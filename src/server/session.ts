/**
 * Signing in to psm, against werewolf-dapp.
 *
 * dapp already owns psm's accounts: `/api/v1/apps/psm/auth/{register,login,
 * refresh,logout}` and `/apps/psm/me`. psm does not store passwords, does not
 * mint identities, and does not verify dapp's signatures — it asks dapp.
 *
 * **psm's server is the confidential client, not the browser.** todo-app can run
 * the whole flow in the tab because dapp hands web clients an httpOnly refresh
 * cookie the page cannot read. psm's app-session endpoints take the refresh
 * token in the request body instead, so a browser client would have to keep it
 * somewhere JavaScript can reach — exactly what todo-app's own comments warn
 * against. So psm redeems the authorization code server-side and the browser
 * gets back a cookie holding nothing but an opaque session id and a signature
 * over it.
 *
 * The dapp refresh token stays here, next to the session record, and never
 * crosses back to the page. There is no password path: "Continue with Werewolf"
 * (server/sso.ts) is the only way in, so psm never handles a credential at all.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type express from "express";

import { isMultiTenant, requiresAuth } from "../mode.ts";
import { sharedStateDir } from "../store.ts";
import { werewolfApiUrl } from "./runtime.ts";

export const SESSION_COOKIE = "psm_session";

/** dapp access tokens live 15 minutes; refresh a little before the edge. */
const ACCESS_SKEW_MS = 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface PsmSessionUser {
  id: string;
  email?: string;
  name?: string;
}

interface SessionRecord {
  id: string;
  user: PsmSessionUser;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  apiUrl: string;
  createdAt: number;
  lastSeenAt: number;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Hosted psm may run more than one process, so sessions have to survive this
 * one; locally there is a single process and a single owner, and writing
 * long-lived refresh tokens to disk would be a downgrade from cloud.ts's keyring.
 */
const memorySessions = new Map<string, SessionRecord>();

const sessionsDir = () => sharedStateDir("sessions");

function sessionFile(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new AuthError("bad session id", 400);
  return path.join(sessionsDir(), `${id}.json`);
}

function readSession(id: string): SessionRecord | null {
  if (!isMultiTenant()) return memorySessions.get(id) || null;
  try {
    return JSON.parse(fs.readFileSync(sessionFile(id), "utf8"));
  } catch {
    return null;
  }
}

function writeSession(record: SessionRecord) {
  if (!isMultiTenant()) {
    memorySessions.set(record.id, record);
    return;
  }
  fs.writeFileSync(sessionFile(record.id), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
}

function dropSession(id: string) {
  memorySessions.delete(id);
  if (!isMultiTenant()) return;
  try {
    fs.rmSync(sessionFile(id));
  } catch {
    /* already gone */
  }
}

/**
 * The cookie is `<id>.<hmac>`. Signing it means a guessed or tampered id is
 * rejected without a lookup; the id itself is 256 bits of randomness, so the
 * signature is belt and braces rather than the only thing standing there.
 */
function sessionSecret(): string {
  const configured = process.env.PSM_SESSION_SECRET;
  if (configured) return configured;
  if (requiresAuth()) {
    throw new AuthError(
      "hosted psm needs PSM_SESSION_SECRET set to sign session cookies",
      503,
    );
  }
  // Local psm has one owner on loopback; a per-process secret is enough, and it
  // means restarting invalidates cookies rather than leaving a static key around.
  return (processSecret ||= crypto.randomBytes(32).toString("hex"));
}
let processSecret: string | null = null;

function sign(id: string): string {
  return crypto.createHmac("sha256", sessionSecret()).update(id).digest("base64url");
}

export function sealCookie(id: string): string {
  return `${id}.${sign(id)}`;
}

function unsealCookie(value: string): string | null {
  const at = value.lastIndexOf(".");
  if (at <= 0) return null;
  const id = value.slice(0, at);
  const presented = Buffer.from(value.slice(at + 1));
  const expected = Buffer.from(sign(id));
  if (presented.length !== expected.length) return null;
  return crypto.timingSafeEqual(presented, expected) ? id : null;
}

export function cookieOptions(): express.CookieOptions {
  return {
    httpOnly: true, // the page never reads this, which is the point
    sameSite: "lax",
    secure: requiresAuth(), // hosted is TLS; loopback has no certificate
    path: "/",
    maxAge: SESSION_TTL_MS,
  };
}

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

/**
 * Turn dapp's auth result into a psm session. Both ways in land here — the
 * password endpoints above and the SSO code exchange in sso.ts — because dapp
 * answers both with the same `{ user, tokens, entitlement }` shape.
 */
export function openSession(
  data: any,
  apiUrl: string,
  fallbackEmail?: string,
): { user: PsmSessionUser; cookie: string; entitlement?: unknown } {
  const tokens = data?.tokens;
  if (!tokens?.accessToken || !tokens?.refreshToken) {
    throw new AuthError("Werewolf did not return a session", 502);
  }

  const record: SessionRecord = {
    id: crypto.randomBytes(32).toString("base64url"),
    user: {
      id: String(data.user?.id || ""),
      email: data.user?.email || fallbackEmail,
      name: data.user?.name,
    },
    accessToken: tokens.accessToken,
    accessExpiresAt: Date.now() + (Number(tokens.expiresIn) || 900) * 1000,
    refreshToken: tokens.refreshToken,
    apiUrl,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  if (!record.user.id) throw new AuthError("Werewolf did not identify the account", 502);
  writeSession(record);
  return { user: record.user, cookie: sealCookie(record.id), entitlement: data.entitlement };
}

/** The Werewolf API this process talks to, and a caller-facing POST helper. */
export async function dappPost(pathname: string, body: unknown, apiUrl?: string): Promise<any> {
  return dapp(pathname, { method: "POST", body: JSON.stringify(body) }, apiUrl);
}

/** Swap dapp's rotating refresh token for a fresh access token. */
async function refreshRecord(record: SessionRecord): Promise<SessionRecord | null> {
  try {
    const data = await dapp(
      "/apps/psm/auth/refresh",
      { method: "POST", body: JSON.stringify({ refreshToken: record.refreshToken }) },
      record.apiUrl,
    );
    const tokens = data?.tokens;
    if (!tokens?.accessToken) return null;
    record.accessToken = tokens.accessToken;
    // dapp rotates on every use: keeping the old one would spend a token that is
    // already dead and log the user out on the next call.
    if (tokens.refreshToken) record.refreshToken = tokens.refreshToken;
    record.accessExpiresAt = Date.now() + (Number(tokens.expiresIn) || 900) * 1000;
    writeSession(record);
    return record;
  } catch {
    return null;
  }
}

function readCookie(req: express.Request, name: string): string {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

/**
 * Resolve the caller's session from its cookie, refreshing against dapp when the
 * access token has aged out. Returns null for "not signed in", which is a normal
 * state locally and a 401 hosted.
 */
export async function sessionFromRequest(req: express.Request): Promise<PsmSessionUser | null> {
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return null;
  let id: string | null;
  try {
    id = unsealCookie(raw);
  } catch {
    return null; // no signing secret configured — treat as signed out
  }
  if (!id) return null;

  const record = readSession(id);
  if (!record) return null;
  if (Date.now() - record.lastSeenAt > SESSION_TTL_MS) {
    dropSession(id);
    return null;
  }

  if (record.accessExpiresAt - ACCESS_SKEW_MS <= Date.now()) {
    const refreshed = await refreshRecord(record);
    if (!refreshed) {
      dropSession(id); // dapp revoked or rotated us out; make the page sign in again
      return null;
    }
  }
  record.lastSeenAt = Date.now();
  writeSession(record);
  return record.user;
}

/**
 * Everything the rest of the request needs to know about who is calling: the
 * owner for state paths, and the Werewolf token for calls made on their behalf.
 * Resolved once per request so a refresh cannot happen twice concurrently.
 */
export async function sessionContext(
  req: express.Request,
): Promise<{ userId: string | null; accessToken: string | null }> {
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return { userId: null, accessToken: null };
  let id: string | null;
  try {
    id = unsealCookie(raw);
  } catch {
    return { userId: null, accessToken: null };
  }
  if (!id) return { userId: null, accessToken: null };

  let record = readSession(id);
  if (!record) return { userId: null, accessToken: null };
  if (Date.now() - record.lastSeenAt > SESSION_TTL_MS) {
    dropSession(id);
    return { userId: null, accessToken: null };
  }
  if (record.accessExpiresAt - ACCESS_SKEW_MS <= Date.now()) {
    const refreshed = await refreshRecord(record);
    if (!refreshed) {
      dropSession(id);
      return { userId: null, accessToken: null };
    }
    record = refreshed;
  }
  record.lastSeenAt = Date.now();
  writeSession(record);
  return { userId: record.user.id, accessToken: record.accessToken };
}

/** The dapp access token for this session, for calls psm makes on its behalf. */
export async function accessTokenFor(req: express.Request): Promise<string | null> {
  const raw = readCookie(req, SESSION_COOKIE);
  const id = raw ? unsealCookie(raw) : null;
  if (!id) return null;
  let record = readSession(id);
  if (!record) return null;
  if (record.accessExpiresAt - ACCESS_SKEW_MS <= Date.now()) {
    record = await refreshRecord(record);
  }
  return record?.accessToken || null;
}

export async function signOut(req: express.Request): Promise<void> {
  const raw = readCookie(req, SESSION_COOKIE);
  const id = raw ? unsealCookie(raw) : null;
  if (!id) return;
  const record = readSession(id);
  if (record) {
    // Best effort: revoking at dapp is right, but a failure there must not leave
    // the browser holding a cookie it thinks is live.
    await dapp(
      "/apps/psm/auth/logout",
      { method: "POST", headers: { Authorization: `Bearer ${record.accessToken}` } },
      record.apiUrl,
    ).catch(() => undefined);
  }
  dropSession(id);
}

/**
 * Validate a werewolf access token presented directly (API clients, the agent),
 * by asking dapp who it belongs to. Authoritative: a revoked session fails here
 * immediately, which local signature checking could not tell us.
 */
const introspectionCache = new Map<string, { user: PsmSessionUser; checkedAt: number }>();
const INTROSPECT_TTL_MS = 30_000;

export async function userForAccessToken(token: string): Promise<PsmSessionUser | null> {
  const key = crypto.createHash("sha256").update(token).digest("hex");
  const cached = introspectionCache.get(key);
  if (cached && Date.now() - cached.checkedAt < INTROSPECT_TTL_MS) return cached.user;
  try {
    const data = await dapp("/apps/psm/me", { headers: { Authorization: `Bearer ${token}` } });
    const user = { id: String(data?.user?.id || ""), email: data?.user?.email, name: data?.user?.name };
    if (!user.id) return null;
    introspectionCache.set(key, { user, checkedAt: Date.now() });
    return user;
  } catch {
    introspectionCache.delete(key);
    return null;
  }
}
