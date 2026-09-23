/**
 * "Sign in with Werewolf" — psm's half of it that has to live on a server.
 *
 * The flow itself is OAuth 2.0 authorization code + PKCE against werewolf-dapp,
 * and it runs **in the browser**, in web/auth.js, exactly as todo-app's does.
 * One application row (`psm`, `clientType: 'web'`), one client_id, one consent
 * screen, one callback path — whether the page came from the local agent or from
 * psm.werewolf.solutions.
 *
 * What is left here is the part a page cannot do for itself:
 *
 *  - **Where dapp is.** A local dapp's consent screen is on its Vite dev server,
 *    whose port moves; only the machine can see which one is actually running.
 *  - **Whether signing in can work at all.** dapp answers `app_not_configured`
 *    until the row exists, and the consent screen cannot explain itself, so psm
 *    asks first and says so in a sentence.
 *
 * The code exchange moved to server/session.ts, because for a web client dapp
 * returns the refresh credential as an httpOnly cookie and a page on localhost
 * cannot keep one. See the header there.
 *
 * Superseded: psm used to hold a second, server-side PKCE flow of its own for
 * the loopback case, against a separate `native` row. Two rows meant two
 * registrations, two consent screens and two things to keep working; the browser
 * flow serves both postures now.
 */
import type express from "express";

import { getProjects } from "../index.ts";
import { APP_KEY } from "./session.ts";
import { machineProcesses } from "./machine.ts";
import { currentWerewolfRuntime, werewolfApiUrl } from "./runtime.ts";

/** Where the browser is sent back to. One path, every posture. */
export const SSO_CALLBACK_PATH = "/auth/callback";

/** Vite's default, and what todo-app's own config uses for a local dapp. */
const VITE_DEFAULT_ORIGIN = "http://localhost:5173";

/**
 * Find the dapp client's dev server, because Vite climbs to 5174, 5175… when a
 * previous one is still holding the port. Guessing 5173 in that state sends the
 * user to a stale client; asking the machine gets the live one.
 */
function runningDappClientOrigin(): string | null {
  try {
    const dappName = currentWerewolfRuntime().project; // "werewolf-dapp"
    const project = getProjects().find((candidate) => candidate.name === dappName);
    if (!project) return null;
    const vite = machineProcesses().find(
      (proc) =>
        proc.ports.length &&
        /\bvite\b/.test(proc.label) &&
        proc.cwd &&
        (proc.cwd === project.path || proc.cwd.startsWith(project.path + "/")),
    );
    return vite ? `http://localhost:${vite.ports[0]}` : null;
  } catch {
    return null; // best effort — never let discovery break signing in
  }
}

/**
 * Where dapp's *consent screen* lives — its web client, not its API. Signing in
 * is a full-page redirect there, so this has to be a browsable origin.
 */
export function werewolfWebOrigin(apiUrl: string): string {
  const configured = process.env.WEREWOLF_WEB_ORIGIN;
  if (configured) return configured.replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return "https://werewolf.solutions";
  }
  // https://werewolf.solutions/api/v1 → https://werewolf.solutions, which serves
  // the consent screen alongside the API.
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) return url.origin;

  // A local dapp is a different shape: its API is on 3000 but the client you are
  // actually working on is Vite's dev server, and 3000 serves a *built* bundle
  // that may be months old. Prefer the running dev client.
  return runningDappClientOrigin() || VITE_DEFAULT_ORIGIN;
}

/**
 * The callback this page will be returned to. A web client is exact-matched
 * (`CloudApplication.isRedirectAllowed`), so this string has to appear verbatim
 * in the row's `redirectUris` — which is why psm's ports are pinned, the way
 * todo-app pins 5200. `PSM_PUBLIC_ORIGIN` covers a psm behind a proxy.
 */
export function ssoRedirectUri(req?: express.Request): string {
  const configured = process.env.PSM_PUBLIC_ORIGIN;
  if (configured) return `${configured.replace(/\/$/, "")}${SSO_CALLBACK_PATH}`;
  const origin = pageOrigin(req);
  return `${origin}${SSO_CALLBACK_PATH}`;
}

/** The origin the page asking us was served from. */
function pageOrigin(req?: express.Request): string {
  const header = req?.headers.origin;
  if (typeof header === "string" && header) return header.replace(/\/$/, "");
  const host = req?.headers.host;
  // Same-origin GETs send no Origin at all, so Host is the usual answer here.
  if (typeof host === "string" && host) return `http://${host}`;
  return `http://localhost:${Number(process.env.PORT || 4317)}`;
}

/** A callback psm will not sign an exchange for. 400, not 401: it never left. */
export class SsoCallbackError extends Error {
  status = 400;
}

/**
 * The callback psm will accept for a code exchange, given what the page claims.
 *
 * The page reports the URI it actually used, because dapp exact-matches it
 * against the one bound into the code. psm cannot simply *forward* that string,
 * though, because it now derives the `Origin` header of its own server-side
 * exchange from it (see server/session.ts): an unchecked value here would let a
 * caller choose which origin psm asserts to dapp. So the claim is checked
 * against the callback this psm would have issued for this very request, and
 * anything else is refused before a single byte reaches dapp.
 *
 * That comparison is meaningful because the claim and the reference are not the
 * same source. `ssoRedirectUri` is built from `PSM_PUBLIC_ORIGIN` when a proxy
 * pins one, and otherwise from the request's own origin — which `agentGuard`
 * has already narrowed to loopback or the single paired origin before any route
 * runs. The body is just a string a caller typed.
 */
export function approvedSsoCallback(req: express.Request | undefined, claimed: string): string {
  const expected = ssoRedirectUri(req);
  const requested = String(claimed || "").trim();
  // Nothing claimed: the page is this psm's own, and the callback is ours to say.
  if (!requested) return expected;
  if (requested === expected) return requested;
  throw new SsoCallbackError(
    `This sign-in came back to ${requested}, and psm issues ${expected}. ` +
      "A web client is exact-matched, so the callback has to be the one this psm serves.",
  );
}

/**
 * The `Origin` psm presents to dapp on this app's auth calls, derived from a
 * callback that has already been through `approvedSsoCallback`.
 *
 * dapp pins a web client's cookie endpoints to an origin represented in the
 * row's `redirectUris` (`server/utils/appSessionCookie.js`, `isOriginAllowed`),
 * and psm is a server, so nothing sets this header for it. The callback's own
 * origin is exactly the right answer: if the URI is registered — and dapp
 * re-checks that on the exchange — then its origin is in the allowlist by
 * construction. Nothing here widens what dapp accepts; it only stops psm from
 * arriving with no Origin at all, which dapp correctly refuses.
 */
export function ssoOriginForCallback(callbackUri: string): string {
  let url: URL;
  try {
    url = new URL(callbackUri);
  } catch {
    throw new SsoCallbackError(`${callbackUri || "That callback"} is not a usable callback URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new SsoCallbackError("A psm callback is an http(s) URL; this one is not.");
  }
  return url.origin;
}

/**
 * Is psm registered with the dapp this instance is pointed at, as the kind of
 * client this build expects, and will it accept this page's callback?
 *
 * Worth asking *before* the redirect. dapp's consent screen is a page on its web
 * client, so an unregistered client_id sends the user away from psm to a screen
 * that cannot explain itself, and they come back — if they come back — with
 * nothing. Production has had no CloudApplication rows at all
 * (`503 app_not_configured` for `psm`, `psm-web` and `todo` alike), which is
 * exactly the case that used to look like "sign-in is broken" from here.
 *
 * Registration is a row in dapp's database. See docs/werewolf-psm-registration.md.
 */
export interface SsoAvailability {
  available: boolean;
  reason?: string;
}

const CHECK_TTL_MS = 30_000;
const REGISTRATION_TIMEOUT_MS = 5_000;
let lastCheck: { at: number; key: string; result: SsoAvailability } | null = null;

export async function ssoAvailability(
  req?: express.Request,
  fetchImpl: typeof fetch = fetch,
): Promise<SsoAvailability> {
  const apiUrl = await werewolfApiUrl();
  const redirectUri = ssoRedirectUri(req);
  const key = `${apiUrl}\0${redirectUri}`;
  if (lastCheck && lastCheck.key === key && Date.now() - lastCheck.at < CHECK_TTL_MS) {
    return lastCheck.result;
  }
  const result = await probeRegistration(apiUrl, redirectUri, fetchImpl);
  lastCheck = { at: Date.now(), key, result };
  return result;
}

async function probeRegistration(
  apiUrl: string,
  redirectUri: string,
  fetchImpl: typeof fetch,
): Promise<SsoAvailability> {
  // camelCase `redirectUri` — dapp treats `redirect_uri` as absent and answers
  // redirectAllowed:false, which is a misleading way to read "wrong question".
  const url = `${apiUrl}/apps/${APP_KEY}/public?redirectUri=${encodeURIComponent(redirectUri)}`;
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REGISTRATION_TIMEOUT_MS);
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    const error = err as Error;
    return {
      available: false,
      reason: error.name === "AbortError"
        ? `Werewolf at ${apiUrl} did not answer within ${REGISTRATION_TIMEOUT_MS / 1000} seconds.`
        : `Could not reach Werewolf at ${apiUrl} (${error.message}).`,
    };
  } finally {
    clearTimeout(timeout);
  }
  const body = (await response.json().catch(() => ({}))) as any;

  // 404 and 503 are the same story: getApplication() found no row. dapp's
  // controller maps app_not_configured to 404 on this route and 503 on exchange.
  if (response.status === 404 || response.status === 503) {
    return {
      available: false,
      reason:
        `psm is not registered with Werewolf at ${apiUrl}, so signing in cannot work. ` +
        "It needs one CloudApplication row with key `psm` and clientType `web` " +
        "(see docs/werewolf-psm-registration.md).",
    };
  }
  if (!response.ok || !body?.success) {
    return {
      available: false,
      reason: body?.message || `Werewolf answered ${response.status} when asked about psm.`,
    };
  }

  // A row from before the two rows were collapsed. The browser flow needs `web`:
  // a native row would hand a page its refresh token, which is the whole reason
  // dapp has a cookie transport at all.
  if (body.data?.clientType && body.data.clientType !== "web") {
    return {
      available: false,
      reason:
        `Werewolf has psm registered as a ${body.data.clientType} client, and this build signs in ` +
        "as a web client. The row needs clientType `web` and this callback in its redirectUris " +
        `(${redirectUri}) — see docs/werewolf-psm-registration.md.`,
    };
  }
  if (!body.data?.redirectAllowed) {
    return {
      available: false,
      reason:
        `Werewolf knows psm but will not accept this page's callback (${redirectUri}). ` +
        "A web client is exact-matched, so that URI has to be listed in the row's redirectUris.",
    };
  }
  return { available: true };
}

/** Test seam: forget the cached registration answer. */
export function resetSsoAvailability(): void {
  lastCheck = null;
}

/** What the page needs to start a sign-in for itself. */
export async function ssoConfig(req?: express.Request) {
  const apiUrl = await werewolfApiUrl();
  return {
    appKey: APP_KEY,
    apiBase: apiUrl,
    webOrigin: werewolfWebOrigin(apiUrl),
    callbackPath: SSO_CALLBACK_PATH,
    redirectUri: ssoRedirectUri(req),
  };
}
