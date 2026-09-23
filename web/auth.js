/**
 * "Sign in with Werewolf" — the whole flow, for every posture psm runs in.
 *
 * OAuth 2.0 authorization code + PKCE against werewolf-dapp, the same shape
 * todo-app uses (client/src/auth/session.ts): leave for the consent screen, come
 * back to /auth/callback with a 60-second single-use code, exchange it.
 *
 * ## One application
 *
 * `client_id` is `psm`, always. psm used to register twice — `psm` as a native
 * client for the local cockpit and `psm-web` for the hosted page — because dapp's
 * native redirect rule (any loopback port) and its web rule (exact https match)
 * cannot both come from one row. Two rows meant two registrations to keep alive,
 * two consent screens, and a sign-in that could work in one posture and not the
 * other. Now there is one `web` row and the ports are pinned instead, the way
 * todo-app pins 5200 — see docs/werewolf-psm-registration.md for the exact list.
 *
 * ## Two transports, because of one cookie
 *
 * dapp gives a `web` client its refresh credential as an httpOnly cookie and
 * omits it from the JSON (server/utils/appSessionCookie.js). That cookie is
 * SameSite=Lax and host-only on the API's host, so:
 *
 *   hosted   psm.werewolf.solutions → werewolf.solutions is same-*site*: the
 *            page exchanges and refreshes directly, and the cookie rides along.
 *            Identical to todo-app.
 *   cockpit  localhost:4317 → werewolf.solutions is cross-site, so the browser
 *            would neither store nor send it. The page posts the code to its own
 *            agent instead, which keeps the cookie (server/session.ts) and
 *            answers /api/auth/session.
 *
 * The PKCE half — verifier, state, redirect, callback — is the same code in both.
 * The access token, where this file holds one, lives in a module variable and
 * never in storage.
 */
(function () {
  /** Where dapp is. Replaced by the agent's own answer when it serves this page. */
  let API_BASE =
    localStorage.getItem("psm.dapp.api") || "https://werewolf.solutions/api/v1";
  let WEB_ORIGIN = localStorage.getItem("psm.dapp.web") || "https://werewolf.solutions";

  const APP_KEY = "psm";
  const CALLBACK_PATH = "/auth/callback";
  const AUTH_REQUEST_MS = 8_000;
  /** Must match a registered redirect URI exactly — web clients are exact-match. */
  const redirectUri = () => `${location.origin}${CALLBACK_PATH}`;

  /**
   * Is there a psm agent behind this page? Decided by app.js, which asks
   * /api/auth/session — a hostname guess gets it wrong for the static host on
   * localhost:8080, which is every bit as serverless as psm.werewolf.solutions.
   * Until it says otherwise, assume not: the direct flow is the safe default
   * because it never posts a code to something that is not psm.
   */
  let servedByAgent = false;

  const VERIFIER_KEY = "psm.pkce.verifier";
  const STATE_KEY = "psm.pkce.state";
  const RETURN_KEY = "psm.pkce.returnTo";
  const DEVICE_KEY = "psm.deviceId";
  /**
   * "There was a session last time." dapp's authLimiter allows only so many
   * *failed* attempts per window, and a signed-out visitor reloading the page
   * would otherwise fire a guaranteed-401 refresh every single time.
   */
  const SIGNED_IN_KEY = "psm.signedIn";
  /**
   * The display name from the last exchange. A *refresh* returns tokens but no
   * user, so without this the chip reads "Account" after every reload. Cached,
   * non-authoritative, and never used for anything but a label.
   */
  const WHO_KEY = "psm.who";

  /* In memory only, and deliberately not exposed. A reload drops it and
   * restore() fetches another. */
  let accessToken = null;

  /**
   * Point this page at a dapp. The agent knows things the page cannot work out:
   * which dapp it is talking to, and where a *local* dapp's consent screen is
   * (Vite's port moves when a previous dev server still holds 5173).
   */
  function configure(config) {
    if (!config) return;
    if (typeof config.servedByAgent === "boolean") servedByAgent = config.servedByAgent;
    // localStorage still wins: it is the override that points a hosted bundle at
    // a local dapp for testing, and it has no build step to go through.
    if (config.apiBase && !localStorage.getItem("psm.dapp.api")) API_BASE = config.apiBase;
    if (config.webOrigin && !localStorage.getItem("psm.dapp.web")) WEB_ORIGIN = config.webOrigin;
  }

  /* ---- PKCE (RFC 7636), S256 only — dapp rejects anything else ---- */

  const base64url = (bytes) => {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = "";
    for (const byte of view) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const randomBase64url = (n) => base64url(crypto.getRandomValues(new Uint8Array(n)));
  const createVerifier = () => randomBase64url(32); // 43 chars, inside the RFC's 43–128
  const createState = () => randomBase64url(16);
  const challengeFor = async (verifier) =>
    base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

  /**
   * A "device" to dapp is a browser profile here. It has to be stable, or every
   * reload would open a new session and burn through the app's device allowance.
   */
  const deviceId = () => {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  };

  const authUrl = (action) => `${API_BASE}/apps/${APP_KEY}/auth/${action}`;

  /**
   * Authentication is part of page startup, so a browser/network policy that
   * silently drops the request must not leave the whole cockpit loading forever.
   */
  async function timedFetch(url, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUTH_REQUEST_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Every direct auth call needs the cookie, which is cross-origin in production. */
  const post = (url, body, headers) =>
    timedFetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(headers || {}) },
      body: JSON.stringify(body ?? {}),
    });

  /** The same call, but to psm's own agent, which holds the cookie for us. */
  const postToAgent = (path, body) =>
    timedFetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });

  /**
   * Is `psm` registered with this dapp, as a web client, with this page's
   * callback? Asked before the redirect, because an unregistered or misregistered
   * client_id sends the user to a consent screen that cannot explain itself —
   * production has answered `app_not_configured` for every application row, and
   * from here that looked simply like a broken button.
   */
  async function checkRegistered() {
    let res;
    try {
      res = await timedFetch(
        `${API_BASE}/apps/${APP_KEY}/public?redirectUri=${encodeURIComponent(redirectUri())}`,
        { headers: { Accept: "application/json" } },
      );
    } catch (err) {
      throw new Error(`Could not reach Werewolf at ${API_BASE} (${err.message}).`);
    }
    const body = await res.json().catch(() => null);
    // 404 and 503 both mean "no such application row" — dapp's controller maps
    // app_not_configured to 404 here and 503 on the exchange route.
    if (res.status === 404 || res.status === 503) {
      throw new Error(
        `psm is not registered with Werewolf at ${API_BASE}, so signing in cannot work. ` +
          "It needs one CloudApplication row with key `psm` and clientType `web`.",
      );
    }
    if (!res.ok || !body?.success) {
      throw new Error(body?.message || `Werewolf answered ${res.status} when asked about psm.`);
    }
    if (body.data?.clientType && body.data.clientType !== "web") {
      throw new Error(
        `Werewolf has psm registered as a ${body.data.clientType} client, and this build signs in ` +
          "as a web client. The row needs clientType `web`.",
      );
    }
    if (!body.data?.redirectAllowed) {
      throw new Error(
        `Werewolf will not accept this page's callback (${redirectUri()}). ` +
          "A web client is exact-matched, so that URI has to be listed in the row's redirectUris.",
      );
    }
  }

  /** Step 1 — leave for the consent screen. Does not return. */
  async function beginSignIn() {
    if (!window.isSecureContext) {
      throw new Error(
        "Signing in needs a secure context (https, or localhost). crypto.subtle is unavailable here.",
      );
    }
    await checkRegistered();
    const verifier = createVerifier();
    const state = createState();
    // sessionStorage, not localStorage: this is one tab's in-flight login, and it
    // should not outlive the tab or leak into another one.
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, state);
    sessionStorage.setItem(RETURN_KEY, location.hash || "");

    const params = new URLSearchParams({
      client_id: APP_KEY,
      redirect_uri: redirectUri(),
      state,
      code_challenge: await challengeFor(verifier),
      code_challenge_method: "S256",
    });
    location.href = `${WEB_ORIGIN}/authorize?${params}`;
  }

  /**
   * Step 3 — redeem the code in the URL. Call this only on the callback path.
   *
   * Runs at most once per page load, and every caller joins the same attempt:
   * redeeming is doubly single-use — it consumes the stored verifier here, and
   * dapp burns the code's jti server-side — so a second run cannot succeed.
   */
  let inFlightCompletion = null;
  function completeSignIn(search) {
    if (!inFlightCompletion) inFlightCompletion = redeem(search);
    return inFlightCompletion;
  }

  function clearPending() {
    sessionStorage.removeItem(VERIFIER_KEY);
    sessionStorage.removeItem(STATE_KEY);
  }

  async function redeem(search) {
    const params = new URLSearchParams(search);
    const error = params.get("error");
    if (error) {
      clearPending();
      throw new Error(error === "access_denied" ? "Sign-in was declined." : error);
    }

    const code = params.get("code");
    const state = params.get("state");
    const verifier = sessionStorage.getItem(VERIFIER_KEY);
    const expectedState = sessionStorage.getItem(STATE_KEY);
    clearPending();

    if (!code || !verifier) throw new Error("This sign-in did not start here. Try again.");
    // The code is bound to the verifier anyway; this catches a callback replayed
    // into a tab that started a different login.
    if (!state || state !== expectedState) throw new Error("Sign-in state did not match. Try again.");

    const payload = {
      code,
      codeVerifier: verifier,
      redirectUri: redirectUri(),
      device: { id: deviceId(), name: "Browser", platform: navigator.platform || "web" },
    };

    // Through the agent when it serves this page: it can keep the refresh cookie
    // that a cross-site browser would drop on the floor.
    if (servedByAgent) {
      const res = await postToAgent("/api/auth/exchange", payload);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "Could not complete sign-in.");
      rememberWho(body.user);
      return body.user;
    }

    const res = await post(authUrl("exchange"), payload);
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) throw new Error(body?.message || "Could not complete sign-in.");
    accessToken = body.data.tokens.accessToken;
    keepBodyRefreshToken(body.data.tokens.refreshToken);
    rememberWho(body.data.user);
    return body.data.user;
  }

  /**
   * A dapp without the cookie transport hands a web client its refresh token in
   * the response body (dev/master today; only feat/todo-app sets the cookie).
   *
   * It is held in a module variable and **never** written to storage: a refresh
   * token in localStorage is readable by any injected script, which is the exact
   * thing `clientType: 'web'` exists to prevent. The cost is that a reload has
   * nothing to restore from and asks for a fresh sign-in — a real limitation,
   * and the right side to err on. It goes away when dapp gains the cookie.
   */
  let bodyRefreshToken = null;
  function keepBodyRefreshToken(token) {
    bodyRefreshToken = typeof token === "string" && token ? token : null;
  }

  function rememberWho(user) {
    localStorage.setItem(SIGNED_IN_KEY, "1");
    try {
      localStorage.setItem(WHO_KEY, JSON.stringify(user));
    } catch {}
  }

  /**
   * Swap the httpOnly cookie for a fresh access token. False when there is no
   * usable session — a first visit, a revoked session, an expired cookie.
   *
   * Single-flight: dapp rotates the refresh token on every use, so two refreshes
   * racing with the same cookie means the second presents a token the first just
   * spent, and gets a 401.
   */
  let inFlightRefresh = null;
  function refresh() {
    if (!inFlightRefresh) {
      inFlightRefresh = runRefresh().finally(() => {
        inFlightRefresh = null;
      });
    }
    return inFlightRefresh;
  }

  async function runRefresh() {
    // The agent's session is the agent's business; app.js asks it directly.
    if (servedByAgent) return false;
    // The cookie rides along on its own when dapp set one. The body covers the
    // build that did not — and a dapp with the cookie transport ignores the body
    // for a web client, so sending both is safe either way.
    const res = await post(authUrl("refresh"), bodyRefreshToken ? { refreshToken: bodyRefreshToken } : {});
    const body = res.ok ? await res.json().catch(() => null) : null;
    if (!body?.success) {
      accessToken = null;
      bodyRefreshToken = null;
      localStorage.removeItem(SIGNED_IN_KEY);
      localStorage.removeItem(WHO_KEY);
      return false;
    }
    accessToken = body.data.tokens.accessToken;
    // Rotated on every use: keeping the spent one would fail the next refresh.
    keepBodyRefreshToken(body.data.tokens.refreshToken);
    localStorage.setItem(SIGNED_IN_KEY, "1");
    return true;
  }

  /**
   * On startup: are we still signed in from last time? Skipped entirely when
   * there is no marker, so a signed-out visitor never spends a rate-limited
   * failed attempt just by loading the page.
   */
  async function restore() {
    if (servedByAgent) return false; // /api/auth/session is the answer there
    if (!localStorage.getItem(SIGNED_IN_KEY)) return false;
    return refresh();
  }

  async function signOut() {
    if (servedByAgent) {
      await postToAgent("/api/auth/logout", {}).catch(() => undefined);
    } else if (accessToken) {
      // Revokes server-side and clears the cookie. Best effort — a failure here
      // must not leave the page thinking it is still signed in.
      await timedFetch(authUrl("logout"), {
        method: "POST",
        credentials: "include",
        headers: { Authorization: `Bearer ${accessToken}` },
      }).catch(() => undefined);
    }
    accessToken = null;
    bodyRefreshToken = null;
    localStorage.removeItem(SIGNED_IN_KEY);
    localStorage.removeItem(WHO_KEY);
  }

  /**
   * `fetch` for dapp's API: attaches the access token and, on a 401, refreshes
   * once and retries. A second 401 means the session is genuinely gone.
   *
   * Note this is for **dapp**, not the agent — the agent is a different origin
   * with a different credential entirely (see web/agent.js).
   */
  async function authFetch(path, init = {}) {
    const call = () =>
      fetch(`${API_BASE}${path}`, {
        ...init,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(init.headers || {}),
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
      });
    const first = await call();
    if (first.status !== 401) return first;
    if (!(await refresh())) return first;
    return call();
  }

  window.PsmAuth = {
    configure,
    get servedByAgent() { return servedByAgent; },
    get apiBase() { return API_BASE; },
    get webOrigin() { return WEB_ORIGIN; },
    appKey: APP_KEY,
    callbackPath: CALLBACK_PATH,
    redirectUri,
    isCallback: () => location.pathname === CALLBACK_PATH,
    returnTo: () => sessionStorage.getItem(RETURN_KEY) || "",
    beginSignIn,
    completeSignIn,
    restore,
    refresh,
    signOut,
    authFetch,
    getAccessToken: () => accessToken,
    /** Who the last exchange said we are — a label, not a claim. */
    cachedUser: () => {
      try { return JSON.parse(localStorage.getItem(WHO_KEY) || "null"); } catch { return null; }
    },
  };
})();
