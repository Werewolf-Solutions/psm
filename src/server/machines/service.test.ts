import assert from "node:assert/strict";
import test from "node:test";

import { SecretBroker } from "../deploy/connections.ts";
import { DeploymentStore } from "../deploy/store.ts";
import { openDatabase } from "../db.ts";
import { ADMIN_CONNECTION_KIND, MachineService } from "./service.ts";
import { MachineTransportError, type MachineTransport, type SshEndpoint, type SshResult } from "./ssh.ts";
import { MachineStore } from "./store.ts";

const HOST_BLOB = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]).toString("base64");
const KNOWN = `203.0.113.4 ssh-ed25519 ${HOST_BLOB}`;
let keyCounter = 0;

/** A server simulated in memory: enough state to answer the setup script's report. */
class FakeServer implements MachineTransport {
  accounts = new Map<string, { key: string }>();
  calls: string[] = [];
  failNextApply: "timeout-after-applying" | null = null;

  async run(endpoint: SshEndpoint, command: string, input: string | Buffer = ""): Promise<SshResult> {
    input = String(input);
    this.calls.push(`${endpoint.user}: ${command.split(" ").slice(0, 4).join(" ")}`);
    if (command === "echo psm-identity-ok") return { code: 0, stdout: "psm-identity-ok\n", stderr: "" };
    const account = /readonly PSM_ACCOUNT='([^']+)'/.exec(input)?.[1];
    const authorized = /readonly PSM_AUTHORIZED='([^']+)'/.exec(input)?.[1];
    if (command.includes("--inspect") || command.includes("--apply")) {
      if (command.includes("--apply")) {
        this.accounts.set(account!, { key: authorized! });
        if (this.failNextApply) { this.failNextApply = null; throw new MachineTransportError("timed out", "timeout"); }
      }
      const existing = this.accounts.get(account!);
      const lines = ["psm.schema=1", "psm.kernel=Linux", "psm.arch=x86_64", "psm.os_id=ubuntu", "psm.os_version=20.04", "psm.uid=0",
        `psm.account=${existing ? "present" : "absent"}`, `psm.key=${existing ? (existing.key === authorized ? "match" : "differs") : "absent"}`,
        `psm.workdir=${existing ? "present" : "absent"}`, `psm.result=${command.includes("--apply") ? "applied" : "inspected"}`];
      if (existing && existing.key !== authorized) lines.push("psm.conflict=key-differs:rotate-explicitly");
      return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
    }
    // Verification, run as the command account itself.
    if (!this.accounts.has(endpoint.user)) throw new MachineTransportError("Permission denied (publickey).", "auth-failed");
    return { code: 0, stdout: `user=${endpoint.user}\ngroups=${endpoint.user}\nwrite=ok\nsudo=no\nhelper=no\n`, stderr: "" };
  }

  async scanHostKeys(): Promise<string[]> { return [KNOWN]; }

  async generateKeyPair(): Promise<{ privateKey: Buffer; publicKey: string }> {
    keyCounter += 1;
    const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, keyCounter)]).toString("base64");
    return { privateKey: Buffer.from(`private-${keyCounter}`), publicKey: `ssh-ed25519 ${blob} test` };
  }
}

async function fixture(t: test.TestContext) {
  const database = openDatabase(":memory:");
  t.after(() => database.close());
  const deployments = new DeploymentStore(database);
  const broker = new SecretBroker();
  const server = new FakeServer();
  const store = new MachineStore(() => database);
  let now = 1_000_000;
  const service = new MachineService({ store, deployments, broker, transport: server, now: () => now });
  const [candidate] = (await service.discover("203.0.113.4", 22)).candidates;
  let machine = service.register({ workspaceId: "personal", name: "alpha", host: "203.0.113.4", port: 22, knownHost: candidate.knownHost, confirmFingerprint: candidate.fingerprint });
  deployments.createConnection({
    connectionId: "admin", kind: ADMIN_CONNECTION_KIND, label: "admin", secretGeneration: 0, readiness: "missing-secret",
    metadata: { publicMetadata: { knownHost: KNOWN }, credentialIdentity: null, requiredSecretSlots: ["privateKey"] },
    constraints: { allowedProjectIds: ["*"], allowedEnvironmentIds: ["*"], maximumAuthorizedRisk: "production", ssh: { host: "203.0.113.4", user: "root", port: 22, hostKeyFingerprint: candidate.fingerprint } },
    createdAt: now,
  });
  await broker.put("admin", "privateKey", "admin-key");
  machine = service.setAdminConnection(machine.id, "personal", machine.revision, "admin");
  const project = { id: "prj_todo", name: "Todo", workspaceId: "personal" };
  return { database, deployments, broker, server, store, service, machine, project, advance: (ms: number) => { now += ms; } };
}

test("a scanned key must be confirmed before PSM connects, and a wrong confirmation is refused", async (t) => {
  const { service } = await fixture(t);
  const unverified = service.register({ workspaceId: "personal", name: "beta", host: "203.0.113.4", port: 2222, knownHost: `[203.0.113.4]:2222 ssh-ed25519 ${HOST_BLOB}` });
  assert.equal(unverified.hostKeySource, "scanned-unverified");
  await assert.rejects(service.inspect(unverified.id, "personal"), /Confirm this machine's host key/);
  await assert.rejects(service.planCommandAccess({ machineId: unverified.id, workspaceId: "personal", project: { id: "p", name: "p", workspaceId: "personal" }, environmentId: "staging", risk: "staging" }), /Confirm/);
  assert.throws(() => service.confirmHostKey(unverified.id, "personal", unverified.revision, "SHA256:nope"), /does not match/);
  const confirmed = service.confirmHostKey(unverified.id, "personal", unverified.revision, unverified.hostKeyFingerprint);
  assert.equal(confirmed.hostKeySource, "operator-confirmed");
  assert.throws(() => service.register({ workspaceId: "personal", name: "dup", host: "203.0.113.4", port: 22, knownHost: KNOWN }), /already registered/);
});

test("an administrator connection must pin exactly this machine", async (t) => {
  const { service, deployments, machine } = await fixture(t);
  deployments.createConnection({
    connectionId: "elsewhere", kind: ADMIN_CONNECTION_KIND, label: "x", secretGeneration: 0, readiness: "missing-secret",
    metadata: { publicMetadata: { knownHost: KNOWN }, credentialIdentity: null, requiredSecretSlots: ["privateKey"] },
    constraints: { allowedProjectIds: ["*"], allowedEnvironmentIds: ["*"], maximumAuthorizedRisk: "production", ssh: { host: "198.51.100.9", user: "root", port: 22, hostKeyFingerprint: machine.hostKeyFingerprint } },
    createdAt: 1,
  });
  assert.throws(() => service.setAdminConnection(machine.id, "personal", machine.revision, "elsewhere"), /different endpoint/);
  assert.throws(() => service.setAdminConnection(machine.id, "personal", machine.revision, "missing"), /no longer exists/);
});

test("setup approves exactly the reviewed plan, and a machine is invisible to other workspaces", async (t) => {
  const { service, machine, project } = await fixture(t);
  const access = await service.planCommandAccess({ machineId: machine.id, workspaceId: "personal", project, environmentId: "staging", risk: "staging" });
  assert.throws(() => service.startSetup({ accessId: access.id, workspaceId: "personal", planDigest: "sha256:other", method: "admin-ssh", actor: "t" }), /changed since it was reviewed/);
  assert.throws(() => service.getMachine(machine.id, "business:0123456789abcdef01234567"), /not found/);
  assert.throws(() => service.startSetup({ accessId: access.id, workspaceId: "business:0123456789abcdef01234567", planDigest: access.plan.digest, method: "admin-ssh", actor: "t" }), /not found/);
  await assert.rejects(service.planCommandAccess({ machineId: machine.id, workspaceId: "personal", project: { ...project, workspaceId: "business:0123456789abcdef01234567" }, environmentId: "staging", risk: "staging" }), /different workspace/);
  const job = await service.settled(service.startSetup({ accessId: access.id, workspaceId: "personal", planDigest: access.plan.digest, method: "admin-ssh", actor: "t" }).id);
  assert.equal(job.state, "succeeded", JSON.stringify(job.error));
  assert.equal(job.approvedBy, "t");
});

test("an apply cut off mid-flight is uncertain, and the retry inspects instead of replaying", async (t) => {
  const { service, server, machine, project } = await fixture(t);
  const access = await service.planCommandAccess({ machineId: machine.id, workspaceId: "personal", project, environmentId: "staging", risk: "staging" });
  server.failNextApply = "timeout-after-applying";
  const failed = await service.settled(service.startSetup({ accessId: access.id, workspaceId: "personal", planDigest: access.plan.digest, method: "admin-ssh", actor: "t" }).id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error?.code, "uncertain");
  assert.equal(failed.steps.find((step) => step.id === "apply")!.status, "uncertain");
  assert.equal(service.getAccess(access.id, "personal").state, "failed");
  server.calls = [];
  const retried = await service.settled(service.retry(failed.id, "personal").id);
  assert.equal(retried.state, "succeeded");
  assert.equal(retried.attempts, 2);
  assert.equal(retried.steps.find((step) => step.id === "apply")!.status, "skipped", "the inspection found the work already done");
  assert.ok(!server.calls.some((call) => call.includes("--apply")), server.calls.join("\n"));
});

test("a process that died mid-job leaves it failed and uncertain, not running forever", async (t) => {
  const { service, store, machine, project, advance } = await fixture(t);
  const access = await service.planCommandAccess({ machineId: machine.id, workspaceId: "personal", project, environmentId: "staging", risk: "staging" });
  const job = store.saveJob({
    id: "msj_dead", machineId: machine.id, accessId: access.id, method: "admin-ssh", planDigest: access.plan.digest, state: "running",
    steps: [{ id: "apply", title: "apply", status: "running", detail: "", startedAt: 1, finishedAt: null }], receipt: [], error: null,
    approvedBy: "t", lease: { owner: "someone-else", expiresAt: 1_000_500 }, attempts: 1, createdAt: 1, updatedAt: 1,
  });
  assert.equal(service.recoverInterrupted(), 0, "a live lease is left alone");
  advance(1_000);
  assert.equal(service.recoverInterrupted(), 1);
  const recovered = store.getJob(job.id);
  assert.equal(recovered.state, "failed");
  assert.equal(recovered.error?.code, "interrupted");
  assert.equal(recovered.steps[0].status, "uncertain");
});

test("revoking access removes PSM's connection and key but leaves the server account alone", async (t) => {
  const { service, server, deployments, broker, machine, project } = await fixture(t);
  const access = await service.planCommandAccess({ machineId: machine.id, workspaceId: "personal", project, environmentId: "staging", risk: "staging" });
  assert.equal((await broker.status(access.connectionId, ["privateKey"])).ready, true);
  await service.settled(service.startSetup({ accessId: access.id, workspaceId: "personal", planDigest: access.plan.digest, method: "admin-ssh", actor: "t" }).id);
  const revoked = await service.revokeAccess(access.id, "personal", service.getAccess(access.id, "personal").revision);
  assert.equal(revoked.state, "revoked");
  assert.throws(() => deployments.getConnection(access.connectionId), /not found/);
  assert.equal((await broker.status(access.connectionId, ["privateKey"])).ready, false);
  assert.ok(server.accounts.has(access.account), "cleanup of the server account is a separate reviewed action");
  assert.throws(() => service.startSetup({ accessId: access.id, workspaceId: "personal", planDigest: access.plan.digest, method: "admin-ssh", actor: "t" }), /revoked/);
  const replanned = await service.planCommandAccess({ machineId: machine.id, workspaceId: "personal", project, environmentId: "staging", risk: "staging" });
  assert.notEqual(replanned.id, access.id);
  assert.equal(replanned.account, access.account, "the same project environment maps to the same account name");
});

test("a key already authorized for that account is a conflict to rotate explicitly, not overwrite", async (t) => {
  const { service, server, machine, project } = await fixture(t);
  const access = await service.planCommandAccess({ machineId: machine.id, workspaceId: "personal", project, environmentId: "staging", risk: "staging" });
  server.accounts.set(access.account, { key: "restrict ssh-ed25519 SOMEONE-ELSE" });
  const job = await service.settled(service.startSetup({ accessId: access.id, workspaceId: "personal", planDigest: access.plan.digest, method: "admin-ssh", actor: "t" }).id);
  assert.equal(job.error?.code, "conflict");
  assert.match(job.error!.message, /rotate it explicitly/);
  assert.equal(server.accounts.get(access.account)!.key, "restrict ssh-ed25519 SOMEONE-ELSE");
});

test("deploy access follows the deployment manifest's target, root and domain", async (t) => {
  const database = openDatabase(":memory:");
  t.after(() => database.close());
  const deployments = new DeploymentStore(database);
  const broker = new SecretBroker();
  const server = new FakeServer();
  const service = new MachineService({
    store: new MachineStore(() => database), deployments, broker, transport: server,
    hostTarget: (projectId, environmentId) => projectId === "prj_todo" && environmentId === "staging"
      ? { unitId: "web", targetId: "werewolf:todo-staging-web", root: "/var/www/todo.werewolf.solutions", allowedRootPrefix: "/var/www", hostname: "todo.werewolf.solutions" }
      : null,
  });
  const [candidate] = (await service.discover("203.0.113.4", 22)).candidates;
  const machine = service.register({ workspaceId: "personal", name: "alpha", host: "203.0.113.4", port: 22, knownHost: candidate.knownHost, confirmFingerprint: candidate.fingerprint });
  const project = { id: "prj_todo", name: "Todo", workspaceId: "personal" };
  await assert.rejects(service.planDeployAccess({ machineId: machine.id, workspaceId: "personal", project, environmentId: "staging", risk: "staging", hostname: "other.example.com", certbotEmail: "ops@example.com" }), /serves todo.werewolf.solutions/);
  const access = await service.planDeployAccess({ machineId: machine.id, workspaceId: "personal", project, environmentId: "staging", risk: "staging", hostname: "", certbotEmail: "ops@example.com" });
  const plan = access.plan as import("./roles.ts").DeployAccessPlan;
  assert.equal(plan.target.targetId, "werewolf:todo-staging-web");
  assert.equal(plan.target.canonicalRoot, "/var/www/todo.werewolf.solutions");
  assert.equal(plan.target.hostname, "todo.werewolf.solutions");
  assert.deepEqual((deployments.getConnection(access.connectionId).constraints as any).allowedTargetIds, ["werewolf:todo-staging-web"]);
});
