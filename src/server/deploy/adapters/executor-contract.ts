import { canonicalDigest, canonicalJson, type CanonicalJson } from "../canonical.ts";

export const PREPARE_ARTIFACT_RESULT_SCHEMA =
  "psm.werewolf.solutions/prepare-artifact-result/v1" as const;
export const RELEASE_EXECUTION_CONTRACT_SCHEMA =
  "psm.werewolf.solutions/static-release-execution/v1" as const;
export const STATIC_RELEASE_RESULT_SCHEMA =
  "psm.werewolf.solutions/static-release-result/v1" as const;
export const STATIC_PAYLOAD_ALGORITHM = "psm-static-tree-sha256@1" as const;

export interface StaticPayloadLimits {
  maxFiles: number;
  maxPathBytes: number;
  maxFileBytes: number;
  maxUnpackedBytes: number;
}

export interface PrepareArtifactDispatch {
  repository: string;
  workflow: string;
  ref: string;
  psmRunId: string;
  psmArtifactId: string;
  projectId: string;
  environmentId: string;
  unitId: string;
  commitSha: string;
  manifestDigest: string;
  buildProfile: CanonicalJson;
  buildProfileDigest: string;
}

export interface PreparedArtifactIdentity {
  psmArtifactId: string;
  githubArtifactId: string;
  producerRunId: string;
  sourceRepository: string;
  commitSha: string;
  /** The host helper refuses a release without one, so it is approved, not looked up later. */
  version: string;
  payloadAlgorithm: typeof STATIC_PAYLOAD_ALGORITHM;
  payloadLimits: StaticPayloadLimits;
  payloadDigest: string;
  archiveDigest: string;
}

export interface ExpectedReleaseIdentity {
  releaseId: string;
  payloadDigest: string;
}

export interface ExecutorHttpStatusProbe {
  id: string;
  kind: "http-status@1";
  url: string;
  method: "GET" | "HEAD";
  expectedStatuses: number[];
  timeoutMs: number;
}

export interface ExecutorReleaseMetadataProbe {
  id: string;
  kind: "release-metadata@1";
  url: string;
  expectedCommitSha: string;
  expectedPsmArtifactId: string;
  timeoutMs: number;
}

export type ExecutorProbe = ExecutorHttpStatusProbe | ExecutorReleaseMetadataProbe;

/**
 * The only document handed to the secret-bearing controller workflow.
 *
 * Deliberately absent: SSH hosts, filesystem paths, keys, credentials and shell
 * text. The controller Environment and its pinned target contract own those.
 */
export interface StaticReleaseExecutionContract {
  schema: typeof RELEASE_EXECUTION_CONTRACT_SCHEMA;
  operation: "deploy" | "release" | "rollback";
  projectId: string;
  environmentId: string;
  unitId: string;
  target: {
    id: string;
    fingerprint: string;
    contractRevision: string;
  };
  artifact: PreparedArtifactIdentity;
  expectedCurrentRelease: ExpectedReleaseIdentity | null;
  intendedRelease: ExpectedReleaseIdentity;
  plan: {
    digest: string;
    expiresAt: string;
  };
  conditionalRollback: {
    allowed: boolean;
    previousReleaseId: string | null;
  };
  pm2: {
    invariant: "unchanged";
    snapshotDigest: string;
  };
  probes: ExecutorProbe[];
}

export interface ReleaseControllerDispatch {
  controller: "werewolf-static@1";
  psmRunId: string;
  projectId: string;
  environmentId: string;
  unitId: string;
  releaseId: string;
  targetId: string;
  planDigest: string;
  planExpiresAt: string;
  artifact: PreparedArtifactIdentity;
  executionContract: StaticReleaseExecutionContract;
  executionContractDigest: string;
}

export interface PrepareArtifactResult {
  schema: typeof PREPARE_ARTIFACT_RESULT_SCHEMA;
  psmRunId: string;
  psmArtifactId: string;
  projectId: string;
  environmentId: string;
  unitId: string;
  sourceRepository: string;
  producerRunId: string;
  githubArtifactId: string;
  commitSha: string;
  version: string;
  manifestDigest: string;
  buildProfileDigest: string;
  payloadAlgorithm: typeof STATIC_PAYLOAD_ALGORITHM;
  payloadLimits: StaticPayloadLimits;
  payloadDigest: string;
  archiveDigest: string;
  retainedUntil: string;
}

export interface ReleaseVerificationResult {
  id: string;
  state: "passed" | "failed";
  code: string;
}

export interface StaticReleaseResult {
  schema: typeof STATIC_RELEASE_RESULT_SCHEMA;
  psmRunId: string;
  projectId: string;
  environmentId: string;
  unitId: string;
  releaseId: string;
  previousReleaseId: string | null;
  planDigest: string;
  executionContractDigest: string;
  controllerRepository: string;
  controllerWorkflow: string;
  controllerRef: string;
  controllerCommitSha: string;
  providerRunId: string;
  targetId: string;
  targetFingerprint: string;
  targetContractRevision: string;
  psmArtifactId: string;
  githubArtifactId: string;
  producerRunId: string;
  payloadAlgorithm: typeof STATIC_PAYLOAD_ALGORITHM;
  payloadDigest: string;
  archiveDigest: string;
  state: "activated" | "rolled-back" | "failed";
  activatedAt: string | null;
  verification: ReleaseVerificationResult[];
}

export class ExecutorContractError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "ExecutorContractError";
    this.field = field;
  }
}

const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/;
const WORKFLOW_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.ya?ml$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const PROVIDER_ID_RE = /^[1-9]\d{0,30}$/;

function fail(field: string, message: string): never {
  throw new ExecutorContractError(field, message);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(field, "must be a plain object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  field: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${field}.${key}`, "is required");
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${field}.${key}`, "is not allowed");
  }
}

function text(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(field, `must be 1-${max} characters without control characters`);
  }
  return value;
}

function id(value: unknown, field: string): string {
  const output = text(value, field, 200);
  if (!ID_RE.test(output) || output.includes("..")) fail(field, "has an invalid identifier format");
  return output;
}

export function validateRepository(value: unknown, field = "repository"): string {
  const output = text(value, field, 201);
  if (!REPOSITORY_RE.test(output) || output.endsWith(".git")) fail(field, "must be an owner/repository name");
  return output;
}

export function validateWorkflow(value: unknown, field = "workflow"): string {
  const output = text(value, field, 132);
  if (!WORKFLOW_RE.test(output)) fail(field, "must be an exact .yml or .yaml filename");
  return output;
}

export function validateCommitSha(value: unknown, field = "commitSha"): string {
  const output = text(value, field, 64);
  if (!SHA_RE.test(output)) fail(field, "must be a full lowercase Git object ID");
  return output;
}

export function validateDigest(value: unknown, field: string): string {
  const output = text(value, field, 71);
  if (!DIGEST_RE.test(output)) fail(field, "must be a lowercase sha256 digest");
  return output;
}

export function validateProviderId(value: unknown, field: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) fail(field, "must be a positive safe integer");
    return String(value);
  }
  const output = text(value, field, 31);
  if (!PROVIDER_ID_RE.test(output)) fail(field, "must be a positive decimal provider ID");
  return output;
}

function releaseVersion(value: unknown, field: string): string {
  const output = text(value, field, 64);
  if (!VERSION_RE.test(output)) fail(field, "must be X.Y.Z");
  return output;
}

function timestamp(value: unknown, field: string, fractionalDigits: 3 | 9 = 3): string {
  const output = text(value, field, 40);
  const format = fractionalDigits === 9
    ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  if (!format.test(output) || !Number.isFinite(Date.parse(output))) {
    fail(field, "must be a UTC ISO-8601 timestamp");
  }
  return output;
}

function positiveInteger(value: unknown, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) {
    fail(field, `must be an integer between 1 and ${max}`);
  }
  return value as number;
}

function parsePayloadLimits(value: unknown, field: string): StaticPayloadLimits {
  const input = record(value, field);
  exactKeys(input, field, ["maxFiles", "maxPathBytes", "maxFileBytes", "maxUnpackedBytes"]);
  return {
    maxFiles: positiveInteger(input.maxFiles, `${field}.maxFiles`, 1_000_000),
    maxPathBytes: positiveInteger(input.maxPathBytes, `${field}.maxPathBytes`, 16_384),
    maxFileBytes: positiveInteger(input.maxFileBytes, `${field}.maxFileBytes`, 16 * 1024 ** 3),
    maxUnpackedBytes: positiveInteger(
      input.maxUnpackedBytes,
      `${field}.maxUnpackedBytes`,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function validatePublicUrl(value: unknown, field: string): string {
  const output = text(value, field, 2048);
  let parsed: URL;
  try {
    parsed = new URL(output);
  } catch {
    fail(field, "must be an absolute URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    fail(field, "must be an HTTPS URL without credentials or a fragment");
  }
  return output;
}

function parseArtifactIdentity(value: unknown, field: string): PreparedArtifactIdentity {
  const input = record(value, field);
  exactKeys(input, field, [
    "psmArtifactId",
    "githubArtifactId",
    "producerRunId",
    "sourceRepository",
    "commitSha",
    "version",
    "payloadAlgorithm",
    "payloadLimits",
    "payloadDigest",
    "archiveDigest",
  ]);
  if (input.payloadAlgorithm !== STATIC_PAYLOAD_ALGORITHM) {
    fail(`${field}.payloadAlgorithm`, `must be ${STATIC_PAYLOAD_ALGORITHM}`);
  }
  return {
    psmArtifactId: id(input.psmArtifactId, `${field}.psmArtifactId`),
    githubArtifactId: validateProviderId(input.githubArtifactId, `${field}.githubArtifactId`),
    producerRunId: validateProviderId(input.producerRunId, `${field}.producerRunId`),
    sourceRepository: validateRepository(input.sourceRepository, `${field}.sourceRepository`),
    commitSha: validateCommitSha(input.commitSha, `${field}.commitSha`),
    version: releaseVersion(input.version, `${field}.version`),
    payloadAlgorithm: STATIC_PAYLOAD_ALGORITHM,
    payloadLimits: parsePayloadLimits(input.payloadLimits, `${field}.payloadLimits`),
    payloadDigest: validateDigest(input.payloadDigest, `${field}.payloadDigest`),
    archiveDigest: validateDigest(input.archiveDigest, `${field}.archiveDigest`),
  };
}

function equalJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function prepareDispatchInputs(input: PrepareArtifactDispatch): Record<string, string> {
  validateRepository(input.repository);
  validateWorkflow(input.workflow);
  text(input.ref, "ref", 256);
  id(input.psmRunId, "psmRunId");
  id(input.psmArtifactId, "psmArtifactId");
  id(input.projectId, "projectId");
  id(input.environmentId, "environmentId");
  id(input.unitId, "unitId");
  validateCommitSha(input.commitSha);
  validateDigest(input.manifestDigest, "manifestDigest");
  validateDigest(input.buildProfileDigest, "buildProfileDigest");
  const buildProfileJson = canonicalJson(input.buildProfile);
  if (Buffer.byteLength(buildProfileJson, "utf8") > 16 * 1024) {
    fail("buildProfile", "canonical JSON exceeds 16384 bytes");
  }
  return {
    psm_run_id: input.psmRunId,
    psm_artifact_id: input.psmArtifactId,
    project_id: input.projectId,
    environment_id: input.environmentId,
    unit_id: input.unitId,
    commit_sha: input.commitSha,
    manifest_digest: input.manifestDigest,
    build_profile_json: buildProfileJson,
    build_profile_digest: input.buildProfileDigest,
  };
}

function parseProbe(value: unknown, field: string): ExecutorProbe {
  const input = record(value, field);
  const kind = input.kind;
  if (kind === "http-status@1") {
    exactKeys(input, field, ["id", "kind", "url", "method", "expectedStatuses", "timeoutMs"]);
    if (input.method !== "GET" && input.method !== "HEAD") fail(`${field}.method`, "must be GET or HEAD");
    if (!Array.isArray(input.expectedStatuses) || input.expectedStatuses.length === 0 || input.expectedStatuses.length > 16) {
      fail(`${field}.expectedStatuses`, "must contain 1-16 HTTP statuses");
    }
    const expectedStatuses = input.expectedStatuses.map((status, index) =>
      positiveInteger(status, `${field}.expectedStatuses[${index}]`, 599)
    );
    if (expectedStatuses.some((status) => status < 100) || new Set(expectedStatuses).size !== expectedStatuses.length) {
      fail(`${field}.expectedStatuses`, "must contain unique statuses from 100 through 599");
    }
    return {
      id: id(input.id, `${field}.id`),
      kind,
      url: validatePublicUrl(input.url, `${field}.url`),
      method: input.method,
      expectedStatuses,
      timeoutMs: positiveInteger(input.timeoutMs, `${field}.timeoutMs`, 60_000),
    };
  }
  if (kind === "release-metadata@1") {
    exactKeys(input, field, [
      "id", "kind", "url", "expectedCommitSha", "expectedPsmArtifactId", "timeoutMs",
    ]);
    return {
      id: id(input.id, `${field}.id`),
      kind,
      url: validatePublicUrl(input.url, `${field}.url`),
      expectedCommitSha: validateCommitSha(input.expectedCommitSha, `${field}.expectedCommitSha`),
      expectedPsmArtifactId: id(input.expectedPsmArtifactId, `${field}.expectedPsmArtifactId`),
      timeoutMs: positiveInteger(input.timeoutMs, `${field}.timeoutMs`, 60_000),
    };
  }
  fail(`${field}.kind`, "is not a supported executor probe");
}

export function parseStaticReleaseExecutionContract(
  value: unknown,
): StaticReleaseExecutionContract {
  const input = record(value, "executionContract");
  exactKeys(input, "executionContract", [
    "schema",
    "operation",
    "projectId",
    "environmentId",
    "unitId",
    "target",
    "artifact",
    "expectedCurrentRelease",
    "intendedRelease",
    "plan",
    "conditionalRollback",
    "pm2",
    "probes",
  ]);
  if (input.schema !== RELEASE_EXECUTION_CONTRACT_SCHEMA) {
    fail("executionContract.schema", `must be ${RELEASE_EXECUTION_CONTRACT_SCHEMA}`);
  }
  if (input.operation !== "deploy" && input.operation !== "release" && input.operation !== "rollback") {
    fail("executionContract.operation", "must be deploy, release or rollback");
  }

  const target = record(input.target, "executionContract.target");
  exactKeys(target, "executionContract.target", ["id", "fingerprint", "contractRevision"]);
  const intended = record(input.intendedRelease, "executionContract.intendedRelease");
  exactKeys(intended, "executionContract.intendedRelease", ["releaseId", "payloadDigest"]);
  let expectedCurrentRelease: ExpectedReleaseIdentity | null = null;
  if (input.expectedCurrentRelease !== null) {
    const expected = record(input.expectedCurrentRelease, "executionContract.expectedCurrentRelease");
    exactKeys(expected, "executionContract.expectedCurrentRelease", ["releaseId", "payloadDigest"]);
    expectedCurrentRelease = {
      releaseId: id(expected.releaseId, "executionContract.expectedCurrentRelease.releaseId"),
      payloadDigest: validateDigest(
        expected.payloadDigest,
        "executionContract.expectedCurrentRelease.payloadDigest",
      ),
    };
  }
  const plan = record(input.plan, "executionContract.plan");
  exactKeys(plan, "executionContract.plan", ["digest", "expiresAt"]);
  const conditionalRollback = record(
    input.conditionalRollback,
    "executionContract.conditionalRollback",
  );
  exactKeys(conditionalRollback, "executionContract.conditionalRollback", [
    "allowed", "previousReleaseId",
  ]);
  if (typeof conditionalRollback.allowed !== "boolean") {
    fail("executionContract.conditionalRollback.allowed", "must be boolean");
  }
  const previousReleaseId = conditionalRollback.previousReleaseId === null
    ? null
    : id(
      conditionalRollback.previousReleaseId,
      "executionContract.conditionalRollback.previousReleaseId",
    );
  if (conditionalRollback.allowed !== (previousReleaseId !== null)) {
    fail(
      "executionContract.conditionalRollback",
      "allowed must be true exactly when a previous release is authorized",
    );
  }
  const pm2 = record(input.pm2, "executionContract.pm2");
  exactKeys(pm2, "executionContract.pm2", ["invariant", "snapshotDigest"]);
  if (pm2.invariant !== "unchanged") fail("executionContract.pm2.invariant", "must be unchanged");
  if (!Array.isArray(input.probes) || input.probes.length > 32) {
    fail("executionContract.probes", "must be an array with at most 32 probes");
  }
  const probes = input.probes.map((probe, index) => parseProbe(probe, `executionContract.probes[${index}]`));
  if (new Set(probes.map((probe) => probe.id)).size !== probes.length) {
    fail("executionContract.probes", "probe IDs must be unique");
  }
  return {
    schema: RELEASE_EXECUTION_CONTRACT_SCHEMA,
    operation: input.operation,
    projectId: id(input.projectId, "executionContract.projectId"),
    environmentId: id(input.environmentId, "executionContract.environmentId"),
    unitId: id(input.unitId, "executionContract.unitId"),
    target: {
      id: id(target.id, "executionContract.target.id"),
      fingerprint: validateDigest(target.fingerprint, "executionContract.target.fingerprint"),
      contractRevision: id(target.contractRevision, "executionContract.target.contractRevision"),
    },
    artifact: parseArtifactIdentity(input.artifact, "executionContract.artifact"),
    expectedCurrentRelease,
    intendedRelease: {
      releaseId: id(intended.releaseId, "executionContract.intendedRelease.releaseId"),
      payloadDigest: validateDigest(
        intended.payloadDigest,
        "executionContract.intendedRelease.payloadDigest",
      ),
    },
    plan: {
      digest: validateDigest(plan.digest, "executionContract.plan.digest"),
      expiresAt: timestamp(plan.expiresAt, "executionContract.plan.expiresAt"),
    },
    conditionalRollback: { allowed: conditionalRollback.allowed, previousReleaseId },
    pm2: {
      invariant: "unchanged",
      snapshotDigest: validateDigest(pm2.snapshotDigest, "executionContract.pm2.snapshotDigest"),
    },
    probes,
  };
}

export function releaseExecutionContractDigest(value: StaticReleaseExecutionContract): string {
  const parsed = parseStaticReleaseExecutionContract(value);
  return canonicalDigest(RELEASE_EXECUTION_CONTRACT_SCHEMA, parsed);
}

export function releaseDispatchInputs(input: ReleaseControllerDispatch): Record<string, string> {
  if (input.controller !== "werewolf-static@1") fail("controller", "is not supported");
  id(input.psmRunId, "psmRunId");
  id(input.projectId, "projectId");
  id(input.environmentId, "environmentId");
  id(input.unitId, "unitId");
  id(input.releaseId, "releaseId");
  id(input.targetId, "targetId");
  validateDigest(input.planDigest, "planDigest");
  timestamp(input.planExpiresAt, "planExpiresAt");
  const artifact = parseArtifactIdentity(input.artifact, "artifact");
  const contract = parseStaticReleaseExecutionContract(input.executionContract);
  const contractDigest = releaseExecutionContractDigest(contract);
  if (input.executionContractDigest !== contractDigest) {
    fail("executionContractDigest", "does not match the canonical execution contract");
  }
  const comparisons: Array<[unknown, unknown, string]> = [
    [contract.projectId, input.projectId, "projectId"],
    [contract.environmentId, input.environmentId, "environmentId"],
    [contract.unitId, input.unitId, "unitId"],
    [contract.target.id, input.targetId, "targetId"],
    [contract.intendedRelease.releaseId, input.releaseId, "releaseId"],
    [contract.intendedRelease.payloadDigest, artifact.payloadDigest, "artifact.payloadDigest"],
    [contract.plan.digest, input.planDigest, "planDigest"],
    [contract.plan.expiresAt, input.planExpiresAt, "planExpiresAt"],
  ];
  for (const [left, right, field] of comparisons) {
    if (left !== right) fail(field, "does not match the execution contract");
  }
  if (!equalJson(contract.artifact, artifact)) {
    fail("artifact", "does not match the execution contract artifact");
  }
  const contractJson = canonicalJson(contract);
  if (Buffer.byteLength(contractJson, "utf8") > 48 * 1024) {
    fail("executionContract", "canonical JSON exceeds 49152 bytes");
  }
  return {
    psm_run_id: input.psmRunId,
    project_id: input.projectId,
    environment_id: input.environmentId,
    unit_id: input.unitId,
    operation: contract.operation,
    source_repository: artifact.sourceRepository,
    psm_artifact_id: artifact.psmArtifactId,
    github_artifact_id: artifact.githubArtifactId,
    producer_run_id: artifact.producerRunId,
    payload_algorithm: artifact.payloadAlgorithm,
    payload_digest: artifact.payloadDigest,
    archive_digest: artifact.archiveDigest,
    commit_sha: artifact.commitSha,
    version: artifact.version,
    plan_digest: input.planDigest,
    plan_expires_at: input.planExpiresAt,
    release_id: input.releaseId,
    target_id: input.targetId,
    execution_contract_json: contractJson,
    execution_contract_digest: contractDigest,
  };
}

const PREPARE_RESULT_WIRE_KEYS = {
  schema: "schema", psmRunId: "psm_run_id", psmArtifactId: "psm_artifact_id",
  projectId: "project_id", environmentId: "environment_id", unitId: "unit_id",
  sourceRepository: "source_repository", producerRunId: "producer_run_id", githubArtifactId: "github_artifact_id",
  commitSha: "commit_sha", version: "version", manifestDigest: "manifest_digest",
  buildProfileDigest: "build_profile_digest", payloadAlgorithm: "payload_algorithm", payloadLimits: "payload_limits",
  payloadDigest: "payload_digest", archiveDigest: "archive_digest", retainedUntil: "retained_until",
} as const satisfies Record<keyof PrepareArtifactResult, string>;

export function parsePrepareArtifactResult(value: unknown): PrepareArtifactResult {
  let input = record(value, "result");
  // Published Todo workflows emitted the complete camelCase record under v1.
  // Accept that exact legacy shape, never field-by-field aliases or defaults.
  // Both shapes then pass the same schema, value and downstream identity checks.
  if (!Object.hasOwn(input, "psm_run_id") && Object.hasOwn(input, "psmRunId")) {
    exactKeys(input, "result", Object.keys(PREPARE_RESULT_WIRE_KEYS));
    input = Object.fromEntries(Object.entries(PREPARE_RESULT_WIRE_KEYS).map(([local, wire]) => [wire, input[local]]));
  }
  exactKeys(input, "result", Object.values(PREPARE_RESULT_WIRE_KEYS));
  if (input.schema !== PREPARE_ARTIFACT_RESULT_SCHEMA) {
    fail("result.schema", `must be ${PREPARE_ARTIFACT_RESULT_SCHEMA}`);
  }
  if (input.payload_algorithm !== STATIC_PAYLOAD_ALGORITHM) {
    fail("result.payload_algorithm", `must be ${STATIC_PAYLOAD_ALGORITHM}`);
  }
  const version = releaseVersion(input.version, "result.version");
  return {
    schema: PREPARE_ARTIFACT_RESULT_SCHEMA,
    psmRunId: id(input.psm_run_id, "result.psm_run_id"),
    psmArtifactId: id(input.psm_artifact_id, "result.psm_artifact_id"),
    projectId: id(input.project_id, "result.project_id"),
    environmentId: id(input.environment_id, "result.environment_id"),
    unitId: id(input.unit_id, "result.unit_id"),
    sourceRepository: validateRepository(input.source_repository, "result.source_repository"),
    producerRunId: validateProviderId(input.producer_run_id, "result.producer_run_id"),
    githubArtifactId: validateProviderId(input.github_artifact_id, "result.github_artifact_id"),
    commitSha: validateCommitSha(input.commit_sha, "result.commit_sha"),
    version,
    manifestDigest: validateDigest(input.manifest_digest, "result.manifest_digest"),
    buildProfileDigest: validateDigest(input.build_profile_digest, "result.build_profile_digest"),
    payloadAlgorithm: STATIC_PAYLOAD_ALGORITHM,
    payloadLimits: parsePayloadLimits(input.payload_limits, "result.payload_limits"),
    payloadDigest: validateDigest(input.payload_digest, "result.payload_digest"),
    archiveDigest: validateDigest(input.archive_digest, "result.archive_digest"),
    retainedUntil: timestamp(input.retained_until, "result.retained_until"),
  };
}

export function parseStaticReleaseResult(value: unknown): StaticReleaseResult {
  const input = record(value, "result");
  exactKeys(input, "result", [
    "schema", "psm_run_id", "project_id", "environment_id", "unit_id", "release_id",
    "previous_release_id", "plan_digest", "execution_contract_digest", "controller_repository",
    "controller_workflow", "controller_ref", "controller_commit_sha", "provider_run_id", "target_id",
    "target_fingerprint", "target_contract_revision", "psm_artifact_id", "github_artifact_id",
    "producer_run_id", "payload_algorithm", "payload_digest", "archive_digest", "state",
    "activated_at", "verification",
  ]);
  if (input.schema !== STATIC_RELEASE_RESULT_SCHEMA) {
    fail("result.schema", `must be ${STATIC_RELEASE_RESULT_SCHEMA}`);
  }
  if (input.payload_algorithm !== STATIC_PAYLOAD_ALGORITHM) {
    fail("result.payload_algorithm", `must be ${STATIC_PAYLOAD_ALGORITHM}`);
  }
  if (input.state !== "activated" && input.state !== "rolled-back" && input.state !== "failed") {
    fail("result.state", "must be activated, rolled-back or failed");
  }
  if (!Array.isArray(input.verification) || input.verification.length > 64) {
    fail("result.verification", "must be an array with at most 64 entries");
  }
  const verification = input.verification.map((item, index): ReleaseVerificationResult => {
    const check = record(item, `result.verification[${index}]`);
    exactKeys(check, `result.verification[${index}]`, ["id", "state", "code"]);
    if (check.state !== "passed" && check.state !== "failed") {
      fail(`result.verification[${index}].state`, "must be passed or failed");
    }
    return {
      id: id(check.id, `result.verification[${index}].id`),
      state: check.state,
      code: id(check.code, `result.verification[${index}].code`),
    };
  });
  return {
    schema: STATIC_RELEASE_RESULT_SCHEMA,
    psmRunId: id(input.psm_run_id, "result.psm_run_id"),
    projectId: id(input.project_id, "result.project_id"),
    environmentId: id(input.environment_id, "result.environment_id"),
    unitId: id(input.unit_id, "result.unit_id"),
    releaseId: id(input.release_id, "result.release_id"),
    previousReleaseId: input.previous_release_id === null
      ? null
      : id(input.previous_release_id, "result.previous_release_id"),
    planDigest: validateDigest(input.plan_digest, "result.plan_digest"),
    executionContractDigest: validateDigest(
      input.execution_contract_digest,
      "result.execution_contract_digest",
    ),
    controllerRepository: validateRepository(
      input.controller_repository,
      "result.controller_repository",
    ),
    controllerWorkflow: validateWorkflow(input.controller_workflow, "result.controller_workflow"),
    controllerRef: text(input.controller_ref, "result.controller_ref", 256),
    controllerCommitSha: validateCommitSha(
      input.controller_commit_sha,
      "result.controller_commit_sha",
    ),
    providerRunId: validateProviderId(input.provider_run_id, "result.provider_run_id"),
    targetId: id(input.target_id, "result.target_id"),
    targetFingerprint: validateDigest(input.target_fingerprint, "result.target_fingerprint"),
    targetContractRevision: id(
      input.target_contract_revision,
      "result.target_contract_revision",
    ),
    psmArtifactId: id(input.psm_artifact_id, "result.psm_artifact_id"),
    githubArtifactId: validateProviderId(input.github_artifact_id, "result.github_artifact_id"),
    producerRunId: validateProviderId(input.producer_run_id, "result.producer_run_id"),
    payloadAlgorithm: STATIC_PAYLOAD_ALGORITHM,
    payloadDigest: validateDigest(input.payload_digest, "result.payload_digest"),
    archiveDigest: validateDigest(input.archive_digest, "result.archive_digest"),
    state: input.state,
    activatedAt: input.activated_at === null
      ? null
      : timestamp(input.activated_at, "result.activated_at", 9),
    verification,
  };
}
