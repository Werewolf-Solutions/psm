import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { explainAccess, configuredRemotes } from "./agent-access.ts";
import { AgentPermissionStore } from "./agent-permissions.ts";
import { openDatabase } from "./db.ts";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-access-"));
  const database = openDatabase(":memory:");
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new AgentPermissionStore(() => database);
  return { store, project: { id: "prj_access", name: "access", path: root }, root };
}

const base = { engine: "claude", remotes: ["origin"], runner: { ok: true, detail: "ok" }, attachedTools: 0, servers: [] };
const status = (items: ReturnType<typeof explainAccess>, id: string) => items.find((item) => item.id === id)?.status;

test("each gap names its cause: grant, review, connection, runner or unsupported", (t) => {
  const { store, project } = fixture(t);
  const develop = store.applyPreset(project, "develop", 0, "operator");
  const items = explainAccess({ ...base, snapshot: develop, store, runner: { ok: false, detail: "Docker is not available to PSM." } });
  assert.equal(status(items, "edit"), "ready");
  assert.equal(status(items, "push"), "needs-review");
  assert.equal(status(items, "tests"), "needs-runner");
  assert.equal(status(items, "attached-tools"), "needs-connection");
  assert.equal(status(items, "server-commands"), "needs-grant");
  assert.equal(status(items, "build"), "unsupported");
  assert.equal(status(items, "local-shell"), "unsupported");
  assert.equal(status(items, "deploy"), "needs-review");
  assert.equal(status(explainAccess({ ...base, snapshot: store.applyPreset(project, "operate-staging", develop.revision, "operator"), store }), "deploy"), "ready");
  assert.match(items.find((item) => item.id === "push")!.detail, /git.push/);
});

test("a grant without its connection says so, and servers are listed per environment", (t) => {
  const { store, project } = fixture(t);
  const full = store.applyPreset(project, "full", 0, "operator");
  const noRemote = explainAccess({ ...base, snapshot: full, store, remotes: [] });
  assert.equal(status(noRemote, "push"), "needs-connection");
  assert.equal(status(noRemote, "server-commands"), "needs-connection");
  const withServer = explainAccess({ ...base, snapshot: full, store, servers: [{ environmentId: "staging", machine: "alpha", host: "h", account: "a", workdir: "/w", connectionId: "c" }] });
  assert.equal(status(withServer, "server-commands:staging"), "ready");
  assert.equal(status(explainAccess({ ...base, snapshot: full, store, engine: "gemini" }), "engine"), "provider-restricted");
});

test("remotes are read from the checkout's Git config", (t) => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = x\n[remote "upstream"]\n\turl = y\n');
  assert.deepEqual(configuredRemotes(root), ["origin", "upstream"]);
});

test("remotes are found through a worktree's pointer to the shared config", (t) => {
  const { root } = fixture(t);
  const common = path.join(root, "main.git");
  fs.mkdirSync(path.join(common, "worktrees", "w1"), { recursive: true });
  fs.writeFileSync(path.join(common, "config"), '[remote "origin"]\n\turl = x\n');
  fs.writeFileSync(path.join(common, "worktrees", "w1", "commondir"), "../..\n");
  const checkout = path.join(root, "checkout"); fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(checkout, ".git"), `gitdir: ${path.join(common, "worktrees", "w1")}\n`);
  assert.deepEqual(configuredRemotes(checkout), ["origin"]);
});
