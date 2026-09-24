import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { controlApp } from "./api.ts";
import { WerewolfVerifier } from "./auth.ts";
import { SecretSealer } from "./crypto.ts";
import { openControlDatabase } from "./db.ts";
import { ControlService } from "./service.ts";

const BIZ = "business:0123456789abcdef01234567";

/** A stand-in Werewolf: two users, one business they share with different roles. */
function werewolf(state: { down?: boolean; removed?: boolean }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (state.down) throw new Error("connection refused");
    const token = String((init?.headers as Record<string, string>)?.Authorization ?? "").replace("Bearer ", "");
    const users: Record<string, { id: string; role: string }> = { "token-alice-0123456789": { id: "alice1", role: "owner" }, "token-bob-012345678901": { id: "bob1", role: "viewer" } };
    const user = users[token];
    if (!user) return new Response(JSON.stringify({ success: false }), { status: 401 });
    if (url.endsWith("/apps/psm/me")) return new Response(JSON.stringify({ success: true, data: { user: { id: user.id, name: user.id } } }));
    if (url.endsWith("/apps/psm/workspaces")) {
      const list = state.removed && user.id === "bob1" ? [] : [{ ref: BIZ, kind: "business", role: user.role, canWrite: user.role !== "viewer", canManage: user.role === "owner" }];
      return new Response(JSON.stringify({ success: true, data: [{ ref: "personal", kind: "personal" }, ...list] }));
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

async function start(t: test.TestContext, state: { down?: boolean; removed?: boolean } = {}) {
  const database = openControlDatabase(":memory:");
  const service = new ControlService(database, new SecretSealer(randomBytes(32)));
  const app = controlApp({ service, verifier: new WerewolfVerifier("http://werewolf.test/api/v1", werewolf(state), 0), allowedOrigins: ["https://psm.werewolf.solutions"] });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => { server.close(); database.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, pathname: string, options: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      method, body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: { "Content-Type": "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...options.headers },
    });
    return { status: response.status, body: await response.json().catch(() => null) as any, headers: response.headers };
  };
  return { call };
}

const ALICE = "token-alice-0123456789";
const BOB = "token-bob-012345678901";

test("identity and membership come from Werewolf; personal workspaces are per user", async (t) => {
  const { call } = await start(t);
  assert.equal((await call("GET", "/api/v1/me")).status, 401);
  const me = await call("GET", "/api/v1/me", { token: ALICE });
  assert.deepEqual(me.body.workspaces.map((entry: any) => entry.ref).sort(), [BIZ, "user:alice1"]);
  assert.equal((await call("POST", `/api/v1/workspaces/${BIZ}/jobs`, { token: BOB, body: { kind: "command", title: "t", steps: ["x"] } })).status, 403, "a viewer cannot create jobs");
  assert.equal((await call("GET", "/api/v1/workspaces/user:alice1/jobs", { token: BOB })).status, 403, "another person's personal workspace");
  const created = await call("POST", `/api/v1/workspaces/${BIZ}/jobs`, { token: ALICE, body: { kind: "command", title: "t", steps: ["x"] } });
  assert.equal(created.status, 201);
  assert.equal((await call("GET", `/api/v1/workspaces/${BIZ}/jobs/${created.body.job.id}`, { token: BOB })).status, 200, "a viewer can read");
});

test("losing membership removes access, and an unreachable Werewolf is an error, not an empty list", async (t) => {
  const state: { down?: boolean; removed?: boolean } = {};
  const { call } = await start(t, state);
  assert.equal((await call("GET", `/api/v1/workspaces/${BIZ}/jobs`, { token: BOB })).status, 200);
  state.removed = true;
  assert.equal((await call("GET", `/api/v1/workspaces/${BIZ}/jobs`, { token: BOB })).status, 403);
  state.down = true;
  const down = await call("GET", `/api/v1/workspaces/${BIZ}/jobs`, { token: ALICE });
  assert.equal(down.status, 503);
  assert.equal(down.body.code, "identity-unavailable");
});

test("only listed browser origins may call the API, and runner routes need a runner credential", async (t) => {
  const { call } = await start(t);
  assert.equal((await call("GET", "/api/v1/me", { token: ALICE, headers: { Origin: "https://evil.example" } })).status, 403);
  const allowed = await call("GET", "/api/v1/me", { token: ALICE, headers: { Origin: "https://psm.werewolf.solutions" } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://psm.werewolf.solutions");
  assert.equal((await call("POST", "/runner/v1/lease", { token: ALICE })).status, 401, "a person's token is not a runner credential");
  assert.equal((await call("POST", "/runner/v1/register", { token: ALICE, body: { name: "x" } })).status, 401);
  assert.equal((await call("POST", "/enroll/v1/intents/int_x/claim", { token: "psmenr_x" })).status, 401);
});
