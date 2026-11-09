/**
 * Starting the executor inside a psm process — opt-in, off by default.
 *
 *   PSM_EXECUTOR=1 npm run agent     or     npm run executor
 *
 * It borrows psm's one Werewolf session (server/session.ts): sign in with
 * "Continue with Werewolf" on the local cockpit and the loop starts claiming;
 * signed out, it backs off and says so. That session lives in memory, so a
 * restarted executor waits for a fresh sign-in — see the TODO below.
 *
 * Projects are matched by their `prj_` id (.psm/identity.json), so the executor
 * only triages projects this machine actually has.
 */
import { getProjects } from "../../index.ts";
import { cachedRecap } from "../ai.ts";
import { werewolfApiUrl } from "../runtime.ts";
import { sessionContext } from "../session.ts";
import { claudeEngine, fileTriageCache } from "../triage/run.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentPermissionStore } from "../agent-permissions.ts";
import { runManagedAgent } from "../agent-permission-runtime.ts";
import { databaseFile } from "../db.ts";
import { executorId, executorPaused, hubClient, runExecutor, type ExecutorEvent, type ExecutorJob, type JobKind, type JobOutcome } from "./client.ts";
import { runBaseline } from "./baseline.ts";
import { implementJobRunner } from "./implement-job.ts";
import { stepReporter } from "./progress.ts";
import { triageJobRunner } from "./triage-job.ts";
import { ExecutorActivity } from "./activity.ts";
import { statePath } from "../../store.ts";
import { loadState as loadWorkspaceState, projectWorkspaceRef } from "../workspaces.ts";

export interface ExecutorStatus {
  enabled: boolean;
  executorId: string | null;
  state: "off" | "starting" | "connected" | "hub-error" | "paused" | "stopped";
  lastClaimAt: number | null;
  lastError: string | null;
  running: string[];
  /** The kill switch, read live. */
  paused: boolean;
}

const status: Omit<ExecutorStatus, "paused"> = {
  enabled: false,
  executorId: null,
  state: "off",
  lastClaimAt: null,
  lastError: null,
  running: [],
};

/** For the cockpit's status line (B5): connected / last claim / jobs running. */
export function executorStatus(): ExecutorStatus {
  return { ...status, running: [...status.running], paused: status.enabled && executorPaused() };
}

let activity: ExecutorActivity | null = null;

/** Job-by-job history for the cockpit (Running → Executor). Created on first use. */
export function executorActivity(): ExecutorActivity {
  if (!activity) activity = new ExecutorActivity(process.env.PSM_EXECUTOR_ACTIVITY_FILE || statePath(".psm-executor-activity.json"));
  return activity;
}

function track(event: ExecutorEvent): void {
  if (event.type === "claimed") executorActivity().claimed(event.job);
  else if (event.type === "posted") executorActivity().posted(event.jobId, event.outcome);
  else if (event.type === "abandoned") executorActivity().abandoned(event.jobId, event.reason);
  switch (event.type) {
    case "idle":
      status.state = "connected";
      status.lastError = null;
      break;
    case "claimed":
      status.state = "connected";
      status.lastError = null;
      status.lastClaimAt = Date.now();
      status.running.push(event.job.jobId);
      break;
    case "posted":
    case "abandoned":
      status.running = status.running.filter((id) => id !== event.jobId);
      break;
    case "hub-error":
      status.state = "hub-error";
      status.lastError = event.error;
      break;
    case "paused":
      status.state = "paused";
      break;
    case "stopped":
      status.state = "stopped";
      status.running = [];
      break;
  }
}

/** D3 sets the pool at two jobs; one is the default until triage has been watched in use. */
function concurrency(): number {
  const value = Number(process.env.PSM_EXECUTOR_CONCURRENCY || 1);
  return Number.isFinite(value) ? Math.min(2, Math.max(1, Math.floor(value))) : 1;
}

let handle: { stop: () => Promise<void> } | null = null;

/** Is the executor on because PSM_EXECUTOR=1 (so the cockpit switch cannot turn it off)? */
export const executorForcedByEnv = () => process.env.PSM_EXECUTOR === "1";

/**
 * Start the loop if `PSM_EXECUTOR=1` or `on` (the cockpit switch, remembered in
 * .psm-switches.json). Returns a stop function, or null when the executor is
 * off. Nothing here traps SIGTERM: a killed process simply lets its leases
 * expire, which is the contract's crash path.
 */
export function startExecutorService(on = false): { stop: () => Promise<void> } | null {
  if (!executorForcedByEnv() && !on) return null;
  if (handle) return handle;
  handle = launch();
  return handle;
}

/** The cockpit switch: start or stop the loop in this process, now. */
export async function setExecutorRunning(on: boolean): Promise<ExecutorStatus> {
  if (on) startExecutorService(true);
  else if (handle && !executorForcedByEnv()) {
    const current = handle;
    handle = null;
    await current.stop();
    Object.assign(status, { enabled: false, state: "off", running: [] });
  }
  return executorStatus();
}

function launch(): { stop: () => Promise<void> } {
  const id = executorId();
  status.enabled = true;
  status.executorId = id;
  status.state = "starting";
  status.lastError = null;

  // TODO(P14 B4): a long-lived executor needs a credential that survives a
  // restart without a person at the keyboard — a device session it can refresh
  // on its own. psm has none today: its only dapp session is the in-memory one
  // from "Continue with Werewolf". Swap this provider when one exists.
  const token = async () => (await sessionContext()).accessToken;
  const hub = hubClient({ apiUrl: () => werewolfApiUrl(), token, executorId: id });

  const runJob = triageJobRunner({
    findProject: (projectId) => {
      const project = getProjects().find((candidate) => candidate.id === projectId);
      return project ? { name: project.name, path: project.path } : null;
    },
    listIntake: (projectId) => hub.listIntake(projectId),
    recap: (name) => cachedRecap(name),
    engine: claudeEngine({ model: process.env.PSM_TRIAGE_MODEL || null }),
    cache: fileTriageCache(),
    onStep: (job, step) => executorActivity().step(job, step),
  });
  const runTriage = async (job: ExecutorJob, signal: AbortSignal): Promise<JobOutcome> => {
    if (job.kind !== "triage") return { status: "failed", error: `the triage pool cannot run a ${job.kind} job` };
    const outcome = await runJob(job, signal);
    executorActivity().finishing(job.jobId, outcome);
    return outcome;
  };

  // Implement jobs (phase E): their own pool, so a long job never holds up
  // triage. Each runs in its own clone under the job's own grant.
  const permissions = new AgentPermissionStore();
  const steps = stepReporter((jobId, step) => hub.heartbeat(jobId, step), (line) => console.log(line));
  const runImplementJob = implementJobRunner({
    findProject: (projectId) => {
      const project = getProjects().find((candidate) => candidate.id === projectId);
      return project ? { id: projectId, name: project.name, path: project.path, workspaceId: projectWorkspaceRef(loadWorkspaceState(), projectId) } : null;
    },
    findProjectByName: (name) => {
      const project = getProjects().find((candidate) => candidate.name === name && candidate.id);
      return project?.id ? { id: project.id, name: project.name, path: project.path, workspaceId: projectWorkspaceRef(loadWorkspaceState(), project.id) } : null;
    },
    jobsDir: jobsDirectory(),
    store: permissions,
    workspaceRules: (workspaceId) => permissions.workspaceRules(workspaceId),
    protectedRoots: [PSM_CODE_ROOT, path.resolve(databaseFile()), `${path.resolve(databaseFile())}-wal`, `${path.resolve(databaseFile())}-shm`],
    baseline: runBaseline,
    runAgent: runManagedAgent,
    projectEngine: (projectId) => getProjects().find((candidate) => candidate.id === projectId)?.aiEngine ?? "claude",
    progress: (jobId, step) => steps.report(jobId, step),
    activity: executorActivity(),
  });
  const runImplement = async (job: ExecutorJob, signal: AbortSignal): Promise<JobOutcome> => {
    if (job.kind !== "implement") return { status: "failed", error: `the implement pool cannot run a ${job.kind} job` };
    const outcome = await runImplementJob(job, signal);
    steps.forget(job.jobId);
    executorActivity().finishing(job.jobId, outcome);
    return outcome;
  };

  const controller = new AbortController();
  const loop = (kinds: JobKind[], run: (job: ExecutorJob, signal: AbortSignal) => Promise<JobOutcome>, pool: number) =>
    runExecutor({
      hub,
      run,
      kinds,
      signal: controller.signal,
      concurrency: pool,
      killSwitch: () => executorPaused(),
      onEvent: track,
      log: (line) => console.log(line),
    }).catch((err) => {
      status.state = "stopped";
      status.lastError = (err as Error).message;
      console.error(`executor: stopped on an unexpected error: ${(err as Error).message}`);
    });
  const loops = [loop(["triage"], runTriage, concurrency()), loop(["implement"], runImplement, implementConcurrency())];
  console.log(`  → executor ${id}: claiming triage (pool ${concurrency()}) and implement jobs (pool ${implementConcurrency()})`);

  return {
    stop: async () => {
      controller.abort();
      await Promise.all(loops);
    },
  };
}

/** Implement jobs at once, across projects. One per project always (the hub's lock). */
function implementConcurrency(): number {
  const value = Number(process.env.PSM_IMPLEMENT_CONCURRENCY || 1);
  return Number.isFinite(value) ? Math.min(3, Math.max(1, Math.floor(value))) : 1;
}

/** Where job clones live. Kept out of the projects themselves. */
export function jobsDirectory(): string {
  return process.env.PSM_JOBS_DIR || statePath(".psm-jobs");
}

const PSM_CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
