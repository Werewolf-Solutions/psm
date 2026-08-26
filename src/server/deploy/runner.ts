/**
 * Durable executor for approved managed-deployment runs.
 *
 * The runner deliberately knows nothing about GitHub, SSH, DNS or nginx. Each
 * versioned action kind is handled by an injected adapter. The durable boundary
 * is the DeploymentStore: intent is already `prepared` when approval queues a
 * run, and this module records `submitted` before it asks an adapter to perform
 * a side effect. A lost response is therefore recovered by observation using
 * the stable idempotency key, never by blindly repeating the request.
 */
import { randomUUID } from "node:crypto";

import {
  DeploymentConflictError,
  DeploymentStore,
  DeploymentTransitionError,
  type DeploymentApproval,
  type DeploymentPlan,
  type DeploymentPlanAction,
  type DeploymentRun,
  type DeploymentRunState,
  type DeploymentRunStep,
  type DeploymentTargetLock,
  type JsonValue,
} from "./store.ts";

export const DEPLOYMENT_RUNNER_EVENT_SCHEMA =
  "psm.werewolf.solutions/deployment-runner-event/v1" as const;
export const DEPLOYMENT_ADAPTER_RESULT_SCHEMA =
  "psm.werewolf.solutions/deployment-adapter-result/v1" as const;

const TERMINAL_RUN_STATES = new Set<DeploymentRunState>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "stale-plan",
  "rolled-back",
]);

const EFFECT_STARTED_STATES = new Set([
  "submitted",
  "observed",
  "completed",
  "failed",
  "recovery-required",
]);

const MAX_ADAPTER_RESULT_BYTES = 32 * 1024;
const MAX_EXTERNAL_ID = 500;

export type AdapterOutcome =
  | "pending"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "rolled-back"
  | "not-submitted"
  | "unknown";

/** A bounded, redacted result. Adapters must not return raw provider objects. */
export interface AdapterObservation {
  outcome: AdapterOutcome;
  externalId?: string | null;
  data?: JsonValue;
  /** Only meaningful with `not-submitted`; the adapter attests a retry is safe. */
  retrySafe?: boolean;
}

export interface DeploymentAdapterContext {
  run: DeploymentRun;
  plan: DeploymentPlan;
  action: DeploymentPlanAction;
  step: DeploymentRunStep | null;
  idempotencyKey: string | null;
  externalId: string | null;
  signal: AbortSignal;
}

/**
 * An exact, versioned action adapter. `check` is used for read-only actions;
 * side-effecting actions require both `submit` and `observe`.
 */
export interface DeploymentActionAdapter {
  kind: string;
  execution: "local" | "remote";
  check?(context: DeploymentAdapterContext): Promise<AdapterObservation>;
  submit?(context: DeploymentAdapterContext): Promise<AdapterObservation>;
  observe?(context: DeploymentAdapterContext): Promise<AdapterObservation>;
  requestCancellation?(context: DeploymentAdapterContext): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface PlanRecheckContext {
  run: DeploymentRun;
  plan: DeploymentPlan;
  approval: DeploymentApproval;
  expectedLockKeys: readonly string[];
  checkpoint: "before-locks" | "after-locks" | "before-action";
  action: DeploymentPlanAction | null;
  signal: AbortSignal;
}

export type PlanRecheckResult =
  | {
      ok: true;
      /** Digest of the exact plan whose current inputs were rechecked. */
      planDigest: string;
      /** Current canonical lock set derived during the recheck. */
      lockKeys: readonly string[];
    }
  | {
      ok: false;
      reason: string;
      planDigest?: string;
      lockKeys?: readonly string[];
    };

export interface ExpiredLockObservationContext {
  lock: DeploymentTargetLock;
  nextRun: DeploymentRun;
  plan: DeploymentPlan;
  signal: AbortSignal;
}

export interface ExpiredLockObservation {
  safeToRecover: boolean;
  reason: string;
}

export interface DeploymentRunnerOptions {
  store: DeploymentStore;
  adapters: readonly DeploymentActionAdapter[];
  /** Re-observes every mutable approval input; called at each mutation gate. */
  recheckPlan(context: PlanRecheckContext): Promise<PlanRecheckResult>;
  /** Required before an expired lease can be transferred to this boot. */
  observeExpiredLock(context: ExpiredLockObservationContext): Promise<ExpiredLockObservation>;
  bootId?: string;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  lockLeaseMs?: number;
  lockPollMs?: number;
  observationPollMs?: number;
  maxObservationAttempts?: number;
  shutdownGraceMs?: number;
}

export type StartupDisposition =
  | "resumed"
  | "manual-recovery-required"
  | "preparation-run-not-owned";

export interface StartupRecovery {
  runId: string;
  disposition: StartupDisposition;
  state: DeploymentRunState;
}

export class DeploymentRunnerError extends Error {}
export class DeploymentRunnerStoppedError extends DeploymentRunnerError {}
export class DeploymentStalePlanError extends DeploymentRunnerError {}
export class DeploymentRecoveryRequiredError extends DeploymentRunnerError {}
export class DeploymentAdapterFailedError extends DeploymentRunnerError {}

class DeploymentCancelledBeforeMutationError extends DeploymentRunnerError {}
class DeploymentRunnerDetachError extends DeploymentRunnerError {}

interface RunAuthority {
  run: DeploymentRun;
  plan: DeploymentPlan;
  approval: DeploymentApproval;
  steps: DeploymentRunStep[];
  lockKeys: string[];
}

interface ActiveRun {
  controller: AbortController;
  promise: Promise<DeploymentRun>;
}

interface StepOutcome {
  outcome: "succeeded" | "cancelled" | "rolled-back";
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DeploymentRunnerStoppedError("runner stopped"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, milliseconds));
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason ?? new DeploymentRunnerStoppedError("runner stopped"));
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function sortedUnique(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values)) throw new DeploymentRunnerError(`${label} is not an array`);
  const parsed = values.map((value) => {
    if (typeof value !== "string" || !value.trim() || value.length > 500) {
      throw new DeploymentRunnerError(`${label} contains an invalid value`);
    }
    return value.trim();
  });
  const sorted = [...new Set(parsed)].sort();
  if (sorted.length !== parsed.length) throw new DeploymentRunnerError(`${label} contains duplicates`);
  return sorted;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function planLockKeys(plan: DeploymentPlan): string[] {
  if (!plan.document || typeof plan.document !== "object" || Array.isArray(plan.document)) {
    throw new DeploymentRunnerError("plan document is not an object");
  }
  const value = (plan.document as Record<string, JsonValue>).lockKeys;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DeploymentRunnerError("plan has no canonical lock set");
  }
  const original = value as string[];
  const keys = sortedUnique(original, "plan lock set");
  if (!sameStrings(keys, original)) throw new DeploymentRunnerError("plan lock set is not canonical");
  return keys;
}

function hasEffectStarted(steps: readonly DeploymentRunStep[]): boolean {
  return steps.some((step) => EFFECT_STARTED_STATES.has(step.state));
}

function actionState(action: DeploymentPlanAction): DeploymentRunState {
  const phase = action.phase.toLowerCase();
  if (phase.includes("depend") || phase.includes("precondition")) return "checking-preconditions";
  if (phase.includes("reconcil")) return "reconciling";
  if (phase.includes("verif")) return "verifying";
  if (phase.includes("observ")) return "observing-result";
  return "dispatching";
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name.slice(0, 120) : "Error";
}

function boundedJson(value: JsonValue | undefined): JsonValue {
  const normalized = value ?? {};
  let encoded: string;
  try {
    encoded = JSON.stringify(normalized);
  } catch {
    throw new DeploymentRunnerError("adapter result is not JSON serializable");
  }
  if (encoded.length > MAX_ADAPTER_RESULT_BYTES) {
    throw new DeploymentRunnerError("adapter result exceeds the durable result limit");
  }
  return JSON.parse(encoded) as JsonValue;
}

function validateObservation(value: AdapterObservation): AdapterObservation {
  const outcomes: readonly AdapterOutcome[] = [
    "pending",
    "succeeded",
    "failed",
    "cancelled",
    "rolled-back",
    "not-submitted",
    "unknown",
  ];
  if (!value || typeof value !== "object" || !outcomes.includes(value.outcome)) {
    throw new DeploymentRunnerError("adapter returned an invalid outcome");
  }
  if (value.externalId !== undefined && value.externalId !== null) {
    if (typeof value.externalId !== "string" || !value.externalId.trim() || value.externalId.length > MAX_EXTERNAL_ID) {
      throw new DeploymentRunnerError("adapter returned an invalid external id");
    }
  }
  return { ...value, data: boundedJson(value.data) };
}

function storedObservation(observation: AdapterObservation, at: number): JsonValue {
  return {
    schema: DEPLOYMENT_ADAPTER_RESULT_SCHEMA,
    outcome: observation.outcome,
    observedAt: at,
    data: boundedJson(observation.data),
  };
}

function storedOutcome(result: JsonValue | null): AdapterOutcome | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const candidate = (result as Record<string, JsonValue>).outcome;
  return typeof candidate === "string" ? candidate as AdapterOutcome : null;
}

/**
 * Owns local scheduling for durable deployment rows. Multiple callers asking
 * for the same run share one promise; SQLite target leases protect against a
 * second PSM process.
 */
export class DeploymentRunner {
  readonly bootId: string;

  private readonly store: DeploymentStore;
  private readonly adapters = new Map<string, DeploymentActionAdapter>();
  private readonly recheckPlan: DeploymentRunnerOptions["recheckPlan"];
  private readonly observeExpiredLock: DeploymentRunnerOptions["observeExpiredLock"];
  private readonly now: () => number;
  private readonly sleep: NonNullable<DeploymentRunnerOptions["sleep"]>;
  private readonly lockLeaseMs: number;
  private readonly lockPollMs: number;
  private readonly observationPollMs: number;
  private readonly maxObservationAttempts: number;
  private readonly shutdownGraceMs: number;
  private readonly active = new Map<string, ActiveRun>();
  private accepting = true;
  private stopping = false;

  constructor(options: DeploymentRunnerOptions) {
    this.store = options.store;
    this.recheckPlan = options.recheckPlan;
    this.observeExpiredLock = options.observeExpiredLock;
    this.bootId = options.bootId ?? `boot_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.lockLeaseMs = Math.max(1_000, options.lockLeaseMs ?? 30_000);
    this.lockPollMs = Math.max(10, options.lockPollMs ?? 1_000);
    this.observationPollMs = Math.max(10, options.observationPollMs ?? 2_000);
    this.maxObservationAttempts = Math.max(1, options.maxObservationAttempts ?? 900);
    this.shutdownGraceMs = Math.max(0, options.shutdownGraceMs ?? 5_000);

    if (typeof this.recheckPlan !== "function" || typeof this.observeExpiredLock !== "function") {
      throw new DeploymentRunnerError("runner safety callbacks are required");
    }
    for (const adapter of options.adapters) {
      if (!/^[-a-z0-9]+@\d+$/.test(adapter.kind)) {
        throw new DeploymentRunnerError(`adapter kind must be explicitly versioned: ${adapter.kind}`);
      }
      if (this.adapters.has(adapter.kind)) throw new DeploymentRunnerError(`duplicate adapter: ${adapter.kind}`);
      this.adapters.set(adapter.kind, adapter);
    }
  }

  /** Resume durable work after a process restart. Recovery-required is manual. */
  start(): StartupRecovery[] {
    if (this.stopping) throw new DeploymentRunnerStoppedError("runner is stopping");
    const recovered: StartupRecovery[] = [];
    for (const run of this.store.listStartupWork()) {
      if (run.runKind === "prepare") {
        recovered.push({ runId: run.runId, disposition: "preparation-run-not-owned", state: run.state });
        continue;
      }
      if (run.state === "recovery-required") {
        recovered.push({ runId: run.runId, disposition: "manual-recovery-required", state: run.state });
        continue;
      }
      recovered.push({ runId: run.runId, disposition: "resumed", state: run.state });
      void this.enqueue(run.runId).catch(() => {
        // executeRun records a durable terminal/recovery state. A rejected
        // promise here must not become an unhandled process-level failure.
      });
    }
    return recovered;
  }

  enqueue(runId: string): Promise<DeploymentRun> {
    return this.schedule(runId, false);
  }

  /** Explicit operator action for a run held in recovery-required. */
  recover(runId: string): Promise<DeploymentRun> {
    const run = this.store.getRun(runId);
    if (run.state !== "recovery-required") {
      throw new DeploymentRunnerError("only a recovery-required run can be manually recovered");
    }
    return this.schedule(runId, true);
  }

  requestCancellation(runId: string): DeploymentRun {
    return this.store.requestCancellation(runId, this.now());
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  private schedule(runId: string, allowRecovery: boolean): Promise<DeploymentRun> {
    if (!this.accepting || this.stopping) {
      return Promise.reject(new DeploymentRunnerStoppedError("runner is not accepting work"));
    }
    const present = this.active.get(runId);
    if (present) return present.promise;
    const controller = new AbortController();
    const promise = this.executeRun(runId, controller.signal, allowRecovery)
      .finally(() => this.active.delete(runId));
    this.active.set(runId, { controller, promise });
    return promise;
  }

  private authority(runId: string): RunAuthority {
    const run = this.store.getRun(runId);
    if (run.runKind !== "deployment" || !run.planId || run.planRevision === null || !run.planDigest || !run.approvalId) {
      throw new DeploymentRunnerError("runner only executes approved deployment runs");
    }
    const plan = this.store.getPlan(run.planId, run.planRevision);
    const approval = this.store.getApproval(run.approvalId);
    if (
      plan.digest !== run.planDigest ||
      approval.planId !== plan.planId ||
      approval.planRevision !== plan.revision ||
      approval.planDigest !== plan.digest ||
      approval.risk !== plan.risk ||
      run.projectId !== plan.projectId ||
      run.environmentId !== plan.environmentId ||
      run.operation !== plan.operation
    ) {
      throw new DeploymentStalePlanError("durable plan authority does not match the run");
    }

    const steps = this.store.listRunSteps(run.runId);
    const actions = plan.actions.filter((action) => action.sideEffecting);
    if (steps.length !== actions.length) throw new DeploymentRunnerError("durable run steps do not match plan actions");
    for (const action of actions) {
      const step = steps.find((candidate) => candidate.stepId === action.actionId);
      if (!step || step.actionDigest !== action.actionDigest || step.adapterKind !== action.kind) {
        throw new DeploymentRunnerError(`durable step does not match action ${action.actionId}`);
      }
    }
    const lockKeys = planLockKeys(plan);
    if (steps.length && !lockKeys.length) throw new DeploymentRunnerError("a side-effecting plan has no target locks");
    return { run, plan, approval, steps, lockKeys };
  }

  private preflightAdapters(plan: DeploymentPlan): void {
    for (const action of plan.actions) {
      if (!/^[-a-z0-9]+@\d+$/.test(action.kind)) {
        throw new DeploymentRunnerError(`plan action is not explicitly versioned: ${action.kind}`);
      }
      const adapter = this.adapters.get(action.kind);
      if (!adapter) throw new DeploymentRunnerError(`no adapter is installed for ${action.kind}`);
      if (action.sideEffecting && (!adapter.submit || !adapter.observe)) {
        throw new DeploymentRunnerError(`side-effect adapter ${action.kind} lacks submit or observe`);
      }
      if (!action.sideEffecting && !adapter.check) {
        throw new DeploymentRunnerError(`read-only adapter ${action.kind} lacks check`);
      }
    }
  }

  private assertFreshAuthority(authority: RunAuthority): void {
    const now = this.now();
    if (authority.plan.blocked) throw new DeploymentStalePlanError("approved plan is blocked");
    if (authority.plan.supersededAt !== null) throw new DeploymentStalePlanError("approved plan was superseded");
    if (authority.plan.expiresAt <= now || authority.approval.expiresAt <= now) {
      throw new DeploymentStalePlanError("approved plan or authority expired");
    }
  }

  private async exactRecheck(
    authority: RunAuthority,
    checkpoint: PlanRecheckContext["checkpoint"],
    action: DeploymentPlanAction | null,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertFreshAuthority(authority);
    const result = await this.recheckPlan({
      run: this.store.getRun(authority.run.runId),
      plan: authority.plan,
      approval: authority.approval,
      expectedLockKeys: authority.lockKeys,
      checkpoint,
      action,
      signal,
    });
    if (!result.ok) throw new DeploymentStalePlanError(result.reason || "plan recheck failed");
    const observedKeys = sortedUnique(result.lockKeys, "rechecked lock set");
    if (result.planDigest !== authority.plan.digest || !sameStrings(observedKeys, authority.lockKeys)) {
      throw new DeploymentStalePlanError("plan digest or target lock set changed during recheck");
    }
  }

  private adapterContext(
    runId: string,
    plan: DeploymentPlan,
    action: DeploymentPlanAction,
    step: DeploymentRunStep | null,
    signal: AbortSignal,
  ): DeploymentAdapterContext {
    return {
      run: this.store.getRun(runId),
      plan,
      action,
      step,
      idempotencyKey: step?.idempotencyKey ?? null,
      externalId: step?.externalId ?? null,
      signal,
    };
  }

  private emit(
    runId: string,
    type: string,
    phase: string,
    level: "info" | "warning" | "error",
    message: string,
    fields: Record<string, JsonValue> = {},
  ): void {
    const at = this.now();
    try {
      this.store.appendEvent({
        runId,
        at,
        type,
        phase,
        level,
        message,
        data: { schema: DEPLOYMENT_RUNNER_EVENT_SCHEMA, ...fields },
      });
    } catch {
      try {
        this.store.markAuditDegraded(runId, at);
      } catch {
        // The state machine must remain fail-closed even if its audit sink is
        // degraded. The durable annotation is best-effort after the first error.
      }
    }
  }

  private move(
    runId: string,
    state: DeploymentRunState,
    phase: string,
    recoveryReason: string | null = null,
  ): DeploymentRun {
    const current = this.store.getRun(runId);
    if (TERMINAL_RUN_STATES.has(current.state)) return current;
    if (current.state === state && (state !== "recovery-required" || current.recoveryReason === recoveryReason)) {
      return current;
    }
    return this.store.transitionRun({
      runId,
      expectedStates: [current.state],
      state,
      phase,
      at: this.now(),
      recoveryReason,
    });
  }

  private async acquireLocks(
    authority: RunAuthority,
    signal: AbortSignal,
    effectAlreadyStarted: boolean,
  ): Promise<void> {
    if (!authority.lockKeys.length) return;
    const existing = this.store.locksForRun(authority.run.runId);
    if (effectAlreadyStarted && !existing.length) {
      throw new DeploymentRecoveryRequiredError("an in-flight effect has no durable target lease");
    }
    if (existing.length) {
      const present = existing.map((lock) => lock.lockKey).sort();
      if (!sameStrings(present, authority.lockKeys)) {
        throw new DeploymentRecoveryRequiredError("the run's durable target lease set is incomplete");
      }
    }

    this.move(authority.run.runId, "acquiring-locks", "acquiring-locks");
    while (true) {
      if (signal.aborted) throw signal.reason ?? new DeploymentRunnerStoppedError("runner stopped");
      if (!effectAlreadyStarted) this.assertFreshAuthority(authority);
      const now = this.now();
      const claimed = this.store.claimTargetLocks({
        runId: authority.run.runId,
        bootId: this.bootId,
        lockKeys: authority.lockKeys,
        now,
        leaseExpiresAt: now + this.lockLeaseMs,
      });
      if (claimed.acquired) {
        this.emit(authority.run.runId, "locks-acquired", "acquiring-locks", "info", "Target locks acquired", {
          lockCount: authority.lockKeys.length,
        });
        return;
      }

      for (const lock of claimed.expired) {
        const observed = await this.observeExpiredLock({
          lock,
          nextRun: this.store.getRun(authority.run.runId),
          plan: authority.plan,
          signal,
        });
        if (!observed.safeToRecover) {
          throw new DeploymentRecoveryRequiredError(observed.reason || "expired target lock could not be classified");
        }
        const observedAt = this.now();
        this.store.recoverExpiredTargetLock({
          lockKey: lock.lockKey,
          expectedOwnerRunId: lock.ownerRunId,
          expectedOwnerBootId: lock.ownerBootId,
          newOwnerRunId: authority.run.runId,
          newOwnerBootId: this.bootId,
          observedAt,
          leaseExpiresAt: observedAt + this.lockLeaseMs,
        });
        this.emit(authority.run.runId, "expired-lock-recovered", "acquiring-locks", "warning", "Expired target lock recovered after observation", {
          lockKey: lock.lockKey,
          previousRunId: lock.ownerRunId,
        });
      }

      const live = claimed.contended.filter((lock) => lock.leaseExpiresAt > now);
      if (live.length) {
        this.emit(authority.run.runId, "lock-contended", "acquiring-locks", "info", "Waiting for a target lock", {
          lockCount: live.length,
        });
        const firstExpiry = Math.min(...live.map((lock) => lock.leaseExpiresAt));
        await this.sleep(Math.max(10, Math.min(this.lockPollMs, firstExpiry - now)), signal);
      }
    }
  }

  private heartbeat(runId: string, lockKeys: readonly string[]): { stop(): void; failure(): Error | null } {
    let failed: Error | null = null;
    if (!lockKeys.length) return { stop() {}, failure: () => null };
    const interval = setInterval(() => {
      if (failed || this.stopping) return;
      const now = this.now();
      try {
        this.store.heartbeatTargetLocks({
          runId,
          bootId: this.bootId,
          lockKeys,
          now,
          leaseExpiresAt: now + this.lockLeaseMs,
        });
      } catch (error) {
        failed = error instanceof Error ? error : new Error("target lock heartbeat failed");
        this.emit(runId, "lock-heartbeat-failed", "locks", "error", "Target lock ownership could not be renewed");
      }
    }, Math.max(100, Math.floor(this.lockLeaseMs / 3)));
    interval.unref?.();
    return { stop: () => clearInterval(interval), failure: () => failed };
  }

  private assertHeartbeat(heartbeat: ReturnType<DeploymentRunner["heartbeat"]>): void {
    if (heartbeat.failure()) throw new DeploymentRecoveryRequiredError("target lock ownership changed");
  }

  private async checkAction(
    runId: string,
    plan: DeploymentPlan,
    action: DeploymentPlanAction,
    adapter: DeploymentActionAdapter,
    signal: AbortSignal,
    effectsStarted: boolean,
  ): Promise<void> {
    this.move(runId, actionState(action), action.phase);
    let attempts = 0;
    while (true) {
      if (signal.aborted) throw signal.reason ?? new DeploymentRunnerStoppedError("runner stopped");
      let observation: AdapterObservation;
      try {
        observation = validateObservation(await adapter.check!(this.adapterContext(runId, plan, action, null, signal)));
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        if (effectsStarted) throw new DeploymentRecoveryRequiredError("post-mutation observation failed");
        throw new DeploymentAdapterFailedError(`read-only adapter failed: ${errorName(error)}`);
      }
      if (observation.outcome === "succeeded") {
        this.emit(runId, "action-checked", action.phase, "info", "Read-only action passed", {
          actionId: action.actionId,
          result: storedObservation(observation, this.now()),
        });
        return;
      }
      if (observation.outcome === "pending" && ++attempts < this.maxObservationAttempts) {
        await this.sleep(this.observationPollMs, signal);
        continue;
      }
      if (observation.outcome === "unknown" || observation.outcome === "pending") {
        if (effectsStarted) throw new DeploymentRecoveryRequiredError("post-mutation result is inconclusive");
        throw new DeploymentAdapterFailedError("precondition result is inconclusive");
      }
      throw new DeploymentAdapterFailedError(`read-only action ${action.actionId} did not pass`);
    }
  }

  private transitionObserved(
    step: DeploymentRunStep,
    observation: AdapterObservation,
  ): DeploymentRunStep {
    if (step.state === "observed") return step;
    if (step.state !== "submitted" && step.state !== "recovery-required") {
      throw new DeploymentRunnerError(`step ${step.stepId} cannot record an observation from ${step.state}`);
    }
    return this.store.transitionRunStep({
      runId: step.runId,
      ordinal: step.ordinal,
      expectedState: step.state,
      state: "observed",
      at: this.now(),
      externalId: observation.externalId ?? step.externalId,
      result: storedObservation(observation, this.now()),
    });
  }

  private async observeStep(
    plan: DeploymentPlan,
    action: DeploymentPlanAction,
    adapter: DeploymentActionAdapter,
    initialStep: DeploymentRunStep,
    initialObservation: AdapterObservation | null,
    signal: AbortSignal,
  ): Promise<StepOutcome> {
    let step = initialStep;
    let observation = initialObservation;
    let attempts = 0;
    let cancellationSent = false;

    while (true) {
      if (signal.aborted) {
        if (adapter.execution === "remote") throw new DeploymentRunnerDetachError("remote action remains observable");
        throw new DeploymentRecoveryRequiredError("local action was interrupted after submission");
      }
      const run = this.store.getRun(step.runId);
      if (run.cancellationRequestedAt !== null && !cancellationSent && adapter.requestCancellation) {
        try {
          await adapter.requestCancellation(this.adapterContext(step.runId, plan, action, step, signal));
          this.emit(step.runId, "cancellation-forwarded", action.phase, "warning", "Cancellation was forwarded to the executor", {
            actionId: action.actionId,
          });
        } catch {
          this.emit(step.runId, "cancellation-forward-failed", action.phase, "warning", "Executor cancellation request was not confirmed", {
            actionId: action.actionId,
          });
        }
        cancellationSent = true;
      }

      if (!observation) {
        try {
          observation = validateObservation(await adapter.observe!(this.adapterContext(step.runId, plan, action, step, signal)));
        } catch (error) {
          if (signal.aborted) continue;
          throw new DeploymentRecoveryRequiredError(`submitted action could not be observed: ${errorName(error)}`);
        }
      }

      if (observation.outcome === "not-submitted") {
        throw new DeploymentRecoveryRequiredError("provider reports no accepted effect; an operator must classify the submission");
      }
      if (observation.outcome === "unknown") {
        if (step.state === "submitted" || step.state === "observed") {
          step = this.store.transitionRunStep({
            runId: step.runId,
            ordinal: step.ordinal,
            expectedState: step.state,
            state: "recovery-required",
            at: this.now(),
            externalId: observation.externalId ?? step.externalId,
            result: storedObservation(observation, this.now()),
          });
        }
        throw new DeploymentRecoveryRequiredError("provider outcome is unknown");
      }

      step = this.transitionObserved(step, observation);
      this.move(step.runId, "observing-result", action.phase);
      if (observation.outcome === "pending") {
        if (++attempts >= this.maxObservationAttempts) {
          step = this.store.transitionRunStep({
            runId: step.runId,
            ordinal: step.ordinal,
            expectedState: "observed",
            state: "recovery-required",
            at: this.now(),
            result: storedObservation({ outcome: "unknown", data: { reason: "observation-limit" } }, this.now()),
          });
          throw new DeploymentRecoveryRequiredError("executor remained pending beyond the observation limit");
        }
        await this.sleep(this.observationPollMs, signal);
        step = this.store.listRunSteps(step.runId).find((candidate) => candidate.ordinal === step.ordinal)!;
        observation = null;
        continue;
      }

      if (observation.outcome === "failed") {
        this.store.transitionRunStep({
          runId: step.runId,
          ordinal: step.ordinal,
          expectedState: "observed",
          state: "failed",
          at: this.now(),
          result: storedObservation(observation, this.now()),
        });
        throw new DeploymentAdapterFailedError(`executor action ${action.actionId} failed`);
      }

      if (observation.outcome === "cancelled") {
        this.store.transitionRunStep({
          runId: step.runId,
          ordinal: step.ordinal,
          expectedState: "observed",
          state: "completed",
          at: this.now(),
          result: storedObservation(observation, this.now()),
        });
        return { outcome: "cancelled" };
      }

      this.store.transitionRunStep({
        runId: step.runId,
        ordinal: step.ordinal,
        expectedState: "observed",
        state: "completed",
        at: this.now(),
        result: storedObservation(observation, this.now()),
      });
      return { outcome: observation.outcome === "rolled-back" ? "rolled-back" : "succeeded" };
    }
  }

  private async effectAction(
    runId: string,
    plan: DeploymentPlan,
    action: DeploymentPlanAction,
    adapter: DeploymentActionAdapter,
    startingStep: DeploymentRunStep,
    signal: AbortSignal,
  ): Promise<StepOutcome> {
    let step = startingStep;
    if (step.state === "completed") {
      const outcome = storedOutcome(step.result);
      return { outcome: outcome === "rolled-back" ? "rolled-back" : outcome === "cancelled" ? "cancelled" : "succeeded" };
    }
    if (step.state === "failed") throw new DeploymentAdapterFailedError(`executor action ${action.actionId} previously failed`);
    if (step.state === "cancelled") return { outcome: "cancelled" };

    if (step.state === "recovery-required") {
      this.emit(runId, "recovery-observation-started", action.phase, "warning", "Recovery observation started", {
        actionId: action.actionId,
      });
      return this.observeStep(plan, action, adapter, step, null, signal);
    }
    if (step.state === "submitted" || step.state === "observed") {
      this.emit(runId, "executor-reattached", action.phase, "info", "Reattached to a submitted action", {
        actionId: action.actionId,
      });
      return this.observeStep(plan, action, adapter, step, null, signal);
    }
    if (step.state !== "prepared") throw new DeploymentRunnerError(`unsupported durable step state: ${step.state}`);
    if (signal.aborted) throw signal.reason ?? new DeploymentRunnerStoppedError("runner stopped");

    this.move(runId, actionState(action), action.phase);
    step = this.store.transitionRunStep({
      runId,
      ordinal: step.ordinal,
      expectedState: "prepared",
      state: "submitted",
      at: this.now(),
      // The correlation/idempotency key is known before provider contact. A
      // later observation replaces this with a provider-native identifier.
      externalId: step.idempotencyKey,
      result: {
        schema: DEPLOYMENT_ADAPTER_RESULT_SCHEMA,
        outcome: "pending",
        observedAt: null,
        data: { submissionIntent: true },
      },
    });
    this.move(runId, "waiting-executor", action.phase);
    this.emit(runId, "action-submitted", action.phase, "info", "Durable submission intent recorded", {
      actionId: action.actionId,
      idempotencyKey: step.idempotencyKey,
    });

    let submitted: AdapterObservation | null = null;
    try {
      submitted = validateObservation(await adapter.submit!(this.adapterContext(runId, plan, action, step, signal)));
    } catch (error) {
      if (signal.aborted) {
        if (adapter.execution === "remote") throw new DeploymentRunnerDetachError("remote submission may still be running");
        throw new DeploymentRecoveryRequiredError("local submission was interrupted");
      }
      this.emit(runId, "submission-response-lost", action.phase, "warning", "Submission response was not conclusive; observing by idempotency key", {
        actionId: action.actionId,
        errorType: errorName(error),
      });
    }

    if (submitted?.outcome === "not-submitted" && submitted.retrySafe) {
      // The provider adapter has conclusively attested that no request exists.
      // One retry uses the same durable idempotency key and cannot create a
      // second logical action.
      this.emit(runId, "submission-retry", action.phase, "warning", "Provider confirmed no accepted request; retrying once", {
        actionId: action.actionId,
      });
      try {
        submitted = validateObservation(await adapter.submit!(this.adapterContext(runId, plan, action, step, signal)));
      } catch {
        submitted = null;
      }
    }
    if (submitted?.outcome === "not-submitted") submitted = null;
    return this.observeStep(plan, action, adapter, step, submitted, signal);
  }

  private cancelPreparedSteps(runId: string): void {
    for (const step of this.store.listRunSteps(runId)) {
      if (step.state !== "prepared") continue;
      try {
        this.store.transitionRunStep({
          runId,
          ordinal: step.ordinal,
          expectedState: "prepared",
          state: "cancelled",
          at: this.now(),
          result: { schema: DEPLOYMENT_ADAPTER_RESULT_SCHEMA, outcome: "cancelled", data: { submitted: false } },
        });
      } catch (error) {
        if (!(error instanceof DeploymentTransitionError)) throw error;
      }
    }
  }

  private terminal(runId: string, state: Extract<DeploymentRunState,
    "succeeded" | "failed" | "cancelled" | "interrupted" | "stale-plan" | "rolled-back">,
    reason: string,
    data: Record<string, JsonValue> = {},
  ): DeploymentRun {
    if (state !== "succeeded" && state !== "rolled-back") this.cancelPreparedSteps(runId);
    const run = this.move(runId, state, "complete", null);
    this.emit(runId, `run-${state}`, "complete", state === "failed" ? "error" : state === "stale-plan" ? "warning" : "info", reason, {
      state,
      ...data,
    });
    try {
      this.store.releaseTargetLocks(runId, this.bootId);
    } catch (error) {
      if (!(error instanceof DeploymentConflictError)) throw error;
      this.emit(runId, "lock-release-skipped", "complete", "warning", "Some target locks are owned by another boot and were retained");
    }
    return run;
  }

  private async executeRun(runId: string, signal: AbortSignal, allowRecovery: boolean): Promise<DeploymentRun> {
    let heartbeat: ReturnType<DeploymentRunner["heartbeat"]> | null = null;
    let authority: RunAuthority | null = null;
    let effectStarted = false;
    try {
      authority = this.authority(runId);
      if (TERMINAL_RUN_STATES.has(authority.run.state)) return authority.run;
      if (authority.run.state === "recovery-required" && !allowRecovery) return authority.run;
      this.preflightAdapters(authority.plan);
      effectStarted = hasEffectStarted(authority.steps);

      if (!effectStarted) {
        if (authority.run.cancellationRequestedAt !== null) {
          throw new DeploymentCancelledBeforeMutationError("cancelled before mutation");
        }
        await this.exactRecheck(authority, "before-locks", null, signal);
      }
      await this.acquireLocks(authority, signal, effectStarted);
      heartbeat = this.heartbeat(runId, authority.lockKeys);
      this.assertHeartbeat(heartbeat);

      if (!effectStarted) {
        this.move(runId, "checking-preconditions", "checking-preconditions");
        await this.exactRecheck(authority, "after-locks", null, signal);
      }
      this.emit(runId, allowRecovery ? "run-recovery-started" : "run-started", "checking-preconditions", "info", allowRecovery ? "Manual recovery started" : "Deployment execution started");

      let cancelled = false;
      let rolledBack = false;
      const stepsById = new Map(this.store.listRunSteps(runId).map((step) => [step.stepId, step]));
      for (const action of authority.plan.actions) {
        this.assertHeartbeat(heartbeat);
        let currentRun = this.store.getRun(runId);
        const adapter = this.adapters.get(action.kind)!;
        const currentStep = action.sideEffecting ? stepsById.get(action.actionId)! : null;

        if (currentRun.cancellationRequestedAt !== null && !effectStarted) {
          throw new DeploymentCancelledBeforeMutationError("cancelled before mutation");
        }
        if (action.sideEffecting && currentStep?.state === "prepared") {
          if (currentRun.cancellationRequestedAt !== null) {
            this.store.transitionRunStep({
              runId,
              ordinal: currentStep.ordinal,
              expectedState: "prepared",
              state: "cancelled",
              at: this.now(),
              result: { schema: DEPLOYMENT_ADAPTER_RESULT_SCHEMA, outcome: "cancelled", data: { submitted: false } },
            });
            cancelled = true;
            continue;
          }
          await this.exactRecheck(authority, "before-action", action, signal);
        }

        if (!action.sideEffecting) {
          // Read-only checks are safe to repeat after a restart. They stay in
          // plan order so post-activation verification cannot run early.
          await this.checkAction(runId, authority.plan, action, adapter, signal, effectStarted);
          continue;
        }

        if (!currentStep) throw new DeploymentRunnerError(`missing durable step for ${action.actionId}`);
        const outcome = await this.effectAction(runId, authority.plan, action, adapter, currentStep, signal);
        const refreshed = this.store.listRunSteps(runId).find((step) => step.stepId === action.actionId)!;
        stepsById.set(action.actionId, refreshed);
        effectStarted = effectStarted || EFFECT_STARTED_STATES.has(refreshed.state);
        if (outcome.outcome === "cancelled") cancelled = true;
        if (outcome.outcome === "rolled-back") rolledBack = true;
        currentRun = this.store.getRun(runId);
        if (currentRun.cancellationRequestedAt !== null && outcome.outcome !== "succeeded") cancelled = true;
      }

      if (rolledBack || authority.plan.operation === "rollback") {
        return this.terminal(runId, "rolled-back", "Rollback completed and was observed");
      }
      if (cancelled) return this.terminal(runId, "cancelled", "Cancellation completed and the resulting state was observed");
      return this.terminal(runId, "succeeded", "Deployment completed and was observed");
    } catch (error) {
      const current = this.store.getRun(runId);
      if (TERMINAL_RUN_STATES.has(current.state)) return current;
      if (error instanceof DeploymentCancelledBeforeMutationError) {
        return this.terminal(runId, "cancelled", "Deployment was cancelled before provider submission");
      }
      if (error instanceof DeploymentStalePlanError) {
        return this.terminal(runId, "stale-plan", "The exact approved plan is no longer executable");
      }
      if (error instanceof DeploymentRunnerDetachError) {
        this.move(runId, "interrupting", "interrupting", "remote executor will be reattached on startup");
        this.emit(runId, "run-detached", "interrupting", "warning", "PSM stopped while a remote action remained observable");
        return this.store.getRun(runId);
      }
      if (error instanceof DeploymentRecoveryRequiredError) {
        const run = this.move(runId, "recovery-required", "recovery-required", error.message.slice(0, 500));
        this.emit(runId, "recovery-required", "recovery-required", "error", "A side effect requires observation before execution can continue");
        return run;
      }
      if (error instanceof DeploymentRunnerStoppedError || signal.aborted) {
        const submitted = this.store.listRunSteps(runId).some((step) => step.state === "submitted" || step.state === "observed" || step.state === "recovery-required");
        if (submitted || effectStarted) {
          const run = this.move(runId, "recovery-required", "recovery-required", "runner stopped after provider submission");
          this.emit(runId, "recovery-required", "recovery-required", "error", "Runner stopped after a provider submission; observation is required");
          return run;
        }
        return this.terminal(runId, "interrupted", "Runner stopped before provider submission");
      }

      const submitted = this.store.listRunSteps(runId).some((step) => step.state === "submitted" || step.state === "observed" || step.state === "recovery-required");
      if (submitted && !(error instanceof DeploymentAdapterFailedError)) {
        const run = this.move(runId, "recovery-required", "recovery-required", "execution failed after provider submission");
        this.emit(runId, "recovery-required", "recovery-required", "error", "Execution failed after submission; provider state must be observed", {
          errorType: errorName(error),
        });
        return run;
      }
      return this.terminal(runId, "failed", "Deployment failed before a successful observed completion", {
        errorType: errorName(error),
        // Bounded, and never a provider response: adapters return redacted
        // observations, and what reaches here is the runner's own refusal.
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    } finally {
      heartbeat?.stop();
    }
  }

  /** Stop taking jobs and detach/interrupt active work without inventing an outcome. */
  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.accepting = false;
    const reason = new DeploymentRunnerStoppedError("deployment runner is shutting down");
    for (const active of this.active.values()) active.controller.abort(reason);

    const work = Promise.allSettled([...this.active.values()].map((active) => active.promise));
    if (this.shutdownGraceMs > 0) {
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.shutdownGraceMs);
          timer.unref?.();
        }),
      ]);
    }
    await Promise.allSettled(
      [...this.adapters.values()].filter((adapter) => adapter.shutdown).map((adapter) => adapter.shutdown!()),
    );
  }
}
