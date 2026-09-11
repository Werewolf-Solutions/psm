import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "./db.ts";
import { AgentPermissionStore, PREPARATION_OPERATIONS, reviewAgentPermissions } from "./agent-permissions.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-permission-lifecycle-"));
process.env.PSM_SESSIONS_FILE = path.join(root, "transcript.json");
const ai = await import("./ai.ts");

test("revocation aborts the managed turn, clears its queue and blocks resume before spawn", async (t) => {
  const database = openDatabase(":memory:");
  const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_test", name: "test", path: root };
  for (const operation of PREPARATION_OPERATIONS) store.change(project, operation.permission, true, store.snapshot(project).revision, "operator");
  const running: AbortController[] = [];
  ai.configureManagedAgents((scope) => {
    const snapshot = store.snapshot(project);
    const gap = reviewAgentPermissions([snapshot], scope.engine, PREPARATION_OPERATIONS.map((entry) => entry.permission));
    if (gap) throw new Error(gap);
    return { store, snapshots: [snapshot], protectedRoots: [] };
  }, async (input) => {
    running.push(input.signal);
    await new Promise<void>((resolve) => input.signal.signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  t.after(() => { ai.stopSession("test"); ai.configureManagedAgents(null); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const send = () => ai.send("test", root, "claude", null, null, "continue", true);
  assert.equal(send().ok, true);
  assert.equal(running.length, 1, "Full access cannot bypass the managed runner");
  assert.equal(send().queued, true);
  store.change(project, "git.commit", false, store.snapshot(project).revision, "operator");
  ai.stopProjectAgents(root);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(running[0].signal.aborted, true);
  assert.equal(ai.aiState("test").busy, false);
  assert.equal(ai.aiState("test").queueDepth, 0);
  assert.match(send().error!, /requires git.commit/);
  assert.equal(running.length, 1, "neither queued nor resumed work was spawned");
});
