import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { setModeForTesting } from "../mode.ts";
import { authConfigured, currentUserId, hostedAuth } from "./auth.ts";

const SECRET = "test-signing-secret";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function hs256(payload: Record<string, unknown>, secret = SECRET): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

const future = () => Math.floor(Date.now() / 1000) + 600;

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

/** The middleware verifies asynchronously, so give the promise a tick to settle. */
async function run(req: any) {
  const res = fakeRes();
  let passedReq: any = null;
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    const originalJson = res.json;
    res.json = (payload: any) => {
      originalJson(payload);
      done();
      return res;
    };
    hostedAuth()(req, res, () => {
      passedReq = req;
      done();
    });
  });
  return { res, user: passedReq?.user };
}

const request = (headers: Record<string, string> = {}) =>
  ({ method: "GET", path: "/api/projects", headers }) as any;

test.beforeEach(() => {
  setModeForTesting("hosted");
  process.env.PSM_AUTH_SECRET = SECRET;
  // These cases exercise local JWT verification. Signing in through dapp is the
  // other strategy and is covered separately; leaving it on here would send a
  // rejected token off to the network before the assertion could be made.
  process.env.PSM_WEREWOLF_AUTH = "0";
  delete process.env.PSM_AUTH_ISSUER;
  delete process.env.PSM_AUTH_AUDIENCE;
});

test.after(() => {
  setModeForTesting(undefined);
  delete process.env.PSM_AUTH_SECRET;
  delete process.env.PSM_WEREWOLF_AUTH;
});

test("local modes are never asked for a session", async () => {
  setModeForTesting("dev");
  const { user, res } = await run(request());
  assert.equal(res.statusCode, 200);
  assert.equal(user, undefined, "dev mode has no accounts");
});

test("hosted with no auth configured at all fails closed", async () => {
  delete process.env.PSM_AUTH_SECRET;
  assert.equal(authConfigured(), false, "werewolf sign-in is off and no key is set");
  const { res } = await run(request({ authorization: `Bearer ${hs256({ sub: "u1", exp: future() })}` }));
  assert.equal(res.statusCode, 503, "serving unauthenticated is worse than serving nothing");
  assert.equal(res.body.code, "auth_unconfigured");
});

test("signing in through werewolf counts as configured on its own", () => {
  delete process.env.PSM_AUTH_SECRET;
  delete process.env.PSM_WEREWOLF_AUTH; // the default: dapp is the identity provider
  assert.equal(authConfigured(), true, "a deployment needs no key material to accept logins");
});

test("the sign-in routes stay reachable without a session", async () => {
  // Leaving for the consent screen and coming back are both things you do
  // precisely because you are not signed in yet.
  for (const path of [
    "/api/cloud/sso/start",
    "/api/cloud/sso/callback",
    "/api/auth/session",
    "/api/auth/logout",
  ]) {
    const { res } = await run({ ...request(), path });
    assert.equal(res.statusCode, 200, `${path} must not require what it hands out`);
  }
});

test("the routes that used to take a password are gone", async () => {
  // psm has one way in now; these must not quietly still work.
  for (const path of ["/api/auth/login", "/api/auth/register"]) {
    const { res } = await run({ ...request(), path });
    assert.equal(res.statusCode, 401, `${path} should no longer be a public entry point`);
  }
});

test("the login screen itself is served without a session", async () => {
  const { res } = await run({ ...request(), path: "/index.html" });
  assert.equal(res.statusCode, 200, "static assets are public; the API behind them is not");
});

test("no token means no access", async () => {
  const { res } = await run(request());
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "unauthenticated");
});

test("a valid bearer token identifies the user", async () => {
  const token = hs256({ sub: "user-42", email: "a@b.c", exp: future() });
  const { res, user } = await run(request({ authorization: `Bearer ${token}` }));
  assert.equal(res.statusCode, 200);
  assert.equal(user.id, "user-42");
  assert.equal(user.email, "a@b.c");
});

test("the session cookie works too, since the parent domain issues it", async () => {
  const token = hs256({ sub: "cookie-user", exp: future() });
  const { user } = await run(request({ cookie: `other=1; werewolf_session=${token}; more=2` }));
  assert.equal(user.id, "cookie-user");
});

test("a token signed with the wrong key is rejected", async () => {
  const token = hs256({ sub: "u1", exp: future() }, "not-the-secret");
  const { res } = await run(request({ authorization: `Bearer ${token}` }));
  assert.equal(res.statusCode, 401);
});

test("an expired session is rejected", async () => {
  const token = hs256({ sub: "u1", exp: Math.floor(Date.now() / 1000) - 60 });
  const { res } = await run(request({ authorization: `Bearer ${token}` }));
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /expired/);
});

test("issuer and audience are enforced when configured", async () => {
  process.env.PSM_AUTH_ISSUER = "https://werewolf.solutions";
  process.env.PSM_AUTH_AUDIENCE = "psm";

  const wrongIssuer = hs256({ sub: "u1", exp: future(), iss: "https://evil.com", aud: "psm" });
  assert.equal((await run(request({ authorization: `Bearer ${wrongIssuer}` }))).res.statusCode, 401);

  const wrongAudience = hs256({ sub: "u1", exp: future(), iss: "https://werewolf.solutions", aud: "other" });
  assert.equal((await run(request({ authorization: `Bearer ${wrongAudience}` }))).res.statusCode, 401);

  const good = hs256({ sub: "u1", exp: future(), iss: "https://werewolf.solutions", aud: "psm" });
  assert.equal((await run(request({ authorization: `Bearer ${good}` }))).res.statusCode, 200);
});

test("a token with no subject cannot own anything", async () => {
  const token = hs256({ email: "a@b.c", exp: future() });
  const { res } = await run(request({ authorization: `Bearer ${token}` }));
  assert.equal(res.statusCode, 401);
});

test("a garbled token is rejected rather than throwing", async () => {
  for (const token of ["", "abc", "a.b", "a.b.c.d", "not.a.jwt"]) {
    const { res } = await run(request({ authorization: `Bearer ${token}` }));
    assert.equal(res.statusCode, 401, token);
  }
});

test("without a session the owner is the single local user", () => {
  assert.equal(currentUserId(request()), "local");
  assert.equal(currentUserId({ ...request(), user: { id: "u9" } } as any), "u9");
});
