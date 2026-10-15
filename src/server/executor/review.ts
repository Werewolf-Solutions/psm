/**
 * Reviewing an implement job, here on the machine that holds its branch.
 *
 *   diff    what the job changed: its commits and `git diff base..branch`,
 *           read from the job's clone.
 *   accept  bring `psm/job/<id>` into your real checkout and merge it into
 *           whatever branch is checked out (`--no-ff`, so it reads as one
 *           change). If the merge would overwrite your uncommitted changes or
 *           conflicts, it is aborted, your checkout is left as it was, and the
 *           branch stays in your repo for you to merge by hand.
 *   discard remove the job's clone (after accept or reject).
 *
 * The merge runs as you, with your Git config and hooks: it is your click.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { branchFor, jobGit } from "./implement-job.ts";

const MAX_DIFF = 400 * 1024;

export interface JobDiff {
  branch: string;
  base: string;
  head: string;
  commits: { sha: string; subject: string }[];
  diff: string;
  truncated: boolean;
}

export function readJobDiff(clone: string, jobId: string): JobDiff | null {
  if (!fs.existsSync(clone)) return null;
  const base = fs.readFileSync(`${clone}/.git/psm-job-base`, "utf8").trim();
  const head = jobGit(clone, ["rev-parse", branchFor(jobId)]).trim();
  const log = jobGit(clone, ["log", "--format=%H%x09%s", `${base}..${head}`]).trim();
  const full = jobGit(clone, ["diff", "--no-ext-diff", "--no-textconv", "--stat", "--patch", `${base}..${head}`], { maxBuffer: 64 * 1024 * 1024 });
  return {
    branch: branchFor(jobId),
    base,
    head,
    commits: log ? log.split("\n").reverse().map((line) => ({ sha: line.split("\t")[0], subject: line.split("\t").slice(1).join("\t") })) : [],
    diff: full.length > MAX_DIFF ? full.slice(0, MAX_DIFF) : full,
    truncated: full.length > MAX_DIFF,
  };
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }).trim() };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    return { ok: false, out: `${e.stdout || ""}\n${e.stderr || e.message}`.trim() };
  }
}

export type AcceptOutcome =
  | { ok: true; into: string; mergeCommit: string }
  | { ok: false; reason: string; branchKept: boolean };

/** Fetch the job's branch into your checkout and merge it into the current branch. */
export function acceptJob(realPath: string, clone: string, jobId: string, message: string): AcceptOutcome {
  const branch = branchFor(jobId);
  const current = git(realPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!current.ok) return { ok: false, reason: "Your checkout is on a detached HEAD; check out the branch to merge into, then accept again.", branchKept: false };
  if (fs.existsSync(`${realPath}/.git/MERGE_HEAD`)) return { ok: false, reason: "Your checkout is in the middle of another merge. Finish or abort it first.", branchKept: false };

  const fetched = git(realPath, ["fetch", "--quiet", "--no-tags", clone, `+${branch}:${branch}`]);
  if (!fetched.ok) return { ok: false, reason: `Could not bring ${branch} into your repo: ${fetched.out.split("\n").pop()}`, branchKept: false };

  const merged = git(realPath, ["merge", "--no-ff", "--no-edit", "-m", message, branch]);
  if (!merged.ok) {
    const conflicted = fs.existsSync(`${realPath}/.git/MERGE_HEAD`);
    if (conflicted) git(realPath, ["merge", "--abort"]);
    const why = /would be overwritten/.test(merged.out)
      ? "your uncommitted changes touch the same files"
      : conflicted
        ? "it conflicts with what is on your branch"
        : merged.out.split("\n").filter(Boolean).pop() || "git refused";
    return { ok: false, reason: `Not merged: ${why}. Your checkout is unchanged, and ${branch} is in your repo to merge by hand.`, branchKept: true };
  }
  return { ok: true, into: current.out, mergeCommit: git(realPath, ["rev-parse", "HEAD"]).out };
}

export function discardClone(clone: string): void {
  fs.rmSync(clone, { recursive: true, force: true });
}
