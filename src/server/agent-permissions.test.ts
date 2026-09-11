import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { openDatabase } from "./db.ts";
import { AgentPermissionStore, agentPermissionRouter, PREPARATION_OPERATIONS, reviewAgentPermissions } from "./agent-permissions.ts";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-permissions-"));
  const database = openDatabase(":memory:");
  const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_test", name: "test", path: root };
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, database, store, project };
}

test("legacy identity and repository-written grants cannot authorize tools", (t) => {
  const { root, store, project } = fixture(t);
  fs.mkdirSync(path.join(root, ".psm"));
  for (const version of [1, 2]) {
    fs.writeFileSync(path.join(root, ".psm/identity.json"), JSON.stringify({ version, id: project.id, agentCapabilities: { "git.commit": { granted: true } } }));
    fs.writeFileSync(path.join(root, ".psm/capabilities.json"), JSON.stringify({ "git.commit": true }));
    const snapshot = store.snapshot(project);
    assert.equal(snapshot.revision, 0);
    assert.deepEqual(snapshot.grants, {});
    assert.throws(() => store.check(snapshot, "git.commit"), /has not granted/);
    assert.match(reviewAgentPermissions([snapshot], "claude", PREPARATION_OPERATIONS.map((entry) => entry.permission))!, /git.commit.*project grants: none/);
  }
});

test("grants, revocation and stale revisions are atomic and audited", (t) => {
  const { store, project } = fixture(t);
  const granted = store.change(project, "git.commit", true, 0, "operator:test");
  store.check(granted, "git.commit");
  assert.throws(() => store.change(project, "repo.edit", true, 0, "forged"), /changed since/);
  assert.equal(store.history(project).length, 1);
  const revoked = store.change(project, "git.commit", false, 1, "operator:test");
  assert.throws(() => store.check(granted, "git.commit"), /permissions changed/);
  assert.throws(() => store.check(revoked, "git.commit"), /has not granted/);
  assert.deepEqual(store.history(project).map((event: any) => [event.revision, event.granted, event.actor]), [[2, 0, "operator:test"], [1, 1, "operator:test"]]);
});

test("unknown, outward and unsupported capabilities never become grants", (t) => {
  const { store, project } = fixture(t);
  for (const permission of ["everything", "git.push", "pkg.install", "test.run"]) assert.throws(() => store.change(project, permission, true, 0, "operator"));
  assert.equal(store.history(project).length, 0);
  assert.match(reviewAgentPermissions([store.snapshot(project)], "codex", [])!, /does not yet support/);
});

test("the same project ID in another checkout does not inherit authority", (t) => {
  const { store, project, root } = fixture(t);
  const other = path.join(root, "other"); fs.mkdirSync(other);
  store.change(project, "repo.read", true, 0, "operator");
  assert.deepEqual(store.snapshot({ ...project, path: other }).grants, {});
});

test("permission mutation requires browser origin metadata and ignores caller-supplied actor", async (t) => {
  const { store, project } = fixture(t);
  const changed: string[] = [];
  const app = express(); app.use(express.json());
  app.use(agentPermissionRouter({ store, project: () => project, changed: (project) => changed.push(project.id) }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const call = (headers: Record<string, string>) => fetch(`${origin}/api/projects/test/agent-permissions`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ permission: "repo.read", granted: true, revision: 0, actor: "attacker" }) });
  assert.equal((await call({})).status, 403);
  assert.equal((await call({ Origin: "https://untrusted.example", "Sec-Fetch-Site": "same-origin" })).status, 403);
  const response = await call({ Origin: origin, "Sec-Fetch-Site": "same-origin" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.grants["repo.read"].granted, true);
  assert.notEqual(body.grants["repo.read"].actor, "attacker");
  assert.deepEqual(changed, [project.id]);
});
