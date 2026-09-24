import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentPermissionStore, ReviewRequiredError } from "../agent-permissions.ts";
import { taskKey } from "../agent-policy.ts";
import { OperationReviews } from "../agent-reviews.ts";
import { openDatabase } from "../db.ts";
import { MachineCommands } from "./commands.ts";
import { MachineStore } from "./store.ts";
import type { MachineTransport, SshEndpoint } from "./ssh.ts";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-commands-"));
  const database = openDatabase(":memory:");
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const permissions = new AgentPermissionStore(() => database);
  const reviews = new OperationReviews(permissions, () => database);
  const store = new MachineStore(() => database);
  const project = { id: "prj_todo", name: "todo", path: root };
  const now = Date.now();
  store.createMachine({ id: "mch_a", workspaceId: "personal", name: "alpha", host: "203.0.113.4", port: 22, knownHost: "203.0.113.4 ssh-ed25519 AAAA", hostKeyFingerprint: "SHA256:x", hostKeySource: "operator-confirmed", adminConnectionId: null, lastInspection: null, createdAt: now, updatedAt: now });
  for (const environmentId of ["staging", "production"]) {
    store.createAccess({
      id: `mac_${environmentId}`, machineId: "mch_a", projectId: project.id, projectName: "todo", environmentId, role: "command", risk: environmentId as "staging",
      account: `psm-x-todo-${environmentId}`, workdir: `/srv/psm/commands/psm-x-todo-${environmentId}`, publicKeyFingerprint: "SHA256:k", connectionId: `conn-${environmentId}`,
      state: "ready", plan: {} as never, checks: [], verifiedAt: now, createdAt: now, updatedAt: now,
    });
  }
  const sent: Array<{ endpoint: SshEndpoint; command: string }> = [];
  const transport: MachineTransport = {
    run: async (endpoint, command) => { sent.push({ endpoint, command }); return { code: 0, stdout: "ok\n", stderr: "" }; },
    scanHostKeys: async () => [], generateKeyPair: async () => ({ privateKey: Buffer.alloc(0), publicKey: "" }),
  };
  return { permissions, reviews, commands: new MachineCommands(store, transport), project, sent };
}

test("staging runs under Operate staging, production asks, and a one-time approval covers exactly one command", async (t) => {
  const { permissions, reviews, commands, project, sent } = fixture(t);
  const snapshot = { ...permissions.applyPreset(project, "operate-staging", 0, "operator"), task: taskKey("room") };
  const staging = await commands.run({ snapshot, permissions, environmentId: "staging", command: "systemctl --user status" });
  assert.equal(staging.account, "psm-x-todo-staging");
  assert.equal(sent[0].endpoint.user, "psm-x-todo-staging");
  assert.equal(sent[0].endpoint.connectionId, "conn-staging");

  const denied = await commands.run({ snapshot, permissions, environmentId: "production", command: "rm -rf cache" }).catch((error) => error);
  assert.ok(denied instanceof ReviewRequiredError);
  assert.match(denied.summary, /as psm-x-todo-production[\s\S]*rm -rf cache/);
  const review = reviews.request(snapshot, denied.permission, denied.context, denied.summary, denied.message);
  assert.equal(reviews.request(snapshot, denied.permission, denied.context, denied.summary, denied.message).id, review.id, "asking twice reuses the review");
  reviews.decide(project, review.id, "once", "operator");
  // The approval added authority, so the same (older) snapshot may use it.
  await commands.run({ snapshot, permissions, environmentId: "production", command: "rm -rf cache" });
  assert.equal(sent.length, 2);
  await assert.rejects(commands.run({ snapshot, permissions, environmentId: "production", command: "rm -rf cache" }), ReviewRequiredError, "used once");
  await assert.rejects(commands.run({ snapshot, permissions, environmentId: "production", command: "rm -rf /srv" }), ReviewRequiredError, "a different command is a different review");
  assert.throws(() => reviews.decide(project, review.id, "once", "operator"), /already answered/);
});

test("task approvals end with the task, and a missing server says what is needed", async (t) => {
  const { permissions, reviews, commands, project } = fixture(t);
  const base = permissions.applyPreset(project, "operate-production", 0, "operator");
  const room = { ...base, task: taskKey("room a") };
  const asked = await commands.run({ snapshot: room, permissions, environmentId: "production", command: "uptime" }).catch((error) => error);
  const review = reviews.request(room, asked.permission, asked.context, asked.summary, asked.message);
  reviews.decide(project, review.id, "task", "operator");
  await commands.run({ snapshot: room, permissions, environmentId: "production", command: "df -h" });
  await assert.rejects(commands.run({ snapshot: { ...room, task: taskKey("room b") }, permissions, environmentId: "production", command: "df -h" }), ReviewRequiredError);
  await assert.rejects(commands.run({ snapshot: room, permissions, environmentId: "development", command: "ls" }), /Needs connection/);
  assert.deepEqual(commands.environments(project.id).map((entry) => entry.environmentId).sort(), ["production", "staging"]);
});

test("without machine.command, nothing reaches a server", async (t) => {
  const { permissions, commands, project, sent } = fixture(t);
  const develop = permissions.applyPreset(project, "develop", 0, "operator");
  await assert.rejects(commands.run({ snapshot: develop, permissions, environmentId: "staging", command: "ls" }), /has not granted machine.command/);
  assert.equal(sent.length, 0);
});

test("the remote line keeps a hostile command as one quoted word", async (t) => {
  const { permissions, commands, project, sent } = fixture(t);
  const full = permissions.applyPreset(project, "full", 0, "operator");
  const hostile = `echo "a'b" ; echo $(id) \`id\``;
  await commands.run({ snapshot: full, permissions, environmentId: "staging", command: hostile });
  // Parse the line the way the remote login shell would, without running it.
  const words = execFileSync("bash", ["-c", `f() { printf '%s\\0' "$@"; }; eval "f $(printf '%s' "$1" | sed 's/&&/\\&\\&/')"`, "_", sent[0].command.split(" && ")[1]]).toString().split("\0").filter(Boolean);
  assert.equal(words.at(-1), hostile);
  assert.match(sent[0].command, /^cd '\/srv\/psm\/commands\/psm-x-todo-staging' && exec timeout --kill-after=5s 120s bash -c /);
});
