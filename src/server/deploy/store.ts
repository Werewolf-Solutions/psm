/**
 * Durable state for managed deployments.
 *
 * This module is deliberately the only deployment layer that knows the table
 * layout. It exposes compare-and-set operations rather than generic updates:
 * an approved plan is queued atomically, steps cannot jump over durable intent,
 * events receive their sequence inside a write transaction, and an expired
 * target lease is not silently stolen.
 *
 * Values called `document`, `payload`, `intent` or `result` are versioned and
 * validated by their owning module before reaching this store. The boundary
 * still requires them to be serializable JSON so secrets/provider objects do
 * not accidentally become opaque SQLite values.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { db } from "../db.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type DeploymentRisk = "development" | "staging" | "production";
export type DeploymentOperation = "reconcile" | "release" | "deploy" | "rollback" | "adopt";
export type DeploymentRunState =
  | "queued"
  | "acquiring-locks"
  | "checking-preconditions"
  | "reconciling"
  | "dispatching"
  | "waiting-executor"
  | "observing-result"
  | "importing-artifact"
  | "verifying"
  | "interrupting"
  | "recovery-required"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "stale-plan"
  | "rolled-back";
export type DeploymentStepState =
  | "prepared"
  | "submitted"
  | "observed"
  | "completed"
  | "failed"
  | "cancelled"
  | "recovery-required";

export class DeploymentStoreError extends Error {}
export class DeploymentValidationError extends DeploymentStoreError {}
export class DeploymentNotFoundError extends DeploymentStoreError {}
export class DeploymentConflictError extends DeploymentStoreError {}
export class DeploymentTransitionError extends DeploymentConflictError {}

const TERMINAL_RUN_STATES = new Set<DeploymentRunState>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "stale-plan",
  "rolled-back",
]);

const TERMINAL_STEP_STATES = new Set<DeploymentStepState>([
  "completed",
  "failed",
  "cancelled",
]);

const STEP_TRANSITIONS: Readonly<Record<DeploymentStepState, readonly DeploymentStepState[]>> = {
  prepared: ["submitted", "failed", "cancelled"],
  submitted: ["observed", "failed", "cancelled", "recovery-required"],
  observed: ["completed", "failed", "recovery-required"],
  "recovery-required": ["recovery-required", "observed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const MAX_ID = 500;
const MAX_MESSAGE = 4_000;
const MAX_EVENTS_PAGE = 2_000;

function text(value: unknown, label: string, max = MAX_ID): string {
  const parsed = String(value ?? "").trim();
  if (!parsed) throw new DeploymentValidationError(`${label} is required`);
  if (parsed.length > max) throw new DeploymentValidationError(`${label} is too long`);
  return parsed;
}

function integer(value: unknown, label: string, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new DeploymentValidationError(`${label} must be an integer of at least ${minimum}`);
  }
  return parsed;
}

function json(value: JsonValue, label: string): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new DeploymentValidationError(`${label} must be JSON serializable`);
  }
  if (encoded === undefined) throw new DeploymentValidationError(`${label} must be JSON serializable`);
  // JSON.stringify silently converts some unsupported nested values. Parsing
  // produces the exact JSON value the caller will read back and rejects none of
  // JSON's valid scalar roots.
  JSON.parse(encoded);
  return encoded;
}

function fromJson<T extends JsonValue>(value: string): T {
  return JSON.parse(value) as T;
}

function sortedUnique(values: readonly string[], label: string): string[] {
  return [...new Set(values.map((value) => text(value, label)))].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function transaction<T>(database: DatabaseSync, write: () => T, immediate = false): T {
  database.exec(immediate ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = write();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function generatedId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export interface DeploymentManifestRecord {
  projectId: string;
  checkoutId: string;
  environmentId: string;
  commitSha: string;
  digest: string;
  schemaVersion: number;
  document: JsonValue;
  createdAt: number;
}

interface ManifestRow {
  project_id: string;
  checkout_id: string;
  environment_id: string;
  commit_sha: string;
  digest: string;
  schema_version: number;
  document: string;
  created_at: number;
}

const manifestFromRow = (row: ManifestRow): DeploymentManifestRecord => ({
  projectId: row.project_id,
  checkoutId: row.checkout_id,
  environmentId: row.environment_id,
  commitSha: row.commit_sha,
  digest: row.digest,
  schemaVersion: row.schema_version,
  document: fromJson(row.document),
  createdAt: row.created_at,
});

export type ConnectionReadiness = "ready" | "missing-secret" | "invalid" | "unknown";

export interface DeploymentConnection {
  connectionId: string;
  kind: string;
  label: string;
  metadataRevision: number;
  secretGeneration: number;
  readiness: ConnectionReadiness;
  metadata: JsonValue;
  constraints: JsonValue;
  createdAt: number;
  updatedAt: number;
}

interface ConnectionRow {
  connection_id: string;
  kind: string;
  label: string;
  metadata_revision: number;
  secret_generation: number;
  readiness: ConnectionReadiness;
  metadata: string;
  constraints_document: string;
  created_at: number;
  updated_at: number;
}

const connectionFromRow = (row: ConnectionRow): DeploymentConnection => ({
  connectionId: row.connection_id,
  kind: row.kind,
  label: row.label,
  metadataRevision: row.metadata_revision,
  secretGeneration: row.secret_generation,
  readiness: row.readiness,
  metadata: fromJson(row.metadata),
  constraints: fromJson(row.constraints_document),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface DeploymentConnectionBinding {
  projectId: string;
  checkoutId: string;
  environmentId: string;
  slot: string;
  connectionId: string;
  bindingRevision: number;
  createdAt: number;
  updatedAt: number;
}

interface ConnectionBindingRow {
  project_id: string;
  checkout_id: string;
  environment_id: string;
  slot: string;
  connection_id: string;
  binding_revision: number;
  created_at: number;
  updated_at: number;
}

const connectionBindingFromRow = (row: ConnectionBindingRow): DeploymentConnectionBinding => ({
  projectId: row.project_id,
  checkoutId: row.checkout_id,
  environmentId: row.environment_id,
  slot: row.slot,
  connectionId: row.connection_id,
  bindingRevision: row.binding_revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export type DeploymentPolicyScope = "global" | "risk" | "project" | "environment" | "target";

export interface DeploymentPolicyRecord {
  scopeKind: DeploymentPolicyScope;
  scopeId: string;
  revision: number;
  document: JsonValue;
  createdAt: number;
}

interface PolicyRow {
  scope_kind: DeploymentPolicyScope;
  scope_id: string;
  revision: number;
  document: string;
  created_at: number;
}

const policyFromRow = (row: PolicyRow): DeploymentPolicyRecord => ({
  scopeKind: row.scope_kind,
  scopeId: row.scope_id,
  revision: row.revision,
  document: fromJson(row.document),
  createdAt: row.created_at,
});

export interface DeploymentResourceBinding {
  projectId: string;
  environmentId: string;
  resourceId: string;
  connectionId: string;
  providerAccount: string;
  providerObjectId: string;
  observedFingerprint: string;
  bindingRevision: number;
  boundAt: number;
  updatedAt: number;
}

interface ResourceBindingRow {
  project_id: string;
  environment_id: string;
  resource_id: string;
  connection_id: string;
  provider_account: string;
  provider_object_id: string;
  observed_fingerprint: string;
  binding_revision: number;
  bound_at: number;
  updated_at: number;
}

const resourceBindingFromRow = (row: ResourceBindingRow): DeploymentResourceBinding => ({
  projectId: row.project_id,
  environmentId: row.environment_id,
  resourceId: row.resource_id,
  connectionId: row.connection_id,
  providerAccount: row.provider_account,
  providerObjectId: row.provider_object_id,
  observedFingerprint: row.observed_fingerprint,
  bindingRevision: row.binding_revision,
  boundAt: row.bound_at,
  updatedAt: row.updated_at,
});

export interface DeploymentArtifact {
  artifactId: string;
  producingRunId: string | null;
  provenance: "managed" | "external";
  projectId: string;
  kind: string;
  sourceRepository: string;
  githubArtifactId: string;
  producerRunId: string;
  commitSha: string;
  version: string;
  buildProfileDigest: string;
  payloadAlgorithm: string;
  payloadDigest: string;
  archiveDigest: string;
  providerLocator: JsonValue;
  provenanceUrl: string | null;
  createdAt: number;
  retainedUntil: number;
  tombstonedAt: number | null;
}

interface ArtifactRow {
  psm_artifact_id: string;
  producing_run_id: string | null;
  provenance: "managed" | "external";
  project_id: string;
  kind: string;
  source_repository: string;
  github_artifact_id: string;
  producer_run_id: string;
  commit_sha: string;
  version: string;
  build_profile_digest: string;
  payload_algorithm: string;
  payload_digest: string;
  archive_digest: string;
  provider_locator: string;
  provenance_url: string | null;
  created_at: number;
  retained_until: number;
  tombstoned_at: number | null;
}

const artifactFromRow = (row: ArtifactRow): DeploymentArtifact => ({
  artifactId: row.psm_artifact_id,
  producingRunId: row.producing_run_id,
  provenance: row.provenance,
  projectId: row.project_id,
  kind: row.kind,
  sourceRepository: row.source_repository,
  githubArtifactId: row.github_artifact_id,
  producerRunId: row.producer_run_id,
  commitSha: row.commit_sha,
  version: row.version,
  buildProfileDigest: row.build_profile_digest,
  payloadAlgorithm: row.payload_algorithm,
  payloadDigest: row.payload_digest,
  archiveDigest: row.archive_digest,
  providerLocator: fromJson(row.provider_locator),
  provenanceUrl: row.provenance_url,
  createdAt: row.created_at,
  retainedUntil: row.retained_until,
  tombstonedAt: row.tombstoned_at,
});

export interface DeploymentPlanAction {
  ordinal: number;
  actionId: string;
  actionDigest: string;
  kind: string;
  phase: string;
  sideEffecting: boolean;
  preconditions: JsonValue;
  document: JsonValue;
}

interface PlanActionRow {
  ordinal: number;
  action_id: string;
  action_digest: string;
  kind: string;
  phase: string;
  side_effecting: number;
  preconditions: string;
  immutable_document: string;
}

const actionFromRow = (row: PlanActionRow): DeploymentPlanAction => ({
  ordinal: row.ordinal,
  actionId: row.action_id,
  actionDigest: row.action_digest,
  kind: row.kind,
  phase: row.phase,
  sideEffecting: row.side_effecting !== 0,
  preconditions: fromJson(row.preconditions),
  document: fromJson(row.immutable_document),
});

export interface DeploymentPlan {
  planId: string;
  revision: number;
  digest: string;
  projectId: string;
  checkoutId: string;
  environmentId: string;
  operation: DeploymentOperation;
  risk: DeploymentRisk;
  manifestDigest: string;
  artifactId: string | null;
  requiredAcknowledgementIds: string[];
  blocked: boolean;
  document: JsonValue;
  createdAt: number;
  expiresAt: number;
  supersededAt: number | null;
  actions: DeploymentPlanAction[];
}

interface PlanRow {
  plan_id: string;
  revision: number;
  digest: string;
  project_id: string;
  checkout_id: string;
  environment_id: string;
  operation: DeploymentOperation;
  risk: DeploymentRisk;
  manifest_digest: string;
  psm_artifact_id: string | null;
  required_acknowledgements: string;
  blocked: number;
  immutable_document: string;
  created_at: number;
  expires_at: number;
  superseded_at: number | null;
}

export interface DeploymentApproval {
  approvalId: string;
  planId: string;
  planRevision: number;
  planDigest: string;
  risk: DeploymentRisk;
  actorKind: "local-operator" | "werewolf-user";
  actorSubject: string | null;
  agentId: string;
  origin: "local" | "paired";
  acknowledgementIds: string[];
  approvedAt: number;
  expiresAt: number;
  consumedAt: number;
}

interface ApprovalRow {
  approval_id: string;
  plan_id: string;
  plan_revision: number;
  plan_digest: string;
  risk: DeploymentRisk;
  actor_kind: "local-operator" | "werewolf-user";
  actor_subject: string | null;
  agent_id: string;
  origin: "local" | "paired";
  acknowledgement_ids: string;
  approved_at: number;
  expires_at: number;
  consumed_at: number;
}

const approvalFromRow = (row: ApprovalRow): DeploymentApproval => ({
  approvalId: row.approval_id,
  planId: row.plan_id,
  planRevision: row.plan_revision,
  planDigest: row.plan_digest,
  risk: row.risk,
  actorKind: row.actor_kind,
  actorSubject: row.actor_subject,
  agentId: row.agent_id,
  origin: row.origin,
  acknowledgementIds: fromJson<string[]>(row.acknowledgement_ids),
  approvedAt: row.approved_at,
  expiresAt: row.expires_at,
  consumedAt: row.consumed_at,
});

export interface DeploymentRun {
  runId: string;
  runKind: "prepare" | "deployment";
  projectId: string;
  environmentId: string | null;
  operation: "prepare" | DeploymentOperation;
  planId: string | null;
  planRevision: number | null;
  planDigest: string | null;
  approvalId: string | null;
  artifactRunId: string | null;
  state: DeploymentRunState;
  phase: string;
  auditDegraded: boolean;
  cancellationRequestedAt: number | null;
  recoveryReason: string | null;
  rawLogPath: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

interface RunRow {
  run_id: string;
  run_kind: "prepare" | "deployment";
  project_id: string;
  environment_id: string | null;
  operation: "prepare" | DeploymentOperation;
  plan_id: string | null;
  plan_revision: number | null;
  plan_digest: string | null;
  approval_id: string | null;
  artifact_run_id: string | null;
  state: DeploymentRunState;
  phase: string;
  audit_degraded: number;
  cancellation_requested_at: number | null;
  recovery_reason: string | null;
  raw_log_path: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

const runFromRow = (row: RunRow): DeploymentRun => ({
  runId: row.run_id,
  runKind: row.run_kind,
  projectId: row.project_id,
  environmentId: row.environment_id,
  operation: row.operation,
  planId: row.plan_id,
  planRevision: row.plan_revision,
  planDigest: row.plan_digest,
  approvalId: row.approval_id,
  artifactRunId: row.artifact_run_id,
  state: row.state,
  phase: row.phase,
  auditDegraded: row.audit_degraded !== 0,
  cancellationRequestedAt: row.cancellation_requested_at,
  recoveryReason: row.recovery_reason,
  rawLogPath: row.raw_log_path,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export interface DeploymentRunStep {
  runId: string;
  ordinal: number;
  stepId: string;
  actionDigest: string;
  adapterKind: string;
  idempotencyKey: string;
  state: DeploymentStepState;
  externalId: string | null;
  preconditions: JsonValue;
  intent: JsonValue;
  result: JsonValue | null;
  preparedAt: number;
  submittedAt: number | null;
  observedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

interface StepRow {
  run_id: string;
  ordinal: number;
  step_id: string;
  action_digest: string;
  adapter_kind: string;
  idempotency_key: string;
  state: DeploymentStepState;
  external_id: string | null;
  preconditions: string;
  intent: string;
  result: string | null;
  prepared_at: number;
  submitted_at: number | null;
  observed_at: number | null;
  completed_at: number | null;
  updated_at: number;
}

const stepFromRow = (row: StepRow): DeploymentRunStep => ({
  runId: row.run_id,
  ordinal: row.ordinal,
  stepId: row.step_id,
  actionDigest: row.action_digest,
  adapterKind: row.adapter_kind,
  idempotencyKey: row.idempotency_key,
  state: row.state,
  externalId: row.external_id,
  preconditions: fromJson(row.preconditions),
  intent: fromJson(row.intent),
  result: row.result === null ? null : fromJson(row.result),
  preparedAt: row.prepared_at,
  submittedAt: row.submitted_at,
  observedAt: row.observed_at,
  completedAt: row.completed_at,
  updatedAt: row.updated_at,
});

export interface DeploymentEvent {
  runId: string;
  sequence: number;
  at: number;
  type: string;
  phase: string;
  level: "info" | "warning" | "error";
  message: string;
  data: JsonValue;
}

interface EventRow {
  run_id: string;
  sequence: number;
  occurred_at: number;
  event_type: string;
  phase: string;
  level: "info" | "warning" | "error";
  message: string;
  payload: string;
}

const eventFromRow = (row: EventRow): DeploymentEvent => ({
  runId: row.run_id,
  sequence: row.sequence,
  at: row.occurred_at,
  type: row.event_type,
  phase: row.phase,
  level: row.level,
  message: row.message,
  data: fromJson(row.payload),
});

export interface DeploymentTargetLock {
  lockKey: string;
  ownerRunId: string;
  ownerBootId: string;
  acquiredAt: number;
  heartbeatAt: number;
  leaseExpiresAt: number;
}

interface LockRow {
  lock_key: string;
  owner_run_id: string;
  owner_boot_id: string;
  acquired_at: number;
  heartbeat_at: number;
  lease_expires_at: number;
}

const lockFromRow = (row: LockRow): DeploymentTargetLock => ({
  lockKey: row.lock_key,
  ownerRunId: row.owner_run_id,
  ownerBootId: row.owner_boot_id,
  acquiredAt: row.acquired_at,
  heartbeatAt: row.heartbeat_at,
  leaseExpiresAt: row.lease_expires_at,
});

export interface DeploymentRelease {
  releaseId: string;
  artifactId: string;
  activationRunId: string | null;
  targetId: string;
  projectId: string;
  environmentId: string;
  unitId: string;
  previousReleaseId: string | null;
  provenance: "managed" | "external";
  targetContractDigest: string;
  receipt: JsonValue;
  activatedAt: number;
  deactivatedAt: number | null;
  tombstonedAt: number | null;
}

interface ReleaseRow {
  release_id: string;
  psm_artifact_id: string;
  activation_run_id: string | null;
  target_id: string;
  project_id: string;
  environment_id: string;
  unit_id: string;
  previous_release_id: string | null;
  provenance: "managed" | "external";
  target_contract_digest: string;
  receipt: string;
  activated_at: number;
  deactivated_at: number | null;
  tombstoned_at: number | null;
}

const releaseFromRow = (row: ReleaseRow): DeploymentRelease => ({
  releaseId: row.release_id,
  artifactId: row.psm_artifact_id,
  activationRunId: row.activation_run_id,
  targetId: row.target_id,
  projectId: row.project_id,
  environmentId: row.environment_id,
  unitId: row.unit_id,
  previousReleaseId: row.previous_release_id,
  provenance: row.provenance,
  targetContractDigest: row.target_contract_digest,
  receipt: fromJson(row.receipt),
  activatedAt: row.activated_at,
  deactivatedAt: row.deactivated_at,
  tombstonedAt: row.tombstoned_at,
});

export interface DeploymentWatchSnapshot {
  monitorId: string;
  projectId: string;
  environmentId: string;
  unitId: string;
  providerState: string;
  freshness: "fresh" | "stale" | "missing";
  effectiveState: "healthy" | "down" | "degraded" | "unknown" | "stale" | "not-monitored";
  observedAt: number;
  ingestedAt: number;
  normalizedState: JsonValue;
}

interface WatchRow {
  monitor_id: string;
  project_id: string;
  environment_id: string;
  unit_id: string;
  provider_state: string;
  freshness: DeploymentWatchSnapshot["freshness"];
  effective_state: DeploymentWatchSnapshot["effectiveState"];
  observed_at: number;
  ingested_at: number;
  normalized_state: string;
}

const watchFromRow = (row: WatchRow): DeploymentWatchSnapshot => ({
  monitorId: row.monitor_id,
  projectId: row.project_id,
  environmentId: row.environment_id,
  unitId: row.unit_id,
  providerState: row.provider_state,
  freshness: row.freshness,
  effectiveState: row.effective_state,
  observedAt: row.observed_at,
  ingestedAt: row.ingested_at,
  normalizedState: fromJson(row.normalized_state),
});

const PLAN_SELECT = `SELECT plan_id, revision, digest, project_id, checkout_id, environment_id,
  operation, risk, manifest_digest, psm_artifact_id, required_acknowledgements, blocked,
  immutable_document, created_at, expires_at, superseded_at FROM deployment_plans`;
const RUN_SELECT = `SELECT run_id, run_kind, project_id, environment_id, operation, plan_id,
  plan_revision, plan_digest, approval_id, artifact_run_id, state, phase, audit_degraded,
  cancellation_requested_at, recovery_reason, raw_log_path, created_at, updated_at,
  started_at, finished_at FROM deployment_runs`;
const STEP_SELECT = `SELECT run_id, ordinal, step_id, action_digest, adapter_kind, idempotency_key,
  state, external_id, preconditions, intent, result, prepared_at, submitted_at, observed_at,
  completed_at, updated_at FROM deployment_run_steps`;
const RELEASE_SELECT = `SELECT release_id, psm_artifact_id, activation_run_id, target_id, project_id,
  environment_id, unit_id, previous_release_id, provenance, target_contract_digest, receipt,
  activated_at, deactivated_at, tombstoned_at FROM deployment_releases`;

export class DeploymentStore {
  #db: DatabaseSync | null;

  /** Tests pass a private handle; the server follows the shared lazy handle. */
  constructor(database: DatabaseSync | null = null) {
    this.#db = database;
  }

  private get database(): DatabaseSync {
    return this.#db ?? db();
  }

  cacheManifest(input: DeploymentManifestRecord): DeploymentManifestRecord {
    const manifest: DeploymentManifestRecord = {
      projectId: text(input.projectId, "project id"),
      checkoutId: text(input.checkoutId, "checkout id"),
      environmentId: text(input.environmentId, "environment id"),
      commitSha: text(input.commitSha, "commit SHA"),
      digest: text(input.digest, "manifest digest"),
      schemaVersion: integer(input.schemaVersion, "manifest schema version", 1),
      document: input.document,
      createdAt: integer(input.createdAt, "manifest creation time"),
    };
    const encoded = json(manifest.document, "manifest document");
    this.database
      .prepare(
        `INSERT OR IGNORE INTO deployment_manifests
         (project_id, checkout_id, environment_id, commit_sha, digest, schema_version, document, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        manifest.projectId,
        manifest.checkoutId,
        manifest.environmentId,
        manifest.commitSha,
        manifest.digest,
        manifest.schemaVersion,
        encoded,
        manifest.createdAt,
      );
    const stored = this.getManifest({
      projectId: manifest.projectId,
      checkoutId: manifest.checkoutId,
      environmentId: manifest.environmentId,
      commitSha: manifest.commitSha,
      digest: manifest.digest,
    });
    if (!stored || stored.schemaVersion !== manifest.schemaVersion || json(stored.document, "stored manifest") !== encoded) {
      throw new DeploymentConflictError("manifest digest/source tuple already has different bytes");
    }
    return stored;
  }

  getManifest(key: {
    projectId: string;
    checkoutId: string;
    environmentId: string;
    commitSha: string;
    digest: string;
  }): DeploymentManifestRecord | null {
    const row = this.database
      .prepare(
        `SELECT project_id, checkout_id, environment_id, commit_sha, digest, schema_version, document, created_at
         FROM deployment_manifests
         WHERE project_id = ? AND checkout_id = ? AND environment_id = ? AND commit_sha = ? AND digest = ?`,
      )
      .get(key.projectId, key.checkoutId, key.environmentId, key.commitSha, key.digest) as
      | ManifestRow
      | undefined;
    return row ? manifestFromRow(row) : null;
  }

  createConnection(input: Omit<DeploymentConnection, "metadataRevision" | "createdAt" | "updatedAt"> & {
    createdAt: number;
  }): DeploymentConnection {
    const now = integer(input.createdAt, "connection creation time");
    this.database
      .prepare(
        `INSERT INTO deployment_connections
         (connection_id, kind, label, metadata_revision, secret_generation, readiness, metadata,
          constraints_document, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        text(input.connectionId, "connection id"),
        text(input.kind, "connection kind"),
        text(input.label, "connection label"),
        integer(input.secretGeneration, "secret generation"),
        input.readiness,
        json(input.metadata, "connection metadata"),
        json(input.constraints, "connection constraints"),
        now,
        now,
      );
    return this.getConnection(input.connectionId);
  }

  /** The generation of a service's runtime secrets; 0 until one is first stored. */
  getServiceSecretGeneration(owner: string): number {
    const row = this.database
      .prepare("SELECT generation FROM deployment_service_secret_generations WHERE owner = ?")
      .get(text(owner, "secret owner")) as { generation: number } | undefined;
    return row?.generation ?? 0;
  }

  setServiceSecretGeneration(owner: string, generation: number, at: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("secret generation is invalid");
    this.database
      .prepare(`INSERT INTO deployment_service_secret_generations (owner, generation, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(owner) DO UPDATE SET generation = excluded.generation, updated_at = excluded.updated_at`)
      .run(text(owner, "secret owner"), generation, at);
  }

  getConnection(connectionId: string): DeploymentConnection {
    const row = this.database
      .prepare(
        `SELECT connection_id, kind, label, metadata_revision, secret_generation, readiness,
         metadata, constraints_document, created_at, updated_at
         FROM deployment_connections WHERE connection_id = ?`,
      )
      .get(text(connectionId, "connection id")) as ConnectionRow | undefined;
    if (!row) throw new DeploymentNotFoundError("connection not found");
    return connectionFromRow(row);
  }

  listConnections(): DeploymentConnection[] {
    return (
      this.database
        .prepare(
          `SELECT connection_id, kind, label, metadata_revision, secret_generation, readiness,
           metadata, constraints_document, created_at, updated_at
           FROM deployment_connections ORDER BY kind, label, connection_id`,
        )
        .all() as unknown as ConnectionRow[]
    ).map(connectionFromRow);
  }

  removeConnection(connectionId: string, expectedMetadataRevision: number): void {
    const id = text(connectionId, "connection id");
    transaction(this.database, () => {
      const references = this.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM deployment_connection_bindings WHERE connection_id = ?) +
             (SELECT COUNT(*) FROM deployment_resource_bindings WHERE connection_id = ?) AS count`,
        )
        .get(id, id) as { count: number };
      if (references.count) {
        throw new DeploymentConflictError("connection is still bound to deployment authority");
      }
      const result = this.database
        .prepare("DELETE FROM deployment_connections WHERE connection_id = ? AND metadata_revision = ?")
        .run(id, integer(expectedMetadataRevision, "expected metadata revision", 1));
      if (!result.changes) throw new DeploymentConflictError("connection revision changed or connection is absent");
    }, true);
  }

  /** Commit compatible shared-controller pins together, or leave all pins unchanged. */
  updateConnections(inputs: Array<Parameters<DeploymentStore["updateConnection"]>[0]>): DeploymentConnection[] {
    return transaction(this.database, () => inputs.map((input) => this.updateConnection(input)), true);
  }

  updateConnection(input: {
    connectionId: string;
    expectedMetadataRevision: number;
    label: string;
    readiness: ConnectionReadiness;
    metadata: JsonValue;
    constraints: JsonValue;
    secretGeneration: number;
    updatedAt: number;
  }): DeploymentConnection {
    const result = this.database
      .prepare(
        `UPDATE deployment_connections
         SET label = ?, readiness = ?, metadata = ?, constraints_document = ?, secret_generation = ?,
             metadata_revision = metadata_revision + 1, updated_at = ?
         WHERE connection_id = ? AND metadata_revision = ?`,
      )
      .run(
        text(input.label, "connection label"),
        input.readiness,
        json(input.metadata, "connection metadata"),
        json(input.constraints, "connection constraints"),
        integer(input.secretGeneration, "secret generation"),
        integer(input.updatedAt, "connection update time"),
        text(input.connectionId, "connection id"),
        integer(input.expectedMetadataRevision, "expected metadata revision", 1),
      );
    if (!result.changes) throw new DeploymentConflictError("connection revision changed");
    return this.getConnection(input.connectionId);
  }

  /**
   * Record keychain-backed secret rotation/deletion without pretending the
   * profile's public metadata changed. Both revisions are plan inputs, so
   * either compare-and-set still invalidates an older plan for the right reason.
   */
  updateConnectionSecretStatus(input: {
    connectionId: string;
    expectedSecretGeneration: number;
    /** Credential-cache refreshes must not overwrite a newer or invalid profile. */
    expectedMetadataRevision?: number;
    secretGeneration: number;
    readiness: ConnectionReadiness;
    updatedAt: number;
  }): DeploymentConnection {
    const expected = integer(input.expectedSecretGeneration, "expected secret generation");
    const next = integer(input.secretGeneration, "secret generation");
    if (next < expected) throw new DeploymentValidationError("secret generation cannot decrease");
    const result = this.database
      .prepare(
        `UPDATE deployment_connections SET secret_generation = ?, readiness = ?, updated_at = ?
         WHERE connection_id = ? AND secret_generation = ?
           AND (? IS NULL OR (metadata_revision = ? AND readiness != 'invalid'))`,
      )
      .run(
        next,
        input.readiness,
        integer(input.updatedAt, "connection secret update time"),
        text(input.connectionId, "connection id"),
        expected,
        input.expectedMetadataRevision ?? null,
        input.expectedMetadataRevision ?? null,
      );
    if (!result.changes) throw new DeploymentConflictError("connection secret generation changed");
    return this.getConnection(input.connectionId);
  }

  bindConnection(input: {
    projectId: string;
    checkoutId: string;
    environmentId: string;
    slot: string;
    connectionId: string;
    expectedRevision: number | null;
    at: number;
  }): DeploymentConnectionBinding {
    const key = [
      text(input.projectId, "project id"),
      text(input.checkoutId, "checkout id"),
      text(input.environmentId, "environment id"),
      text(input.slot, "connection slot"),
      text(input.connectionId, "connection id"),
    ] as const;
    const at = integer(input.at, "binding time");
    return transaction(this.database, () => {
      this.getConnection(key[4]);
      const existing = this.database
        .prepare(
          `SELECT project_id, checkout_id, environment_id, slot, connection_id, binding_revision,
           created_at, updated_at FROM deployment_connection_bindings
           WHERE checkout_id = ? AND environment_id = ? AND slot = ?`,
        )
        .get(key[1], key[2], key[3]) as ConnectionBindingRow | undefined;
      if (!existing) {
        if (input.expectedRevision !== null) throw new DeploymentConflictError("connection binding is absent");
        this.database
          .prepare(
            `INSERT INTO deployment_connection_bindings
             (project_id, checkout_id, environment_id, slot, connection_id, binding_revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(...key, at, at);
      } else {
        if (existing.project_id !== key[0]) {
          throw new DeploymentConflictError("checkout binding belongs to another project");
        }
        if (input.expectedRevision !== existing.binding_revision) {
          throw new DeploymentConflictError("connection binding revision changed");
        }
        this.database
          .prepare(
            `UPDATE deployment_connection_bindings
             SET connection_id = ?, binding_revision = binding_revision + 1, updated_at = ?
             WHERE checkout_id = ? AND environment_id = ? AND slot = ? AND binding_revision = ?`,
          )
          .run(key[4], at, key[1], key[2], key[3], existing.binding_revision);
      }
      return this.getConnectionBinding(key[1], key[2], key[3]);
    }, true);
  }

  getConnectionBinding(checkoutId: string, environmentId: string, slot: string): DeploymentConnectionBinding {
    const row = this.database
      .prepare(
        `SELECT project_id, checkout_id, environment_id, slot, connection_id, binding_revision,
         created_at, updated_at FROM deployment_connection_bindings
         WHERE checkout_id = ? AND environment_id = ? AND slot = ?`,
      )
      .get(checkoutId, environmentId, slot) as ConnectionBindingRow | undefined;
    if (!row) throw new DeploymentNotFoundError("connection binding not found");
    return connectionBindingFromRow(row);
  }

  listConnectionBindings(
    projectId: string,
    environmentId: string,
    checkoutId?: string,
  ): DeploymentConnectionBinding[] {
    const rows = checkoutId === undefined
      ? this.database
          .prepare(
            `SELECT project_id, checkout_id, environment_id, slot, connection_id, binding_revision,
             created_at, updated_at FROM deployment_connection_bindings
             WHERE project_id = ? AND environment_id = ? ORDER BY checkout_id, slot`,
          )
          .all(projectId, environmentId)
      : this.database
          .prepare(
            `SELECT project_id, checkout_id, environment_id, slot, connection_id, binding_revision,
             created_at, updated_at FROM deployment_connection_bindings
             WHERE project_id = ? AND environment_id = ? AND checkout_id = ? ORDER BY slot`,
          )
          .all(projectId, environmentId, checkoutId);
    return (rows as unknown as ConnectionBindingRow[]).map(connectionBindingFromRow);
  }

  appendPolicy(input: {
    scopeKind: DeploymentPolicyScope;
    scopeId: string;
    expectedRevision: number | null;
    document: JsonValue;
    createdAt: number;
  }): DeploymentPolicyRecord {
    return transaction(this.database, () => {
      const latest = this.latestPolicy(input.scopeKind, input.scopeId);
      const actual = latest?.revision ?? null;
      if (actual !== input.expectedRevision) throw new DeploymentConflictError("policy revision changed");
      const revision = (actual ?? 0) + 1;
      this.database
        .prepare(
          `INSERT INTO deployment_policies (scope_kind, scope_id, revision, document, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.scopeKind,
          text(input.scopeId, "policy scope id"),
          revision,
          json(input.document, "policy document"),
          integer(input.createdAt, "policy creation time"),
        );
      return this.latestPolicy(input.scopeKind, input.scopeId)!;
    }, true);
  }

  latestPolicy(scopeKind: DeploymentPolicyScope, scopeId: string): DeploymentPolicyRecord | null {
    const row = this.database
      .prepare(
        `SELECT scope_kind, scope_id, revision, document, created_at FROM deployment_policies
         WHERE scope_kind = ? AND scope_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(scopeKind, scopeId) as PolicyRow | undefined;
    return row ? policyFromRow(row) : null;
  }

  listLatestPolicies(): DeploymentPolicyRecord[] {
    return (
      this.database
        .prepare(
          `SELECT p.scope_kind, p.scope_id, p.revision, p.document, p.created_at
           FROM deployment_policies p
           WHERE p.revision = (SELECT MAX(n.revision) FROM deployment_policies n
             WHERE n.scope_kind = p.scope_kind AND n.scope_id = p.scope_id)
           ORDER BY p.scope_kind, p.scope_id`,
        )
        .all() as unknown as PolicyRow[]
    ).map(policyFromRow);
  }

  bindResource(input: Omit<DeploymentResourceBinding, "bindingRevision" | "boundAt" | "updatedAt"> & {
    expectedRevision: number | null;
    at: number;
  }): DeploymentResourceBinding {
    return transaction(this.database, () => {
      this.getConnection(input.connectionId);
      const existing = this.getResourceBinding(input.projectId, input.environmentId, input.resourceId);
      const at = integer(input.at, "resource binding time");
      if (!existing) {
        if (input.expectedRevision !== null) throw new DeploymentConflictError("resource binding is absent");
        this.database
          .prepare(
            `INSERT INTO deployment_resource_bindings
             (project_id, environment_id, resource_id, connection_id, provider_account,
              provider_object_id, observed_fingerprint, binding_revision, bound_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            text(input.projectId, "project id"),
            text(input.environmentId, "environment id"),
            text(input.resourceId, "resource id"),
            text(input.connectionId, "connection id"),
            text(input.providerAccount, "provider account"),
            text(input.providerObjectId, "provider object id"),
            text(input.observedFingerprint, "observed fingerprint"),
            at,
            at,
          );
      } else {
        if (existing.bindingRevision !== input.expectedRevision) {
          throw new DeploymentConflictError("resource binding revision changed");
        }
        const result = this.database
          .prepare(
            `UPDATE deployment_resource_bindings SET connection_id = ?, provider_account = ?,
             provider_object_id = ?, observed_fingerprint = ?, binding_revision = binding_revision + 1,
             updated_at = ?
             WHERE project_id = ? AND environment_id = ? AND resource_id = ? AND binding_revision = ?`,
          )
          .run(
            input.connectionId,
            input.providerAccount,
            input.providerObjectId,
            input.observedFingerprint,
            at,
            input.projectId,
            input.environmentId,
            input.resourceId,
            existing.bindingRevision,
          );
        if (!result.changes) throw new DeploymentConflictError("resource binding revision changed");
      }
      return this.getResourceBinding(input.projectId, input.environmentId, input.resourceId)!;
    }, true);
  }

  getResourceBinding(projectId: string, environmentId: string, resourceId: string): DeploymentResourceBinding | null {
    const row = this.database
      .prepare(
        `SELECT project_id, environment_id, resource_id, connection_id, provider_account,
         provider_object_id, observed_fingerprint, binding_revision, bound_at, updated_at
         FROM deployment_resource_bindings
         WHERE project_id = ? AND environment_id = ? AND resource_id = ?`,
      )
      .get(projectId, environmentId, resourceId) as ResourceBindingRow | undefined;
    return row ? resourceBindingFromRow(row) : null;
  }

  listResourceBindings(projectId: string, environmentId: string): DeploymentResourceBinding[] {
    return (
      this.database
        .prepare(
          `SELECT project_id, environment_id, resource_id, connection_id, provider_account,
           provider_object_id, observed_fingerprint, binding_revision, bound_at, updated_at
           FROM deployment_resource_bindings
           WHERE project_id = ? AND environment_id = ? ORDER BY resource_id`,
        )
        .all(projectId, environmentId) as unknown as ResourceBindingRow[]
    ).map(resourceBindingFromRow);
  }

  createPreparationRun(input: {
    runId?: string;
    projectId: string;
    environmentId?: string;
    rawLogPath?: string | null;
    createdAt: number;
  }): DeploymentRun {
    const runId = text(input.runId ?? generatedId("run"), "run id");
    const at = integer(input.createdAt, "run creation time");
    this.database
      .prepare(
        `INSERT INTO deployment_runs
         (run_id, run_kind, project_id, environment_id, operation, plan_id, plan_revision,
          plan_digest, approval_id, artifact_run_id, state, phase, audit_degraded,
          cancellation_requested_at, recovery_reason, raw_log_path, created_at, updated_at,
          started_at, finished_at)
         VALUES (?, 'prepare', ?, ?, 'prepare', NULL, NULL, NULL, NULL, NULL, 'queued',
          'queued', 0, NULL, NULL, ?, ?, ?, NULL, NULL)`,
      )
      .run(runId, text(input.projectId, "project id"), input.environmentId == null ? null : text(input.environmentId, "environment id"), input.rawLogPath ?? null, at, at);
    return this.getRun(runId);
  }

  recordArtifact(input: Omit<DeploymentArtifact, "tombstonedAt"> & { tombstonedAt?: null }): DeploymentArtifact {
    if (input.provenance === "managed" && !input.producingRunId) {
      throw new DeploymentValidationError("managed artifact needs a producing run");
    }
    if (input.provenance === "external" && input.producingRunId) {
      throw new DeploymentValidationError("external artifact cannot claim a PSM producing run");
    }
    if (input.producingRunId) {
      const run = this.getRun(input.producingRunId);
      if (run.runKind !== "prepare" || run.projectId !== input.projectId) {
        throw new DeploymentConflictError("artifact producing run belongs to another operation or project");
      }
    }
    this.database
      .prepare(
        `INSERT INTO deployment_artifacts
         (psm_artifact_id, producing_run_id, provenance, project_id, kind, source_repository,
          github_artifact_id, producer_run_id, commit_sha, version, build_profile_digest,
          payload_algorithm, payload_digest, archive_digest, provider_locator, provenance_url,
          created_at, retained_until, tombstoned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        text(input.artifactId, "artifact id"),
        input.producingRunId,
        input.provenance,
        text(input.projectId, "project id"),
        text(input.kind, "artifact kind"),
        text(input.sourceRepository, "source repository"),
        text(input.githubArtifactId, "GitHub artifact id"),
        text(input.producerRunId, "producer run id"),
        text(input.commitSha, "commit SHA"),
        text(input.version, "artifact version"),
        text(input.buildProfileDigest, "build profile digest"),
        text(input.payloadAlgorithm, "payload algorithm"),
        text(input.payloadDigest, "payload digest"),
        text(input.archiveDigest, "archive digest"),
        json(input.providerLocator, "provider locator"),
        input.provenanceUrl ?? null,
        integer(input.createdAt, "artifact creation time"),
        integer(input.retainedUntil, "artifact retention time"),
      );
    return this.getArtifact(input.artifactId);
  }

  getArtifact(artifactId: string): DeploymentArtifact {
    const row = this.database
      .prepare(
        `SELECT psm_artifact_id, producing_run_id, provenance, project_id, kind, source_repository,
         github_artifact_id, producer_run_id, commit_sha, version, build_profile_digest,
         payload_algorithm, payload_digest, archive_digest, provider_locator, provenance_url,
         created_at, retained_until, tombstoned_at
         FROM deployment_artifacts WHERE psm_artifact_id = ?`,
      )
      .get(text(artifactId, "artifact id")) as ArtifactRow | undefined;
    if (!row) throw new DeploymentNotFoundError("artifact not found");
    return artifactFromRow(row);
  }

  listArtifacts(filters: {
    projectId?: string;
    sourceRepository?: string;
    commitSha?: string;
    includeTombstoned?: boolean;
  } = {}): DeploymentArtifact[] {
    const conditions: string[] = [];
    const values: string[] = [];
    if (filters.projectId !== undefined) {
      conditions.push("project_id = ?");
      values.push(text(filters.projectId, "project id"));
    }
    if (filters.sourceRepository !== undefined) {
      conditions.push("source_repository = ?");
      values.push(text(filters.sourceRepository, "source repository"));
    }
    if (filters.commitSha !== undefined) {
      conditions.push("commit_sha = ?");
      values.push(text(filters.commitSha, "commit SHA"));
    }
    if (!filters.includeTombstoned) conditions.push("tombstoned_at IS NULL");
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    return (
      this.database
        .prepare(
          `SELECT psm_artifact_id, producing_run_id, provenance, project_id, kind, source_repository,
           github_artifact_id, producer_run_id, commit_sha, version, build_profile_digest,
           payload_algorithm, payload_digest, archive_digest, provider_locator, provenance_url,
           created_at, retained_until, tombstoned_at
           FROM deployment_artifacts${where}
           ORDER BY created_at DESC, rowid DESC`,
        )
        .all(...values) as unknown as ArtifactRow[]
    ).map(artifactFromRow);
  }

  tombstoneArtifact(artifactId: string, at: number): DeploymentArtifact {
    return transaction(this.database, () => {
      const artifact = this.getArtifact(artifactId);
      if (artifact.tombstonedAt === null) {
        const active = this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM deployment_releases
             WHERE psm_artifact_id = ? AND deactivated_at IS NULL AND tombstoned_at IS NULL`,
          )
          .get(artifact.artifactId) as { count: number };
        if (active.count) throw new DeploymentConflictError("active release artifact cannot be tombstoned");
        this.database
          .prepare("UPDATE deployment_artifacts SET tombstoned_at = ? WHERE psm_artifact_id = ?")
          .run(integer(at, "artifact tombstone time"), artifact.artifactId);
      }
      return this.getArtifact(artifact.artifactId);
    }, true);
  }

  createPlan(input: Omit<DeploymentPlan, "actions" | "supersededAt"> & {
    actions: readonly Omit<DeploymentPlanAction, "ordinal">[];
  }): DeploymentPlan {
    const createdAt = integer(input.createdAt, "plan creation time");
    const expiresAt = integer(input.expiresAt, "plan expiry time");
    if (expiresAt <= createdAt) throw new DeploymentValidationError("plan expiry must follow creation");
    const required = sortedUnique(input.requiredAcknowledgementIds, "acknowledgement id");
    if (input.artifactId) {
      const selectedArtifact = this.getArtifact(input.artifactId);
      if (selectedArtifact.projectId !== input.projectId) {
        throw new DeploymentConflictError("plan artifact belongs to another project");
      }
    }
    return transaction(this.database, () => {
      const latest = this.database
        .prepare("SELECT revision FROM deployment_plans WHERE plan_id = ? ORDER BY revision DESC LIMIT 1")
        .get(input.planId) as { revision: number } | undefined;
      const expectedRevision = (latest?.revision ?? 0) + 1;
      if (input.revision !== expectedRevision) {
        throw new DeploymentConflictError(`next plan revision is ${expectedRevision}`);
      }
      if (latest) {
        this.database
          .prepare("UPDATE deployment_plans SET superseded_at = ? WHERE plan_id = ? AND revision = ? AND superseded_at IS NULL")
          .run(createdAt, input.planId, latest.revision);
      }
      this.database
        .prepare(
          `INSERT INTO deployment_plans
           (plan_id, revision, digest, project_id, checkout_id, environment_id, operation, risk,
            manifest_digest, psm_artifact_id, required_acknowledgements, blocked,
            immutable_document, created_at, expires_at, superseded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          text(input.planId, "plan id"),
          integer(input.revision, "plan revision", 1),
          text(input.digest, "plan digest"),
          text(input.projectId, "project id"),
          text(input.checkoutId, "checkout id"),
          text(input.environmentId, "environment id"),
          input.operation,
          input.risk,
          text(input.manifestDigest, "manifest digest"),
          input.artifactId,
          json(required as JsonValue, "required acknowledgements"),
          input.blocked ? 1 : 0,
          json(input.document, "plan document"),
          createdAt,
          expiresAt,
        );
      const insertAction = this.database.prepare(
        `INSERT INTO deployment_plan_actions
         (plan_id, plan_revision, ordinal, action_id, action_digest, kind, phase,
          side_effecting, preconditions, immutable_document)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      input.actions.forEach((action, ordinal) => {
        insertAction.run(
          input.planId,
          input.revision,
          ordinal,
          text(action.actionId, "action id"),
          text(action.actionDigest, "action digest"),
          text(action.kind, "action kind"),
          text(action.phase, "action phase"),
          action.sideEffecting ? 1 : 0,
          json(action.preconditions, "action preconditions"),
          json(action.document, "action document"),
        );
      });
      return this.getPlan(input.planId, input.revision);
    }, true);
  }

  getPlan(planId: string, revision?: number): DeploymentPlan {
    const row = revision === undefined
      ? (this.database.prepare(`${PLAN_SELECT} WHERE plan_id = ? ORDER BY revision DESC LIMIT 1`).get(planId) as PlanRow | undefined)
      : (this.database.prepare(`${PLAN_SELECT} WHERE plan_id = ? AND revision = ?`).get(planId, revision) as PlanRow | undefined);
    if (!row) throw new DeploymentNotFoundError("deployment plan not found");
    const actions = (
      this.database
        .prepare(
          `SELECT ordinal, action_id, action_digest, kind, phase, side_effecting,
           preconditions, immutable_document FROM deployment_plan_actions
           WHERE plan_id = ? AND plan_revision = ? ORDER BY ordinal`,
        )
        .all(row.plan_id, row.revision) as unknown as PlanActionRow[]
    ).map(actionFromRow);
    return {
      planId: row.plan_id,
      revision: row.revision,
      digest: row.digest,
      projectId: row.project_id,
      checkoutId: row.checkout_id,
      environmentId: row.environment_id,
      operation: row.operation,
      risk: row.risk,
      manifestDigest: row.manifest_digest,
      artifactId: row.psm_artifact_id,
      requiredAcknowledgementIds: fromJson<string[]>(row.required_acknowledgements),
      blocked: row.blocked !== 0,
      document: fromJson(row.immutable_document),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      supersededAt: row.superseded_at,
      actions,
    };
  }

  /** Every durable preview, including blocked, expired and superseded revisions. */
  listPlans(projectId: string, environmentId?: string): DeploymentPlan[] {
    const rows = environmentId === undefined
      ? this.database
          .prepare(`${PLAN_SELECT} WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`)
          .all(projectId)
      : this.database
          .prepare(
            `${PLAN_SELECT} WHERE project_id = ? AND environment_id = ? ORDER BY created_at DESC, rowid DESC`,
          )
          .all(projectId, environmentId);
    return (rows as unknown as PlanRow[]).map((row) => this.getPlan(row.plan_id, row.revision));
  }

  approveAndQueue(input: {
    approvalId?: string;
    runId?: string;
    planId: string;
    planRevision: number;
    planDigest: string;
    risk: DeploymentRisk;
    actorKind: "local-operator" | "werewolf-user";
    actorSubject: string | null;
    agentId: string;
    origin: "local" | "paired";
    acknowledgementIds: readonly string[];
    approvedAt: number;
    expiresAt: number;
    rawLogPath?: string | null;
  }): { approval: DeploymentApproval; run: DeploymentRun; created: boolean } {
    const acknowledgements = sortedUnique(input.acknowledgementIds, "acknowledgement id");
    const approvedAt = integer(input.approvedAt, "approval time");
    const expiresAt = integer(input.expiresAt, "approval expiry time");
    return transaction(this.database, () => {
      const existing = this.database
        .prepare(
          `SELECT a.approval_id, a.plan_id, a.plan_revision, a.plan_digest, a.risk, a.actor_kind,
           a.actor_subject, a.agent_id, a.origin, a.acknowledgement_ids, a.approved_at,
           a.expires_at, a.consumed_at, r.run_id
           FROM deployment_approvals a JOIN deployment_runs r ON r.approval_id = a.approval_id
           WHERE a.plan_id = ? AND a.plan_revision = ? AND a.plan_digest = ?`,
        )
        .get(input.planId, input.planRevision, input.planDigest) as (ApprovalRow & { run_id: string }) | undefined;
      if (existing) {
        const approval = approvalFromRow(existing);
        if (
          approval.risk !== input.risk ||
          approval.actorKind !== input.actorKind ||
          approval.actorSubject !== input.actorSubject ||
          approval.agentId !== input.agentId ||
          approval.origin !== input.origin ||
          !sameStrings(approval.acknowledgementIds, acknowledgements)
        ) {
          throw new DeploymentConflictError("plan was already approved with different authority");
        }
        return { approval, run: this.getRun(existing.run_id), created: false };
      }

      const plan = this.getPlan(input.planId, input.planRevision);
      if (plan.digest !== input.planDigest) throw new DeploymentConflictError("plan digest changed");
      if (plan.supersededAt !== null) throw new DeploymentConflictError("plan was superseded");
      if (plan.blocked) throw new DeploymentConflictError("plan is blocked");
      if (plan.expiresAt <= approvedAt) throw new DeploymentConflictError("plan expired");
      if (expiresAt <= approvedAt || expiresAt > plan.expiresAt) {
        throw new DeploymentValidationError("approval expiry must be after approval and no later than the plan");
      }
      if (plan.risk !== input.risk) throw new DeploymentConflictError("approval risk does not match plan");
      if (!sameStrings(plan.requiredAcknowledgementIds, acknowledgements)) {
        throw new DeploymentConflictError("approval acknowledgements do not exactly match the plan");
      }
      if (input.actorKind === "werewolf-user" && !input.actorSubject) {
        throw new DeploymentValidationError("Werewolf approval needs an actor subject");
      }
      let artifactRunId: string | null = null;
      if (plan.artifactId) {
        const artifact = this.getArtifact(plan.artifactId);
        if (artifact.tombstonedAt !== null || artifact.retainedUntil <= approvedAt) {
          throw new DeploymentConflictError("artifact is no longer retained");
        }
        artifactRunId = artifact.producingRunId;
      }

      const approvalId = text(input.approvalId ?? generatedId("approval"), "approval id");
      const runId = text(input.runId ?? generatedId("run"), "run id");
      this.database
        .prepare(
          `INSERT INTO deployment_approvals
           (approval_id, plan_id, plan_revision, plan_digest, risk, actor_kind, actor_subject,
            agent_id, origin, acknowledgement_ids, approved_at, expires_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          approvalId,
          plan.planId,
          plan.revision,
          plan.digest,
          input.risk,
          input.actorKind,
          input.actorSubject,
          text(input.agentId, "agent id"),
          input.origin,
          json(acknowledgements as JsonValue, "approval acknowledgements"),
          approvedAt,
          expiresAt,
          approvedAt,
        );
      this.database
        .prepare(
          `INSERT INTO deployment_runs
           (run_id, run_kind, project_id, environment_id, operation, plan_id, plan_revision,
            plan_digest, approval_id, artifact_run_id, state, phase, audit_degraded,
            cancellation_requested_at, recovery_reason, raw_log_path, created_at, updated_at,
            started_at, finished_at)
           VALUES (?, 'deployment', ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', 0,
            NULL, NULL, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          runId,
          plan.projectId,
          plan.environmentId,
          plan.operation,
          plan.planId,
          plan.revision,
          plan.digest,
          approvalId,
          artifactRunId,
          input.rawLogPath ?? null,
          approvedAt,
          approvedAt,
        );

      const sideEffects = plan.actions.filter((action) => action.sideEffecting);
      const insertStep = this.database.prepare(
        `INSERT INTO deployment_run_steps
         (run_id, ordinal, step_id, action_digest, adapter_kind, idempotency_key, state,
          external_id, preconditions, intent, result, prepared_at, submitted_at, observed_at,
          completed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?, NULL, ?, NULL, NULL, NULL, ?)`,
      );
      sideEffects.forEach((action, ordinal) => {
        insertStep.run(
          runId,
          ordinal,
          action.actionId,
          action.actionDigest,
          action.kind,
          `deployment:${runId}:${action.actionId}`,
          json(action.preconditions, "step preconditions"),
          json(action.document, "step intent"),
          approvedAt,
          approvedAt,
        );
      });
      const approval = this.getApproval(approvalId);
      return { approval, run: this.getRun(runId), created: true };
    }, true);
  }

  getApproval(approvalId: string): DeploymentApproval {
    const row = this.database
      .prepare(
        `SELECT approval_id, plan_id, plan_revision, plan_digest, risk, actor_kind, actor_subject,
         agent_id, origin, acknowledgement_ids, approved_at, expires_at, consumed_at
         FROM deployment_approvals WHERE approval_id = ?`,
      )
      .get(approvalId) as ApprovalRow | undefined;
    if (!row) throw new DeploymentNotFoundError("approval not found");
    return approvalFromRow(row);
  }

  getRun(runId: string): DeploymentRun {
    const row = this.database.prepare(`${RUN_SELECT} WHERE run_id = ?`).get(runId) as RunRow | undefined;
    if (!row) throw new DeploymentNotFoundError("deployment run not found");
    return runFromRow(row);
  }

  listRuns(projectId: string, environmentId?: string): DeploymentRun[] {
    const rows = environmentId === undefined
      ? this.database.prepare(`${RUN_SELECT} WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`).all(projectId)
      : this.database.prepare(`${RUN_SELECT} WHERE project_id = ? AND environment_id = ? ORDER BY created_at DESC, rowid DESC`).all(projectId, environmentId);
    return (rows as unknown as RunRow[]).map(runFromRow);
  }

  /** Work a restarted process must classify or resume; terminal rows are excluded. */
  listStartupWork(): DeploymentRun[] {
    const terminal = [...TERMINAL_RUN_STATES];
    const placeholders = terminal.map(() => "?").join(", ");
    return (
      this.database
        .prepare(`${RUN_SELECT} WHERE state NOT IN (${placeholders}) ORDER BY created_at, rowid`)
        .all(...terminal) as unknown as RunRow[]
    ).map(runFromRow);
  }

  transitionRun(input: {
    runId: string;
    expectedStates: readonly DeploymentRunState[];
    state: DeploymentRunState;
    phase: string;
    at: number;
    recoveryReason?: string | null;
  }): DeploymentRun {
    const expected = [...new Set(input.expectedStates)];
    if (!expected.length) throw new DeploymentValidationError("a run transition needs an expected state");
    if (expected.some((state) => TERMINAL_RUN_STATES.has(state))) {
      throw new DeploymentTransitionError("terminal deployment runs cannot transition");
    }
    const at = integer(input.at, "run transition time");
    const terminalAt = TERMINAL_RUN_STATES.has(input.state) ? at : null;
    const placeholders = expected.map(() => "?").join(", ");
    const result = this.database
      .prepare(
        `UPDATE deployment_runs SET state = ?, phase = ?, recovery_reason = ?, updated_at = ?,
         started_at = CASE WHEN started_at IS NULL AND ? <> 'queued' THEN ? ELSE started_at END,
         finished_at = ?
         WHERE run_id = ? AND state IN (${placeholders}) AND updated_at <= ?`,
      )
      .run(
        input.state,
        text(input.phase, "run phase"),
        input.recoveryReason ?? null,
        at,
        input.state,
        at,
        terminalAt,
        text(input.runId, "run id"),
        ...expected,
        at,
      );
    if (!result.changes) throw new DeploymentTransitionError("run state changed before transition");
    return this.getRun(input.runId);
  }

  requestCancellation(runId: string, at: number): DeploymentRun {
    const run = this.getRun(runId);
    if (TERMINAL_RUN_STATES.has(run.state)) throw new DeploymentTransitionError("run is already terminal");
    this.database
      .prepare(
        `UPDATE deployment_runs SET cancellation_requested_at = COALESCE(cancellation_requested_at, ?),
         updated_at = MAX(updated_at, ?) WHERE run_id = ?`,
      )
      .run(integer(at, "cancellation time"), at, run.runId);
    return this.getRun(run.runId);
  }

  markAuditDegraded(runId: string, at: number): DeploymentRun {
    this.getRun(runId);
    this.database
      .prepare("UPDATE deployment_runs SET audit_degraded = 1, updated_at = MAX(updated_at, ?) WHERE run_id = ?")
      .run(integer(at, "audit degradation time"), runId);
    return this.getRun(runId);
  }

  listRunSteps(runId: string): DeploymentRunStep[] {
    this.getRun(runId);
    return (
      this.database.prepare(`${STEP_SELECT} WHERE run_id = ? ORDER BY ordinal`).all(runId) as unknown as StepRow[]
    ).map(stepFromRow);
  }

  transitionRunStep(input: {
    runId: string;
    ordinal: number;
    expectedState: DeploymentStepState;
    state: DeploymentStepState;
    at: number;
    externalId?: string | null;
    result?: JsonValue | null;
  }): DeploymentRunStep {
    if (!STEP_TRANSITIONS[input.expectedState].includes(input.state)) {
      throw new DeploymentTransitionError(`step cannot move from ${input.expectedState} to ${input.state}`);
    }
    const at = integer(input.at, "step transition time");
    const current = this.database
      .prepare(`${STEP_SELECT} WHERE run_id = ? AND ordinal = ?`)
      .get(input.runId, input.ordinal) as StepRow | undefined;
    if (!current) throw new DeploymentNotFoundError("deployment run step not found");
    if (current.state !== input.expectedState) throw new DeploymentTransitionError("step state changed before transition");
    const externalId = input.externalId === undefined ? current.external_id : input.externalId;
    const resultValue = input.result === undefined
      ? current.result
      : input.result === null ? null : json(input.result, "step result");
    const submittedAt = input.state === "submitted" ? at : current.submitted_at;
    const observedAt = input.state === "observed" || input.state === "recovery-required" ? at : current.observed_at;
    const completedAt = TERMINAL_STEP_STATES.has(input.state) ? at : current.completed_at;
    const changed = this.database
      .prepare(
        `UPDATE deployment_run_steps SET state = ?, external_id = ?, result = ?, submitted_at = ?,
         observed_at = ?, completed_at = ?, updated_at = ?
         WHERE run_id = ? AND ordinal = ? AND state = ? AND updated_at <= ?`,
      )
      .run(
        input.state,
        externalId,
        resultValue,
        submittedAt,
        observedAt,
        completedAt,
        at,
        input.runId,
        input.ordinal,
        input.expectedState,
        at,
      );
    if (!changed.changes) throw new DeploymentTransitionError("step state changed before transition");
    return stepFromRow(
      this.database.prepare(`${STEP_SELECT} WHERE run_id = ? AND ordinal = ?`).get(input.runId, input.ordinal) as unknown as StepRow,
    );
  }

  appendEvent(input: Omit<DeploymentEvent, "sequence">): DeploymentEvent {
    const runId = text(input.runId, "run id");
    const at = integer(input.at, "event time");
    return transaction(this.database, () => {
      this.getRun(runId);
      const row = this.database
        .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM deployment_events WHERE run_id = ?")
        .get(runId) as { sequence: number };
      const sequence = row.sequence;
      this.database
        .prepare(
          `INSERT INTO deployment_events
           (run_id, sequence, occurred_at, event_type, phase, level, message, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          sequence,
          at,
          text(input.type, "event type"),
          text(input.phase, "event phase"),
          input.level,
          text(input.message, "event message", MAX_MESSAGE),
          json(input.data, "event payload"),
        );
      return { ...input, runId, sequence, at };
    }, true);
  }

  listEvents(runId: string, afterSequence = 0, limit = 500): DeploymentEvent[] {
    const bounded = Math.min(integer(limit, "event limit", 1), MAX_EVENTS_PAGE);
    return (
      this.database
        .prepare(
          `SELECT run_id, sequence, occurred_at, event_type, phase, level, message, payload
           FROM deployment_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
        )
        .all(runId, integer(afterSequence, "event cursor"), bounded) as unknown as EventRow[]
    ).map(eventFromRow);
  }

  claimTargetLocks(input: {
    runId: string;
    bootId: string;
    lockKeys: readonly string[];
    now: number;
    leaseExpiresAt: number;
  }): { acquired: true; locks: DeploymentTargetLock[] } | {
    acquired: false;
    contended: DeploymentTargetLock[];
    expired: DeploymentTargetLock[];
  } {
    const keys = sortedUnique(input.lockKeys, "lock key");
    const now = integer(input.now, "lock claim time");
    const lease = integer(input.leaseExpiresAt, "lock lease expiry");
    if (lease <= now) throw new DeploymentValidationError("lock lease must expire in the future");
    return transaction(this.database, () => {
      const run = this.getRun(input.runId);
      if (TERMINAL_RUN_STATES.has(run.state)) throw new DeploymentConflictError("terminal run cannot own locks");
      if (!keys.length) return { acquired: true, locks: [] };
      const select = this.database.prepare(
        `SELECT lock_key, owner_run_id, owner_boot_id, acquired_at, heartbeat_at, lease_expires_at
         FROM deployment_target_locks WHERE lock_key = ?`,
      );
      const present = keys
        .map((key) => select.get(key) as LockRow | undefined)
        .filter((row): row is LockRow => Boolean(row))
        .map(lockFromRow);
      const contended = present.filter(
        (lock) => lock.ownerRunId !== input.runId || lock.ownerBootId !== input.bootId,
      );
      if (contended.length) {
        return { acquired: false, contended, expired: contended.filter((lock) => lock.leaseExpiresAt <= now) };
      }
      const insert = this.database.prepare(
        `INSERT INTO deployment_target_locks
         (lock_key, owner_run_id, owner_boot_id, acquired_at, heartbeat_at, lease_expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (lock_key) DO UPDATE SET heartbeat_at = excluded.heartbeat_at,
           lease_expires_at = excluded.lease_expires_at
         WHERE deployment_target_locks.owner_run_id = excluded.owner_run_id
           AND deployment_target_locks.owner_boot_id = excluded.owner_boot_id`,
      );
      keys.forEach((key) => insert.run(key, input.runId, text(input.bootId, "boot id"), now, now, lease));
      return { acquired: true, locks: this.locksForRun(input.runId) };
    }, true);
  }

  /**
   * Transfer one expired lease only after the recovery worker has observed the
   * affected target. `observedAt` is deliberately part of the compare-and-set:
   * callers cannot use ordinary acquisition to steal an expired lease.
   */
  recoverExpiredTargetLock(input: {
    lockKey: string;
    expectedOwnerRunId: string;
    expectedOwnerBootId: string;
    newOwnerRunId: string;
    newOwnerBootId: string;
    observedAt: number;
    leaseExpiresAt: number;
  }): DeploymentTargetLock {
    const observedAt = integer(input.observedAt, "recovery observation time");
    const lease = integer(input.leaseExpiresAt, "recovered lock expiry");
    if (lease <= observedAt) throw new DeploymentValidationError("recovered lease must expire after observation");
    return transaction(this.database, () => {
      const nextRun = this.getRun(input.newOwnerRunId);
      if (TERMINAL_RUN_STATES.has(nextRun.state)) throw new DeploymentConflictError("terminal run cannot recover a lock");
      const result = this.database
        .prepare(
          `UPDATE deployment_target_locks SET owner_run_id = ?, owner_boot_id = ?, acquired_at = ?,
           heartbeat_at = ?, lease_expires_at = ?
           WHERE lock_key = ? AND owner_run_id = ? AND owner_boot_id = ? AND lease_expires_at <= ?`,
        )
        .run(
          input.newOwnerRunId,
          text(input.newOwnerBootId, "new boot id"),
          observedAt,
          observedAt,
          lease,
          text(input.lockKey, "lock key"),
          text(input.expectedOwnerRunId, "expected lock owner"),
          text(input.expectedOwnerBootId, "expected owner boot id"),
          observedAt,
        );
      if (!result.changes) throw new DeploymentConflictError("expired lock ownership changed or was not observed after expiry");
      return this.getTargetLock(input.lockKey)!;
    }, true);
  }

  heartbeatTargetLocks(input: {
    runId: string;
    bootId: string;
    lockKeys: readonly string[];
    now: number;
    leaseExpiresAt: number;
  }): DeploymentTargetLock[] {
    const keys = sortedUnique(input.lockKeys, "lock key");
    const now = integer(input.now, "lock heartbeat time");
    const lease = integer(input.leaseExpiresAt, "lock lease expiry");
    if (lease <= now) throw new DeploymentValidationError("lock lease must expire in the future");
    return transaction(this.database, () => {
      const update = this.database.prepare(
        `UPDATE deployment_target_locks SET heartbeat_at = ?, lease_expires_at = ?
         WHERE lock_key = ? AND owner_run_id = ? AND owner_boot_id = ?`,
      );
      for (const key of keys) {
        if (!update.run(now, lease, key, input.runId, input.bootId).changes) {
          throw new DeploymentConflictError(`lock ownership changed: ${key}`);
        }
      }
      return this.locksForRun(input.runId);
    }, true);
  }

  releaseTargetLocks(runId: string, bootId: string): number {
    return transaction(this.database, () => {
      const run = this.getRun(runId);
      if (!TERMINAL_RUN_STATES.has(run.state)) {
        throw new DeploymentConflictError("run must be durably terminal before releasing locks");
      }
      return Number(
        this.database
          .prepare("DELETE FROM deployment_target_locks WHERE owner_run_id = ? AND owner_boot_id = ?")
          .run(runId, bootId).changes,
      );
    }, true);
  }

  getTargetLock(lockKey: string): DeploymentTargetLock | null {
    const row = this.database
      .prepare(
        `SELECT lock_key, owner_run_id, owner_boot_id, acquired_at, heartbeat_at, lease_expires_at
         FROM deployment_target_locks WHERE lock_key = ?`,
      )
      .get(lockKey) as LockRow | undefined;
    return row ? lockFromRow(row) : null;
  }

  locksForRun(runId: string): DeploymentTargetLock[] {
    return (
      this.database
        .prepare(
          `SELECT lock_key, owner_run_id, owner_boot_id, acquired_at, heartbeat_at, lease_expires_at
           FROM deployment_target_locks WHERE owner_run_id = ? ORDER BY lock_key`,
        )
        .all(runId) as unknown as LockRow[]
    ).map(lockFromRow);
  }

  listExpiredTargetLocks(now: number): DeploymentTargetLock[] {
    return (
      this.database
        .prepare(
          `SELECT lock_key, owner_run_id, owner_boot_id, acquired_at, heartbeat_at, lease_expires_at
           FROM deployment_target_locks WHERE lease_expires_at <= ? ORDER BY lock_key`,
        )
        .all(integer(now, "lock expiry observation time")) as unknown as LockRow[]
    ).map(lockFromRow);
  }

  activateRelease(input: Omit<DeploymentRelease, "previousReleaseId" | "deactivatedAt" | "tombstonedAt"> & {
    expectedCurrentReleaseId: string | null;
  }): DeploymentRelease {
    return transaction(this.database, () => {
      const artifact = this.getArtifact(input.artifactId);
      if (artifact.tombstonedAt !== null) throw new DeploymentConflictError("release artifact is tombstoned");
      if (artifact.projectId !== input.projectId) {
        throw new DeploymentConflictError("release artifact belongs to another project");
      }
      if (input.provenance === "managed" && !input.activationRunId) {
        throw new DeploymentValidationError("managed release needs an activation run");
      }
      if (input.provenance === "external" && input.activationRunId) {
        throw new DeploymentValidationError("external release cannot claim a PSM activation run");
      }
      const current = this.getActiveRelease(input.targetId);
      if ((current?.releaseId ?? null) !== input.expectedCurrentReleaseId) {
        throw new DeploymentConflictError("active release changed");
      }
      const at = integer(input.activatedAt, "release activation time");
      const retained = this.database
        .prepare(`${RELEASE_SELECT} WHERE release_id = ?`)
        .get(input.releaseId) as ReleaseRow | undefined;
      if (retained && retained.tombstoned_at !== null) {
        throw new DeploymentConflictError("release is tombstoned");
      }
      if (
        retained &&
        (retained.target_id !== input.targetId ||
          retained.psm_artifact_id !== input.artifactId ||
          retained.project_id !== input.projectId ||
          retained.environment_id !== input.environmentId ||
          retained.unit_id !== input.unitId)
      ) {
        throw new DeploymentConflictError("release identity already names another target, unit or artifact");
      }
      if (current?.releaseId === input.releaseId) {
        // Re-observing an activation after a lost response is idempotent. Never
        // turn it into a self-referential rollback edge or rewrite its receipt.
        return current;
      }
      if (current) {
        this.database
          .prepare("UPDATE deployment_releases SET deactivated_at = ? WHERE release_id = ? AND deactivated_at IS NULL")
          .run(at, current.releaseId);
      }
      if (retained) {
        this.database
          .prepare(
            `UPDATE deployment_releases SET activation_run_id = ?, previous_release_id = ?,
             provenance = ?, target_contract_digest = ?, receipt = ?, activated_at = ?, deactivated_at = NULL
             WHERE release_id = ? AND tombstoned_at IS NULL`,
          )
          .run(
            input.activationRunId,
            current?.releaseId ?? null,
            input.provenance,
            input.targetContractDigest,
            json(input.receipt, "release receipt"),
            at,
            input.releaseId,
          );
      } else {
        this.database
          .prepare(
            `INSERT INTO deployment_releases
             (release_id, psm_artifact_id, activation_run_id, target_id, project_id, environment_id,
              unit_id, previous_release_id, provenance, target_contract_digest, receipt,
              activated_at, deactivated_at, tombstoned_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
          )
          .run(
            text(input.releaseId, "release id"),
            input.artifactId,
            input.activationRunId,
            text(input.targetId, "target id"),
            text(input.projectId, "project id"),
            text(input.environmentId, "environment id"),
            text(input.unitId, "unit id"),
            current?.releaseId ?? null,
            input.provenance,
            text(input.targetContractDigest, "target contract digest"),
            json(input.receipt, "release receipt"),
            at,
          );
      }
      return this.getActiveRelease(input.targetId)!;
    }, true);
  }

  /**
   * A release recorded as active but unverified (its controller failed after
   * activation) takes the receipt of the run that later verified it. Only that
   * unverified receipt is ever replaced.
   */
  verifyActiveRelease(input: { releaseId: string; targetId: string; activationRunId: string; receipt: JsonValue }): boolean {
    const result = this.database
      .prepare(
        `UPDATE deployment_releases SET activation_run_id = ?, receipt = ?
         WHERE release_id = ? AND target_id = ? AND deactivated_at IS NULL AND tombstoned_at IS NULL
           AND json_extract(receipt, '$.verified') = 0`,
      )
      .run(text(input.activationRunId, "activation run id"), json(input.receipt, "release receipt"), text(input.releaseId, "release id"), text(input.targetId, "target id"));
    return result.changes === 1;
  }

  getActiveRelease(targetId: string): DeploymentRelease | null {
    const row = this.database
      .prepare(`${RELEASE_SELECT} WHERE target_id = ? AND deactivated_at IS NULL AND tombstoned_at IS NULL`)
      .get(targetId) as ReleaseRow | undefined;
    return row ? releaseFromRow(row) : null;
  }

  listActiveUnverifiedReleases(): DeploymentRelease[] {
    const rows = this.database.prepare(
      `${RELEASE_SELECT} WHERE deactivated_at IS NULL AND tombstoned_at IS NULL
       AND json_extract(receipt, '$.verified') = 0`,
    ).all() as unknown as ReleaseRow[];
    return rows.map(releaseFromRow);
  }

  listReleases(targetId: string): DeploymentRelease[] {
    return (
      this.database
        .prepare(`${RELEASE_SELECT} WHERE target_id = ? ORDER BY activated_at DESC, rowid DESC`)
        .all(targetId) as unknown as ReleaseRow[]
    ).map(releaseFromRow);
  }

  tombstoneRelease(releaseId: string, at: number): DeploymentRelease {
    const row = this.database.prepare(`${RELEASE_SELECT} WHERE release_id = ?`).get(releaseId) as ReleaseRow | undefined;
    if (!row) throw new DeploymentNotFoundError("release not found");
    if (row.deactivated_at === null) throw new DeploymentConflictError("active release cannot be tombstoned");
    this.database
      .prepare("UPDATE deployment_releases SET tombstoned_at = COALESCE(tombstoned_at, ?) WHERE release_id = ?")
      .run(integer(at, "release tombstone time"), releaseId);
    return releaseFromRow(
      this.database.prepare(`${RELEASE_SELECT} WHERE release_id = ?`).get(releaseId) as unknown as ReleaseRow,
    );
  }

  putWatchSnapshot(input: DeploymentWatchSnapshot): DeploymentWatchSnapshot {
    const observedAt = integer(input.observedAt, "watch observation time");
    const ingestedAt = integer(input.ingestedAt, "watch ingestion time");
    if (ingestedAt < observedAt) throw new DeploymentValidationError("watch ingestion cannot predate observation");
    this.database
      .prepare(
        `INSERT INTO deployment_watch_snapshots
         (monitor_id, project_id, environment_id, unit_id, provider_state, freshness,
          effective_state, observed_at, ingested_at, normalized_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (monitor_id, environment_id, unit_id) DO UPDATE SET
           project_id = excluded.project_id, provider_state = excluded.provider_state,
           freshness = excluded.freshness, effective_state = excluded.effective_state,
           observed_at = excluded.observed_at, ingested_at = excluded.ingested_at,
           normalized_state = excluded.normalized_state
         WHERE excluded.observed_at >= deployment_watch_snapshots.observed_at`,
      )
      .run(
        text(input.monitorId, "monitor id"),
        text(input.projectId, "project id"),
        text(input.environmentId, "environment id"),
        text(input.unitId, "unit id"),
        text(input.providerState, "provider state"),
        input.freshness,
        input.effectiveState,
        observedAt,
        ingestedAt,
        json(input.normalizedState, "normalized watch state"),
      );
    return this.getWatchSnapshot(input.monitorId, input.environmentId, input.unitId)!;
  }

  getWatchSnapshot(monitorId: string, environmentId: string, unitId: string): DeploymentWatchSnapshot | null {
    const row = this.database
      .prepare(
        `SELECT monitor_id, project_id, environment_id, unit_id, provider_state, freshness,
         effective_state, observed_at, ingested_at, normalized_state
         FROM deployment_watch_snapshots WHERE monitor_id = ? AND environment_id = ? AND unit_id = ?`,
      )
      .get(monitorId, environmentId, unitId) as WatchRow | undefined;
    return row ? watchFromRow(row) : null;
  }
}

export const deploymentStore = new DeploymentStore();
