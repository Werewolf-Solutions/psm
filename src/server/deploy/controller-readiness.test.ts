import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db.ts";
import { SecretBroker } from "./connections.ts";
import { DeploymentRuntimeAdapters } from "./runtime-adapters.ts";
import { DeploymentStore } from "./store.ts";
import type { EnvironmentManifest, UnitManifest } from "./types.ts";

const HOST_KEY = `ssh-ed25519 ${Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]).toString("base64")}`;
const FINGERPRINT = "SHA256:dOuQrjCMszNHv3XdjsqWoz/SHsEhtCI4o9BvjcMCNJU";
const TARGET = "werewolf:todo-staging-web";
const unit = {
  id: "web", executor: { kind: "github-actions@1", connection: "github", sourceRepository: "Werewolf-Solutions/todo-app", prepareWorkflow: "build-static.yml", releaseController: "werewolf-static@1" },
  target: { kind: "ssh-release-directory@1", targetId: TARGET, observerConnection: "host", root: "/var/www/todo.werewolf.solutions" },
} as unknown as UnitManifest;
const environment = { id: "staging", risk: "staging", units: [unit] } as unknown as EnvironmentManifest;

async function fixture(t: test.TestContext) {
  const database = openDatabase(":memory:");
  t.after(() => database.close());
  const store = new DeploymentStore(database);
  const broker = new SecretBroker();
  const scope = { allowedProjectIds: ["prj_todo"], allowedEnvironmentIds: ["staging"], maximumAuthorizedRisk: "staging", allowedTargetIds: [TARGET] };
  const ssh = (user: string) => ({ host: "46.101.29.222", user, port: 22, hostKeyFingerprint: FINGERPRINT });
  const helper = (connectionId: string, user: string, role: string) => {
    store.createConnection({
      connectionId, kind: "ssh-host-helper@1", label: connectionId, secretGeneration: 0, readiness: "missing-secret",
      metadata: { publicMetadata: { knownHost: `46.101.29.222 ${HOST_KEY}`, role, targetContracts: { [TARGET]: { fingerprint: `sha256:${"c".repeat(64)}`, revision: "psm-b19f21dd11b4" } } }, credentialIdentity: null, requiredSecretSlots: ["privateKey"] },
      constraints: { ...scope, allowedTargetRootPrefixes: ["/var/www/todo.werewolf.solutions"], ssh: ssh(user) }, createdAt: 1,
    });
  };
  helper("host", "psm-i-todo", "infrastructure");
  helper("ci", "psm-r-todo", "ci");
  store.createConnection({
    connectionId: "github", kind: "github-actions@1", label: "github", secretGeneration: 0, readiness: "missing-secret",
    metadata: { publicMetadata: { revision: 1, prepareWorkflows: [], releaseControllers: [{ controller: "werewolf-static@1", targetId: TARGET, repository: "Werewolf-Solutions/deployment-control", workflow: "release-static.yml", workflowPath: ".github/workflows/release-static.yml", ref: "refs/heads/main", expectedHeadSha: "a".repeat(40), expectedWorkflowBlobSha: "b".repeat(40), githubEnvironment: "todo-staging-web", allowedSourceRepositories: ["Werewolf-Solutions/todo-app"] }] }, credentialIdentity: null, requiredSecretSlots: ["apiToken"] },
    constraints: { ...scope, allowedRepositories: ["Werewolf-Solutions/todo-app", "Werewolf-Solutions/deployment-control"] }, createdAt: 1,
  });
  for (const [id, slot, value] of [["host", "privateKey", "host-key"], ["ci", "privateKey", "-----BEGIN OPENSSH PRIVATE KEY-----\nci\n"], ["github", "apiToken", "ghp_testtokenvalue123"]] as const) {
    const generation = await broker.put(id, slot, value);
    const record = store.getConnection(id);
    store.updateConnectionSecretStatus({ connectionId: id, expectedSecretGeneration: record.secretGeneration, secretGeneration: generation, readiness: "ready", updatedAt: 2 });
  }
  for (const slot of ["github", "host"]) store.bindConnection({ projectId: "prj_todo", checkoutId: "chk_1", environmentId: "staging", slot, connectionId: slot, expectedRevision: null, at: 3 });
  return new DeploymentRuntimeAdapters({ store, broker });
}

function stubGitHub(t: test.TestContext, file: Record<string, unknown>, secrets: string[]) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push(`${init?.method ?? "GET"} ${href}`);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (href.includes("/contents/targets/werewolf__todo-staging-web.json")) return reply(200, { content: Buffer.from(JSON.stringify(file)).toString("base64") });
    if (href.includes("/environments/todo-staging-web/secrets?")) return reply(200, { secrets: secrets.map((name) => ({ name })) });
    return reply(404, { message: "Not Found" });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const current = { schema: "psm.werewolf.solutions/control-target/v1", targetId: TARGET, sshHost: "46.101.29.222", sshUser: "psm-r-todo", sshPort: 22, hostKeyFingerprint: FINGERPRINT, canonicalRoot: "/var/www/todo.werewolf.solutions", contractRevision: "psm-b19f21dd11b4" };

test("a stale controller target file and missing credentials block the release with the exact fix", async (t) => {
  const adapters = await fixture(t);
  const calls = stubGitHub(t, { ...current, sshUser: "psm-infra", contractRevision: "todo-staging-v1" }, []);
  const checks = await adapters.controllerReadiness(unit, { checkoutId: "chk_1", environment });
  const target = checks.find((check) => check.id === "web:controller-target")!;
  assert.equal(target.ready, false);
  assert.match(target.detail, /contractRevision must be "psm-b19f21dd11b4" \(is "todo-staging-v1"\); sshUser must be "psm-r-todo" \(is "psm-infra"\)/);
  const credentials = checks.find((check) => check.id === "web:controller-credentials")!;
  assert.equal(credentials.ready, false);
  assert.match(credentials.detail, /missing PSM_TARGET_KNOWN_HOSTS and PSM_TARGET_SSH_PRIVATE_KEY\. Publish the CI release key/);
  assert.ok(calls.some((call) => call.includes(`?ref=${"a".repeat(40)}`)), "the file is read at the pinned commit");
  assert.ok(checks.every((check) => check.purpose === "deploy"));
});

test("a matching target file and published credentials pass", async (t) => {
  const adapters = await fixture(t);
  stubGitHub(t, current, ["PSM_TARGET_KNOWN_HOSTS", "PSM_TARGET_SSH_PRIVATE_KEY"]);
  const checks = await adapters.controllerReadiness(unit, { checkoutId: "chk_1", environment });
  assert.deepEqual(checks.map((check) => [check.id, check.ready]), [["web:controller-target", true], ["web:controller-credentials", true]]);
});
