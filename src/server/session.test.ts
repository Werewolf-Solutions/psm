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
 *
 * It also enforces dapp's **origin pin** for a web client. Because those cookie
 * endpoints hand back a bearer token, dapp requires the caller's `Origin` to be
 * one of the application row's registered redirect origins
 * (appSessionCookie.isOriginAllowed) — and an absent Origin is not one of them.
 * A browser sets that header itself; psm is a server and has to send it, derived
 * from the callback the sign-in actually used. The stand-in refuses exactly as
 * dapp does, so a psm that sends no Origin fails these tests rather than only
 * failing against the real thing.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

/**
 * The `psm` row's redirect origins, as bootstrap-psm.js registers them. dapp
 * derives its accepted Origins from exactly this list.
 */
const REGISTERED_ORIGINS = [
  "https://psm.werewolf.solutions",
  "http://localhost:8080",
  "http://localhost:4317",
  "http://127.0.0.1:4317",
];

/** The callback this psm issues, and the origin psm therefore presents. */
const CALLBACK = "http://localhost:4317/auth/callback";
const ORIGIN = "http://localhost:4317";

const calls: Array<{ path: string; body: any; auth?: string; cookie?: string; origin?: string }> = [];
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
      origin: req.headers.origin as string,
    });
    const send = (status: number, payload: unknown, setCookie?: string) => {
      res.writeHead(status, {
        "content-type": "application/json",
        ...(setCookie ? { "set-cookie": setCookie } : {}),
      });
      res.end(JSON.stringify(payload));
    };
    /* dapp's rule, transcribed: for a web client the Origin must be the origin
     * of one of the row's registered redirect URIs, and "" is not one. */
    const originAllowed = () => {
      if (!webMode) return true; // only web clients are pinned
      const origin = String(req.headers.origin || "");
      return REGISTERED_ORIGINS.includes(origin);
    };

    // A web client's refresh token is never in the JSON — it is in the cookie.
    const mintCookie = () => {
      issuedCookie = `ws_app_rt_psm=refresh-r${refreshCount}`;
      return `${issuedCookie}; Path=/api/v1/apps/psm/auth; HttpOnly; SameSite=Lax`;
    };

    if (req.url === "/apps/psm/auth/exchange") {
      const body = raw ? JSON.parse(raw) : {};
      // dapp collapses an origin failure into the same generic 401 as a bad
      // code — no oracles — so psm sees only "sign-in failed".
      if (!originAllowed()) {
        return send(401, { success: false, message: "Invalid or expired authorization code" });
      }
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
      // Refresh is the one route where dapp says why: 403, not 401.
      if (!originAllowed()) {
        return send(403, { success: false, message: "Application origin is not allowed" });
      }
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
    ORIGIN,
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
    ORIGIN,
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

/* ---- the Origin dapp pins a web client to ---- */

test("the exchange presents the callback's origin, which is what dapp accepts", async () => {
  webMode = true;
  const { user } = await exchangeCode({
    code: "good-code",
    codeVerifier: "verifier",
    redirectUri: CALLBACK,
    device: { id: "device-1", name: "psm", platform: "test" },
  });
  assert.equal(user.id, "user-1");

  const exchange = calls.at(-1)!;
  assert.equal(exchange.origin, ORIGIN, "no Origin at all is what dapp refused");
  assert.ok(
    REGISTERED_ORIGINS.includes(exchange.origin!),
    "and it has to be a registered one, not any string psm felt like sending",
  );
});

test("the origin is retained on the session and presented again on refresh", async () => {
  webMode = true;
  await exchangeCode({
    code: "good-code",
    codeVerifier: "verifier",
    redirectUri: CALLBACK,
    device: { id: "device-1", name: "psm", platform: "test" },
  });
  const opened = calls.at(-1)!;
  calls.length = 0;

  // Age the real session out — this is an actual refresh against the stand-in,
  // not a hand-built record, so the retained origin is what is under test.
  openSession(
    { user: { id: "user-1" }, tokens: { accessToken: "access-x1", expiresIn: -10 } },
    API,
    issuedCookie,
    opened.origin!,
  );
  assert.equal((await sessionContext()).accessToken, "access-r2", "refresh must actually succeed");

  const refresh = calls.at(-1)!;
  assert.equal(refresh.path, "/apps/psm/auth/refresh");
  assert.equal(refresh.origin, ORIGIN, "the same origin the session was opened with");
});

test("a session carrying no origin cannot refresh — dapp answers 403", async () => {
  webMode = true;
  // The pre-fix shape: a session opened without an origin to remember. dapp
  // refuses it, and psm reports signed-out rather than looping.
  openSession(
    { user: { id: "user-1" }, tokens: { accessToken: "access-x1", expiresIn: -10 } },
    API,
    "ws_app_rt_psm=refresh-r1",
  );
  assert.equal(await currentUser(), null);
  assert.equal(calls.at(-1)?.origin, undefined, "it had none to send");
});

test("signing out presents the same origin as the rest of the session", async () => {
  webMode = true;
  await exchangeCode({
    code: "good-code",
    codeVerifier: "verifier",
    redirectUri: CALLBACK,
    device: { id: "device-1", name: "psm", platform: "test" },
  });
  await signOut();
  const logout = calls.at(-1)!;
  assert.equal(logout.path, "/apps/psm/auth/logout");
  assert.equal(logout.origin, ORIGIN);
});

test("the legacy body transport carries an Origin too", async () => {
  // dapp builds without the cookie do not pin the origin, but psm sends the
  // same header either way — one code path, and it is already correct when that
  // build gains the cookie transport.
  webMode = false;
  await exchangeCode({
    code: "good-code",
    codeVerifier: "verifier",
    redirectUri: "https://psm.werewolf.solutions/auth/callback",
    device: { id: "device-1", name: "psm", platform: "test" },
  });
  assert.equal(calls.at(-1)?.origin, "https://psm.werewolf.solutions");

  // and the hosted origin refreshes under that same origin. The exchange above
  // already spent counter 1, so the rotated token here is r2.
  openSession(authResult(-10), API, null, "https://psm.werewolf.solutions");
  assert.equal((await sessionContext()).accessToken, "access-r2");
  assert.equal(calls.at(-1)?.origin, "https://psm.werewolf.solutions");
});

test("a callback that is not a usable http(s) URL never reaches dapp", async () => {
  const device = { id: "device-1", name: "psm", platform: "test" };
  for (const redirectUri of [
    "javascript:alert(1)//auth/callback",
    "not-a-url",
    "",
    "file:///auth/callback",
  ]) {
    await assert.rejects(
      () => exchangeCode({ code: "good-code", codeVerifier: "v", redirectUri, device }),
      /not a usable callback URL|is an http\(s\) URL/,
      `${redirectUri || "(empty)"} should be refused locally`,
    );
  }
  assert.equal(calls.length, 0, "psm must not ask dapp to vouch for a callback it made up");
  assert.equal(await currentUser(), null);
});
