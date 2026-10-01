import { randomUUID } from "node:crypto";
import { APP_VERSION } from "../../version.ts";
import { canonicalDigest } from "./canonical.ts";
import type { EffectiveDeploymentPolicy, PolicyBlocker } from "./policy.ts";
import { compareWorkspaceVersions, type DeploymentSourceSnapshot } from "./source.ts";
import type { DeploymentArtifact, DeploymentOperation, DeploymentRelease, JsonValue } from "./store.ts";
import type {
  DeploymentActionNode,
  DeploymentManifestV1,
  EnvironmentManifest,
  ExpandedDeploymentGraph,
} from "./types.ts";
import type { DeploymentObservation, EnvironmentObservations, WatchObservation } from "./observations.ts";

export const DEPLOYMENT_PLAN_SCHEMA = "psm.werewolf.solutions/deployment-plan/v1" as const;

export interface PlanConnectionSnapshot {
  slot: string;
  kind: string;
  connectionId: string | null;
  profile: string | null;
  ready: boolean;
  detail: string;
  metadataRevision: number | null;
  bindingRevision: number | null;
  secretGeneration: number | null;
  principal: string | null;
  scopeFingerprint: string | null;
}

export interface PlanBlocker {
  id: string;
  code: string;
  title: string;
  message: string;
  ownerRef?: string;
}

export interface PlanAcknowledgement {
  id: string;
  label: string;
}

export interface PlannedActionDocument {
  ordinal: number;
  id: string;
  kind: string;
  phase: string;
  ownerRef: string;
  operation: "assert" | "noop" | "create" | "update" | "adopt" | "apply" | "activate" | "verify" | "rollback" | "blocked";
  title: string;
  detail: string;
  sideEffecting: boolean;
  connection?: string;
  dependsOn: string[];
  preconditions: JsonValue;
  intent: JsonValue;
  digest: string;
}

export interface DeploymentPlanDocument {
  schema: typeof DEPLOYMENT_PLAN_SCHEMA;
  planId: string;
  revision: number;
  createdAt: number;
  expiresAt: number;
  projectId: string;
  checkoutId: string;
  environmentId: string;
  operation: DeploymentOperation;
  adoptionResourceId: string | null;
  risk: "development" | "staging" | "production";
  engineVersion: string;
  manifestDigest: string;
  manifest: DeploymentManifestV1;
  source: {
    commit: string;
    version: string;
    branch: string | null;
    identityDigest: string;
    packageDigest: string;
    subject: string;
    inputsDirty: boolean;
    reachableFromAllowedBranch: boolean;
  };
  artifact: DeploymentArtifact | null;
  rollbackRelease: DeploymentRelease | null;
  activeReleases: DeploymentRelease[];
  graph: ExpandedDeploymentGraph;
  connections: PlanConnectionSnapshot[];
  observations: EnvironmentObservations;
  policy: EffectiveDeploymentPolicy;
  lockKeys: string[];
  actions: PlannedActionDocument[];
  blockers: PlanBlocker[];
  acknowledgements: PlanAcknowledgement[];
  blocked: boolean;
}

export interface BuildDeploymentPlanInput {
  planId?: string;
  revision?: number;
  now?: number;
  operation: DeploymentOperation;
  adoptionResourceId?: string | null;
  manifest: DeploymentManifestV1;
  environment: EnvironmentManifest;
  graph: ExpandedDeploymentGraph;
  source: DeploymentSourceSnapshot;
  sourceInputsDirty: boolean;
  sourceReachable: boolean;
  artifact?: DeploymentArtifact | null;
  rollbackRelease?: DeploymentRelease | null;
  activeReleases?: DeploymentRelease[];
  connections: PlanConnectionSnapshot[];
  observations: EnvironmentObservations;
  policy: EffectiveDeploymentPolicy;
  policyBlockers?: PolicyBlocker[];
  /**
   * Action kinds the engine can actually execute. The runner refuses an
   * uninstalled kind before taking a lock, so leaving this out only moves the
   * same refusal later; passing it turns "half-way through an approved
   * production run" into a blocker an operator reads before approving.
   */
  installedActionKinds?: readonly string[];
}

export interface BuiltDeploymentPlan {
  id: string;
  revision: number;
  digest: string;
  createdAt: number;
  expiresAt: number;
  blocked: boolean;
  document: DeploymentPlanDocument;
  actions: PlannedActionDocument[];
}

/** Inputs that must stay approved after this run has changed observed state. */
export function planAuthorityDigest(document: DeploymentPlanDocument): string {
  return canonicalDigest("psm-deployment-plan-authority:v1", {
    projectId: document.projectId,
    checkoutId: document.checkoutId,
    environmentId: document.environmentId,
    operation: document.operation,
    adoptionResourceId: document.adoptionResourceId,
    risk: document.risk,
    engineVersion: document.engineVersion,
    manifestDigest: document.manifestDigest,
    source: document.source,
    artifact: document.artifact,
    rollbackRelease: document.rollbackRelease,
    graph: document.graph,
    connections: document.connections,
    policy: document.policy,
    lockKeys: document.lockKeys,
  });
}

function planId(): string {
  return `dpl_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function blocker(code: string, message: string, ownerRef?: string): PlanBlocker {
  return {
    id: `${code}:${ownerRef ?? "plan"}`,
    code,
    title: code.split("-").map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" "),
    message,
    ...(ownerRef ? { ownerRef } : {}),
  };
}

function resourceObservation(node: DeploymentActionNode, observations: EnvironmentObservations): DeploymentObservation | undefined {
  const match = /^resource:([^/]+)/.exec(node.ownerRef);
  return match ? observations.resources.find((item) => item.id === match[1]) : undefined;
}

function dependencyObservation(node: DeploymentActionNode, observations: EnvironmentObservations): DeploymentObservation | undefined {
  const match = /^dependency:(.+)$/.exec(node.ownerRef);
  return match ? observations.dependencies.find((item) => item.id === match[1]) : undefined;
}

function selectedNodes(
  operation: DeploymentOperation,
  graph: ExpandedDeploymentGraph,
  adoptionResourceId?: string | null,
): DeploymentActionNode[] {
  if (operation === "rollback") return [];
  const phases = operation === "reconcile" || operation === "adopt"
    ? new Set(["dependencies", "reconcile"])
    : operation === "release"
      // Reconciliation nodes become exact no-op assertions after the drift gate below. Keeping
      // them preserves graph edges into release while still refusing an implicit repair.
      ? new Set(["dependencies", "reconcile", "release", "activate", "verify", "watch"])
      : new Set(["dependencies", "reconcile", "release", "activate", "verify", "watch"]);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.order.map((id) => byId.get(id)!).filter((node) => {
    if (!phases.has(node.phase)) return false;
    if (operation !== "adopt") return true;
    return node.phase === "dependencies"
      || (node.ownerRef === `resource:${adoptionResourceId}` && node.kind === "reconcile-dns@1");
  });
}

function actionOperation(
  node: DeploymentActionNode,
  observations: EnvironmentObservations,
  planOperation: DeploymentOperation,
): PlannedActionDocument["operation"] {
  if (node.phase === "dependencies") {
    return dependencyObservation(node, observations)?.state === "ready" ? "assert" : "blocked";
  }
  if (node.phase === "reconcile") {
    if (node.kind === "reload-nginx@1") return "apply";
    const observation = resourceObservation(node, observations);
    if (!observation) return "blocked";
    if (node.kind === "verify-resource@1" || node.kind === "validate-nginx@1") return "verify";
    if (observation.state === "in-sync" || observation.state === "ready") return "noop";
    if (observation.state === "adopt") return planOperation === "adopt" ? "adopt" : "blocked";
    if (observation.state === "create") return "create";
    if (observation.state === "update") return "update";
    return "blocked";
  }
  // The protected controller performs staging, activation, target probes and conditional rollback
  // as one remote transaction. This graph node is the independent local postcondition.
  if (node.kind === "activate-static-release@1" || node.kind === "activate-service-release@1") return "verify";
  if (node.kind === "snapshot-pm2@1") return "assert";
  if (node.phase === "verify" || node.phase === "watch") return "verify";
  return "apply";
}

function actionTitle(node: DeploymentActionNode): string {
  return node.kind.replace(/@\d+$/, "").split("-").map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ");
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function actionFromNode(
  node: DeploymentActionNode,
  ordinal: number,
  observations: EnvironmentObservations,
  planOperation: DeploymentOperation,
): PlannedActionDocument {
  const operation = actionOperation(node, observations, planOperation);
  const observation = node.phase === "dependencies"
    ? dependencyObservation(node, observations)
    : node.phase === "reconcile" ? resourceObservation(node, observations) : undefined;
  const preconditions = toJson({
    dependencyFingerprints: node.phase === "dependencies" && observation ? [observation.fingerprint] : [],
    observedFingerprint: node.phase === "reconcile" ? observation?.fingerprint ?? null : null,
  });
  const intent = toJson({
    ownerRef: node.ownerRef,
    kind: node.kind,
    metadata: node.metadata ?? {},
  });
  const base = {
    ordinal,
    id: node.id,
    kind: node.kind,
    phase: node.phase,
    ownerRef: node.ownerRef,
    operation,
    title: actionTitle(node),
    detail: observation?.detail ?? node.ownerRef,
    sideEffecting: ["create", "update", "adopt", "apply", "activate", "rollback"].includes(operation),
    ...(node.connection ? { connection: node.connection } : {}),
    dependsOn: node.dependsOn,
    preconditions,
    intent,
  };
  return { ...base, digest: canonicalDigest("psm-deployment-action:v1", base) };
}

function rollbackActions(
  environment: EnvironmentManifest,
  release: DeploymentRelease | null,
): PlannedActionDocument[] {
  return environment.units.flatMap((unit, index) => {
    const snapshotBase = {
      ordinal: index * 4,
      id: `unit:${unit.id}#pm2-before-rollback`,
      kind: "snapshot-pm2@1",
      phase: "release",
      ownerRef: `unit:${unit.id}`,
      operation: "assert" as const,
      title: "Snapshot PM2",
      detail: "Capture the shared process set before rollback",
      sideEffecting: false,
      connection: unit.target.observerConnection,
      dependsOn: [] as string[],
      preconditions: toJson({}),
      intent: toJson({ invariant: "unchanged" }),
    };
    const snapshot = { ...snapshotBase, digest: canonicalDigest("psm-deployment-action:v1", snapshotBase) };
    const base = {
      ordinal: index * 4 + 1,
      id: `unit:${unit.id}#rollback`,
      kind: unit.recipe === "node-service-ssh-nginx@1" ? "activate-service-release@1" : "activate-static-release@1",
      phase: "activate",
      ownerRef: `unit:${unit.id}`,
      operation: release ? "rollback" as const : "blocked" as const,
      title: "Activate retained release",
      detail: release ? release.releaseId : "No retained release was selected",
      sideEffecting: !!release,
      connection: unit.executor.connection,
      dependsOn: [snapshot.id],
      preconditions: toJson({ activeReleaseId: null }),
      intent: toJson({ releaseId: release?.releaseId ?? null, targetId: unit.target.targetId }),
    };
    const activate = { ...base, digest: canonicalDigest("psm-deployment-action:v1", base) };
    const verifyBase = {
      ordinal: index * 4 + 2,
      id: `unit:${unit.id}#verify-rollback`,
      kind: "verify-release@1",
      phase: "verify",
      ownerRef: `unit:${unit.id}`,
      operation: "verify" as const,
      title: "Verify rolled-back release",
      detail: `${unit.verification.length} verification probe${unit.verification.length === 1 ? "" : "s"}`,
      sideEffecting: false,
      dependsOn: [activate.id],
      preconditions: toJson({ releaseId: release?.releaseId ?? null }),
      intent: toJson({ verificationIds: unit.verification.map((probe) => probe.id) }),
    };
    const verify = { ...verifyBase, digest: canonicalDigest("psm-deployment-action:v1", verifyBase) };
    const compareBase = {
      ordinal: index * 4 + 3,
      id: `unit:${unit.id}#pm2-unchanged-rollback`,
      kind: "compare-pm2@1",
      phase: "verify",
      ownerRef: `unit:${unit.id}`,
      operation: "verify" as const,
      title: "Compare PM2",
      detail: "Shared process set must remain unchanged",
      sideEffecting: false,
      connection: unit.target.observerConnection,
      dependsOn: [snapshot.id, verify.id],
      preconditions: toJson({}),
      intent: toJson({ invariant: "unchanged" }),
    };
    return [snapshot, activate, verify, { ...compareBase, digest: canonicalDigest("psm-deployment-action:v1", compareBase) }];
  });
}

function watchIsFresh(definitionMaxAge: number, observation: WatchObservation | undefined, now: number): boolean {
  return !!observation
    && observation.effectiveState === "healthy"
    && now - observation.observedAt <= definitionMaxAge * 1_000;
}

function lockKeys(environment: EnvironmentManifest, operation: DeploymentOperation): string[] {
  const keys = new Set<string>();
  if (operation !== "release" && operation !== "rollback") {
    for (const resource of environment.resources) keys.add(`resource/${resource.kind}/${resource.id}`);
  }
  if (operation !== "reconcile" && operation !== "adopt") {
    for (const unit of environment.units) keys.add(`target/${unit.target.targetId}`);
  }
  return [...keys].sort();
}

function hasRegressionRationale(subject: string): boolean {
  return /(?:version[- ]regression[- ]reason|version decrease|lower version)\s*:/i.test(subject);
}

/**
 * The plan's content, with "when we looked" left out.
 *
 * The runner re-derives an approved plan at every mutation gate and refuses to
 * continue unless the digest still matches, so any field that moves on its own
 * turns a legitimate run into "the plan changed since approval". Observation
 * timestamps do exactly that: they are `Date.now()` at build time, so a rebuild
 * a millisecond later already failed the gate.
 *
 * Timestamps and HTTP response duration are diagnostic measurements, not
 * changes to the observed service. Keep status, URL, redirects, state and
 * other evidence in the digest so actual drift still stops execution. The
 * document retains real measurement times for the operator to inspect.
 */
function digestableDocument(document: DeploymentPlanDocument): DeploymentPlanDocument {
  const atZero = <T extends { observedAt: number }>(item: T): T => ({ ...item, observedAt: 0 });
  const stableDependency = (item: DeploymentObservation): DeploymentObservation => ({
    ...atZero(item),
    ...(item.evidence && Object.hasOwn(item.evidence, "durationMs")
      ? { evidence: { ...item.evidence, durationMs: 0 } } : {}),
  });
  const observations = document.observations;
  return {
    ...document,
    observations: {
      ...observations,
      dependencies: observations.dependencies.map(stableDependency),
      resources: observations.resources.map(atZero),
      watch: observations.watch.map(atZero),
      observedAt: 0,
    },
  };
}

export function buildDeploymentPlan(input: BuildDeploymentPlanInput): BuiltDeploymentPlan {
  const now = input.now ?? Date.now();
  const id = input.planId ?? planId();
  const revision = input.revision ?? 1;
  const ttlSeconds = Math.max(30, Math.min(input.policy.planTtlSeconds ?? input.environment.policy.planTtlSeconds, 3_600));
  const expiresAt = now + ttlSeconds * 1_000;
  const blockers: PlanBlocker[] = [];
  const acknowledgements: PlanAcknowledgement[] = [];

  for (const item of input.policyBlockers ?? []) blockers.push(blocker(item.code, item.message, item.layerId));
  for (const connection of input.connections) {
    if (!connection.ready) blockers.push(blocker("connection-missing", connection.detail, `connection:${connection.slot}`));
  }
  for (const check of input.observations.execution ?? []) {
    if (check.purpose === "deploy" && !check.ready) blockers.push(blocker("executor-not-ready", check.detail, `executor:${check.id}`));
  }
  if (input.sourceInputsDirty) {
    blockers.push(blocker("source-dirty", "Local changes are not committed yet. Review changes and commit through PSM; it assigns the release version before preparing a new build.", "source"));
  }
  if (input.environment.releasePolicy.requireReachableFromBranch && !input.sourceReachable) {
    blockers.push(blocker("source-unreachable", `Commit is not reachable from ${input.environment.releasePolicy.allowedBranch}`, "source"));
  }
  if (input.operation !== "rollback") {
    for (const observation of input.observations.dependencies) {
      if (observation.state !== "ready") blockers.push(blocker("dependency-failed", observation.detail, `dependency:${observation.id}`));
    }
  }
  if (input.operation === "release") {
    for (const observation of input.observations.resources) {
      if (observation.state !== "in-sync" && observation.state !== "ready") {
        blockers.push(blocker("resource-drift", `${observation.id}: ${observation.detail}`, `resource:${observation.id}`));
      }
    }
  }
  if (input.operation === "reconcile" || input.operation === "deploy" || input.operation === "adopt") {
    for (const observation of input.observations.resources) {
      if (["blocked", "conflict", "unknown", "missing"].includes(observation.state)) {
        blockers.push(blocker(observation.state === "conflict" ? "resource-conflict" : "resource-observation-failed", observation.detail, `resource:${observation.id}`));
      }
      if (observation.state === "adopt" && input.operation !== "adopt") {
        blockers.push(blocker("resource-adoption-required", observation.detail, `resource:${observation.id}`));
      }
    }
  }
  if (input.operation === "adopt") {
    const resource = input.environment.resources.find((item) => item.id === input.adoptionResourceId);
    const observation = input.observations.resources.find((item) => item.id === input.adoptionResourceId);
    if (!resource || resource.kind !== "digitalocean-dns-record@1") {
      blockers.push(blocker("resource-adoption-invalid", "Select one adoptable provider resource", "adoption"));
    } else if (observation?.state !== "adopt") {
      blockers.push(blocker("resource-adoption-stale", observation?.detail ?? "The resource has no adoptable observation", `resource:${resource.id}`));
    }
  }

  const needsArtifact = input.operation === "release" || input.operation === "deploy";
  if (needsArtifact && !input.artifact) blockers.push(blocker("artifact-missing", "Select or prepare an immutable artifact", "artifact"));
  if (needsArtifact && !input.artifact) {
    for (const release of input.activeReleases ?? []) {
      const receipt = release.receipt as { version?: unknown; verified?: unknown };
      if (typeof receipt.version !== "string" || receipt.verified === false) continue;
      const compared = compareWorkspaceVersions(input.source.version, receipt.version);
      if (compared <= 0 && !(compared < 0 && hasRegressionRationale(input.source.subject))) {
        blockers.push(blocker("version-not-increased", `Committed source ${input.source.version} needs a release version newer than active ${receipt.version}. Make ready can create a versioned commit through PSM before publishing and building.`, "source"));
      }
    }
  }
  if (input.artifact) {
    if (input.artifact.tombstonedAt !== null || input.artifact.retainedUntil <= now) blockers.push(blocker("artifact-expired", "The selected artifact is no longer retained", "artifact"));
    if (input.artifact.commitSha !== input.source.commit) blockers.push(blocker("artifact-source-mismatch", "Artifact and exact source commit differ", "artifact"));
    for (const unit of input.environment.units) {
      if (input.artifact.sourceRepository !== unit.executor.sourceRepository) blockers.push(blocker("artifact-repository-mismatch", "Artifact was produced by a different source repository", "artifact"));
      const profileDigest = canonicalDigest("psm-deployment-build-profile:v1", unit.artifact.buildProfile);
      if (input.artifact.buildProfileDigest !== profileDigest) blockers.push(blocker("artifact-build-profile-mismatch", "Artifact was built with different environment inputs", "artifact"));
    }
    // An old artifact needs rebuilding, not another source version bump.
    const activeVersions = input.artifact.commitSha === input.source.commit ? input.activeReleases ?? [] : [];
    for (const release of activeVersions) {
      const receipt = release.receipt as { version?: unknown; verified?: unknown; commit?: unknown; payloadDigest?: unknown };
      if (typeof receipt.version !== "string") continue;
      const compared = compareWorkspaceVersions(input.artifact.version, receipt.version);
      if (compared <= 0) {
        // A later PSM probe can fail after the controller verified and activated
        // this exact artifact (for example, while local DNS still caches NXDOMAIN).
        // Repeating the same reviewed release can finish verification in place;
        // another artifact at the same version remains refused.
        const verifyingActiveArtifact = compared === 0
          && release.provenance === "managed"
          && release.projectId === input.manifest.projectId
          && release.environmentId === input.environment.id
          && input.environment.units.some((unit) => unit.id === release.unitId && unit.target.targetId === release.targetId)
          && release.artifactId === input.artifact.artifactId
          && receipt.commit === input.artifact.commitSha
          && receipt.payloadDigest === input.artifact.payloadDigest;
        if (verifyingActiveArtifact) continue;
        if (compared < 0 && hasRegressionRationale(input.source.subject)) {
          acknowledgements.push({ id: "version-decrease", label: `Deploy lower version ${input.artifact.version} over ${receipt.version}` });
        } else {
          blockers.push(blocker("version-not-increased", `Artifact ${input.artifact.version} must be newer than active ${receipt.version}. Increase the project's root package.json version, commit and push it, then prepare and select a new build.`, `release:${release.releaseId}`));
        }
      }
    }
  }
  if (input.operation === "rollback" && !input.rollbackRelease) {
    blockers.push(blocker("release-missing", "Select an exact retained release", "rollback"));
  }

  if (needsArtifact && input.policy.requireFreshWatchBeforeRelease) {
    for (const definition of input.environment.watch) {
      const observation = input.observations.watch.find((item) => item.monitorId === definition.id);
      const maximumAge = Math.min(definition.maxObservationAgeSeconds, input.policy.maxWatchAgeSeconds ?? Infinity);
      if (!watchIsFresh(maximumAge, observation, now)) {
        blockers.push(blocker("monitor-stale", `${definition.id} has no fresh healthy external observation`, `watch:${definition.id}`));
      }
    }
  }
  if (input.policy.risk === "production") {
    acknowledgements.push({ id: "production-target", label: "I reviewed this exact production target, source, artifact and action graph." });
  }

  const actions = input.operation === "rollback"
    ? rollbackActions(input.environment, input.rollbackRelease ?? null)
    : selectedNodes(input.operation, input.graph, input.adoptionResourceId).map((node, ordinal) => actionFromNode(node, ordinal, input.observations, input.operation));
  for (const action of actions) {
    if (action.operation === "blocked") blockers.push(blocker("action-blocked", action.detail, action.ownerRef));
  }
  if (input.installedActionKinds) {
    const installed = new Set(input.installedActionKinds);
    for (const kind of [...new Set(actions.map((action) => action.kind))].sort()) {
      if (installed.has(kind)) continue;
      blockers.push(blocker("executor-missing", `No installed executor performs ${kind}`, `action-kind:${kind}`));
    }
  }

  const documentWithoutBlocked = {
    schema: DEPLOYMENT_PLAN_SCHEMA,
    planId: id,
    revision,
    createdAt: now,
    expiresAt,
    projectId: input.manifest.projectId,
    checkoutId: input.source.checkoutId,
    environmentId: input.environment.id,
    operation: input.operation,
    adoptionResourceId: input.adoptionResourceId ?? null,
    risk: input.policy.risk,
    engineVersion: APP_VERSION,
    manifestDigest: input.source.manifestDigest,
    manifest: input.manifest,
    source: {
      commit: input.source.commit,
      version: input.source.version,
      branch: input.source.branch,
      identityDigest: input.source.identityDigest,
      packageDigest: input.source.packageDigest,
      subject: input.source.subject,
      inputsDirty: input.sourceInputsDirty,
      reachableFromAllowedBranch: input.sourceReachable,
    },
    artifact: input.artifact ?? null,
    rollbackRelease: input.rollbackRelease ?? null,
    activeReleases: input.activeReleases ?? [],
    graph: input.graph,
    connections: input.connections,
    observations: input.observations,
    policy: input.policy,
    lockKeys: lockKeys(input.environment, input.operation),
    actions,
    blockers,
    acknowledgements: [...new Map(acknowledgements.map((item) => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
  const document: DeploymentPlanDocument = { ...documentWithoutBlocked, blocked: blockers.length > 0 };
  const digest = canonicalDigest(DEPLOYMENT_PLAN_SCHEMA, digestableDocument(document));
  return { id, revision, digest, createdAt: now, expiresAt, blocked: document.blocked, document, actions };
}

export function planView(plan: BuiltDeploymentPlan | { digest: string; document: DeploymentPlanDocument }): Record<string, unknown> {
  const document = plan.document;
  return {
    id: document.planId,
    revision: document.revision,
    digest: plan.digest,
    createdAt: document.createdAt,
    expiresAt: document.expiresAt,
    operation: document.operation,
    risk: document.risk,
    blocked: document.blocked,
    blockers: document.blockers,
    acknowledgements: document.acknowledgements,
    actions: document.actions.map((action) => ({
      id: action.id,
      kind: action.kind,
      phase: action.phase,
      operation: action.operation,
      state: action.operation,
      title: action.title,
      detail: action.detail,
      sideEffecting: action.sideEffecting,
    })),
  };
}
