/**
 * "Sign in with Werewolf" for the **hosted page**.
 *
 * A direct port of todo-app's client/src/auth/{config,pkce,session}.ts to vanilla
 * JS, because psm's web/ has no build step. The flow is OAuth 2.0 authorization
 * code + PKCE against werewolf-dapp: leave for the consent screen, come back with
 * a 60-second single-use code, exchange it for a session.
 *
 * **The refresh token never arrives here.** psm's hosted page is registered as
 * `psm-web` with `clientType: 'web'`, and for web clients dapp puts the refresh
 * token in an httpOnly cookie and omits it from the JSON — see
 * werewolf-dapp/server/utils/appSessionCookie.js. That is the whole reason for a
 * second application row: the `psm` row is `native` and would hand a browser its
 * refresh token in the response body. The access token here lives in a module
 * variable and never touches localStorage.
 *
 * A reload therefore has no token but still has the cookie, so `restore()` calls
 * refresh on startup and gets a session back without another round trip through
 * the consent screen.
 *
 * **This file is for the hosted page only.** Served from the agent at
 * 127.0.0.1, psm keeps its server-side loopback flow (src/server/sso.ts), where
 * the verifier never reaches the browser at all. `PsmAuth.hosted` is the switch.
 */
(function () {
  const HOSTED = !["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);

  /**
   * Where dapp is, from this page's point of view. Two different origins, and
   * they are not the same thing: the API answers on werewolf.solutions, while the
   * *consent screen* is a page in dapp's web client. Overridable from
   * localStorage so the hosted bundle can be pointed at a local dapp for testing
   * without a build step.
   */
  // Note the local default is `localhost`, not `127.0.0.1`. The refresh cookie is
  // SameSite=Lax, and Lax is about *site*: psm.werewolf.solutions → werewolf.solutions
  // is same-site so the cookie rides along, but localhost:8080 → 127.0.0.1:3000 is
  // cross-site and it would be dropped, so a reload would silently lose the session.
  const API_BASE =
    localStorage.getItem("psm.dapp.api") ||
    (HOSTED ? "https://werewolf.solutions/api/v1" : "http://localhost:3000/api/v1");
  const WEB_ORIGIN =
    localStorage.getItem("psm.dapp.web") ||
    (HOSTED ? "https://werewolf.solutions" : "http://localhost:5173");

  const APP_KEY = "psm-web";
  const CALLBACK_PATH = "/auth/callback";
  /** Must match a registered redirect URI exactly — web clients are exact-match. */
  const redirectUri = () => `${location.origin}${CALLBACK_PATH}`;

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

  /** Every auth call needs the cookie, which is cross-origin in production. */
  const post = (url, body, headers) =>
    fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(headers || {}) },
      body: JSON.stringify(body ?? {}),
    });

  /** Step 1 — leave for the consent screen. Does not return. */
  async function beginSignIn() {
    if (!window.isSecureContext) {
      throw new Error(
        "Signing in needs a secure context (https, or localhost). crypto.subtle is unavailable here.",
      );
    }
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

    const res = await post(authUrl("exchange"), {
      code,
      codeVerifier: verifier,
      redirectUri: redirectUri(),
      device: { id: deviceId(), name: "Browser", platform: navigator.platform || "web" },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) throw new Error(body?.message || "Could not complete sign-in.");

    accessToken = body.data.tokens.accessToken;
    localStorage.setItem(SIGNED_IN_KEY, "1");
    try {
      localStorage.setItem(WHO_KEY, JSON.stringify(body.data.user));
    } catch {}
    return body.data.user;
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
    const res = await post(authUrl("refresh"), {});
    const body = res.ok ? await res.json().catch(() => null) : null;
    if (!body?.success) {
      accessToken = null;
      localStorage.removeItem(SIGNED_IN_KEY);
      localStorage.removeItem(WHO_KEY);
      return false;
    }
    accessToken = body.data.tokens.accessToken;
    localStorage.setItem(SIGNED_IN_KEY, "1");
    return true;
  }

  /**
   * On startup: are we still signed in from last time? Skipped entirely when
   * there is no marker, so a signed-out visitor never spends a rate-limited
   * failed attempt just by loading the page.
   */
  async function restore() {
    if (!localStorage.getItem(SIGNED_IN_KEY)) return false;
    return refresh();
  }

  async function signOut() {
    if (accessToken) {
      // Revokes server-side and clears the cookie. Best effort — a failure here
      // must not leave the page thinking it is still signed in.
      await fetch(authUrl("logout"), {
        method: "POST",
        credentials: "include",
        headers: { Authorization: `Bearer ${accessToken}` },
      }).catch(() => undefined);
    }
    accessToken = null;
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
    hosted: HOSTED,
    apiBase: API_BASE,
    webOrigin: WEB_ORIGIN,
    appKey: APP_KEY,
    callbackPath: CALLBACK_PATH,
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
