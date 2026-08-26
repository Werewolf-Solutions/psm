import net from "node:net";

import { canonicalDigest } from "./canonical.ts";
import {
  SecretBroker,
  validateConnectionProfile,
  type ConnectionProfile,
} from "./connections.ts";
import { BetterStackClient } from "./adapters/better-stack.ts";
import { DigitalOceanClient, dnsMatches, type DigitalOceanDnsRecord } from "./adapters/digitalocean.ts";
import { GitHubActionsAdapter, type GitHubActionsConnectionMetadata, type GitHubDispatchReceipt } from "./adapters/github.ts";
import {
  RELEASE_EXECUTION_CONTRACT_SCHEMA,
  STATIC_PAYLOAD_ALGORITHM,
  releaseExecutionContractDigest,
  type PreparedArtifactIdentity,
  type ReleaseControllerDispatch,
  type StaticPayloadLimits,
  type StaticReleaseExecutionContract,
} from "./adapters/executor-contract.ts";
import {
  SshHostHelperTransport,
  hostHelperRequest,
  type HostHelperResponse,
  type HostHelperTransport,
} from "./adapters/host-helper.ts";
import type { ObservationAdapters, ResourceDiscoveryResult, WatchObservation } from "./observations.ts";
import type { DeploymentPlanDocument, PlannedActionDocument } from "./planner.ts";
import type { AdapterObservation, DeploymentActionAdapter, DeploymentAdapterContext } from "./runner.ts";
import {
  DeploymentStore,
  type DeploymentConnection,
  type DeploymentArtifact,
  type JsonValue,
} from "./store.ts";
import type {
  DigitalOceanDnsResource,
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

function helperData(response: HostHelperResponse): Record<string, unknown> {
  const data = object(response.data);
  if (!Object.keys(data).length) throw new Error("host helper returned no observation data");
  return data;
}

function helperDesired(resource: Exclude<ResourceManifest, DigitalOceanDnsResource>, tls?: boolean): JsonValue {
  return json({ kind: resource.kind, ...resource.desired, ...(tls === undefined ? {} : { tls }) });
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
    };
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
      token: () => this.#connections.withToken(profile, async (token) => token),
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

  #artifactIdentity(artifact: DeploymentArtifact): PreparedArtifactIdentity {
    const limits = object(artifact.providerLocator).payloadLimits as StaticPayloadLimits | undefined;
    if (
      artifact.payloadAlgorithm !== STATIC_PAYLOAD_ALGORITHM
      || !limits
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
      payloadAlgorithm: STATIC_PAYLOAD_ALGORITHM,
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
    const identity = this.#artifactIdentity(artifact);
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
      conditionalRollback: {
        allowed: !rollback && document.policy.authority.automaticRollback === true && active !== null,
        previousReleaseId: active?.releaseId ?? null,
      },
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
    const dispatch = this.#releaseDispatch(context);
    const receipt = await this.#github(profile).dispatchRelease(dispatch, { signal: context.signal });
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
    if (!receipt || !dispatch) return { outcome: "unknown", data: { reason: "dispatch-receipt-unavailable" } };
    const profile = this.#profileForAction(context, "github-actions@1");
    const github = this.#github(profile);
    const polled = await github.pollRun(receipt, { signal: context.signal });
    if (!polled.run || polled.run.status !== "completed") {
      return { outcome: "pending", externalId: polled.run?.providerRunId ?? context.externalId, data: json({ receipt: polled.receipt, dispatch }) };
    }
    if (polled.run.conclusion !== "success") {
      return { outcome: "unknown", externalId: polled.run.providerRunId, data: { reason: `controller-${polled.run.conclusion ?? "failed"}` } };
    }
    const resultValue = await github.downloadRunArtifactJson(
      polled.receipt,
      `${context.run.runId}-result`,
      "psm-release-result.json",
      { signal: context.signal },
    );
    const result = await github.importReleaseResult(polled.receipt, dispatch, resultValue, { signal: context.signal });
    if (result.state === "failed") return { outcome: "unknown", externalId: result.providerRunId, data: json(result) };
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
    return {
      outcome: document.operation === "rollback" ? "rolled-back" : "succeeded",
      externalId: result.providerRunId,
      data: json(result),
    };
  }

  async #checkActivation(context: DeploymentAdapterContext): Promise<AdapterObservation> {
    const dispatch = this.#releaseDispatch(context);
    const active = this.#connections.store.getActiveRelease(dispatch.targetId);
    return {
      outcome: active?.releaseId === dispatch.releaseId && active.artifactId === dispatch.artifact.psmArtifactId ? "succeeded" : "failed",
      data: { expectedReleaseId: dispatch.releaseId, activeReleaseId: active?.releaseId ?? null },
    };
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
        const owned = observed.records.find((record) => record.id === binding.providerObjectId);
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

  async discoverResource(
    resource: ResourceManifest,
    context: { projectId: string; checkoutId: string; environment: EnvironmentManifest },
  ): Promise<ResourceDiscoveryResult> {
    if (resource.kind === "digitalocean-dns-record@1") {
      return this.#observeDns(await this.#dnsContext(resource, context), context.projectId, context.environment.id);
    }
    const unit = targetForResource(resource, context.environment);
    const profile = this.#profileForEnvironment({ checkoutId: context.checkoutId, environment: context.environment, slot: resource.connection, kind: "ssh-host-helper@1" });
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
    let operation = "observe-resource";
    let desired = helperDesired(resource, context.action.kind === "reconcile-ingress-http@1" ? false : undefined);
    if (context.action.kind === "validate-nginx@1" || context.action.kind === "reload-nginx@1") {
      operation = "validate-nginx";
      desired = {};
    }
    const response = await this.#host.invoke({ connection: profile, request: hostHelperRequest({ targetId: unit.target.targetId, operation, desired }), signal: context.signal });
    const data = helperData(response);
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
    const desired = context.action.kind === "reload-nginx@1" || context.action.kind === "validate-nginx@1"
      ? {}
      : json(resource.desired);
    await this.#host.invoke({
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
        return { outcome: observed.effectiveState === "healthy" ? "succeeded" : "failed", data: json(observed) };
      },
    };
    const stage: DeploymentActionAdapter = {
      kind: "stage-static-release@1",
      execution: "remote",
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
    return [dns, ...hostKinds.map((kind) => this.#hostAdapter(kind)), stage, activate, watch];
  }
}
