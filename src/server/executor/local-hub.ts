/**
 * The queue, kept in psm itself.
 *
 * psm is local software: the models, the clones and the review all live on this
 * machine, so the queue does too. This is the same `Hub` the executor and the
 * cockpit already talk to (client.ts), backed by psm's own database instead of
 * the Werewolf hub. No account, no sign-in, no second server to run.
 *
 * The rules are the hub's (docs/roadmaps/p14-hub-contract.md), unchanged:
 *
 *   intake:  new -> claimed -> triaged | failed (one retry first) ; any -> withdrawn
 *   job:     queued -> claimed -> review -> accepted | rejected
 *                              -> stalled | failed (one retry first)
 *            review -> queued (revise) ; queued | stalled | failed -> cancelled
 *
 *   - a lease is 120 s and is kept by heartbeats; one that runs out returns the
 *     item to the queue (twice, for a job, and it is stalled);
 *   - at most one claimed implement job per project (the repo lock);
 *   - Go needs a triaged intake whose verdict fits or needs a decision.
 *
 * node:sqlite is synchronous and psm is one process, so each step below is
 * atomic without a transaction of its own.
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { db } from "../db.ts";
import { validateVerdict, type Verdict } from "../triage/verdict.ts";
import { HubError, type ExecutorJob, type Hub, type HubJob, type HubQuestion, type ImplementResult, type JobKind, type QueueItem } from "./client.ts";
import type { JobSelection } from "./model-selection.ts";

export const LEASE_MS = 120_000;
export const MAX_ATTEMPTS = 2; // one retry
const MAX_TEXT = 20_000;
const CLAIM_WAIT_MS = 25_000;
const CLAIM_POLL_MS = 1_000;
const PSM_KEY = /^pst_[0-9a-f]{24}$/;
const PROJECT_ID = /^prj_[a-z0-9]{1,64}$/i;
const GO_VERDICTS = new Set(["fits", "needs_decision"]);
const ACTIVE = "('queued','claimed','review')";

export interface LocalHubOptions {
  executorId: string;
  /** The projects on this machine; only one with an id, not archived, can take work. */
  projects: () => { id?: string | null; name: string; archived?: boolean }[];
  database?: () => DatabaseSync;
  now?: () => number;
  /** How long a claim waits for work before answering "nothing". Tests shorten it. */
  claimWaitMs?: number;
  claimPollMs?: number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const json = <T>(text: string | null, fallback: T): T => {
  if (text == null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

function shapeIntake(row: any): QueueItem {
  return {
    intakeId: row.intake_id,
    projectId: row.project_id,
    source: row.source,
    sourceRef: { kind: "psm", key: row.key },
    text: row.text,
    status: row.status,
    claim: row.claim_executor ? { executorId: row.claim_executor, leaseUntil: iso(row.lease_until) } : null,
    attempts: row.attempts,
    verdict: json<Verdict | null>(row.verdict, null),
    error: row.error ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function shapeJob(row: any): HubJob {
  return {
    jobId: row.job_id,
    intakeId: row.intake_id,
    projectId: row.project_id,
    kind: "implement",
    selection: json<JobSelection>(row.selection, { mode: "auto" }),
    status: row.status,
    claim: row.claim_executor ? { executorId: row.claim_executor, leaseUntil: iso(row.lease_until) } : null,
    attempts: row.attempts,
    pinnedExecutor: row.pinned_executor ?? null,
    revisions: json<{ comment: string; at: string }[]>(row.revisions, []),
    result: json<ImplementResult | null>(row.result, null),
    error: row.error ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function parseSelection(value: any): JobSelection {
  if (value == null || value.mode === "auto") return { mode: "auto" };
  if (value.mode !== "manual" || !["claude", "codex"].includes(value.engine)) throw new HubError("Choose Auto or Claude/Codex", 400, "bad_selection");
  const model = value.model == null || value.model === "" ? null : value.model;
  const effort = value.effort == null || value.effort === "" ? null : value.effort;
  if (model !== null && (typeof model !== "string" || !/^[a-zA-Z0-9._:-]{1,120}$/.test(model))) throw new HubError("Invalid model id", 400, "bad_selection");
  if (effort !== null && (typeof effort !== "string" || !/^[a-zA-Z0-9_-]{1,30}$/.test(effort))) throw new HubError("Invalid effort", 400, "bad_selection");
  return { mode: "manual", engine: value.engine, model, effort } as JobSelection;
}

function parseText(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) throw new HubError("text must not be empty", 400, "bad_text");
  if (text.length > MAX_TEXT) throw new HubError(`text must be at most ${MAX_TEXT} characters`, 400, "bad_text");
  return text;
}

export function localHub(options: LocalHubOptions): Hub {
  const database = options.database ?? db;
  const now = options.now ?? Date.now;
  const me = options.executorId;
  const sql = (text: string) => database().prepare(text);

  const projectName = (projectId: string) => options.projects().find((project) => project.id === projectId)?.name ?? null;
  const requireProject = (projectId: unknown) => {
    const known = typeof projectId === "string" && PROJECT_ID.test(projectId) && options.projects().some((project) => project.id === projectId && !project.archived);
    if (!known) throw new HubError("No such project", 404, "project_not_found");
  };

  const intakeRow = (intakeId: string) => sql("SELECT * FROM hub_intake WHERE intake_id = ?").get(String(intakeId)) as any;
  const jobRow = (jobId: string) => sql("SELECT * FROM hub_jobs WHERE job_id = ?").get(String(jobId)) as any;
  const ownIntake = (intakeId: string) => {
    const row = intakeRow(intakeId);
    if (!row) throw new HubError("No such intake", 404, "not_found");
    return row;
  };
  const refuseDuringJob = (intakeId: string) => {
    if (sql(`SELECT 1 FROM hub_jobs WHERE intake_id = ? AND status IN ${ACTIVE}`).get(intakeId)) {
      throw new HubError("This task has a job under way. Cancel or finish the job first.", 409, "job_active");
    }
  };

  /** Leases that ran out: intake back to new; a job back to queued, or stalled when out of attempts. */
  function releaseExpired(at: number) {
    sql("UPDATE hub_intake SET status = 'new', claim_executor = NULL, lease_until = NULL, updated_at = ? WHERE status = 'claimed' AND lease_until <= ?").run(at, at);
    sql(`UPDATE hub_jobs SET status = 'stalled', claim_executor = NULL, lease_until = NULL, progress = NULL, updated_at = ?,
         error = COALESCE(error, 'The executor stopped answering, twice. Stalled rather than retried silently.')
         WHERE status = 'claimed' AND lease_until <= ? AND attempts >= ?`).run(at, at, MAX_ATTEMPTS);
    sql("UPDATE hub_jobs SET status = 'queued', claim_executor = NULL, lease_until = NULL, progress = NULL, updated_at = ? WHERE status = 'claimed' AND lease_until <= ?").run(at, at);
  }

  function claimTriage(at: number): ExecutorJob | null {
    const row = sql("SELECT * FROM hub_intake WHERE status = 'new' ORDER BY created_at, rowid LIMIT 1").get() as any;
    if (!row) return null;
    const leaseUntil = at + LEASE_MS;
    sql("UPDATE hub_intake SET status = 'claimed', claim_executor = ?, lease_until = ?, attempts = attempts + 1, updated_at = ? WHERE intake_id = ?").run(me, leaseUntil, at, row.intake_id);
    return { jobId: row.intake_id, kind: "triage", intakeId: row.intake_id, projectId: row.project_id, projectName: projectName(row.project_id) as string, text: row.text, attempt: row.attempts + 1, leaseUntil: iso(leaseUntil) };
  }

  function claimImplement(at: number): ExecutorJob | null {
    // The repo lock: skip a project that already has a claimed job.
    const row = sql(`SELECT * FROM hub_jobs AS job WHERE status = 'queued' AND (pinned_executor IS NULL OR pinned_executor = ?)
                     AND NOT EXISTS (SELECT 1 FROM hub_jobs AS busy WHERE busy.project_id = job.project_id AND busy.status = 'claimed')
                     ORDER BY created_at, rowid LIMIT 1`).get(me) as any;
    if (!row) return null;
    const leaseUntil = at + LEASE_MS;
    sql("UPDATE hub_jobs SET status = 'claimed', claim_executor = ?, lease_until = ?, attempts = attempts + 1, error = NULL, progress = NULL, updated_at = ? WHERE job_id = ?").run(me, leaseUntil, at, row.job_id);
    const intake = intakeRow(row.intake_id);
    const revisions = json<{ comment: string; at: string }[]>(row.revisions, []);
    return {
      jobId: row.job_id,
      kind: "implement",
      intakeId: row.intake_id,
      projectId: row.project_id,
      projectName: projectName(row.project_id) as string,
      text: intake?.text ?? "",
      verdict: json<Verdict | null>(intake?.verdict ?? null, null),
      selection: json<JobSelection>(row.selection, { mode: "auto" }),
      revisions,
      attempt: row.attempts + 1,
      continueClone: row.pinned_executor === me && revisions.length > 0,
      leaseUntil: iso(leaseUntil),
    };
  }

  const heldIntake = (jobId: string, at: number) => sql("SELECT * FROM hub_intake WHERE intake_id = ? AND status = 'claimed' AND claim_executor = ? AND lease_until > ?").get(jobId, me, at) as any;
  const heldJob = (jobId: string, at: number) => sql("SELECT * FROM hub_jobs WHERE job_id = ? AND status = 'claimed' AND claim_executor = ? AND lease_until > ?").get(jobId, me, at) as any;
  const notHeld = () => new HubError("This job is no longer claimed by this executor", 409, "not_held");

  return {
    async claim(kinds: JobKind[], signal?: AbortSignal) {
      const deadline = now() + (options.claimWaitMs ?? CLAIM_WAIT_MS);
      for (;;) {
        if (signal?.aborted) return null;
        const at = now();
        releaseExpired(at);
        // Triage first: it is quick, and it decides whether there is anything to implement.
        const job = (kinds.includes("triage") && claimTriage(at)) || (kinds.includes("implement") && claimImplement(at)) || null;
        if (job) return job;
        const left = deadline - now();
        if (left <= 0) return null;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, Math.min(options.claimPollMs ?? CLAIM_POLL_MS, left));
          signal?.addEventListener("abort", done, { once: true });
        });
      }
    },

    async heartbeat(jobId, step) {
      const at = now();
      const leaseUntil = at + LEASE_MS;
      if (jobId.startsWith("job_")) {
        if (!heldJob(jobId, at)) throw notHeld();
        const label = typeof step === "string" ? step.trim().slice(0, 200) : "";
        if (label) sql("UPDATE hub_jobs SET lease_until = ?, progress = ?, updated_at = ? WHERE job_id = ?").run(leaseUntil, JSON.stringify({ label, at: iso(at) }), at, jobId);
        else sql("UPDATE hub_jobs SET lease_until = ? WHERE job_id = ?").run(leaseUntil, jobId);
      } else {
        if (!heldIntake(jobId, at)) throw notHeld();
        sql("UPDATE hub_intake SET lease_until = ? WHERE intake_id = ?").run(leaseUntil, jobId);
      }
      return { leaseUntil: iso(leaseUntil) };
    },

    async result(jobId, outcome) {
      const at = now();
      const error = "error" in outcome ? String(outcome.error || "").trim().slice(0, 2000) : "";
      if (jobId.startsWith("job_")) {
        const held = heldJob(jobId, at);
        if (!held) throw notHeld();
        if (outcome.status === "review") {
          const result = outcome.result;
          if (!result || typeof result.branch !== "string" || !/^psm\/job\/job_[0-9a-f]{24}$/.test(result.branch)) throw new HubError("result.branch must be psm/job/<jobId>", 400, "bad_result");
          if (!Array.isArray(result.commits) || !result.commits.length) throw new HubError("result.commits must list at least one commit", 400, "bad_result");
          sql("UPDATE hub_jobs SET status = 'review', result = ?, error = NULL, claim_executor = NULL, lease_until = NULL, progress = NULL, pinned_executor = ?, updated_at = ? WHERE job_id = ?")
            .run(JSON.stringify(result), me, at, jobId);
          return;
        }
        if (outcome.status !== "stalled" && outcome.status !== "failed") throw new HubError("status must be review, stalled or failed", 400, "bad_result");
        if (!error) throw new HubError(`A ${outcome.status} result needs an error message`, 400, "bad_result");
        // A stop rule stalls at once. A crash or engine failure gets one retry, then is failed.
        const next = outcome.status === "stalled" ? "stalled" : held.attempts < MAX_ATTEMPTS ? "queued" : "failed";
        sql("UPDATE hub_jobs SET status = ?, error = ?, claim_executor = NULL, lease_until = NULL, progress = NULL, pinned_executor = ?, updated_at = ? WHERE job_id = ?").run(next, error, me, at, jobId);
        return;
      }
      const held = heldIntake(jobId, at);
      if (!held) throw notHeld();
      if (outcome.status === "triaged") {
        const checked = validateVerdict(outcome.verdict);
        if (!checked.ok) throw new HubError(`Invalid verdict: ${checked.error}`, 400, "invalid_verdict");
        sql("UPDATE hub_intake SET status = 'triaged', verdict = ?, error = NULL, claim_executor = NULL, lease_until = NULL, updated_at = ? WHERE intake_id = ?").run(JSON.stringify(checked.verdict), at, jobId);
        return;
      }
      if (outcome.status !== "failed") throw new HubError("status must be triaged or failed", 400, "bad_result");
      if (!error) throw new HubError("A failed result needs an error message", 400, "bad_result");
      sql("UPDATE hub_intake SET status = ?, verdict = NULL, error = ?, claim_executor = NULL, lease_until = NULL, updated_at = ? WHERE intake_id = ?").run(held.attempts < MAX_ATTEMPTS ? "new" : "failed", error, at, jobId);
    },

    async listIntake(projectId) {
      releaseExpired(now());
      return (sql("SELECT * FROM hub_intake WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200").all(projectId) as any[])
        .map((row) => ({ intakeId: row.intake_id, text: row.text, status: row.status, verdict: json<Verdict | null>(row.verdict, null) }));
    },

    async listQueue() {
      releaseExpired(now());
      return (sql("SELECT * FROM hub_intake ORDER BY created_at DESC, rowid DESC LIMIT 200").all() as any[]).map(shapeIntake);
    },

    async listQuestions() {
      const rows = sql(`SELECT * FROM hub_intake AS intake WHERE status = 'triaged'
                        AND NOT EXISTS (SELECT 1 FROM hub_jobs AS job WHERE job.intake_id = intake.intake_id AND job.status IN ${ACTIVE})
                        ORDER BY updated_at DESC, rowid DESC LIMIT 200`).all() as any[];
      const questions: HubQuestion[] = [];
      for (const row of rows) {
        const verdict = json<any>(row.verdict, null);
        if (verdict?.verdict !== "needs_decision") continue;
        questions.push({
          intakeId: row.intake_id, kind: "psm", itemId: null, projectId: row.project_id, project: null, text: row.text, workspace: null, date: null,
          questions: Array.isArray(verdict.questions) ? verdict.questions : [],
          rationale: typeof verdict.rationale === "string" ? verdict.rationale : "",
          size: verdict.size ?? null,
          updatedAt: iso(row.updated_at),
        });
        if (questions.length === 100) break;
      }
      return questions;
    },

    async createIntake({ projectId, text, key }) {
      if (typeof key !== "string" || !PSM_KEY.test(key)) throw new HubError("sourceRef.key must look like pst_<24 hex>", 400, "bad_source_ref");
      const clean = parseText(text);
      const existing = sql("SELECT * FROM hub_intake WHERE key = ?").get(key) as any;
      if (existing) return { intake: shapeIntake(existing), created: false };
      requireProject(projectId);
      const intakeId = `int_${crypto.randomBytes(12).toString("hex")}`;
      const at = now();
      sql("INSERT INTO hub_intake(intake_id, project_id, source, key, text, status, attempts, created_at, updated_at) VALUES (?, ?, 'psm', ?, ?, 'new', 0, ?, ?)").run(intakeId, projectId, key, clean, at, at);
      return { intake: shapeIntake(intakeRow(intakeId)), created: true };
    },

    async updateIntake(intakeId, change) {
      const found = ownIntake(intakeId);
      if (found.status === "withdrawn") throw new HubError("This task was withdrawn", 409, "withdrawn");
      const text = change.text !== undefined ? parseText(change.text) : found.text;
      const projectId = change.projectId !== undefined ? change.projectId : found.project_id;
      if (change.text === undefined && change.projectId === undefined) throw new HubError("Send text or projectId to change", 400, "nothing_to_change");
      if (text === found.text && projectId === found.project_id) return shapeIntake(found);
      if (projectId !== found.project_id) requireProject(projectId);
      refuseDuringJob(found.intake_id);
      // A real change sends it back to triage.
      sql("UPDATE hub_intake SET text = ?, project_id = ?, status = 'new', verdict = NULL, error = NULL, attempts = 0, claim_executor = NULL, lease_until = NULL, updated_at = ? WHERE intake_id = ?")
        .run(text, projectId, now(), found.intake_id);
      return shapeIntake(intakeRow(found.intake_id));
    },

    async withdrawIntake(intakeId) {
      const found = ownIntake(intakeId);
      if (found.status === "withdrawn") return shapeIntake(found);
      refuseDuringJob(found.intake_id);
      sql("UPDATE hub_intake SET status = 'withdrawn', claim_executor = NULL, lease_until = NULL, updated_at = ? WHERE intake_id = ?").run(now(), found.intake_id);
      return shapeIntake(intakeRow(found.intake_id));
    },

    async listJobs() {
      releaseExpired(now());
      return (sql("SELECT * FROM hub_jobs ORDER BY created_at DESC, rowid DESC LIMIT 200").all() as any[]).map(shapeJob);
    },

    async goJob(intakeId, selection) {
      const choice = parseSelection(selection);
      const intake = intakeRow(intakeId);
      if (!intake) throw new HubError("No such intake", 404, "not_found");
      if (intake.status !== "triaged" || !GO_VERDICTS.has(json<any>(intake.verdict, null)?.verdict)) {
        throw new HubError("Only a triaged item that fits (or that you decided on) can be implemented", 409, "not_ready");
      }
      if (sql(`SELECT 1 FROM hub_jobs WHERE intake_id = ? AND status IN ${ACTIVE}`).get(intake.intake_id)) throw new HubError("This item already has a job", 409, "already_queued");
      const jobId = `job_${crypto.randomBytes(12).toString("hex")}`;
      const at = now();
      sql("INSERT INTO hub_jobs(job_id, intake_id, project_id, selection, status, attempts, revisions, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, '[]', ?, ?)")
        .run(jobId, intake.intake_id, intake.project_id, JSON.stringify(choice), at, at);
      return shapeJob(jobRow(jobId));
    },

    async reviewJob(jobId, action, comment) {
      const job = jobRow(jobId);
      if (!job) throw new HubError("No such job", 404, "not_found");
      if (job.status !== "review") throw new HubError(`This job is ${job.status}, not waiting for review`, 409, "not_in_review");
      const at = now();
      if (action === "accept" || action === "reject") {
        sql("UPDATE hub_jobs SET status = ?, updated_at = ? WHERE job_id = ?").run(action === "accept" ? "accepted" : "rejected", at, jobId);
      } else if (action === "revise") {
        const text = typeof comment === "string" ? comment.trim().slice(0, 4000) : "";
        if (!text) throw new HubError("Say what to change", 400, "comment_required");
        const revisions = [...json<{ comment: string; at: string }[]>(job.revisions, []), { comment: text, at: iso(at) }];
        sql("UPDATE hub_jobs SET status = 'queued', attempts = 0, error = NULL, revisions = ?, updated_at = ? WHERE job_id = ?").run(JSON.stringify(revisions), at, jobId);
      } else throw new HubError("action must be accept, reject or revise", 400, "bad_action");
      return shapeJob(jobRow(jobId));
    },

    async cancelJob(jobId) {
      const job = jobRow(jobId);
      if (!job || !["queued", "stalled", "failed"].includes(job.status)) throw new HubError("Only a queued, stalled or failed job can be cancelled", 409, "not_cancellable");
      sql("UPDATE hub_jobs SET status = 'cancelled', claim_executor = NULL, lease_until = NULL, updated_at = ? WHERE job_id = ?").run(now(), jobId);
      return shapeJob(jobRow(jobId));
    },

    /** The project registry feeds Todo's picker on the Werewolf hub. The local queue reads psm's own projects. */
    async publishProjects(projects) {
      return { count: projects.length, archived: 0 };
    },
  };
}
