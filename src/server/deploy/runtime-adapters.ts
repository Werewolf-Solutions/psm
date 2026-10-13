import { createHmac, randomBytes } from "node:crypto";
import net from "node:net";

import { canonicalDigest } from "./canonical.ts";
import { serviceSecretOwner, serviceSecretSlot } from "./secrets.ts";
import {
  SecretBroker,
  validateConnectionProfile,
  type ConnectionProfile,
} from "./connections.ts";
import { BetterStackClient } from "./adapters/better-stack.ts";
import { observeWerewolfWatch } from "./adapters/werewolf-watch.ts";
import { SshMachineTransport } from "../machines/ssh.ts";
import { DigitalOceanClient, DigitalOceanError, dnsMatches, type DigitalOceanDnsRecord } from "./adapters/digitalocean.ts";
import { GitHubActionsAdapter, GitHubExecutorError, type GitHubActionsConnectionMetadata, type GitHubDispatchReceipt } from "./adapters/github.ts";
import { deploymentGitHubToken, githubAppIdentity, githubAppPages, githubAppTokens } from "./github-app.ts";
import {
  ExecutorContractError,
  RELEASE_EXECUTION_CONTRACT_SCHEMA,
  SERVICE_PAYLOAD_ALGORITHM,
  STATIC_PAYLOAD_ALGORITHM,
  releaseDispatchInputs,
  releaseExecutionContractDigest,
  type PreparedArtifactIdentity,
  type ReleaseControllerDispatch,
  type StaticPayloadLimits,
  type StaticReleaseExecutionContract,
} from "./adapters/executor-contract.ts";
import {
  HostHelperError,
  SshHostHelperTransport,
  hostHelperRequest,
  type HostHelperResponse,
  type HostHelperTransport,
} from "./adapters/host-helper.ts";
import type { ExecutionReadinessCheck, ObservationAdapters, ResourceDiscoveryResult, WatchObservation } from "./observations.ts";
import type { DeploymentPlanDocument, PlannedActionDocument } from "./planner.ts";
import type { AdapterObservation, DeploymentActionAdapter, DeploymentAdapterContext } from "./runner.ts";
import {
  DeploymentStore,
  type DeploymentConnection,
  type DeploymentArtifact,
  type DeploymentResourceBinding,
  type DeploymentRunStep,
  type JsonValue,
} from "./store.ts";
import type {
  DigitalOceanDnsResource,
  ServiceSecretsResource,
  EnvironmentManifest,
  ExternalHttpWatch,
  ResourceManifest,
  UnitManifest,
} from "./types.ts";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function newlyCreatedDnsStillPending(
  result: ResourceDiscoveryResult,
  binding: DeploymentResourceBinding | null,
  step: DeploymentRunStep | null,
  now: number,
): boolean {
  return result.state === "conflict" && result.detail === "The owned DNS record no longer exists"
    && step?.submittedAt != null && binding != null && binding.boundAt >= step.submittedAt
    && now - step.submittedAt >= 0 && now - step.submittedAt < 30_000;
}

export function deploymentConnectionProfile(connection: DeploymentConnection): ConnectionProfile {
  const metadata = object(connection.metadata);
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
    constraints: object(connection.constraints) as unknown as ConnectionProfile["constraints"],
  };
}

class RuntimeConnections {
  constructor(readonly store: DeploymentStore, readonly broker: SecretBroker) {}

  profile(input: {
    checkoutId: string;
    environmentId: string;
    slot: string;
    kind: string;
    plan?: DeploymentPlanDocument;
  }): ConnectionProfile {
    const binding = this.store.getConnectionBinding(input.checkoutId, input.environmentId, input.slot);
    const record = this.store.getConnection(binding.connectionId);
    const profile = deploymentConnectionProfile(record);
    const validation = validateConnectionProfile(profile);
    if (!validation.ok) throw new Error(validation.issues[0].message);
    if (record.kind !== input.kind || record.readiness !== "ready") {
      throw new Error(`connection ${record.connectionId} is not a ready ${input.kind} profile`);
    }
    if (input.plan) {
      const snapshot = input.plan.connections.find((item) => item.slot === input.slot);
      if (
        !snapshot
        || snapshot.connectionId !== record.connectionId
        || snapshot.metadataRevision !== record.metadataRevision
        || snapshot.bindingRevision !== binding.bindingRevision
        || snapshot.secretGeneration !== record.secretGeneration
      ) {
        throw new Error(`connection ${input.slot} changed after plan approval`);
      }
    }
    return profile;
  }

  async withToken<T>(profile: ConnectionProfile, operation: (token: string) => Promise<T>): Promise<T> {
    if (!profile.requiredSecretSlots.includes("apiToken")) {
      throw new Error(`connection ${profile.connectionId} does not declare apiToken`);
    }
    return this.broker.withLease(
      profile.connectionId,
      ["apiToken"],
      (lease) => lease.useUtf8("apiToken", operation),
      60_000,
    );
  }
}

function environment(document: DeploymentPlanDocument): EnvironmentManifest {
  const result = document.manifest.environments.find((item) => item.id === document.environmentId);
  if (!result) throw new Error("plan environment is missing from its manifest");
  return result;
}

function actionDocument(context: DeploymentAdapterContext): PlannedActionDocument {
  return context.action.document as unknown as PlannedActionDocument;
}

function planDocument(context: DeploymentAdapterContext): DeploymentPlanDocument {
  return context.plan.document as unknown as DeploymentPlanDocument;
}

function ownerId(ownerRef: string, kind: "resource" | "unit" | "watch"): string {
  const match = new RegExp(`^${kind}:([^/#]+)`).exec(ownerRef);
  if (!match) throw new Error(`action owner is not a ${kind}`);
  return match[1];
}

function resourceForAction(context: DeploymentAdapterContext): ResourceManifest {
  const document = planDocument(context);
  const id = ownerId(actionDocument(context).ownerRef, "resource");
  const resource = environment(document).resources.find((item) => item.id === id);
  if (!resource) throw new Error(`resource ${id} is absent from the plan manifest`);
  return resource;
}

function unitForAction(context: DeploymentAdapterContext): UnitManifest {
  const document = planDocument(context);
  const id = ownerId(actionDocument(context).ownerRef, "unit");
  const unit = environment(document).units.find((item) => item.id === id);
  if (!unit) throw new Error(`unit ${id} is absent from the plan manifest`);
  return unit;
}

function targetForResource(resource: ResourceManifest, environmentValue: EnvironmentManifest): UnitManifest {
  const units = environmentValue.units.filter((unit) => unit.resourceRefs.includes(`resource:${resource.id}`));
  const targetIds = [...new Set(units.map((unit) => unit.target.targetId))];
  if (units.length === 0 || targetIds.length !== 1) {
    throw new Error(`resource ${resource.id} does not resolve to one enrolled target`);
  }
  return units[0];
}

export function helperData(response: HostHelperResponse): Record<string, unknown> {
  if (response.outcome === "failed") throw new HostHelperError(response.detail, response.code);
  const data = object(response.data);
  if (!Object.keys(data).length) throw new Error("host helper returned no observation data");
  return data;
}

export { serviceSecretOwner, serviceSecretSlot } from "./secrets.ts";

export type ServiceSecretState = "in-sync" | "differs" | "missing-on-host" | "missing-in-psm";

/**
 * Compare PSM's values with the host's keyed fingerprints for one fresh salt.
 * Only the verdict per name is returned: neither fingerprints nor salt are
 * kept, so a weak secret cannot be guessed offline from a stored plan or log.
 */
export function compareServiceSecrets(
  names: readonly string[],
  local: ReadonlyMap<string, string>,
  hostFingerprints: Record<string, unknown>,
  salt: Buffer,
): Record<string, ServiceSecretState> {
  const states: Record<string, ServiceSecretState> = {};
  for (const name of names) {
    const value = local.get(name);
    const host = hostFingerprints[name];
    if (value === undefined) states[name] = "missing-in-psm";
    else if (typeof host !== "string") states[name] = "missing-on-host";
    else states[name] = host === `hmac-sha256:${createHmac("sha256", salt).update(value).digest("hex")}` ? "in-sync" : "differs";
  }
  return states;
}

export function serviceSecretsSummary(states: Record<string, ServiceSecretState>, undeclared: readonly string[] = []): ResourceDiscoveryResult {
  const names = Object.keys(states).sort();
  const missingLocal = names.filter((name) => states[name] === "missing-in-psm");
  if (missingLocal.length) {
    return { state: "blocked", detail: `Set ${missingLocal.join(", ")} in PSM before deploying; the values are never committed.`, observed: { states, undeclared: [...undeclared] } };
  }
  const changed = names.filter((name) => states[name] !== "in-sync");
  if (!changed.length && !undeclared.length) return { state: "in-sync", detail: "Every declared secret on the host matches PSM's value.", observed: { states, undeclared: [...undeclared] } };
  const missing = names.filter((name) => states[name] === "missing-on-host");
  return {
    state: missing.length === names.length ? "create" : "update",
    detail: [
      changed.length ? `${changed.join(", ")} will be written to the host and the service restarted.` : "",
      undeclared.length ? `${undeclared.join(", ")} on the host ${undeclared.length === 1 ? "is" : "are"} no longer declared and will be removed.` : "",
    ].filter(Boolean).join(" "),
    observed: { states, undeclared: [...undeclared] },
  };
}

function helperDesired(resource: Exclude<ResourceManifest, DigitalOceanDnsResource>, tls?: boolean): JsonValue {
  return json({ kind: resource.kind, ...resource.desired, ...(tls === undefined ? {} : { tls }) });
}

// A noop http-ready was planned from the full TLS observation, and the TLS
// config keeps the :80 ACME location, so it re-checks that same rendering
// instead of demanding the HTTP-only bootstrap file.
/**
 * Where a release stands on the target. It is staged into incoming/ and renamed
 * into releases/<id> only with its receipt, and served only while `current`
 * points at it. `unreadable` means the observation cannot say.
 */
export function releaseStateOnTarget(observed: Record<string, unknown>, releaseId: string): { state: "absent" | "staged" | "active" | "unreadable"; active: string | null } {
  if ((observed.layout !== "ready" && observed.layout !== "missing") || !Array.isArray(observed.releases)) return { state: "unreadable", active: null };
  const active = observed.active === null ? null : object(observed.active).releaseId;
  if (observed.active !== null && typeof active !== "string") return { state: "unreadable", active: null };
  const current = (active as string | null) ?? null;
  if (current === releaseId) return { state: "active", active: current };
  const staged = observed.releases.some((receipt) => object(receipt).releaseId === releaseId);
  return { state: staged ? "staged" : "absent", active: current };
}

/** Only this exact, freshly observed target state can close a receiptless release as failed. */
export function missingReceiptReleaseAbsent(observed: Record<string, unknown>, dispatch: ReleaseControllerDispatch): boolean {
  const found = releaseStateOnTarget(observed, dispatch.releaseId);
  return observed.targetId === dispatch.targetId
    && observed.targetDigest === dispatch.executionContract.target.fingerprint
    && found.state === "absent"
    && found.active === (dispatch.executionContract.expectedCurrentRelease?.releaseId ?? null);
}

/**
 * The target's active receipt, only when it is exactly the release this dispatch
 * approved: same release, artifact, commit, version, both digests and target
 * contract. Anything else is
 * not ours to record.
 */
export function approvedReleaseActiveOnTarget(observed: Record<string, unknown>, dispatch: ReleaseControllerDispatch): Record<string, unknown> | null {
  if (observed.layout !== "ready" || observed.targetId !== dispatch.targetId
    || observed.targetDigest !== dispatch.executionContract.target.fingerprint
    || observed.active === null || typeof observed.active !== "object") return null;
  const active = object(observed.active);
  return active.schema === "psm.werewolf.solutions/target-release/v1"
    && active.targetId === dispatch.targetId
    && active.payloadAlgorithm === dispatch.artifact.payloadAlgorithm
    && active.releaseId === dispatch.releaseId
    && active.artifactId === dispatch.artifact.psmArtifactId
    && active.payloadDigest === dispatch.artifact.payloadDigest
    && active.archiveDigest === dispatch.artifact.archiveDigest
    && active.commitSha === dispatch.artifact.commitSha
    && active.version === dispatch.artifact.version
    && active.targetDigest === dispatch.executionContract.target.fingerprint
    ? active : null;
}

/** A local contract error is raised before GitHub receives a dispatch request. */
export function preDispatchContractFailure(events: readonly { type: string; data: JsonValue }[], actionId: string): boolean {
  return events.some((event) => event.type === "submission-response-lost"
    && object(event.data).actionId === actionId
    && object(event.data).errorType === "ExecutorContractError");
}

export function rollbackAuthorization(rollback: boolean, automaticRollback: boolean, activeReleaseId: string | null, intendedReleaseId: string): { allowed: boolean; previousReleaseId: string | null } {
  const allowed = !rollback && automaticRollback && activeReleaseId !== null && activeReleaseId !== intendedReleaseId;
  return { allowed, previousReleaseId: allowed ? activeReleaseId : null };
}

export function ingressObservationTls(kind: string, operation: PlannedActionDocument["operation"]): false | undefined {
  return kind === "reconcile-ingress-http@1" && operation !== "noop" ? false : undefined;
}

/** Deployment receipts need the current Watch verdict, not seven days of chart data. */
export function deploymentWatchReceipt(observed: WatchObservation): JsonValue {
  const evidence = observed.evidence ?? {};
  const boundedText = (key: string) => typeof evidence[key] === "string" ? (evidence[key] as string).slice(0, 200) : null;
  const boundedNumber = (key: string) => typeof evidence[key] === "number" && Number.isFinite(evidence[key]) ? evidence[key] : null;
  return {
    monitorId: observed.monitorId,
    providerState: observed.providerState,
    effectiveState: observed.effectiveState,
    observedAt: observed.observedAt,
    detail: observed.detail?.slice(0, 300) ?? null,
    evidence: {
      provider: boundedText("provider"),
      providerMonitorId: boundedText("providerMonitorId"),
      observer: boundedText("observer"),
      failureDomain: boundedText("failureDomain"),
      status: boundedNumber("status"),
      durationMs: boundedNumber("durationMs"),
      tlsExpiresAt: boundedNumber("tlsExpiresAt"),
    },
  };
}

function stateResult(data: Record<string, unknown>, detail: string): ResourceDiscoveryResult {
  const allowed = new Set(["in-sync", "create", "update", "adopt", "conflict", "blocked", "unknown"]);
  const state = typeof data.state === "string" && allowed.has(data.state) ? data.state : "unknown";
  return { state: state as ResourceDiscoveryResult["state"], detail, observed: data };
}

function addressFrom(profile: ConnectionProfile): string {
  const address = profile.publicMetadata?.address;
  if (typeof address !== "string" || net.isIP(address) !== 4) {
    throw new Error(`connection ${profile.connectionId} has no public IPv4 address metadata`);
  }
  return address;
}

interface DnsContext {
  resource: DigitalOceanDnsResource;
  profile: ConnectionProfile;
  address: string;
}

export class DeploymentRuntimeAdapters {
  readonly observations: ObservationAdapters;
  readonly #connections: RuntimeConnections;
  readonly #host: HostHelperTransport;

  constructor(options: { store: DeploymentStore; broker: SecretBroker; hostTransport?: HostHelperTransport }) {
    this.#connections = new RuntimeConnections(options.store, options.broker);
    this.#host = options.hostTransport ?? new SshHostHelperTransport({ broker: options.broker });
    this.observations = {
      discoverResource: (resource, context) => this.discoverResource(resource, context),
      watch: (definition, context) => this.observeWatch(definition, context),
      executionReadiness: (unit, context) => this.controllerReadiness(unit, context),
    };
  }

  /**
   * Before a release, check what the pinned GitHub release controller will
   * rely on but PSM does not own: its target file must describe the target as
   * enrolled, and its Environment must hold the key and host key. Values of
   * secrets are never read — only their names.
   */
  async controllerReadiness(unit: UnitManifest, context: { checkoutId: string; environment: EnvironmentManifest }): Promise<ExecutionReadinessCheck[]> {
    if (unit.executor.kind !== "github-actions@1" || !unit.executor.releaseController || unit.target.kind !== "ssh-release-directory@1") return [];
    const targetId = unit.target.targetId;
    let github: ConnectionProfile;
    let host: ConnectionProfile;
    try {
      github = this.#connections.profile({ checkoutId: context.checkoutId, environmentId: context.environment.id, slot: unit.executor.connection, kind: "github-actions@1" });
      host = this.#connections.profile({ checkoutId: context.checkoutId, environmentId: context.environment.id, slot: unit.target.observerConnection, kind: "ssh-host-helper@1" });
    } catch {
      return []; // Unbound or unready connections are reported as their own blockers.
    }
    const controllers = (github.publicMetadata as { releaseControllers?: unknown })?.releaseControllers;
    // The connection's own allowlist refuses every dispatch it does not name, so an
    // unnamed tuple must block the plan here rather than fail the release later.
    const releaseController = unit.executor.releaseController;
    if (!Array.isArray(controllers) || !controllers.some((entry) => object(entry).targetId === targetId && object(entry).controller === releaseController)) {
      return [{
        id: `${unit.id}:controller-pin`, purpose: "deploy", title: "Release controller pin", ready: false,
        detail: `The ${unit.executor.connection} connection (${github.name}) pins no ${releaseController} release controller for ${targetId}, so it would refuse this release before dispatch. Bind a connection that pins one, or review controller setup for this connection.`,
      }];
    }
    const adapter = this.#github(github);
    const appManaged = Boolean(githubAppIdentity(github)) || controllers.some((entry) => object(entry).targetId === targetId && object(entry).sourceAuthorization === "installation-token");
    const reviewSetup = "Press “Review controller setup / update” in the GitHub connection, then “Apply reviewed controller setup”. PSM verifies the bundle, prepares the target file and environment, and installs its release credentials.";
    const checks: ExecutionReadinessCheck[] = [];
    // Fixes PSM cannot make itself name the exact GitHub page where they are made.
    const pinned = controllers.map(object).find((entry) => entry.targetId === targetId && entry.controller === releaseController) ?? {};
    const controllerUrl = `https://github.com/${String(pinned.repository)}`;
    const controllerBranch = String(pinned.ref ?? "").replace(/^refs\/heads\//, "");
    const targetFile = `targets/${targetId.replace(/[:/]/g, "__")}.json`;
    try {
      const head = await adapter.controllerHead(targetId);
      const moved = head.headSha !== head.pinnedHeadSha;
      checks.push({
        id: `${unit.id}:controller-pin`, purpose: "deploy", title: "Release controller pin",
        ready: !moved,
        // The full new commit stays in the text: the Pin button sends back exactly what was shown.
        detail: !moved ? `Pinned to ${head.pinnedHeadSha.slice(0, 12)}, the current ${head.ref} of ${head.repository}.`
          : `${head.repository} ${head.ref} moved from ${head.pinnedHeadSha.slice(0, 12)} to ${head.headSha}. Releases stay refused until you review the change (https://github.com/${head.repository}/compare/${head.pinnedHeadSha}...${head.headSha}) and ${appManaged ? reviewSetup : "pin the new commit."}`,
      });
    } catch (error) {
      checks.push({ id: `${unit.id}:controller-pin`, purpose: "deploy", title: "Release controller pin", ready: false, detail: `Could not read the release controller's current commit: ${error instanceof Error ? error.message : String(error)}` });
    }
    const ssh = host.constraints.ssh;
    const contract = object(object(host.publicMetadata?.targetContracts)[targetId]);
    try {
      const observed = helperData(await this.#host.invoke({ connection: host, request: hostHelperRequest({ targetId, operation: "observe-target", desired: {} }) }));
      const live = typeof observed.targetDigest === "string" ? observed.targetDigest : "";
      const pinned = typeof contract.fingerprint === "string" ? contract.fingerprint : "";
      checks.push({
        id: `${unit.id}:target-contract`, purpose: "deploy", title: "Target contract",
        ready: Boolean(live) && live === pinned,
        // The full live digest stays in the text: the Pin button sends back exactly what was shown.
        detail: live === pinned ? `The server's target contract matches the pinned ${pinned.slice(0, 19)}….`
          : `The server's target contract changed from ${pinned.slice(0, 19)}… to ${live}. Releases would be refused at verification. Pin it only if you made or approved that change on the server.`,
      });
    } catch (error) {
      checks.push({ id: `${unit.id}:target-contract`, purpose: "deploy", title: "Target contract", ready: false, detail: `Could not read the server's target contract: ${error instanceof Error ? error.message : String(error)}` });
    }
    // Where the GitHub plan has no branch protection, the reviewed set of people who can
    // push stands in for it: anyone new could change the workflow that holds the release key.
    if (pinned.branchProtection === "unavailable-on-plan") {
      const reviewed = Array.isArray(pinned.reviewedWriters) ? pinned.reviewedWriters.map(String) : [];
      try {
        const writers = await adapter.listControllerWriters(targetId);
        const added = writers.filter((login) => !reviewed.includes(login));
        const pages = githubAppPages(github);
        // A repository always has someone who can push: an empty list means the App cannot see them.
        const blind = !writers.length || !reviewed.length;
        checks.push({
          id: `${unit.id}:controller-writers`, purpose: "deploy", title: "Who can change the release controller",
          ready: added.length === 0 && !blind,
          detail: blind
            ? `The GitHub App cannot see who can push to ${String(pinned.repository)}, so PSM cannot guard it. Grant the App Organization permissions → Members: Read at ${pages.permissions}, accept it at ${pages.installation}, then review controller setup again to record who can push.`
            : added.length === 0
            ? `${String(pinned.repository)} has no branch protection on its GitHub plan; releases run only at the pinned commit, and only ${reviewed.join(", ") || "nobody"} can push to it.`
            : `${added.join(", ")} can now push to ${String(pinned.repository)}, which has no branch protection on its GitHub plan, so they could change the workflow that holds the release key. Remove their access at ${controllerUrl}/settings/access, or review controller setup again to accept them.`,
        });
      } catch (error) {
        checks.push({ id: `${unit.id}:controller-writers`, purpose: "deploy", title: "Who can change the release controller", ready: false, detail: `Could not list who can push to ${String(pinned.repository)}: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    // The key the controller uses: a CI release key PSM enrolled for this target on this host.
    const ci = this.#connections.store.listConnections().map(deploymentConnectionProfile).find((profile) =>
      profile.kind === "ssh-host-helper@1" && object(profile.publicMetadata).role === "ci"
      && profile.constraints.allowedTargetIds?.includes(targetId) && profile.constraints.ssh?.host === ssh?.host);
    try {
      const file = object(await adapter.readControllerJson(targetId, `targets/${targetId.replace(/[:/]/g, "__")}.json`));
      const expected: Record<string, unknown> = {
        sshHost: ssh?.host, sshPort: ssh?.port ?? 22, hostKeyFingerprint: ssh?.hostKeyFingerprint, canonicalRoot: unit.target.root,
        contractRevision: contract.revision, ...(ci ? { sshUser: ci.constraints.ssh?.user } : {}),
      };
      const wrong = Object.entries(expected).filter(([key, value]) => value !== undefined && (file[key] ?? (key === "sshPort" ? 22 : undefined)) !== value);
      checks.push({
        id: `${unit.id}:controller-target`, purpose: "deploy", title: "Release controller target file",
        ready: Object.keys(file).length > 0 && wrong.length === 0,
        // GitHub answers 404 both for a missing file and for a private repository the token cannot see.
        detail: appManaged && (!Object.keys(file).length || wrong.length) ? `${!Object.keys(file).length ? "The target file is unavailable at the pinned controller commit." : "The pinned target file does not match the enrolled target."} ${reviewSetup}`
          : !Object.keys(file).length ? `PSM's GitHub token cannot read ${targetFile} at the pinned controller commit: the file is missing there, or the token has no access to ${String(pinned.repository)}. Create it at ${controllerUrl}/new/${controllerBranch}/targets?filename=${targetFile.slice("targets/".length)}, then pin the new commit.`
          : wrong.length ? `Update the controller's target file, then pin the new commit: ${wrong.map(([key, value]) => `${key} must be ${JSON.stringify(value)} (is ${JSON.stringify(file[key] ?? null)})`).join("; ")}. Edit it at ${controllerUrl}/edit/${controllerBranch}/${targetFile}`
          : "Matches the enrolled target.",
      });
    } catch (error) {
      checks.push({ id: `${unit.id}:controller-target`, purpose: "deploy", title: "Release controller target file", ready: false, detail: `Could not read the controller's target file: ${error instanceof Error ? error.message : String(error)}` });
    }
    try {
      const names = await adapter.listEnvironmentSecretNames(targetId);
      const missing = ["PSM_TARGET_KNOWN_HOSTS", "PSM_TARGET_SSH_PRIVATE_KEY"].filter((name) => !names?.includes(name));
      checks.push({
        id: `${unit.id}:controller-credentials`, purpose: "deploy", title: "Release controller credentials",
        ready: missing.length === 0,
        detail: missing.length === 0 ? "The controller's GitHub Environment holds the release key and host key."
          : appManaged ? `The target’s release environment or its required credentials are not available. ${reviewSetup}`
          : names === null ? `PSM's GitHub token cannot see the controller's GitHub Environment: it does not exist yet, or the token has no access to the controller repository. ${ci ? "Publishing the CI release key creates it." : "Add a CI release key in Machines, then publish it from this page."}`
          : ci ? `The controller's GitHub Environment is missing ${missing.join(" and ")}. Publish the CI release key from this page.`
          : `The controller's GitHub Environment is missing ${missing.join(" and ")}. First add a CI release key in Machines, then publish it from this page.`,
      });
    } catch (error) {
      checks.push({ id: `${unit.id}:controller-credentials`, purpose: "deploy", title: "Release controller credentials", ready: false, detail: `Could not list the controller's GitHub Environment secrets: ${error instanceof Error ? error.message : String(error)}` });
    }
    try {
      const controller = controllers.map(object).find((entry) => entry.targetId === targetId);
      if (controller?.sourceAuthorization === "installation-token") {
        if (!githubAppIdentity(github)) throw new Error("Connect the GitHub App to supply short-lived source access");
        await githubAppTokens(this.#connections.broker).token(github, unit.executor.sourceRepository, { actions: "read" });
        checks.push({ id: `${unit.id}:controller-artifact-reader`, purpose: "deploy", title: "Source artifact access", ready: true,
          detail: "The GitHub App can read the source artifact. PSM will publish a fresh source-only token before dispatch." });
      } else {
      const [secrets, variables] = await Promise.all([adapter.listEnvironmentSecretNames(targetId), adapter.listEnvironmentVariableNames(targetId)]);
      const missing = [
        ...(variables?.includes("PSM_ARTIFACT_READER_APP_ID") ? [] : ["variable PSM_ARTIFACT_READER_APP_ID"]),
        ...(secrets?.includes("PSM_ARTIFACT_READER_PRIVATE_KEY") ? [] : ["secret PSM_ARTIFACT_READER_PRIVATE_KEY"]),
      ];
      checks.push({
        id: `${unit.id}:controller-artifact-reader`, purpose: "deploy", title: "Release controller artifact reader",
        ready: missing.length === 0,
        detail: missing.length === 0 ? "The controller's GitHub Environment holds the artifact-reader GitHub App credentials."
          : `The controller's GitHub Environment is missing ${missing.join(" and ")}, so its release job cannot download the prepared artifact. Install the artifact-reader GitHub App on the source repository and add both to the ${String(pinned.githubEnvironment)} environment at ${controllerUrl}/settings/environments (docs/deploy/TODO-STAGING-SETUP.md, steps 4–5).`,
      });
      }
    } catch (error) {
      checks.push({ id: `${unit.id}:controller-artifact-reader`, purpose: "deploy", title: "Release controller artifact reader", ready: false, detail: `Could not list the controller's GitHub Environment: ${error instanceof Error ? error.message : String(error)}` });
    }
    return checks;
  }

  /**
   * Pin the target contract the helper attests now, only if it is the digest the
   * operator reviewed. Every host connection that pinned the old digest for this
   * target moves with it, so plans made against the old one go stale.
   */
  async pinTargetContract(unit: UnitManifest, context: { checkoutId: string; environment: EnvironmentManifest }, reviewedDigest: string): Promise<{ targetId: string; fingerprint: string; connections: string[] }> {
    if (unit.target.kind !== "ssh-release-directory@1") throw new Error("this unit has no host target");
    const targetId = unit.target.targetId;
    const host = this.#connections.profile({ checkoutId: context.checkoutId, environmentId: context.environment.id, slot: unit.target.observerConnection, kind: "ssh-host-helper@1" });
    const observed = helperData(await this.#host.invoke({ connection: host, request: hostHelperRequest({ targetId, operation: "observe-target", desired: {} }) }));
    if (observed.targetDigest !== reviewedDigest) throw new Error(`The server now attests ${String(observed.targetDigest).slice(0, 19)}…, not the reviewed ${reviewedDigest.slice(0, 19)}…. Check readiness again.`);
    const previous = String(object(object(host.publicMetadata?.targetContracts)[targetId]).fingerprint ?? "");
    const moved: string[] = [];
    for (const record of this.#connections.store.listConnections().filter((item) => item.kind === "ssh-host-helper@1")) {
      const metadata = object(record.metadata);
      const publicMetadata = object(metadata.publicMetadata);
      const contracts = object(publicMetadata.targetContracts);
      const entry = object(contracts[targetId]);
      if (entry.fingerprint !== previous) continue;
      this.#connections.store.updateConnection({
        connectionId: record.connectionId, expectedMetadataRevision: record.metadataRevision, label: record.label, readiness: record.readiness,
        metadata: json({ ...metadata, publicMetadata: { ...publicMetadata, targetContracts: { ...contracts, [targetId]: { ...entry, fingerprint: reviewedDigest } } } }),
        constraints: record.constraints, secretGeneration: record.secretGeneration, updatedAt: Date.now(),
      });
      moved.push(record.connectionId);
    }
    return { targetId, fingerprint: reviewedDigest, connections: moved };
  }

  /**
   * Move a target's controller pin to the commit its ref points at now, only if
   * that is the commit the operator reviewed. Saving bumps the connection's
   * metadata revision, so plans made against the old pin go stale.
   */
  async pinControllerHead(unit: UnitManifest, context: { checkoutId: string; environment: EnvironmentManifest }, reviewedHeadSha: string): Promise<{ repository: string; ref: string; headSha: string; workflowBlobSha: string }> {
    if (unit.executor.kind !== "github-actions@1" || unit.target.kind !== "ssh-release-directory@1") throw new Error("this unit has no GitHub release controller");
    const github = this.#connections.profile({ checkoutId: context.checkoutId, environmentId: context.environment.id, slot: unit.executor.connection, kind: "github-actions@1" });
    const managed = (github.publicMetadata?.releaseControllers as GitHubActionsConnectionMetadata["releaseControllers"] | undefined)
      ?.find((entry) => entry.targetId === unit.target.targetId);
    if (managed?.sourceAuthorization === "installation-token") throw new Error("Use Review controller setup to verify the complete App-managed bundle before moving its pin");
    const head = await this.#github(github).controllerHead(unit.target.targetId);
    if (head.headSha !== reviewedHeadSha) throw new Error(`${head.repository} ${head.ref} is now at ${head.headSha.slice(0, 12)}, not the reviewed ${reviewedHeadSha.slice(0, 12)}. Check readiness again.`);
    const record = this.#connections.store.getConnection(github.connectionId);
    const metadata = object(record.metadata);
    const publicMetadata = object(metadata.publicMetadata);
    const controllers = Array.isArray(publicMetadata.releaseControllers) ? publicMetadata.releaseControllers.map(object) : [];
    const updated = controllers.map((controller) => controller.repository === head.repository && controller.ref === head.ref && controller.expectedHeadSha === head.pinnedHeadSha
      ? { ...controller, expectedHeadSha: head.headSha, expectedWorkflowBlobSha: head.workflowBlobSha }
      : controller);
    this.#connections.store.updateConnection({
      connectionId: record.connectionId,
      expectedMetadataRevision: record.metadataRevision,
      label: record.label,
      readiness: record.readiness,
      metadata: json({ ...metadata, publicMetadata: { ...publicMetadata, releaseControllers: updated } }),
      constraints: record.constraints,
      secretGeneration: record.secretGeneration,
      updatedAt: Date.now(),
    });
    return { repository: head.repository, ref: head.ref, headSha: head.headSha, workflowBlobSha: head.workflowBlobSha };
  }

  /**
   * Publish the CI release key and the pinned host key into the pinned
   * controller's GitHub Environment, so its release job can reach the helper.
   */
  async publishControllerCredentials(unit: UnitManifest, context: { checkoutId: string; environment: EnvironmentManifest; projectId: string }): Promise<{ repository: string; environment: string; names: string[]; keyFingerprint: string }> {
    if (unit.executor.kind !== "github-actions@1" || unit.target.kind !== "ssh-release-directory@1") throw new Error("this unit has no GitHub release controller");
    const targetId = unit.target.targetId;
    const github = this.#connections.profile({ checkoutId: context.checkoutId, environmentId: context.environment.id, slot: unit.executor.connection, kind: "github-actions@1" });
    const host = this.#connections.profile({ checkoutId: context.checkoutId, environmentId: context.environment.id, slot: unit.target.observerConnection, kind: "ssh-host-helper@1" });
    const ci = this.#connections.store.listConnections().filter((record) => record.readiness === "ready").map(deploymentConnectionProfile).find((profile) =>
      profile.kind === "ssh-host-helper@1" && object(profile.publicMetadata).role === "ci" && profile.constraints.allowedTargetIds?.includes(targetId)
      && profile.constraints.allowedProjectIds?.includes(context.projectId) && profile.constraints.ssh?.host === host.constraints.ssh?.host
      && profile.constraints.ssh?.hostKeyFingerprint === host.constraints.ssh?.hostKeyFingerprint);
    if (!ci) throw new Error("No ready CI release key for this target. Add one in Machines first.");
    const knownHost = ci.publicMetadata?.knownHost;
    if (typeof knownHost !== "string" || !knownHost) throw new Error("The CI release key has no pinned host key.");
    const privateKey = await this.#connections.broker.withLease(ci.connectionId, ["privateKey"], (lease) => lease.useUtf8("privateKey", (value) => value), 60_000);
    const result = await this.#github(github).publishEnvironmentSecrets(targetId, { PSM_TARGET_SSH_PRIVATE_KEY: privateKey, PSM_TARGET_KNOWN_HOSTS: `${knownHost}\n` });
    return { ...result, keyFingerprint: String(ci.credentialIdentity?.value ?? "") };
  }

  #profileForAction(context: DeploymentAdapterContext, kind: string): ConnectionProfile {
    const document = planDocument(context);
    const slot = actionDocument(context).connection;
    if (!slot) throw new Error(`action ${context.action.actionId} has no connection slot`);
    return this.#connections.profile({
      checkoutId: document.checkoutId,
      environmentId: document.environmentId,
      slot,
      kind,
      plan: document,
    });
  }

  #profileForEnvironment(input: { checkoutId: string; environment: EnvironmentManifest; slot: string; kind: string }): ConnectionProfile {
    if (!input.checkoutId) throw new Error("deployment checkout identity is unavailable");
    return this.#connections.profile({
      checkoutId: input.checkoutId,
      environmentId: input.environment.id,
      slot: input.slot,
      kind: input.kind,
    });
  }

  #github(profile: ConnectionProfile): GitHubActionsAdapter {
    return new GitHubActionsAdapter({
      metadata: profile.publicMetadata as unknown as GitHubActionsConnectionMetadata,
      token: (request) => deploymentGitHubToken(this.#connections.broker, profile, request),
    });
  }

  #pm2Digest(context: DeploymentAdapterContext, unit: UnitManifest): string {
    const rollback = planDocument(context).operation === "rollback";
    const beforeId = rollback ? `unit:${unit.id}#pm2-before-rollback` : `unit:${unit.id}#pm2-before`;
    const event = this.#connections.store.listEvents(context.run.runId, 0, 500).find((item) =>
      item.type === "action-checked" && object(item.data).actionId === beforeId
    );
    const result = object(object(object(event?.data).result).data);
    if (typeof result.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(result.digest)) {
      throw new Error("durable PM2 baseline is unavailable");
    }
    return result.digest;
  }

  #artifactIdentity(artifact: DeploymentArtifact, unit: UnitManifest): PreparedArtifactIdentity {
    const limits = object(artifact.providerLocator).payloadLimits as StaticPayloadLimits | undefined;
    // A static site and a service bundle are not interchangeable: each unit takes only its own kind.
    const expected = unit.recipe === "node-service-ssh-nginx@1" ? SERVICE_PAYLOAD_ALGORITHM : STATIC_PAYLOAD_ALGORITHM;
    if (artifact.payloadAlgorithm !== expected) {
      throw new Error(`prepared artifact is ${artifact.payloadAlgorithm}, but ${unit.recipe} releases ${expected}`);
    }
    if (
      !limits
      || !Number.isInteger(limits.maxFiles)
      || !Number.isInteger(limits.maxPathBytes)
      || !Number.isInteger(limits.maxFileBytes)
      || !Number.isInteger(limits.maxUnpackedBytes)
    ) {
      throw new Error("prepared artifact has no complete payload identity");
    }
    return {
      psmArtifactId: artifact.artifactId,
      githubArtifactId: artifact.githubArtifactId,
      producerRunId: artifact.producerRunId,
      sourceRepository: artifact.sourceRepository,
      commitSha: artifact.commitSha,
      version: artifact.version,
      payloadAlgorithm: expected,
      payloadLimits: limits,
      payloadDigest: artifact.payloadDigest,
      archiveDigest: artifact.archiveDigest,
    };
  }

  #targetContract(document: DeploymentPlanDocument, unit: UnitManifest): { fingerprint: string; revision: string } {
    const profile = this.#connections.profile({
      checkoutId: document.checkoutId,
      environmentId: document.environmentId,
      slot: unit.target.observerConnection,
      kind: "ssh-host-helper@1",
      plan: document,
    });
    const contracts = object(profile.publicMetadata?.targetContracts);
    const contract = object(contracts[unit.target.targetId]);
    if (typeof contract.fingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(contract.fingerprint) || typeof contract.revision !== "string") {
      throw new Error(`host connection has no trusted contract for ${unit.target.targetId}`);
    }
    return { fingerprint: contract.fingerprint, revision: contract.revision };
  }

  #releaseDispatch(context: DeploymentAdapterContext): ReleaseControllerDispatch {
    const document = planDocument(context);
    const unit = unitForAction(context);
    const rollback = document.operation === "rollback";
    const selectedRelease = rollback ? document.rollbackRelease : null;
    const artifact = rollback
      ? this.#connections.store.getArtifact(selectedRelease?.artifactId ?? "")
      : document.artifact;
    if (!artifact) throw new Error("release action has no prepared artifact");
    const identity = this.#artifactIdentity(artifact, unit);
    const active = document.activeReleases.find((item) => item.targetId === unit.target.targetId) ?? null;
    const activeReceipt = object(active?.receipt);
    const intendedReleaseId = rollback ? selectedRelease!.releaseId : `release_${artifact.artifactId}`;
    const intendedPayloadDigest = rollback
      ? String(object(selectedRelease!.receipt).payloadDigest ?? "")
      : artifact.payloadDigest;
    const target = this.#targetContract(document, unit);
    const probes = unit.verification.map((probe) => {
      const timeoutMs = Math.min(60_000, Math.max(100, probe.request.timeoutMs ?? 5_000));
      if (probe.kind === "release-metadata@1") {
        return {
          id: probe.id,
          kind: "release-metadata@1" as const,
          url: probe.request.url,
          expectedCommitSha: identity.commitSha,
          expectedPsmArtifactId: identity.psmArtifactId,
          timeoutMs,
        };
      }
      return {
        id: probe.id,
        kind: "http-status@1" as const,
        url: probe.request.url,
        method: probe.request.method,
        expectedStatuses: [probe.expect.status],
        timeoutMs,
      };
    });
    const contract: StaticReleaseExecutionContract = {
      schema: RELEASE_EXECUTION_CONTRACT_SCHEMA,
      operation: rollback ? "rollback" : document.operation === "release" ? "release" : "deploy",
      projectId: document.projectId,
      environmentId: document.environmentId,
      unitId: unit.id,
      target: { id: unit.target.targetId, fingerprint: target.fingerprint, contractRevision: target.revision },
      artifact: identity,
      expectedCurrentRelease: active ? {
        releaseId: active.releaseId,
        payloadDigest: String(activeReceipt.payloadDigest ?? ""),
      } : null,
      intendedRelease: { releaseId: intendedReleaseId, payloadDigest: intendedPayloadDigest },
      plan: { digest: context.plan.digest, expiresAt: new Date(document.expiresAt).toISOString() },
      conditionalRollback: rollbackAuthorization(rollback, document.policy.authority.automaticRollback === true, active?.releaseId ?? null, intendedReleaseId),
      pm2: { invariant: "unchanged", snapshotDigest: this.#pm2Digest(context, unit) },
      probes,
    };
    return {
      controller: "werewolf-static@1",
      psmRunId: context.run.runId,
      projectId: document.projectId,
      environmentId: document.environmentId,
      unitId: unit.id,
      releaseId: intendedReleaseId,
      targetId: unit.target.targetId,
      planDigest: context.plan.digest,
      planExpiresAt: contract.plan.expiresAt,
      artifact: identity,
      executionContract: contract,
      executionContractDigest: releaseExecutionContractDigest(contract),
    };
  }

  async #submitRelease(context: DeploymentAdapterContext): Promise<AdapterObservation> {
    const profile = this.#profileForAction(context, "github-actions@1");
    let dispatch: ReleaseControllerDispatch;
    try {
      dispatch = this.#releaseDispatch(context);
      // Reject deterministic local contract errors before contacting GitHub.
      releaseDispatchInputs(dispatch);
    } catch (error) {
      if (error instanceof ExecutorContractError) {
        return { outcome: "failed", data: { reason: "local-contract-invalid", detail: error.message.slice(0, 300) } };
      }
      throw error;
    }
    const adapter = this.#github(profile);
    // The allowlist answers without contacting GitHub, so a refusal is known, not a lost response.
    const policyRejection = adapter.releaseDispatchPolicyRejection(dispatch);
    if (policyRejection) {
      return { outcome: "failed", data: { reason: "release-policy-rejected", detail: `The pinned GitHub connection rejected this release before dispatch: ${policyRejection}. Nothing was sent to GitHub or the target.` } };
    }
    const controllers = (profile.publicMetadata as unknown as GitHubActionsConnectionMetadata).releaseControllers;
    const controller = controllers.find((entry) => entry.targetId === dispatch.targetId);
    if (controller?.sourceAuthorization === "installation-token") {
      const sharing = this.#connections.store.listConnections().some((record) => record.kind === "github-actions@1"
        && (deploymentConnectionProfile(record).publicMetadata?.releaseControllers as GitHubActionsConnectionMetadata["releaseControllers"] | undefined)
          ?.some((entry) => entry.targetId !== dispatch.targetId && entry.repository === controller.repository && entry.githubEnvironment === controller.githubEnvironment));
      if (sharing)
        throw new Error("Each managed target needs its own GitHub Environment for source-token delivery");
      const sourceToken = await githubAppTokens(this.#connections.broker).token(profile, dispatch.artifact.sourceRepository, { actions: "read" }, true);
      await adapter.publishEnvironmentSecrets(dispatch.targetId, { PSM_SOURCE_READ_TOKEN: sourceToken }, { signal: context.signal });
    }
    const receipt = await adapter.dispatchRelease(dispatch, { signal: context.signal });
    return {
      outcome: "pending",
      externalId: receipt.providerRunId ?? context.idempotencyKey,
      data: json({ receipt, dispatch }),
    };
  }

  async #observeRelease(context: DeploymentAdapterContext): Promise<AdapterObservation> {
    const stored = object(context.step?.result);
    const data = object(stored.data);
    const receipt = data.receipt as unknown as GitHubDispatchReceipt | undefined;
    const dispatch = data.dispatch as unknown as ReleaseControllerDispatch | undefined;
    const profile = this.#profileForAction(context, "github-actions@1");
    const github = this.#github(profile);
    if (!receipt || !dispatch) return this.#observeReleaseWithoutReceipt(context, github);
    const polled = await github.pollRun(receipt, { signal: context.signal });
    // Every non-final answer carries the receipt forward: it is the only record of
    // which GitHub run this step started, and recovery needs it again.
    const carried = { receipt: polled.receipt, dispatch } as unknown as Record<string, JsonValue>;
    if (!polled.run || polled.run.status !== "completed") {
      return { outcome: "pending", externalId: polled.run?.providerRunId ?? context.externalId, data: json(carried) };
    }
    if (polled.run.conclusion !== "success") {
      const step = await github.releaseTargetStep(polled.receipt, { signal: context.signal });
      const reason = `controller-${polled.run.conclusion ?? "failed"}`;
      if (!step.reached) {
        return {
          outcome: "failed",
          externalId: polled.run.providerRunId,
          data: json({ ...carried, reason, detail: `The release controller stopped${step.stoppedAt ? ` at "${step.stoppedAt}"` : ""} before reaching the target, so nothing on the server changed. See ${polled.run.provenanceUrl}` }),
        };
      }
      const untouched = await this.#releaseOnTarget(context, dispatch, polled.run.providerRunId);
      if (untouched) {
        return {
          outcome: "failed",
          externalId: polled.run.providerRunId,
          data: json({ ...carried, reason, detail: `The release controller failed${step.stoppedAt ? ` at "${step.stoppedAt}"` : ""}. ${untouched} See ${polled.run.provenanceUrl}` }),
        };
      }
      return { outcome: "unknown", externalId: polled.run.providerRunId, data: json({ ...carried, reason }) };
    }
    let resultValue: unknown;
    try {
      resultValue = await github.downloadRunArtifactJson(
        polled.receipt,
        `${context.run.runId}-result`,
        "psm-release-result.json",
        { signal: context.signal },
      );
    } catch (error) {
      if (!(error instanceof GitHubExecutorError && error.code === "artifact-integrity"
        && error.message === "workflow must retain exactly one named result artifact")) throw error;
      // GitHub completed, but published no result to import. The target's own
      // exact receipt can establish what is active; it cannot make this run a
      // verified success without the controller's result artifact.
      const onTarget = await this.#releaseOnTarget(context, dispatch, polled.run.providerRunId);
      if (!onTarget) return { outcome: "unknown", externalId: polled.run.providerRunId, data: json({ ...carried, reason: "result-artifact-missing" }) };
      return { outcome: "failed", externalId: polled.run.providerRunId, data: json({
        ...carried, reason: "result-artifact-missing",
        detail: `The controller completed but uploaded no release result. ${onTarget} See ${polled.run.provenanceUrl}`,
      }) };
    }
    const result = await github.importReleaseResult(polled.receipt, dispatch, resultValue, { signal: context.signal });
    if (result.state === "failed") return { outcome: "unknown", externalId: result.providerRunId, data: json({ ...result, ...carried }) };
    if (result.state === "rolled-back") return { outcome: "rolled-back", externalId: result.providerRunId, data: json(result) };
    const document = planDocument(context);
    const artifact = this.#connections.store.getArtifact(dispatch.artifact.psmArtifactId);
    this.#connections.store.activateRelease({
      releaseId: result.releaseId,
      artifactId: artifact.artifactId,
      activationRunId: context.run.runId,
      targetId: result.targetId,
      projectId: result.projectId,
      environmentId: result.environmentId,
      unitId: result.unitId,
      provenance: "managed",
      targetContractDigest: result.targetFingerprint,
      receipt: json({ ...result, commit: artifact.commitSha, version: artifact.version, payloadDigest: artifact.payloadDigest }),
      activatedAt: Date.parse(result.activatedAt ?? new Date().toISOString()),
      expectedCurrentReleaseId: dispatch.executionContract.expectedCurrentRelease?.releaseId ?? null,
    });
    // Redeploying a release left active-but-unverified verifies it in place.
    this.#connections.store.verifyActiveRelease({
      releaseId: result.releaseId,
      targetId: result.targetId,
      activationRunId: context.run.runId,
      receipt: json({ ...result, commit: artifact.commitSha, version: artifact.version, payloadDigest: artifact.payloadDigest }),
    });
    return {
      outcome: document.operation === "rollback" ? "rolled-back" : "succeeded",
      externalId: result.providerRunId,
      data: json(result),
    };
  }

  /**
   * After the controller finished, the target's own answer says exactly what this
   * release left behind. Returns that sentence, or null when the target cannot say.
   * An approved release left active without verification is recorded as the
   * target's active release, so the next plan's compare-and-set expects it.
   */
  async #releaseOnTarget(context: DeploymentAdapterContext, dispatch: ReleaseControllerDispatch, providerRunId: string): Promise<string | null> {
    const document = planDocument(context);
    const unit = unitForAction(context);
    const host = this.#connections.profile({ checkoutId: document.checkoutId, environmentId: document.environmentId, slot: unit.target.observerConnection, kind: "ssh-host-helper@1", plan: document });
    const observed = helperData(await this.#host.invoke({ connection: host, request: hostHelperRequest({ targetId: dispatch.targetId, operation: "observe-target", desired: {} }), signal: context.signal }));
    const found = releaseStateOnTarget(observed, dispatch.releaseId);
    const active = found.active ?? "none";
    if (found.state === "absent") return `The target shows ${dispatch.releaseId} was never staged or activated (active release: ${active}), so nothing on the server changed.`;
    if (found.state === "staged") return `The target shows ${dispatch.releaseId} staged but not activated; the active release is still ${active}.`;
    if (found.state !== "active") return null;
    const receipt = approvedReleaseActiveOnTarget(observed, dispatch);
    if (!receipt) {
      // The controller is finished and the target is fully observed, so this is
      // known, not uncertain; it just is not the approved release to record.
      const live = object(observed.active);
      const differs = ["artifactId", "commitSha", "version", "payloadDigest", "archiveDigest"].some((key) => live[key] !== (key === "artifactId" ? dispatch.artifact.psmArtifactId : (dispatch.artifact as unknown as Record<string, unknown>)[key]));
      if (differs) return null;
      return `The target shows ${dispatch.releaseId} active, staged under target contract ${String(live.targetDigest).slice(0, 19)}… while this run approved ${dispatch.executionContract.target.fingerprint.slice(0, 19)}…, so PSM did not record it. The target contract changed after it was pinned; re-verify it before deploying again.`;
    }
    if (this.#connections.store.getActiveRelease(dispatch.targetId)?.releaseId !== dispatch.releaseId) {
      const artifact = this.#connections.store.getArtifact(dispatch.artifact.psmArtifactId);
      this.#connections.store.activateRelease({
        releaseId: dispatch.releaseId,
        artifactId: artifact.artifactId,
        activationRunId: context.run.runId,
        targetId: dispatch.targetId,
        projectId: dispatch.projectId,
        environmentId: dispatch.environmentId,
        unitId: dispatch.unitId,
        provenance: "managed",
        targetContractDigest: dispatch.executionContract.target.fingerprint,
        receipt: json({ verified: false, providerRunId, releaseId: dispatch.releaseId, commit: artifact.commitSha, version: artifact.version, payloadDigest: artifact.payloadDigest, stagedAt: receipt.stagedAt ?? null }),
        activatedAt: Date.now(),
        expectedCurrentReleaseId: dispatch.executionContract.expectedCurrentRelease?.releaseId ?? null,
      });
    }
    return `The target shows ${dispatch.releaseId} active, but PSM has no successful verification receipt. PSM recorded it as active and unverified; a fresh reviewed plan can verify it in place.`;
  }

  /**
   * Steps held before receipts were carried forward kept only GitHub's run id. That
   * id, the PSM run in the run's title and the target's own state still decide it.
   */
  async #observeReleaseWithoutReceipt(context: DeploymentAdapterContext, github: GitHubActionsAdapter): Promise<AdapterObservation> {
    let providerRunId = context.step?.externalId ?? "";
    if (!/^[1-9][0-9]{0,19}$/.test(providerRunId)) {
      if (preDispatchContractFailure(this.#connections.store.listEvents(context.run.runId), context.action.actionId)) {
        return { outcome: "failed", data: { reason: "local-contract-invalid", detail: "The execution contract was rejected locally before GitHub was contacted; no release was dispatched." } };
      }
      const dispatch = this.#releaseDispatch(context);
      if (!context.step?.submittedAt) return { outcome: "unknown", data: { reason: "dispatch-receipt-unavailable" } };
      const policyRejection = github.releaseDispatchPolicyRejection(dispatch);
      if (policyRejection) {
        if (await this.#missingReceiptTargetUnchanged(context, dispatch)) {
          return { outcome: "failed", data: { reason: "release-policy-rejected", detail: `The pinned GitHub connection rejected this release before dispatch: ${policyRejection}. The target still has the previously approved release.` } };
        }
        return { outcome: "unknown", data: { reason: "release-policy-rejected-target-uncertain", detail: `The pinned GitHub connection rejected dispatch locally (${policyRejection}), but the target does not match the approved prior release.` } };
      }
      try {
        providerRunId = await github.findReleaseRunByCorrelation(dispatch.targetId, context.run.runId, context.step.submittedAt, { signal: context.signal }) ?? "";
      } catch (error) {
        if (error instanceof GitHubExecutorError) {
          return { outcome: "unknown", data: { reason: "dispatch-search-inconclusive", detail: error.message.slice(0, 300) } };
        }
        throw error;
      }
      if (!providerRunId) {
        if (await this.#missingReceiptTargetUnchanged(context, dispatch)) {
          return { outcome: "failed", data: { reason: "release-not-dispatched", detail: "GitHub workflow history contains no run for this submission, and the target still has the previously approved release with no staged or active copy of the intended release." } };
        }
        return { outcome: "unknown", data: { reason: "dispatch-receipt-unavailable", detail: "No matching GitHub run was found, but the target has not proved the intended release absent and its previous release unchanged." } };
      }
    }
    const dispatch = this.#releaseDispatch(context);
    const run = await github.releaseRunById(dispatch.targetId, providerRunId, context.run.runId, { signal: context.signal });
    if (!run.completed) return { outcome: "unknown", externalId: providerRunId, data: { reason: "controller-still-running" } };
    const reason = `controller-${run.conclusion ?? "failed"}`;
    if (run.conclusion !== "success" && !run.reached) {
      return { outcome: "failed", externalId: providerRunId, data: json({ reason, detail: `The release controller stopped${run.stoppedAt ? ` at "${run.stoppedAt}"` : ""} before reaching the target, so nothing on the server changed. See ${run.provenanceUrl}` }) };
    }
    const untouched = await this.#releaseOnTarget(context, dispatch, providerRunId);
    if (untouched && run.conclusion !== "success") {
      return { outcome: "failed", externalId: providerRunId, data: json({ reason, detail: `The release controller failed${run.stoppedAt ? ` at "${run.stoppedAt}"` : ""}. ${untouched} See ${run.provenanceUrl}` }) };
    }
    return { outcome: "unknown", externalId: providerRunId, data: { reason } };
  }

  async #missingReceiptTargetUnchanged(context: DeploymentAdapterContext, dispatch: ReleaseControllerDispatch): Promise<boolean> {
    const document = planDocument(context);
    const unit = unitForAction(context);
    const host = this.#connections.profile({ checkoutId: document.checkoutId, environmentId: document.environmentId,
      slot: unit.target.observerConnection, kind: "ssh-host-helper@1", plan: document });
    const observed = helperData(await this.#host.invoke({ connection: host,
      request: hostHelperRequest({ targetId: dispatch.targetId, operation: "observe-target", desired: {} }), signal: context.signal }));
    return missingReceiptReleaseAbsent(observed, dispatch);
  }

  async #checkActivation(context: DeploymentAdapterContext): Promise<AdapterObservation> {
    const dispatch = this.#releaseDispatch(context);
    const active = this.#connections.store.getActiveRelease(dispatch.targetId);
    return {
      outcome: active?.releaseId === dispatch.releaseId && active.artifactId === dispatch.artifact.psmArtifactId ? "succeeded" : "failed",
      data: { expectedReleaseId: dispatch.releaseId, activeReleaseId: active?.releaseId ?? null },
    };
  }

  async #checkActiveReleaseOnTarget(context: DeploymentAdapterContext): Promise<AdapterObservation> {
    const dispatch = this.#releaseDispatch(context);
    const active = this.#connections.store.getActiveRelease(dispatch.targetId);
    if (active?.releaseId !== dispatch.releaseId || active.artifactId !== dispatch.artifact.psmArtifactId) {
      return { outcome: "failed", data: { reason: "active-release-changed" } };
    }
    const document = planDocument(context);
    const unit = unitForAction(context);
    const host = this.#connections.profile({ checkoutId: document.checkoutId, environmentId: document.environmentId,
      slot: unit.target.observerConnection, kind: "ssh-host-helper@1", plan: document });
    const observed = helperData(await this.#host.invoke({ connection: host,
      request: hostHelperRequest({ targetId: dispatch.targetId, operation: "observe-target", desired: {} }), signal: context.signal }));
    const receipt = approvedReleaseActiveOnTarget(observed, dispatch);
    return receipt
      ? { outcome: "succeeded", data: { releaseId: dispatch.releaseId, artifactId: dispatch.artifact.psmArtifactId, targetObserved: true } }
      : { outcome: "failed", data: { reason: "active-release-target-mismatch", releaseId: dispatch.releaseId } };
  }

  async #dnsContext(
    resource: DigitalOceanDnsResource,
    context: { checkoutId: string; environment: EnvironmentManifest },
    plan?: DeploymentPlanDocument,
  ): Promise<DnsContext> {
    const profile = plan
      ? this.#connections.profile({ checkoutId: plan.checkoutId, environmentId: plan.environmentId, slot: resource.connection, kind: "digitalocean-api@1", plan })
      : this.#profileForEnvironment({ checkoutId: context.checkoutId, environment: context.environment, slot: resource.connection, kind: "digitalocean-api@1" });
    const sourceSlot = resource.desired.valueFrom.connection;
    const sourceKind = context.environment.connections[sourceSlot]?.kind;
    if (!sourceKind) throw new Error(`DNS address source connection ${sourceSlot} is missing`);
    const source = plan
      ? this.#connections.profile({ checkoutId: plan.checkoutId, environmentId: plan.environmentId, slot: sourceSlot, kind: sourceKind, plan })
      : this.#profileForEnvironment({ checkoutId: context.checkoutId, environment: context.environment, slot: sourceSlot, kind: sourceKind });
    return { resource, profile, address: addressFrom(source) };
  }

  async #observeDns(input: DnsContext, projectId: string, environmentId: string, signal?: AbortSignal): Promise<ResourceDiscoveryResult> {
    return this.#connections.withToken(input.profile, async (token) => {
      const client = new DigitalOceanClient({ token, apiBaseUrl: typeof input.profile.publicMetadata?.apiBaseUrl === "string" ? input.profile.publicMetadata.apiBaseUrl : undefined });
      const observed = await client.observeDns(input.resource, signal);
      const binding = this.#connections.store.getResourceBinding(projectId, environmentId, input.resource.id);
      const evidence = { zone: input.resource.desired.zone, name: input.resource.desired.name, records: observed.records, address: input.address };
      if (binding) {
        if (binding.connectionId !== input.profile.connectionId || binding.providerAccount !== observed.accountId) {
          return { state: "conflict", detail: "DNS ownership binding points at another connection or account", observed: evidence, providerAccount: observed.accountId };
        }
        let owned = observed.records.find((record) => record.id === binding.providerObjectId);
        // The filtered list can lag a successful create. Check the bound ID
        // directly before declaring that a record disappeared.
        if (!owned) {
          try {
            const byId = await client.getDns(input.resource.desired.zone, binding.providerObjectId, signal);
            if (byId.name === input.resource.desired.name && byId.type === input.resource.desired.type) owned = byId;
          } catch (error) {
            if (!(error instanceof DigitalOceanError && error.status === 404)) throw error;
          }
        }
        if (!owned) return { state: "conflict", detail: "The owned DNS record no longer exists", observed: evidence, providerAccount: observed.accountId, providerObjectId: binding.providerObjectId };
        return {
          state: dnsMatches(owned, input.resource, input.address) ? "in-sync" : "update",
          detail: dnsMatches(owned, input.resource, input.address) ? "Owned DNS record matches" : "Owned DNS record differs",
          observed: evidence,
          providerAccount: observed.accountId,
          providerObjectId: owned.id,
        };
      }
      if (observed.records.length === 0) return { state: "create", detail: "DNS record does not exist", observed: evidence, providerAccount: observed.accountId };
      if (observed.records.length === 1 && dnsMatches(observed.records[0], input.resource, input.address)) {
        return { state: "adopt", detail: "A matching unowned DNS record requires explicit adoption", observed: evidence, providerAccount: observed.accountId, providerObjectId: observed.records[0].id };
      }
      return { state: "conflict", detail: "Unowned DNS records conflict with the desired identity", observed: evidence, providerAccount: observed.accountId };
    });
  }

  /** PSM's stored values for the names it has; a name without a value is simply absent. */
  async #localServiceSecrets(projectId: string, environmentId: string, unitId: string, names: readonly string[]): Promise<Map<string, string>> {
    const owner = serviceSecretOwner(projectId, environmentId, unitId);
    const status = await this.#connections.broker.status(owner, []);
    const present = names.filter((name) => status.availableSlots.includes(serviceSecretSlot(name)));
    if (!present.length) return new Map();
    return this.#connections.broker.withLease(owner, present.map(serviceSecretSlot), (lease) =>
      new Map(present.map((name) => [name, lease.useUtf8(serviceSecretSlot(name), (value) => value)])));
  }

  async #observeServiceSecrets(
    resource: ServiceSecretsResource,
    unit: UnitManifest,
    projectId: string,
    environmentId: string,
    profile: ConnectionProfile,
    signal?: AbortSignal,
  ): Promise<ResourceDiscoveryResult> {
    const salt = randomBytes(16);
    const response = await this.#host.invoke({
      connection: profile,
      request: hostHelperRequest({ targetId: unit.target.targetId, operation: "observe-resource",
        desired: { kind: "service-secrets@1", names: resource.desired.names, salt: salt.toString("hex") } }),
      signal,
    });
    const data = helperData(response);
    const local = await this.#localServiceSecrets(projectId, environmentId, unit.id, resource.desired.names);
    const states = compareServiceSecrets(resource.desired.names, local, object(data.fingerprints), salt);
    salt.fill(0);
    return serviceSecretsSummary(states, Array.isArray(data.undeclared) ? data.undeclared.map(String) : []);
  }

  async discoverResource(
    resource: ResourceManifest,
    context: { projectId: string; checkoutId: string; environment: EnvironmentManifest },
  ): Promise<ResourceDiscoveryResult> {
    if (resource.kind === "digitalocean-dns-record@1") {
      return this.#observeDns(await this.#dnsContext(resource, context), context.projectId, context.environment.id);
    }
    const unit = targetForResource(resource, context.environment);
    const profile = this.#profileForEnvironment({ checkoutId: context.checkoutId, environment: context.environment, slot: resource.connection, kind: "ssh-host-helper@1" });
    if (resource.kind === "service-secrets@1") {
      return this.#observeServiceSecrets(resource, unit, context.projectId, context.environment.id, profile);
    }
    const response = await this.#host.invoke({
      connection: profile,
      request: hostHelperRequest({ targetId: unit.target.targetId, operation: "observe-resource", desired: helperDesired(resource) }),
    });
    return stateResult(helperData(response), `${resource.kind} observed through the enrolled host helper`);
  }

  async observeWatch(
    definition: ExternalHttpWatch,
    context: { projectId: string; checkoutId: string; environment: EnvironmentManifest },
  ): Promise<WatchObservation> {
    const profile = this.#profileForEnvironment({ checkoutId: context.checkoutId, environment: context.environment, slot: definition.connection, kind: "external-monitor@1" });
    const provider = profile.publicMetadata?.provider;
    if (provider === "werewolf-watch@1") return observeWerewolfWatch(profile, new SshMachineTransport({broker: this.#connections.broker}), definition);
    if (provider !== "better-stack@1") throw new Error("external monitor profile is not Better Stack v1");
    return this.#connections.withToken(profile, (token) => new BetterStackClient({
      token,
      apiBaseUrl: typeof profile.publicMetadata?.apiBaseUrl === "string" ? profile.publicMetadata.apiBaseUrl : undefined,
    }).observe(definition));
  }

  async #observeHostAction(context: DeploymentAdapterContext): Promise<AdapterObservation> {
    const document = planDocument(context);
    const action = actionDocument(context);
    const environmentValue = environment(document);
    const profile = this.#profileForAction(context, "ssh-host-helper@1");
    if (context.action.kind === "snapshot-pm2@1" || context.action.kind === "compare-pm2@1") {
      const unit = unitForAction(context);
      const operation = context.action.kind === "snapshot-pm2@1" ? "snapshot-pm2" : "compare-pm2";
      let desired: JsonValue = {};
      if (operation === "compare-pm2") {
        const beforeId = context.action.actionId.endsWith("-rollback")
          ? `unit:${unit.id}#pm2-before-rollback`
          : `unit:${unit.id}#pm2-before`;
        const event = this.#connections.store.listEvents(context.run.runId, 0, 500).find((item) =>
          item.type === "action-checked" && object(item.data).actionId === beforeId
        );
        const result = object(object(object(event?.data).result).data);
        if (typeof result.digest !== "string") throw new Error("durable PM2 baseline is unavailable");
        desired = { expectedDigest: result.digest };
      }
      const response = await this.#host.invoke({ connection: profile, request: hostHelperRequest({ targetId: unit.target.targetId, operation, desired }), signal: context.signal });
      return { outcome: "succeeded", data: json(helperData(response)) };
    }
    const resource = resourceForAction(context);
    if (resource.kind === "digitalocean-dns-record@1") throw new Error("DNS does not use the host helper");
    const unit = targetForResource(resource, environmentValue);
    if (resource.kind === "service-secrets@1") {
      const result = await this.#observeServiceSecrets(resource, unit, document.projectId, document.environmentId, profile, context.signal);
      return { outcome: result.state === "in-sync" ? "succeeded" : "failed", data: json({ state: result.state, detail: result.detail, ...object(result.observed) }) };
    }
    let operation = "observe-resource";
    let desired = helperDesired(resource, ingressObservationTls(context.action.kind, action.operation));
    if (context.action.kind === "validate-nginx@1" || context.action.kind === "reload-nginx@1") {
      operation = "validate-nginx";
      desired = {};
    }
    const response = await this.#host.invoke({ connection: profile, request: hostHelperRequest({ targetId: unit.target.targetId, operation, desired }), signal: context.signal });
    const data = helperData(response);
    // A syntax check cannot prove that systemctl actually reloaded nginx. If
    // the reload response was lost, hold the run for recovery instead of
    // reporting the old process as ready for ACME validation.
    if (context.action.kind === "reload-nginx@1") {
      return { outcome: "unknown", data: json({ reason: "nginx reload result is unavailable" }) };
    }
    const state = typeof data.state === "string" ? data.state : null;
    return { outcome: operation === "validate-nginx" || state === "in-sync" ? "succeeded" : "failed", data: json(data) };
  }

  async #submitHostAction(context: DeploymentAdapterContext): Promise<AdapterObservation> {
    const document = planDocument(context);
    const resource = resourceForAction(context);
    if (resource.kind === "digitalocean-dns-record@1") throw new Error("DNS does not use the host helper");
    const unit = targetForResource(resource, environment(document));
    const profile = this.#profileForAction(context, "ssh-host-helper@1");
    const operation = context.action.kind.replace(/@1$/, "");
    let desired: JsonValue = context.action.kind === "reload-nginx@1" || context.action.kind === "validate-nginx@1"
      ? {}
      : json(resource.desired);
    if (resource.kind === "service-secrets@1") {
      // Values leave the secret store only inside this one typed request; they are
      // never part of the plan, the step data or an event.
      const local = await this.#localServiceSecrets(document.projectId, document.environmentId, unit.id, resource.desired.names);
      const missing = resource.desired.names.filter((name) => !local.has(name));
      if (missing.length) throw new Error(`Set ${missing.join(", ")} in PSM before deploying`);
      desired = { values: Object.fromEntries(local) };
    }
    const response = await this.#host.invoke({
      connection: profile,
      request: hostHelperRequest({
        targetId: unit.target.targetId,
        operation,
        desired,
        planDigest: document.planId ? context.plan.digest : undefined,
        idempotencyKey: context.idempotencyKey ?? undefined,
        expiresAt: document.expiresAt,
      }),
      signal: context.signal,
    });
    if (context.action.kind === "reload-nginx@1") {
      return { outcome: "succeeded", externalId: context.idempotencyKey, data: json(helperData(response)) };
    }
    return { outcome: "pending", externalId: context.idempotencyKey, data: { accepted: true } };
  }

  async #submitDns(context: DeploymentAdapterContext): Promise<AdapterObservation> {
    const document = planDocument(context);
    const resource = resourceForAction(context);
    if (resource.kind !== "digitalocean-dns-record@1") throw new Error("action is not a DNS resource");
    const input = await this.#dnsContext(resource, { checkoutId: document.checkoutId, environment: environment(document) }, document);
    await this.#connections.withToken(input.profile, async (token) => {
      const client = new DigitalOceanClient({ token, apiBaseUrl: typeof input.profile.publicMetadata?.apiBaseUrl === "string" ? input.profile.publicMetadata.apiBaseUrl : undefined });
      const observation = await client.observeDns(resource, context.signal);
      const existing = this.#connections.store.getResourceBinding(document.projectId, document.environmentId, resource.id);
      let selected: DigitalOceanDnsRecord;
      if (document.operation === "adopt") {
        if (existing || observation.records.length !== 1 || !dnsMatches(observation.records[0], resource, input.address)) {
          throw new Error("DNS record is no longer exactly adoptable");
        }
        selected = observation.records[0];
      } else if (!existing) {
        if (observation.records.length !== 0) throw new Error("an unowned DNS record appeared before create");
        selected = await client.createDns(resource, input.address, context.signal);
      } else {
        if (existing.connectionId !== input.profile.connectionId || existing.providerAccount !== observation.accountId) {
          throw new Error("DNS ownership binding changed before update");
        }
        const owned = observation.records.find((item) => item.id === existing.providerObjectId);
        if (!owned) throw new Error("owned DNS record disappeared before update");
        selected = dnsMatches(owned, resource, input.address)
          ? owned
          : await client.updateDns(resource, owned.id, input.address, context.signal);
      }
      this.#connections.store.bindResource({
        projectId: document.projectId,
        environmentId: document.environmentId,
        resourceId: resource.id,
        connectionId: input.profile.connectionId,
        providerAccount: observation.accountId,
        providerObjectId: selected.id,
        observedFingerprint: canonicalDigest("psm-digitalocean-dns-record:v1", selected),
        expectedRevision: existing?.bindingRevision ?? null,
        at: Date.now(),
      });
    });
    return { outcome: "pending", externalId: context.idempotencyKey, data: { accepted: true } };
  }

  #hostAdapter(kind: string): DeploymentActionAdapter {
    return {
      kind,
      execution: "remote",
      check: (context) => this.#observeHostAction(context),
      submit: (context) => this.#submitHostAction(context),
      observe: (context) => this.#observeHostAction(context),
    };
  }

  actionAdapters(): DeploymentActionAdapter[] {
    const hostKinds = [
      "reconcile-release-directory@1",
      "reconcile-service@1",
      "reconcile-service-secrets@1",
      "reconcile-ingress-http@1",
      "reconcile-certificate@1",
      "reconcile-ingress-tls@1",
      "validate-nginx@1",
      "reload-nginx@1",
      "snapshot-pm2@1",
      "compare-pm2@1",
    ];
    const dns: DeploymentActionAdapter = {
      kind: "reconcile-dns@1",
      execution: "remote",
      check: async (context) => {
        const document = planDocument(context);
        const resource = resourceForAction(context);
        if (resource.kind !== "digitalocean-dns-record@1") throw new Error("action is not a DNS resource");
        const result = await this.#observeDns(
          await this.#dnsContext(resource, { checkoutId: document.checkoutId, environment: environment(document) }, document),
          document.projectId,
          document.environmentId,
          context.signal,
        );
        return { outcome: result.state === "in-sync" ? "succeeded" : "failed", data: json(result) };
      },
      submit: (context) => this.#submitDns(context),
      observe: async (context) => {
        const document = planDocument(context);
        const resource = resourceForAction(context) as DigitalOceanDnsResource;
        const result = await this.#observeDns(
          await this.#dnsContext(resource, { checkoutId: document.checkoutId, environment: environment(document) }, document),
          document.projectId,
          document.environmentId,
          context.signal,
        );
        const binding = this.#connections.store.getResourceBinding(document.projectId, document.environmentId, resource.id);
        if (newlyCreatedDnsStillPending(result, binding, context.step, Date.now())) {
          return { outcome: "pending", externalId: context.externalId, data: json({ ...result, detail: "Waiting for newly created DNS record to become observable" }) };
        }
        return { outcome: result.state === "in-sync" ? "succeeded" : "failed", externalId: context.externalId, data: json(result) };
      },
    };
    const watch: DeploymentActionAdapter = {
      kind: "observe-watch@1",
      execution: "remote",
      check: async (context) => {
        const document = planDocument(context);
        const environmentValue = environment(document);
        const id = ownerId(actionDocument(context).ownerRef, "watch");
        const definition = environmentValue.watch.find((item) => item.id === id);
        if (!definition) throw new Error(`watch ${id} is absent from the manifest`);
        const observed = await this.observeWatch(definition, { projectId: document.projectId, checkoutId: document.checkoutId, environment: environmentValue });
        return { outcome: observed.effectiveState === "healthy" ? "succeeded" : "failed", data: deploymentWatchReceipt(observed) };
      },
    };
    const stage: DeploymentActionAdapter = {
      kind: "stage-static-release@1",
      execution: "remote",
      check: (context) => this.#checkActiveReleaseOnTarget(context),
      submit: (context) => this.#submitRelease(context),
      observe: (context) => this.#observeRelease(context),
    };
    const activate: DeploymentActionAdapter = {
      kind: "activate-static-release@1",
      execution: "remote",
      check: (context) => this.#checkActivation(context),
      submit: (context) => this.#submitRelease(context),
      observe: (context) => this.#observeRelease(context),
    };
    // A service release travels the same controller path; only the helper operation differs.
    const serviceStage: DeploymentActionAdapter = { ...stage, kind: "stage-service-release@1" };
    const serviceActivate: DeploymentActionAdapter = { ...activate, kind: "activate-service-release@1" };
    return [dns, ...hostKinds.map((kind) => this.#hostAdapter(kind)), stage, activate, serviceStage, serviceActivate, watch];
  }
}
