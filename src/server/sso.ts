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
  try {
    response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    return {
      available: false,
      reason: `Could not reach Werewolf at ${apiUrl} (${(err as Error).message}).`,
    };
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
