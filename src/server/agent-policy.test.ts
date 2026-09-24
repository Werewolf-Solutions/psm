import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentPermissionStore, ReviewRequiredError } from "./agent-permissions.ts";
import { decide, makeRule, PRESETS, taskKey, type PolicyRule } from "./agent-policy.ts";
import { openDatabase } from "./db.ts";

const rule = (permission: string, effect: PolicyRule["effect"], scope: PolicyRule["scope"] = {}, extra: Partial<PolicyRule> = {}): PolicyRule =>
  ({ ...makeRule({ permission, effect, scope, source: "test", actor: "t", now: 1 }), ...extra });

test("the most specific rule wins, and at equal specificity deny beats ask beats allow", () => {
  const rules = [rule("machine.command", "ask"), rule("machine.command", "allow", { environmentId: "staging" })];
  assert.equal(decide({ permission: "machine.command", context: { environmentId: "staging" }, rules }).effect, "allow");
  assert.equal(decide({ permission: "machine.command", context: { environmentId: "production" }, rules }).effect, "ask");
  assert.equal(decide({ permission: "machine.command", rules: [...rules, rule("machine.command", "deny")] }).effect, "deny");
  assert.equal(decide({ permission: "git.push", rules }).effect, "deny", "no rule is a deny");
  assert.match(decide({ permission: "git.push", rules }).reason, /No rule allows git.push/);
});

test("a workspace deny beats any project allow, including a more specific one", () => {
  const decision = decide({
    permission: "machine.command", context: { environmentId: "production" },
    rules: [rule("machine.command", "allow", { environmentId: "production" })],
    workspaceRules: [rule("machine.command", "deny")],
  });
  assert.equal(decision.effect, "deny");
  assert.equal(decision.workspace, true);
});

test("expired, used-up and other-task rules do not apply", () => {
  assert.equal(decide({ permission: "git.push", now: 10, rules: [rule("git.push", "allow", {}, { expiresAt: 5 })] }).effect, "deny");
  assert.equal(decide({ permission: "git.push", rules: [rule("git.push", "allow", {}, { remainingUses: 0 })] }).effect, "deny");
  const task = rule("git.push", "allow", { task: taskKey("room a") });
  assert.equal(decide({ permission: "git.push", context: { task: taskKey("room a") }, rules: [task] }).effect, "allow");
  assert.equal(decide({ permission: "git.push", context: { task: taskKey("room b") }, rules: [task] }).effect, "deny");
  assert.throws(() => makeRule({ permission: "git.push", effect: "allow", duration: { kind: "until", expiresAt: 1 }, source: "t", actor: "t", now: 2 }), /future/);
  assert.throws(() => makeRule({ permission: "git.push", effect: "allow", scope: { environmentId: "prod; rm" }, source: "t", actor: "t" }), /scope/);
});

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-policy-"));
  const database = openDatabase(":memory:");
  const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_policy", name: "policy", path: root };
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, project, database };
}

test("existing grants keep exactly their authority as standing allows", (t) => {
  const { store, project } = fixture(t);
  const granted = store.changeMany(project, ["repo.read", "git.push"], true, 0, "operator");
  assert.equal(store.check(granted, "git.push").rule?.source, "grant");
  assert.throws(() => store.check(granted, "repo.edit"), /has not granted repo.edit/);
});

test("ask raises a review, a one-time allow is used once, and adding authority keeps running turns valid", (t) => {
  const { store, project } = fixture(t);
  const start = store.changeMany(project, ["repo.read"], true, 0, "operator");
  const asked = store.addRule(project, { permission: "git.push", effect: "ask", source: "custom", actor: "operator" }, start.revision);
  // An Ask rule reduces authority, so a turn that started before it is stale.
  assert.throws(() => store.check(start, "repo.read"), /permissions changed/);
  const turn = store.snapshot(project);
  assert.throws(() => store.check(turn, "git.push"), ReviewRequiredError);
  const once = store.addRule(project, { permission: "git.push", effect: "allow", scope: { connectionId: "origin" }, duration: { kind: "once" }, source: "review:x", actor: "operator" }, asked.revision);
  // The allow was additive: the turn that started before it may use it.
  assert.equal(store.check(turn, "git.push", { connectionId: "origin" }).effect, "allow");
  assert.throws(() => store.check(turn, "git.push", { connectionId: "origin" }), ReviewRequiredError, "the one-time allow is gone");
  assert.equal(store.snapshot(project).rules!.length, 1, "the used rule is removed");
  // Removing a grant reduces authority: older snapshots are refused.
  store.changeMany(project, ["repo.read"], false, once.revision, "operator");
  assert.throws(() => store.check(turn, "repo.read"), /permissions changed/);
});

test("presets replace grants and rules exactly, and are audited with their version", (t) => {
  const { store, project } = fixture(t);
  store.changeMany(project, ["repo.read", "git.push"], true, 0, "operator");
  const staging = store.applyPreset(project, "operate-staging", 1, "operator");
  const preset = PRESETS.find((entry) => entry.id === "operate-staging")!;
  assert.deepEqual(Object.keys(staging.grants).sort(), [...preset.grants].sort());
  assert.equal(store.check(staging, "machine.command", { environmentId: "staging" }).effect, "allow");
  assert.throws(() => store.check(staging, "machine.command", { environmentId: "production" }), ReviewRequiredError);
  const inspect = store.applyPreset(project, "inspect", staging.revision, "operator");
  assert.deepEqual(Object.keys(inspect.grants), ["repo.read"]);
  assert.deepEqual(inspect.rules, []);
  assert.ok(store.history(project).some((event: any) => event.permission === "preset:operate-staging@1"));
  assert.throws(() => store.applyPreset(project, "root", inspect.revision, "operator"), /Unknown preset/);
});

test("workspace denials apply to every project in that workspace", (t) => {
  const { store, project, database } = fixture(t);
  const granted = store.changeMany(project, ["git.push"], true, 0, "operator");
  database.prepare("INSERT INTO agent_permissions (project_id, checkout, revision, grants, rules) VALUES ('ws:personal', '', 1, '{}', ?)").run(JSON.stringify([rule("git.push", "deny")]));
  assert.throws(() => store.check(granted, "git.push"), /Denied by workspace policy/);
  assert.equal(store.check({ ...granted, project: { ...granted.project, workspaceId: "business:0123456789abcdef01234567" } }, "git.push").effect, "allow");
});

test("an undecided operation is a grant request the operator can answer; an explicit deny is final", async (t) => {
  const { store, project, database } = fixture(t);
  const { GrantRequiredError } = await import("./agent-permissions.ts");
  const { OperationReviews } = await import("./agent-reviews.ts");
  const reviews = new OperationReviews(store, () => database);
  const turn = { ...store.changeMany(project, ["repo.read"], true, 0, "operator"), task: taskKey("room") };
  const undecided = (() => { try { store.check(turn, "git.push", { connectionId: "origin" }, "Push abc to origin/main"); } catch (error) { return error; } })();
  assert.ok(undecided instanceof GrantRequiredError);
  assert.match((undecided as Error).message, /has not granted git.push/);
  const request = reviews.request(turn, (undecided as any).permission, (undecided as any).context, (undecided as any).summary, (undecided as Error).message);
  reviews.decide(project, request.id, "task", "operator");
  assert.equal(store.check(turn, "git.push", { connectionId: "origin" }).effect, "allow", "granted for this task; the running turn continues");
  store.addRule(project, { permission: "repo.delete", effect: "deny", source: "custom", actor: "operator" }, store.snapshot(project).revision);
  const fresh = { ...store.snapshot(project), task: taskKey("room") };
  const denied = (() => { try { store.check(fresh, "repo.delete"); } catch (error) { return error; } })();
  assert.ok(!(denied instanceof GrantRequiredError), "an explicit deny is not offered as a request");
  assert.match((denied as Error).message, /Denied by deny repo.delete/);
});
