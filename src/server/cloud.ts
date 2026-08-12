/**
 * PSM Cloud — sync, encrypted backups, devices and billing, all served by
 * werewolf-dapp under `/apps/psm/*`.
 *
 * This file used to own a second sign-in of its own: an identity session
 * (`/auth/login`), a cloud session (`/apps/psm/auth/login`), refresh for both,
 * and an OS-keyring credential store. That was one login too many — psm now has
 * exactly one way in ("Continue with Werewolf", server/sso.ts), and the access
 * token it produces is already psm-audience, which is precisely what these
 * endpoints want.
 *
 * So there is no authentication here any more. Every call borrows the current
 * request's token from the async context (src/store.ts). Signed out, the cloud
 * surfaces say so instead of offering a second front door.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { currentAccessToken } from "../store.ts";
import { currentWerewolfRuntime, werewolfApiUrl } from "./runtime.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DEVICE_FILE = process.env.PSM_CLOUD_DEVICE_FILE || path.join(ROOT, ".psm-cloud-device.json");

/** Sync revision is the only thing worth keeping between calls. */
const state = { syncRevision: 0 };

function atomicJson(file: string, value: unknown, mode = 0o600): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode });
  fs.renameSync(temp, file);
  fs.chmodSync(file, mode);
}

/**
 * A stable identity for this installation, so dapp can list and revoke it in
 * Devices. Also reused as the agent's id (server/agent.ts).
 */
export function deviceIdentity(): { id: string; name: string; platform: string } {
  try {
    const parsed = JSON.parse(fs.readFileSync(DEVICE_FILE, "utf8"));
    if (parsed?.id) return parsed;
  } catch {
    /* mint one below */
  }
  const device = {
    id: crypto.randomUUID(),
    name: os.hostname(),
    platform: `${os.platform()} ${os.arch()}`,
  };
  atomicJson(DEVICE_FILE, device);
  return device;
}

function unauthenticated(): Error & { status?: number; code?: string } {
  const error = new Error("Sign in with Werewolf to use PSM Cloud") as Error & {
    status?: number;
    code?: string;
  };
  error.status = 401;
  error.code = "unauthenticated";
  return error;
}

/**
 * One call to dapp on behalf of the signed-in user. Refresh is not handled here:
 * server/session.ts renews the token before the request reaches this point, so a
 * 401 here means the session is genuinely gone rather than merely stale.
 */
export async function cloudRequest(pathname: string, init: RequestInit = {}): Promise<any> {
  const accessToken = currentAccessToken();
  if (!accessToken) throw unauthenticated();

  const apiUrl = await werewolfApiUrl();
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${accessToken}`);

  const response = await fetch(`${apiUrl}/apps/psm${pathname}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const error = new Error(
      body.message || `Werewolf API request failed (${response.status})`,
    ) as Error & { status?: number; code?: string; data?: unknown };
    error.status = response.status;
    error.code = body.code;
    error.data = body.data;
    throw error;
  }
  return body.data ?? body;
}

/** Is there a session to make cloud calls with? */
export function cloudAvailable(): boolean {
  return !!currentAccessToken();
}

export async function account(_force = false): Promise<any> {
  const runtime = currentWerewolfRuntime();
  const service = await cloudRequest("/me");
  return {
    ...service,
    cloudReady: true,
    apiUrl: runtime.activeUrl,
    apiSource: runtime.source,
  };
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

export async function projectTodos(project: string): Promise<any> {
  return cloudRequest(`/todos?project=${encodeURIComponent(project)}`);
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
