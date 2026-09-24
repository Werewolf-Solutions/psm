import { connectionDiagnostics, sameObservedConnection } from "./connection-diagnostics.ts";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Project } from "../../types.ts";
import { canonicalDigest } from "./canonical.ts";
import { discoverConnectionDefaults, type GitHubDefaults } from "./connection-defaults.ts";
import {
  connectionReadinessView,
  resolveConnectionBinding,
  SecretBroker,
  validateConnectionScope,
  type ConnectionProfile,
  type ConnectionScopeRequest,
  type JsonValue as ConnectionJsonValue,
} from "./connections.ts";
import { expandDeploymentGraph } from "./graph.ts";
import { loadDeploymentManifest, parseDeploymentManifest } from "./manifest.ts";
import { observeEnvironment, type ObservationAdapters } from "./observations.ts";
import { buildDeploymentPlan, planView, type DeploymentPlanDocument, type PlanConnectionSnapshot } from "./planner.ts";
import { composeDeploymentPolicy, type DeploymentPolicyLayer } from "./policy.ts";
import { deploymentReadiness, type DeploymentReadiness } from "./readiness.ts";
import {
  checkoutId,
  commitReachableFrom,
  deploymentInputsDirty,
  readDeploymentSource,
  resolveCommit,
  type DeploymentSourceSnapshot,
} from "./source.ts";
import {
  DeploymentNotFoundError,
  DeploymentStore,
  type DeploymentArtifact,
  type DeploymentConnection,
  type DeploymentOperation,
  type DeploymentPlan,
  type DeploymentRelease,
  type JsonValue,
} from "./store.ts";
import type { DeploymentManifestV1, EnvironmentManifest, UnitManifest } from "./types.ts";

export class ManagedDeploymentError extends Error {
  constructor(
    message: string,
    readonly code = "deployment-invalid",
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ManagedDeploymentError";
  }
}

export interface ManagedDeploymentProject {
  id: string;
  name: string;
  path: string;
  gitBranch?: string | null;
  gitLastSubject?: string | null;
}

/** One project's dependency on another, as the manifest declares it and the last plan observed it. */
export interface CrossProjectDependencyEdge {
  dependentProjectId: string;
  dependentProjectName: string;
  dependentEnvironmentId: string;
  dependencyId: string;
  kind: string;
  ownerProjectId: string;
  /** null when psm can no longer find the owning project — the edge still matters. */
  ownerProjectName: string | null;
  ownerEnvironmentId: string | null;
  /** Whether the owner is also in the room, which decides how the UI links to it. */
  ownerInRoom: boolean;
  state: string;
  detail: string;
  observedAt: number | null;
}

export interface DeploymentServiceOptions {
  store: DeploymentStore;
  secretBroker: SecretBroker;
  projects: () => readonly Project[] | readonly ManagedDeploymentProject[];
  observations?: ObservationAdapters;
  artifactPreparationAvailable?: boolean;
  /** Action kinds the runner has adapters for; surfaced as plan blockers, not run-time surprises. */
  installedActionKinds?: readonly string[];
  githubConnectionDefaults?: (repo: string, workflow: string, ref?: string) => Promise<GitHubDefaults>;
}

interface LoadedContext {
  project: ManagedDeploymentProject;
  manifest: DeploymentManifestV1;
  source: DeploymentSourceSnapshot;
  committed: boolean;
  sourceInputsDirty: boolean;
}

interface ResolvedEnvironment {
  context: LoadedContext;
  environment: EnvironmentManifest;
  connections: PlanConnectionSnapshot[];
  connectionPolicyLayers: DeploymentPolicyLayer[];
}

export interface ArtifactPreparationContext {
  project: ManagedDeploymentProject;
  source: DeploymentSourceSnapshot;
  manifest: DeploymentManifestV1;
  environment: EnvironmentManifest;
  unit: EnvironmentManifest["units"][number];
  connection: ConnectionProfile;
}

const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function profileFromRecord(connection: DeploymentConnection): ConnectionProfile {
  const metadata = object(connection.metadata);
  const constraints = object(connection.constraints);
  return {
    connectionId: connection.connectionId,
    name: connection.label,
    kind: connection.kind,
    metadataRevision: connection.metadataRevision,
    publicMetadata: object(metadata.publicMetadata) as ConnectionProfile["publicMetadata"],
    ...(metadata.credentialIdentity ? { credentialIdentity: metadata.credentialIdentity as ConnectionProfile["credentialIdentity"] } : {}),
    requiredSecretSlots: Array.isArray(metadata.requiredSecretSlots)
      ? metadata.requiredSecretSlots.filter((item): item is string => typeof item === "string")
      : [],
    constraints: constraints as unknown as ConnectionProfile["constraints"],
  };
}

function exactManifest(
  project: ManagedDeploymentProject,
  revision: string,
): LoadedContext {
  const source = readDeploymentSource(project.path, revision);
  const manifest = parseDeploymentManifest(JSON.parse(source.manifestText), {
    projectRoot: project.path,
    expectedProjectId: project.id,
    identityProjectId: source.projectId,
    packageVersion: source.version,
  });
  return {
    project,
    manifest,
    source,
    committed: true,
    sourceInputsDirty: deploymentInputsDirty(project.path),
  };
}

/** Current worktree fallback is preview-only; approval is blocked through sourceInputsDirty. */
function previewManifest(project: ManagedDeploymentProject): LoadedContext {
  const loaded = loadDeploymentManifest(project.path, project.id);
  if (!loaded) throw new ManagedDeploymentError("project has no managed deployment manifest", "manifest-missing", 404);
  const manifestText = fs.readFileSync(loaded.manifestPath, "utf8");
  const identityText = fs.readFileSync(`${project.path}/.psm/identity.json`, "utf8");
  const packageText = fs.readFileSync(`${project.path}/package.json`, "utf8");
  const identity = JSON.parse(identityText) as { id?: string };
  const pkg = JSON.parse(packageText) as { version?: string };
  const source: DeploymentSourceSnapshot = {
    checkoutId: checkoutId(project.path),
    checkoutPath: fs.realpathSync(project.path),
    commit: resolveCommit(project.path),
    branch: project.gitBranch ?? null,
    manifestText,
    manifestDigest: sha256(manifestText),
    identityText,
    identityDigest: sha256(identityText),
    packageText,
    packageDigest: sha256(packageText),
    projectId: String(identity.id ?? ""),
    version: String(pkg.version ?? ""),
    subject: project.gitLastSubject ?? "",
  };
  return { project, manifest: loaded.manifest, source, committed: false, sourceInputsDirty: true };
}

function releaseView(release: DeploymentRelease, activeReleaseId: string | null): Record<string, unknown> {
  const receipt = object(release.receipt);
  return {
    releaseId: release.releaseId,
    version: typeof receipt.version === "string" ? receipt.version : null,
    commit: typeof receipt.commit === "string" ? receipt.commit : null,
    psmArtifactId: release.artifactId,
    activatedAt: release.activatedAt,
    active: release.releaseId === activeReleaseId,
    retained: release.tombstonedAt === null,
    provenance: release.provenance,
  };
}

function runTerminal(state: string): boolean {
  return ["succeeded", "failed", "cancelled", "interrupted", "stale-plan", "rolled-back"].includes(state);
}

export class DeploymentService {
  readonly store: DeploymentStore;
  readonly secretBroker: SecretBroker;
  readonly #projects: DeploymentServiceOptions["projects"];
  readonly observations: ObservationAdapters;
  readonly artifactPreparationAvailable: boolean;
  readonly installedActionKinds: readonly string[] | undefined;
  readonly #githubConnectionDefaults: DeploymentServiceOptions["githubConnectionDefaults"];

  constructor(options: DeploymentServiceOptions) {
    this.store = options.store;
    this.secretBroker = options.secretBroker;
    this.#projects = options.projects;
    this.observations = options.observations ?? {};
    this.artifactPreparationAvailable = options.artifactPreparationAvailable ?? false;
    this.installedActionKinds = options.installedActionKinds;
    this.#githubConnectionDefaults = options.githubConnectionDefaults;
  }

  resolveProject(idOrName: string): ManagedDeploymentProject {
    const project = this.#projects().find((item) => item.id === idOrName || item.name === idOrName);
    if (!project || !project.id) throw new ManagedDeploymentError("project not found", "project-not-found", 404);
    return { id: project.id, name: project.name, path: project.path, gitBranch: project.gitBranch, gitLastSubject: project.gitLastSubject };
  }

  private loadCurrent(idOrName: string): LoadedContext {
    const project = this.resolveProject(idOrName);
    try { return exactManifest(project, "HEAD"); } catch (exactError) {
      try { return previewManifest(project); } catch (previewError) {
        if (previewError instanceof ManagedDeploymentError) throw previewError;
        throw new ManagedDeploymentError(
          previewError instanceof Error ? previewError.message : String(previewError),
          "manifest-invalid",
          400,
          exactError instanceof Error ? exactError.message : String(exactError),
        );
      }
    }
  }

  private scopeRequests(environment: EnvironmentManifest, slot: string): ConnectionScopeRequest[] {
    const base = { projectId: "", environmentId: environment.id, risk: environment.risk };
    const requests: ConnectionScopeRequest[] = [{ ...base }];
    for (const resource of environment.resources.filter((item) => item.connection === slot)) {
      if (resource.kind === "digitalocean-dns-record@1") requests.push({ ...base, zone: resource.desired.zone });
      if (resource.kind === "host-release-directory@1") requests.push({ ...base, targetRoot: resource.desired.root });
      if (resource.kind === "nginx-static-site@1" || resource.kind === "letsencrypt-certificate@1") {
        requests.push({ ...base });
      }
    }
    for (const unit of environment.units) {
      if (unit.executor.connection === slot) requests.push({ ...base, repository: unit.executor.sourceRepository, sourceRef: environment.releasePolicy.allowedBranch });
      if (unit.target.observerConnection === slot) requests.push({ ...base, targetId: unit.target.targetId, targetRoot: unit.target.root });
    }
    for (const watch of environment.watch.filter((item) => item.connection === slot)) requests.push({ ...base, monitorId: watch.monitorKey });
    return requests;
  }

  private async resolveEnvironment(context: LoadedContext, environmentId: string): Promise<ResolvedEnvironment> {
    const environment = context.manifest.environments.find((item) => item.id === environmentId);
    if (!environment) throw new ManagedDeploymentError("deployment environment not found", "environment-not-found", 404);
    const connections: PlanConnectionSnapshot[] = [];
    const connectionPolicyLayers: DeploymentPolicyLayer[] = [];
    for (const [slot, declaration] of Object.entries(environment.connections).sort(([left], [right]) => left.localeCompare(right))) {
      try {
        const binding = this.store.getConnectionBinding(context.source.checkoutId, environment.id, slot);
        const record = this.store.getConnection(binding.connectionId);
        const profile = profileFromRecord(record);
        const scopes = this.scopeRequests(environment, slot).map((scope) => ({ ...scope, projectId: context.project.id }));
        const issues = scopes.flatMap((scope) => validateConnectionScope(profile, declaration.kind, scope).issues);
        // Binding identity itself is checked separately from every use-specific scope.
        try {
          resolveConnectionBinding(
            { slot, kind: declaration.kind },
            { checkoutId: binding.checkoutId, environmentId: binding.environmentId, slot: binding.slot, connectionId: binding.connectionId, bindingRevision: binding.bindingRevision },
            profile,
            { checkoutId: context.source.checkoutId, environmentId: environment.id },
            scopes[0],
          );
        } catch (error) {
          if (error && typeof error === "object" && "issues" in error && Array.isArray((error as { issues: unknown[] }).issues)) {
            issues.push(...((error as { issues: typeof issues }).issues));
          } else throw error;
        }
        const readiness = await connectionReadinessView(profile, this.secretBroker);
        // Imported or externally provisioned credentials can leave the cached
        // missing-secret flag behind. Runtime adapters and the cockpit must
        // agree on the broker's current presence/generation, without overriding
        // an invalid profile or racing a metadata/credential change.
        const credentialState = readiness.ready ? "ready" : "missing-secret";
        if (record.readiness !== "invalid" && (record.readiness !== credentialState || record.secretGeneration !== readiness.secretGeneration)) {
          this.store.updateConnectionSecretStatus({ connectionId: record.connectionId, expectedSecretGeneration: record.secretGeneration,
            expectedMetadataRevision: record.metadataRevision, secretGeneration: readiness.secretGeneration, readiness: credentialState, updatedAt: Date.now() });
        }
        const ready = readiness.ready && issues.length === 0 && record.readiness !== "invalid";
        connections.push({
          slot,
          kind: declaration.kind,
          connectionId: record.connectionId,
          profile: record.label,
          ready,
          detail: ready ? "Bound and within local scope" : issues[0]?.message ?? (readiness.missingSecretSlots.length ? `Missing secret: ${readiness.missingSecretSlots.join(", ")}` : `Connection is ${record.readiness}`),
          metadataRevision: record.metadataRevision,
          bindingRevision: binding.bindingRevision,
          secretGeneration: readiness.secretGeneration,
          principal: readiness.credentialFingerprint,
          scopeFingerprint: canonicalDigest("psm-deployment-connection-scope:v1", { scopes, constraints: profile.constraints }),
        });
        connectionPolicyLayers.push({
          id: `connection:${record.connectionId}`,
          revision: `${record.metadataRevision}:${readiness.secretGeneration}`,
          source: "connection",
          scope: { kind: "connection", id: record.connectionId },
          minimumRisk: profile.constraints.minimumRequiredRisk,
          maximumAuthorizedRisk: profile.constraints.maximumAuthorizedRisk,
          allowedSourceRefs: profile.constraints.allowedSourceRefs,
        });
      } catch (error) {
        const detail = error instanceof DeploymentNotFoundError
          ? "No local profile is bound"
          : error instanceof Error ? error.message : String(error);
        connections.push({ slot, kind: declaration.kind, connectionId: null, profile: null, ready: false, detail, metadataRevision: null, bindingRevision: null, secretGeneration: null, principal: null, scopeFingerprint: null });
      }
    }
    return { context, environment, connections, connectionPolicyLayers };
  }

  private policyLayers(resolved: ResolvedEnvironment): DeploymentPolicyLayer[] {
    const { context, environment } = resolved;
    const targetIds = new Set(environment.units.map((unit) => unit.target.targetId));
    const selected = this.store.listLatestPolicies().filter((record) => {
      if (record.scopeKind === "global") return true;
      if (record.scopeKind === "risk") return record.scopeId === environment.risk;
      if (record.scopeKind === "project") return record.scopeId === context.project.id;
      if (record.scopeKind === "environment") return record.scopeId === `${context.project.id}/${environment.id}`;
      return targetIds.has(record.scopeId);
    });
    const local = selected.map((record) => ({
      ...object(record.document),
      id: `${record.scopeKind}:${record.scopeId}`,
      revision: record.revision,
      source: "local",
      scope: { kind: record.scopeKind, id: record.scopeId },
    } as DeploymentPolicyLayer));
    const manifest: DeploymentPolicyLayer = {
      id: `manifest:${context.source.manifestDigest}:${environment.id}`,
      revision: context.source.manifestDigest,
      source: "manifest",
      scope: { kind: "manifest", id: environment.id },
      minimumRisk: environment.risk,
      planTtlSeconds: environment.policy.planTtlSeconds,
      approval: environment.releasePolicy.approval,
      requireFreshWatchBeforeRelease: environment.policy.requireFreshWatchBeforeRelease,
      authority: {
        delete: environment.policy.allowDelete,
        automaticRollback: environment.policy.rollbackOnVerificationFailure,
      },
    };
    return [manifest, ...local, ...resolved.connectionPolicyLayers];
  }

  private releases(environment: EnvironmentManifest): { all: DeploymentRelease[]; active: DeploymentRelease[] } {
    const all = environment.units.flatMap((unit) => this.store.listReleases(unit.target.targetId));
    const active = environment.units.flatMap((unit) => {
      const release = this.store.getActiveRelease(unit.target.targetId);
      return release ? [release] : [];
    });
    return { all, active };
  }

  runView(runId: string): Record<string, unknown> {
    const run = this.store.getRun(runId);
    return {
      id: run.runId,
      kind: run.runKind,
      operation: run.operation,
      state: run.state,
      phase: run.phase,
      auditDegraded: run.auditDegraded,
      cancellationRequestedAt: run.cancellationRequestedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      finishedAt: run.finishedAt,
      terminal: runTerminal(run.state),
      events: this.store.listEvents(run.runId).map((event) => ({ ...event, id: `${event.runId}:${event.sequence}` })),
      steps: this.store.listRunSteps(run.runId),
    };
  }

  private storedPlanView(plan: DeploymentPlan | undefined): Record<string, unknown> | null {
    if (!plan) return null;
    return planView({ digest: plan.digest, document: plan.document as unknown as DeploymentPlanDocument });
  }

  /**
   * The host target a project environment's manifest names — what a machine's
   * deploy identities must be enrolled for. Null when the manifest has none.
   */
  hostTarget(idOrName: string, environmentId: string): { slot: string; unitId: string; targetId: string; root: string; allowedRootPrefix: string; hostname: string | null } | null {
    let context: LoadedContext;
    try { context = this.loadCurrent(idOrName); } catch { return null; }
    const environment = context.manifest.environments.find((entry) => entry.id === environmentId);
    const unit = environment?.units.find((entry) => entry.target.kind === "ssh-release-directory@1");
    if (!environment || !unit) return null;
    const hostname = environment.resources.find((item) => item.kind === "nginx-static-site@1")?.desired.hostname ?? null;
    return {
      slot: unit.target.observerConnection, unitId: unit.id, targetId: unit.target.targetId, root: unit.target.root,
      allowedRootPrefix: unit.target.root.slice(0, unit.target.root.lastIndexOf("/")) || "/", hostname: typeof hostname === "string" ? hostname : null,
    };
  }

  /** The environment's unit released by a GitHub release controller, with what its adapters need. */
  releaseControllerUnit(idOrName: string, environmentId: string): { unit: UnitManifest; environment: EnvironmentManifest; checkoutId: string; projectId: string } {
    const context = this.loadCurrent(idOrName);
    const environment = context.manifest.environments.find((entry) => entry.id === environmentId);
    if (!environment) throw new ManagedDeploymentError("deployment environment not found", "environment-not-found", 404);
    const unit = environment.units.find((entry) => entry.executor.kind === "github-actions@1" && entry.executor.releaseController && entry.target.kind === "ssh-release-directory@1");
    if (!unit) throw new ManagedDeploymentError("this environment has no GitHub release controller", "release-controller-missing", 404);
    return { unit, environment, checkoutId: context.source.checkoutId, projectId: context.project.id };
  }

  async environmentView(idOrName: string, environmentId: string): Promise<Record<string, unknown>> {
    const context = this.loadCurrent(idOrName);
    const resolved = await this.resolveEnvironment(context, environmentId);
    const { environment, connections } = resolved;
    const { all, active } = this.releases(environment);
    const plans = this.store.listPlans(context.project.id, environment.id);
    const runs = this.store.listRuns(context.project.id, environment.id);
    const latestPlan = plans[0];
    const planDocument = latestPlan?.document as unknown as DeploymentPlanDocument | undefined;
    const hasCurrentObservation = (connection: typeof connections[number]) => planDocument?.manifestDigest === context.source.manifestDigest
      && planDocument.connections.some((observed) => sameObservedConnection(connection, observed));
    const dependencies = planDocument?.observations?.dependencies ?? environment.dependencies.map((item) => ({ id: item.id, kind: item.kind, state: "unknown", title: item.id, detail: "Choose Discover changes" }));
    const resources = planDocument?.observations?.resources ?? environment.resources.map((item) => ({ id: item.id, kind: item.kind, state: "unknown", title: item.id, detail: "Choose Discover changes" }));
    const firstUnit = environment.units[0];
    const hostname = environment.resources.find((item) => item.kind === "nginx-static-site@1")?.desired.hostname ?? environment.watch[0]?.hostname ?? null;
    const watchDefinition = environment.watch[0];
    const watch = watchDefinition
      ? this.store.getWatchSnapshot(watchDefinition.id, environment.id, watchDefinition.unit)
      : null;
    const profiles = this.store.listConnections().map(profileFromRecord);
    const bound = new Map(profiles.map((profile) => [profile.connectionId, profile]));
    // A connection can be scoped and credentialed and still have no reviewed release workflow
    // behind it. Say so while there is still a plan to block, not when the dispatch fails.
    const unpinned = environment.units.filter((unit) => {
      const connection = connections.find((item) => item.slot === unit.executor.connection);
      if (!connection?.ready || !connection.connectionId) return false;
      const controllers = bound.get(connection.connectionId)?.publicMetadata?.releaseControllers;
      return !(Array.isArray(controllers) ? controllers : []).some((controller) =>
        (controller as { targetId?: unknown } | null)?.targetId === unit.target.targetId);
    });
    const blockers = [
      ...(!context.committed ? [{ id: "source-uncommitted", code: "source-dirty", title: "Commit deployment inputs", message: "The managed manifest is preview-only until committed" }] : []),
      ...connections.filter((item) => !item.ready).map((item) => ({ id: `connection:${item.slot}`, code: "connection-missing", title: `${item.slot} connection`, message: item.detail })),
      ...unpinned.map((unit) => ({ id: `release-controller:${unit.id}`, code: "release-controller-unpinned", title: "Release controller not pinned", message: `The ${unit.executor.connection} connection has no reviewed release workflow for ${unit.target.targetId}. PSM pins it once it can read the release repository.` })),
    ];
    const activeFirst = firstUnit ? active.find((release) => release.unitId === firstUnit.id) ?? null : null;
    const projects = this.#projects();
    const defaults = new Map(await Promise.all(connections.map(async (connection) => [connection.slot, await discoverConnectionDefaults({
      project: context.project, projects, environment, slot: connection.slot, profiles,
      boundConnectionId: connection.connectionId,
      github: this.#githubConnectionDefaults,
    })] as const)));
    return {
      id: environment.id,
      projectId: context.project.id,
      risk: environment.risk,
      hostname,
      releasePolicy: environment.releasePolicy,
      source: { version: context.source.version, branch: context.source.branch, commit: context.source.commit, committed: context.committed, inputsDirty: context.sourceInputsDirty },
      activeRelease: activeFirst ? releaseView(activeFirst, activeFirst.releaseId) : null,
      watch: watch ? { effectiveState: watch.effectiveState, observedAt: watch.observedAt, freshness: watch.freshness } : { effectiveState: "not-monitored" },
      target: firstUnit ? { targetId: firstUnit.target.targetId, kind: firstUnit.target.kind, hostname } : null,
      dependencies,
      resources,
      blockers,
      connections: connections.map((item) => ({
        slot: item.slot, kind: item.kind, connectionId: item.connectionId,
        bindingRevision: item.bindingRevision, metadataRevision: item.metadataRevision,
        ready: item.ready, profile: item.profile, principal: item.principal, detail: item.detail,
        observedAt: hasCurrentObservation(item) ? planDocument?.createdAt ?? null : null,
        observationsExpireAt: hasCurrentObservation(item) ? planDocument?.expiresAt ?? null : null,
        diagnostics: connectionDiagnostics({
          ready: item.ready, detail: item.detail,
          resources: hasCurrentObservation(item) ? resources.filter((resource) => environment.resources.some((definition) => definition.id === resource.id && definition.connection === item.slot)) : [],
        }),
        // Public suggestions only: creating a profile still requires an explicit local action.
        setup: {
          defaults: defaults.get(item.slot),
          zones: [...new Set(environment.resources.flatMap((resource) => resource.connection === item.slot && resource.kind === "digitalocean-dns-record@1" ? [resource.desired.zone] : []))],
          targets: environment.units.filter((unit) => unit.target.observerConnection === item.slot).map((unit) => ({ id: unit.target.targetId, root: unit.target.root })),
          workflows: environment.units.filter((unit) => unit.executor.connection === item.slot).map((unit) => ({ repository: unit.executor.sourceRepository, workflow: unit.executor.prepareWorkflow, targetId: unit.target.targetId })),
          monitorIds: environment.watch.filter((watch) => watch.connection === item.slot).map((watch) => watch.monitorKey),
        },
      })),
      units: environment.units.map((unit) => ({ id: unit.id, recipe: unit.recipe, executor: unit.executor.kind, target: unit.target.targetId })),
      releases: all.map((release) => releaseView(release, active.find((item) => item.targetId === release.targetId)?.releaseId ?? null)),
      canPrepare: this.artifactPreparationAvailable && context.committed && !context.sourceInputsDirty && environment.units.length === 1 && connections.some((item) => item.slot === firstUnit?.executor.connection && item.ready),
      canPlan: true,
      latestPlan: this.storedPlanView(latestPlan),
      latestRun: runs[0] ? this.runView(runs[0].runId) : null,
    };
  }

  async overview(idOrName: string): Promise<Record<string, unknown>> {
    const context = this.loadCurrent(idOrName);
    const environments = await Promise.all(context.manifest.environments.map((environment) => this.environmentView(context.project.id, environment.id)));
    return { managed: true, project: { id: context.project.id, name: context.project.name }, environments };
  }

  /**
   * Dependency edges between a given set of projects, read from what each project
   * last recorded — never by probing. A workroom opens this on every render, and a
   * view must not be able to reach across the network on someone else's behalf.
   *
   * Only edges the manifest itself attributes to a project are returned. `projectId`
   * is required on the two typed cross-project probes and optional on the HTTP ones,
   * so an unattributed probe is simply not a cross-project edge — psm never guesses
   * an owner from a URL.
   */
  crossProjectDependencies(idsOrNames: readonly string[]): CrossProjectDependencyEdge[] {
    const known = new Map(this.#projects().filter((item) => item.id).map((item) => [item.id!, item.name]));
    const members: ManagedDeploymentProject[] = [];
    for (const idOrName of idsOrNames) {
      try { members.push(this.resolveProject(idOrName)); } catch { /* not a project psm can see */ }
    }
    const inRoom = new Set(members.map((member) => member.id));
    const edges: CrossProjectDependencyEdge[] = [];
    for (const member of members) {
      let context: LoadedContext;
      // An unmanaged member is not a failure to report: it has no edges to declare.
      try { context = this.loadCurrent(member.id); } catch { continue; }
      for (const environment of context.manifest.environments) {
        const plan = this.store.listPlans(member.id, environment.id)[0];
        const observed = new Map(
          ((plan?.document as unknown as DeploymentPlanDocument | undefined)?.observations?.dependencies ?? [])
            .map((item) => [item.id, item]),
        );
        for (const dependency of environment.dependencies) {
          const ownerProjectId = "projectId" in dependency ? dependency.projectId : undefined;
          if (!ownerProjectId || ownerProjectId === member.id) continue;
          const observation = observed.get(dependency.id);
          const state = observation?.state ?? "unknown";
          if (state === "ready") continue;
          edges.push({
            dependentProjectId: member.id,
            dependentProjectName: member.name,
            dependentEnvironmentId: environment.id,
            dependencyId: dependency.id,
            kind: dependency.kind,
            ownerProjectId,
            ownerProjectName: known.get(ownerProjectId) ?? null,
            ownerEnvironmentId: "environment" in dependency ? dependency.environment : null,
            ownerInRoom: inRoom.has(ownerProjectId),
            state,
            detail: observation?.detail ?? "Not observed yet — choose Discover changes in the owning project",
            observedAt: observation?.observedAt ?? null,
          });
        }
      }
    }
    return edges;
  }

  async bindConnection(idOrName: string, environmentId: string, slot: string, connectionId: string, expectedRevision: number | null) {
    const context = this.loadCurrent(idOrName);
    const environment = context.manifest.environments.find((item) => item.id === environmentId);
    if (!environment) throw new ManagedDeploymentError("deployment environment not found", "environment-not-found", 404);
    const declaration = environment.connections[slot];
    if (!declaration) throw new ManagedDeploymentError("manifest does not declare that connection slot", "connection-missing", 404);
    const record = this.store.getConnection(connectionId);
    const profile = profileFromRecord(record);
    const issues = this.scopeRequests(environment, slot)
      .map((scope) => ({ ...scope, projectId: context.project.id }))
      .flatMap((scope) => validateConnectionScope(profile, declaration.kind, scope).issues);
    if (issues.length) throw new ManagedDeploymentError(issues[0].message, "connection-out-of-scope", 403, issues);
    return this.store.bindConnection({
      projectId: context.project.id,
      checkoutId: context.source.checkoutId,
      environmentId,
      slot,
      connectionId,
      expectedRevision,
      at: Date.now(),
    });
  }

  artifacts(idOrName: string): DeploymentArtifact[] {
    const project = this.resolveProject(idOrName);
    return this.store.listArtifacts({ projectId: project.id });
  }

  readonly #lastReadiness = new Map<string, { readiness: DeploymentReadiness; plan: Record<string, unknown>; environment: Record<string, unknown> }>();

  /** The most recent readiness check for an environment, as it was answered; never a new check. */
  lastReadiness(idOrName: string, environmentId: string) {
    const last = this.#lastReadiness.get(`${this.resolveProject(idOrName).id}\0${environmentId}`);
    return last ? structuredClone(last) : null;
  }

  async checkReadiness(idOrName: string, environmentId: string, options: {
    artifactId?: string | null;
    preparationAvailable?: boolean;
    preparing?: boolean;
  } = {}): Promise<{ readiness: DeploymentReadiness; plan: Record<string, unknown>; environment: Record<string, unknown> }> {
    const context = this.loadCurrent(idOrName);
    const environment = context.manifest.environments.find((item) => item.id === environmentId);
    if (!environment) throw new ManagedDeploymentError("deployment environment not found", "environment-not-found", 404);
    const unit = environment.units.length === 1 ? environment.units[0] : null;
    // Automatic selection must not carry a production build (or a different
    // commit) into staging merely because it is the newest recorded artifact.
    const matching = unit ? this.artifacts(context.project.id).find((artifact) =>
      artifact.commitSha === context.source.commit
      && artifact.sourceRepository === unit.executor.sourceRepository
      && artifact.buildProfileDigest === canonicalDigest("psm-deployment-build-profile:v1", unit.artifact.buildProfile)
      && artifact.retainedUntil > Date.now() && artifact.tombstonedAt === null
    ) : null;
    const result = await this.createPlan(context.project.id, { environment: environmentId, operation: "deploy", artifactId: options.artifactId ?? matching?.artifactId ?? null });
    const document = this.store.getPlan(String(result.plan.id), Number(result.plan.revision)).document as unknown as DeploymentPlanDocument;
    let canPrepare = (options.preparationAvailable ?? this.artifactPreparationAvailable) && !!unit
      && !(document.observations.execution ?? []).some((item) => item.purpose === "prepare" && !item.ready);
    // Preparation refuses for one concrete reason at a time — uncommitted
    // inputs, an unreachable commit, an unbound build connection. Keep it: a
    // checklist that lists every possible cause is one the operator has to
    // debug, which is what the check was meant to save them from.
    let preparationDetail: string | null = null;
    if (canPrepare) {
      try { await this.artifactPreparationContext(context.project.id, environmentId, unit!.id); }
      catch (error) {
        canPrepare = false;
        preparationDetail = error instanceof ManagedDeploymentError ? error.message : null;
      }
    } else if (!unit && environment.units.length > 1) {
      preparationDetail = "This environment has several deployment units; psm prepares a build for one unit at a time.";
    }
    const activePreparation = this.store.listRuns(context.project.id, environmentId).some((run) => run.runKind === "prepare" && !runTerminal(run.state));
    const readiness = deploymentReadiness(document, {
      canPrepare,
      preparing: options.preparing || activePreparation,
      ...(preparationDetail ? { preparationDetail } : {}),
    });
    for (const item of readiness.items) {
      if (item.ownerProjectId) item.ownerProjectName = this.#projects().find((project) => project.id === item.ownerProjectId)?.name;
    }
    this.#lastReadiness.set(`${context.project.id}\0${environmentId}`, structuredClone({ ...result, readiness }));
    return { ...result, readiness };
  }

  async artifactPreparationContext(
    idOrName: string,
    environmentId: string,
    unitId?: string,
  ): Promise<ArtifactPreparationContext> {
    const project = this.resolveProject(idOrName);
    let context: LoadedContext;
    try { context = exactManifest(project, "HEAD"); } catch (error) {
      throw new ManagedDeploymentError(error instanceof Error ? error.message : String(error), "source-unavailable", 409);
    }
    if (context.sourceInputsDirty) {
      throw new ManagedDeploymentError("deployment inputs differ from committed HEAD", "source-dirty", 409);
    }
    const environment = context.manifest.environments.find((item) => item.id === environmentId);
    if (!environment) throw new ManagedDeploymentError("deployment environment not found", "environment-not-found", 404);
    const candidates = unitId ? environment.units.filter((item) => item.id === unitId) : environment.units;
    if (candidates.length !== 1) {
      throw new ManagedDeploymentError(unitId ? "deployment unit not found" : "unitId is required when an environment has several units", "deployment-invalid", 400);
    }
    const unit = candidates[0];
    const resolved = await this.resolveEnvironment(context, environmentId);
    const snapshot = resolved.connections.find((item) => item.slot === unit.executor.connection);
    if (!snapshot?.ready || !snapshot.connectionId) {
      throw new ManagedDeploymentError(snapshot?.detail ?? "artifact executor connection is not ready", "connection-missing", 409);
    }
    const connection = profileFromRecord(this.store.getConnection(snapshot.connectionId));
    if (connection.kind !== "github-actions@1") {
      throw new ManagedDeploymentError("artifact executor connection kind is invalid", "connection-missing", 409);
    }
    if (!commitReachableFrom(project.path, context.source.commit, environment.releasePolicy.allowedBranch)) {
      throw new ManagedDeploymentError(`commit is not reachable from ${environment.releasePolicy.allowedBranch}`, "source-unreachable", 409);
    }
    return { project, source: context.source, manifest: context.manifest, environment, unit, connection };
  }

  async sourcePublicationContext(projectId: string, environmentId: string, unitId?: string) {
    const context = await this.artifactPreparationContext(projectId, environmentId, unitId);
    const loaded = exactManifest(context.project, "HEAD");
    if (loaded.source.commit !== context.source.commit) throw new ManagedDeploymentError("Source changed during review", "source-changed", 409);
    const resolved = await this.resolveEnvironment(loaded, environmentId);
    const composed = composeDeploymentPolicy(resolved.environment.risk, this.policyLayers(resolved));
    if (!composed.ok) throw new ManagedDeploymentError(composed.blockers.map((blocker) => blocker.message).join("; "), "policy-blocked", 409);
    const branch = context.environment.releasePolicy.allowedBranch;
    if (composed.policy.allowedSourceRefs && !composed.policy.allowedSourceRefs.some((ref) => ref === branch || ref === `refs/heads/${branch}`)) throw new ManagedDeploymentError("Publication branch is outside the deployment policy", "policy-blocked", 403);
    return { ...context, policy: composed.policy };
  }

  runs(idOrName: string, environmentId?: string): Record<string, unknown>[] {
    const project = this.resolveProject(idOrName);
    return this.store.listRuns(project.id, environmentId).map((run) => this.runView(run.runId));
  }

  async targets(): Promise<Record<string, unknown>[]> {
    const targets: Record<string, unknown>[] = [];
    for (const candidate of this.#projects()) {
      if (!candidate.id) continue;
      let context: LoadedContext;
      try { context = this.loadCurrent(candidate.id); } catch { continue; }
      for (const environment of context.manifest.environments) {
        for (const unit of environment.units) {
          const active = this.store.getActiveRelease(unit.target.targetId);
          const watchDefinition = environment.watch.find((item) => item.unit === unit.id);
          const watch = watchDefinition ? this.store.getWatchSnapshot(watchDefinition.id, environment.id, unit.id) : null;
          const lock = this.store.getTargetLock(`target/${unit.target.targetId}`);
          targets.push({
            targetId: unit.target.targetId,
            kind: unit.target.kind,
            root: unit.target.root,
            project: { id: context.project.id, name: context.project.name },
            environment: environment.id,
            unit: unit.id,
            activeRelease: active ? releaseView(active, active.releaseId) : null,
            watch: watch ? { effectiveState: watch.effectiveState, freshness: watch.freshness, observedAt: watch.observedAt } : null,
            lock: lock ? { ownerRunId: lock.ownerRunId, leaseExpiresAt: lock.leaseExpiresAt } : null,
          });
        }
      }
    }
    return targets.sort((left, right) => String(left.targetId).localeCompare(String(right.targetId)));
  }

  /**
   * Build a plan from current inputs.
   *
   * `identity` replays an already-approved plan's ID, revision and creation
   * time so the rebuild is digest-comparable with the original. Everything else
   * — source, connections, observations, policy, releases — is read fresh,
   * which is precisely what makes a digest mismatch mean "the world moved".
   */
  private async buildPlan(
    project: ManagedDeploymentProject,
    request: {
      environment: string;
      operation?: DeploymentOperation;
      artifactId?: string | null;
      releaseId?: string | null;
      resourceId?: string | null;
    },
    identity?: { planId: string; revision: number; now: number },
  ): Promise<{ built: ReturnType<typeof buildDeploymentPlan>; context: LoadedContext; resolved: ResolvedEnvironment }> {
    const operation = request.operation ?? "deploy";
    let artifact: DeploymentArtifact | null = null;
    if (request.artifactId) {
      artifact = this.store.getArtifact(request.artifactId);
      if (artifact.projectId !== project.id) throw new ManagedDeploymentError("artifact belongs to another project", "artifact-missing", 404);
    }
    let context: LoadedContext;
    try { context = exactManifest(project, artifact?.commitSha ?? "HEAD"); } catch {
      context = previewManifest(project);
    }
    const resolved = await this.resolveEnvironment(context, request.environment);
    const layers = this.policyLayers(resolved);
    const composed = composeDeploymentPolicy(resolved.environment.risk, layers);
    const observations = await observeEnvironment(context.project.id, context.source.checkoutId, resolved.environment, this.observations, operation);
    if (this.observations.executionReadiness) {
      observations.execution = (await Promise.all(resolved.environment.units.map((unit) => this.observations.executionReadiness!(unit, {
        projectId: context.project.id,
        checkoutId: context.source.checkoutId,
        environment: resolved.environment,
        commit: context.source.commit,
      })))).flat();
    }
    for (const observation of observations.watch) {
      const definition = resolved.environment.watch.find((item) => item.id === observation.monitorId);
      if (!definition) continue;
      this.store.putWatchSnapshot({
        monitorId: definition.id,
        projectId: context.project.id,
        environmentId: resolved.environment.id,
        unitId: definition.unit,
        providerState: observation.providerState,
        freshness: observation.effectiveState === "stale" ? "stale" : "fresh",
        effectiveState: observation.effectiveState,
        observedAt: observation.observedAt,
        ingestedAt: Date.now(),
        normalizedState: json({ detail: observation.detail ?? null, evidence: observation.evidence ?? null }),
      });
    }
    const graph = expandDeploymentGraph(context.manifest, resolved.environment.id);
    const releases = this.releases(resolved.environment);
    let rollbackRelease: DeploymentRelease | null = null;
    if (request.releaseId) {
      rollbackRelease = releases.all.find((release) => release.releaseId === request.releaseId && release.tombstonedAt === null) ?? null;
    }
    const sourceReachable = !resolved.environment.releasePolicy.requireReachableFromBranch
      || commitReachableFrom(project.path, context.source.commit, resolved.environment.releasePolicy.allowedBranch);
    const built = buildDeploymentPlan({
      ...(identity ? { planId: identity.planId, revision: identity.revision, now: identity.now } : {}),
      operation,
      adoptionResourceId: request.resourceId ?? null,
      manifest: context.manifest,
      environment: resolved.environment,
      graph,
      source: context.source,
      sourceInputsDirty: context.sourceInputsDirty || !context.committed,
      sourceReachable,
      artifact,
      rollbackRelease,
      activeReleases: releases.active,
      connections: resolved.connections,
      observations,
      policy: composed.policy,
      policyBlockers: composed.blockers,
      ...(this.installedActionKinds ? { installedActionKinds: this.installedActionKinds } : {}),
    });
    return { built, context, resolved };
  }

  async createPlan(idOrName: string, request: {
    environment: string;
    operation?: DeploymentOperation;
    artifactId?: string | null;
    releaseId?: string | null;
    resourceId?: string | null;
  }): Promise<{ plan: Record<string, unknown>; environment: Record<string, unknown> }> {
    const project = this.resolveProject(idOrName);
    const { built, context, resolved } = await this.buildPlan(project, request);
    this.store.cacheManifest({
      projectId: context.project.id,
      checkoutId: context.source.checkoutId,
      environmentId: resolved.environment.id,
      commitSha: context.source.commit,
      digest: context.source.manifestDigest,
      schemaVersion: 1,
      document: json(context.manifest),
      createdAt: built.createdAt,
    });
    const stored = this.store.createPlan({
      planId: built.id,
      revision: built.revision,
      digest: built.digest,
      projectId: context.project.id,
      checkoutId: context.source.checkoutId,
      environmentId: resolved.environment.id,
      operation: request.operation ?? "deploy",
      risk: built.document.policy.risk,
      manifestDigest: context.source.manifestDigest,
      artifactId: built.document.artifact?.artifactId ?? null,
      requiredAcknowledgementIds: built.document.acknowledgements.map((item) => item.id),
      blocked: built.blocked,
      document: json(built.document),
      createdAt: built.createdAt,
      expiresAt: built.expiresAt,
      actions: built.actions.map((action) => ({
        actionId: action.id,
        actionDigest: action.digest,
        kind: action.kind,
        phase: action.phase,
        sideEffecting: action.sideEffecting,
        preconditions: action.preconditions,
        document: json(action),
      })),
    });
    return { plan: this.storedPlanView(stored)!, environment: await this.environmentView(project.id, resolved.environment.id) };
  }

  /**
   * Re-derive an approved plan from today's inputs.
   *
   * The runner calls this at every mutation gate. A rebuild that no longer
   * produces the approved digest means an input the operator reviewed has
   * changed, and the run must stop rather than quietly apply a plan nobody
   * approved. Any failure to rebuild is itself a mismatch — an unreadable
   * manifest or an unbound connection is not evidence that nothing moved.
   */
  async recheckPlan(planId: string, revision: number): Promise<{ digest: string; lockKeys: readonly string[] }> {
    const plan = this.store.getPlan(planId, revision);
    const document = plan.document as unknown as DeploymentPlanDocument;
    const project = this.resolveProject(plan.projectId);
    const { built } = await this.buildPlan(
      project,
      {
        environment: plan.environmentId,
        operation: plan.operation,
        artifactId: plan.artifactId,
        releaseId: document.rollbackRelease?.releaseId ?? null,
        resourceId: document.adoptionResourceId,
      },
      { planId: plan.planId, revision: plan.revision, now: document.createdAt },
    );
    return { digest: built.digest, lockKeys: built.document.lockKeys };
  }
}
