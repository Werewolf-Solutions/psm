import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";

import { SecretBroker } from "../deploy/connections.ts";
import { DeploymentStore } from "../deploy/store.ts";
import { openDatabase } from "../db.ts";
import { machineRouter } from "./api.ts";
import type { AuditCommandRunner } from "./audit.ts";
import { MachineService } from "./service.ts";
import type { MachineTransport } from "./ssh.ts";
import { MachineStore } from "./store.ts";

const HOST_BLOB = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]).toString("base64");

async function server(t: test.TestContext, options: { local?: boolean; business?: boolean; ssh?: boolean; auditRunner?: AuditCommandRunner; requireManifestTarget?: boolean } = {}) {
  const database = openDatabase(":memory:");
  const transport: MachineTransport = {
    run: async (_endpoint, command) => {
      if (!options.ssh) throw new Error("no SSH in this test");
      if (command === "sudo -n python3 -") return { code: 0, stdout: JSON.stringify({
        sshd: { available: true, code: 0, out: "passwordauthentication no\nkbdinteractiveauthentication no\npermitrootlogin no\npubkeyauthentication yes\n" },
        firewall: { available: true, code: 0, out: "Status: active\nDefault: deny (incoming)\n22/tcp ALLOW IN Anywhere\n" },
        listeners: { available: true, code: 0, out: "" }, updates: { available: true, code: 0, out: "enabled" }, lynis: { available: false, detail: "not installed" },
      }), stderr: "" };
      return { code: 0, stdout: command.includes("ufw status verbose") ? "Status: active\n22/tcp ALLOW IN Anywhere\n" : "Fresh inactive UFW firewall", stderr: "" };
    },
    scanHostKeys: async (host) => [`${host} ssh-ed25519 ${HOST_BLOB}`],
    generateKeyPair: async () => ({ privateKey: Buffer.from("k"), publicKey: `ssh-ed25519 ${Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 3)]).toString("base64")}` }),
  };
  const service = new MachineService({ store: new MachineStore(() => database), deployments: new DeploymentStore(database), broker: new SecretBroker(), transport, auditRunner: options.auditRunner, requireManifestTarget: options.requireManifestTarget });
  const app = express();
  app.use(express.json());
  app.use(machineRouter({
    service,
    localRequest: () => options.local ?? true,
    project: (id) => id === "prj_todo" ? { id, name: "Todo", workspaceId: "personal" } : null,
    authorize: async (ref) => ref === "personal" || options.business ? { ok: true } : { ok: false, status: 403, error: "not a member" },
    actor: () => "local:test",
  }));
  const listener = app.listen(0);
  t.after(() => { listener.close(); database.close(); });
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  return { call };
}

test("register, confirm and plan through the API, with the plan's authority shown before approval", async (t) => {
  const { call } = await server(t);
  const discovered = await call("POST", "/api/machines/discover", { host: "203.0.113.4" });
  assert.equal(discovered.status, 200);
  assert.equal(discovered.body.verified, false);
  const [candidate] = discovered.body.candidates;
  const unconfirmed = await call("POST", "/api/machines", { name: "alpha", host: "203.0.113.4", knownHost: candidate.knownHost });
  assert.equal(unconfirmed.status, 201);
  assert.equal(unconfirmed.body.machine.trusted, false);
  const blocked = await call("POST", `/api/machines/${unconfirmed.body.machine.id}/access`, { projectId: "prj_todo", environmentId: "staging" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "host-key-unverified");
  const confirmed = await call("POST", `/api/machines/${unconfirmed.body.machine.id}/confirm-host-key`, { fingerprint: candidate.fingerprint, revision: unconfirmed.body.machine.revision });
  assert.equal(confirmed.body.machine.trusted, true);
  const noObserver = await call("GET", `/api/machines/${confirmed.body.machine.id}/snapshot`);
  assert.equal(noObserver.status, 409);
  assert.equal(noObserver.body.code, "observer-access-missing");
  const planned = await call("POST", `/api/machines/${confirmed.body.machine.id}/access`, { projectId: "prj_todo", environmentId: "staging", risk: "staging" });
  assert.equal(planned.status, 201);
  assert.ok(planned.body.access.plan.authority.some((line: string) => /No sudo/.test(line)));
  assert.equal(planned.body.access.plan.script, undefined, "the script is served separately, on request");
  const script = await call("GET", `/api/machine-access/${planned.body.access.id}/script`);
  assert.match(script.body.command, /sha256sum -c/);
  const missing = await call("POST", `/api/machines/${confirmed.body.machine.id}/access`, { projectId: "prj_nope", environmentId: "staging" });
  assert.equal(missing.status, 404);
  const deploy = await call("POST", `/api/machines/${confirmed.body.machine.id}/deploy-access`, { projectId: "prj_todo", environmentId: "staging", risk: "staging", hostname: "todo.example.com", certbotEmail: "ops@example.com" });
  assert.equal(deploy.status, 201);
  assert.equal(deploy.body.access.plan.role, "deploy");
  assert.equal(deploy.body.access.plan.target.hostname, "todo.example.com");
  const noEmail = await call("POST", `/api/machines/${confirmed.body.machine.id}/deploy-access`, { projectId: "prj_todo", environmentId: "production", hostname: "todo.example.com" });
  assert.equal(noEmail.status, 400);
  assert.equal(noEmail.body.field, "certbotEmail");
  const invalid = await call("POST", "/api/machines", { name: "x", host: "root@evil; id", knownHost: "x" });
  assert.equal(invalid.status, 400);
});

test("changes need the local cockpit, and another workspace needs its own authority", async (t) => {
  const remote = await server(t, { local: false });
  const refused = await remote.call("POST", "/api/machines/discover", { host: "203.0.113.4" });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "local-authority-required");
  assert.equal((await remote.call("GET", "/api/machines")).status, 200, "reading stays available to a paired page");
  const local = await server(t);
  const business = await local.call("GET", "/api/machines?workspace=business:0123456789abcdef01234567");
  assert.equal(business.status, 403);
  assert.equal(business.body.code, "workspace-authority");
});

test("a droplet key is public-only, workspace scoped, and binds after host identity review", async (t) => {
  const { call } = await server(t, { business: true, ssh: true });
  const created = await call("POST", "/api/machine-bootstrap-keys", { name: "Lab droplet" });
  assert.equal(created.status, 201);
  assert.match(created.body.key.publicKey, /^ssh-ed25519 /);
  assert.equal(JSON.stringify(created.body).includes("PRIVATE KEY"), false);
  assert.equal((await call("GET", "/api/machine-bootstrap-keys?workspace=business:0123456789abcdef01234567")).body.keys.length, 0);
  const discovered = await call("POST", "/api/machines/discover", { host: "203.0.113.8" });
  const candidate = discovered.body.candidates[0];
  const registered = await call("POST", "/api/machines", { name: "Lab", host: "203.0.113.8", knownHost: candidate.knownHost });
  const id = registered.body.machine.id;
  const before = await call("POST", `/api/machines/${id}/bootstrap-access`, { connectionId: created.body.key.connectionId, user: "root" });
  assert.equal(before.status, 409);
  await call("POST", `/api/machines/${id}/confirm-host-key`, { fingerprint: candidate.fingerprint, revision: registered.body.machine.revision });
  const bound = await call("POST", `/api/machines/${id}/bootstrap-access`, { connectionId: created.body.key.connectionId, user: "root" });
  assert.equal(bound.status, 200);
  assert.equal(bound.body.machine.adminConnectionId, created.body.key.connectionId);
  assert.equal((await call("GET", "/api/machine-bootstrap-keys")).body.keys.length, 0);
  assert.equal((await call("DELETE", `/api/machine-bootstrap-keys/${created.body.key.connectionId}`)).status, 403);
});

test("firewall apply requires the exact reviewed plan and verified SSH key", async (t) => {
  const { call } = await server(t, { ssh: true });
  const created = await call("POST", "/api/machine-bootstrap-keys", { name: "Fresh droplet" });
  const candidate = (await call("POST", "/api/machines/discover", { host: "203.0.113.9" })).body.candidates[0];
  const registered = await call("POST", "/api/machines", { name: "Fresh", host: "203.0.113.9", knownHost: candidate.knownHost, confirmFingerprint: candidate.fingerprint });
  const id = registered.body.machine.id;
  await call("POST", `/api/machines/${id}/bootstrap-access`, { connectionId: created.body.key.connectionId, user: "root" });
  const review = await call("POST", `/api/machines/${id}/firewall-review`);
  assert.equal(review.status, 200);
  assert.match(review.body.plan.digest, /^sha256:/);
  assert.equal((await call("POST", `/api/machines/${id}/firewall-apply`, { digest: "sha256:wrong" })).status, 409);
  assert.equal((await call("POST", `/api/machines/${id}/firewall-apply`, { digest: review.body.plan.digest })).body.ok, true);
});

test("security audit is local, workspace-scoped and reports both vantages", async (t) => {
  const auditRunner: AuditCommandRunner = async (file, args) => ({ code: 0, stderr: "", stdout: file === "ssh-audit" ? "{}" : args.includes("-sU") ? "Nmap done: 1 IP address (1 host up)\n" : "22/tcp open ssh\nNmap done: 1 IP address (1 host up)\n" });
  const { call } = await server(t, { ssh: true, auditRunner });
  const candidate = (await call("POST", "/api/machines/discover", { host: "203.0.113.10" })).body.candidates[0];
  const registered = await call("POST", "/api/machines", { name: "Audit host", host: "203.0.113.10", knownHost: candidate.knownHost, confirmFingerprint: candidate.fingerprint });
  const id = registered.body.machine.id;
  const noAdmin = await call("POST", `/api/machines/${id}/security-audit`, { scope: "internal" });
  assert.equal(noAdmin.status, 409);
  const key = await call("POST", "/api/machine-bootstrap-keys", { name: "Audit host" });
  await call("POST", `/api/machines/${id}/bootstrap-access`, { connectionId: key.body.key.connectionId, user: "root" });
  const internal = await call("POST", `/api/machines/${id}/security-audit`, { scope: "internal" });
  assert.equal(internal.status, 200);
  assert.equal(internal.body.report.checks.find((check: { id: string }) => check.id === "ssh").status, "pass");
  const external = await call("POST", `/api/machines/${id}/security-audit`, { scope: "agent-external" });
  assert.equal(external.status, 200);
  assert.match(external.body.report.vantage, /PSM agent/);
  assert.equal(external.body.report.checks.find((check: { id: string }) => check.id === "tcp").status, "pass");
  assert.equal((await call("POST", `/api/machines/${id}/security-audit?workspace=business:0123456789abcdef01234567`, { scope: "agent-external" })).status, 403);
  assert.equal((await call("POST", `/api/machines/${id}/security-audit`, { scope: "anything" })).status, 400);
});

test("remote callers cannot initiate machine security scans", async (t) => {
  const { call } = await server(t, { local: false });
  assert.equal((await call("POST", "/api/machines/missing/security-audit", { scope: "agent-external" })).status, 403);
  assert.equal((await call("POST", "/api/machine-access/missing/repair-target")).status, 403);
});

test("deploy access cannot enroll a target before its manifest environment exists", async (t) => {
  const { call } = await server(t, { requireManifestTarget: true });
  const candidate = (await call("POST", "/api/machines/discover", { host: "203.0.113.11" })).body.candidates[0];
  const registered = await call("POST", "/api/machines", { name: "Lab", host: "203.0.113.11", knownHost: candidate.knownHost, confirmFingerprint: candidate.fingerprint });
  const result = await call("POST", `/api/machines/${registered.body.machine.id}/deploy-access`, {
    projectId: "prj_todo", environmentId: "production", risk: "production", hostname: "lab.example.com", certbotEmail: "ops@example.com",
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "deployment-target-missing");
  assert.deepEqual((await call("GET", `/api/machines/${registered.body.machine.id}`)).body.machine.access, []);
});
