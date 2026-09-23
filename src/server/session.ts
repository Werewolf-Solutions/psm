/**
 * The local cockpit's Werewolf session.
 *
 * psm runs on one machine for one person, reached over loopback, and it shells
 * out on request. So there is exactly one session, held in memory and never
 * written to disk: a refresh credential in a process that dies with the terminal
 * beats one in a file.
 *
 * It is established by "Sign in with Werewolf" — authorization code + PKCE
 * against werewolf-dapp. The browser runs the PKCE half (web/auth.js, the same
 * code the hosted page runs) and hands the code here to be redeemed, because a
 * page on localhost cannot keep dapp's refresh cookie.
 *
 * ## Why there is a cookie jar in here
 *
 * psm is registered as **one** application, `clientType: 'web'` — one row, one
 * consent screen, the shape todo-app uses. For a web client dapp never returns
 * the refresh token in JSON; it sets an httpOnly cookie
 * (`ws_app_rt_psm`, scoped to `/api/v1/apps/psm/auth`) and omits it from the body
 * — see werewolf-dapp/server/utils/appSessionCookie.js.
 *
 * That cookie is `SameSite=Lax` and host-only on the API's host, which works
 * beautifully for psm.werewolf.solutions → werewolf.solutions (different origins,
 * same *site*) and not at all for a cockpit on localhost:4317 → werewolf.solutions
 * (genuinely cross-site: the browser will neither store it nor send it). A server
 * has no SameSite rules, so the cockpit's exchange goes through here and psm
 * keeps the cookie on the page's behalf.
 *
 * **Note on the paired hosted page.** A browser paired with this agent inherits
 * this session for `/api/cloud/*` calls: the machine's owner is whoever started
 * the agent, and the pairing token already grants shell access, so this is the
 * intended semantics rather than a gap. It is written down here so it is decided
 * rather than discovered.
 */
import crypto from "node:crypto";

import { runWithSession } from "../store.ts";
import { werewolfApiUrl } from "./runtime.ts";
import { ssoOriginForCallback } from "./sso.ts";

/** dapp access tokens live 15 minutes; refresh a little before the edge. */
const ACCESS_SKEW_MS = 60_000;
/** A remote auth service must never be able to hold the local cockpit open. */
const DAPP_REQUEST_TIMEOUT_MS = 8_000;

/** The single application row psm signs in as. */
export const APP_KEY = "psm";

/** dapp's cookie for this app; one per app so two cannot clobber each other. */
const REFRESH_COOKIE = `ws_app_rt_${APP_KEY}`;

export interface PsmSessionUser {
  id: string;
  email?: string;
  name?: string;
}

interface SessionRecord {
  user: PsmSessionUser;
  accessToken: string;
  accessExpiresAt: number;
  /** dapp's httpOnly refresh cookie, as `name=value`. Rotates on every use. */
  refreshCookie: string | null;
  apiUrl: string;
  /**
   * The `Origin` this session was opened with, kept so every later call on it
   * presents the same one. See `appOrigin` below for why psm sends one at all.
   */
  origin: string;
  createdAt: number;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** One machine, one owner, one session. */
let session: SessionRecord | null = null;

/* ---------- talking to dapp ---------- */

/** The call, plus the response — the refresh cookie arrives in a header. */
async function dappRaw(
  pathname: string,
  init: RequestInit,
  apiUrl?: string,
): Promise<{ data: any; response: Response }> {
  const base = apiUrl || (await werewolfApiUrl());
  let response: Response;
  try {
    response = await fetch(`${base}${pathname}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers || {}) },
      redirect: "manual", // an auth endpoint that redirects is not one we follow
      signal: AbortSignal.timeout(DAPP_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const error = err as Error;
    const detail = error.name === "TimeoutError"
      ? `request timed out after ${DAPP_REQUEST_TIMEOUT_MS / 1000} seconds`
      : error.message;
    throw new AuthError(`Could not reach the Werewolf API: ${detail}`, 502);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success === false) {
    throw new AuthError(body?.message || `Werewolf API returned ${response.status}`, response.status);
  }
  return { data: body?.data ?? body, response };
}

async function dapp(pathname: string, init: RequestInit, apiUrl?: string): Promise<any> {
  return (await dappRaw(pathname, init, apiUrl)).data;
}

export async function dappPost(pathname: string, body: unknown, apiUrl?: string): Promise<any> {
  return dapp(pathname, { method: "POST", body: JSON.stringify(body) }, apiUrl);
}

/**
 * Pull psm's refresh cookie out of a response, as the `name=value` pair a
 * `Cookie:` header wants. Everything else dapp sets is the browser's business
 * and none of ours — attributes included, since we are not a browser and have no
 * Path or SameSite to enforce.
 */
export function readRefreshCookie(response: Response): string | null {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const all = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [response.headers.get("set-cookie") || ""].filter(Boolean);
  for (const raw of all) {
    const pair = raw.split(";")[0]?.trim();
    if (pair && pair.startsWith(`${REFRESH_COOKIE}=`)) {
      // A cleared cookie comes back empty; that is a sign-out, not a session.
      return pair === `${REFRESH_COOKIE}=` ? null : pair;
    }
  }
  return null;
}

/** Turn dapp's auth result — from the code exchange — into psm's session. */
export function openSession(
  data: any,
  apiUrl: string,
  refreshCookie: string | null = null,
  origin: string = "",
): { user: PsmSessionUser } {
  const tokens = data?.tokens;
  if (!tokens?.accessToken) throw new AuthError("Werewolf did not return a session", 502);
  const user: PsmSessionUser = {
    id: String(data.user?.id || ""),
    email: data.user?.email,
    name: data.user?.name,
  };
  if (!user.id) throw new AuthError("Werewolf did not identify the account", 502);

  session = {
    user,
    accessToken: tokens.accessToken,
    accessExpiresAt: Date.now() + (Number(tokens.expiresIn) || 900) * 1000,
    // A web client is given a cookie, not a token. A row still registered as
    // native answers with `tokens.refreshToken` instead; carrying it as a cookie
    // pair keeps one code path and lets that build limp along until the row is
    // migrated (docs/werewolf-psm-registration.md).
    refreshCookie: refreshCookie
      || (tokens.refreshToken ? `${REFRESH_COOKIE}=${tokens.refreshToken}` : null),
    apiUrl,
    origin,
    createdAt: Date.now(),
  };
  return { user };
}

/**
 * The `Origin` header psm sends on this app's auth calls.
 *
 * dapp pins a **web** client's cookie endpoints to an origin that appears in the
 * application row's `redirectUris` — `isOriginAllowed` in
 * werewolf-dapp/server/utils/appSessionCookie.js — so that another same-site
 * subdomain cannot refresh psm's session and read the bearer token that comes
 * back. That check is right, and psm is on the wrong side of it by accident: a
 * browser stamps this header itself, a server does not, and psm arrived with
 * none at all. An absent Origin is not a trusted Origin, so dapp refused —
 * `401` on exchange, `403` on refresh — and the cockpit could never sign in.
 *
 * The fix belongs here rather than in dapp's check. The origin is taken from the
 * callback this sign-in actually used, *after* `approvedSsoCallback` has
 * confirmed it is the one this psm issues (see server/sso.ts). It is never the
 * caller's own `Origin` header, which would let whoever reached this route
 * choose what psm asserts.
 */
function appOrigin(origin: string): Record<string, string> {
  return origin ? { Origin: origin } : {};
}

/**
 * Redeem the authorization code the browser came back with.
 *
 * The verifier travelled through the page — that is the PKCE contract, and it is
 * useless to anyone without this exchange. What must not travel through the page
 * is the *refresh* credential, and it does not: dapp's cookie is captured here.
 *
 * `redirectUri` must already have been approved by `approvedSsoCallback`; the
 * caller in server/index.ts does that, and the origin psm presents to dapp is
 * derived from it rather than from anything the caller sent.
 */
export async function exchangeCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  device: { id: string; name: string; platform: string };
}): Promise<{ user: PsmSessionUser }> {
  if (!input.code || !input.codeVerifier) {
    throw new AuthError("This sign-in is missing its code.", 400);
  }
  const origin = ssoOriginForCallback(input.redirectUri);
  const apiUrl = await werewolfApiUrl();
  const { data, response } = await dappRaw(
    `/apps/${APP_KEY}/auth/exchange`,
    {
      method: "POST",
      headers: appOrigin(origin),
      body: JSON.stringify({
        code: input.code,
        codeVerifier: input.codeVerifier,
        redirectUri: input.redirectUri,
        device: input.device,
      }),
    },
    apiUrl,
  );
  return openSession(data, apiUrl, readRefreshCookie(response), origin);
}

/**
 * Present the refresh credential for a fresh access token, and keep the new one.
 *
 * Both ways at once, on purpose. Two builds of dapp are in the wild and psm has
 * to work against either:
 *
 *   with the cookie transport   `refreshAppSession` reads the httpOnly cookie
 *                               and *ignores the body* for a web client — which
 *                               is the property the cookie exists to guarantee.
 *   without it                  the same route reads `req.body.refreshToken`,
 *                               and no cookie is ever set.
 *
 * Sending both means one code path serves both, and the newer dapp discards the
 * half it does not trust. Which build is on the other end is not something psm
 * can see, and not something it should have to ask.
 */
async function refreshSession(): Promise<boolean> {
  if (!session?.refreshCookie) return false;
  try {
    const bare = session.refreshCookie.slice(session.refreshCookie.indexOf("=") + 1);
    const { data, response } = await dappRaw(
      `/apps/${APP_KEY}/auth/refresh`,
      {
        method: "POST",
        body: JSON.stringify({ refreshToken: bare }),
        // The same origin the session was opened with. dapp checks this on
        // refresh too, and answers 403 rather than 401 when it is missing.
        headers: { Cookie: session.refreshCookie, ...appOrigin(session.origin) },
      },
      session.apiUrl,
    );
    const tokens = data?.tokens;
    if (!tokens?.accessToken) return false;
    session.accessToken = tokens.accessToken;
    // dapp rotates on every use: keeping the old one would spend a credential
    // that is already dead and sign the user out on the next call.
    const rotated = readRefreshCookie(response)
      || (tokens.refreshToken ? `${REFRESH_COOKIE}=${tokens.refreshToken}` : null);
    if (rotated) session.refreshCookie = rotated;
    session.accessExpiresAt = Date.now() + (Number(tokens.expiresIn) || 900) * 1000;
    return true;
  } catch {
    return false;
  }
}

/** Who is signed in, or null. Refreshes first if the access token has aged out. */
export async function currentUser(): Promise<PsmSessionUser | null> {
  if (!session) return null;
  if (session.accessExpiresAt - ACCESS_SKEW_MS <= Date.now() && !(await refreshSession())) {
    session = null; // revoked at dapp, or rotated out — make them sign in again
    return null;
  }
  return session.user;
}

/**
 * Everything downstream needs about the caller: the token to act on their behalf.
 * Resolved once per request so two refreshes cannot race.
 */
export async function sessionContext(): Promise<{ accessToken: string | null }> {
  return (await currentUser()) ? { accessToken: session!.accessToken } : { accessToken: null };
}

/** Convenience for routes: run `fn` with the session's token in context. */
export async function withSession<T>(fn: () => T): Promise<T> {
  const { accessToken } = await sessionContext();
  return runWithSession(accessToken, fn);
}

export async function signOut(): Promise<void> {
  const record = session;
  session = null; // drop it first — a failure at dapp must not leave us "signed in"
  if (!record) return;
  await dapp(
    `/apps/${APP_KEY}/auth/logout`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${record.accessToken}`,
        // Logout is what actually revokes the session behind the cookie, so it
        // has to present the cookie as well as the access token.
        ...(record.refreshCookie ? { Cookie: record.refreshCookie } : {}),
        /* dapp's logout is guarded by the access token rather than by
         * isOriginAllowed, so this is not required there today. Sending it
         * anyway keeps one origin for the whole life of a session and means a
         * later tightening of that route does not strand sign-out. */
        ...appOrigin(record.origin),
      },
    },
    record.apiUrl,
  ).catch(() => undefined);
}

/** Tests only. */
export function resetSessionForTesting(): void {
  session = null;
}

/** A stable-ish id for this browser/agent pair, so dapp can list and revoke it. */
export function deviceFingerprint(userAgent: string): string {
  return crypto.createHash("sha256").update(`psm\0${userAgent}`).digest("hex").slice(0, 32);
}
