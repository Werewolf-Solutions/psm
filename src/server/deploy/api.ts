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
import { ManagedDeploymentError, DeploymentService } from "./service.ts";
import {
  DeploymentConflictError,
  DeploymentNotFoundError,
  DeploymentStoreError,
  DeploymentTransitionError,
  DeploymentValidationError,
  type DeploymentConnection,
  type DeploymentOperation,
  type JsonValue,
} from "./store.ts";
import { authorizeDeploymentAction, composeDeploymentPolicy, type DeploymentPolicyLayer, type EffectiveDeploymentPolicy } from "./policy.ts";

export interface DeploymentRunController {
  enqueue(runId: string): void | Promise<void>;
  cancel(runId: string): unknown | Promise<unknown>;
}

export interface ArtifactPreparationController {
  prepare(input: { projectId: string; environmentId: string; unitId?: string }): Promise<{ runId: string }>;
}

export interface DeploymentApiOptions {
  service: DeploymentService;
  currentUser: () => Promise<PsmSessionUser | null>;
  localRequest: (request: Request) => boolean;
  runner?: DeploymentRunController;
  preparer?: ArtifactPreparationController;
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
  const { service } = options;
  const intents = options.intents ?? new ApprovalIntentRegistry();
  const streamTickets = options.streamTickets ?? new DeploymentStreamTicketRegistry();

  router.get("/api/projects/:id/deployments", async (req, res) => {
    try { res.json(await service.overview(req.params.id)); } catch (error) { apiError(res, error); }
  });

  router.get("/api/projects/:id/deployments/:environment", async (req, res) => {
    try { res.json({ managed: true, environment: await service.environmentView(req.params.id, req.params.environment) }); } catch (error) { apiError(res, error); }
  });

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
      const decision = authorizeDeploymentAction(policy, { action: "approve", origin, authenticated: !!user });
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
      const decision = authorizeDeploymentAction(policy, { action: "approve", origin, authenticated: !!user });
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

  router.post("/api/deployment-runs/:runId/cancel", async (req, res) => {
    try {
      const run = service.store.getRun(req.params.runId);
      if (run.planId) {
        const plan = service.store.getPlan(run.planId, run.planRevision!);
        if (plan.risk === "production") {
          const user = await options.currentUser();
          if (!exactLocalCockpitOrigin(req) || !user) return res.status(403).json({ error: "production cancellation requires the authenticated local cockpit", code: "approval-required" });
        }
      }
      if (options.runner) await options.runner.cancel(run.runId);
      else service.store.requestCancellation(run.runId, Date.now());
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
