import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { setModeForTesting } from "../mode.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "psm-agent-"));
process.env.PSM_AGENT_FILE = path.join(sandbox, "agent.json");
process.env.PSM_HOSTED_ORIGIN = "https://psm.werewolf.solutions";

const { agentGuard, agentSecret, hostedOrigins, rotateAgentToken } = await import("./agent.ts");

/** Minimal express-shaped doubles — the guard only touches these fields. */
function fakeReq(overrides: any = {}) {
  return {
    method: "GET",
    path: "/api/projects",
    query: {},
    ...overrides,
    // merged last: a caller passing only `origin` must still get a valid Host
    headers: { host: "127.0.0.1:4317", ...(overrides.headers || {}) },
  } as any;
}

function fakeRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as any,
    ended: false,
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      res.ended = true;
      return res;
    },
    end() {
      res.ended = true;
      return res;
    },
  };
  return res;
}

function run(guard: any, req: any) {
  const res = fakeRes();
  let passed = false;
  guard(req, res, () => {
    passed = true;
  });
  return { res, passed };
}

test.after(() => {
  setModeForTesting(undefined);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("the pairing token is 0600 and stable across reads", () => {
  const first = agentSecret();
  const second = agentSecret();
  assert.equal(first.token, second.token);
  assert.ok(first.token.length >= 32);
  if (process.platform !== "win32") {
    const mode = fs.statSync(process.env.PSM_AGENT_FILE!).mode & 0o777;
    assert.equal(mode, 0o600, "a token file readable by other users is a shell for them");
  }
});

test("rotating replaces the token", () => {
  const before = agentSecret().token;
  const after = rotateAgentToken().token;
  assert.notEqual(before, after);
  assert.equal(agentSecret().token, after);
});

test("a non-loopback Host is refused even in agent mode", () => {
  setModeForTesting("agent");
  const { res, passed } = run(agentGuard(), fakeReq({ headers: { host: "psm.example.com" } }));
  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
});

test("requests with no Origin pass — curl and same-origin navigation still work", () => {
  setModeForTesting("agent");
  const { passed } = run(agentGuard(), fakeReq());
  assert.equal(passed, true);
});

test("a loopback Origin passes without any token", () => {
  setModeForTesting("agent");
  const { passed } = run(agentGuard(), fakeReq({ headers: { origin: "http://localhost:4317" } }));
  assert.equal(passed, true, "the local cockpit must never need pairing");
});

test("dev mode refuses the hosted origin outright", () => {
  setModeForTesting("dev");
  const { res, passed } = run(
    agentGuard(),
    fakeReq({ headers: { origin: "https://psm.werewolf.solutions", authorization: `Bearer ${agentSecret().token}` } }),
  );
  assert.equal(passed, false, "only agent mode opens the boundary");
  assert.equal(res.statusCode, 403);
});

test("an unpaired hosted origin is rejected with a code the UI can act on", () => {
  setModeForTesting("agent");
  const { res, passed } = run(agentGuard(), fakeReq({ headers: { origin: "https://psm.werewolf.solutions" } }));
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "agent_unpaired");
});

test("a wrong token is rejected", () => {
  setModeForTesting("agent");
  const { res, passed } = run(
    agentGuard(),
    fakeReq({ headers: { origin: "https://psm.werewolf.solutions", authorization: "Bearer not-the-token" } }),
  );
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
});

test("the right token from the allowlisted origin gets through, with CORS headers", () => {
  setModeForTesting("agent");
  const { res, passed } = run(
    agentGuard(),
    fakeReq({ headers: { origin: "https://psm.werewolf.solutions", authorization: `Bearer ${agentSecret().token}` } }),
  );
  assert.equal(passed, true);
  assert.equal(res.headers["access-control-allow-origin"], "https://psm.werewolf.solutions");
  assert.equal(res.headers["vary"], "Origin");
});

test("an origin that merely looks like the hosted one is refused", () => {
  setModeForTesting("agent");
  for (const origin of [
    "https://psm.werewolf.solutions.evil.com",
    "http://psm.werewolf.solutions",
    "https://evil.com",
  ]) {
    const { res, passed } = run(
      agentGuard(),
      fakeReq({ headers: { origin, authorization: `Bearer ${agentSecret().token}` } }),
    );
    assert.equal(passed, false, origin);
    assert.equal(res.statusCode, 403, origin);
  }
});

test("the Private Network Access preflight is answered", () => {
  setModeForTesting("agent");
  const { res, passed } = run(
    agentGuard(),
    fakeReq({
      method: "OPTIONS",
      headers: {
        origin: "https://psm.werewolf.solutions",
        "access-control-request-private-network": "true",
      },
    }),
  );
  assert.equal(passed, false, "a preflight is answered, not forwarded");
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-private-network"], "true");
  assert.equal(res.headers["access-control-allow-origin"], "https://psm.werewolf.solutions");
});

test("EventSource can authenticate by query, since it cannot set headers", () => {
  setModeForTesting("agent");
  const { passed } = run(
    agentGuard(),
    fakeReq({
      path: "/api/projects/x/logs/stream",
      headers: { origin: "https://psm.werewolf.solutions" },
      query: { agentToken: agentSecret().token },
    }),
  );
  assert.equal(passed, true);
});

test("declared public paths skip the token but still require an allowed origin", () => {
  setModeForTesting("agent");
  const guard = agentGuard({ publicPaths: ["/api/agent"] });
  const discovery = run(guard, fakeReq({ path: "/api/agent", headers: { origin: "https://psm.werewolf.solutions" } }));
  assert.equal(discovery.passed, true, "the hosted page must be able to detect an agent");

  const foreign = run(guard, fakeReq({ path: "/api/agent", headers: { origin: "https://evil.com" } }));
  assert.equal(foreign.passed, false);
  assert.equal(foreign.res.statusCode, 403);

  const guarded = run(guard, fakeReq({ path: "/api/projects", headers: { origin: "https://psm.werewolf.solutions" } }));
  assert.equal(guarded.passed, false, "everything else still needs the token");
});

test("the allowlist is configurable for staging origins", () => {
  const previous = process.env.PSM_HOSTED_ORIGIN;
  process.env.PSM_HOSTED_ORIGIN = "https://a.example, https://b.example/";
  assert.deepEqual(hostedOrigins(), ["https://a.example", "https://b.example"]);
  process.env.PSM_HOSTED_ORIGIN = previous;
});
