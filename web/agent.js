/**
 * Talking to the agent on the user's own machine.
 *
 * The hosted page has no API of its own. Everything about projects — scanning,
 * running, logs, AI — comes from a psm agent on `127.0.0.1`, reached directly
 * from the browser and authenticated with a pairing token. Nothing about the
 * user's code passes through a server.
 *
 * Served from the agent itself (the local cockpit) this module is inert: the
 * base is empty, no token is attached, and every call is same-origin exactly as
 * it always was.
 *
 * ## The browser is the hard part
 *
 * A public https page reaching a private address is gated. Chrome has shipped
 * **Local Network Access as a permission** (`navigator.permissions.query({name:
 * "local-network-access"})`), and until it is granted:
 *
 *   - a plain `fetch` **hangs indefinitely** — no error, ever
 *   - `fetch(url, { targetAddressSpace: "private" })` fails fast with TypeError
 *
 * So calls from a public page pass `targetAddressSpace`, because a fast failure
 * we can explain beats a spinner that never resolves — but *only* from a public
 * page: Chrome rejects the option when the initiator is already local, failing a
 * request that would otherwise succeed. `diagnose()` turns whatever happens into
 * something the pairing screen can say out loud, rather than "failed to fetch".
 * Verified on Chrome 151 on 2026-08-12, both ways round.
 *
 * EventSource cannot carry a header or that option, so streams authenticate with
 * `?agentToken=` (the agent accepts it — see src/server/agent.ts) and are subject
 * to the same permission with no way to fail fast.
 */
(function () {
  const STORE_KEY = "psm.agent";
  const DEFAULT_PORTS = [4317, 4318, 4319, 4320];
  const PROBE_MS = 2500;

  const AGENT = {
    /** "" when the page is served by the agent; otherwise its origin. */
    base: "",
    token: "",
    /** What /api/agent reported: name, hostname, platform, version, mode. */
    identity: null,
    /**
     * unknown | same-origin | paired | unreachable | unpaired | wrong-mode |
     * blocked-by-browser
     */
    state: "unknown",
    detail: "",
  };

  /**
   * Is the agent serving this very page?
   *
   * The hostname is only a first guess, and a wrong one during testing: the
   * static host runs on localhost:8080 and is not an agent at all. app.js settles
   * it by asking this origin for /api/auth/session and calls `setServedByAgent`,
   * which is the same "loopback is not same-origin" distinction the agent's own
   * CORS guard had to learn.
   */
  let servedByAgent = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);

  /**
   * Is this page subject to the local-network gate? Only a *public* origin is.
   *
   * This also decides whether `targetAddressSpace: "private"` may be used at all:
   * Chrome rejects the option outright when the initiator is itself local — a
   * page on http://localhost:8080 passing it gets `TypeError: Failed to fetch`
   * for a request that succeeds without it. So it is opt-in for public pages,
   * where it buys a fast failure, and absent everywhere else.
   */
  let GATED = !servedByAgent && location.protocol === "https:";
  let spaceOption = GATED ? { targetAddressSpace: "private" } : {};

  function setServedByAgent(value) {
    servedByAgent = !!value;
    GATED = !servedByAgent && location.protocol === "https:";
    spaceOption = GATED ? { targetAddressSpace: "private" } : {};
    if (servedByAgent) {
      AGENT.base = "";
      AGENT.token = "";
      AGENT.state = "same-origin";
    } else if (AGENT.state === "same-origin") {
      AGENT.state = AGENT.base ? "unknown" : "unpaired";
      load();
    }
  }

  function load() {
    if (servedByAgent) {
      AGENT.base = "";
      AGENT.token = "";
      AGENT.state = "same-origin";
      return;
    }
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (saved?.base) {
        AGENT.base = String(saved.base).replace(/\/$/, "");
        AGENT.token = String(saved.token || "");
      }
    } catch {
      /* nothing paired */
    }
  }

  function remember(base, token) {
    AGENT.base = String(base).replace(/\/$/, "");
    AGENT.token = String(token || "");
    localStorage.setItem(STORE_KEY, JSON.stringify({ base: AGENT.base, token: AGENT.token }));
  }

  function forget() {
    AGENT.base = "";
    AGENT.token = "";
    AGENT.identity = null;
    AGENT.state = "unpaired";
    localStorage.removeItem(STORE_KEY);
  }

  /** Chrome's Local Network Access permission, where the browser has one. */
  async function localNetworkPermission() {
    try {
      const status = await navigator.permissions.query({ name: "local-network-access" });
      return status.state; // granted | prompt | denied
    } catch {
      return "unsupported"; // older Chrome, or a browser without the permission
    }
  }

  /**
   * One request to the agent. Same-origin and unadorned when the agent serves
   * this page; bearer-authenticated and address-space-declared otherwise.
   */
  function api(path, init = {}) {
    if (!AGENT.base) return fetch(path, init);
    const headers = { ...(init.headers || {}) };
    if (AGENT.token) headers.Authorization = `Bearer ${AGENT.token}`;
    // Declared only from a public page, where it turns an indefinite hang into
    // an immediate, explainable failure. See spaceOption above.
    return fetch(AGENT.base + path, { ...init, headers, ...spaceOption });
  }

  /**
   * An SSE stream from the agent. EventSource cannot set headers, so the token
   * rides in the query string — which is why the agent accepts `agentToken`.
   */
  function agentStream(path) {
    if (!AGENT.base) return new EventSource(path);
    const url = new URL(AGENT.base + path);
    if (AGENT.token) url.searchParams.set("agentToken", AGENT.token);
    return new EventSource(url.toString());
  }

  /**
   * Why can we not reach the agent? Every branch has to end in a sentence a
   * person can act on — "Failed to fetch" is not one.
   */
  async function diagnose(base) {
    // Only a *public* page is subject to the local-network gate. A page already
    // on loopback reaching loopback is not, so blaming the permission there
    // would send someone hunting a browser setting for a CORS problem.
    const permission = GATED ? await localNetworkPermission() : "not-applicable";
    if (permission === "denied") {
      return {
        state: "blocked-by-browser",
        detail:
          "This browser is blocking pages from reaching your local network. Allow " +
          "“Local network access” for this site in the address-bar site settings, then try again.",
      };
    }

    let response;
    try {
      response = await withTimeout(fetch(`${base}/api/agent`, { ...spaceOption }), PROBE_MS);
    } catch (err) {
      if (err?.name === "TimeoutError") {
        return {
          state: "blocked-by-browser",
          detail:
            "The request never completed, which usually means the browser is waiting on " +
            "permission to reach your local network. Look for a prompt in the address bar.",
        };
      }
      if (GATED && permission === "prompt") {
        return {
          state: "blocked-by-browser",
          detail:
            "The browser has not been given permission to reach your local network yet. " +
            "Click Connect again and allow it when the address bar asks.",
        };
      }
      return {
        state: "unreachable",
        detail: `Nothing answered at ${base}. Start it with \`npm run agent\` and check the port.`,
      };
    }

    if (response.status === 401) {
      return { state: "unpaired", detail: "That token was not accepted. Copy it again from the cockpit." };
    }
    if (response.status === 403) {
      return {
        state: "wrong-mode",
        detail:
          "The agent refused this origin. It is probably running in dev mode — restart it " +
          "with `npm run agent`, which is the mode that accepts a paired browser.",
      };
    }
    if (!response.ok) {
      return { state: "unreachable", detail: `The agent answered ${response.status}.` };
    }
    return { state: "ok", identity: await response.json().catch(() => null) };
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })), ms),
      ),
    ]);
  }

  /** Look for an agent on the usual ports. Returns the first that answers. */
  async function discover() {
    for (const port of DEFAULT_PORTS) {
      const base = `http://127.0.0.1:${port}`;
      const result = await diagnose(base);
      if (result.state === "ok") return { base, identity: result.identity };
      // A 401/403 still proves something is listening — that is the one to offer.
      if (result.state === "unpaired" || result.state === "wrong-mode") return { base, identity: null };
    }
    return null;
  }

  /**
   * Establish (or re-check) the connection. Validates before storing, so a bad
   * token fails on the button rather than later on the board.
   */
  async function connect(base, token) {
    const target = String(base || AGENT.base || `http://127.0.0.1:${DEFAULT_PORTS[0]}`).replace(/\/$/, "");
    const previous = { base: AGENT.base, token: AGENT.token };
    AGENT.base = target;
    AGENT.token = String(token ?? AGENT.token ?? "");

    const result = await diagnose(target);
    if (result.state !== "ok") {
      AGENT.base = previous.base;
      AGENT.token = previous.token;
      AGENT.state = result.state;
      AGENT.detail = result.detail;
      return false;
    }

    // /api/agent is public by design, so prove the token too before trusting it.
    let authed;
    try {
      authed = await withTimeout(api("/api/links"), PROBE_MS);
    } catch {
      AGENT.base = previous.base;
      AGENT.token = previous.token;
      AGENT.state = "unreachable";
      AGENT.detail = "The agent stopped answering midway through pairing.";
      return false;
    }
    if (authed.status === 401) {
      AGENT.base = previous.base;
      AGENT.token = previous.token;
      AGENT.state = "unpaired";
      AGENT.detail = "That token was not accepted. Copy it again from the cockpit at " + target + ".";
      return false;
    }

    AGENT.identity = result.identity;
    AGENT.state = "paired";
    AGENT.detail = "";
    remember(target, AGENT.token);
    return true;
  }

  /** On load: are we already connected to something? */
  async function refreshState() {
    if (servedByAgent) {
      AGENT.state = "same-origin";
      return AGENT.state;
    }
    if (!AGENT.base) {
      AGENT.state = "unpaired";
      AGENT.detail = "";
      return AGENT.state;
    }
    await connect(AGENT.base, AGENT.token);
    return AGENT.state;
  }

  load();

  window.PsmAgent = {
    state: () => AGENT.state,
    detail: () => AGENT.detail,
    identity: () => AGENT.identity,
    base: () => AGENT.base,
    token: () => AGENT.token,
    servedByAgent: () => servedByAgent,
    setServedByAgent,
    defaultBase: `http://127.0.0.1:${DEFAULT_PORTS[0]}`,
    api,
    agentStream,
    connect,
    forget,
    discover,
    diagnose,
    refreshState,
    localNetworkPermission,
  };
})();
