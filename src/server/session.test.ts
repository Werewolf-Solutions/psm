/**
 * The local cockpit's single Werewolf session, against a stand-in for dapp.
 *
 * Sessions are created by the SSO code exchange — sso.test.ts covers that half.
 * What is pinned here is everything after: refresh rotates the token dapp gave
 * us, a refresh dapp rejects ends the session rather than looping, and sign-out
 * revokes at dapp without leaving the process believing it is still signed in.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

const calls: Array<{ path: string; body: any; auth?: string }> = [];
let refreshCount = 0;
let failNextRefresh = false;

const dapp = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    calls.push({
      path: req.url || "",
      body: raw ? JSON.parse(raw) : null,
      auth: req.headers.authorization as string,
    });
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
    send(404, { success: false, message: "no such route" });
  });
});

await new Promise<void>((resolve) => dapp.listen(0, "127.0.0.1", () => resolve()));
const API = `http://127.0.0.1:${(dapp.address() as any).port}`;
process.env.WEREWOLF_API_URL = API;

const { currentUser, openSession, resetSessionForTesting, sessionContext, signOut } =
  await import("./session.ts");
const { currentAccessToken } = await import("../store.ts");

/** What dapp's exchange hands back, and what psm turns into its session. */
const authResult = (expiresIn = 900) => ({
  user: { id: "user-1", name: "Ada", email: "ada@example.com" },
  tokens: { accessToken: "access-1", refreshToken: "refresh-1", expiresIn },
});

test.beforeEach(() => {
  resetSessionForTesting();
  calls.length = 0;
  refreshCount = 0;
});

test.after(() => dapp.close());

test("opening a session identifies the user", async () => {
  const { user } = openSession(authResult(), API);
  assert.equal(user.id, "user-1");
  assert.equal((await currentUser())?.email, "ada@example.com");
});

test("a reply that carries no usable session is refused", () => {
  assert.throws(() => openSession({ user: { id: "u" } }, API), /did not return a session/);
  assert.throws(() => openSession({ tokens: { accessToken: "a", refreshToken: "b" } }, API), /did not identify/);
});

test("signed out is a valid answer, not an error", async () => {
  assert.equal(await currentUser(), null);
  assert.deepEqual(await sessionContext(), { accessToken: null });
});

test("the request context carries the token cloud calls borrow", async () => {
  openSession(authResult(), API);
  assert.equal((await sessionContext()).accessToken, "access-1");
});

test("an expired access token is refreshed, and the rotated one is kept", async () => {
  openSession(authResult(-10), API); // already past its life
  assert.equal((await sessionContext()).accessToken, "access-r1");

  // the next call reuses the fresh token rather than refreshing again
  assert.equal((await sessionContext()).accessToken, "access-r1");
  assert.equal(refreshCount, 1, "keeping the spent refresh token would sign the user out");
});

test("a refresh dapp rejects ends the session rather than looping", async () => {
  openSession(authResult(-10), API);
  failNextRefresh = true;
  try {
    assert.equal(await currentUser(), null, "revoked at dapp means signed out here");
    assert.deepEqual(await sessionContext(), { accessToken: null });
  } finally {
    failNextRefresh = false;
  }
});

test("signing out revokes at dapp and forgets locally even if dapp fails", async () => {
  openSession(authResult(), API);
  await signOut();
  assert.equal(calls.at(-1)?.path, "/apps/psm/auth/logout");
  assert.equal(calls.at(-1)?.auth, "Bearer access-1", "revocation is authenticated as that session");
  assert.equal(await currentUser(), null);

  // and with dapp unreachable, the local session still goes
  openSession(authResult(), API);
  process.env.WEREWOLF_API_URL = "http://127.0.0.1:1"; // nothing listening
  try {
    await signOut();
    assert.equal(await currentUser(), null, "a failure at dapp must not leave us 'signed in'");
  } finally {
    process.env.WEREWOLF_API_URL = API;
  }
});

test("withSession puts the token where cloud.ts reads it", async () => {
  const { withSession } = await import("./session.ts");
  openSession(authResult(), API);
  assert.equal(await withSession(() => currentAccessToken()), "access-1");

  resetSessionForTesting();
  assert.equal(await withSession(() => currentAccessToken()), null);
});
