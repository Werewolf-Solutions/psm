import { externalPreparationItems, externalPreparationMessage, repositoryRepairItems } from "./readiness.ts";
import type { SourcePublicationController } from "./source-publication.ts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { db } from "../db.ts";
import type { ArtifactPreparationController, DeploymentRunController } from "./api.ts";
import type { DeploymentService } from "./service.ts";
import type { DeploymentPlanDocument } from "./planner.ts";

export type PreparationState = "running" | "waiting-input" | "awaiting-approval" | "blocked" | "succeeded" | "cancelled";
export interface PreparationJob {
  id: string;
  projectId: string;
  environmentId: string;
  state: PreparationState;
  phase: "check" | "repair" | "publish" | "build" | "infrastructure";
  message: string;
  createdAt: number;
  updatedAt: number;
  workroomId: string | null;
  waitingForRepair: boolean;
  /** This preparation has already asked its AI room to diagnose external blockers. */
  diagnosedExternal?: boolean;
  repairs: number;
  runId: string | null;
  planId: string | null;
  publicationId?: string | null;
  /** Why a blocked job is blocked, when psm can tell on its own that the cause has gone. */
  blockedBy?: "capabilities" | "checkout" | "external" | null;
  failure: string | null;
  /** Which AI clears the steps psm cannot do alone. Null means the project's own. */
  engine: string | null;
  model: string | null;
  effort: string | null;
}
export type ReadinessResult = Awaited<ReturnType<DeploymentService["checkReadiness"]>>;
export interface PreparationRepairer {
  start(job: PreparationJob, checked: ReadinessResult, purpose?: "repair" | "diagnose-external"): Promise<string>;
  status(roomId: string): { busy: boolean; question: boolean };
  stop(roomId: string): void;
}

export class PreparationRepository {
  constructor(private readonly database: () => DatabaseSync = db) {}
  get(projectId: string, environmentId: string): PreparationJob | null {
    const row = this.database().prepare("SELECT document FROM deployment_preparations WHERE project_id = ? AND environment_id = ?").get(projectId, environmentId) as { document: string } | undefined;
    return row ? JSON.parse(row.document) as PreparationJob : null;
  }
  save(job: PreparationJob): void {
    this.database().prepare("INSERT INTO deployment_preparations VALUES (?, ?, ?) ON CONFLICT(project_id, environment_id) DO UPDATE SET document = excluded.document")
      .run(job.projectId, job.environmentId, JSON.stringify(job));
  }
  forProject(projectId: string): PreparationJob[] {
    return (this.database().prepare("SELECT document FROM deployment_preparations WHERE project_id = ?").all(projectId) as { document: string }[])
      .map((row) => JSON.parse(row.document) as PreparationJob);
  }
  all(): PreparationJob[] {
    return (this.database().prepare("SELECT document FROM deployment_preparations").all() as { document: string }[])
      .map((row) => JSON.parse(row.document) as PreparationJob);
  }
  active(): PreparationJob[] {
    return (this.database().prepare("SELECT document FROM deployment_preparations").all() as { document: string }[])
      .map((row) => JSON.parse(row.document) as PreparationJob).filter(preparationActive);
  }
}
export function preparationActive(job: PreparationJob): boolean {
  return ["running", "waiting-input", "awaiting-approval"].includes(job.state);
}

/** What the cockpit polls: the job's own state, with nothing the page cannot act on. */
export function preparationView(job: PreparationJob | null): Record<string, unknown> | null {
  if (!job) return null;
  return {
    id: job.id,
    state: job.state,
    phase: job.phase,
    message: job.message,
    active: preparationActive(job),
    workroomId: job.workroomId,
    runId: job.runId,
    planId: job.planId,
    publicationId: job.publicationId ?? null,
    blockedBy: job.blockedBy ?? null,
    failure: job.failure,
    engine: job.engine,
    model: job.model,
    effort: job.effort,
    repairs: job.repairs,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/** Coordinates existing work sessions/builds. Infrastructure ALWAYS uses the existing reviewed approval API. */
export class DeploymentPreparationController {
  private readonly advancing = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private sweep: ReturnType<typeof setInterval> | null = null;
  readonly repository: PreparationRepository;
  constructor(readonly options: {
    service: DeploymentService;
    preparer: ArtifactPreparationController;
    publisher?: SourcePublicationController;
    runner: DeploymentRunController;
    repairs: PreparationRepairer;
    repository?: PreparationRepository;
    reviewCapabilities?: (projectId: string, engine: string | null, workroomId?: string | null) => string | null;
    /** Checkout problems no grant can fix: staged operator work, a detached HEAD, no usable Git identity. */
    reviewCheckout?: (projectId: string) => string | null;
    repairConnections?: (projectId: string, environmentId: string) => Promise<void>;
    /**
     * Approve this exact plan under a standing rule, when one covers it, and
     * return the queued run. Null means the plan waits for an operator review.
     */
    standingApproval?: (input: { projectId: string; environmentId: string; planId: string }) => Promise<{ runId: string; reason: string } | null>;
    background?: boolean;
  }) { this.repository = options.repository ?? new PreparationRepository(); }
  private key(projectId: string, environmentId: string): string { return `${projectId}/${environmentId}`; }
  current(projectId: string, environmentId: string): PreparationJob | null { return this.repository.get(projectId, environmentId); }
  /**
   * Start, or rejoin, this deployment's preparation.
   *
   * `ai` is how a stalled preparation gets moving again on a different provider:
   * a room whose engine has hit its usage window is not a reason to abandon the
   * work, so the choice is re-read on every press and applied to the room the
   * next repair uses.
   */
  start(projectId: string, environmentId: string, ai: { engine?: string | null; model?: string | null; effort?: string | null } = {}): PreparationJob {
    const previous = this.current(projectId, environmentId);
    if (previous && preparationActive(previous)) { this.schedule(previous); return previous; }
    const now = Date.now();
    const job: PreparationJob = {
      id: `prep_${randomUUID()}`, projectId, environmentId,
      state: "running", phase: "check", message: "Checking and preparing this deployment…",
      createdAt: now, updatedAt: now, workroomId: previous?.workroomId ?? null,
      waitingForRepair: false, repairs: 0, runId: null, planId: null, failure: null, blockedBy: null,
      diagnosedExternal: false,
      engine: ai.engine ?? previous?.engine ?? null,
      model: ai.model ?? (ai.engine ? null : previous?.model ?? null),
      effort: ai.effort ?? (ai.engine ? null : previous?.effort ?? null),
    };
    this.repository.save(job); this.schedule(job); return job;
  }
  /** Restart does not silently resume mutation authority; the user resumes with the button. */
  recover(): void {
    for (const job of this.repository.active()) {
      job.state = "blocked"; job.message = "The agent restarted. Resume preparation to recheck its current state.";
      this.repository.save(job);
    }
  }
  /**
   * Continue the preparations that stopped only because their grants or their
   * checkout were not ready, once they are.
   *
   * A job blocked this way waits on a condition, not a decision: grants given in
   * the local cockpit, or a checkout fixed by hand (unstaged work, an attached
   * branch, an identity Git can commit with). Each job is rechecked in the order a
   * repair checks it — grants, then the checkout — so the banner names the problem
   * that is actually left, including for a job saved under an older rule. One now
   * clear continues where it stopped: the attempt budget carries over, and the
   * two-hour window restarts because waiting on the operator is not unattended
   * work. A job interrupted mid-work by an agent restart is not blocked this way,
   * so it still waits for the button.
   */
  recheckBlocked(projectId?: string): PreparationJob[] {
    const resumed: PreparationJob[] = [];
    for (const job of projectId ? this.repository.forProject(projectId) : this.repository.all()) {
      if (job.state !== "blocked" || (job.blockedBy !== "capabilities" && job.blockedBy !== "checkout")) continue;
      let blockedBy: "capabilities" | "checkout" = job.blockedBy;
      let gap: string | null;
      try {
        gap = this.options.reviewCapabilities?.(job.projectId, job.engine, job.workroomId) ?? null;
        if (gap) blockedBy = "capabilities";
        else {
          gap = this.options.reviewCheckout?.(job.projectId) ?? null;
          if (gap) blockedBy = "checkout";
        }
      } catch (error) {
        gap = error instanceof Error ? error.message : "Check this project before resuming preparation.";
      }
      if (gap) {
        // Only a real change is written, so a periodic recheck does not churn the job.
        if (gap !== job.message || blockedBy !== job.blockedBy) { job.message = gap; job.blockedBy = blockedBy; this.save(job); }
        continue;
      }
      job.blockedBy = null; job.state = "running"; job.phase = "check"; job.createdAt = Date.now();
      job.message = "Grants and checkout are ready. Resuming preparation…";
      this.save(job); this.schedule(job); resumed.push(job);
    }
    return resumed;
  }
  /** A grant change is one recheck, scoped to the project whose grants moved. */
  capabilitiesChanged(projectId: string): PreparationJob[] { return this.recheckBlocked(projectId); }
  /**
   * Recheck blocked jobs now, then every `intervalMs`. The first pass corrects a
   * job saved before this process started; later passes notice a checkout fixed
   * outside psm, which raises no event psm could hear.
   */
  watchBlocked(intervalMs = 10_000): void {
    if (this.stopped || this.options.background === false || this.sweep) return;
    const tick = () => { try { this.recheckBlocked(); } catch { /* the next pass tries again */ } };
    tick();
    this.sweep = setInterval(tick, intervalMs);
    this.sweep.unref();
  }
  close(): void {
    this.stopped = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear();
    if (this.sweep) clearInterval(this.sweep); this.sweep = null;
  }
  async cancel(projectId: string, environmentId: string): Promise<PreparationJob | null> {
    const job = this.current(projectId, environmentId);
    // A job waiting on grants or its checkout is not active, but it is armed:
    // fixing either would start it again. Stopping has to reach it, or the only
    // way to decline is to leave the problem unfixed.
    if (!job || !(preparationActive(job) || job.blockedBy === "capabilities" || job.blockedBy === "checkout")) return job;
    job.state = "cancelled"; job.blockedBy = null; job.message = "Preparation stopped.";
    this.save(job);
    if (job.publicationId) this.options.publisher?.cancel(job.publicationId);
    if (job.workroomId) this.options.repairs.stop(job.workroomId);
    if (job.runId) await this.options.runner.cancel(job.runId);
    return job;
  }
  private save(job: PreparationJob): void {
    const current = this.current(job.projectId, job.environmentId);
    if (current && (current.id !== job.id || current.state === "cancelled")) return;
    job.updatedAt = Date.now(); this.repository.save(job);
  }
  private schedule(job: PreparationJob): void {
    if (this.stopped || this.options.background === false || !preparationActive(job)) return;
    const key = this.key(job.projectId, job.environmentId);
    if (this.timers.has(key)) return;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.advance(job.projectId, job.environmentId).finally(() => {
        const current = this.current(job.projectId, job.environmentId);
        if (current) this.schedule(current);
      });
    }, 1500);
    timer.unref(); this.timers.set(key, timer);
  }
  async advance(projectId: string, environmentId: string): Promise<void> {
    const key = this.key(projectId, environmentId);
    const pending = this.advancing.get(key);
    if (pending) return pending;
    const work = this.step(projectId, environmentId).catch((error: unknown) => {
      const job = this.current(projectId, environmentId);
      if (job && preparationActive(job)) {
        job.state = "blocked";
        job.message = error instanceof Error ? error.message : "Preparation failed. Check the preparation session.";
        this.save(job);
      }
    });
    this.advancing.set(key, work);
    try { await work; } finally { this.advancing.delete(key); }
  }
  private live(job: PreparationJob): boolean {
    const current = this.current(job.projectId, job.environmentId);
    return !this.stopped && !!current && current.id === job.id && preparationActive(current);
  }
  private async repair(job: PreparationJob, checked: ReadinessResult): Promise<void> {
    if (!this.live(job)) return;
    const permissionGap = this.options.reviewCapabilities?.(job.projectId, job.engine, job.workroomId);
    if (permissionGap) {
      job.state = "blocked"; job.phase = "check"; job.blockedBy = "capabilities"; job.message = permissionGap;
      this.save(job); return;
    }
    // Asked only once grants are in place: the preflight reads the checkout with
    // them. No grant fixes what it finds, so the job waits on the checkout
    // instead, and the recheck resumes it once someone fixes it.
    const checkoutGap = this.options.reviewCheckout?.(job.projectId);
    if (checkoutGap) {
      job.state = "blocked"; job.phase = "check"; job.blockedBy = "checkout"; job.message = checkoutGap;
      this.save(job); return;
    }
    if (job.repairs >= 3) {
      job.state = "blocked"; job.message = "Preparation needs more information. Open its session to review the remaining problem, then retry.";
      this.save(job); return;
    }
    job.phase = "repair"; job.state = "running"; job.repairs++;
    job.message = "Fixing deployment inputs and prerequisites in the preparation session…";
    this.save(job);
    job.workroomId = await this.options.repairs.start(job, checked);
    job.waitingForRepair = true; job.failure = null; this.save(job);
    if (!this.live(job)) this.options.repairs.stop(job.workroomId);
  }
  private async step(projectId: string, environmentId: string): Promise<void> {
    const job = this.current(projectId, environmentId);
    if (!job || !this.live(job)) return;
    if (Date.now() - job.createdAt > 2 * 60 * 60_000) {
      job.state = "blocked"; job.message = "Preparation paused after two hours. Review its session and resume when ready.";
      this.save(job); if (job.workroomId) this.options.repairs.stop(job.workroomId); return;
    }
    if (job.waitingForRepair && job.workroomId) {
      const state = this.options.repairs.status(job.workroomId);
      if (state.busy || state.question) {
        job.state = state.question ? "waiting-input" : "running";
        job.message = state.question ? "Answer the question in the preparation session; preparation will continue automatically." : "Fixing deployment prerequisites…";
        this.save(job); return;
      }
      job.waitingForRepair = false; job.state = "running";
    }
    const { service, preparer } = this.options;
    if (job.publicationId && this.options.publisher) {
      const publication = this.options.publisher.get(job.publicationId);
      if (publication.state === "publishing" || publication.state === "pending" && publication.expiresAt > Date.now()) return;
      if (publication.state !== "succeeded") {
        job.state = "blocked"; job.message = publication.expiresAt <= Date.now() ? "Source publication review expired. Resume preparation for a fresh review." : publication.events.at(-1)?.message ?? "Source publication stopped."; this.save(job); return;
      }
      job.publicationId = null; job.state = "running";
    }
    if (job.planId && !job.runId) {
      const approved = service.store.listRuns(projectId, environmentId).find((run) => run.planId === job.planId);
      if (approved) job.runId = approved.runId;
      else if (service.store.getPlan(job.planId).expiresAt > Date.now()) return;
      else job.planId = null;
    }
    if (job.runId) {
      const run = service.runView(job.runId);
      if (!run.terminal) { this.save(job); return; }
      if (run.state !== "succeeded") job.failure = `${job.phase === "build" ? "Build" : "Infrastructure preparation"} run ${job.runId} ended ${String(run.state)}. Inspect its events and repair the cause.`;
      job.runId = null; job.planId = null; job.state = "running";
    }
    await this.options.repairConnections?.(projectId, environmentId);
    const checked = await service.checkReadiness(projectId, environmentId, { preparationAvailable: true });
    if (!this.live(job)) return;
    const outstanding = checked.readiness.items.filter((item) => item.status !== "ready");
    const sourceItems = repositoryRepairItems(checked.readiness);
    const externalItems = externalPreparationItems(checked.readiness);
    if (sourceItems.length || job.failure && job.phase === "build" && !externalItems.length) {
      // A mixed report may contain useful local work. Send only that work to the
      // single-project room; connection credentials and other projects stay out.
      const repairItems = sourceItems.length ? sourceItems : outstanding.filter((item) => item.action === "prepare-artifact");
      await this.repair(job, { ...checked, readiness: { ...checked.readiness, items: repairItems } }); return;
    }
    if (externalItems.length || job.failure) {
      if (externalItems.length && !job.diagnosedExternal) {
        job.phase = "repair"; job.state = "running";
        job.message = "Asking the selected AI to diagnose the external deployment checks…";
        this.save(job);
        job.workroomId = await this.options.repairs.start(job, {
          ...checked, readiness: { ...checked.readiness, items: externalItems },
        }, "diagnose-external");
        job.diagnosedExternal = true;
        job.waitingForRepair = true;
        this.save(job);
        if (!this.live(job)) this.options.repairs.stop(job.workroomId);
        return;
      }
      job.state = "blocked"; job.blockedBy = "external"; job.phase = "check";
      job.message = externalItems.length
        ? `${externalPreparationMessage(externalItems)}${job.workroomId ? " Open the preparation session for the AI diagnosis and next actions." : ""}`
        : `Infrastructure preparation failed: ${job.failure}. Review the run and its connections before resuming.`;
      this.save(job); return;
    }
    if (outstanding.some((item) => item.action === "prepare-artifact")) {
      if (!checked.readiness.canMakeReady) {
        job.state = "blocked"; job.phase = "check"; job.blockedBy = "external";
        job.message = externalPreparationMessage(outstanding.filter((item) => item.action === "prepare-artifact")); this.save(job); return;
      }
      const publication = await this.options.publisher?.review(projectId, environmentId);
      if (!this.live(job)) { if (publication) this.options.publisher?.cancel(publication.id); return; }
      if (publication) {
        job.publicationId = publication.id; job.phase = "publish"; job.state = "awaiting-approval";
        job.message = "Review and approve publishing the local source commit to GitHub; the build will continue afterward."; this.save(job); return;
      }
      job.phase = "build"; job.message = "Building and verifying the committed deployment artifact…"; this.save(job);
      const existing = service.store.listRuns(projectId, environmentId).find((run) => run.runKind === "prepare" && !service.runView(run.runId).terminal);
      const prepared = existing ? { runId: existing.runId } : await preparer.prepare({ projectId, environmentId });
      job.runId = prepared.runId; this.save(job);
      if (!this.live(job)) await this.options.runner.cancel(prepared.runId);
      return;
    }
    const result = await service.createPlan(projectId, { environment: environmentId, operation: "reconcile" });
    if (!this.live(job)) return;
    const plan = service.store.getPlan(String(result.plan.id));
    const document = plan.document as unknown as DeploymentPlanDocument;
    if (plan.blocked) {
      job.failure = document.blockers.map((item) => item.message).join("; ");
      job.state = "blocked"; job.phase = "check"; job.blockedBy = "external";
      job.message = `Infrastructure needs attention: ${job.failure}. Review Deployment connections and the infrastructure plan, then resume.`; this.save(job); return;
    }
    if (!document.actions.some((action) => action.sideEffecting)) {
      job.state = "succeeded"; job.phase = "check"; job.message = "Ready to deploy. Source, dependencies, build and infrastructure have been checked.";
      this.save(job); return;
    }
    // Infrastructure is applied only under an approval bound to this exact plan:
    // a standing rule the operator set for this environment, or their review of
    // it through the existing API. The coordinator then follows that run.
    const standing = await this.options.standingApproval?.({ projectId, environmentId, planId: plan.planId });
    if (!this.live(job)) return;
    if (standing) {
      job.phase = "infrastructure"; job.planId = plan.planId; job.runId = standing.runId; job.state = "running";
      job.message = `Applying the infrastructure plan under a standing rule (${standing.reason})…`;
      this.save(job); return;
    }
    job.phase = "infrastructure"; job.planId = plan.planId;
    job.state = "awaiting-approval"; job.message = "Review and approve the infrastructure plan below; preparation will continue afterward.";
    this.save(job);
  }
}
