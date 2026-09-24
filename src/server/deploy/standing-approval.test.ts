import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentPermissionStore } from "../agent-permissions.ts";
import { openDatabase } from "../db.ts";
import { approveByStandingRule } from "./standing-approval.ts";
import type { DeploymentStore } from "./store.ts";

function fixture(t: test.TestContext, plan: { environmentId?: string; requiredAcknowledgementIds?: string[] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-standing-"));
  const database = openDatabase(":memory:");
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const permissions = new AgentPermissionStore(() => database);
  const project = { id: "prj_todo", name: "todo", path: root };
  const approved: any[] = [];
  const queued: string[] = [];
  const store = {
    getPlan: () => ({ planId: "plan_1", revision: 3, digest: "sha256:plan", projectId: "prj_todo", environmentId: plan.environmentId ?? "staging", risk: plan.environmentId ?? "staging", blocked: false, expiresAt: Date.now() + 60_000, requiredAcknowledgementIds: plan.requiredAcknowledgementIds ?? [] }),
    approveAndQueue: (input: any) => { approved.push(input); return { created: true, run: { runId: "run_1" } }; },
  } as unknown as DeploymentStore;
  const deps = { permissions, project: () => project, store, enqueue: (runId: string) => { queued.push(runId); }, agentId: () => "agent" };
  const ask = (environmentId = plan.environmentId ?? "staging") => approveByStandingRule(deps, { projectId: "prj_todo", environmentId, planId: "plan_1" });
  return { permissions, project, approved, queued, ask };
}

test("with no rule, and with an Ask rule, the plan waits for review", async (t) => {
  const { permissions, project, approved, ask } = fixture(t);
  assert.equal(await ask(), null);
  permissions.addRule(project, { permission: "deploy.approve", effect: "ask", scope: { environmentId: "staging" }, source: "custom", actor: "o" }, 0);
  assert.equal(await ask(), null);
  assert.equal(approved.length, 0);
});

test("an environment rule approves exactly this plan, recording the rule and policy revision", async (t) => {
  const { permissions, project, approved, queued, ask } = fixture(t);
  const staging = permissions.applyPreset(project, "operate-staging", 0, "o");
  const result = await ask();
  assert.deepEqual(result?.runId, "run_1");
  assert.deepEqual(queued, ["run_1"]);
  assert.equal(approved[0].planDigest, "sha256:plan");
  assert.equal(approved[0].planRevision, 3);
  assert.match(approved[0].actorSubject, new RegExp(`^policy:rule_[0-9a-f-]+@r${staging.revision}$`));
  assert.equal(await ask("production"), null, "the staging rule does not reach production");
});

test("acknowledgements are covered only by a rule scoped to exactly that environment", async (t) => {
  const { permissions, project, approved, ask } = fixture(t, { environmentId: "production", requiredAcknowledgementIds: ["production-target"] });
  permissions.applyPreset(project, "full", 0, "o");
  assert.equal(await ask(), null, "an unscoped Full access grant does not claim the production review");
  permissions.addRule(project, { permission: "deploy.approve", effect: "allow", scope: { environmentId: "production" }, duration: { kind: "once" }, source: "custom", actor: "o" }, permissions.snapshot(project).revision);
  assert.equal((await ask())?.runId, "run_1");
  assert.deepEqual(approved[0].acknowledgementIds, ["production-target"]);
  assert.equal(await ask(), null, "the one-time production rule was used");
});
