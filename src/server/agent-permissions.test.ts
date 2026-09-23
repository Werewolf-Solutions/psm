import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { openDatabase } from "./db.ts";
import { AGENT_PERMISSIONS, AgentPermissionStore, agentPermissionRouter, PREPARATION_OPERATIONS, reviewAgentPermissions } from "./agent-permissions.ts";

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

test("unknown capabilities never become grants and every catalogued operation can be granted", (t) => {
  const { store, project } = fixture(t);
  for (const permission of ["everything", "git.force-push"]) assert.throws(() => store.change(project, permission, true, 0, "operator"));
  assert.equal(store.history(project).length, 0);
  assert.equal(reviewAgentPermissions([store.snapshot(project)], "codex", []), null);
  assert.match(reviewAgentPermissions([store.snapshot(project)], "unknown", [])!, /does not yet support/);
  for (const permission of AGENT_PERMISSIONS) {
    assert.ok(permission.category);
    store.change(project, permission.id, true, store.snapshot(project).revision, "operator");
  }
  assert.equal(Object.values(store.snapshot(project).grants).filter((grant) => grant?.granted).length, AGENT_PERMISSIONS.length);
});

test("bulk grants are atomic, share one revision, and skip permissions already in that state", (t) => {
  const { store, project } = fixture(t);
  const granted = store.changeMany(project, ["repo.read", "git.merge", "git.push"], true, 0, "operator");
  assert.equal(granted.revision, 1);
  for (const permission of ["repo.read", "git.merge", "git.push"] as const) store.check(granted, permission);
  assert.deepEqual(store.history(project).map((event: any) => event.revision), [1, 1, 1]);
  const unchanged = store.changeMany(project, ["repo.read", "git.merge"], true, 1, "operator");
  assert.equal(unchanged.revision, 1);
  assert.equal(store.history(project).length, 3);
  assert.throws(() => store.changeMany(project, ["repo.edit", "not-real"], true, 1, "operator"), /Invalid/);
  assert.equal(store.snapshot(project).grants["repo.edit"], undefined);
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

test("the browser API grants a whole category atomically", async (t) => {
  const { store, project } = fixture(t);
  const changed: string[] = [];
  const app = express(); app.use(express.json());
  app.use(agentPermissionRouter({ store, project: () => project, changed: (value) => changed.push(value.id) }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const response = await fetch(`${origin}/api/projects/test/agent-permissions`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ permissions: ["git.branch", "git.switch", "git.merge"], granted: true, revision: 0 }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.revision, 1);
  assert.ok(body.categories.some((category: any) => category.id === "git-local"));
  for (const permission of ["git.branch", "git.switch", "git.merge"]) assert.equal(body.grants[permission].granted, true);
  assert.deepEqual(changed, [project.id], "one bulk action stops turns and resumes preparation once");
});

test("a grant change can say what it resumed, alongside the updated grants", async (t) => {
  const { store, project } = fixture(t);
  const app = express(); app.use(express.json());
  app.use(agentPermissionRouter({ store, project: () => project, changed: () => ({ resumedPreparations: ["staging"] }) }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const response = await fetch(`${origin}/api/projects/test/agent-permissions`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ permission: "git.commit", granted: true, revision: 0 }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.resumedPreparations, ["staging"]);
  assert.equal(body.grants["git.commit"].granted, true, "the notice is added to the view, not instead of it");
});
