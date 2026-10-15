/**
 * The PSM executor — the client half of P14 B3/B5.
 *
 * It claims jobs from the hub in werewolf-dapp (docs/roadmaps/p14-hub-contract.md),
 * holds each one's lease with a heartbeat while it runs, and posts the result.
 * The hub is the source of truth; this side only has to be a well-behaved
 * worker, and its stop rules (D3, E2) are enforced here, never by a prompt:
 *
 *   - every job has a timeout (triage: five minutes);
 *   - at most one job per project runs at a time;
 *   - hub errors back off exponentially, capped at sixty seconds;
 *   - a kill switch stops claiming and abandons running jobs;
 *   - aborting stops the loop cleanly.
 *
 * An abandoned job — by abort, kill switch or a lost lease — gets no result.
 * Its lease simply expires and the hub returns it to the queue, which is the
 * contract's crash path and guarantees no duplicate result.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";

import { statePath } from "../../store.ts";
import type { OpenIntake } from "../triage/context.ts";
import type { Verdict } from "../triage/verdict.ts";

export type JobKind = "triage";

export interface ExecutorJob {
  jobId: string;
  kind: JobKind;
  intakeId: string;
  projectId: string;
  projectName: string;
  text: string;
  attempt: number;
  leaseUntil: string;
}

export type JobOutcome = { status: "triaged"; verdict: Verdict } | { status: "failed"; error: string };

export const HEARTBEAT_MS = 30_000;
export const JOB_TIMEOUTS_MS: Record<JobKind, number> = { triage: 5 * 60_000 };
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
/** The hub long-polls for 25 s; give it room before calling the request dead. */
const CLAIM_TIMEOUT_MS = 35_000;
const REQUEST_TIMEOUT_MS = 15_000;
const ERROR_MAX = 2000;

/* ---------- identity and kill switch ---------- */

const EXECUTOR_ID_RE = /^[a-z0-9-]{1,64}$/;

interface ExecutorState {
  executorId: string;
  paused?: boolean;
}

function readState(file: string): ExecutorState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return EXECUTOR_ID_RE.test(parsed?.executorId) ? parsed : null;
  } catch {
    return null;
  }
}

function writeState(file: string, state: ExecutorState): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function executorStateFile(): string {
  return process.env.PSM_EXECUTOR_FILE || statePath(".psm-executor.json");
}

/**
 * This machine's executor id, minted once and kept in psm's state dir so a
 * restart claims as the same executor. Readable on purpose: the hub shows it.
 */
export function executorId(file = executorStateFile()): string {
  const existing = readState(file);
  if (existing) return existing.executorId;
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "host";
  const state: ExecutorState = { executorId: `psm-${host}-${crypto.randomBytes(4).toString("hex")}` };
  writeState(file, state);
  return state.executorId;
}

/** The kill switch: `PSM_EXECUTOR_PAUSED=1`, or `paused: true` in the state file. */
export function executorPaused(file = executorStateFile()): boolean {
  if (process.env.PSM_EXECUTOR_PAUSED === "1") return true;
  return readState(file)?.paused === true;
}

export function setExecutorPaused(paused: boolean, file = executorStateFile()): void {
  writeState(file, { executorId: executorId(file), paused });
}

/* ---------- talking to the hub ---------- */

export class HubError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface HubOptions {
  /** dapp's API base, e.g. https://werewolf.solutions/api/v1. */
  apiUrl: () => Promise<string> | string;
  /** A psm-audience access token, or null when signed out. */
  token: () => Promise<string | null> | string | null;
  executorId: string;
  fetch?: typeof fetch;
}

export interface Hub {
  claim(kinds: JobKind[], signal?: AbortSignal): Promise<ExecutorJob | null>;
  heartbeat(jobId: string): Promise<{ leaseUntil: string }>;
  result(jobId: string, outcome: JobOutcome): Promise<void>;
  /** The owner's intake for one project — context for triage. */
  listIntake(projectId: string): Promise<OpenIntake[]>;
}

function isJob(value: any): value is ExecutorJob {
  return (
    !!value &&
    typeof value.jobId === "string" &&
    value.kind === "triage" &&
    typeof value.projectId === "string" &&
    typeof value.text === "string"
  );
}

export function hubClient(options: HubOptions): Hub {
  if (!EXECUTOR_ID_RE.test(options.executorId)) throw new Error(`invalid executor id: ${options.executorId}`);
  const fetchImpl = options.fetch || fetch;

  async function call(
    method: string,
    pathname: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ status: number; data: any }> {
    const token = await options.token();
    if (!token) throw new HubError("Sign in with Werewolf to run the executor", 401, "unauthenticated");
    const base = String(await options.apiUrl()).replace(/\/+$/, "");
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    let response: Response;
    try {
      response = await fetchImpl(`${base}${pathname}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "X-PSM-Executor": options.executorId,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new HubError(`Could not reach the hub: ${(err as Error).message}`, 0, "unreachable");
    }
    if (response.status === 204) return { status: 204, data: null };
    const payload: any = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
      throw new HubError(payload?.message || `Hub returned ${response.status}`, response.status, payload?.code);
    }
    return { status: response.status, data: payload?.data ?? payload };
  }

  return {
    async claim(kinds, signal) {
      const { data } = await call("POST", "/psm/executor/claim", { kinds }, CLAIM_TIMEOUT_MS, signal);
      if (!data) return null;
      if (!isJob(data.job)) throw new HubError("Hub returned a job this executor cannot read", 502, "bad_job");
      return data.job;
    },
    async heartbeat(jobId) {
      const { data } = await call("POST", `/psm/executor/jobs/${encodeURIComponent(jobId)}/heartbeat`, {}, REQUEST_TIMEOUT_MS);
      return { leaseUntil: String(data?.leaseUntil || "") };
    },
    async result(jobId, outcome) {
      await call("POST", `/psm/executor/jobs/${encodeURIComponent(jobId)}/result`, outcome, REQUEST_TIMEOUT_MS);
    },
    async listIntake(projectId) {
      const { data } = await call("GET", `/psm/intake?projectId=${encodeURIComponent(projectId)}`, undefined, REQUEST_TIMEOUT_MS);
      const items = Array.isArray(data?.intake) ? data.intake : Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      return items
        .filter((item: any) => item && typeof item.intakeId === "string" && typeof item.text === "string")
        .map((item: any) => ({ intakeId: item.intakeId, text: item.text, status: item.status, verdict: item.verdict ?? null }));
    },
  };
}

/* ---------- the loop ---------- */

export type ExecutorEvent =
  | { type: "claimed"; job: ExecutorJob }
  | { type: "heartbeat"; jobId: string; leaseUntil: string }
  | { type: "posted"; jobId: string; outcome: JobOutcome }
  | { type: "abandoned"; jobId: string; reason: string }
  | { type: "hub-error"; error: string; retryInMs: number }
  | { type: "idle" }
  | { type: "paused" }
  | { type: "stopped" };

export interface ExecutorOptions {
  hub: Hub;
  /** Run one job. Must honour `signal`; the loop enforces the timeout regardless. */
  run: (job: ExecutorJob, signal: AbortSignal) => Promise<JobOutcome>;
  signal: AbortSignal;
  kinds?: JobKind[];
  /** Jobs at once across all projects. One per project, always. */
  concurrency?: number;
  heartbeatMs?: number;
  timeoutsMs?: Partial<Record<JobKind, number>>;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Checked before every claim and while jobs run. */
  killSwitch?: () => boolean;
  killSwitchPollMs?: number;
  onEvent?: (event: ExecutorEvent) => void;
  log?: (line: string) => void;
}

export function backoffDelay(failures: number, baseMs = BACKOFF_BASE_MS, maxMs = BACKOFF_MAX_MS): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));
}

/** Resolves after `ms`, or early when `signal` aborts. Never rejects. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** One job per project: later jobs for a busy project wait their turn here. */
class ProjectLocks {
  private tails = new Map<string, Promise<void>>();

  async acquire(projectId: string, signal: AbortSignal): Promise<(() => void) | null> {
    const previous = this.tails.get(projectId) || Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => mine);
    this.tails.set(projectId, tail);
    const cleanup = () => {
      release();
      if (this.tails.get(projectId) === tail) this.tails.delete(projectId);
    };
    await Promise.race([previous, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
    if (signal.aborted) {
      // Still queued behind `previous`: hand our slot on once it frees up.
      previous.then(cleanup);
      return null;
    }
    return cleanup;
  }
}

/**
 * Run the executor until `signal` aborts. Resolves once every worker has
 * stopped; running jobs are abandoned to their leases, not finished.
 */
export async function runExecutor(options: ExecutorOptions): Promise<void> {
  const {
    hub,
    signal,
    kinds = ["triage"],
    heartbeatMs = HEARTBEAT_MS,
    backoffBaseMs = BACKOFF_BASE_MS,
    backoffMaxMs = BACKOFF_MAX_MS,
    killSwitch = () => false,
    killSwitchPollMs = 5_000,
  } = options;
  const timeouts = { ...JOB_TIMEOUTS_MS, ...options.timeoutsMs };
  const concurrency = Math.max(1, Math.floor(options.concurrency || 1));
  const emit = (event: ExecutorEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      /* an observer must not stop the executor */
    }
  };
  const log = options.log || (() => undefined);
  const locks = new ProjectLocks();
  let failures = 0; // shared: one hub, one backoff

  async function postResult(job: ExecutorJob, outcome: JobOutcome, jobSignal: AbortSignal): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await hub.result(job.jobId, outcome);
        emit({ type: "posted", jobId: job.jobId, outcome });
        log(`executor: ${job.jobId} ${outcome.status}${outcome.status === "failed" ? ` (${outcome.error})` : ""}`);
        return;
      } catch (err) {
        const status = (err as HubError).status;
        if (status === 409 || jobSignal.aborted) {
          emit({ type: "abandoned", jobId: job.jobId, reason: status === 409 ? "lease lost before the result was posted" : "stopped" });
          return;
        }
        log(`executor: could not post ${job.jobId}: ${(err as Error).message}`);
        await sleep(backoffDelay(attempt, backoffBaseMs, backoffMaxMs), jobSignal);
      }
    }
    // The lease will expire and the hub will hand the job out again.
    emit({ type: "abandoned", jobId: job.jobId, reason: "the result could not be posted" });
  }

  async function handle(job: ExecutorJob): Promise<void> {
    const controller = new AbortController();
    let stopReason: string | null = null;
    const stop = (reason: string) => {
      if (stopReason) return;
      stopReason = reason;
      controller.abort(new Error(reason));
    };
    const onParentAbort = () => stop("executor stopped");
    signal.addEventListener("abort", onParentAbort, { once: true });

    // Heartbeat from the moment of the claim, including while waiting on the project lock.
    const beat = setInterval(() => {
      hub.heartbeat(job.jobId).then(
        ({ leaseUntil }) => emit({ type: "heartbeat", jobId: job.jobId, leaseUntil }),
        (err) => {
          if ((err as HubError).status === 409) stop("lease lost");
          else log(`executor: heartbeat for ${job.jobId} failed: ${(err as Error).message}`);
        },
      );
    }, heartbeatMs);
    const killWatch = setInterval(() => killSwitch() && stop("kill switch"), killSwitchPollMs);

    let release: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      release = await locks.acquire(job.projectId, controller.signal);
      if (!release) return;

      const timeoutMs = timeouts[job.kind];
      let timedOut = false;
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("timeout"));
      }, timeoutMs);

      let outcome: JobOutcome;
      try {
        outcome = await options.run(job, controller.signal);
      } catch (err) {
        outcome = { status: "failed", error: `the job crashed: ${(err as Error).message}` };
      }
      clearTimeout(timer);
      if (timedOut) outcome = { status: "failed", error: `timed out after ${Math.round(timeoutMs / 1000)} s` };
      if (stopReason) return;
      if (outcome.status === "failed") outcome = { status: "failed", error: outcome.error.slice(0, ERROR_MAX) };
      await postResult(job, outcome, controller.signal);
    } finally {
      if (timer) clearTimeout(timer);
      clearInterval(beat);
      clearInterval(killWatch);
      signal.removeEventListener("abort", onParentAbort);
      release?.();
      if (stopReason) {
        emit({ type: "abandoned", jobId: job.jobId, reason: stopReason });
        log(`executor: abandoned ${job.jobId} (${stopReason}); its lease will return it to the queue`);
      }
    }
  }

  async function worker(): Promise<void> {
    while (!signal.aborted) {
      if (killSwitch()) {
        emit({ type: "paused" });
        await sleep(killSwitchPollMs, signal);
        continue;
      }
      let job: ExecutorJob | null;
      const started = Date.now();
      try {
        job = await hub.claim(kinds, signal);
        failures = 0;
      } catch (err) {
        if (signal.aborted) break;
        failures++;
        const retryInMs = backoffDelay(failures, backoffBaseMs, backoffMaxMs);
        emit({ type: "hub-error", error: (err as Error).message, retryInMs });
        if (failures === 1 || failures % 10 === 0) log(`executor: ${(err as Error).message}; retrying in ${Math.round(retryInMs / 1000)} s`);
        await sleep(retryInMs, signal);
        continue;
      }
      if (!job) {
        emit({ type: "idle" });
        // The hub's long-poll paces this loop; a hub that answers instantly must not make it spin.
        const elapsed = Date.now() - started;
        if (elapsed < backoffBaseMs) await sleep(backoffBaseMs - elapsed, signal);
        continue;
      }
      if (signal.aborted) break; // claimed as we stopped: the lease returns it
      emit({ type: "claimed", job });
      log(`executor: claimed ${job.jobId} (${job.kind}, ${job.projectName}, attempt ${job.attempt})`);
      await handle(job);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  emit({ type: "stopped" });
}
