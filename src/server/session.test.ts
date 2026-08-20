/**
 * The local cockpit's single Werewolf session, against a stand-in for dapp.
 *
 * Two things are pinned here. The session lifecycle: refresh rotates the
 * credential dapp gave us, a refresh dapp rejects ends the session rather than
 * looping, and sign-out revokes at dapp without leaving the process believing it
 * is still signed in.
 *
 * And the **web-client cookie transport**, which is why the cockpit's exchange
 * happens on the server at all. psm is one application row with
 * `clientType: 'web'`, so dapp returns no refresh token in the body — it sets an
 * httpOnly `ws_app_rt_psm` cookie. The stand-in below enforces that exactly as
 * werewolf-dapp does: the cookie is the *only* accepted source on refresh
 * (appSsoController.refreshAppSession), and it rotates on every use.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

const calls: Array<{ path: string; body: any; auth?: string; cookie?: string }> = [];
let refreshCount = 0;
let failNextRefresh = false;
/** Play dapp's `web` client type: cookie in, cookie out, nothing in the body. */
let webMode = false;
let issuedCookie = "";

const dapp = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    calls.push({
      path: req.url || "",
      body: raw ? JSON.parse(raw) : null,
      auth: req.headers.authorization as string,
      cookie: req.headers.cookie as string,
    });
    const send = (status: number, payload: unknown, setCookie?: string) => {
      res.writeHead(status, {
        "content-type": "application/json",
        ...(setCookie ? { "set-cookie": setCookie } : {}),
      });
      res.end(JSON.stringify(payload));
    };
    // A web client's refresh token is never in the JSON — it is in the cookie.
    const mintCookie = () => {
      issuedCookie = `ws_app_rt_psm=refresh-r${refreshCount}`;
      return `${issuedCookie}; Path=/api/v1/apps/psm/auth; HttpOnly; SameSite=Lax`;
    };

    if (req.url === "/apps/psm/auth/exchange") {
      const body = raw ? JSON.parse(raw) : {};
      if (body.code !== "good-code") {
        return send(401, { success: false, message: "Invalid or expired authorization code" });
      }
      refreshCount += 1;
      return send(
        200,
        {
          success: true,
          data: {
            user: { id: "user-1", name: "Ada", email: "ada@example.com" },
            tokens: { accessToken: "access-x1", expiresIn: 900 },
          },
        },
        mintCookie(),
      );
    }

    if (req.url === "/apps/psm/auth/refresh") {
      if (failNextRefresh) return send(401, { success: false, message: "Refresh token is invalid" });
      if (webMode) {
        // Exactly dapp's rule: for a web client the cookie is the only source,
        // and a body-borne token is ignored rather than trusted.
        if ((req.headers.cookie || "") !== issuedCookie) {
          return send(401, { success: false, message: "Refresh token is invalid or expired" });
        }
        refreshCount += 1;
        return send(
          200,
          { success: true, data: { tokens: { accessToken: `access-r${refreshCount}`, expiresIn: 900 } } },
          mintCookie(),
        );
      }
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

const {
  currentUser,
  exchangeCode,
  openSession,
  resetSessionForTesting,
  sessionContext,
  signOut,
} = await import("./session.ts");
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
  webMode = false;
  issuedCookie = "";
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

/* ---- the web-client cookie transport ---- */

test("the code exchange opens a session from a cookie, with no token in the body", async () => {
  webMode = true;
  const { user } = await exchangeCode({
    code: "good-code",
    codeVerifier: "verifier",
    redirectUri: "http://localhost:4317/auth/callback",
    device: { id: "device-1", name: "psm", platform: "test" },
  });
  assert.equal(user.id, "user-1");

  const exchange = calls.at(-1)!;
  assert.equal(exchange.path, "/apps/psm/auth/exchange");
  assert.equal(exchange.body.codeVerifier, "verifier");
  assert.equal(exchange.body.redirectUri, "http://localhost:4317/auth/callback");
  // dapp exact-matches the callback against the code it minted, so psm must
  // forward the page's own URI rather than inventing one.
  assert.equal((await sessionContext()).accessToken, "access-x1");
});

test("a rejected code never opens a session", async () => {
  webMode = true;
  await assert.rejects(
    () => exchangeCode({
      code: "replayed",
      codeVerifier: "verifier",
      redirectUri: "http://localhost:4317/auth/callback",
      device: { id: "device-1", name: "psm", platform: "test" },
    }),
    /Invalid or expired authorization code/,
  );
  assert.equal(await currentUser(), null);
});

test("the exchange refuses to start without a code and a verifier", async () => {
  const device = { id: "device-1", name: "psm", platform: "test" };
  const uri = "http://localhost:4317/auth/callback";
  await assert.rejects(
    () => exchangeCode({ code: "", codeVerifier: "v", redirectUri: uri, device }),
    /missing its code/,
  );
  await assert.rejects(
    () => exchangeCode({ code: "c", codeVerifier: "", redirectUri: uri, device }),
    /missing its code/,
  );
  assert.equal(calls.length, 0, "neither should have reached dapp");
});

test("refresh presents the cookie, and keeps the rotated one", async () => {
  webMode = true;
  await exchangeCode({
    code: "good-code",
    codeVerifier: "verifier",
    redirectUri: "http://localhost:4317/auth/callback",
    device: { id: "device-1", name: "psm", platform: "test" },
  });
  const first = issuedCookie;

  // Age the access token out so the next call has to refresh.
  openSession(
    { user: { id: "user-1" }, tokens: { accessToken: "access-x1", expiresIn: -10 } },
    API,
    first,
  );
  assert.equal((await sessionContext()).accessToken, "access-r2");

  const refresh = calls.at(-1)!;
  assert.equal(refresh.path, "/apps/psm/auth/refresh");
  assert.equal(refresh.cookie, first, "the cookie is what a cookie-transport dapp reads");
  // Also in the body, for the dapp builds that have no cookie transport at all.
  // A dapp that does have one ignores the body for a web client, so this costs
  // nothing and saves psm from having to know which build it is talking to.
  assert.equal(refresh.body.refreshToken, first.split("=")[1]);
  assert.notEqual(issuedCookie, first, "dapp rotated it");

  // And the rotated cookie is what the next refresh presents — keeping the spent
  // one would sign the user out on the very next call.
  openSession(
    { user: { id: "user-1" }, tokens: { accessToken: "access-r2", expiresIn: -10 } },
    API,
    issuedCookie,
  );
  assert.equal((await sessionContext()).accessToken, "access-r3");
});

test("a session with no cookie cannot refresh, and reads as signed out", async () => {
  webMode = true;
  // What a native-shaped reply would leave behind: no cookie, no token.
  openSession({ user: { id: "user-1" }, tokens: { accessToken: "a", expiresIn: -10 } }, API, null);
  assert.equal(await currentUser(), null);
  assert.equal(calls.length, 0, "there is nothing to present, so nothing is asked");
});

test("signing out presents the cookie, which is what revokes the session", async () => {
  webMode = true;
  await exchangeCode({
    code: "good-code",
    codeVerifier: "verifier",
    redirectUri: "http://localhost:4317/auth/callback",
    device: { id: "device-1", name: "psm", platform: "test" },
  });
  await signOut();
  const logout = calls.at(-1)!;
  assert.equal(logout.path, "/apps/psm/auth/logout");
  assert.equal(logout.cookie, issuedCookie);
  assert.equal(logout.auth, "Bearer access-x1");
  assert.equal(await currentUser(), null);
});

test("a dapp with no cookie transport still refreshes, from the body", async () => {
  // dev/master of werewolf-dapp return the refresh token in the JSON body and
  // read it back from `req.body.refreshToken`; only feat/todo-app has the
  // httpOnly cookie. psm has to work against whichever is deployed.
  webMode = false;
  openSession(authResult(-10), API); // body-style reply, no Set-Cookie
  assert.equal((await sessionContext()).accessToken, "access-r1");

  const refresh = calls.at(-1)!;
  assert.equal(refresh.path, "/apps/psm/auth/refresh");
  assert.equal(refresh.body.refreshToken, "refresh-1", "the body is the only source there");
  assert.equal(refresh.cookie, "ws_app_rt_psm=refresh-1", "and the cookie header costs nothing");

  // The rotated token from the body is kept, so the next refresh is not a replay.
  openSession(authResult(-10), API);
  assert.equal((await sessionContext()).accessToken, "access-r2");
});
