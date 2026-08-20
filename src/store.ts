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
import { randomUUID } from "node:crypto";
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
 * Replace a state file in one step.
 *
 * Everything psm keeps is written whole and read whole, which makes a plain
 * `writeFileSync` a real hazard: the file is truncated first, so a crash — or
 * two writes racing — leaves a reader half a document, and JSON half a document
 * is JSON that does not parse. Write a sibling temp file and rename it instead;
 * rename is atomic within a filesystem, so a reader sees the old file or the new
 * one and never the gap between them.
 *
 * `mode` defaults to whatever the file already carries, falling back to `0600`
 * for one that does not exist yet. Pass it explicitly for a file that must be
 * private no matter what mode it picked up along the way.
 */
export function writeFileAtomic(file: string, contents: string, mode?: number): void {
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  let fileMode = mode ?? 0o600;
  if (mode === undefined) {
    try {
      fileMode = fs.statSync(file).mode & 0o777;
    } catch {
      /* no file yet — 0600 it is */
    }
  }
  try {
    fs.writeFileSync(temp, contents, { mode: fileMode });
    fs.renameSync(temp, file);
  } catch (err) {
    // A failed write must not leave its scratch file behind for the next one to
    // trip over; the caller still hears about the failure.
    try {
      fs.unlinkSync(temp);
    } catch {
      /* never existed */
    }
    throw err;
  }
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
