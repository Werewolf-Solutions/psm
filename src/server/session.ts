/**
 * The local cockpit's Werewolf session.
 *
 * psm runs on one machine for one person, reached over loopback, and it shells
 * out on request. So there is exactly one session, held in memory, and no cookie:
 * a signed cookie would protect nothing the loopback boundary does not already
 * protect, and a refresh token written to disk would be a downgrade from holding
 * it in a process that dies with the terminal.
 *
 * It is established by "Continue with Werewolf" — authorization code + PKCE
 * against werewolf-dapp, redeemed here (see server/sso.ts). psm stores no
 * password, mints no identity, and holds none of dapp's signing keys.
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

/** dapp access tokens live 15 minutes; refresh a little before the edge. */
const ACCESS_SKEW_MS = 60_000;

export interface PsmSessionUser {
  id: string;
  email?: string;
  name?: string;
}

interface SessionRecord {
  user: PsmSessionUser;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  apiUrl: string;
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

async function dapp(pathname: string, init: RequestInit, apiUrl?: string): Promise<any> {
  const base = apiUrl || (await werewolfApiUrl());
  let response: Response;
  try {
    response = await fetch(`${base}${pathname}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    });
  } catch (err) {
    throw new AuthError(`Could not reach the Werewolf API: ${(err as Error).message}`, 502);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success === false) {
    throw new AuthError(body?.message || `Werewolf API returned ${response.status}`, response.status);
  }
  return body?.data ?? body;
}

export async function dappPost(pathname: string, body: unknown, apiUrl?: string): Promise<any> {
  return dapp(pathname, { method: "POST", body: JSON.stringify(body) }, apiUrl);
}

/** Turn dapp's auth result — from the SSO code exchange — into psm's session. */
export function openSession(data: any, apiUrl: string): { user: PsmSessionUser } {
  const tokens = data?.tokens;
  if (!tokens?.accessToken || !tokens?.refreshToken) {
    throw new AuthError("Werewolf did not return a session", 502);
  }
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
    refreshToken: tokens.refreshToken,
    apiUrl,
    createdAt: Date.now(),
  };
  return { user };
}

/** Swap dapp's rotating refresh token for a fresh access token. */
async function refreshSession(): Promise<boolean> {
  if (!session) return false;
  try {
    const data = await dapp(
      "/apps/psm/auth/refresh",
      { method: "POST", body: JSON.stringify({ refreshToken: session.refreshToken }) },
      session.apiUrl,
    );
    const tokens = data?.tokens;
    if (!tokens?.accessToken) return false;
    session.accessToken = tokens.accessToken;
    // dapp rotates on every use: keeping the old one would spend a token that is
    // already dead and sign the user out on the next call.
    if (tokens.refreshToken) session.refreshToken = tokens.refreshToken;
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
    "/apps/psm/auth/logout",
    { method: "POST", headers: { Authorization: `Bearer ${record.accessToken}` } },
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
