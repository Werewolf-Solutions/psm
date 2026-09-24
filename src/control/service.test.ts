import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { DevelopmentVerifier, type Principal } from "./auth.ts";
import { SecretSealer } from "./crypto.ts";
import { openControlDatabase } from "./db.ts";
import { ControlService, LEASE_MS, validateJobSpec } from "./service.ts";

const ALICE_WS = "user:alice";
const BIZ = "business:0123456789abcdef01234567";

async function fixture(t: test.TestContext) {
  const database = openControlDatabase(":memory:");
  t.after(() => database.close());
  let now = 1_000_000;
  const service = new ControlService(database, new SecretSealer(randomBytes(32)), () => now);
  const verifier = new DevelopmentVerifier({
    alice: { subject: "alice", workspaces: { [ALICE_WS]: "owner", [BIZ]: "admin" } },
    bob: { subject: "bob", workspaces: { "user:bob": "owner", [BIZ]: "viewer" } },
    mallory: { subject: "mallory", workspaces: { "user:mallory": "owner" } },
  });
  const who = (token: string) => verifier.verify(token);
  return { service, alice: await who("alice"), bob: await who("bob"), mallory: await who("mallory"), advance: (ms: number) => { now += ms; } };
}

function runnerFor(service: ControlService, principal: Principal, workspace: string, images = ["node:22-bookworm-slim"]) {
  const { token } = service.createRegistration(principal, workspace);
  return service.registerRunner(token, { name: "r", capabilities: { images, backend: "test" } });
}

const job = (overrides: Record<string, unknown> = {}) => ({ kind: "command", title: "t", steps: ["echo hi"], ...overrides });

test("another workspace's jobs, secrets and runners read as missing or forbidden", async (t) => {
  const { service, alice, mallory } = await fixture(t);
  const created = service.createJob(alice, ALICE_WS, job());
  assert.throws(() => service.getJob(mallory, ALICE_WS, created.id), /Workspace not found/);
  assert.throws(() => service.getJob(mallory, "user:mallory", created.id), /Job not found/);
  assert.throws(() => service.listJobs(mallory, ALICE_WS), /Workspace not found/);
  service.putSecret(alice, ALICE_WS, "API_KEY", "sk-alice-secret");
  assert.throws(() => service.listSecrets(mallory, ALICE_WS), /Workspace not found/);
  assert.throws(() => service.createJob(mallory, "user:mallory", job({ secrets: [{ name: "API_KEY", env: "KEY" }] })), /no secret named API_KEY/);
  assert.throws(() => service.createRegistration(mallory, ALICE_WS), /Workspace not found/);
});

test("roles gate writes and management", async (t) => {
  const { service, bob, alice } = await fixture(t);
  assert.throws(() => service.createJob(bob, BIZ, job()), /read-only/);
  assert.throws(() => service.putSecret(bob, BIZ, "X", "y"), /cannot manage/);
  assert.equal(service.createJob(alice, BIZ, job()).workspaceId, BIZ);
  assert.equal(service.listJobs(bob, BIZ).length, 1, "a viewer can read");
});

test("registration tokens are single use and runners only lease their own workspace", async (t) => {
  const { service, alice, mallory } = await fixture(t);
  const { token } = service.createRegistration(alice, ALICE_WS);
  const { runner, credential } = service.registerRunner(token, { name: "a", capabilities: { images: ["node:22-bookworm-slim"] } });
  assert.throws(() => service.registerRunner(token, { name: "again", capabilities: {} }), /invalid, used or expired/);
  assert.equal(service.authenticateRunner(runner.id, credential).workspaceId, ALICE_WS);
  assert.throws(() => service.authenticateRunner(runner.id, "psmrun_wrong"), /not valid/);
  const other = runnerFor(service, mallory, "user:mallory").runner;
  const aliceJob = service.createJob(alice, ALICE_WS, job());
  assert.equal(service.lease(other), null, "mallory's runner never sees alice's job");
  assert.equal(service.lease(runner)?.id, aliceJob.id);
  assert.throws(() => service.heartbeat(other, aliceJob.id), /does not hold/);
  assert.throws(() => service.leaseSecrets(other, aliceJob.id), /does not hold/);
  service.revokeRunner(alice, ALICE_WS, runner.id);
  assert.throws(() => service.authenticateRunner(runner.id, credential), /not valid/);
});

test("a runner gets exactly the secrets its job declared, sealed per workspace", async (t) => {
  const { service, alice } = await fixture(t);
  service.putSecret(alice, ALICE_WS, "ANTHROPIC", "sk-ant-123456", "anthropic-api-key");
  service.putSecret(alice, ALICE_WS, "OTHER", "not-for-this-job");
  const { runner } = runnerFor(service, alice, ALICE_WS);
  const created = service.createJob(alice, ALICE_WS, job({ secrets: [{ name: "ANTHROPIC", env: "ANTHROPIC_API_KEY" }] }));
  service.lease(runner);
  assert.deepEqual(service.leaseSecrets(runner, created.id), { ANTHROPIC_API_KEY: "sk-ant-123456" });
  assert.ok(service.audit(alice, ALICE_WS).some((entry) => entry.action === "secrets.lease" && entry.subject === `${created.id}:ANTHROPIC`));
  assert.ok(!JSON.stringify(service.listSecrets(alice, ALICE_WS)).includes("sk-ant"), "listing shows fingerprints, never values");
  const sealer = new SecretSealer(randomBytes(32));
  const sealed = sealer.seal(ALICE_WS, "A", Buffer.from("v"));
  assert.throws(() => sealer.open("user:mallory", "A", sealed), "a sealed value does not open in another workspace");
  assert.throws(() => sealer.open(ALICE_WS, "B", sealed), "or under another name");
});

test("lapsed leases: never started is requeued, started is uncertain unless idempotent", async (t) => {
  const { service, alice, advance } = await fixture(t);
  const { runner } = runnerFor(service, alice, ALICE_WS);
  const notStarted = service.createJob(alice, ALICE_WS, job({ title: "a" }));
  service.lease(runner);
  advance(LEASE_MS + 1);
  assert.deepEqual(service.sweep().requeued, [notStarted.id]);
  const leased = service.lease(runner)!;
  service.heartbeat(runner, leased.id, true);
  advance(LEASE_MS + 1);
  assert.deepEqual(service.sweep().uncertain, [notStarted.id], "a started, non-idempotent job is uncertain");
  assert.equal(service.lease(runner), null, "and is not handed out again");
  const retried = service.retryUncertain(alice, ALICE_WS, notStarted.id);
  assert.equal(retried.state, "queued");
  const idempotent = service.createJob(alice, ALICE_WS, job({ title: "b", idempotent: true }));
  service.cancelJob(alice, ALICE_WS, notStarted.id);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const leasedAgain = service.lease(runner)!;
    assert.equal(leasedAgain.id, idempotent.id);
    service.heartbeat(runner, leasedAgain.id, true);
    advance(LEASE_MS + 1);
    const swept = service.sweep();
    if (attempt < 3) assert.deepEqual(swept.requeued, [idempotent.id]);
    else assert.deepEqual(swept.uncertain, [idempotent.id], "attempts are bounded");
  }
});

test("cancellation stops queued jobs at once and running jobs through the heartbeat", async (t) => {
  const { service, alice } = await fixture(t);
  const { runner } = runnerFor(service, alice, ALICE_WS);
  const queued = service.createJob(alice, ALICE_WS, job());
  assert.equal(service.cancelJob(alice, ALICE_WS, queued.id).state, "cancelled");
  const running = service.createJob(alice, ALICE_WS, job());
  service.lease(runner); service.heartbeat(runner, running.id, true);
  service.cancelJob(alice, ALICE_WS, running.id);
  assert.equal(service.heartbeat(runner, running.id, true).cancel, true);
  assert.equal(service.complete(runner, running.id, { exitCode: null, cancelled: true }).state, "cancelled");
  assert.throws(() => service.heartbeat(runner, running.id), /does not hold/, "a finished job has no lease");
});

test("enrollment intents are single use, expire, and are only readable in their workspace", async (t) => {
  const { service, alice, mallory, advance } = await fixture(t);
  const intent = service.createEnrollmentIntent(alice, ALICE_WS, { purpose: "machine-setup", binding: { planDigest: "sha256:abc" } });
  assert.throws(() => service.claimEnrollmentIntent(intent.intentId, "psmenr_wrong", {}), /Unknown setup intent/);
  service.claimEnrollmentIntent(intent.intentId, intent.token, { result: "applied" });
  assert.throws(() => service.claimEnrollmentIntent(intent.intentId, intent.token, {}), /already used/);
  assert.equal(service.getEnrollmentIntent(alice, ALICE_WS, intent.intentId).state, "claimed");
  assert.throws(() => service.getEnrollmentIntent(mallory, "user:mallory", intent.intentId), /not found/);
  const late = service.createEnrollmentIntent(alice, ALICE_WS, { purpose: "machine-setup", binding: {}, ttlMs: 60_000 });
  advance(61_000);
  assert.throws(() => service.claimEnrollmentIntent(late.intentId, late.token, {}), /expired/);
});

test("provider keys are checked with the provider, and only verification results are stored", async (t) => {
  const { service, alice } = await fixture(t);
  service.putSecret(alice, ALICE_WS, "ANTHROPIC", "sk-ant-valid", "anthropic-api-key");
  const seen: Array<Record<string, string>> = [];
  const ok = await service.verifyProviderKey(alice, ALICE_WS, "ANTHROPIC", (async (_url: string, init: RequestInit) => { seen.push(init.headers as Record<string, string>); return new Response("{}", { status: 200 }); }) as typeof fetch);
  assert.equal(ok.ok, true);
  assert.equal(seen[0]["x-api-key"], "sk-ant-valid");
  const bad = await service.verifyProviderKey(alice, ALICE_WS, "ANTHROPIC", (async () => new Response("{}", { status: 401 })) as typeof fetch);
  assert.deepEqual(bad, { ok: false, detail: "The provider rejected this key." });
  service.putSecret(alice, ALICE_WS, "PLAIN", "x");
  await assert.rejects(service.verifyProviderKey(alice, ALICE_WS, "PLAIN"), /Only model-provider keys/);
});

test("job specs reject credentials in URLs, bad names and oversized input", () => {
  assert.throws(() => validateJobSpec(job({ checkout: { repository: "https://user:pass@github.com/a/b.git", ref: "main" } })), /without credentials/);
  assert.throws(() => validateJobSpec(job({ checkout: { repository: "git@github.com:a/b.git", ref: "main" } })), /https/);
  assert.throws(() => validateJobSpec(job({ checkout: { repository: "https://github.com/a/b.git", ref: "../x" } })), /ref/);
  assert.throws(() => validateJobSpec(job({ secrets: [{ name: "A", env: "lower" }] })), /secret reference/);
  assert.throws(() => validateJobSpec(job({ steps: [] })), /1–20 steps/);
  assert.throws(() => validateJobSpec(job({ image: "UPPER/Case" })), /image/);
  assert.equal(validateJobSpec(job()).network, "none", "no network unless asked");
});
