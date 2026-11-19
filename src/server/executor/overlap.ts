/**
 * Which implement jobs may run side by side in one repository.
 *
 * Each job has a scope: the files and folders it is expected to change. Triage
 * predicts it (`touches`), and a job that has produced a branch knows it for
 * certain (its changed files). Two jobs on the same project overlap when any
 * path of one equals, or lies inside, a path of the other. A job whose scope is
 * unknown overlaps everything on its project, which is the old one-at-a-time
 * repo lock.
 *
 * A queued job waits for every overlapping job that is running, in review, or
 * queued ahead of it, so work on the same files lands one after another, each
 * starting from the code the previous one merged.
 */

export const SCOPE_MAX = 20;
const PATH_MAX = 200;

/** A scope as stored: repo-relative paths, a folder ending in `/`. `null` is "could be anything". */
export type Scope = string[] | null;

/** Clean entries, any number of them; null when one names the whole repo or leaves it. */
function cleanEntries(value: unknown): Set<string> | null {
  if (!Array.isArray(value) || !value.length) return null;
  const out = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") return null;
    let entry = raw.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
    if (!entry || entry === "." || entry === "*" || entry === "**") return null;
    if (entry.length > PATH_MAX || entry.split("/").some((part) => part === "..")) return null;
    // A glob is as wide as the folder it starts in.
    const glob = entry.search(/[*?[{]/);
    if (glob >= 0) {
      const folder = entry.slice(0, glob).replace(/[^/]*$/, "");
      if (!folder) return null;
      entry = folder;
    }
    out.add(entry);
  }
  return out;
}

/**
 * Clean a predicted scope. Anything that names the whole repo, or leaves it,
 * makes the scope unknown rather than guessed, and so does a prediction of more
 * than SCOPE_MAX paths: one that wide is not a prediction.
 */
export function normalizeScope(value: unknown): Scope {
  const out = cleanEntries(value);
  if (!out || out.size > SCOPE_MAX) return null;
  return [...out].sort();
}

const depth = (entry: string) => entry.replace(/\/$/, "").split("/").length;
const parentFolder = (entry: string) => entry.replace(/\/$/, "").replace(/[^/]*$/, "");

/**
 * Clean a list that is known to be complete, such as the files a branch really
 * changed, keeping it at most SCOPE_MAX long by widening it rather than
 * dropping it: the deepest entries give way to their folders until it fits, so
 * the result still covers every file. Unknown only when even that cannot fit
 * (too many files at the top of the repo) or an entry is not a repo path.
 */
export function widenScope(value: unknown): Scope {
  const out = cleanEntries(value);
  if (!out) return null;
  let entries = [...out];
  for (;;) {
    // Nothing inside a folder that is already listed.
    entries = entries.filter((entry) => !entries.some((other) => other !== entry && other.endsWith("/") && inside(entry, other)));
    if (entries.length <= SCOPE_MAX) return entries.sort();
    const deepest = Math.max(...entries.map(depth));
    if (deepest <= 1) return null;
    entries = [...new Set(entries.map((entry) => (depth(entry) === deepest ? parentFolder(entry) : entry)))];
  }
}

const inside = (path: string, folder: string) => {
  const base = folder.endsWith("/") ? folder : `${folder}/`;
  return path === folder.replace(/\/$/, "") || path.startsWith(base);
};

/** The paths two scopes share, or null when they do not overlap. An unknown scope overlaps everything. */
export function overlap(a: Scope, b: Scope): string[] | null {
  if (a === null || b === null) return ["the whole project (scope unknown)"];
  const shared = new Set<string>();
  for (const x of a) for (const y of b) {
    if (x === y || inside(x, y)) shared.add(x);
    else if (inside(y, x)) shared.add(y);
  }
  return shared.size ? [...shared].sort() : null;
}

/** Both scopes together, widened to fit (each is already a scope); unknown wins. */
export function unionScope(a: Scope, b: Scope): Scope {
  if (a === null || b === null) return null;
  return widenScope([...a, ...b]);
}

export interface ScheduledJob {
  jobId: string;
  projectId: string;
  status: string;
  /** Ordering for "ahead of it" among queued jobs; `seq` breaks ties within a millisecond. */
  createdAt: number;
  seq?: number;
  scope: Scope;
}

export interface Blocker {
  jobId: string;
  status: string;
  paths: string[];
}

const HOLDS = new Set(["claimed", "review"]);

/**
 * What a queued job waits for: overlapping jobs on its project that are
 * running or in review, or queued ahead of it.
 */
export function blockersFor(job: ScheduledJob, others: ScheduledJob[]): Blocker[] {
  const blockers: Blocker[] = [];
  for (const other of others) {
    if (other.jobId === job.jobId || other.projectId !== job.projectId) continue;
    const ahead = other.status === "queued" && (other.createdAt < job.createdAt || (other.createdAt === job.createdAt && (other.seq ?? 0) < (job.seq ?? 0)));
    if (!HOLDS.has(other.status) && !ahead) continue;
    const paths = overlap(job.scope, other.scope);
    if (paths) blockers.push({ jobId: other.jobId, status: other.status, paths });
  }
  return blockers;
}

/**
 * After a job has produced its branch: the jobs already in review that its real
 * changes collide with. The first to finish keeps its place; the second goes
 * back to the queue. A running job is checked when it finishes, and a queued
 * one waits for this one.
 */
export function collisionsAfter(job: ScheduledJob, others: ScheduledJob[]): Blocker[] {
  return blockersFor({ ...job, createdAt: -Infinity }, others.filter((other) => other.status === "review"));
}

export interface MergedJob {
  jobId: string;
  projectId: string;
  /** When its Accept merged it. */
  acceptedAt: number;
  scope: Scope;
}

/**
 * After a job has produced its branch: the jobs merged since its code was
 * taken (`basedAt`, when its clone was made) that change the same files. Its
 * branch is older than that merged code, so Accept may conflict, and even a
 * clean merge has not been tested together. collisionsAfter cannot see these:
 * they are no longer in review. Unknown when psm does not know `basedAt`.
 */
export function mergedSince(job: Pick<ScheduledJob, "jobId" | "projectId" | "scope">, basedAt: number | null, merged: MergedJob[]): Blocker[] {
  if (basedAt == null) return [];
  const found: Blocker[] = [];
  for (const other of merged) {
    if (other.jobId === job.jobId || other.projectId !== job.projectId || other.acceptedAt < basedAt) continue;
    const paths = overlap(job.scope, other.scope);
    if (paths) found.push({ jobId: other.jobId, status: "accepted", paths });
  }
  return found;
}
