/**
 * psm's session, against a stand-in for werewolf-dapp.
 *
 * Sessions are created by the SSO code exchange — sso.test.ts covers that half.
 * What is pinned here is everything after: the cookie carries no token, refresh
 * rotates, a revoked session dies rather than looping, and sign-out revokes at
 * dapp.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { setModeForTesting } from "../mode.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "psm-session-"));
process.env.PSM_SESSION_SECRET = "test-session-secret";
process.env.PSM_DATA_DIR = sandbox;

interface Call {
  path: string;
  body: any;
  auth?: string;
}

const calls: Call[] = [];
let refreshCount = 0;
let failNextRefresh = false;

const dapp = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: req.url || "", body, auth: req.headers.authorization as string });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.url === "/apps/psm/auth/refresh") {
      if (failNextRefresh) return send(401, { success: false, message: "Refresh token is invalid" });
      refreshCount += 1;
      // dapp rotates the refresh token on every use — psm must store the new one
      return send(200, {
        success: true,
        data: {
          tokens: {
            accessToken: `access-r${refreshCount}`,
            refreshToken: `refresh-r${refreshCount}`,
            expiresIn: 900,
          },
        },
      });
    }
    if (req.url === "/apps/psm/auth/logout") return send(200, { success: true });
    if (req.url === "/apps/psm/me") {
      if (req.headers.authorization !== "Bearer good-token") {
        return send(401, { success: false, message: "Not authorised" });
      }
      return send(200, {
        success: true,
        data: { user: { id: "user-9", name: "Introspected", email: "i@example.com" } },
      });
    }
    send(404, { success: false, message: "no such route" });
  });
});

await new Promise<void>((resolve) => dapp.listen(0, "127.0.0.1", () => resolve()));
const dappPort = (dapp.address() as any).port;
const API = `http://127.0.0.1:${dappPort}`;
process.env.WEREWOLF_API_URL = API;

const {
  SESSION_COOKIE,
  accessTokenFor,
  openSession,
  sessionContext,
  sessionFromRequest,
  signOut,
  userForAccessToken,
} = await import("./session.ts");

const req = (cookie?: string) =>
  ({ headers: { "user-agent": "test", ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}) } }) as any;

/** What dapp's exchange hands back, and what psm turns into a session. */
const authResult = () => ({
  user: { id: "user-1", name: "Ada", email: "ada@example.com" },
  tokens: { accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 900 },
});

const recordFile = (cookie: string) => path.join(sandbox, "sessions", `${cookie.split(".")[0]}.json`);

/** Age a session's access token past its life, the way 15 minutes would. */
function expireAccessToken(cookie: string): string {
  const file = recordFile(cookie);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.accessExpiresAt = Date.now() - 1000;
  fs.writeFileSync(file, JSON.stringify(record));
  return file;
}

test.before(() => setModeForTesting("hosted"));

test.after(() => {
  setModeForTesting(undefined);
  dapp.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("opening a session yields a cookie and the user", () => {
  const { user, cookie } = openSession(authResult(), API);
  assert.equal(user.id, "user-1");
  assert.equal(user.email, "ada@example.com");
  assert.ok(cookie.includes("."), "the cookie is an id and a signature");
});

test("the cookie carries no token — only an opaque id", () => {
  const { cookie } = openSession(authResult(), API);
  assert.ok(!cookie.includes("access-1"), "an access token in the cookie would defeat httpOnly");
  assert.ok(!cookie.includes("refresh-1"), "the refresh token must never reach the browser");
});

test("a reply that carries no usable session is refused", () => {
  assert.throws(() => openSession({ user: { id: "u" } }, API), /did not return a session/);
  assert.throws(() => openSession({ tokens: { accessToken: "a", refreshToken: "b" } }, API), /did not identify/);
});

test("a signed cookie resolves back to its user", async () => {
  const { cookie } = openSession(authResult(), API);
  assert.equal((await sessionFromRequest(req(cookie)))?.id, "user-1");
});

test("a tampered or forged cookie resolves to nobody", async () => {
  const { cookie } = openSession(authResult(), API);
  const [id, signature] = cookie.split(".");
  for (const bad of [`${id}x.${signature}`, `${id}.${signature}x`, id, "nonsense", `made-up.${signature}`]) {
    assert.equal(await sessionFromRequest(req(bad)), null, bad);
  }
});

test("no cookie is a valid answer, not an error", async () => {
  assert.equal(await sessionFromRequest(req()), null);
  assert.deepEqual(await sessionContext(req()), { userId: null, accessToken: null });
});

test("the request context carries both the owner and the token", async () => {
  const { cookie } = openSession(authResult(), API);
  const context = await sessionContext(req(cookie));
  assert.equal(context.userId, "user-1");
  assert.equal(context.accessToken, "access-1", "cloud calls borrow this rather than signing in again");
});

test("an expired access token is refreshed, and the rotated one is kept", async () => {
  refreshCount = 0;
  const { cookie } = openSession(authResult(), API);
  const file = expireAccessToken(cookie);

  assert.equal(await accessTokenFor(req(cookie)), "access-r1");
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.refreshToken, "refresh-r1", "keeping the spent token would log the user out next call");
});

test("the context refreshes too, so a stale token never reaches a cloud call", async () => {
  const { cookie } = openSession(authResult(), API);
  expireAccessToken(cookie);
  const context = await sessionContext(req(cookie));
  assert.ok(context.accessToken?.startsWith("access-r"), `got ${context.accessToken}`);
  assert.equal(context.userId, "user-1");
});

test("a refresh dapp rejects ends the session rather than looping", async () => {
  const { cookie } = openSession(authResult(), API);
  const file = expireAccessToken(cookie);

  failNextRefresh = true;
  try {
    assert.equal(await sessionFromRequest(req(cookie)), null, "revoked at dapp means signed out here");
    assert.equal(fs.existsSync(file), false, "and the dead session is not left on disk");
  } finally {
    failNextRefresh = false;
  }
});

test("signing out revokes at dapp and drops the local record", async () => {
  const { cookie } = openSession(authResult(), API);
  calls.length = 0;
  await signOut(req(cookie));

  assert.equal(calls.at(-1)?.path, "/apps/psm/auth/logout");
  assert.equal(calls.at(-1)?.auth, "Bearer access-1", "revocation is authenticated as that session");
  assert.equal(await sessionFromRequest(req(cookie)), null);
});

test("a bearer access token is identified by asking dapp", async () => {
  assert.equal((await userForAccessToken("good-token"))?.id, "user-9");
  assert.equal(await userForAccessToken("stale-token"), null);
});
