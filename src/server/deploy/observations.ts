import { canonicalDigest } from "./canonical.ts";
import { httpProbe, jsonPath, type HttpProbeResult } from "./probes.ts";
import type {
  DependencyManifest,
  EnvironmentManifest,
  ExternalHttpWatch,
  ResourceManifest,
  UnitManifest,
  VerificationManifest,
} from "./types.ts";

export type ObservationState =
  | "ready"
  | "in-sync"
  | "create"
  | "update"
  | "adopt"
  | "missing"
  | "conflict"
  | "blocked"
  | "unknown";

export interface DeploymentObservation {
  id: string;
  kind: string;
  state: ObservationState;
  title: string;
  detail: string;
  observedAt: number;
  fingerprint: string;
  evidence?: Record<string, unknown>;
}

export interface ResourceDiscoveryResult {
  state: Extract<ObservationState, "in-sync" | "create" | "update" | "adopt" | "conflict" | "blocked" | "unknown">;
  detail: string;
  /** Stable, redacted fields only. Raw provider responses are forbidden here. */
  observed?: Record<string, unknown>;
  providerAccount?: string;
  providerObjectId?: string;
}

export interface ExternalAssertionResult {
  ok: boolean;
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface WatchObservation {
  monitorId: string;
  providerState: string;
  effectiveState: "healthy" | "down" | "degraded" | "unknown" | "stale" | "not-monitored";
  observedAt: number;
  detail?: string;
  evidence?: Record<string, unknown>;
}

export interface ObservationAdapters {
  executionReadiness?: (unit: UnitManifest, context: { projectId: string; checkoutId: string; environment: EnvironmentManifest; commit: string }) => Promise<ExecutionReadinessCheck[]>;
  discoverResource?: (
    resource: ResourceManifest,
    context: { projectId: string; checkoutId: string; environment: EnvironmentManifest; operation?: string },
  ) => Promise<ResourceDiscoveryResult>;
  githubChecks?: (dependency: Extract<DependencyManifest, { kind: "github-checks@1" }>) => Promise<ExternalAssertionResult>;
  projectRelease?: (dependency: Extract<DependencyManifest, { kind: "project-release@1" }>) => Promise<ExternalAssertionResult>;
  werewolfBackupPolicy?: (dependency: Extract<DependencyManifest, { kind: "werewolf-backup-policy@1" }>) => Promise<ExternalAssertionResult>;
  watch?: (
    definition: ExternalHttpWatch,
    context: { projectId: string; checkoutId: string; environment: EnvironmentManifest },
  ) => Promise<WatchObservation | null>;
}

export interface ExecutionReadinessCheck {
  id: string;
  title: string;
  ready: boolean;
  detail: string;
  purpose: "prepare" | "deploy";
}

export interface EnvironmentObservations {
  dependencies: DeploymentObservation[];
  resources: DeploymentObservation[];
  watch: WatchObservation[];
  observedAt: number;
  execution?: ExecutionReadinessCheck[];
}

function fingerprint(kind: string, value: unknown): string {
  return canonicalDigest(`psm-deployment-observation:${kind}:v1`, value);
}

function detailFromProbe(result: HttpProbeResult): string {
  return `HTTP ${result.status} in ${result.durationMs}ms`;
}

async function observeHttpDependency(
  dependency: Extract<DependencyManifest, { kind: "http-status@1" | "http-json@1" }>,
): Promise<DeploymentObservation> {
  const observedAt = Date.now();
  try {
    const result = await httpProbe({
      url: dependency.request.url,
      method: dependency.request.method,
      timeoutMs: dependency.request.timeoutMs,
      maxBytes: dependency.request.maxResponseBytes,
      followSameOriginRedirects: dependency.request.followSameOriginRedirects,
    });
    const failures: string[] = [];
    if (result.status !== dependency.expect.status) {
      failures.push(`expected HTTP ${dependency.expect.status}, received ${result.status}`);
    }
    if (dependency.kind === "http-json@1") {
      for (const predicate of dependency.expect.equals) {
        const actual = jsonPath(result.json, predicate.path);
        if (!Object.is(actual, predicate.value)) {
          failures.push(`${predicate.path} did not equal the expected value`);
        }
      }
    }
    const evidence = {
      url: result.url,
      status: result.status,
      durationMs: result.durationMs,
      redirects: result.redirects,
    };
    return {
      id: dependency.id,
      kind: dependency.kind,
      state: failures.length ? "blocked" : "ready",
      title: dependency.id,
      detail: failures.join("; ") || detailFromProbe(result),
      observedAt: result.observedAt,
      fingerprint: fingerprint(dependency.kind, evidence),
      evidence,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: dependency.id,
      kind: dependency.kind,
      state: "blocked",
      title: dependency.id,
      detail: message,
      observedAt,
      fingerprint: fingerprint(dependency.kind, { error: message }),
    };
  }
}

async function observeExternalDependency(
  dependency: Exclude<DependencyManifest, { kind: "http-status@1" | "http-json@1" }>,
  adapters: ObservationAdapters,
): Promise<DeploymentObservation> {
  const observedAt = Date.now();
  const invoke = dependency.kind === "github-checks@1"
    ? adapters.githubChecks
    : dependency.kind === "project-release@1"
      ? adapters.projectRelease
      : adapters.werewolfBackupPolicy;
  if (!invoke) {
    const detail = `No ${dependency.kind} observation adapter is configured`;
    return {
      id: dependency.id,
      kind: dependency.kind,
      state: "blocked",
      title: dependency.id,
      detail,
      observedAt,
      fingerprint: fingerprint(dependency.kind, { unavailable: true }),
    };
  }
  try {
    // The branch preserves the discriminated callback type without weakening adapter inputs.
    let result: ExternalAssertionResult;
    if (dependency.kind === "github-checks@1") result = await adapters.githubChecks!(dependency);
    else if (dependency.kind === "project-release@1") result = await adapters.projectRelease!(dependency);
    else result = await adapters.werewolfBackupPolicy!(dependency);
    return {
      id: dependency.id,
      kind: dependency.kind,
      state: result.ok ? "ready" : "blocked",
      title: dependency.id,
      detail: result.detail,
      observedAt,
      fingerprint: fingerprint(dependency.kind, result.evidence ?? { ok: result.ok }),
      ...(result.evidence ? { evidence: result.evidence } : {}),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      id: dependency.id,
      kind: dependency.kind,
      state: "blocked",
      title: dependency.id,
      detail,
      observedAt,
      fingerprint: fingerprint(dependency.kind, { error: detail }),
    };
  }
}

export async function observeDependency(
  dependency: DependencyManifest,
  adapters: ObservationAdapters = {},
): Promise<DeploymentObservation> {
  if (dependency.kind === "http-status@1" || dependency.kind === "http-json@1") {
    return observeHttpDependency(dependency);
  }
  return observeExternalDependency(dependency, adapters);
}

export async function observeResource(
  projectId: string,
  environment: EnvironmentManifest,
  resource: ResourceManifest,
  adapters: ObservationAdapters = {},
  checkoutId = "",
  operation?: string,
): Promise<DeploymentObservation> {
  const observedAt = Date.now();
  if (!adapters.discoverResource) {
    const detail = `No read-only ${resource.kind} discovery adapter is configured`;
    return {
      id: resource.id,
      kind: resource.kind,
      state: "blocked",
      title: resource.id,
      detail,
      observedAt,
      fingerprint: fingerprint(resource.kind, { unavailable: true }),
    };
  }
  try {
    const result = await adapters.discoverResource(resource, { projectId, checkoutId, environment, operation });
    const evidence = {
      observed: result.observed ?? null,
      providerAccount: result.providerAccount ?? null,
      providerObjectId: result.providerObjectId ?? null,
    };
    return {
      id: resource.id,
      kind: resource.kind,
      state: result.state,
      title: resource.id,
      detail: result.detail,
      observedAt,
      fingerprint: fingerprint(resource.kind, evidence),
      evidence,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      id: resource.id,
      kind: resource.kind,
      state: "blocked",
      title: resource.id,
      detail,
      observedAt,
      fingerprint: fingerprint(resource.kind, { error: detail }),
    };
  }
}

export async function observeEnvironment(
  projectId: string,
  checkoutId: string,
  environment: EnvironmentManifest,
  adapters: ObservationAdapters = {},
  operation?: string,
): Promise<EnvironmentObservations> {
  const [dependencies, resources, watch] = await Promise.all([
    Promise.all(environment.dependencies.map((dependency) => observeDependency(dependency, adapters))),
    Promise.all(environment.resources.map((resource) => observeResource(projectId, environment, resource, adapters, checkoutId, operation))),
    Promise.all(environment.watch.map(async (definition) => {
      if (!adapters.watch) return null;
      try { return await adapters.watch(definition, { projectId, checkoutId, environment }); } catch { return null; }
    })),
  ]);
  return {
    dependencies,
    resources,
    watch: watch.filter((item): item is WatchObservation => item !== null),
    observedAt: Date.now(),
  };
}

export async function verifyDeployment(
  verification: VerificationManifest,
  release: { commit: string; psmArtifactId: string; version?: string },
): Promise<DeploymentObservation> {
  const observedAt = Date.now();
  try {
    const result = await httpProbe({
      url: verification.request.url,
      method: verification.request.method,
      timeoutMs: verification.request.timeoutMs,
      maxBytes: verification.request.maxResponseBytes,
      followSameOriginRedirects: verification.request.followSameOriginRedirects,
    });
    const failures: string[] = [];
    if (verification.kind === "http-status@1" || verification.kind === "http-json@1") {
      if (result.status !== verification.expect.status) failures.push(`expected HTTP ${verification.expect.status}, received ${result.status}`);
      if (verification.kind === "http-json@1") {
        for (const predicate of verification.expect.equals) {
          if (!Object.is(jsonPath(result.json, predicate.path), predicate.value)) failures.push(`${predicate.path} did not equal the expected value`);
        }
      }
    } else {
      if (result.status !== 200) failures.push(`expected HTTP 200, received ${result.status}`);
      const expected: Array<[string, unknown]> = [
        ["$.commit", release.commit],
        ["$.psmArtifactId", release.psmArtifactId],
      ];
      if (verification.expect.version && release.version) expected.push(["$.version", release.version]);
      for (const [path, value] of expected) {
        if (!Object.is(jsonPath(result.json, path), value)) failures.push(`${path} does not identify the approved release`);
      }
    }
    const evidence = { url: result.url, status: result.status, durationMs: result.durationMs };
    return {
      id: verification.id,
      kind: verification.kind,
      state: failures.length ? "blocked" : "ready",
      title: verification.id,
      detail: failures.join("; ") || detailFromProbe(result),
      observedAt: result.observedAt,
      fingerprint: fingerprint(verification.kind, evidence),
      evidence,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      id: verification.id,
      kind: verification.kind,
      state: "blocked",
      title: verification.id,
      detail,
      observedAt,
      fingerprint: fingerprint(verification.kind, { error: detail }),
    };
  }
}
