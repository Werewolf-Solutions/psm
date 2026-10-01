/**
 * Assembles the managed deployment engine.
 *
 * The store, the service that plans against it and the runner that executes
 * approved plans are separately testable, but they are only *safe* in one
 * arrangement: the runner must recheck through the same planner the operator
 * approved through, and it must refuse an inherited lock it cannot account for.
 * That arrangement lives here so `index.ts` cannot accidentally build a
 * different one.
 */
import { defaultDeploymentAdapters, installedExecutorKinds } from "./executors.ts";
import { DeploymentService } from "./service.ts";
import { planAuthorityDigest, type DeploymentPlanDocument } from "./planner.ts";
import {
  DeploymentRunner,
  type DeploymentActionAdapter,
  type ExpiredLockObservation,
  type ExpiredLockObservationContext,
  type PlanRecheckContext,
  type PlanRecheckResult,
  type StartupRecovery,
} from "./runner.ts";
import type { DeploymentStore } from "./store.ts";
import type { DeploymentServiceOptions } from "./service.ts";

const TERMINAL_RUN_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "stale-plan",
  "rolled-back",
]);

export interface DeploymentEngineOptions extends Omit<DeploymentServiceOptions, "installedActionKinds"> {
  adapters?: readonly DeploymentActionAdapter[];
  bootId?: string;
}

export interface DeploymentEngine {
  service: DeploymentService;
  runner: DeploymentRunner;
  /** The subset of `DeploymentRunner` the HTTP layer is allowed to reach. */
  controller: { enqueue(runId: string): void | Promise<void>; cancel(runId: string): unknown; closeUncertainReload(runId: string): unknown; closeFailedReadOnlyObservation(runId: string): unknown; recover(runId: string): void };
  start(): StartupRecovery[];
  shutdown(): Promise<void>;
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Re-derive the approved plan from today's inputs and require the same digest.
 *
 * A rebuild that throws is a mismatch, not a pass: an unreadable manifest or a
 * connection that lost its binding is exactly the kind of drift this gate
 * exists to catch, and treating the error as "unchanged" would apply a plan
 * against a world nobody re-reviewed.
 */
export async function recheckAgainstPlanner(
  service: DeploymentService,
  context: PlanRecheckContext,
): Promise<PlanRecheckResult> {
  let rebuilt: { digest: string; lockKeys: readonly string[]; authorityDigest: string };
  try {
    rebuilt = await service.recheckPlan(context.plan.planId, context.plan.revision);
  } catch (error) {
    return { ok: false, reason: `plan inputs could not be re-derived: ${error instanceof Error ? error.message : String(error)}` };
  }
  const approvedAuthority = context.effectStarted
    ? planAuthorityDigest(context.plan.document as unknown as DeploymentPlanDocument) : null;
  if (context.effectStarted && rebuilt.authorityDigest !== approvedAuthority) {
    return { ok: false, reason: `approved source, policy or connections changed during execution (${context.checkpoint})`, planDigest: rebuilt.digest, lockKeys: rebuilt.lockKeys };
  }
  if (!context.effectStarted && rebuilt.digest !== context.plan.digest) {
    return {
      ok: false,
      reason: `deployment inputs changed since approval (${context.checkpoint})`,
      planDigest: rebuilt.digest,
      lockKeys: rebuilt.lockKeys,
    };
  }
  if (!sameKeys([...context.expectedLockKeys], [...rebuilt.lockKeys])) {
    return { ok: false, reason: "the set of targets this plan mutates changed since approval", planDigest: rebuilt.digest, lockKeys: rebuilt.lockKeys };
  }
  return { ok: true, planDigest: context.effectStarted ? context.plan.digest : rebuilt.digest, lockKeys: rebuilt.lockKeys };
}

/**
 * Decide whether an expired lease may be transferred to this boot.
 *
 * PSM can prove two things from its own durable records: that the plan waiting
 * on the lock mutates nothing, or that the previous owner's run reached a
 * terminal state and the lease is merely stale bookkeeping. It cannot prove
 * what a run that died mid-mutation left on the target, because that needs a
 * target-side observer PSM does not have yet. So it says so and holds, rather
 * than assuming the target is clean.
 */
export function observeExpiredLockFromRecords(
  store: DeploymentStore,
  context: ExpiredLockObservationContext,
): ExpiredLockObservation {
  if (!context.plan.actions.some((action) => action.sideEffecting)) {
    return { safeToRecover: true, reason: "the waiting plan performs no mutation" };
  }
  let ownerState: string;
  try {
    ownerState = store.getRun(context.lock.ownerRunId).state;
  } catch {
    return { safeToRecover: false, reason: `lock ${context.lock.lockKey} names run ${context.lock.ownerRunId}, which this database does not contain` };
  }
  if (TERMINAL_RUN_STATES.has(ownerState)) {
    return { safeToRecover: true, reason: `previous owner ${context.lock.ownerRunId} finished as ${ownerState}` };
  }
  return {
    safeToRecover: false,
    reason: `previous owner ${context.lock.ownerRunId} is still ${ownerState}; PSM has no target-side observer to establish what it left behind`,
  };
}

export function createDeploymentEngine(options: DeploymentEngineOptions): DeploymentEngine {
  const adapters = options.adapters ?? defaultDeploymentAdapters();
  const service = new DeploymentService({
    store: options.store,
    secretBroker: options.secretBroker,
    projects: options.projects,
    ...(options.observations ? { observations: options.observations } : {}),
    // Preparation stays unavailable until an executor is actually constructed;
    // `canPrepare` in the UI and the 409 from the prepare route both read this.
    artifactPreparationAvailable: options.artifactPreparationAvailable ?? false,
    installedActionKinds: installedExecutorKinds(adapters),
  });
  const runner = new DeploymentRunner({
    store: options.store,
    adapters,
    recheckPlan: (context) => recheckAgainstPlanner(service, context),
    observeExpiredLock: async (context) => observeExpiredLockFromRecords(options.store, context),
    ...(options.bootId ? { bootId: options.bootId } : {}),
  });
  return {
    service,
    runner,
    controller: {
      enqueue: (runId) => {
        // A rejected execution is already durable as a terminal or
        // recovery-required run; it must not also crash the HTTP request that
        // queued it, nor the process.
        void runner.enqueue(runId).catch(() => {});
      },
      cancel: (runId) => runner.requestCancellation(runId),
      closeUncertainReload: (runId) => runner.closeUncertainNginxReload(runId),
      closeFailedReadOnlyObservation: (runId) => runner.closeFailedReadOnlyObservation(runId),
      // Recovery only re-observes submitted work, never re-submits it; like
      // enqueue, its outcome is durable in the run rather than in the request.
      recover: (runId) => { void runner.recover(runId).catch(() => {}); },
    },
    start: () => runner.start(),
    shutdown: () => runner.shutdown(),
  };
}
