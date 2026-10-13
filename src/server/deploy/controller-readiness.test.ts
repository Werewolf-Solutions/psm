import assert from "node:assert/strict";
import test from "node:test";
import { HOST_HELPER_RESPONSE_SCHEMA } from "./adapters/host-helper.ts";

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

async function fixture(t: test.TestContext, live = { targetDigest: `sha256:${"c".repeat(64)}` }, appManaged = false, pinsController = true, controllerExtra: Record<string, unknown> = {}) {
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
    metadata: { publicMetadata: { revision: 1, prepareWorkflows: [], releaseControllers: !pinsController ? [] : [{ controller: "werewolf-static@1", ...(appManaged ? { sourceAuthorization: "installation-token" } : {}), targetId: TARGET, repository: "Werewolf-Solutions/deployment-control", workflow: "release-static.yml", workflowPath: ".github/workflows/release-static.yml", ref: "refs/heads/main", expectedHeadSha: "a".repeat(40), expectedWorkflowBlobSha: "b".repeat(40), githubEnvironment: "todo-staging-web", allowedSourceRepositories: ["Werewolf-Solutions/todo-app"], ...controllerExtra }] }, credentialIdentity: null, requiredSecretSlots: ["apiToken"] },
    constraints: { ...scope, allowedRepositories: ["Werewolf-Solutions/todo-app", "Werewolf-Solutions/deployment-control"] }, createdAt: 1,
  });
  for (const [id, slot, value] of [["host", "privateKey", "host-key"], ["ci", "privateKey", "-----BEGIN OPENSSH PRIVATE KEY-----\nci\n"], ["github", "apiToken", "ghp_testtokenvalue123"]] as const) {
    const generation = await broker.put(id, slot, value);
    const record = store.getConnection(id);
    store.updateConnectionSecretStatus({ connectionId: id, expectedSecretGeneration: record.secretGeneration, secretGeneration: generation, readiness: "ready", updatedAt: 2 });
  }
  for (const slot of ["github", "host"]) store.bindConnection({ projectId: "prj_todo", checkoutId: "chk_1", environmentId: "staging", slot, connectionId: slot, expectedRevision: null, at: 3 });
  // The enrolled helper's observe-target answer; `live` lets a test move the server's contract.
  const hostTransport = {
    invoke: async ({ request }: { request: { requestId: string; targetId: string; operation: string } }) => ({
      schema: HOST_HELPER_RESPONSE_SCHEMA, requestId: request.requestId, targetId: request.targetId, operation: request.operation,
      outcome: "succeeded", code: "ok", detail: "operation completed and was observed", observedAt: new Date().toISOString(),
      data: { targetId: request.targetId, targetDigest: live.targetDigest, layout: "ready", active: null, releases: [] },
    }),
  };
  return new DeploymentRuntimeAdapters({ store, broker, hostTransport: hostTransport as never });
}

function stubGitHub(t: test.TestContext, file: Record<string, unknown>, secrets: string[], variables: string[] = [], head = "a".repeat(40), writers: string[] = []) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push(`${init?.method ?? "GET"} ${href}`);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (href.includes("/contents/targets/werewolf__todo-staging-web.json")) return reply(200, { content: Buffer.from(JSON.stringify(file)).toString("base64") });
    if (href.includes("/commits/refs%2Fheads%2Fmain") || href.includes("/commits/refs/heads/main")) return reply(200, { sha: head });
    if (href.includes("/contents/.github/workflows/release-static.yml")) return reply(200, { type: "file", path: ".github/workflows/release-static.yml", sha: "b".repeat(40) });
    if (href.includes("/collaborators?")) return reply(200, writers.map((login) => ({ login, permissions: { push: true } })));
    if (href.includes("/environments/todo-staging-web/secrets?")) return reply(200, { secrets: secrets.map((name) => ({ name })) });
    if (href.includes("/environments/todo-staging-web/variables?")) return reply(200, { variables: variables.map((name) => ({ name })) });
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
  assert.match(target.detail, /https:\/\/github\.com\/Werewolf-Solutions\/deployment-control\/edit\/main\/targets\/werewolf__todo-staging-web\.json$/, "names the exact page to edit");
  const credentials = checks.find((check) => check.id === "web:controller-credentials")!;
  assert.equal(credentials.ready, false);
  assert.match(credentials.detail, /missing PSM_TARGET_KNOWN_HOSTS and PSM_TARGET_SSH_PRIVATE_KEY\. Publish the CI release key/);
  assert.ok(calls.some((call) => call.includes(`?ref=${"a".repeat(40)}`)), "the file is read at the pinned commit");
  assert.ok(checks.every((check) => check.purpose === "deploy"));
});

test("a matching target file and published credentials pass", async (t) => {
  const adapters = await fixture(t);
  stubGitHub(t, current, ["PSM_ARTIFACT_READER_PRIVATE_KEY", "PSM_TARGET_KNOWN_HOSTS", "PSM_TARGET_SSH_PRIVATE_KEY"], ["PSM_ARTIFACT_READER_APP_ID"]);
  const checks = await adapters.controllerReadiness(unit, { checkoutId: "chk_1", environment });
  assert.deepEqual(checks.map((check) => [check.id, check.ready]), [["web:controller-pin", true], ["web:target-contract", true], ["web:controller-target", true], ["web:controller-credentials", true], ["web:controller-artifact-reader", true]]);
});

test("a moved controller branch blocks release until the exact new commit is pinned", async (t) => {
  const adapters = await fixture(t);
  const moved = "c".repeat(40);
  stubGitHub(t, current, ["PSM_ARTIFACT_READER_PRIVATE_KEY", "PSM_TARGET_KNOWN_HOSTS", "PSM_TARGET_SSH_PRIVATE_KEY"], ["PSM_ARTIFACT_READER_APP_ID"], moved);
  const checks = await adapters.controllerReadiness(unit, { checkoutId: "chk_1", environment });
  const pin = checks.find((check) => check.id === "web:controller-pin");
  assert.equal(pin?.ready, false);
  assert.match(pin?.detail ?? "", new RegExp(`moved from ${"a".repeat(12)} to ${moved}`));
  assert.match(pin?.detail ?? "", new RegExp(`/compare/${"a".repeat(40)}\\.\\.\\.${moved}`));

  await assert.rejects(adapters.pinControllerHead(unit, { checkoutId: "chk_1", environment }, "d".repeat(40)), /not the reviewed/);
  await adapters.pinControllerHead(unit, { checkoutId: "chk_1", environment }, moved);
  const after = await adapters.controllerReadiness(unit, { checkoutId: "chk_1", environment });
  assert.equal(after.find((check) => check.id === "web:controller-pin")?.ready, true);
});

test("App-managed controllers require bundle review before a manual pin moves", async (t) => {
  const adapters = await fixture(t, { targetDigest: `sha256:${"c".repeat(64)}` }, true);
  await assert.rejects(adapters.pinControllerHead(unit, { checkoutId: "chk_1", environment }, "c".repeat(40)), /Review controller setup/);
});

test("a target contract changed on the server blocks release until the exact new digest is pinned", async (t) => {
  // Observed 2026-09-28: pm2User/pm2Home were edited on the server with approval, moving
  // the helper's target digest away from the one pinned at enrollment.
  const live = { targetDigest: `sha256:${"e".repeat(64)}` };
  const adapters = await fixture(t, live);
  stubGitHub(t, current, ["PSM_ARTIFACT_READER_PRIVATE_KEY", "PSM_TARGET_KNOWN_HOSTS", "PSM_TARGET_SSH_PRIVATE_KEY"], ["PSM_ARTIFACT_READER_APP_ID"]);
  const check = async () => (await adapters.controllerReadiness(unit, { checkoutId: "chk_1", environment })).find((item) => item.id === "web:target-contract");
  const before = await check();
  assert.equal(before?.ready, false);
  assert.match(before?.detail ?? "", new RegExp(`changed from sha256:${"c".repeat(12)}… to ${live.targetDigest}`));
  await assert.rejects(adapters.pinTargetContract(unit, { checkoutId: "chk_1", environment }, `sha256:${"d".repeat(64)}`), /not the reviewed/);
  const pinned = await adapters.pinTargetContract(unit, { checkoutId: "chk_1", environment }, live.targetDigest);
  assert.deepEqual(pinned.connections.sort(), ["ci", "host"], "every connection that pinned the old digest moves with it");
  assert.equal((await check())?.ready, true);
});

test("a controller without the artifact-reader App credentials cannot release", async (t) => {
  const adapters = await fixture(t);
  stubGitHub(t, current, ["PSM_TARGET_KNOWN_HOSTS", "PSM_TARGET_SSH_PRIVATE_KEY"]);
  const checks = await adapters.controllerReadiness(unit, { checkoutId: "chk_1", environment });
  const reader = checks.find((check) => check.id === "web:controller-artifact-reader");
  assert.equal(reader?.ready, false);
  assert.match(reader?.detail ?? "", /variable PSM_ARTIFACT_READER_APP_ID and secret PSM_ARTIFACT_READER_PRIVATE_KEY/);
  assert.match(reader?.detail ?? "", /todo-staging-web environment at https:\/\/github\.com\/Werewolf-Solutions\/deployment-control\/settings\/environments /);
});

test("a bound GitHub connection that pins no controller for the target blocks the plan", async (t) => {
  // Observed 2026-09-29: the github slot was rebound to an App connection with no release
  // controllers; readiness said nothing and the run failed at dispatch two days later.
  const adapters = await fixture(t, undefined, false, false);
  const calls = stubGitHub(t, current, []);
  const checks = await adapters.controllerReadiness(unit, { checkoutId: "chk_1", environment });
  assert.deepEqual(checks.map((check) => [check.id, check.ready, check.purpose]), [["web:controller-pin", false, "deploy"]]);
  assert.match(checks[0].detail, /pins no werewolf-static@1 release controller for werewolf:todo-staging-web/);
  assert.deepEqual(calls, [], "the allowlist is answered without contacting GitHub");
});

test("without branch protection on its plan, anyone new who can push to the controller blocks the release", async (t) => {
  const adapters = await fixture(t, undefined, false, true, { branchProtection: "unavailable-on-plan", reviewedWriters: ["Oznerol92"] });
  const reviewed = async (writers: string[]) => {
    stubGitHub(t, current, ["PSM_ARTIFACT_READER_PRIVATE_KEY", "PSM_TARGET_KNOWN_HOSTS", "PSM_TARGET_SSH_PRIVATE_KEY"], ["PSM_ARTIFACT_READER_APP_ID"], "a".repeat(40), writers);
    return (await adapters.controllerReadiness(unit, { checkoutId: "chk_1", environment })).find((check) => check.id === "web:controller-writers");
  };
  assert.equal((await reviewed(["Oznerol92"]))?.ready, true);
  const added = await reviewed(["Oznerol92", "someone-else"]);
  assert.equal(added?.ready, false);
  assert.match(added?.detail ?? "", /^someone-else can now push to Werewolf-Solutions\/deployment-control/);
  assert.match(added?.detail ?? "", /https:\/\/github\.com\/Werewolf-Solutions\/deployment-control\/settings\/access/);
});

test("a controller with branch protection is not asked who can push", async (t) => {
  const adapters = await fixture(t);
  const calls = stubGitHub(t, current, ["PSM_ARTIFACT_READER_PRIVATE_KEY", "PSM_TARGET_KNOWN_HOSTS", "PSM_TARGET_SSH_PRIVATE_KEY"], ["PSM_ARTIFACT_READER_APP_ID"]);
  const checks = await adapters.controllerReadiness(unit, { checkoutId: "chk_1", environment });
  assert.ok(!checks.some((check) => check.id === "web:controller-writers"));
  assert.ok(!calls.some((call) => call.includes("/collaborators")));
});

test("a controller whose writers the App cannot see is not ready", async (t) => {
  const adapters = await fixture(t, undefined, false, true, { branchProtection: "unavailable-on-plan", reviewedWriters: [] });
  stubGitHub(t, current, ["PSM_ARTIFACT_READER_PRIVATE_KEY", "PSM_TARGET_KNOWN_HOSTS", "PSM_TARGET_SSH_PRIVATE_KEY"], ["PSM_ARTIFACT_READER_APP_ID"], "a".repeat(40), []);
  const check = (await adapters.controllerReadiness(unit, { checkoutId: "chk_1", environment })).find((item) => item.id === "web:controller-writers");
  assert.equal(check?.ready, false);
  assert.match(check?.detail ?? "", /cannot see who can push/);
});

test("App-managed missing target, moved pin and absent credentials use one bundle review instead of manual file edits", async (t) => {
  const adapters = await fixture(t, { targetDigest: `sha256:${"c".repeat(64)}` }, true);
  stubGitHub(t, {}, [], [], "c".repeat(40));
  const checks = await adapters.controllerReadiness(unit, { checkoutId: "chk_1", environment });
  for (const id of ["web:controller-pin", "web:controller-target", "web:controller-credentials"]) {
    const item = checks.find((check) => check.id === id)!;
    assert.equal(item.ready, false);
    assert.match(item.detail, /Review controller setup \/ update/);
    assert.match(item.detail, /Apply reviewed controller setup/);
    assert.doesNotMatch(item.detail, /Create it at|Edit it at|then pin the new commit/);
  }
});
