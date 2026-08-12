/**
 * Where psm's own state lives, and whose it is.
 *
 * Locally there is one owner — the person at the keyboard — so state sits in
 * files next to the repo, exactly where it always has. Hosted, the same files
 * would be a cross-account data leak: `overrides.json` is one flat object keyed
 * by project name, so two accounts with a project called `api` would overwrite
 * each other.
 *
 * So hosted mode resolves every state path inside a per-user directory, and the
 * user id comes from the request's verified session, carried through the call
 * stack by AsyncLocalStorage. Code that reads state does not need to know which
 * posture it is in — it asks for a path and gets the right one.
 *
 * This is deliberately files-on-disk rather than a database: it keeps the local
 * tool dependency-free and the hosted deployment stateless-except-for-a-volume.
 * When hosted psm grows past that, this module is the seam to replace.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { isMultiTenant } from "./mode.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PSM_ROOT = path.resolve(__dirname, "..");

/** The single owner of a local install. Never appears in a hosted path. */
export const LOCAL_USER = "local";

const context = new AsyncLocalStorage<{ userId: string; accessToken: string | null }>();

/**
 * Run `fn` with every state lookup inside it scoped to this user, carrying the
 * Werewolf access token for the same session.
 *
 * The token rides along because psm's cloud features (sync, backups, devices,
 * billing) are calls to dapp *on behalf of the signed-in user* — they used to
 * keep a second session of their own, with its own login, refresh and keyring.
 * One session, resolved once per request, is both simpler and impossible to get
 * out of step with itself.
 */
export function runAsUser<T>(userId: string, fn: () => T, accessToken: string | null = null): T {
  return context.run({ userId: userId || LOCAL_USER, accessToken }, fn);
}

export function currentUser(): string {
  return context.getStore()?.userId || LOCAL_USER;
}

/** The signed-in user's Werewolf access token, or null when signed out. */
export function currentAccessToken(): string | null {
  return context.getStore()?.accessToken || null;
}

/**
 * A filesystem-safe directory name for an account. Ids from an identity provider
 * can be anything (emails, URLs, uuids), so hash rather than sanitise — a
 * one-way name cannot collide and cannot traverse.
 */
function userSlug(userId: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(userId)) return userId;
  return "u_" + createHash("sha256").update(userId).digest("hex").slice(0, 32);
}

/** The root psm writes under. Not account-scoped — see `sharedStateDir`. */
function dataRoot(): string {
  return process.env.PSM_DATA_DIR || path.join(PSM_ROOT, ".psm-data");
}

/** The directory holding this request's state. */
export function stateDir(): string {
  if (!isMultiTenant()) return PSM_ROOT;
  const dir = path.join(dataRoot(), "users", userSlug(currentUser()));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * State that cannot be account-scoped because it is what *establishes* the
 * account: the session store maps a cookie to a user, so looking it up already
 * requires knowing the user it is about to tell you.
 */
export function sharedStateDir(name: string): string {
  const dir = isMultiTenant() ? path.join(dataRoot(), name) : path.join(PSM_ROOT, `.psm-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve one state file. `name` is a fixed literal from psm's own code — never
 * user input — but it is still checked, because a traversal here would cross an
 * account boundary in hosted mode.
 */
export function statePath(name: string): string {
  if (name.includes("..") || path.isAbsolute(name)) throw new Error(`unsafe state path: ${name}`);
  return path.join(stateDir(), name);
}
