import { deploymentGuide, repositoryRepairItems } from "./readiness.ts";
import { isPermissionOperatorRequest } from "../agent-permissions.ts";
import type { SourcePublicationController } from "./source-publication.ts";
import express, { type Request, type Response } from "express";
import { agentIdentity, isLoopbackHost } from "../agent.ts";
import type { PsmSessionUser } from "../session.ts";
import { ApprovalIntentRegistry } from "./approvals.ts";
import { DeploymentStreamTicketRegistry } from "./stream-tickets.ts";
import {
  connectionReadinessView,
  validateConnectionProfile,
  type ConnectionProfile,
} from "./connections.ts";
import { DeploymentManifestValidationError } from "./manifest.ts";
import type { EnvironmentManifest, UnitManifest } from "./types.ts";
import { ManagedDeploymentError, DeploymentService } from "./service.ts";
import { DeploymentSetupError, detectDeploymentSetup, writeDeploymentSetup, addDeploymentEnvironment } from "./setup.ts";
import { GitHubSetup } from "./github-setup.ts";
import { GitHubControllerSetup } from "./github-controller-setup.ts";
import {
  DeploymentConflictError,
  DeploymentNotFoundError,
  DeploymentStoreError,
  DeploymentTransitionError,
  DeploymentValidationError,
  type DeploymentConnection,
  type DeploymentOperation,
  type DeploymentRun,
  type JsonValue,
} from "./store.ts";
import { authorizeDeploymentAction, composeDeploymentPolicy, type DeploymentPolicyLayer, type EffectiveDeploymentPolicy } from "./policy.ts";
import { preparationActive, preparationView, type DeploymentPreparationController } from "./make-ready.ts";

export interface DeploymentRunController {
  enqueue(runId: string): void | Promise<void>;
  cancel(runId: string): unknown | Promise<unknown>;
  closeUncertainReload?(runId: string): unknown | Promise<unknown>;
  closeFailedReadOnlyObservation?(runId: string): unknown | Promise<unknown>;
  recover?(runId: string): void | Promise<void>;
}

export interface ArtifactPreparationController {
  prepare(input: { projectId: string; environmentId: string; unitId?: string }): Promise<{ runId: string }>;
}

export interface DeploymentApiOptions {
  service: DeploymentService;
  reviewCapabilities?: (projectId: string, engine: string | null, workroomId?: string | null) => string | null;
  reviewCheckout?: (projectId: string) => string | null;
  currentUser: () => Promise<PsmSessionUser | null>;
  localRequest: (request: Request) => boolean;
  /** Disable in a hosted SaaS controller; local cockpit approval uses the machine operator. */
  allowLocalOperatorWithoutSignIn?: boolean;
  runner?: DeploymentRunController;
  preparer?: ArtifactPreparationController;
  /** When configured, "make ready" runs the whole preparation flow instead of one build. */
  preparation?: DeploymentPreparationController;
  publisher?: SourcePublicationController;
  /** Publishes the CI release key and host key to the pinned controller's GitHub Environment. */
  controllerCredentials?: (unit: UnitManifest, context: { checkoutId: string; environment: EnvironmentManifest; projectId: string }) => Promise<Record<string, unknown>>;
  controllerPin?: (unit: UnitManifest, context: { checkoutId: string; environment: EnvironmentManifest }, reviewedHeadSha: string) => Promise<Record<string, unknown>>;
  targetContractPin?: (unit: UnitManifest, context: { checkoutId: string; environment: EnvironmentManifest }, reviewedDigest: string) => Promise<Record<string, unknown>>;
  intents?: ApprovalIntentRegistry;
  streamTickets?: DeploymentStreamTicketRegistry;
  /** Rotates when the long-lived pairing token rotates, invalidating outstanding stream tickets. */
  agentGeneration?: () => number;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function exactLocalCockpitOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !origin) return false;
  try {
    const parsed = new URL(origin);
    const requestHost = String(req.headers.host || "").toLowerCase();
    return isLoopbackHost(parsed.hostname)
      && parsed.host.toLowerCase() === requestHost
      && (parsed.protocol === "http:" || parsed.protocol === "https:");
  } catch {
    return false;
  }
}

function profileFromRecord(connection: DeploymentConnection): ConnectionProfile {
  const metadata = asObject(connection.metadata);
  return {
    connectionId: connection.connectionId,
    name: connection.label,
    kind: connection.kind,
    metadataRevision: connection.metadataRevision,
    publicMetadata: asObject(metadata.publicMetadata) as ConnectionProfile["publicMetadata"],
    ...(metadata.credentialIdentity ? { credentialIdentity: metadata.credentialIdentity as ConnectionProfile["credentialIdentity"] } : {}),
    requiredSecretSlots: Array.isArray(metadata.requiredSecretSlots)
      ? metadata.requiredSecretSlots.filter((item): item is string => typeof item === "string")
      : [],
    constraints: asObject(connection.constraints) as unknown as ConnectionProfile["constraints"],
  };
}

function effectivePolicy(document: JsonValue): EffectiveDeploymentPolicy {
  const policy = asObject(asObject(document).policy);
  return policy as unknown as EffectiveDeploymentPolicy;
}

function apiError(res: Response, error: unknown): void {
  if (error instanceof ManagedDeploymentError) {
    res.status(error.status).json({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
    return;
  }
  if (error instanceof DeploymentManifestValidationError) {
    res.status(400).json({ error: error.message, code: "manifest-invalid", issues: error.issues });
    return;
  }
  if (error instanceof DeploymentNotFoundError) {
    res.status(404).json({ error: error.message, code: "not-found" });
    return;
  }
  if (error instanceof DeploymentConflictError || error instanceof DeploymentTransitionError) {
    res.status(409).json({ error: error.message, code: "deployment-conflict" });
    return;
  }
  if (error instanceof DeploymentValidationError) {
    res.status(400).json({ error: error.message, code: "deployment-invalid" });
    return;
  }
  if (error instanceof DeploymentStoreError) {
    res.status(500).json({ error: error.message, code: "deployment-store" });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({ error: message || "managed deployment failed", code: "deployment-error" });
}

function operation(value: unknown): DeploymentOperation {
  const candidate = String(value || "deploy") as DeploymentOperation;
  if (!["reconcile", "release", "deploy", "rollback", "adopt"].includes(candidate)) {
    throw new ManagedDeploymentError("unsupported deployment operation", "deployment-invalid", 400);
  }
  return candidate;
}

const TERMINAL_RUN_STATES = new Set(["succeeded", "failed", "cancelled", "interrupted", "stale-plan", "rolled-back"]);

function requireLocal(options: DeploymentApiOptions, req: Request, res: Response): boolean {
  if (options.localRequest(req)) return true;
  res.status(403).json({ error: "change deployment authority from the local cockpit", code: "local-authority-required" });
  return false;
}

export function createDeploymentRouter(options: DeploymentApiOptions): express.Router {
  const router = express.Router();
  const localOperatorRequest = (req: Request) => options.allowLocalOperatorWithoutSignIn !== false
    && options.localRequest(req) && exactLocalCockpitOrigin(req) && isPermissionOperatorRequest(req);

  const { service } = options;
  const githubSetup = new GitHubSetup(service);
  const githubControllerSetup = new GitHubControllerSetup(service);
  router.post("/api/projects/:id/deployments/:environment/github/controller/preview", async (req, res) => {
    if (!requireLocal(options, req, res)) return;
    if (!exactLocalCockpitOrigin(req)) return res.status(403).json({ error: "Review controller setup from the local cockpit" });
    try { res.json(await githubControllerSetup.preview(req.params.id, req.params.environment)); } catch (error) { apiError(res, error); }
  });
  router.post("/api/projects/:id/deployments/:environment/github/controller/apply", async (req, res) => {
    if (!requireLocal(options, req, res)) return;
    if (!exactLocalCockpitOrigin(req)) return res.status(403).json({ error: "Apply controller setup from the local cockpit" });
    try { res.json(await githubControllerSetup.apply(String(req.body?.id ?? ""), req.params.id, req.params.environment)); } catch (error) { apiError(res, error); }
  });
  router.post("/api/projects/:id/deployments/:environment/github/connect", (req, res) => {
    if (!requireLocal(options, req, res)) return;
    if (!exactLocalCockpitOrigin(req)) return res.status(403).json({ error: "Connect GitHub from the local cockpit" });
    try {
      const result = githubSetup.start(req.params.id, req.params.environment, req.body, String(req.headers.origin));
      res.cookie(`psm_github_${result.state}`, result.browserNonce, { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: 600_000, path: "/api/deployment-github/callback" });
      const { browserNonce: _nonce, ...publicResult } = result;
      res.json(publicResult);
    } catch (error) { apiError(res, error); }
  });
  router.get("/api/deployment-github/callback", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!requireLocal(options, req, res)) return;
    try {
      const state = String(req.query.state ?? "");
      if (!/^[a-f0-9]{64}$/.test(state)) throw new Error("Invalid GitHub setup state");
      const cookie = (req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`psm_github_${state}=`));
      const result = await githubSetup.convert(state, String(req.query.code ?? ""), cookie?.split("=")[1] || "");
      res.clearCookie(`psm_github_${state}`, { path: "/api/deployment-github/callback" });
      res.redirect(303, result.installUrl);
    } catch { res.status(400).type("text").send("GitHub connection could not be completed. Return to the local PSM Deploy page and start Connect GitHub again."); }
  });
  router.post("/api/connections/:connectionId/github/install", async (req, res) => {
    if (!requireLocal(options, req, res)) return;
    if (!exactLocalCockpitOrigin(req)) return res.status(403).json({ error: "Check GitHub installation from the local cockpit" });
    try { res.json(await githubSetup.finish(req.params.connectionId)); } catch (error) { apiError(res, error); }
  });
  const intents = options.intents ?? new ApprovalIntentRegistry();
  const streamTickets = options.streamTickets ?? new DeploymentStreamTicketRegistry();
  const preparationRequests = new Map<string, Promise<Record<string, unknown>>>();
  const addCapabilityReview = (checked: Awaited<ReturnType<DeploymentService["checkReadiness"]>>, projectId: string, engine: string | null, workroomId?: string | null) => {
    const needsRepair = repositoryRepairItems(checked.readiness).length > 0;
    const gap = needsRepair ? options.reviewCapabilities?.(projectId, engine, workroomId) : null;
    if (gap) checked.readiness.items.unshift({ id: "review-capabilities", code: "capabilities-missing", title: "Review capabilities", detail: gap, status: "blocked", action: "review-capabilities", automatic: false });
    // A checkout problem is listed as source work — it opens Changes, not Capabilities —
    // and only once grants are in place, since the preflight reads with them.
    const checkout = needsRepair && !gap ? options.reviewCheckout?.(projectId) : null;
    if (checkout) checked.readiness.items.unshift({ id: "review-checkout", code: "checkout-not-ready", title: "Prepare the Git checkout", detail: checkout, status: "blocked", action: "review-source", automatic: false });
    checked.readiness.guide = deploymentGuide(checked.readiness);
    return checked;
  };

  // First-time setup for a project with no manifest: what PSM detects, then the drafted files.
  router.get("/api/projects/:id/deployment-setup", (req, res) => {
    try { res.json({ setup: detectDeploymentSetup(service.resolveProject(req.params.id)) }); } catch (error) { apiError(res, error); }
  });

  router.post("/api/projects/:id/deployment-setup", (req, res) => {
    if (!requireLocal(options, req, res)) return;
    try {
      const project = service.resolveProject(req.params.id);
      const environment = req.body?.environment === "production" ? "production" : "staging";
      const written = writeDeploymentSetup(project, { hostname: String(req.body?.hostname || ""), zone: String(req.body?.zone || ""), environment });
      res.status(201).json({ ok: true, ...written });
    } catch (error) {
      if (error instanceof DeploymentSetupError) return apiError(res, new ManagedDeploymentError(error.message, error.code, error.code === "setup-exists" ? 409 : 400));
      apiError(res, error);
    }
  });

  router.post("/api/projects/:id/deployment-environments", (req, res) => {
    if (!requireLocal(options, req, res)) return;
    try {
      const project = service.resolveProject(req.params.id);
      const environment = req.body?.environment === "production" ? "production" : req.body?.environment === "staging" ? "staging" : null;
      if (!environment) throw new DeploymentSetupError("Choose staging or production.", "setup-environment");
      const result = addDeploymentEnvironment(project, { hostname: String(req.body?.hostname || ""), zone: String(req.body?.zone || ""), environment });
      res.status(201).json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof DeploymentSetupError) return apiError(res, new ManagedDeploymentError(error.message, error.code, error.code === "setup-exists" ? 409 : 400));
      apiError(res, error);
    }
  });

  router.get("/api/projects/:id/deployments", async (req, res) => {
    try { res.json(await service.overview(req.params.id)); } catch (error) { apiError(res, error); }
  });

  router.get("/api/projects/:id/deployments/:environment", async (req, res) => {
    try { res.json({ managed: true, environment: await service.environmentView(req.params.id, req.params.environment) }); } catch (error) { apiError(res, error); }
  });
  router.get("/api/projects/:id/deployments/:environment/watch", async (req, res) => {
    try { res.json({environment:await service.refreshWatch(req.params.id,req.params.environment)}); }
    catch (error) { apiError(res,error); }
  });

  // The last answer, so reopening the page shows it instead of checking every provider again.
  router.get("/api/projects/:id/deployments/:environment/readiness", (req, res) => {
    try {
      const last = service.lastReadiness(req.params.id, req.params.environment);
      res.json(last ? addCapabilityReview(last, service.resolveProject(req.params.id).id, null) : { readiness: null });
    } catch (error) { apiError(res, error); }
  });

  router.post("/api/projects/:id/deployments/:environment/readiness", async (req, res) => {
    try {
      const checked = await service.checkReadiness(req.params.id, req.params.environment, {
        artifactId: req.body?.artifactId == null ? null : String(req.body.artifactId),
        preparationAvailable: !!options.preparer,
      });
      res.json(addCapabilityReview(checked, service.resolveProject(req.params.id).id, req.body?.engine == null ? null : String(req.body.engine)));
    } catch (error) { apiError(res, error); }
  });

  router.post("/api/projects/:id/deployments/:environment/make-ready", async (req, res) => {
    if (!requireLocal(options, req, res)) return;
    try {
      const project = service.resolveProject(req.params.id);
      const environmentId = req.params.environment;
      if (options.preparation) {
        const coordinator = options.preparation;
        // One click both starts the flow and takes its first step, so the answer
        // the operator gets back is this deployment's real state rather than
        // "starting…" — and a second click joins the same job instead of
        // starting a second one.
        // The AI is chosen per press, so a preparation stopped by one provider's
        // usage limit resumes on the other without losing its room or progress.
        coordinator.start(project.id, environmentId, {
          ...(req.body?.engine == null ? {} : { engine: String(req.body.engine) }),
          ...(req.body?.model == null ? {} : { model: String(req.body.model).trim() || null }),
          ...(req.body?.effort == null ? {} : { effort: String(req.body.effort).trim() || null }),
        });
        await coordinator.advance(project.id, environmentId);
        const job = coordinator.current(project.id, environmentId);
        const checked = await service.checkReadiness(project.id, environmentId, {
          artifactId: req.body?.artifactId == null ? null : String(req.body.artifactId),
          preparationAvailable: !!options.preparer,
        });
        return res.status(job && preparationActive(job) ? 202 : 200).json({
          ...addCapabilityReview(checked, project.id, job?.engine ?? null, job?.workroomId),
          preparation: preparationView(job),
          ...(job?.runId ? { run: service.runView(job.runId) } : {}),
        });
      }
      const key = `${project.id}/${environmentId}`;
      let pending = preparationRequests.get(key);
      if (!pending) {
        pending = (async () => {
          const existing = service.store.listRuns(project.id, environmentId).find((run) => run.runKind === "prepare" && !TERMINAL_RUN_STATES.has(run.state));
          const checked = await service.checkReadiness(project.id, environmentId, {
            artifactId: req.body?.artifactId == null ? null : String(req.body.artifactId),
            preparationAvailable: !!options.preparer,
          });
          if (existing) return { ...checked, run: service.runView(existing.runId), steps: [{ id: "prepare-artifact", status: "running", detail: "The deployment build is already running." }] };
          if (!checked.readiness.canMakeReady || !options.preparer) {
            return { ...checked, steps: [], message: checked.readiness.ready ? "Ready to deploy." : "Complete the listed connection, source, or provider tasks, then check again." };
          }
          // Preparation dispatches a build only. Deployment still goes through
          // its separate exact-plan approval intent and reviewed action graph.
          const prepared = await options.preparer.prepare({ projectId: project.id, environmentId });
          const run = service.runView(prepared.runId);
          const rechecked = await service.checkReadiness(project.id, environmentId, { preparationAvailable: true, preparing: !run.terminal });
          return { ...rechecked, run, steps: [{ id: "prepare-artifact", status: run.terminal ? run.state : "running", detail: run.terminal ? "Deployment build finished; readiness checked again." : "Preparing the committed deployment build. Readiness is checked again when it finishes." }] };
        })();
        preparationRequests.set(key, pending);
        void pending.finally(() => { if (preparationRequests.get(key) === pending) preparationRequests.delete(key); }).catch(() => {});
      }
      const result = await pending;
      const run = asObject(result.run);
      res.status(run.id && !run.terminal ? 202 : 200).json(result);
    } catch (error) { apiError(res, error); }
  });

  /**
   * Where preparation has got to.
   *
   * Deliberately cheap: it reads the job psm already wrote and nothing else, so
   * an open cockpit can poll it every couple of seconds without rebuilding a
   * plan on every tick. The plan comes back only while preparation is actually
   * waiting on an approval, which is the one moment the page needs to show it.
   */
  router.get("/api/projects/:id/deployments/:environment/preparation", (req, res) => {
    try {
      const project = service.resolveProject(req.params.id);
      const job = options.preparation?.current(project.id, req.params.environment) ?? null;
      let plan: Record<string, unknown> | null = null;
      if (job?.planId && job.state === "awaiting-approval") {
        try {
          const stored = service.store.getPlan(job.planId);
          plan = { id: stored.planId, revision: stored.revision, digest: stored.digest, ...asObject(stored.document) };
        } catch { plan = null; }
      }
      res.json({
        preparation: preparationView(job),
        ...(job?.publicationId && options.publisher ? { publication: options.publisher.get(job.publicationId) } : {}),
        ...(plan ? { plan } : {}),
        ...(job?.runId ? { run: service.runView(job.runId) } : {}),
      });
    } catch (error) { apiError(res, error); }
  });

  router.post("/api/projects/:id/deployments/:environment/preparation/cancel", async (req, res) => {
    if (!requireLocal(options, req, res)) return;
    try {
      if (!options.preparation) {
        return res.status(409).json({ error: "automatic preparation is not configured", code: "deployment-conflict" });
      }
      const project = service.resolveProject(req.params.id);
      const job = await options.preparation.cancel(project.id, req.params.environment);
      res.json({ ok: true, preparation: preparationView(job) });
    } catch (error) { apiError(res, error); }
  });

  for (const action of ["approval-intents", "approve"] as const) {
    router.post(`/api/source-publications/:publicationId/${action}`, async (req, res) => {
      if (!requireLocal(options, req, res)) return;
      if (!isPermissionOperatorRequest(req)) return res.status(403).json({ error: "Review publication from the local, same-origin cockpit." });
      try {
        if (!options.publisher) throw new Error("Source publishing is not configured.");
        const plan = options.publisher.get(req.params.publicationId);
        const user = await options.currentUser();
        const decision = authorizeDeploymentAction(plan.policy, { action: "approve", origin: "local", authenticated: !!user, localOperator: localOperatorRequest(req) });
        if (!decision.allowed) return res.status(403).json({ error: decision.reasons.join("; ") });
        if (plan.state !== "pending" || plan.expiresAt <= Date.now()) return res.status(409).json({ error: "Publication review is stale or consumed." });
        const actor = user?.id ?? "local-operator";
        const binding = { planId: plan.id, planRevision: 1, planDigest: plan.digest, actorSubject: actor, agentId: agentIdentity().agentId, origin: "local" as const };
        if (action === "approval-intents") return res.json(intents.mint(binding));
        if (req.body?.digest !== plan.digest || !intents.consume(String(req.body?.intent ?? ""), binding)) return res.status(403).json({ error: "Publication approval intent is missing, expired or belongs to another review." });
        const publication = await options.publisher.approve(plan.id, plan.digest, actor);
        await options.preparation?.advance(plan.projectId, plan.environmentId);
        res.status(publication.state === "succeeded" ? 200 : 409).json({ publication, ...(publication.state === "failed" ? { error: publication.events.at(-1)?.message } : {}) });
      } catch (error) { apiError(res, error); }
    });
  }

  router.get("/api/projects/:id/deployment-artifacts", (req, res) => {
    try { res.json({ artifacts: service.artifacts(req.params.id) }); } catch (error) { apiError(res, error); }
  });

  router.post("/api/projects/:id/deployment-artifacts/prepare", async (req, res) => {
    if (!options.preparer) return res.status(409).json({ error: "artifact preparation executor is not configured", code: "connection-missing" });
    try {
      const project = service.resolveProject(req.params.id);
      const environmentId = String(req.body?.environment || "");
      if (!environmentId) throw new ManagedDeploymentError("environment is required");
      const result = await options.preparer.prepare({ projectId: project.id, environmentId, ...(req.body?.unitId ? { unitId: String(req.body.unitId) } : {}) });
      res.status(202).json({ ok: true, run: service.runView(result.runId) });
    } catch (error) { apiError(res, error); }
  });

  router.post("/api/projects/:id/deployment-plans", async (req, res) => {
    try {
      const result = await service.createPlan(req.params.id, {
        environment: String(req.body?.environment || ""),
        operation: operation(req.body?.operation),
        artifactId: req.body?.artifactId == null ? null : String(req.body.artifactId),
        releaseId: req.body?.releaseId == null ? null : String(req.body.releaseId),
      });
      res.status(201).json(result);
    } catch (error) { apiError(res, error); }
  });

  router.get("/api/deployment-plans/:planId", (req, res) => {
    try {
      const plan = service.store.getPlan(req.params.planId);
      res.json({ plan: { id: plan.planId, revision: plan.revision, digest: plan.digest, ...asObject(plan.document) } });
    } catch (error) { apiError(res, error); }
  });

  router.post("/api/deployment-plans/:planId/approval-intents", async (req, res) => {
    try {
      const plan = service.store.getPlan(req.params.planId);
      const policy = effectivePolicy(plan.document);
      const user = await options.currentUser();
      const origin = options.localRequest(req) ? "local" as const : "paired" as const;
      const decision = authorizeDeploymentAction(policy, { action: "approve", origin, authenticated: !!user, localOperator: localOperatorRequest(req) });
      if (!decision.allowed) return res.status(403).json({ error: decision.reasons.join("; "), code: "approval-required" });
      if (plan.risk === "production" && !exactLocalCockpitOrigin(req)) {
        return res.status(403).json({ error: "production approval intent requires the exact local cockpit origin", code: "approval-required" });
      }
      const actorSubject = user?.id ?? "local-operator";
      const minted = intents.mint({ planId: plan.planId, planRevision: plan.revision, planDigest: plan.digest, actorSubject, agentId: agentIdentity().agentId, origin });
      res.json(minted);
    } catch (error) { apiError(res, error); }
  });

  router.post("/api/deployment-plans/:planId/approve", async (req, res) => {
    try {
      const plan = service.store.getPlan(req.params.planId, Number(req.body?.revision));
      if (String(req.body?.digest || "") !== plan.digest) throw new DeploymentConflictError("plan digest changed");
      const policy = effectivePolicy(plan.document);
      const user = await options.currentUser();
      const origin = options.localRequest(req) ? "local" as const : "paired" as const;
      const decision = authorizeDeploymentAction(policy, { action: "approve", origin, authenticated: !!user, localOperator: localOperatorRequest(req) });
      if (!decision.allowed) return res.status(403).json({ error: decision.reasons.join("; "), code: "approval-required" });
      if (plan.risk === "production" && !exactLocalCockpitOrigin(req)) {
        return res.status(403).json({ error: "production approval requires the exact local cockpit origin", code: "approval-required" });
      }
      const actorSubject = user?.id ?? "local-operator";
      const binding = { planId: plan.planId, planRevision: plan.revision, planDigest: plan.digest, actorSubject, agentId: agentIdentity().agentId, origin };
      if (!intents.consume(String(req.body?.intent || ""), binding)) {
        return res.status(403).json({ error: "approval intent is missing, expired or belongs to another plan/session", code: "approval-required" });
      }
      const result = service.store.approveAndQueue({
        planId: plan.planId,
        planRevision: plan.revision,
        planDigest: plan.digest,
        risk: plan.risk,
        actorKind: user ? "werewolf-user" : "local-operator",
        actorSubject: user?.id ?? null,
        agentId: agentIdentity().agentId,
        origin,
        acknowledgementIds: Array.isArray(req.body?.acknowledgementIds) ? req.body.acknowledgementIds.map(String) : [],
        approvedAt: Date.now(),
        expiresAt: plan.expiresAt,
      });
      if (result.created) await options.runner?.enqueue(result.run.runId);
      res.status(result.created ? 202 : 200).json({ ok: true, run: service.runView(result.run.runId) });
    } catch (error) { apiError(res, error); }
  });

  // A runtime secret is entered here and nowhere else: from the local cockpit, into
  // PSM's secret store. Responses say whether it is set, never what it is.
  router.put("/api/projects/:id/deployments/:environment/service-secrets/:unit/:name", async (req, res) => {
    if (!requireLocal(options, req, res)) return;
    if (!exactLocalCockpitOrigin(req)) return res.status(403).json({ error: "Set runtime secrets from the local cockpit" });
    try {
      res.json(await service.setServiceSecret(req.params.id, req.params.environment, req.params.unit, req.params.name, String(req.body?.value ?? "")));
    } catch (error) { apiError(res, error); }
  });
  router.delete("/api/projects/:id/deployments/:environment/service-secrets/:unit/:name", async (req, res) => {
    if (!requireLocal(options, req, res)) return;
    if (!exactLocalCockpitOrigin(req)) return res.status(403).json({ error: "Remove runtime secrets from the local cockpit" });
    try {
      res.json(await service.setServiceSecret(req.params.id, req.params.environment, req.params.unit, req.params.name, null));
    } catch (error) { apiError(res, error); }
  });

  router.post("/api/projects/:id/deployments/:environment/controller-credentials", async (req, res) => {
    if (!requireLocal(options, req, res)) return;
    try {
      if (!options.controllerCredentials) throw new ManagedDeploymentError("publishing controller credentials is not available", "not-available", 501);
      const { unit, environment, checkoutId, projectId } = service.releaseControllerUnit(req.params.id, req.params.environment);
      res.json({ ok: true, published: await options.controllerCredentials(unit, { checkoutId, environment, projectId }) });
    } catch (error) {
      if (error instanceof ManagedDeploymentError) return apiError(res, error);
      apiError(res, new ManagedDeploymentError(error instanceof Error ? error.message : String(error), "controller-credentials-failed", 409));
    }
  });

  router.post("/api/projects/:id/deployments/:environment/controller-pin", async (req, res) => {
    if (!requireLocal(options, req, res)) return;
    try {
      if (!options.controllerPin) throw new ManagedDeploymentError("re-pinning the release controller is not available", "not-available", 501);
      const reviewed = String(req.body?.headSha || "");
      if (!/^[0-9a-f]{40}$/.test(reviewed)) throw new ManagedDeploymentError("name the reviewed controller commit", "controller-pin-invalid", 400);
      const { unit, environment, checkoutId } = service.releaseControllerUnit(req.params.id, req.params.environment);
      res.json({ ok: true, pinned: await options.controllerPin(unit, { checkoutId, environment }, reviewed) });
    } catch (error) {
      if (error instanceof ManagedDeploymentError) return apiError(res, error);
      apiError(res, new ManagedDeploymentError(error instanceof Error ? error.message : String(error), "controller-pin-failed", 409));
    }
  });

  router.post("/api/projects/:id/deployments/:environment/target-contract-pin", async (req, res) => {
    if (!requireLocal(options, req, res)) return;
    try {
      if (!options.targetContractPin) throw new ManagedDeploymentError("re-pinning the target contract is not available", "not-available", 501);
      const reviewed = String(req.body?.digest || "");
      if (!/^sha256:[0-9a-f]{64}$/.test(reviewed)) throw new ManagedDeploymentError("name the reviewed target contract digest", "target-pin-invalid", 400);
      const { unit, environment, checkoutId } = service.releaseControllerUnit(req.params.id, req.params.environment);
      res.json({ ok: true, pinned: await options.targetContractPin(unit, { checkoutId, environment }, reviewed) });
    } catch (error) {
      if (error instanceof ManagedDeploymentError) return apiError(res, error);
      apiError(res, new ManagedDeploymentError(error instanceof Error ? error.message : String(error), "target-pin-failed", 409));
    }
  });

  router.put("/api/projects/:id/deployments/:environment/connection-bindings/:slot", async (req, res) => {
    if (!requireLocal(options, req, res)) return;
    try {
      const binding = await service.bindConnection(
        req.params.id,
        req.params.environment,
        req.params.slot,
        String(req.body?.connectionId || ""),
        req.body?.expectedRevision == null ? null : Number(req.body.expectedRevision),
      );
      res.json({ ok: true, binding });
    } catch (error) { apiError(res, error); }
  });

  router.post("/api/projects/:id/deployments/:environment/resources/:resourceId/adoption-plans", async (req, res) => {
    try {
      const result = await service.createPlan(req.params.id, {
        environment: req.params.environment,
        operation: "adopt",
        resourceId: req.params.resourceId,
      });
      res.status(201).json(result);
    } catch (error) { apiError(res, error); }
  });

  router.get("/api/projects/:id/deployment-runs", (req, res) => {
    try { res.json({ runs: service.runs(req.params.id, typeof req.query.environment === "string" ? req.query.environment : undefined) }); } catch (error) { apiError(res, error); }
  });

  router.get("/api/deployment-runs/:runId", (req, res) => {
    try { res.json({ run: service.runView(req.params.runId) }); } catch (error) { apiError(res, error); }
  });

  // Resolving a held run takes the same authority as approving its plan: the
  // plan's approval policy decides, and production stays on the local cockpit.
  async function heldRunRefusal(req: Request, run: DeploymentRun): Promise<string | null> {
    if (!run.planId) return "this run has no reviewed plan";
    const plan = service.store.getPlan(run.planId, run.planRevision!);
    const user = await options.currentUser();
    const origin = options.localRequest(req) ? "local" as const : "paired" as const;
    const decision = authorizeDeploymentAction(effectivePolicy(plan.document), { action: "approve", origin, authenticated: !!user, localOperator: localOperatorRequest(req) });
    if (!decision.allowed) return `resolving held work needs the authority that approves this plan: ${decision.reasons.join("; ")}`;
    if (plan.risk === "production" && !exactLocalCockpitOrigin(req)) return "resolving held production work requires the exact local cockpit origin";
    return null;
  }

  router.post("/api/deployment-runs/:runId/cancel", async (req, res) => {
    try {
      const run = service.store.getRun(req.params.runId);
      if (run.planId) {
        const plan = service.store.getPlan(run.planId, run.planRevision!);
        if (plan.risk === "production") {
          const user = await options.currentUser();
          if (!exactLocalCockpitOrigin(req) || (!user && !localOperatorRequest(req))) return res.status(403).json({ error: "production cancellation requires the local cockpit operator", code: "approval-required" });
        }
      }
      if (options.runner) await options.runner.cancel(run.runId);
      else service.store.requestCancellation(run.runId, Date.now());
      res.status(202).json({ ok: true, run: service.runView(run.runId) });
    } catch (error) { apiError(res, error); }
  });

  router.post("/api/deployment-runs/:runId/close-uncertain-reload", async (req, res) => {
    try {
      const run = service.store.getRun(req.params.runId);
      const refusal = await heldRunRefusal(req, run);
      if (refusal) return res.status(403).json({ error: refusal, code: "approval-required" });
      if (!options.runner?.closeUncertainReload) return res.status(503).json({ error: "deployment recovery is unavailable" });
      await options.runner.closeUncertainReload(run.runId);
      res.json({ run: service.runView(run.runId) });
    } catch (error) { apiError(res, error); }
  });

  router.post("/api/deployment-runs/:runId/close-failed-read-only-observation", async (req, res) => {
    try {
      const run = service.store.getRun(req.params.runId);
      const refusal = await heldRunRefusal(req, run);
      if (refusal) return res.status(403).json({ error: refusal, code: "approval-required" });
      if (!options.runner?.closeFailedReadOnlyObservation) return res.status(503).json({ error: "deployment recovery is unavailable" });
      await options.runner.closeFailedReadOnlyObservation(run.runId);
      res.json({ run: service.runView(run.runId) });
    } catch (error) { apiError(res, error); }
  });

  router.post("/api/deployment-runs/:runId/recover", async (req, res) => {
    try {
      const run = service.store.getRun(req.params.runId);
      const refusal = await heldRunRefusal(req, run);
      if (refusal) return res.status(403).json({ error: refusal, code: "approval-required" });
      if (run.state !== "recovery-required") return res.status(409).json({ error: "only a run waiting for recovery can be checked again", code: "not-recoverable" });
      if (!options.runner?.recover) return res.status(503).json({ error: "deployment recovery is unavailable" });
      await options.runner.recover(run.runId);
      res.status(202).json({ ok: true, run: service.runView(run.runId) });
    } catch (error) { apiError(res, error); }
  });

  router.post("/api/deployment-runs/:runId/rollback-plans", async (req, res) => {
    try {
      const run = service.store.getRun(req.params.runId);
      const result = await service.createPlan(run.projectId, { environment: String(run.environmentId || ""), operation: "rollback", releaseId: String(req.body?.releaseId || "") });
      res.status(201).json(result);
    } catch (error) { apiError(res, error); }
  });

  router.get("/api/deployment-runs/:runId/events", (req, res) => {
    try {
      const after = Number(req.query.after || 0);
      res.json({ events: service.store.listEvents(req.params.runId, Number.isSafeInteger(after) ? after : 0) });
    } catch (error) { apiError(res, error); }
  });

  router.post("/api/deployment-runs/:runId/stream-ticket", (req, res) => {
    try {
      service.store.getRun(req.params.runId);
      const minted = streamTickets.mint({
        runId: req.params.runId,
        origin: streamTickets.originFor(req),
        agentGeneration: options.agentGeneration?.() ?? 0,
      });
      res.json(minted);
    } catch (error) { apiError(res, error); }
  });

  router.get("/api/deployment-runs/:runId/stream", (req, res) => {
    try {
      const ticket = typeof req.query.ticket === "string" ? req.query.ticket : "";
      if (!streamTickets.validate({ ticket, runId: req.params.runId, origin: streamTickets.originFor(req), agentGeneration: options.agentGeneration?.() ?? 0 })) {
        return res.status(403).json({ error: "stream ticket is missing, expired or bound to another run/origin", code: "stream-ticket-invalid" });
      }
      service.store.getRun(req.params.runId);
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      let cursor = Number(req.headers["last-event-id"] || req.query.after || 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
      let closed = false;
      const send = () => {
        if (closed) return;
        for (const event of service.store.listEvents(req.params.runId, cursor, 500)) {
          cursor = event.sequence;
          res.write(`id: ${event.sequence}\nevent: deployment\ndata: ${JSON.stringify(event)}\n\n`);
        }
        const run = service.store.getRun(req.params.runId);
        if (TERMINAL_RUN_STATES.has(run.state)) {
          res.write(`event: status\ndata: ${JSON.stringify({ state: run.state, phase: run.phase })}\n\n`);
          cleanup();
          res.end();
        }
      };
      const interval = setInterval(send, 750);
      const heartbeat = setInterval(() => { if (!closed) res.write(": keep-alive\n\n"); }, 15_000);
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        clearInterval(heartbeat);
      };
      req.on("close", cleanup);
      send();
    } catch (error) { apiError(res, error); }
  });

  router.get("/api/connections", async (_req, res) => {
    try {
      const connections = await Promise.all(service.store.listConnections().map(async (record) => {
        const profile = profileFromRecord(record);
        const readiness = await connectionReadinessView(profile, service.secretBroker);
        return {
          connectionId: record.connectionId,
          label: record.label,
          kind: record.kind,
          metadataRevision: record.metadataRevision,
          secretGeneration: readiness.secretGeneration,
          readiness: readiness.ready ? "ready" : "missing-secret",
          ready: readiness.ready,
          publicMetadata: readiness.publicMetadata,
          requiredSecretSlots: profile.requiredSecretSlots,
          credentialFingerprint: readiness.credentialFingerprint,
          missingSecretSlots: readiness.missingSecretSlots,
          constraints: record.constraints,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        };
      }));
      res.json({ connections });
    } catch (error) { apiError(res, error); }
  });

  router.post("/api/connections", async (req, res) => {
    if (!requireLocal(options, req, res)) return;
    try {
      const candidate: ConnectionProfile = {
        connectionId: String(req.body?.connectionId || ""),
        name: String(req.body?.label || ""),
        kind: String(req.body?.kind || ""),
        metadataRevision: 1,
        publicMetadata: asObject(req.body?.publicMetadata) as ConnectionProfile["publicMetadata"],
        ...(req.body?.credentialIdentity ? { credentialIdentity: req.body.credentialIdentity } : {}),
        requiredSecretSlots: Array.isArray(req.body?.requiredSecretSlots) ? req.body.requiredSecretSlots.map(String) : [],
        constraints: req.body?.constraints,
      };
      const validation = validateConnectionProfile(candidate);
      if (!validation.ok) throw new ManagedDeploymentError(validation.issues[0].message, "connection-invalid", 400, validation.issues);
      const record = service.store.createConnection({
        connectionId: candidate.connectionId,
        kind: candidate.kind,
        label: candidate.name,
        secretGeneration: 0,
        readiness: candidate.requiredSecretSlots.length ? "missing-secret" : "ready",
        metadata: json({ publicMetadata: candidate.publicMetadata ?? {}, credentialIdentity: candidate.credentialIdentity ?? null, requiredSecretSlots: candidate.requiredSecretSlots }),
        constraints: json(candidate.constraints),
        createdAt: Date.now(),
      });
      res.status(201).json({ ok: true, connection: record });
    } catch (error) { apiError(res, error); }
  });

  router.patch("/api/connections/:connectionId", async (req, res) => {
    if (!requireLocal(options, req, res)) return;
    try {
      const current = service.store.getConnection(req.params.connectionId);
      const currentProfile = profileFromRecord(current);
      const candidate: ConnectionProfile = {
        ...currentProfile,
        name: req.body?.label == null ? current.label : String(req.body.label),
        publicMetadata: req.body?.publicMetadata == null ? currentProfile.publicMetadata : asObject(req.body.publicMetadata) as ConnectionProfile["publicMetadata"],
        credentialIdentity: req.body?.credentialIdentity === undefined ? currentProfile.credentialIdentity : req.body.credentialIdentity || undefined,
        requiredSecretSlots: req.body?.requiredSecretSlots == null ? currentProfile.requiredSecretSlots : req.body.requiredSecretSlots.map(String),
        constraints: req.body?.constraints == null ? currentProfile.constraints : req.body.constraints,
      };
      const validation = validateConnectionProfile(candidate);
      if (!validation.ok) throw new ManagedDeploymentError(validation.issues[0].message, "connection-invalid", 400, validation.issues);
      const readiness = await service.secretBroker.status(current.connectionId, candidate.requiredSecretSlots, candidate.credentialIdentity);
      const record = service.store.updateConnection({
        connectionId: current.connectionId,
        expectedMetadataRevision: Number(req.body?.expectedMetadataRevision),
        label: candidate.name,
        readiness: readiness.ready ? "ready" : "missing-secret",
        metadata: json({ publicMetadata: candidate.publicMetadata ?? {}, credentialIdentity: candidate.credentialIdentity ?? null, requiredSecretSlots: candidate.requiredSecretSlots }),
        constraints: json(candidate.constraints),
        secretGeneration: readiness.generation,
        updatedAt: Date.now(),
      });
      res.json({ ok: true, connection: record });
    } catch (error) { apiError(res, error); }
  });

  router.delete("/api/connections/:connectionId", async (req, res) => {
    if (!requireLocal(options, req, res)) return;
    try {
      const current = service.store.getConnection(req.params.connectionId);
      service.store.removeConnection(current.connectionId, Number(req.body?.expectedMetadataRevision));
      await service.secretBroker.purge(current.connectionId);
      res.json({ ok: true });
    } catch (error) { apiError(res, error); }
  });

  router.post("/api/connections/:connectionId/secrets", async (req, res) => {
    if (!requireLocal(options, req, res)) return;
    try {
      const connection = service.store.getConnection(req.params.connectionId);
      const profile = profileFromRecord(connection);
      const slot = String(req.body?.slot || "");
      if (!profile.requiredSecretSlots.includes(slot)) throw new ManagedDeploymentError("secret slot is not declared by this profile", "connection-invalid");
      await service.secretBroker.put(connection.connectionId, slot, String(req.body?.value || ""));
      const status = await service.secretBroker.status(connection.connectionId, profile.requiredSecretSlots, profile.credentialIdentity);
      const current = service.store.getConnection(connection.connectionId);
      service.store.updateConnectionSecretStatus({ connectionId: current.connectionId, expectedSecretGeneration: current.secretGeneration, secretGeneration: status.generation, readiness: status.ready ? "ready" : "missing-secret", updatedAt: Date.now() });
      res.status(201).json({ ok: true, generation: status.generation, ready: status.ready, missingSecretSlots: status.missingSlots });
    } catch (error) { apiError(res, error); }
  });

  router.delete("/api/connections/:connectionId/secrets/:slot", async (req, res) => {
    if (!requireLocal(options, req, res)) return;
    try {
      const connection = service.store.getConnection(req.params.connectionId);
      const profile = profileFromRecord(connection);
      if (!profile.requiredSecretSlots.includes(req.params.slot)) throw new ManagedDeploymentError("secret slot is not declared by this profile", "connection-invalid");
      await service.secretBroker.delete(connection.connectionId, req.params.slot);
      const status = await service.secretBroker.status(connection.connectionId, profile.requiredSecretSlots, profile.credentialIdentity);
      const current = service.store.getConnection(connection.connectionId);
      service.store.updateConnectionSecretStatus({ connectionId: current.connectionId, expectedSecretGeneration: current.secretGeneration, secretGeneration: status.generation, readiness: status.ready ? "ready" : "missing-secret", updatedAt: Date.now() });
      res.json({ ok: true, generation: status.generation, ready: status.ready, missingSecretSlots: status.missingSlots });
    } catch (error) { apiError(res, error); }
  });

  router.post("/api/connections/:connectionId/test", async (req, res) => {
    try {
      const connection = service.store.getConnection(req.params.connectionId);
      const profile = profileFromRecord(connection);
      const readiness = await connectionReadinessView(profile, service.secretBroker);
      res.json({ ok: readiness.ready, readiness });
    } catch (error) { apiError(res, error); }
  });

  router.get("/api/deployment-policies", (_req, res) => {
    try { res.json({ policies: service.store.listLatestPolicies() }); } catch (error) { apiError(res, error); }
  });

  router.put("/api/deployment-policies/:scope", (req, res) => {
    if (!requireLocal(options, req, res)) return;
    try {
      const scopeKind = String(req.body?.scopeKind || "") as "global" | "risk" | "project" | "environment" | "target";
      const scopeId = String(req.body?.scopeId || "");
      if (!scopeId || !["global", "risk", "project", "environment", "target"].includes(scopeKind)) throw new ManagedDeploymentError("valid policy scope is required");
      if (req.params.scope !== `${scopeKind}:${scopeId}`) throw new ManagedDeploymentError("policy URL and body scope differ");
      const layer = { ...asObject(req.body?.document), id: `${scopeKind}:${scopeId}`, revision: 1, source: "local", scope: { kind: scopeKind, id: scopeId } } as DeploymentPolicyLayer;
      const checked = composeDeploymentPolicy("development", [layer]);
      const invalid = checked.blockers.find((item) => item.code === "invalid-policy");
      if (invalid) throw new ManagedDeploymentError(invalid.message, "invalid-policy");
      const policy = service.store.appendPolicy({ scopeKind, scopeId, expectedRevision: req.body?.expectedRevision == null ? null : Number(req.body.expectedRevision), document: json(req.body?.document ?? {}), createdAt: Date.now() });
      res.json({ ok: true, policy });
    } catch (error) { apiError(res, error); }
  });

  router.get("/api/deployment-targets", async (_req, res) => {
    try {
      res.json({ targets: await service.targets() });
    } catch (error) { apiError(res, error); }
  });

  router.get("/api/deployment-targets/:targetId", async (req, res) => {
    try {
      const target = (await service.targets()).find((item) => item.targetId === req.params.targetId);
      if (!target) return res.status(404).json({ error: "deployment target not found", code: "not-found" });
      res.json({ target });
    } catch (error) { apiError(res, error); }
  });

  return router;
}
