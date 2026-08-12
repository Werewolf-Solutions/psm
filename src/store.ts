/**
 * Where psm's state lives, and the Werewolf token the current request may use.
 *
 * There is one owner: the person at the keyboard. psm runs on their machine and
 * shells out on their behalf, so there is nothing to partition — state sits in
 * files next to the repo, exactly where it always has.
 *
 * This module used to resolve per-account directories for a hosted, multi-tenant
 * psm. That posture is gone (see src/mode.ts). What survives is the seam: every
 * state path still goes through `statePath()` rather than being inlined at forty
 * call sites, and the async context still carries the access token so
 * `server/cloud.ts` can make calls on the signed-in user's behalf without keeping
 * a second session of its own.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PSM_ROOT = path.resolve(__dirname, "..");

const context = new AsyncLocalStorage<{ accessToken: string | null }>();

/**
 * Run `fn` with the signed-in user's Werewolf access token available to anything
 * it calls. psm's cloud features (sync, backups, devices, billing) are calls to
 * dapp *on behalf of* that session; they used to keep a second session with its
 * own login, refresh and keyring.
 */
export function runWithSession<T>(accessToken: string | null, fn: () => T): T {
  return context.run({ accessToken }, fn);
}

/** The signed-in user's Werewolf access token, or null when signed out. */
export function currentAccessToken(): string | null {
  return context.getStore()?.accessToken || null;
}

/** The directory psm keeps its state in. */
export function stateDir(): string {
  return PSM_ROOT;
}

/**
 * State that is not tied to a single project — the session store, for one.
 * Kept as a distinct call so the two kinds stay visibly different.
 */
export function sharedStateDir(name: string): string {
  const dir = path.join(PSM_ROOT, `.psm-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve one state file. `name` is a fixed literal from psm's own code — never
 * user input — but it is still checked, because a traversal here would write
 * outside the repo.
 */
export function statePath(name: string): string {
  if (name.includes("..") || path.isAbsolute(name)) throw new Error(`unsafe state path: ${name}`);
  return path.join(stateDir(), name);
}
