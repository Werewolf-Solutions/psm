import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { currentWerewolfRuntime, werewolfApiUrl } from "./runtime.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DEVICE_FILE = process.env.PSM_CLOUD_DEVICE_FILE || path.join(ROOT, ".psm-cloud-device.json");
const CREDENTIAL_SERVICE = "psm-cloud";
const CREDENTIAL_ACCOUNT = "werewolf-refresh";

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
}

interface StoredSessions {
  version: 3;
  identityRefreshToken?: string;
  identityApiUrl?: string;
  cloudRefreshToken?: string;
  cloudApiUrl?: string;
}

interface SessionState {
  identityTokens: Tokens | null;
  identityExpiresAt: number;
  identityApiUrl: string | null;
  cloudTokens: Tokens | null;
  cloudExpiresAt: number;
  cloudApiUrl: string | null;
  account: any | null;
  syncRevision: number;
  credentialPersistence: "keyring" | "memory";
}

const state: SessionState = {
  identityTokens: null,
  identityExpiresAt: 0,
  identityApiUrl: null,
  cloudTokens: null,
  cloudExpiresAt: 0,
  cloudApiUrl: null,
  account: null,
  syncRevision: 0,
  credentialPersistence: "memory",
};

let storedSessions: StoredSessions | null | undefined;

function atomicJson(file: string, value: unknown, mode = 0o600): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode });
  fs.renameSync(temp, file);
  fs.chmodSync(file, mode);
}

export function deviceIdentity(): { id: string; name: string; platform: string } {
  try {
    const parsed = JSON.parse(fs.readFileSync(DEVICE_FILE, "utf8"));
    if (parsed?.id) return parsed;
  } catch {}
  const device = {
    id: crypto.randomUUID(),
    name: os.hostname(),
    platform: `${os.platform()} ${os.arch()}`,
  };
  atomicJson(DEVICE_FILE, device);
  return device;
}

function keyring(command: "lookup" | "store" | "clear", value?: string): string | null {
  if (process.env.PSM_CLOUD_DISABLE_KEYRING === "1") return null;
  if (process.platform === "linux") {
    try {
      if (command === "lookup") {
        return execFileSync("secret-tool", ["lookup", "service", CREDENTIAL_SERVICE, "account", CREDENTIAL_ACCOUNT], {
          encoding: "utf8",
          timeout: 3000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() || null;
      }
      if (command === "store") {
        execFileSync(
          "secret-tool",
          ["store", "--label", "PSM Cloud", "service", CREDENTIAL_SERVICE, "account", CREDENTIAL_ACCOUNT],
          { input: value || "", timeout: 3000, stdio: ["pipe", "ignore", "ignore"] },
        );
        return value || null;
      }
      execFileSync("secret-tool", ["clear", "service", CREDENTIAL_SERVICE, "account", CREDENTIAL_ACCOUNT], {
        timeout: 3000,
        stdio: "ignore",
      });
      return null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      if (command === "lookup") {
        return execFileSync("security", ["find-generic-password", "-s", CREDENTIAL_SERVICE, "-a", CREDENTIAL_ACCOUNT, "-w"], {
          encoding: "utf8",
          timeout: 3000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() || null;
      }
      if (command === "store") {
        execFileSync("security", ["add-generic-password", "-U", "-s", CREDENTIAL_SERVICE, "-a", CREDENTIAL_ACCOUNT, "-w", value || ""], {
          timeout: 3000,
          stdio: "ignore",
        });
        return value || null;
      }
      execFileSync("security", ["delete-generic-password", "-s", CREDENTIAL_SERVICE, "-a", CREDENTIAL_ACCOUNT], {
        timeout: 3000,
        stdio: "ignore",
      });
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

function readStoredSessions(): StoredSessions | null {
  if (storedSessions !== undefined) return storedSessions;
  const raw = keyring("lookup");
  if (!raw) return (storedSessions = null);
  state.credentialPersistence = "keyring";
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version === 2 || parsed?.version === 3) {
      storedSessions = {
        version: 3,
        ...(typeof parsed.identityRefreshToken === "string" ? { identityRefreshToken: parsed.identityRefreshToken } : {}),
        ...(typeof parsed.identityApiUrl === "string" ? { identityApiUrl: parsed.identityApiUrl } : {}),
        ...(typeof parsed.cloudRefreshToken === "string" ? { cloudRefreshToken: parsed.cloudRefreshToken } : {}),
        ...(typeof parsed.cloudApiUrl === "string" ? { cloudApiUrl: parsed.cloudApiUrl } : {}),
      };
      return storedSessions;
    }
  } catch {}
  // Older PSM builds stored only the app-scoped refresh token as a raw string.
  storedSessions = { version: 3, cloudRefreshToken: raw };
  return storedSessions;
}

function rememberSessions(): void {
  const previous = readStoredSessions();
  const next: StoredSessions = {
    version: 3,
    ...(state.identityTokens?.refreshToken || previous?.identityRefreshToken
      ? { identityRefreshToken: state.identityTokens?.refreshToken || previous?.identityRefreshToken }
      : {}),
    ...(state.identityApiUrl || previous?.identityApiUrl
      ? { identityApiUrl: state.identityApiUrl || previous?.identityApiUrl }
      : {}),
    ...(state.cloudTokens?.refreshToken || previous?.cloudRefreshToken
      ? { cloudRefreshToken: state.cloudTokens?.refreshToken || previous?.cloudRefreshToken }
      : {}),
    ...(state.cloudApiUrl || previous?.cloudApiUrl
      ? { cloudApiUrl: state.cloudApiUrl || previous?.cloudApiUrl }
      : {}),
  };
  storedSessions = next;
  if (keyring("store", JSON.stringify(next))) state.credentialPersistence = "keyring";
  else state.credentialPersistence = "memory";
}

function forgetSessions(): void {
  keyring("clear");
  storedSessions = null;
}

type SessionKind = "identity" | "cloud";

function tokensFor(kind: SessionKind): Tokens | null {
  return kind === "identity" ? state.identityTokens : state.cloudTokens;
}

function expiresAtFor(kind: SessionKind): number {
  return kind === "identity" ? state.identityExpiresAt : state.cloudExpiresAt;
}

function apiUrlFor(kind: SessionKind): string | undefined {
  const live = kind === "identity" ? state.identityApiUrl : state.cloudApiUrl;
  if (live) return live;
  const stored = readStoredSessions();
  return kind === "identity" ? stored?.identityApiUrl : stored?.cloudApiUrl;
}

function refreshTokenFor(kind: SessionKind): string | undefined {
  const live = tokensFor(kind)?.refreshToken;
  if (live) return live;
  const stored = readStoredSessions();
  return kind === "identity" ? stored?.identityRefreshToken : stored?.cloudRefreshToken;
}

function tokenExpiry(tokens: Tokens): number {
  const explicit = Number(tokens.expiresIn);
  if (Number.isFinite(explicit) && explicit > 0) return Date.now() + Math.max(30, explicit) * 1000;
  try {
    const payload = JSON.parse(Buffer.from(tokens.accessToken.split(".")[1], "base64url").toString("utf8"));
    if (Number.isFinite(payload.exp)) return Number(payload.exp) * 1000;
  } catch {}
  return Date.now() + 15 * 60 * 1000;
}

function acceptTokens(kind: SessionKind, value: unknown, apiUrl: string): void {
  const raw = value as Partial<Tokens> | null;
  if (!raw || typeof raw.accessToken !== "string" || typeof raw.refreshToken !== "string") {
    const error = new Error("Werewolf API returned an invalid authentication response") as Error & { status?: number };
    error.status = 502;
    throw error;
  }
  const tokens: Tokens = {
    accessToken: raw.accessToken,
    refreshToken: raw.refreshToken,
    ...(Number.isFinite(Number(raw.expiresIn)) ? { expiresIn: Number(raw.expiresIn) } : {}),
  };
  if (kind === "identity") {
    state.identityTokens = tokens;
    state.identityExpiresAt = tokenExpiry(tokens);
    state.identityApiUrl = apiUrl;
  } else {
    state.cloudTokens = tokens;
    state.cloudExpiresAt = tokenExpiry(tokens);
    state.cloudApiUrl = apiUrl;
  }
  rememberSessions();
}

async function request(
  pathname: string,
  init: RequestInit = {},
  session: SessionKind | null = null,
  retry = true,
  targetUrl?: string,
): Promise<any> {
  if (session && (!tokensFor(session)?.accessToken || expiresAtFor(session) <= Date.now() + 15000)) {
    await refreshSession(session);
  }
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const accessToken = session ? tokensFor(session)?.accessToken : null;
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const apiUrl = targetUrl || (session ? apiUrlFor(session) : undefined) || await werewolfApiUrl();
  const response = await fetch(`${apiUrl}${pathname}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && session && retry) {
    await refreshSession(session, true);
    return request(pathname, init, session, false, apiUrl);
  }
  if (!response.ok || body.success === false) {
    const error = new Error(body.message || `Werewolf API request failed (${response.status})`) as Error & {
      status?: number;
      code?: string;
      data?: unknown;
    };
    error.status = response.status;
    error.code = body.code;
    error.data = body.data;
    throw error;
  }
  return body.data ?? body;
}

async function refreshSession(kind: SessionKind, force = false): Promise<void> {
  if (!force && tokensFor(kind)?.accessToken && expiresAtFor(kind) > Date.now() + 15000) return;
  const refreshToken = refreshTokenFor(kind);
  if (!refreshToken) {
    const message = kind === "identity" ? "Sign in to Werewolf Solutions first" : "Reconnect this device to PSM Cloud";
    const error = new Error(message) as Error & { status?: number };
    error.status = 401;
    throw error;
  }
  const endpoint = kind === "identity" ? "/auth/refresh" : "/apps/psm/auth/refresh";
  const apiUrl = apiUrlFor(kind) || await werewolfApiUrl();
  const data = await request(
    endpoint,
    { method: "POST", body: JSON.stringify({ refreshToken }) },
    null,
    false,
    apiUrl,
  );
  acceptTokens(kind, kind === "identity" ? data : data.tokens, apiUrl);
}

function canonicalUser(data: any): any {
  const user = data?.user || data;
  return {
    id: String(user?.id || user?._id || ""),
    name: String(user?.name || ""),
    email: String(user?.email || ""),
    ...(user?.role ? { role: String(user.role) } : {}),
  };
}

function accountView(user: any, service: any | null, serviceError?: string): any {
  const runtime = currentWerewolfRuntime();
  const apiUrl = state.identityApiUrl || runtime.activeUrl;
  const apiSource = apiUrl === runtime.localUrl
    ? "local"
    : apiUrl === runtime.productionUrl
      ? "production"
      : runtime.source;
  return {
    ...(service || {}),
    user,
    cloudReady: !!service,
    ...(serviceError ? { serviceError } : {}),
    credentialPersistence: state.credentialPersistence,
    apiUrl,
    apiSource,
  };
}

export async function authenticate(
  action: "login" | "register",
  fields: { name?: string; email: string; password: string },
): Promise<any> {
  const apiUrl = await werewolfApiUrl(true);
  const identity = await request(
    `/auth/${action}`,
    { method: "POST", body: JSON.stringify(fields) },
    null,
    true,
    apiUrl,
  );
  // A new canonical login replaces both halves of any previous account session.
  state.identityTokens = null;
  state.identityExpiresAt = 0;
  state.identityApiUrl = null;
  state.cloudTokens = null;
  state.cloudExpiresAt = 0;
  state.cloudApiUrl = null;
  forgetSessions();
  acceptTokens("identity", identity, apiUrl);

  // /auth/me is the source of truth for whether this installation is signed in.
  const user = canonicalUser(await request("/auth/me", {}, "identity"));
  try {
    const service = await request(
      "/apps/psm/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ ...fields, device: deviceIdentity() }),
      },
      null,
      true,
      apiUrl,
    );
    acceptTokens("cloud", service.tokens, apiUrl);
    const snapshot = await request("/apps/psm/me", {}, "cloud");
    state.account = accountView(user, snapshot);
  } catch (err) {
    const typed = err as Error;
    state.account = accountView(user, null, typed.message || "Could not connect this device to PSM Cloud");
  }
  return state.account;
}

export async function account(force = false): Promise<any> {
  if (!force && state.account) {
    return state.account;
  }
  const user = canonicalUser(await request("/auth/me", {}, "identity"));
  try {
    const service = await request("/apps/psm/me", {}, "cloud");
    state.account = accountView(user, service);
  } catch (err) {
    const typed = err as Error;
    state.account = accountView(user, null, typed.message);
  }
  return state.account;
}

export async function logout(): Promise<void> {
  try {
    if (state.cloudTokens?.accessToken) {
      await request("/apps/psm/auth/logout", { method: "POST" }, "cloud").catch(() => {});
    }
    if (state.identityTokens?.accessToken) {
      await request("/auth/logout", { method: "POST" }, "identity").catch(() => {});
    }
  } finally {
    state.identityTokens = null;
    state.identityExpiresAt = 0;
    state.identityApiUrl = null;
    state.cloudTokens = null;
    state.cloudExpiresAt = 0;
    state.cloudApiUrl = null;
    state.account = null;
    forgetSessions();
  }
}

export async function cloudRequest(pathname: string, init: RequestInit = {}): Promise<any> {
  return request(`/apps/psm${pathname}`, init, "cloud");
}

export async function checkout(interval: "month" | "year"): Promise<string> {
  const data = await cloudRequest("/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ interval }),
  });
  return data.url;
}

export async function billingPortal(): Promise<string> {
  const data = await cloudRequest("/billing/portal", { method: "POST", body: "{}" });
  return data.url;
}

export async function devices(): Promise<any[]> {
  return (await cloudRequest("/devices")).devices || [];
}

export async function revokeDevice(id: string): Promise<any> {
  return cloudRequest(`/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function syncRevision(): number {
  return state.syncRevision;
}

export async function pullSync(): Promise<any> {
  const data = await cloudRequest("/sync");
  state.syncRevision = Number(data.revision) || 0;
  return data;
}

export async function pushSync(value: unknown, revision = state.syncRevision): Promise<any> {
  const data = await cloudRequest("/sync", {
    method: "PATCH",
    body: JSON.stringify({ revision, state: value }),
  });
  state.syncRevision = Number(data.revision) || revision + 1;
  return data;
}

export function cloudAvailable(): boolean {
  return !!state.identityTokens?.accessToken || !!readStoredSessions()?.identityRefreshToken;
}
