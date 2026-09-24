/**
 * Machine onboarding against a real SSH server: a disposable Ubuntu 20.04
 * container (see test-hosts.ts). Opt in with `PSM_MACHINE_DOCKER=1` for the
 * local unprivileged container, or `PSM_MACHINE_LXD=1` for the systemd LXD
 * container on the homelab. The ordinary test run stays hermetic and skips it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentPermissionStore } from "../agent-permissions.ts";
import { SecretBroker } from "../deploy/connections.ts";
import { DeploymentStore } from "../deploy/store.ts";
import { openDatabase } from "../db.ts";
import { MachineCommands } from "./commands.ts";
import { commandAccountName } from "./plan.ts";
import { ADMIN_CONNECTION_KIND, MachineService } from "./service.ts";
import { SshMachineTransport } from "./ssh.ts";
import { MachineStore } from "./store.ts";
import { selectedTestHost, startTestHost } from "./test-hosts.ts";

const hostKind = selectedTestHost();

async function waitFor<T>(what: string, attempt: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 40; i++) {
    try { return await attempt(); } catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw new Error(`${what}: ${String(last)}`);
}

test("machine onboarding against a disposable Ubuntu 20.04 server", { skip: !hostKind && "set PSM_MACHINE_DOCKER=1 or PSM_MACHINE_LXD=1 to run against a real server" }, async (t) => {
  const database = openDatabase(":memory:");
  const deployments = new DeploymentStore(database);
  const broker = new SecretBroker();
  const transport = new SshMachineTransport({ broker });
  const machineStore = new MachineStore(() => database);
  const service = new MachineService({ store: machineStore, deployments, broker, transport });

  const adminKey = await transport.generateKeyPair("psm test admin");
  const target = startTestHost(hostKind!, adminKey.publicKey);
  t.after(() => { target.close(); database.close(); });
  const { port } = target;
  const exec = target.exec;

  // 1. Connect: discover candidates, then register only with a confirmed fingerprint.
  const discovered = await waitFor("sshd", () => service.discover(target.address, port));
  const ed25519 = discovered.candidates.find((candidate) => candidate.keyType === "ssh-ed25519")!;
  const trueFingerprint = exec("ssh-keygen", "-lf", "/etc/ssh/ssh_host_ed25519_key.pub").split(" ")[1];
  assert.equal(ed25519.fingerprint, trueFingerprint, "scanned fingerprint matches the one the server itself reports");
  assert.throws(() => service.register({ workspaceId: "personal", name: "test", host: target.address, port, knownHost: ed25519.knownHost, confirmFingerprint: "SHA256:wrong" }), /does not match/);
  let machine = service.register({ workspaceId: "personal", name: "Ubuntu test host", host: target.address, port, knownHost: ed25519.knownHost, confirmFingerprint: trueFingerprint });
  assert.equal(machine.hostKeySource, "operator-confirmed");

  const addAdmin = async (connectionId: string, user: string) => {
    deployments.createConnection({
      connectionId, kind: ADMIN_CONNECTION_KIND, label: `${user} on test host`, secretGeneration: 0, readiness: "missing-secret",
      metadata: { publicMetadata: { knownHost: ed25519.knownHost }, credentialIdentity: null, requiredSecretSlots: ["privateKey"] },
      constraints: { allowedProjectIds: ["*"], allowedEnvironmentIds: ["*"], maximumAuthorizedRisk: "production", ssh: { host: target.address, user, port, hostKeyFingerprint: trueFingerprint } },
      createdAt: Date.now(),
    });
    // The broker zeroes what it is given, so each connection gets its own copy.
    await broker.put(connectionId, "privateKey", Buffer.from(adminKey.privateKey));
  };
  await addAdmin("admin-root", "root");
  await addAdmin("admin-nopass", "admin-nopass");
  await addAdmin("admin-pass", "admin-pass");
  machine = service.setAdminConnection(machine.id, "personal", machine.revision, "admin-nopass");

  // 2. Inspect through non-interactive sudo; nothing changes.
  const report = await service.inspect(machine.id, "personal");
  assert.equal(report.osId, "ubuntu");
  assert.equal(report.osVersion, "20.04");
  assert.equal(report.uid, 0, "inspection ran as root through sudo -n");
  assert.equal(report.helper, "absent");
  assert.deepEqual(report.conflicts, []);

  // 3. Set up the first project and verify from PSM as the new account.
  const todo = { id: "prj_todo", name: "Todo", workspaceId: "personal" };
  const access = await service.planCommandAccess({ machineId: machine.id, workspaceId: "personal", project: todo, environmentId: "staging", risk: "staging" });
  const first = service.startSetup({ accessId: access.id, workspaceId: "personal", planDigest: access.plan.digest, method: "admin-ssh", actor: "test" });
  const done = await service.settled(first.id);
  assert.equal(done.state, "succeeded", JSON.stringify(done.error));
  assert.deepEqual(done.steps.map((step) => step.status), ["done", "done", "done", "done", "done"]);
  const ready = service.getAccess(access.id, "personal");
  assert.equal(ready.state, "ready");
  assert.ok(ready.checks.every((check) => check.ok), JSON.stringify(ready.checks));
  assert.equal(exec("id", "-un", access.account), access.account);
  assert.equal(exec("stat", "-c", "%U:%G %a", `/home/${access.account}/.ssh/authorized_keys`), `root:${access.account} 640`);
  assert.equal(deployments.getConnection(access.connectionId).readiness, "ready");

  // A managed agent's server command runs as that account, in its directory, without sudo.
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "psm-real-host-"));
  t.after(() => fs.rmSync(checkout, { recursive: true, force: true }));
  const permissions = new AgentPermissionStore(() => database);
  const agentView = permissions.applyPreset({ id: todo.id, name: todo.name, path: checkout }, "operate-staging", 0, "test");
  const ran = await new MachineCommands(machineStore, transport).run({
    snapshot: agentView, permissions, environmentId: "staging",
    command: `id -un; pwd; sudo -n true 2>/dev/null && echo SUDO || echo nosudo; printf '%s\\n' "quote'test"; exit 3`,
  });
  assert.deepEqual(ran.stdout.trim().split("\n"), [access.account, access.workdir, "nosudo", "quote'test"]);
  assert.equal(ran.exitCode, 3);

  // 4. Repeat: the same access is reused and setup finds nothing to do.
  const again = await service.planCommandAccess({ machineId: machine.id, workspaceId: "personal", project: todo, environmentId: "staging", risk: "staging" });
  assert.equal(again.id, access.id);
  const repeat = await service.settled(service.startSetup({ accessId: access.id, workspaceId: "personal", planDigest: access.plan.digest, method: "admin-ssh", actor: "test" }).id);
  assert.equal(repeat.state, "succeeded");
  assert.equal(repeat.steps.find((step) => step.id === "apply")!.status, "skipped");
  assert.deepEqual(repeat.receipt, []);

  // 5. A second project reuses the machine and gets its own account and key.
  const api = { id: "prj_api", name: "Todo", workspaceId: "personal" };
  const second = await service.planCommandAccess({ machineId: machine.id, workspaceId: "personal", project: api, environmentId: "staging", risk: "staging" });
  assert.notEqual(second.account, access.account);
  assert.notEqual(second.publicKeyFingerprint, access.publicKeyFingerprint);
  assert.equal((await service.settled(service.startSetup({ accessId: second.id, workspaceId: "personal", planDigest: second.plan.digest, method: "admin-ssh", actor: "test" }).id)).state, "succeeded");
  assert.notEqual(exec("id", "-u", second.account), exec("id", "-u", access.account));
  // Neither account can use the other's working directory.
  assert.throws(() => exec("su", "-s", "/bin/sh", second.account, "-c", `touch /srv/psm/commands/${access.account}/x`));

  // 6. A colliding account stops setup before any change.
  const other = { id: "prj_other", name: "Other", workspaceId: "personal" };
  const taken = commandAccountName(machine.id, other.id, other.name, "staging");
  exec("useradd", "--shell", "/bin/sh", taken);
  const collide = await service.planCommandAccess({ machineId: machine.id, workspaceId: "personal", project: other, environmentId: "staging", risk: "staging" });
  const refused = await service.settled(service.startSetup({ accessId: collide.id, workspaceId: "personal", planDigest: collide.plan.digest, method: "admin-ssh", actor: "test" }).id);
  assert.equal(refused.state, "failed");
  assert.equal(refused.error?.code, "conflict");
  assert.match(refused.error!.message, /already exists with different settings/);
  assert.equal(refused.steps.find((step) => step.id === "apply")!.status, "pending");
  assert.throws(() => exec("test", "-e", `/srv/psm/commands/${taken}`));

  // 7. An administrator who needs a password gets the copyable command instead.
  machine = service.setAdminConnection(machine.id, "personal", service.getMachine(machine.id, "personal").revision, "admin-pass");
  const docs = { id: "prj_docs", name: "Docs", workspaceId: "personal" };
  const manual = await service.planCommandAccess({ machineId: machine.id, workspaceId: "personal", project: docs, environmentId: "production", risk: "production" });
  const needsPassword = await service.settled(service.startSetup({ accessId: manual.id, workspaceId: "personal", planDigest: manual.plan.digest, method: "admin-ssh", actor: "test" }).id);
  assert.equal(needsPassword.error?.code, "sudo-password-required");
  const waiting = service.startSetup({ accessId: manual.id, workspaceId: "personal", planDigest: manual.plan.digest, method: "manual-command", actor: "test" });
  const card = await waitFor("waiting", async () => {
    const job = service.getJob(waiting.id, "personal");
    if (job.state !== "waiting") throw new Error(job.state);
    return job;
  });
  assert.ok(card.command && !/PRIVATE|password/i.test(card.command));
  // Claimed success is not success: confirming before running the command fails verification.
  const premature = await service.confirmManualSetup(waiting.id, "personal");
  assert.equal(premature.state, "failed");
  assert.equal(premature.error?.code, "verification-failed");
  // The operator pastes the command into a root shell on the server.
  exec("bash", "-c", card.command!);
  const retried = service.startSetup({ accessId: manual.id, workspaceId: "personal", planDigest: manual.plan.digest, method: "manual-command", actor: "test" });
  await waitFor("waiting again", async () => { if (service.getJob(retried.id, "personal").state !== "waiting") throw new Error("not yet"); });
  const confirmed = await service.confirmManualSetup(retried.id, "personal");
  assert.equal(confirmed.state, "succeeded", JSON.stringify(confirmed.error));

  // 8. Another workspace cannot see or use this machine.
  assert.throws(() => service.getMachine(machine.id, "business:0123456789abcdef01234567"), /not found/);
  await assert.rejects(service.planCommandAccess({ machineId: machine.id, workspaceId: "personal", project: { ...todo, id: "prj_biz", workspaceId: "business:0123456789abcdef01234567" }, environmentId: "staging", risk: "staging" }), /different workspace/);

  // 9. A changed host key stops everything, and nothing is re-pinned silently.
  target.rotateHostKeys();
  machine = service.setAdminConnection(machine.id, "personal", service.getMachine(machine.id, "personal").revision, "admin-root");
  assert.equal(service.retry(done.id, "personal").state, "succeeded", "retrying finished work is a no-op");
  const changed = await service.settled(service.startSetup({ accessId: access.id, workspaceId: "personal", planDigest: access.plan.digest, method: "admin-ssh", actor: "test" }).id);
  assert.equal(changed.error?.code, "host-key-mismatch");
  assert.equal(service.getMachine(machine.id, "personal").hostKeyFingerprint, trueFingerprint);
});

test("host helper install and per-project deploy identities on a systemd server", { skip: (hostKind !== "lxd") && "set PSM_MACHINE_LXD=1: installing a service needs a systemd test host" }, async (t) => {
  const database = openDatabase(":memory:");
  const deployments = new DeploymentStore(database);
  const broker = new SecretBroker();
  const transport = new SshMachineTransport({ broker });
  const service = new MachineService({ store: new MachineStore(() => database), deployments, broker, transport });
  const adminKey = await transport.generateKeyPair("psm test admin");
  const target = startTestHost("lxd", adminKey.publicKey);
  t.after(() => { target.close(); database.close(); });
  const exec = target.exec;

  const [candidate] = (await waitFor("sshd", () => service.discover(target.address, target.port))).candidates.filter((entry) => entry.keyType === "ssh-ed25519");
  const fingerprint = exec("ssh-keygen", "-lf", "/etc/ssh/ssh_host_ed25519_key.pub").split(" ")[1];
  let machine = service.register({ workspaceId: "personal", name: "systemd test host", host: target.address, port: target.port, knownHost: candidate.knownHost, confirmFingerprint: fingerprint });
  deployments.createConnection({
    connectionId: "admin-nopass", kind: ADMIN_CONNECTION_KIND, label: "admin", secretGeneration: 0, readiness: "missing-secret",
    metadata: { publicMetadata: { knownHost: candidate.knownHost }, credentialIdentity: null, requiredSecretSlots: ["privateKey"] },
    constraints: { allowedProjectIds: ["*"], allowedEnvironmentIds: ["*"], maximumAuthorizedRisk: "production", ssh: { host: target.address, user: "admin-nopass", port: target.port, hostKeyFingerprint: fingerprint } },
    createdAt: Date.now(),
  });
  await broker.put("admin-nopass", "privateKey", Buffer.from(adminKey.privateKey));
  machine = service.setAdminConnection(machine.id, "personal", machine.revision, "admin-nopass");

  // A deploy access before the helper exists stops before any change.
  const todo = { id: "prj_todo", name: "Todo", workspaceId: "personal" };
  const early = await service.planDeployAccess({ machineId: machine.id, workspaceId: "personal", project: todo, environmentId: "staging", risk: "staging", hostname: "todo-staging.example.com", certbotEmail: "ops@example.com" });
  const blocked = await service.settled(service.startSetup({ accessId: early.id, workspaceId: "personal", planDigest: early.plan.digest, method: "admin-ssh", actor: "test" }).id);
  assert.equal(blocked.error?.code, "conflict");
  assert.match(blocked.error!.message, /helper-missing/);
  assert.throws(() => exec("id", early.account));

  // 1. Install the helper: build, upload, digest check, systemd service.
  const helper = await service.planHelperInstall({ machineId: machine.id, workspaceId: "personal" });
  assert.ok(helper.plan.operations.some((line) => /nginx and certbot/.test(line)));
  const installed = await service.settled(service.startSetup({ accessId: helper.id, workspaceId: "personal", planDigest: helper.plan.digest, method: "admin-ssh", actor: "test" }).id);
  assert.equal(installed.state, "succeeded", JSON.stringify(installed.error));
  assert.equal(exec("systemctl", "is-active", "psm-host-helper.service"), "active");
  assert.equal(exec("stat", "-c", "%U:%G %a", "/usr/local/libexec/psm-host-helper"), "root:root 755");
  assert.equal(exec("sh", "-c", "ls /tmp | grep -c '^psm-host-helper\\.' || true"), "0", "the uploaded binary is removed");
  assert.ok(service.getMachine(machine.id, "personal").helper?.sha256);
  const again = await service.settled(service.startSetup({ accessId: helper.id, workspaceId: "personal", planDigest: helper.plan.digest, method: "admin-ssh", actor: "test" }).id);
  assert.equal(again.steps.find((step) => step.id === "apply")!.status, "skipped");

  // 2. The same deploy access now sets up, and the helper's own fingerprint is pinned.
  const ready = await service.settled(service.retry(blocked.id, "personal").id);
  assert.equal(ready.state, "succeeded", JSON.stringify(ready.error));
  const access = service.getAccess(early.id, "personal");
  assert.ok(access.checks.every((check) => check.ok), JSON.stringify(access.checks));
  const plan = access.plan as import("./roles.ts").DeployAccessPlan;
  const host = deployments.getConnection(access.connectionId);
  const pinned = (host.metadata as any).publicMetadata.targetContracts[plan.target.targetId];
  assert.match(pinned.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(pinned.revision, plan.target.revision);
  assert.equal(host.readiness, "ready");
  assert.equal(deployments.getConnection(access.releaseConnectionId!).readiness, "ready");
  assert.equal(exec("id", "-Gn", plan.release.account), `${plan.release.account} psm-deploy`);
  assert.match(exec("cat", plan.target.file), /"certbotEmail": "ops@example.com"/);

  // 3. A second project on the same machine: new identities, same helper, no reinstall.
  const api = { id: "prj_api", name: "API", workspaceId: "personal" };
  const second = await service.planDeployAccess({ machineId: machine.id, workspaceId: "personal", project: api, environmentId: "staging", risk: "staging", hostname: "api-staging.example.com", certbotEmail: "ops@example.com" });
  assert.equal((await service.settled(service.startSetup({ accessId: second.id, workspaceId: "personal", planDigest: second.plan.digest, method: "admin-ssh", actor: "test" }).id)).state, "succeeded");
  assert.notEqual(second.account, access.account);
  // Todo's infrastructure identity cannot act on the API target.
  const secondPlan = second.plan as import("./roles.ts").DeployAccessPlan;
  const { SshHostHelperTransport, hostHelperRequest } = await import("../deploy/adapters/host-helper.ts");
  const { profileFromRecord } = await import("../deploy/service.ts");
  await assert.rejects(
    new SshHostHelperTransport({ broker }).invoke({ connection: profileFromRecord(deployments.getConnection(access.connectionId)), request: hostHelperRequest({ targetId: secondPlan.target.targetId, operation: "observe-target", desired: {} }) }),
    (error: { code?: string }) => error.code === "not-authorized",
  );

  // 3b. A second, separately revocable release key for the CI controller.
  const ci = await service.planCiKey(access.id, "personal");
  assert.equal(ci.account, plan.release.account);
  const ciJob = await service.settled(service.startSetup({ accessId: ci.id, workspaceId: "personal", planDigest: ci.plan.digest, method: "admin-ssh", actor: "test" }).id);
  assert.equal(ciJob.state, "succeeded", JSON.stringify(ciJob.error));
  const keyLines = exec("cat", `/home/${plan.release.account}/.ssh/authorized_keys`).split("\n");
  assert.equal(keyLines.length, 2);
  assert.ok(keyLines.every((line) => line.startsWith('command="/usr/local/libexec/psm-host-helper-client",restrict ssh-ed25519 ')));
  const ciConnection = deployments.getConnection(ci.connectionId);
  assert.equal(ciConnection.readiness, "ready");
  assert.deepEqual((ciConnection.metadata as any).publicMetadata.targetContracts, (host.metadata as any).publicMetadata.targetContracts);
  assert.equal((await service.settled(service.startSetup({ accessId: ci.id, workspaceId: "personal", planDigest: ci.plan.digest, method: "admin-ssh", actor: "test" }).id)).steps.find((step) => step.id === "apply")!.status, "skipped");

  // 4. Repeat is a no-op; revocation removes PSM's keys but leaves the server alone.
  const repeat = await service.settled(service.startSetup({ accessId: access.id, workspaceId: "personal", planDigest: access.plan.digest, method: "admin-ssh", actor: "test" }).id);
  assert.equal(repeat.steps.find((step) => step.id === "apply")!.status, "skipped");
  await service.revokeAccess(access.id, "personal", service.getAccess(access.id, "personal").revision);
  assert.throws(() => deployments.getConnection(access.connectionId), /not found/);
  assert.throws(() => deployments.getConnection(access.releaseConnectionId!), /not found/);
  assert.equal(exec("id", "-un", access.account), access.account);

  // 5. A newer helper build replaces the installed one only through a plan that
  //    names the installed file's exact digest; so does a target enrolled for
  //    other accounts (how a hand-bootstrapped host is adopted).
  const { buildHostHelper } = await import("./roles.ts");
  const { createHash } = await import("node:crypto");
  const newer = new MachineService({
    store: new MachineStore(() => database), deployments, broker, transport,
    buildHelper: (arch) => {
      const base = buildHostHelper(arch);
      const file = `${base.file}.newer`;
      fs.writeFileSync(file, Buffer.concat([fs.readFileSync(base.file), Buffer.from("\n")]));
      const bytes = fs.readFileSync(file);
      return { ...base, file, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
    },
  });
  const installedSha = exec("sha256sum", "/usr/local/libexec/psm-host-helper").split(" ")[0];
  const upgrade = await newer.planHelperInstall({ machineId: machine.id, workspaceId: "personal" });
  const stopped = await newer.settled(newer.startSetup({ accessId: upgrade.id, workspaceId: "personal", planDigest: upgrade.plan.digest, method: "admin-ssh", actor: "test" }).id);
  assert.equal(stopped.error?.code, "replaceable", JSON.stringify(stopped.error));
  assert.equal(exec("sha256sum", "/usr/local/libexec/psm-host-helper").split(" ")[0], installedSha, "nothing changed");
  const replacing = await newer.planReplacement(upgrade.id, "personal");
  assert.equal((replacing.plan as import("./roles.ts").HelperInstallPlan).replaces?.binary, installedSha);
  assert.ok(replacing.plan.operations[0].startsWith("Replace the installed /usr/local/libexec/psm-host-helper"));
  const upgraded = await newer.settled(newer.startSetup({ accessId: upgrade.id, workspaceId: "personal", planDigest: replacing.plan.digest, method: "admin-ssh", actor: "test" }).id);
  assert.equal(upgraded.state, "succeeded", JSON.stringify(upgraded.error));
  assert.equal(exec("sha256sum", "/usr/local/libexec/psm-host-helper").split(" ")[0], (replacing.plan as import("./roles.ts").HelperInstallPlan).helper.sha256);
  assert.equal(exec("stat", "-c", "%U:%G %a", `/var/lib/psm-deploy/replaced/binary.${installedSha}`), "root:root 755");
  assert.equal(exec("systemctl", "is-active", "psm-host-helper.service"), "active");

  const adopter = { id: "prj_todo2", name: "Todo two", workspaceId: "personal" };
  const adopt = await newer.planDeployAccess({ machineId: machine.id, workspaceId: "personal", project: adopter, environmentId: "staging", risk: "staging", targetId: plan.target.targetId, hostname: "todo-staging.example.com", certbotEmail: "ops@example.com" });
  const previous = exec("sha256sum", plan.target.file).split(" ")[0];
  const held = await newer.settled(newer.startSetup({ accessId: adopt.id, workspaceId: "personal", planDigest: adopt.plan.digest, method: "admin-ssh", actor: "test" }).id);
  assert.equal(held.error?.code, "replaceable", JSON.stringify(held.error));
  assert.throws(() => exec("id", adopt.account), "no account was created before the review");
  const adopting = await newer.planReplacement(adopt.id, "personal");
  assert.equal((adopting.plan as import("./roles.ts").DeployAccessPlan).target.replaces, previous);
  const adopted = await newer.settled(newer.startSetup({ accessId: adopt.id, workspaceId: "personal", planDigest: adopting.plan.digest, method: "admin-ssh", actor: "test" }).id);
  assert.equal(adopted.state, "succeeded", JSON.stringify(adopted.error));
  assert.match(exec("cat", plan.target.file), new RegExp(`"deployUid": ${exec("id", "-u", adopt.account)},`));
  assert.equal(exec("stat", "-c", "%a", `/var/lib/psm-deploy/replaced/target.${previous}.json`), "640");
});

test("one-time administrator handoff when sudo needs a password, then automatic setup and release", { skip: (hostKind !== "lxd") && "set PSM_MACHINE_LXD=1: needs a systemd test host" }, async (t) => {
  const database = openDatabase(":memory:");
  const deployments = new DeploymentStore(database);
  const broker = new SecretBroker();
  const transport = new SshMachineTransport({ broker });
  const service = new MachineService({ store: new MachineStore(() => database), deployments, broker, transport });
  const adminKey = await transport.generateKeyPair("psm test admin");
  const target = startTestHost("lxd", adminKey.publicKey);
  t.after(() => { target.close(); database.close(); });
  const [candidate] = (await waitFor("sshd", () => service.discover(target.address, target.port))).candidates.filter((entry) => entry.keyType === "ssh-ed25519");
  const fingerprint = target.exec("ssh-keygen", "-lf", "/etc/ssh/ssh_host_ed25519_key.pub").split(" ")[1];
  let machine = service.register({ workspaceId: "personal", name: "handoff host", host: target.address, port: target.port, knownHost: candidate.knownHost, confirmFingerprint: fingerprint });
  // The operator's own login needs a password for sudo, so PSM cannot set up on its own.
  deployments.createConnection({
    connectionId: "admin-pass", kind: ADMIN_CONNECTION_KIND, label: "admin", secretGeneration: 0, readiness: "missing-secret",
    metadata: { publicMetadata: { knownHost: candidate.knownHost }, credentialIdentity: null, requiredSecretSlots: ["privateKey"] },
    constraints: { allowedProjectIds: ["*"], allowedEnvironmentIds: ["*"], maximumAuthorizedRisk: "production", ssh: { host: target.address, user: "admin-pass", port: target.port, hostKeyFingerprint: fingerprint } },
    createdAt: Date.now(),
  });
  await broker.put("admin-pass", "privateKey", Buffer.from(adminKey.privateKey));
  machine = service.setAdminConnection(machine.id, "personal", machine.revision, "admin-pass");
  const helperFirst = await service.planHelperInstall({ machineId: machine.id, workspaceId: "personal" }).catch((error) => error);
  assert.match(String(helperFirst?.message ?? helperFirst), /needs a password for sudo|sudo/i, "inspection itself needs root and says why");

  // 1. PSM plans its own administrator access; the operator pastes one command.
  const admin = await service.planAdminAccess({ machineId: machine.id, workspaceId: "personal" });
  assert.ok(admin.plan.authority[0].startsWith("Full administration"));
  const waiting = service.startSetup({ accessId: admin.id, workspaceId: "personal", planDigest: admin.plan.digest, method: "manual-command", actor: "test" });
  const card = await waitFor("waiting", async () => { const job = service.getJob(waiting.id, "personal"); if (job.state !== "waiting") throw new Error(job.state); return job; });
  assert.equal((await service.probeManualSetup(waiting.id, "personal")).state, "waiting", "nothing has run yet");
  target.exec("bash", "-c", card.command!);
  // 2. The probe notices on its own, verifies, and adopts the new administrator connection.
  const done = await service.probeManualSetup(waiting.id, "personal");
  assert.equal(done.state, "succeeded", JSON.stringify(done.error));
  machine = service.getMachine(machine.id, "personal") as typeof machine;
  assert.equal(machine.adminConnectionId, admin.connectionId);

  // 3. Everything else is now automatic: the helper installs over the new access.
  const helper = await service.planHelperInstall({ machineId: machine.id, workspaceId: "personal" });
  const installed = await service.settled(service.startSetup({ accessId: helper.id, workspaceId: "personal", planDigest: helper.plan.digest, method: "admin-ssh", actor: "test" }).id);
  assert.equal(installed.state, "succeeded", JSON.stringify(installed.error));

  // 4. Releasing removes the sudoers entry and key on the server, and PSM forgets the connection.
  await service.releaseAdminAccess(admin.id, "personal");
  assert.throws(() => target.exec("test", "-e", `/etc/sudoers.d/${admin.account}`));
  assert.throws(() => target.exec("test", "-e", `/home/${admin.account}/.ssh/authorized_keys`));
  assert.equal(service.getMachine(machine.id, "personal").adminConnectionId, null);
  assert.throws(() => deployments.getConnection(admin.connectionId), /not found/);
  assert.equal(target.exec("systemctl", "is-active", "psm-host-helper.service"), "active", "what it set up keeps working");
});
