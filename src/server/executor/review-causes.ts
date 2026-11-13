/**
 * Why a reviewed job went back: the cause tag on Reject and Revise.
 *
 * A rejection fixes one job. The tag says whether the next job is likely to
 * make the same mistake:
 *
 *   one-off  the agent got this one wrong; nothing to change in the project.
 *   project  something in the project made the mistake easy (a misleading
 *            example, a missing fixture, an unreliable setup), with a note
 *            saying what.
 *
 * Kept per project so the review screen can show the earlier "project" causes
 * next to the one being written: a repeat is the signal to fix the project.
 *
 * Local only, like the activity history: it quotes task text, so it lives in
 * psm's state directory (0600) and is served only on the local router.
 */
import fs from "node:fs";

export type ReviewCause = "one-off" | "project";

export interface ReviewCauseRecord {
  at: number;
  jobId: string;
  projectId: string;
  action: "reject" | "revise";
  cause: ReviewCause;
  /** What in the project made it easy. Empty for a one-off. */
  note: string;
  /** The task as written, cut short, so a record reads on its own. */
  task: string;
}

const KEEP = 500;
const MAX_NOTE = 500;
const MAX_TASK = 200;

/**
 * Reads `{ cause, causeNote }` from a review request. A "project" cause needs
 * a note; on Revise the comment stands in when none is given.
 */
export function parseReviewCause(body: unknown, comment = ""): { cause: ReviewCause; note: string } | { error: string } {
  const input = (body ?? {}) as { cause?: unknown; causeNote?: unknown };
  if (input.cause !== "one-off" && input.cause !== "project") return { error: "Say why it is going back: a one-off mistake, or something in the project that made it easy." };
  if (input.cause === "one-off") return { cause: "one-off", note: "" };
  const note = (typeof input.causeNote === "string" ? input.causeNote.trim() : "") || comment.trim();
  if (!note) return { error: "Say what in the project made this mistake easy." };
  return { cause: "project", note: note.slice(0, MAX_NOTE) };
}

/** For the timeline: "one-off" or "project cause: <note>". */
export const causeLabel = (cause: ReviewCause, note: string) => (cause === "project" ? `project cause: ${note}` : "one-off");

export class ReviewCauses {
  #records: ReviewCauseRecord[] = [];

  constructor(private readonly file: string | null = null, private readonly now: () => number = Date.now) {
    if (!file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(saved)) this.#records = saved.filter((record) => record && typeof record.jobId === "string" && typeof record.projectId === "string").slice(0, KEEP);
    } catch {
      /* nothing saved yet */
    }
  }

  record(input: Omit<ReviewCauseRecord, "at" | "task"> & { task: string }): ReviewCauseRecord {
    const record: ReviewCauseRecord = { ...input, at: this.now(), task: input.task.length > MAX_TASK ? `${input.task.slice(0, MAX_TASK)}…` : input.task };
    this.#records = [record, ...this.#records].slice(0, KEEP);
    if (this.file) {
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.#records), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    }
    return record;
  }

  /** A project's "project" causes, newest first: what to check for a repeat. */
  projectCauses(projectId: string): ReviewCauseRecord[] {
    return this.#records.filter((record) => record.projectId === projectId && record.cause === "project");
  }
}
