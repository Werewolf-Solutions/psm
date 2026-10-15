/**
 * What the executor did, job by job, so the cockpit can show it.
 *
 * A triage job is not a chat: it is one prompt to a tool-less Claude call and
 * one answer. This keeps that whole exchange — the note claimed from the hub,
 * the prompt psm built (project context + note), Claude's raw reply with what
 * it cost, the verdict, and what went back to the hub — as a timeline per job.
 *
 * Local only: it holds project context and note text, so it lives in psm's
 * state directory (0600) and is served only on the local router. The last
 * KEEP jobs are kept, across restarts.
 */
import fs from "node:fs";

import type { EngineMeta } from "../triage/run.ts";
import type { Verdict } from "../triage/verdict.ts";
import type { ExecutorJob, JobOutcome } from "./client.ts";
import type { JobStep } from "./triage-job.ts";

export type ActivityState =
  | "claimed"
  | "building-context"
  | "asking-claude"
  | "checking-answer"
  | "posting"
  | "triaged"
  | "failed"
  | "abandoned";

export interface ActivityEvent {
  at: number;
  label: string;
}

export interface ActivityEntry {
  jobId: string;
  intakeId: string;
  projectId: string;
  projectName: string;
  /** The note as written in Todo. */
  text: string;
  attempt: number;
  claimedAt: number;
  finishedAt: number | null;
  state: ActivityState;
  context: { bytes: number; truncated: boolean; openIntake: number } | null;
  systemPrompt: string | null;
  prompt: string | null;
  answer: string | null;
  meta: EngineMeta | null;
  cached: boolean;
  verdict: Verdict | null;
  error: string | null;
  timeline: ActivityEvent[];
}

const KEEP = 50;
const MAX_PROMPT = 96 * 1024;
const MAX_ANSWER = 32 * 1024;

const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…[cut at ${max} characters]` : text);

export class ExecutorActivity {
  #entries: ActivityEntry[] = [];
  #revision = 0;
  #saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string | null = null, private readonly now: () => number = Date.now) {
    if (!file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(saved)) {
        // A job that was mid-flight when psm stopped did not finish here; its
        // lease expires and the hub hands it out again.
        this.#entries = saved.slice(0, KEEP).map((entry: ActivityEntry) =>
          entry.finishedAt
            ? entry
            : {
                ...entry,
                state: "abandoned",
                finishedAt: entry.claimedAt,
                error: entry.error ?? "psm stopped before this job finished",
                timeline: [...(entry.timeline ?? []), { at: this.now(), label: "psm stopped before this job finished. The hub will hand it out again." }],
              },
        );
      }
    } catch {
      /* nothing saved yet */
    }
  }

  get revision(): number {
    return this.#revision;
  }

  #find(jobId: string): ActivityEntry | undefined {
    return this.#entries.find((entry) => entry.jobId === jobId);
  }

  #touch(entry: ActivityEntry, label: string, state?: ActivityState): void {
    entry.timeline.push({ at: this.now(), label });
    if (state) entry.state = state;
    this.#revision++;
    this.#save();
  }

  #save(): void {
    if (!this.file || this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      try {
        const temp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(this.#entries), { mode: 0o600 });
        fs.renameSync(temp, this.file!);
      } catch {
        /* history is a convenience; losing it changes nothing */
      }
    }, 250);
    this.#saveTimer.unref?.();
  }

  claimed(job: ExecutorJob): void {
    const entry: ActivityEntry = {
      jobId: job.jobId,
      intakeId: job.intakeId,
      projectId: job.projectId,
      projectName: job.projectName,
      text: job.text,
      attempt: job.attempt,
      claimedAt: this.now(),
      finishedAt: null,
      state: "claimed",
      context: null,
      systemPrompt: null,
      prompt: null,
      answer: null,
      meta: null,
      cached: false,
      verdict: null,
      error: null,
      timeline: [],
    };
    this.#entries = [entry, ...this.#entries.filter((other) => other.jobId !== job.jobId)].slice(0, KEEP);
    this.#touch(entry, `Claimed from the hub${job.attempt > 1 ? ` (attempt ${job.attempt})` : ""}`, "building-context");
  }

  step(job: ExecutorJob, step: JobStep): void {
    const entry = this.#find(job.jobId);
    if (!entry) return;
    switch (step.type) {
      case "context":
        entry.context = { bytes: step.bytes, truncated: step.truncated, openIntake: step.openIntake };
        this.#touch(entry, `Built context for ${step.project}: ${Math.round(step.bytes / 1024)} KB${step.truncated ? " (trimmed)" : ""}, ${step.openIntake} other open note${step.openIntake === 1 ? "" : "s"}`);
        break;
      case "cached":
        entry.cached = true;
        entry.verdict = step.verdict;
        this.#touch(entry, "Same note and context as before: reused the earlier verdict, no Claude call", "posting");
        break;
      case "prompt":
        entry.systemPrompt = step.systemPrompt;
        entry.prompt = cap(step.prompt, MAX_PROMPT);
        this.#touch(entry, "Asked Claude (one call, no tools)", "asking-claude");
        break;
      case "answer": {
        entry.answer = cap(step.text, MAX_ANSWER);
        entry.meta = step.meta;
        const cost = step.meta?.costUsd != null ? ` · $${step.meta.costUsd.toFixed(4)}` : "";
        const took = step.meta?.durationMs != null ? ` in ${(step.meta.durationMs / 1000).toFixed(1)} s` : "";
        this.#touch(entry, `Claude answered${took}${cost}`, "checking-answer");
        break;
      }
      case "engine-error":
        entry.error = step.error;
        this.#touch(entry, `Claude call failed: ${step.error}`);
        break;
      case "invalid":
        entry.error = step.error;
        this.#touch(entry, `The answer was not a valid verdict: ${step.error}`);
        break;
    }
  }

  /** The run returned; the loop is about to post this outcome. */
  finishing(jobId: string, outcome: JobOutcome): void {
    const entry = this.#find(jobId);
    if (!entry) return;
    if (outcome.status === "triaged") entry.verdict = outcome.verdict;
    else entry.error = outcome.error;
    this.#touch(entry, outcome.status === "triaged" ? `Verdict: ${outcome.verdict.verdict.replace("_", " ")}, size ${outcome.verdict.size}` : `Failed: ${outcome.error}`, "posting");
  }

  posted(jobId: string, outcome: JobOutcome): void {
    const entry = this.#find(jobId);
    if (!entry) return;
    entry.finishedAt = this.now();
    this.#touch(entry, outcome.status === "triaged" ? "Posted the verdict to the hub — Todo shows it now" : "Reported the failure to the hub", outcome.status === "triaged" ? "triaged" : "failed");
  }

  abandoned(jobId: string, reason: string): void {
    const entry = this.#find(jobId);
    if (!entry) return;
    entry.finishedAt = this.now();
    entry.error = entry.error ?? reason;
    this.#touch(entry, `Stopped without posting: ${reason}. The hub will hand it out again.`, "abandoned");
  }

  /** Newest first, without the large fields. */
  list() {
    return this.#entries.map(({ systemPrompt: _s, prompt: _p, answer: _a, ...summary }) => summary);
  }

  get(jobId: string): ActivityEntry | null {
    const entry = this.#find(jobId);
    return entry ? structuredClone(entry) : null;
  }
}
