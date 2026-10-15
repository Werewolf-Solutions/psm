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
import { executorId, executorPaused, hubClient, runExecutor, type ExecutorEvent } from "./client.ts";
import { triageJobRunner } from "./triage-job.ts";

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

function track(event: ExecutorEvent): void {
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

/**
 * Start the loop if `PSM_EXECUTOR=1`. Returns a stop function, or null when the
 * executor is off. Nothing here traps SIGTERM: a killed process simply lets its
 * leases expire, which is the contract's crash path.
 */
export function startExecutorService(): { stop: () => Promise<void> } | null {
  if (process.env.PSM_EXECUTOR !== "1") return null;

  const id = executorId();
  status.enabled = true;
  status.executorId = id;
  status.state = "starting";

  // TODO(P14 B4): a long-lived executor needs a credential that survives a
  // restart without a person at the keyboard — a device session it can refresh
  // on its own. psm has none today: its only dapp session is the in-memory one
  // from "Continue with Werewolf". Swap this provider when one exists.
  const token = async () => (await sessionContext()).accessToken;
  const hub = hubClient({ apiUrl: () => werewolfApiUrl(), token, executorId: id });

  const run = triageJobRunner({
    findProject: (projectId) => {
      const project = getProjects().find((candidate) => candidate.id === projectId);
      return project ? { name: project.name, path: project.path } : null;
    },
    listIntake: (projectId) => hub.listIntake(projectId),
    recap: (name) => cachedRecap(name),
    engine: claudeEngine({ model: process.env.PSM_TRIAGE_MODEL || null }),
    cache: fileTriageCache(),
  });

  const controller = new AbortController();
  const loop = runExecutor({
    hub,
    run,
    signal: controller.signal,
    concurrency: concurrency(),
    killSwitch: () => executorPaused(),
    onEvent: track,
    log: (line) => console.log(line),
  }).catch((err) => {
    status.state = "stopped";
    status.lastError = (err as Error).message;
    console.error(`executor: stopped on an unexpected error: ${(err as Error).message}`);
  });
  console.log(`  → executor ${id}: claiming triage jobs (pool ${concurrency()})`);

  return {
    stop: async () => {
      controller.abort();
      await loop;
    },
  };
}
