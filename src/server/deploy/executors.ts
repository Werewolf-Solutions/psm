/**
 * The action adapters PSM can perform honestly today.
 *
 * `DeploymentRunner.preflightAdapters` refuses a plan whose action kinds are
 * not all installed here, and it does so before any lock is taken. That refusal
 * is the point. Kinds needing infrastructure PSM does not yet own — the
 * root-owned host helper, a DigitalOcean adapter, an external monitor — are
 * absent rather than stubbed, because a stub returning `succeeded` would make
 * PSM claim a reconciliation it never performed. `installedExecutorKinds`
 * reports the same set to the planner, so the gap reaches an operator as a plan
 * blocker instead of as a failure half-way through an approved run.
 *
 * Every adapter here is read-only. Nothing in this file mutates a provider, a
 * target or a repository.
 */
import { observeDependency, observeResource, verifyDeployment, type DeploymentObservation, type ObservationAdapters } from "./observations.ts";
import type { DeploymentPlanDocument, PlannedActionDocument } from "./planner.ts";
import type { AdapterObservation, DeploymentActionAdapter, DeploymentAdapterContext } from "./runner.ts";
import type { DeploymentRelease, JsonValue } from "./store.ts";
import type { EnvironmentManifest, VerificationManifest } from "./types.ts";

/** Read-only actions have no external identity to recover by; only the evidence is durable. */
function evidence(observation: DeploymentObservation): AdapterObservation {
  const ready = observation.state === "ready" || observation.state === "in-sync";
  return {
    outcome: ready ? "succeeded" : "failed",
    data: {
      id: observation.id,
      kind: observation.kind,
      state: observation.state,
      detail: observation.detail,
      observedAt: observation.observedAt,
      fingerprint: observation.fingerprint,
    } as JsonValue,
  };
}

function planDocument(context: DeploymentAdapterContext): DeploymentPlanDocument {
  return context.plan.document as unknown as DeploymentPlanDocument;
}

function actionDocument(context: DeploymentAdapterContext): PlannedActionDocument {
  return context.action.document as unknown as PlannedActionDocument;
}

function environmentOf(document: DeploymentPlanDocument): EnvironmentManifest {
  const environment = document.manifest.environments.find((item) => item.id === document.environmentId);
  if (!environment) {
    throw new Error(`plan names environment ${document.environmentId}, which its own manifest does not declare`);
  }
  return environment;
}

/** `dependency:api-healthy` → `api-healthy`, and a wrong owner kind is a plan defect, not a retry. */
function ownerId(ownerRef: string, expected: string): string {
  const separator = ownerRef.indexOf(":");
  if (separator < 0 || ownerRef.slice(0, separator) !== expected) {
    throw new Error(`expected a ${expected} action, received owner ${ownerRef}`);
  }
  return ownerRef.slice(separator + 1);
}

/**
 * The exact bytes this run is verifying. A rollback verifies the release it
 * reactivates; everything else verifies the approved artifact. Neither is
 * inferred from what the target currently serves — that is the thing under test.
 */
function verifiedIdentity(document: DeploymentPlanDocument): { commit: string; psmArtifactId: string; version?: string } {
  if (document.operation === "rollback") {
    const release: DeploymentRelease | null = document.rollbackRelease;
    if (!release) throw new Error("a rollback plan reached verification without a retained release");
    const receipt = (release.receipt ?? {}) as { commit?: unknown; version?: unknown };
    return {
      commit: typeof receipt.commit === "string" ? receipt.commit : "",
      psmArtifactId: release.artifactId,
      ...(typeof receipt.version === "string" ? { version: receipt.version } : {}),
    };
  }
  const artifact = document.artifact;
  if (!artifact) throw new Error("plan reached verification without an approved artifact");
  return { commit: artifact.commitSha, psmArtifactId: artifact.artifactId, version: artifact.version };
}

function verificationsFor(document: DeploymentPlanDocument, action: PlannedActionDocument): VerificationManifest[] {
  const environment = environmentOf(document);
  const all = environment.units.flatMap((unit) => unit.verification);
  // A deploy verifies one named probe per action; a rollback re-runs the unit's set.
  if (action.ownerRef.startsWith("verification:")) {
    const id = ownerId(action.ownerRef, "verification");
    const probe = all.find((item) => item.id === id);
    if (!probe) throw new Error(`plan names verification ${id}, which its manifest does not declare`);
    return [probe];
  }
  const unitId = ownerId(action.ownerRef, "unit");
  const unit = environment.units.find((item) => item.id === unitId);
  if (!unit) throw new Error(`plan names unit ${unitId}, which its manifest does not declare`);
  return [...unit.verification].sort((left, right) => left.id.localeCompare(right.id));
}

/** Re-assert a cross-project or external dependency at the moment of the run. */
function assertDependency(observations: ObservationAdapters): DeploymentActionAdapter {
  return {
    kind: "assert-dependency@1",
    execution: "local",
    async check(context) {
      const document = planDocument(context);
      const environment = environmentOf(document);
      const id = ownerId(actionDocument(context).ownerRef, "dependency");
      const dependency = environment.dependencies.find((item) => item.id === id);
      if (!dependency) throw new Error(`plan names dependency ${id}, which its manifest does not declare`);
      return evidence(await observeDependency(dependency, observations));
    },
  };
}

/** Re-observe one reconciled resource. Discovery stays adapter-gated and fails closed. */
function verifyResource(observations: ObservationAdapters): DeploymentActionAdapter {
  return {
    kind: "verify-resource@1",
    execution: "local",
    async check(context) {
      const document = planDocument(context);
      const environment = environmentOf(document);
      const id = ownerId(actionDocument(context).ownerRef, "resource");
      const resource = environment.resources.find((item) => item.id === id);
      if (!resource) throw new Error(`plan names resource ${id}, which its manifest does not declare`);
      return evidence(await observeResource(document.projectId, environment, resource, observations, document.checkoutId));
    },
  };
}

/** Probe the public surface and require it to identify the exact approved release. */
const verifyRelease: DeploymentActionAdapter = {
  kind: "verify-release@1",
  execution: "local",
  async check(context) {
    const document = planDocument(context);
    const identity = verifiedIdentity(document);
    const probes = verificationsFor(document, actionDocument(context));
    const observations: DeploymentObservation[] = [];
    for (const probe of probes) observations.push(await verifyDeployment(probe, identity));
    const failed = observations.find((item) => item.state !== "ready");
    return {
      outcome: failed ? "failed" : "succeeded",
      data: {
        expected: { commit: identity.commit, psmArtifactId: identity.psmArtifactId, version: identity.version ?? null },
        probes: observations.map((item) => ({ id: item.id, state: item.state, detail: item.detail })),
      } as JsonValue,
    };
  },
};

/**
 * Every adapter PSM installs by default.
 *
 * They are all read-only, so this set alone can execute a `verify` plan and the
 * dependency and verification phases of any other. It cannot execute a release:
 * `stage-static-release@1` and `activate-static-release@1` need the protected
 * `deployment-control` workflow and an enrolled target, and the reconcile,
 * PM2 and watch kinds need the host helper and an external monitor. Those are
 * section 21 prerequisites, and their adapters land with them.
 */
export function defaultDeploymentAdapters(observations: ObservationAdapters = {}): DeploymentActionAdapter[] {
  return [assertDependency(observations), verifyResource(observations), verifyRelease];
}

export function installedExecutorKinds(adapters: readonly DeploymentActionAdapter[]): string[] {
  return [...new Set(adapters.map((adapter) => adapter.kind))].sort();
}
