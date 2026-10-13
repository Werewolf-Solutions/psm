import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { AgentPermissionStore } from "./agent-permissions.ts";
import { openDatabase } from "./db.ts";
import { workspaceAgentPolicyRouter } from "./workspace-agent-policy.ts";

const BUSINESS = "business:0123456789abcdef01234567";
const deny = (permission = "git.push", scope = {}) => ({ permission, effect: "deny" as const, scope, source: "custom", actor: "operator" });
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-workspace-policy-"));
  const database = openDatabase(":memory:");
  const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_policy", name: "policy", path: root, workspaceId: BUSINESS };
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, project, database };
}

test("workspace restrictions fence existing turns, override presets, and leave other workspaces unchanged", (t) => {
  const { store, project } = fixture(t);
  const started = store.applyPreset(project, "full", 0, "operator");
  const personal = { ...started, project: { ...started.project, workspaceId: "personal" } };
  const added = store.addWorkspaceRule(BUSINESS.toUpperCase(), deny("machine.command", { environmentId: "production" }), 0);
  assert.equal(added.workspaceId, BUSINESS);
  assert.throws(() => store.check(started, "repo.read"), /Workspace permissions changed/);
  assert.equal(store.check(personal, "machine.command", { environmentId: "production" }).effect, "allow");
  const fresh = store.snapshot(project);
  assert.throws(() => store.check(fresh, "machine.command", { environmentId: "production" }), /Denied by workspace policy/);
  assert.equal(store.check(fresh, "machine.command", { environmentId: "staging" }).effect, "allow");
  store.addRule(project, { permission: "machine.command", effect: "allow", scope: { environmentId: "production", connectionId: "prod" }, source: "custom", actor: "operator" }, fresh.revision);
  assert.throws(() => store.check(store.snapshot(project), "machine.command", { environmentId: "production", connectionId: "prod" }), /Denied by workspace policy/);
  store.removeWorkspaceRule(BUSINESS, added.rules[0].id, added.revision, "operator");
  assert.equal(store.check(fresh, "machine.command", { environmentId: "production" }).effect, "allow", "removal does not invalidate a current turn");
  assert.throws(() => store.check(started, "repo.read"), /Workspace permissions changed/, "removal cannot revive an already fenced turn");
  assert.equal(store.snapshot(project).revision, 2, "workspace edits never rewrite project policy");
});

test("workspace edits reject stale revisions and nonrestriction inputs atomically and survive reopening", (t) => {
  const { store, project, database } = fixture(t);
  for (const input of [
    { ...deny(), effect: "allow" as const }, { ...deny(), effect: "ask" as const }, deny("git.force-push"),
    { ...deny(), duration: { kind: "once" as const } }, deny("git.push", { typo: "production" }),
    { ...deny(), duration: { kind: "until" as const, expiresAt: 1 } },
  ]) assert.throws(() => store.addWorkspaceRule(BUSINESS, input, 0));
  assert.equal(store.workspaceHistory(BUSINESS).length, 0);
  const first = store.addWorkspaceRule(BUSINESS, deny("*"), 0);
  assert.throws(() => store.addWorkspaceRule(BUSINESS, deny(), 0), /changed since/);
  assert.throws(() => store.removeWorkspaceRule(BUSINESS, "missing", first.revision, "operator"), /no longer exists/);
  assert.equal(store.workspacePolicy(BUSINESS).revision, 1);
  const reopened = new AgentPermissionStore(() => database);
  assert.deepEqual(reopened.workspacePolicy(BUSINESS), first);
  assert.equal(reopened.decide(reopened.snapshot(project), "repo.read").workspace, true);
  const removed = reopened.removeWorkspaceRule(BUSINESS, first.rules[0].id, 1, "operator");
  assert.equal(removed.rules.length, 0);
  assert.throws(() => reopened.check(reopened.snapshot(project), "repo.read"), /has not granted/, "removing a deny cannot create a project grant");
  assert.deepEqual(reopened.workspaceHistory(BUSINESS).map((event: any) => [event.revision, event.permission, event.actor]), [[2, "rule-removed:deny:*", "operator"], [1, "rule:deny:*", "operator"]]);
});

test("expired workspace restrictions stop applying without changing grants", (t) => {
  const { store, project } = fixture(t);
  store.change(project, "git.push", true, 0, "operator");
  const added = store.addWorkspaceRule(BUSINESS, { ...deny(), duration: { kind: "until", expiresAt: Date.now() + 60_000 } }, 0);
  assert.equal(store.decide(store.snapshot(project), "git.push").effect, "deny");
  const later = Date.now() + 120_000;
  const original = Date.now;
  Date.now = () => later;
  try { assert.equal(store.check(store.snapshot(project), "git.push").effect, "allow"); }
  finally { Date.now = original; }
  assert.equal(store.workspacePolicy(BUSINESS).rules[0].id, added.rules[0].id, "retain the recorded restriction and its audit");
});

test("workspace API requires local operator and current management authority on every edit", async (t) => {
  const { store } = fixture(t);
  let verdict: { ok: true } | { ok: false; status: number; error: string } = { ok: true };
  const authorized: string[] = [];
  const changes: Array<{ ref: string; restrictive: boolean }> = [];
  const app = express(); app.use(express.json());
  app.use(workspaceAgentPolicyRouter({ store, authorize: async (ref) => { authorized.push(ref); return verdict; }, changed: (ref, change) => { changes.push({ ref, ...change }); } }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const base = `${origin}/api/workspaces/${encodeURIComponent(BUSINESS.toUpperCase())}/agent-policy`;
  const headers = { "Content-Type": "application/json", Origin: origin, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" };
  const body = JSON.stringify({ ...deny(), actor: "attacker", revision: 0 });
  assert.equal((await fetch(`${base}/rules`, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 403);
  assert.equal(authorized.length, 0, "reject forged cockpit calls before membership lookup");
  assert.equal((await fetch(`${origin}/api/workspaces/invalid/agent-policy`)).status, 400);
  for (const status of [401, 403, 503]) {
    verdict = { ok: false, status, error: "Membership unavailable or role cannot manage workspace policy" };
    assert.equal((await fetch(base)).status, status);
    assert.equal((await fetch(`${base}/rules`, { method: "POST", headers, body })).status, status);
    assert.equal(store.workspacePolicy(BUSINESS).revision, 0);
  }
  verdict = { ok: true };
  const response = await fetch(`${base}/rules`, { method: "POST", headers, body });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.notEqual(saved.rules[0].actor, "attacker");
  assert.equal(saved.rules[0].source, "custom");
  assert.equal((await fetch(`${base}/rules`, { method: "POST", headers, body })).status, 409);
  verdict = { ok: false, status: 403, error: "Management role revoked" };
  const removal = { method: "DELETE", headers, body: JSON.stringify({ revision: 1 }) };
  assert.equal((await fetch(`${base}/rules/${saved.rules[0].id}`, removal)).status, 403);
  assert.equal(store.workspacePolicy(BUSINESS).rules.length, 1);
  verdict = { ok: true };
  assert.equal((await fetch(`${base}/rules/${saved.rules[0].id}`, removal)).status, 200);
  assert.deepEqual(changes, [{ ref: BUSINESS, restrictive: true }, { ref: BUSINESS, restrictive: false }]);
  assert.ok(authorized.every((ref) => ref === BUSINESS));
});
