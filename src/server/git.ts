/**
 * What a repository looks like right now: its branch, and what has changed in it.
 *
 * Read-only, and deliberately so. psm shows you the state of a checkout so you
 * can decide what to do about it; committing, switching branches and pushing
 * stay in your hands, or in the AI's, where they are already visible in a
 * transcript. Nothing here writes.
 *
 * This exists for workrooms most of all. One conversation editing three
 * repositories leaves its work spread across three `git status` calls that
 * nobody runs, and the failure that follows — one side committed, the other
 * forgotten on a branch nobody looked at — is exactly what a room is supposed to
 * prevent. Seeing all of them at once is the point.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { childEnv } from "./procs.ts";

const run = promisify(execFile);

/** A cap on the file list. A repo with 5,000 changed files is telling you enough. */
const MAX_FILES = 300;
const MAX_BRANCHES = 40;
const TIMEOUT_MS = 10_000;

export interface RepoChange {
  /** Two-letter porcelain code, e.g. " M", "A ", "??". */
  code: string;
  path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface RepoBranch {
  name: string;
  current: boolean;
  when: string;
}

export interface RepoStatus {
  project: string;
  path: string;
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  clean: boolean;
  truncated: boolean;
  changes: RepoChange[];
  branches: RepoBranch[];
  lastCommit: { hash: string; subject: string; when: string } | null;
  error: string | null;
}

function empty(project: string, dir: string): RepoStatus {
  return {
    project,
    path: dir,
    isRepo: false,
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    clean: true,
    truncated: false,
    changes: [],
    branches: [],
    lastCommit: null,
    error: null,
  };
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", dir, ...args], {
    env: childEnv(),
    timeout: TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Parse `--porcelain=v2 --branch`.
 *
 * v2 rather than v1 because the header lines carry the branch, its upstream and
 * the ahead/behind counts, which v1 leaves to be worked out with two more calls
 * — and because its fields are positional and stable, where v1's are a format
 * that has changed shape before.
 */
function parseStatus(out: string, status: RepoStatus): void {
  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      status.detached = head === "(detached)";
      status.branch = status.detached ? null : head;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      status.upstream = line.slice("# branch.upstream ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const [ahead, behind] = line.slice("# branch.ab ".length).trim().split(" ");
      status.ahead = Math.abs(Number(ahead)) || 0;
      status.behind = Math.abs(Number(behind)) || 0;
      continue;
    }
    if (line.startsWith("#")) continue;

    const kind = line[0];
    let code = "??";
    let file = "";
    if (kind === "1" || kind === "2") {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      // 2 adds <X><score> and a tab-separated original path for renames
      const fields = line.split(" ");
      code = fields[1] ?? "??";
      file = kind === "1" ? fields.slice(8).join(" ") : (fields.slice(9).join(" ").split("\t")[0] ?? "");
    } else if (kind === "u") {
      code = "UU";
      file = line.split(" ").slice(10).join(" ");
    } else if (kind === "?") {
      code = "??";
      file = line.slice(2);
    } else {
      continue;
    }

    const untracked = code === "??";
    const staged = !untracked && code[0] !== "." && code[0] !== " ";
    const unstaged = !untracked && code[1] !== "." && code[1] !== " ";
    if (untracked) status.untracked++;
    else {
      if (staged) status.staged++;
      if (unstaged) status.unstaged++;
    }
    if (status.changes.length < MAX_FILES) {
      status.changes.push({ code: code.replace(/\./g, " "), path: file, staged, unstaged, untracked });
    } else {
      status.truncated = true;
    }
  }
  status.clean = !status.staged && !status.unstaged && !status.untracked;
}

/**
 * One repository's state. Never throws: a folder that is not a checkout, or a
 * git that is not installed, is part of what the pane has to show — a pane that
 * disappears because one of three repositories is odd is worse than one that
 * says so.
 */
export async function repoStatus(project: string, dir: string): Promise<RepoStatus> {
  const status = empty(project, dir);
  try {
    await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    status.isRepo = true;
  } catch (err) {
    status.error = /not a git repository/i.test(String(err)) ? null : (err as Error).message;
    return status;
  }

  const [statusOut, branchOut, commitOut] = await Promise.all([
    git(dir, ["status", "--porcelain=v2", "--branch"]).catch((err) => {
      status.error = (err as Error).message;
      return "";
    }),
    git(dir, ["branch", "--sort=-committerdate", "--format=%(refname:short)%09%(HEAD)%09%(committerdate:relative)"])
      .catch(() => ""),
    // An empty repository has no HEAD, which is not an error worth showing.
    git(dir, ["log", "-1", "--format=%h%x09%s%x09%cr"]).catch(() => ""),
  ]);

  parseStatus(statusOut, status);

  status.branches = branchOut
    .split("\n")
    .filter(Boolean)
    .slice(0, MAX_BRANCHES)
    .map((line) => {
      const [name, head, when] = line.split("\t");
      return { name: (name ?? "").trim(), current: head === "*", when: (when ?? "").trim() };
    })
    .filter((branch) => branch.name);

  const commit = commitOut.trim().split("\t");
  if (commit[0]) status.lastCommit = { hash: commit[0], subject: commit[1] ?? "", when: commit[2] ?? "" };

  return status;
}

/** Several repositories at once, in the order given — a workroom's members. */
export function repoStatuses(repos: { project: string; path: string }[]): Promise<RepoStatus[]> {
  return Promise.all(repos.map((repo) => repoStatus(repo.project, repo.path)));
}
