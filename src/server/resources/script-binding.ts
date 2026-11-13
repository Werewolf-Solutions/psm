/**
 * P02a.4 — bind a Data Apply to exactly what was previewed.
 *
 * Preview runs the script (`node <script>` with the project's environment and
 * database credentials), so it is code execution, not a read. Two rules follow:
 *
 * - **Apply runs what was previewed.** Preview records a digest of the script
 *   file, its package lockfile and the target; Apply refuses if any of them
 *   changed since (`preview-stale`).
 * - **A Read target previews committed code only.** On a database at Read,
 *   Preview refuses a script with uncommitted changes, or one git does not
 *   track: anyone who can edit the file could otherwise write to a Read
 *   database through Preview.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { DbScript } from "./scripts.ts";

const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];

/** The lockfile that decides the script's dependencies: its package's, else the project root's. */
function lockfile(projectPath: string, directory: string): string | null {
  for (const dir of [path.join(projectPath, directory), projectPath]) {
    for (const name of LOCKFILES) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

/** sha256 over the script's bytes, its lockfile's bytes and the target key. */
export function scriptDigest(projectPath: string, script: Pick<DbScript, "path" | "directory">, targetKey: string): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(path.join(projectPath, script.path)));
  hash.update("\0lock\0");
  const lock = lockfile(projectPath, script.directory);
  if (lock) hash.update(fs.readFileSync(lock));
  hash.update(`\0target\0${targetKey}`);
  return "sha256:" + hash.digest("hex");
}

export type GitState = "committed" | "modified" | "untracked" | "no-git";

const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });

/** Is the script, as it is on disk, what the repository has committed? */
export function scriptGitState(projectPath: string, relative: string): GitState {
  try {
    if (git(projectPath, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return "no-git";
  } catch {
    return "no-git";
  }
  try {
    git(projectPath, ["ls-files", "--error-unmatch", "--", relative]);
  } catch {
    return "untracked";
  }
  try {
    return git(projectPath, ["status", "--porcelain", "--", relative]).trim() ? "modified" : "committed";
  } catch {
    return "modified"; // cannot tell: fail closed
  }
}

export const GIT_STATE_TEXT: Record<Exclude<GitState, "committed">, string> = {
  modified: "has uncommitted changes",
  untracked: "is not committed to git",
  "no-git": "is not in a git repository",
};
