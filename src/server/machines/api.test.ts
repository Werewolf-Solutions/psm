import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";

import { SecretBroker } from "../deploy/connections.ts";
import { DeploymentStore } from "../deploy/store.ts";
import { openDatabase } from "../db.ts";
import { machineRouter } from "./api.ts";
import { MachineService } from "./service.ts";
import type { MachineTransport } from "./ssh.ts";
import { MachineStore } from "./store.ts";

const HOST_BLOB = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]).toString("base64");

async function server(t: test.TestContext, options: { local?: boolean; business?: boolean } = {}) {
  const database = openDatabase(":memory:");
  const transport: MachineTransport = {
    run: async () => { throw new Error("no SSH in this test"); },
    scanHostKeys: async (host) => [`${host} ssh-ed25519 ${HOST_BLOB}`],
    generateKeyPair: async () => ({ privateKey: Buffer.from("k"), publicKey: `ssh-ed25519 ${Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 3)]).toString("base64")}` }),
  };
  const service = new MachineService({ store: new MachineStore(() => database), deployments: new DeploymentStore(database), broker: new SecretBroker(), transport });
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
