import { sealedBox } from "../sealed-box.ts";
import {
  ExecutorContractError,
  parsePrepareArtifactResult,
  parseStaticReleaseResult,
  prepareDispatchInputs,
  releaseDispatchInputs,
  type PrepareArtifactDispatch,
  type PrepareArtifactResult,
  type ReleaseControllerDispatch,
  type StaticReleaseResult,
  validateCommitSha,
  validateDigest,
  validateProviderId,
  validateRepository,
  validateWorkflow,
} from "./executor-contract.ts";
import { unzipSync } from "fflate";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_API_VERSION = "2026-03-10";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_JSON_BYTES = 512 * 1024;
const MAX_TIMEOUT_MS = 60_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_MESSAGE = 512;
const MAX_RESULT_ARTIFACT_BYTES = 2 * 1024 * 1024;

export interface GitHubWorkflowRefPolicy {
  /** Exact branch, tag, protected ref or immutable ref accepted for dispatch. */
  ref: string;
  /** Optional metadata pin; dispatch still observes and requires the requested exact commit. */
  expectedHeadSha?: string;
  expectedWorkflowBlobSha?: string;
}

export interface GitHubPrepareWorkflowPolicy {
  repository: string;
  workflow: string;
  workflowPath: string;
  refs: readonly GitHubWorkflowRefPolicy[];
}

export interface GitHubReleaseControllerPolicy {
  controller: "werewolf-static@1";
  targetId: string;
  repository: string;
  workflow: string;
  workflowPath: string;
  ref: string;
  expectedHeadSha: string;
  expectedWorkflowBlobSha: string;
  githubEnvironment: string;
  allowedSourceRepositories: readonly string[];
}

/** Server-owned, non-secret connection metadata. Project manifests cannot widen it. */
export interface GitHubActionsConnectionMetadata {
  revision: string | number;
  apiBaseUrl?: string;
  apiVersion?: string;
  requestTimeoutMs?: number;
  maxJsonResponseBytes?: number;
  prepareWorkflows: readonly GitHubPrepareWorkflowPolicy[];
  releaseControllers: readonly GitHubReleaseControllerPolicy[];
}

export interface GitHubActionsAdapterOptions {
  metadata: GitHubActionsConnectionMetadata;
  /** Resolves the Actions token just in time; the adapter never retains or returns it. */
  token: () => string | Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
}

export type GitHubExecutorErrorCode =
  | "github-config-invalid"
  | "github-target-not-allowed"
  | "github-contract-invalid"
  | "github-request-timeout"
  | "github-response-too-large"
  | "github-response-invalid"
  | "github-api-error"
  | "github-run-not-found"
  | "github-run-ambiguous"
  | "github-run-mismatch"
  | "artifact-integrity";

export class GitHubExecutorError extends Error {
  readonly code: GitHubExecutorErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(
    code: GitHubExecutorErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GitHubExecutorError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}

export interface WorkflowTrustObservation {
  repository: string;
  workflow: string;
  workflowPath: string;
  ref: string;
  headSha: string;
  workflowBlobSha: string;
}

export interface GitHubDispatchReceipt {
  schema: "psm.werewolf.solutions/github-dispatch-receipt/v1";
  policyRevision: string;
  operation: "prepare" | "release";
  repository: string;
  workflow: string;
  workflowPath: string;
  ref: string;
  expectedHeadSha: string;
  workflowBlobSha: string;
  psmRunId: string;
  dispatchedAt: string;
  providerRunId: string | null;
  controller: "werewolf-static@1" | null;
  targetId: string | null;
  githubEnvironment: string | null;
}

export type GitHubRunProviderStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "waiting"
  | "pending"
  | "requested";

export type GitHubRunConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "stale"
  | "success"
  | "timed_out"
  | null;

export interface GitHubRunObservation {
  providerRunId: string;
  repository: string;
  workflow: string;
  ref: string;
  headSha: string;
  displayTitle: string;
  status: "queued" | "waiting" | "in-progress" | "completed";
  providerStatus: GitHubRunProviderStatus;
  conclusion: GitHubRunConclusion;
  runAttempt: number;
  createdAt: string;
  updatedAt: string;
  provenanceUrl: string;
}

export interface GitHubPollResult {
  receipt: GitHubDispatchReceipt;
  run: GitHubRunObservation | null;
}

export interface GitHubCancelResult extends GitHubPollResult {
  requested: boolean;
}

export interface ImportedPrepareArtifact extends PrepareArtifactResult {
  provider: {
    repository: string;
    runId: string;
    artifactId: string;
    artifactName: string;
    sizeInBytes: number;
    expiresAt: string;
    provenanceUrl: string;
  };
}

interface ValidatedMetadata {
  revision: string;
  apiBaseUrl: string;
  apiVersion: string;
  requestTimeoutMs: number;
  maxJsonResponseBytes: number;
  prepareWorkflows: GitHubPrepareWorkflowPolicy[];
  releaseControllers: GitHubReleaseControllerPolicy[];
}

interface WorkflowTarget {
  repository: string;
  workflow: string;
  workflowPath: string;
  ref: string;
  expectedWorkflowBlobSha?: string;
}

interface RequestResult {
  status: number;
  body: unknown;
}

const WORKFLOW_PATH_RE = /^\.github\/workflows\/([A-Za-z0-9][A-Za-z0-9._-]{0,127}\.ya?ml)$/;
const REF_FORBIDDEN_RE = /[\u0000-\u0020\u007f~^:?*\[\\]/;
const GIT_OBJECT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PROVIDER_STATUSES = new Set<GitHubRunProviderStatus>([
  "queued", "in_progress", "completed", "waiting", "pending", "requested",
]);
const CONCLUSIONS = new Set<Exclude<GitHubRunConclusion, null>>([
  "action_required", "cancelled", "failure", "neutral", "skipped", "stale", "success", "timed_out",
]);

function configError(field: string, message: string): never {
  throw new GitHubExecutorError("github-config-invalid", `${field}: ${message}`);
}

function boundedText(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    configError(field, `must be 1-${max} characters without control characters`);
  }
  return value;
}

function identifier(value: unknown, field: string): string {
  const output = boundedText(value, field, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(output) || output.includes("..")) {
    configError(field, "has an invalid identifier format");
  }
  return output;
}

function workflowPath(value: unknown, workflow: string, field: string): string {
  const output = boundedText(value, field, 160);
  const match = WORKFLOW_PATH_RE.exec(output);
  if (!match || match[1] !== workflow) {
    configError(field, `must be exactly .github/workflows/${workflow}`);
  }
  return output;
}

function gitRef(value: unknown, field: string): string {
  const output = boundedText(value, field, 256);
  if (
    REF_FORBIDDEN_RE.test(output)
    || output.startsWith("/")
    || output.endsWith("/")
    || output.startsWith(".")
    || output.endsWith(".")
    || output.includes("..")
    || output.includes("//")
    || output.includes("@{")
    || output.endsWith(".lock")
  ) {
    configError(field, "is not a safe exact Git ref");
  }
  return output;
}

function gitObjectId(value: unknown, field: string): string {
  const output = boundedText(value, field, 64);
  if (!GIT_OBJECT_RE.test(output)) configError(field, "must be a full lowercase Git object ID");
  return output;
}

function apiBase(value: unknown): string {
  const output = value === undefined ? DEFAULT_API_BASE_URL : boundedText(value, "apiBaseUrl", 2048);
  let url: URL;
  try {
    url = new URL(output);
  } catch {
    configError("apiBaseUrl", "must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    configError("apiBaseUrl", "must be HTTPS and contain no credentials, query or fragment");
  }
  return url.href.replace(/\/$/, "");
}

function positiveInteger(
  value: unknown,
  field: string,
  defaultValue: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    configError(field, `must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

function policyRevision(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) configError("revision", "must be a non-negative integer");
    return String(value);
  }
  return boundedText(value, "revision", 128);
}

function validateMetadata(metadata: GitHubActionsConnectionMetadata): ValidatedMetadata {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    configError("metadata", "must be an object");
  }
  const apiVersion = metadata.apiVersion ?? DEFAULT_API_VERSION;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(apiVersion)) {
    configError("apiVersion", "must be a version date in YYYY-MM-DD form");
  }
  if (!Array.isArray(metadata.prepareWorkflows) || !Array.isArray(metadata.releaseControllers)) {
    configError("metadata", "must contain prepareWorkflows and releaseControllers arrays");
  }
  const prepareWorkflows = metadata.prepareWorkflows.map((entry, index) => {
    let repository: string;
    let workflow: string;
    try {
      repository = validateRepository(entry.repository, `prepareWorkflows[${index}].repository`);
      workflow = validateWorkflow(entry.workflow, `prepareWorkflows[${index}].workflow`);
    } catch (error) {
      if (error instanceof ExecutorContractError) configError(error.field, error.message.split(": ").slice(1).join(": "));
      throw error;
    }
    if (!Array.isArray(entry.refs) || entry.refs.length === 0) {
      configError(`prepareWorkflows[${index}].refs`, "must contain at least one exact ref");
    }
    const refs = entry.refs.map((ref: GitHubWorkflowRefPolicy, refIndex: number) => ({
      ref: gitRef(ref.ref, `prepareWorkflows[${index}].refs[${refIndex}].ref`),
      ...(ref.expectedHeadSha === undefined ? {} : {
        expectedHeadSha: gitObjectId(
          ref.expectedHeadSha,
          `prepareWorkflows[${index}].refs[${refIndex}].expectedHeadSha`,
        ),
      }),
      ...(ref.expectedWorkflowBlobSha === undefined ? {} : {
        expectedWorkflowBlobSha: gitObjectId(
          ref.expectedWorkflowBlobSha,
          `prepareWorkflows[${index}].refs[${refIndex}].expectedWorkflowBlobSha`,
        ),
      }),
    }));
    if (new Set(refs.map((ref: GitHubWorkflowRefPolicy) => ref.ref)).size !== refs.length) {
      configError(`prepareWorkflows[${index}].refs`, "contains duplicate refs");
    }
    return {
      repository,
      workflow,
      workflowPath: workflowPath(
        entry.workflowPath,
        workflow,
        `prepareWorkflows[${index}].workflowPath`,
      ),
      refs,
    };
  });
  if (new Set(prepareWorkflows.map((entry) => `${entry.repository}\0${entry.workflow}`)).size !== prepareWorkflows.length) {
    configError("prepareWorkflows", "contains duplicate repository/workflow entries");
  }

  const releaseControllers = metadata.releaseControllers.map((entry, index) => {
    if (entry.controller !== "werewolf-static@1") {
      configError(`releaseControllers[${index}].controller`, "must be werewolf-static@1");
    }
    let repository: string;
    let workflow: string;
    let expectedHeadSha: string;
    try {
      repository = validateRepository(entry.repository, `releaseControllers[${index}].repository`);
      workflow = validateWorkflow(entry.workflow, `releaseControllers[${index}].workflow`);
      expectedHeadSha = validateCommitSha(
        entry.expectedHeadSha,
        `releaseControllers[${index}].expectedHeadSha`,
      );
    } catch (error) {
      if (error instanceof ExecutorContractError) configError(error.field, error.message.split(": ").slice(1).join(": "));
      throw error;
    }
    if (!Array.isArray(entry.allowedSourceRepositories) || entry.allowedSourceRepositories.length === 0) {
      configError(
        `releaseControllers[${index}].allowedSourceRepositories`,
        "must contain at least one repository",
      );
    }
    const allowedSourceRepositories = entry.allowedSourceRepositories.map((
      source: string,
      sourceIndex: number,
    ) => {
      try {
        return validateRepository(
          source,
          `releaseControllers[${index}].allowedSourceRepositories[${sourceIndex}]`,
        );
      } catch (error) {
        if (error instanceof ExecutorContractError) configError(error.field, error.message.split(": ").slice(1).join(": "));
        throw error;
      }
    });
    if (new Set(allowedSourceRepositories).size !== allowedSourceRepositories.length) {
      configError(`releaseControllers[${index}].allowedSourceRepositories`, "contains duplicates");
    }
    return {
      controller: entry.controller,
      targetId: identifier(entry.targetId, `releaseControllers[${index}].targetId`),
      repository,
      workflow,
      workflowPath: workflowPath(
        entry.workflowPath,
        workflow,
        `releaseControllers[${index}].workflowPath`,
      ),
      ref: gitRef(entry.ref, `releaseControllers[${index}].ref`),
      expectedHeadSha,
      expectedWorkflowBlobSha: gitObjectId(
        entry.expectedWorkflowBlobSha,
        `releaseControllers[${index}].expectedWorkflowBlobSha`,
      ),
      githubEnvironment: boundedText(
        entry.githubEnvironment,
        `releaseControllers[${index}].githubEnvironment`,
        255,
      ),
      allowedSourceRepositories,
    };
  });
  if (
    new Set(releaseControllers.map((entry) => `${entry.controller}\0${entry.targetId}`)).size
    !== releaseControllers.length
  ) {
    configError("releaseControllers", "contains duplicate controller/target entries");
  }

  return {
    revision: policyRevision(metadata.revision),
    apiBaseUrl: apiBase(metadata.apiBaseUrl),
    apiVersion,
    requestTimeoutMs: positiveInteger(
      metadata.requestTimeoutMs,
      "requestTimeoutMs",
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
    maxJsonResponseBytes: positiveInteger(
      metadata.maxJsonResponseBytes,
      "maxJsonResponseBytes",
      DEFAULT_MAX_JSON_BYTES,
      MAX_JSON_BYTES,
    ),
    prepareWorkflows,
    releaseControllers,
  };
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function repositoryPath(repository: string): string {
  const [owner, repo] = repository.split("/");
  return `/repos/${pathSegment(owner)}/${pathSegment(repo)}`;
}

function sanitizeMessage(value: unknown, token: string): string {
  if (typeof value !== "string") return "GitHub request failed";
  let message = value.replaceAll(token, "[REDACTED]").replace(/[\u0000-\u001f\u007f]/g, " ");
  message = message.replace(/(?:bearer|token)\s+[A-Za-z0-9._~+\/-]+/gi, "$1 [REDACTED]");
  return message.slice(0, MAX_ERROR_MESSAGE) || "GitHub request failed";
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function readBoundedJson(response: Response, maximum: number): Promise<unknown> {
  if (response.status === 204 || response.status === 205 || response.body === null) return null;
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maximum) {
      throw new GitHubExecutorError(
        "github-response-too-large",
        `GitHub response exceeded ${maximum} bytes`,
      );
    }
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) {
      await reader.cancel().catch(() => {});
      throw new GitHubExecutorError(
        "github-response-too-large",
        `GitHub response exceeded ${maximum} bytes`,
      );
    }
    chunks.push(value);
  }
  if (length === 0) return null;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GitHubExecutorError("github-response-invalid", "GitHub returned invalid UTF-8 JSON");
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new GitHubExecutorError("github-response-invalid", "GitHub returned invalid JSON");
  }
}

function normalizedTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) {
    throw new GitHubExecutorError("github-response-invalid", `GitHub ${field} was invalid`);
  }
  return value;
}

function correlationAppears(title: string, psmRunId: string): boolean {
  let offset = title.indexOf(psmRunId);
  const identifierCharacter = /[A-Za-z0-9._:@/-]/;
  while (offset !== -1) {
    const before = offset === 0 ? "" : title[offset - 1];
    const afterOffset = offset + psmRunId.length;
    const after = afterOffset >= title.length ? "" : title[afterOffset];
    if ((!before || !identifierCharacter.test(before)) && (!after || !identifierCharacter.test(after))) {
      return true;
    }
    offset = title.indexOf(psmRunId, offset + 1);
  }
  return false;
}

function normalizedRef(ref: string): string {
  return ref.replace(/^refs\/(?:heads|tags)\//, "");
}

function provenanceUrl(repository: string, providerRunId: string): string {
  return `https://github.com/${repository}/actions/runs/${providerRunId}`;
}

function sameReceiptTarget(
  receipt: GitHubDispatchReceipt,
  target: WorkflowTarget,
  revision: string,
): boolean {
  return receipt.policyRevision === revision
    && receipt.repository === target.repository
    && receipt.workflow === target.workflow
    && receipt.workflowPath === target.workflowPath
    && receipt.ref === target.ref;
}

export class GitHubActionsAdapter {
  readonly #metadata: ValidatedMetadata;
  readonly #token: () => string | Promise<string>;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: GitHubActionsAdapterOptions) {
    if (typeof options?.token !== "function") configError("token", "must be a function");
    this.#metadata = validateMetadata(options.metadata);
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  get policyRevision(): string {
    return this.#metadata.revision;
  }

  async #request(
    pathname: string,
    options: {
      method?: "GET" | "POST" | "PUT";
      body?: unknown;
      signal?: AbortSignal;
      statuses?: readonly number[];
    } = {},
  ): Promise<RequestResult> {
    const token = await this.#token();
    if (
      typeof token !== "string"
      || token.length < 8
      || token.length > 4096
      || /[\u0000-\u0020\u007f]/.test(token)
    ) {
      throw new GitHubExecutorError("github-config-invalid", "GitHub token is unavailable or invalid");
    }
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onCallerAbort();
    else options.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#metadata.requestTimeoutMs);
    let response: Response;
    try {
      const headers = new Headers({
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "psm-managed-deployments",
        "X-GitHub-Api-Version": this.#metadata.apiVersion,
      });
      if (options.body !== undefined) headers.set("Content-Type", "application/json");
      response = await this.#fetch(`${this.#metadata.apiBaseUrl}${pathname}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new GitHubExecutorError(
          "github-request-timeout",
          `GitHub request timed out after ${this.#metadata.requestTimeoutMs}ms`,
          { retryable: true },
        );
      }
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("GitHub request aborted");
      throw new GitHubExecutorError(
        "github-api-error",
        "GitHub request failed before a response was received",
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onCallerAbort);
    }
    const body = await readBoundedJson(response, this.#metadata.maxJsonResponseBytes);
    const statuses = options.statuses ?? [200];
    if (!statuses.includes(response.status)) {
      const provider = plainRecord(body);
      const message = sanitizeMessage(provider?.message, token);
      const retryable = response.status === 429 || response.status >= 500;
      throw new GitHubExecutorError(
        "github-api-error",
        `GitHub API ${response.status}: ${message}`,
        { status: response.status, retryable },
      );
    }
    return { status: response.status, body };
  }

  #prepareTarget(input: PrepareArtifactDispatch): WorkflowTarget {
    const workflow = this.#metadata.prepareWorkflows.find((entry) =>
      entry.repository === input.repository && entry.workflow === input.workflow
    );
    // The connection form saves a branch by name ("master"); dispatch asks for the
    // full ref ("refs/heads/master"). Both name the same branch; tags never match a bare name.
    const sameRef = (allowed: string, requested: string) => allowed === requested
      || `refs/heads/${allowed}` === requested || allowed === `refs/heads/${requested}`;
    const ref = workflow?.refs.find((entry) => sameRef(entry.ref, input.ref));
    if (!workflow || !ref) {
      throw new GitHubExecutorError(
        "github-target-not-allowed",
        "The prepare repository, workflow and ref tuple is not allowlisted",
      );
    }
    if (ref.expectedHeadSha !== undefined && ref.expectedHeadSha !== input.commitSha) {
      throw new GitHubExecutorError(
        "github-target-not-allowed",
        "The requested prepare commit does not match the server-owned ref pin",
      );
    }
    return {
      repository: workflow.repository,
      workflow: workflow.workflow,
      workflowPath: workflow.workflowPath,
      ref: ref.ref,
      expectedWorkflowBlobSha: ref.expectedWorkflowBlobSha,
    };
  }

  #releaseTarget(input: ReleaseControllerDispatch): GitHubReleaseControllerPolicy {
    const target = this.#metadata.releaseControllers.find((entry) =>
      entry.controller === input.controller && entry.targetId === input.targetId
    );
    if (!target) {
      throw new GitHubExecutorError(
        "github-target-not-allowed",
        "The release controller and target tuple is not allowlisted",
      );
    }
    if (!target.allowedSourceRepositories.includes(input.artifact.sourceRepository)) {
      throw new GitHubExecutorError(
        "github-target-not-allowed",
        "The prepared artifact repository is outside the controller allowlist",
      );
    }
    return target;
  }

  #controllerFor(targetId: string): GitHubReleaseControllerPolicy {
    const controller = this.#metadata.releaseControllers.find((entry) => entry.targetId === targetId);
    if (!controller) {
      throw new GitHubExecutorError("github-target-not-allowed", `No reviewed release controller is pinned for ${targetId}`);
    }
    return controller;
  }

  /**
   * Store secrets in the pinned controller's GitHub Environment for a target,
   * creating the environment if needed. Only that repository and environment
   * are reachable; values are sealed to GitHub's key and never returned.
   */
  async publishEnvironmentSecrets(
    targetId: string,
    secrets: Readonly<Record<string, string>>,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ repository: string; environment: string; names: string[] }> {
    const controller = this.#controllerFor(targetId);
    const names = Object.keys(secrets).sort();
    if (!names.length || names.some((name) => !/^[A-Z_][A-Z0-9_]{0,99}$/.test(name) || name.startsWith("GITHUB_"))) {
      throw new GitHubExecutorError("github-config-invalid", "Secret names must be upper-case identifiers outside GITHUB_*");
    }
    const environment = `${repositoryPath(controller.repository)}/environments/${pathSegment(controller.githubEnvironment)}`;
    // Each call names what it needed, so a refusal says which token permission is missing.
    const step = async <T>(what: string, permission: string, call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        if (!(error instanceof GitHubExecutorError)) throw error;
        const hint = error.status === 403 || error.status === 404 ? ` The token needs ${permission} on ${controller.repository}.` : "";
        throw new GitHubExecutorError(error.code, `${what}: ${error.message}.${hint}`, { status: error.status ?? undefined, retryable: error.retryable });
      }
    };
    // The key lookup doubles as the existence check. Creating an environment
    // needs repository administration; an existing one does not.
    let keyResponse = await step("Reading the environment's encryption key", "Environments: read", () =>
      this.#request(`${environment}/secrets/public-key`, { statuses: [200, 404], signal: options.signal }));
    if (keyResponse.status === 404) {
      await step(`Creating the ${controller.githubEnvironment} environment`, "Administration: read and write (or create the environment in the repository settings)", () =>
        this.#request(environment, { method: "PUT", body: {}, signal: options.signal }));
      keyResponse = await step("Reading the environment's encryption key", "Environments: read", () =>
        this.#request(`${environment}/secrets/public-key`, { signal: options.signal }));
    }
    const key = plainRecord(keyResponse.body);
    const keyId = key?.key_id;
    const publicKey = typeof key?.key === "string" ? Buffer.from(key.key, "base64") : null;
    if (typeof keyId !== "string" || !keyId || !publicKey || publicKey.length !== 32) {
      throw new GitHubExecutorError("github-api-error", "GitHub returned no usable environment public key");
    }
    for (const name of names) {
      const plain = Buffer.from(secrets[name], "utf8");
      try {
        const encrypted = Buffer.from(sealedBox(plain, publicKey)).toString("base64");
        await step(`Writing ${name}`, "Environments: read and write", () =>
          this.#request(`${environment}/secrets/${pathSegment(name)}`, { method: "PUT", body: { encrypted_value: encrypted, key_id: keyId }, statuses: [201, 204], signal: options.signal }));
      } finally {
        plain.fill(0);
      }
    }
    return { repository: controller.repository, environment: controller.githubEnvironment, names };
  }

  /** Names (never values) of the secrets in a target's controller environment. */
  async listEnvironmentSecretNames(targetId: string, options: { signal?: AbortSignal } = {}): Promise<string[] | null> {
    const controller = this.#controllerFor(targetId);
    const result = await this.#request(
      `${repositoryPath(controller.repository)}/environments/${pathSegment(controller.githubEnvironment)}/secrets?per_page=100`,
      { statuses: [200, 404], signal: options.signal },
    );
    if (result.status === 404) return null;
    const secrets = plainRecord(result.body)?.secrets;
    return Array.isArray(secrets) ? secrets.map((entry) => plainRecord(entry)?.name).filter((name): name is string => typeof name === "string").sort() : [];
  }

  /** A JSON file from the pinned controller commit, e.g. its target description. */
  async readControllerJson(targetId: string, file: string, options: { signal?: AbortSignal } = {}): Promise<unknown | null> {
    const controller = this.#controllerFor(targetId);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.json$/.test(file)) throw new GitHubExecutorError("github-config-invalid", "Unexpected controller file path");
    const result = await this.#request(
      `${repositoryPath(controller.repository)}/contents/${file.split("/").map(pathSegment).join("/")}?ref=${pathSegment(controller.expectedHeadSha)}`,
      { statuses: [200, 404], signal: options.signal },
    );
    if (result.status === 404) return null;
    const content = plainRecord(result.body)?.content;
    if (typeof content !== "string") return null;
    try { return JSON.parse(Buffer.from(content, "base64").toString("utf8")); } catch { return null; }
  }

  async verifyWorkflowTrust(
    target: WorkflowTarget,
    expectedHeadSha: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkflowTrustObservation> {
    const commit = await this.#request(
      `${repositoryPath(target.repository)}/commits/${pathSegment(target.ref)}`,
      { signal: options.signal },
    );
    const commitBody = plainRecord(commit.body);
    let observedHeadSha: string;
    try {
      observedHeadSha = validateCommitSha(commitBody?.sha, "response.sha");
    } catch {
      throw new GitHubExecutorError("github-response-invalid", "GitHub returned an invalid commit identity");
    }
    if (observedHeadSha !== expectedHeadSha) {
      throw new GitHubExecutorError(
        "github-run-mismatch",
        "The allowlisted workflow ref no longer resolves to the expected commit",
      );
    }
    const content = await this.#request(
      `${repositoryPath(target.repository)}/contents/${target.workflowPath.split("/").map(pathSegment).join("/")}?ref=${pathSegment(expectedHeadSha)}`,
      { signal: options.signal },
    );
    const contentBody = plainRecord(content.body);
    if (contentBody?.type !== "file" || contentBody.path !== target.workflowPath) {
      throw new GitHubExecutorError(
        "github-response-invalid",
        "GitHub did not return the exact allowlisted workflow file",
      );
    }
    let workflowBlobSha: string;
    try {
      workflowBlobSha = gitObjectId(contentBody.sha, "response.workflow.sha");
    } catch {
      throw new GitHubExecutorError("github-response-invalid", "GitHub returned an invalid workflow blob identity");
    }
    if (
      target.expectedWorkflowBlobSha !== undefined
      && workflowBlobSha !== target.expectedWorkflowBlobSha
    ) {
      throw new GitHubExecutorError(
        "github-run-mismatch",
        "The allowlisted workflow blob does not match its server-owned pin",
      );
    }
    return {
      repository: target.repository,
      workflow: target.workflow,
      workflowPath: target.workflowPath,
      ref: target.ref,
      headSha: observedHeadSha,
      workflowBlobSha,
    };
  }

  async #dispatch(
    operation: "prepare" | "release",
    target: WorkflowTarget,
    psmRunId: string,
    expectedHeadSha: string,
    inputs: Record<string, string>,
    details: {
      controller?: "werewolf-static@1";
      targetId?: string;
      githubEnvironment?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<GitHubDispatchReceipt> {
    if (Object.keys(inputs).length > 25) {
      throw new GitHubExecutorError("github-contract-invalid", "Workflow dispatch exceeds 25 inputs");
    }
    const trust = await this.verifyWorkflowTrust(target, expectedHeadSha, { signal: details.signal });
    const response = await this.#request(
      `${repositoryPath(target.repository)}/actions/workflows/${pathSegment(target.workflow)}/dispatches`,
      {
        method: "POST",
        body: { ref: target.ref, inputs },
        signal: details.signal,
        statuses: [200, 204],
      },
    );
    let providerRunId: string | null = null;
    if (response.status === 200) {
      const body = plainRecord(response.body);
      try {
        providerRunId = validateProviderId(body?.workflow_run_id, "response.workflow_run_id");
      } catch {
        throw new GitHubExecutorError(
          "github-response-invalid",
          "GitHub dispatch returned no valid workflow run ID",
        );
      }
    }
    return {
      schema: "psm.werewolf.solutions/github-dispatch-receipt/v1",
      policyRevision: this.#metadata.revision,
      operation,
      repository: trust.repository,
      workflow: trust.workflow,
      workflowPath: trust.workflowPath,
      ref: trust.ref,
      expectedHeadSha: trust.headSha,
      workflowBlobSha: trust.workflowBlobSha,
      psmRunId,
      dispatchedAt: new Date(this.#now()).toISOString(),
      providerRunId,
      controller: details.controller ?? null,
      targetId: details.targetId ?? null,
      githubEnvironment: details.githubEnvironment ?? null,
    };
  }

  async dispatchPrepare(
    input: PrepareArtifactDispatch,
    options: { signal?: AbortSignal } = {},
  ): Promise<GitHubDispatchReceipt> {
    let inputs: Record<string, string>;
    try {
      inputs = prepareDispatchInputs(input);
    } catch (error) {
      if (error instanceof ExecutorContractError) {
        throw new GitHubExecutorError("github-contract-invalid", error.message);
      }
      throw error;
    }
    const target = this.#prepareTarget(input);
    return this.#dispatch("prepare", target, input.psmRunId, input.commitSha, inputs, options);
  }

  async dispatchRelease(
    input: ReleaseControllerDispatch,
    options: { signal?: AbortSignal } = {},
  ): Promise<GitHubDispatchReceipt> {
    let inputs: Record<string, string>;
    try {
      inputs = releaseDispatchInputs(input);
    } catch (error) {
      if (error instanceof ExecutorContractError) {
        throw new GitHubExecutorError("github-contract-invalid", error.message);
      }
      throw error;
    }
    const target = this.#releaseTarget(input);
    return this.#dispatch(
      "release",
      target,
      input.psmRunId,
      target.expectedHeadSha,
      inputs,
      {
        signal: options.signal,
        controller: target.controller,
        targetId: target.targetId,
        githubEnvironment: target.githubEnvironment,
      },
    );
  }

  #targetForReceipt(receipt: GitHubDispatchReceipt): WorkflowTarget {
    if (receipt.schema !== "psm.werewolf.solutions/github-dispatch-receipt/v1") {
      throw new GitHubExecutorError("github-run-mismatch", "Dispatch receipt schema is invalid");
    }
    if (receipt.operation === "prepare") {
      const workflow = this.#metadata.prepareWorkflows.find((entry) =>
        entry.repository === receipt.repository && entry.workflow === receipt.workflow
      );
      const ref = workflow?.refs.find((entry) => entry.ref === receipt.ref);
      if (!workflow || !ref) {
        throw new GitHubExecutorError("github-run-mismatch", "Dispatch receipt is no longer allowlisted");
      }
      const target: WorkflowTarget = {
        repository: workflow.repository,
        workflow: workflow.workflow,
        workflowPath: workflow.workflowPath,
        ref: ref.ref,
        expectedWorkflowBlobSha: ref.expectedWorkflowBlobSha,
      };
      if (!sameReceiptTarget(receipt, target, this.#metadata.revision)) {
        throw new GitHubExecutorError("github-run-mismatch", "Dispatch receipt does not match its policy snapshot");
      }
      if (ref.expectedHeadSha !== undefined && ref.expectedHeadSha !== receipt.expectedHeadSha) {
        throw new GitHubExecutorError("github-run-mismatch", "Dispatch receipt commit is outside its ref pin");
      }
      return target;
    }
    if (receipt.operation !== "release" || receipt.controller !== "werewolf-static@1" || !receipt.targetId) {
      throw new GitHubExecutorError("github-run-mismatch", "Dispatch receipt operation is invalid");
    }
    const controller = this.#metadata.releaseControllers.find((entry) =>
      entry.controller === receipt.controller && entry.targetId === receipt.targetId
    );
    if (!controller || !sameReceiptTarget(receipt, controller, this.#metadata.revision)) {
      throw new GitHubExecutorError("github-run-mismatch", "Dispatch receipt does not match its controller policy");
    }
    if (
      receipt.expectedHeadSha !== controller.expectedHeadSha
      || receipt.workflowBlobSha !== controller.expectedWorkflowBlobSha
      || receipt.githubEnvironment !== controller.githubEnvironment
    ) {
      throw new GitHubExecutorError("github-run-mismatch", "Dispatch receipt controller trust pins changed");
    }
    return controller;
  }

  #parseRun(value: unknown, receipt: GitHubDispatchReceipt): GitHubRunObservation {
    const run = plainRecord(value);
    if (!run) throw new GitHubExecutorError("github-response-invalid", "GitHub returned an invalid workflow run");
    let providerRunId: string;
    let headSha: string;
    try {
      providerRunId = validateProviderId(run.id, "run.id");
      headSha = validateCommitSha(run.head_sha, "run.head_sha");
    } catch {
      throw new GitHubExecutorError("github-response-invalid", "GitHub returned invalid workflow run identities");
    }
    const repository = plainRecord(run.repository);
    const path = typeof run.path === "string" ? run.path.split("@")[0] : "";
    const displayTitle = typeof run.display_title === "string" && run.display_title.length <= 1024
      ? run.display_title
      : "";
    const providerStatus = run.status;
    const conclusion = run.conclusion;
    if (!PROVIDER_STATUSES.has(providerStatus as GitHubRunProviderStatus)) {
      throw new GitHubExecutorError("github-response-invalid", "GitHub returned an unknown workflow status");
    }
    if (conclusion !== null && !CONCLUSIONS.has(conclusion as Exclude<GitHubRunConclusion, null>)) {
      throw new GitHubExecutorError("github-response-invalid", "GitHub returned an unknown workflow conclusion");
    }
    if ((providerStatus === "completed") !== (conclusion !== null)) {
      throw new GitHubExecutorError("github-response-invalid", "GitHub returned an inconsistent workflow state");
    }
    // GitHub names a just-dispatched run after its workflow until `run-name` is
    // evaluated, so the correlation title appears only once the run starts. A run
    // identified by the id GitHub returned from this very dispatch may still carry
    // the placeholder while pending; a finished run must always carry the correlation.
    const identifiedByDispatch = receipt.providerRunId !== null && receipt.providerRunId === providerRunId;
    const titlePending = identifiedByDispatch && providerStatus !== "completed";
    if (
      repository?.full_name !== receipt.repository
      || path !== receipt.workflowPath
      || run.event !== "workflow_dispatch"
      || headSha !== receipt.expectedHeadSha
      || (!titlePending && !correlationAppears(displayTitle, receipt.psmRunId))
    ) {
      throw new GitHubExecutorError(
        "github-run-mismatch",
        "GitHub workflow run did not match repository, workflow, commit and correlation constraints",
      );
    }
    const headBranch = typeof run.head_branch === "string" ? run.head_branch : null;
    if (headBranch && !GIT_OBJECT_RE.test(receipt.ref) && headBranch !== normalizedRef(receipt.ref)) {
      throw new GitHubExecutorError("github-run-mismatch", "GitHub workflow run ref did not match dispatch");
    }
    const attempt = run.run_attempt;
    if (!Number.isSafeInteger(attempt) || (attempt as number) <= 0) {
      throw new GitHubExecutorError("github-response-invalid", "GitHub workflow run attempt was invalid");
    }
    const status = providerStatus === "completed"
      ? "completed"
      : providerStatus === "in_progress"
        ? "in-progress"
        : providerStatus === "waiting"
          ? "waiting"
          : "queued";
    return {
      providerRunId,
      repository: receipt.repository,
      workflow: receipt.workflow,
      ref: receipt.ref,
      headSha,
      displayTitle,
      status,
      providerStatus: providerStatus as GitHubRunProviderStatus,
      conclusion: conclusion as GitHubRunConclusion,
      runAttempt: attempt as number,
      createdAt: normalizedTimestamp(run.created_at, "created_at"),
      updatedAt: normalizedTimestamp(run.updated_at, "updated_at"),
      provenanceUrl: provenanceUrl(receipt.repository, providerRunId),
    };
  }

  async #getRun(
    receipt: GitHubDispatchReceipt,
    providerRunId: string,
    signal?: AbortSignal,
  ): Promise<GitHubRunObservation> {
    this.#targetForReceipt(receipt);
    const result = await this.#request(
      `${repositoryPath(receipt.repository)}/actions/runs/${pathSegment(providerRunId)}`,
      { signal },
    );
    return this.#parseRun(result.body, receipt);
  }

  async #correlateRun(
    receipt: GitHubDispatchReceipt,
    signal?: AbortSignal,
  ): Promise<GitHubRunObservation | null> {
    this.#targetForReceipt(receipt);
    const query = new URLSearchParams({
      event: "workflow_dispatch",
      head_sha: receipt.expectedHeadSha,
      per_page: "100",
      page: "1",
    });
    const result = await this.#request(
      `${repositoryPath(receipt.repository)}/actions/workflows/${pathSegment(receipt.workflow)}/runs?${query}`,
      { signal },
    );
    const body = plainRecord(result.body);
    if (!body || !Array.isArray(body.workflow_runs) || body.workflow_runs.length > 100) {
      throw new GitHubExecutorError("github-response-invalid", "GitHub returned an invalid workflow run list");
    }
    const candidates = body.workflow_runs.filter((entry) => {
      const run = plainRecord(entry);
      return typeof run?.display_title === "string"
        && correlationAppears(run.display_title, receipt.psmRunId);
    });
    if (candidates.length === 0) return null;
    if (candidates.length > 1) {
      throw new GitHubExecutorError(
        "github-run-ambiguous",
        "Several GitHub workflow runs claimed the same PSM correlation ID",
      );
    }
    const run = this.#parseRun(candidates[0], receipt);
    const dispatchedAt = Date.parse(receipt.dispatchedAt);
    const createdAt = Date.parse(run.createdAt);
    if (!Number.isFinite(dispatchedAt) || createdAt < dispatchedAt - 10_000 || createdAt > this.#now() + 60_000) {
      throw new GitHubExecutorError(
        "github-run-mismatch",
        "GitHub workflow run creation time did not match the dispatch window",
      );
    }
    return run;
  }

  async pollRun(
    receipt: GitHubDispatchReceipt,
    options: { signal?: AbortSignal } = {},
  ): Promise<GitHubPollResult> {
    const run = receipt.providerRunId
      ? await this.#getRun(receipt, validateProviderId(receipt.providerRunId, "receipt.providerRunId"), options.signal)
      : await this.#correlateRun(receipt, options.signal);
    if (!run) return { receipt, run: null };
    return {
      receipt: receipt.providerRunId === run.providerRunId
        ? receipt
        : { ...receipt, providerRunId: run.providerRunId },
      run,
    };
  }

  async cancelRun(
    receipt: GitHubDispatchReceipt,
    options: { signal?: AbortSignal } = {},
  ): Promise<GitHubCancelResult> {
    const polled = await this.pollRun(receipt, options);
    if (!polled.run) {
      throw new GitHubExecutorError(
        "github-run-not-found",
        "No GitHub workflow run matched the durable dispatch intent",
        { retryable: true },
      );
    }
    if (polled.run.status === "completed") return { ...polled, requested: false };
    const result = await this.#request(
      `${repositoryPath(receipt.repository)}/actions/runs/${pathSegment(polled.run.providerRunId)}/cancel`,
      { method: "POST", signal: options.signal, statuses: [202, 409] },
    );
    if (result.status === 202) return { ...polled, requested: true };
    const observed = await this.#getRun(polled.receipt, polled.run.providerRunId, options.signal);
    if (observed.status !== "completed") {
      throw new GitHubExecutorError(
        "github-api-error",
        "GitHub refused cancellation while the workflow was still active",
        { status: 409, retryable: true },
      );
    }
    return { receipt: polled.receipt, run: observed, requested: false };
  }

  /** Download one small, result-only artifact without ever loading release payload bytes. */
  async downloadRunArtifactJson(
    receipt: GitHubDispatchReceipt,
    artifactName: string,
    filename: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    identifier(artifactName, "artifactName");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(filename)) {
      throw new GitHubExecutorError("github-contract-invalid", "result filename is invalid");
    }
    const polled = await this.pollRun(receipt, options);
    if (!polled.run || polled.run.status !== "completed" || polled.run.conclusion !== "success") {
      throw new GitHubExecutorError("artifact-integrity", "workflow did not complete successfully");
    }
    const query = new URLSearchParams({ name: artifactName, per_page: "100", page: "1" });
    const listed = await this.#request(
      `${repositoryPath(receipt.repository)}/actions/runs/${pathSegment(polled.run.providerRunId)}/artifacts?${query}`,
      { signal: options.signal },
    );
    const envelope = plainRecord(listed.body);
    if (!envelope || !Array.isArray(envelope.artifacts)) {
      throw new GitHubExecutorError("github-response-invalid", "GitHub returned an invalid result artifact list");
    }
    const matches = envelope.artifacts.filter((item) => plainRecord(item)?.name === artifactName);
    if (matches.length !== 1 || plainRecord(matches[0])?.expired !== false) {
      throw new GitHubExecutorError("artifact-integrity", "workflow must retain exactly one named result artifact");
    }
    let artifactId: string;
    try { artifactId = validateProviderId(plainRecord(matches[0])?.id, "resultArtifact.id"); } catch {
      throw new GitHubExecutorError("github-response-invalid", "GitHub returned an invalid result artifact ID");
    }
    const token = await this.#token();
    if (typeof token !== "string" || token.length < 8 || token.length > 4096 || /[\u0000-\u0020\u007f]/.test(token)) {
      throw new GitHubExecutorError("github-config-invalid", "GitHub token is unavailable or invalid");
    }
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.#metadata.requestTimeoutMs);
    let response: Response;
    try {
      const redirect = await this.#fetch(
        `${this.#metadata.apiBaseUrl}${repositoryPath(receipt.repository)}/actions/artifacts/${pathSegment(artifactId)}/zip`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "User-Agent": "psm-managed-deployments",
            "X-GitHub-Api-Version": this.#metadata.apiVersion,
          },
          redirect: "manual",
          signal: controller.signal,
        },
      );
      if (redirect.status !== 302) {
        throw new GitHubExecutorError("github-api-error", `GitHub result download returned HTTP ${redirect.status}`, { status: redirect.status });
      }
      const location = redirect.headers.get("location");
      let signed: URL;
      try { signed = new URL(location ?? ""); } catch {
        throw new GitHubExecutorError("github-response-invalid", "GitHub returned no valid artifact download location");
      }
      if (signed.protocol !== "https:" || signed.username || signed.password) {
        throw new GitHubExecutorError("github-response-invalid", "GitHub returned an unsafe artifact download location");
      }
      response = await this.#fetch(signed, { redirect: "error", signal: controller.signal });
      if (!response.ok) throw new GitHubExecutorError("github-api-error", `Artifact storage returned HTTP ${response.status}`, { status: response.status });
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_RESULT_ARTIFACT_BYTES) {
        throw new GitHubExecutorError("github-response-too-large", "Result artifact is too large");
      }
      const archive = new Uint8Array(await response.arrayBuffer());
      if (archive.byteLength > MAX_RESULT_ARTIFACT_BYTES) throw new GitHubExecutorError("github-response-too-large", "Result artifact is too large");
      let files: Record<string, Uint8Array>;
      try { files = unzipSync(archive); } catch {
        throw new GitHubExecutorError("github-response-invalid", "Result artifact is not a valid ZIP archive");
      }
      const names = Object.keys(files);
      if (names.length !== 1 || names[0] !== filename || files[filename].byteLength > MAX_RESULT_ARTIFACT_BYTES) {
        throw new GitHubExecutorError("artifact-integrity", "Result artifact does not contain the one expected JSON file");
      }
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(files[filename])); } catch {
        throw new GitHubExecutorError("github-response-invalid", "Result artifact JSON is invalid");
      }
    } catch (error) {
      if (error instanceof GitHubExecutorError) throw error;
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      throw new GitHubExecutorError("github-api-error", "GitHub result artifact download failed", { retryable: true });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async importPreparedArtifact(
    receipt: GitHubDispatchReceipt,
    dispatch: PrepareArtifactDispatch,
    resultValue: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<ImportedPrepareArtifact> {
    if (
      receipt.operation !== "prepare"
      || receipt.repository !== dispatch.repository
      || receipt.workflow !== dispatch.workflow
      || receipt.ref !== dispatch.ref
      || receipt.psmRunId !== dispatch.psmRunId
      || receipt.expectedHeadSha !== dispatch.commitSha
    ) {
      throw new GitHubExecutorError("artifact-integrity", "Prepare receipt does not match its dispatch");
    }
    const polled = await this.pollRun(receipt, options);
    if (!polled.run) {
      throw new GitHubExecutorError("github-run-not-found", "Prepare workflow run has not appeared", {
        retryable: true,
      });
    }
    if (polled.run.status !== "completed" || polled.run.conclusion !== "success") {
      throw new GitHubExecutorError("artifact-integrity", "Prepare workflow did not complete successfully");
    }
    let result: PrepareArtifactResult;
    try {
      result = parsePrepareArtifactResult(resultValue);
    } catch (error) {
      if (error instanceof ExecutorContractError) {
        throw new GitHubExecutorError("artifact-integrity", error.message);
      }
      throw error;
    }
    const expected: Array<[unknown, unknown]> = [
      [result.psmRunId, dispatch.psmRunId],
      [result.psmArtifactId, dispatch.psmArtifactId],
      [result.projectId, dispatch.projectId],
      [result.environmentId, dispatch.environmentId],
      [result.unitId, dispatch.unitId],
      [result.sourceRepository, dispatch.repository],
      [result.producerRunId, polled.run.providerRunId],
      [result.commitSha, dispatch.commitSha],
      [result.manifestDigest, dispatch.manifestDigest],
      [result.buildProfileDigest, dispatch.buildProfileDigest],
    ];
    if (expected.some(([observed, wanted]) => observed !== wanted)) {
      throw new GitHubExecutorError(
        "artifact-integrity",
        "Prepared artifact result did not match its exact dispatch correlation fields",
      );
    }
    const query = new URLSearchParams({ name: dispatch.psmArtifactId, per_page: "100", page: "1" });
    const listed = await this.#request(
      `${repositoryPath(dispatch.repository)}/actions/runs/${pathSegment(polled.run.providerRunId)}/artifacts?${query}`,
      { signal: options.signal },
    );
    const list = plainRecord(listed.body);
    if (!list || !Array.isArray(list.artifacts) || list.artifacts.length > 100) {
      throw new GitHubExecutorError("github-response-invalid", "GitHub returned an invalid artifact list");
    }
    const matches = list.artifacts.filter((value) => plainRecord(value)?.name === dispatch.psmArtifactId);
    if (matches.length !== 1) {
      throw new GitHubExecutorError(
        "artifact-integrity",
        "The producer run must retain exactly one artifact with the PSM artifact ID",
      );
    }
    const artifact = plainRecord(matches[0])!;
    let githubArtifactId: string;
    try {
      githubArtifactId = validateProviderId(artifact.id, "artifact.id");
    } catch {
      throw new GitHubExecutorError("github-response-invalid", "GitHub returned an invalid artifact ID");
    }
    if (githubArtifactId !== result.githubArtifactId || artifact.expired !== false) {
      throw new GitHubExecutorError(
        "artifact-integrity",
        "The prepared artifact provider identity is mismatched or expired",
      );
    }
    const workflowRun = artifact.workflow_run === undefined ? null : plainRecord(artifact.workflow_run);
    if (
      workflowRun
      && (
        validateProviderId(workflowRun.id, "artifact.workflow_run.id") !== polled.run.providerRunId
        || workflowRun.head_sha !== dispatch.commitSha
      )
    ) {
      throw new GitHubExecutorError("artifact-integrity", "Artifact workflow provenance is mismatched");
    }
    const sizeInBytes = artifact.size_in_bytes;
    if (!Number.isSafeInteger(sizeInBytes) || (sizeInBytes as number) <= 0) {
      throw new GitHubExecutorError("github-response-invalid", "GitHub returned an invalid artifact size");
    }
    const expiresAt = normalizedTimestamp(artifact.expires_at, "artifact.expires_at");
    if (Date.parse(result.retainedUntil) > Date.parse(expiresAt)) {
      throw new GitHubExecutorError(
        "artifact-integrity",
        "Artifact result claims retention beyond the provider expiry",
      );
    }
    return {
      ...result,
      provider: {
        repository: dispatch.repository,
        runId: polled.run.providerRunId,
        artifactId: githubArtifactId,
        artifactName: dispatch.psmArtifactId,
        sizeInBytes: sizeInBytes as number,
        expiresAt,
        provenanceUrl: polled.run.provenanceUrl,
      },
    };
  }

  async importReleaseResult(
    receipt: GitHubDispatchReceipt,
    dispatch: ReleaseControllerDispatch,
    resultValue: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<StaticReleaseResult> {
    const controller = this.#releaseTarget(dispatch);
    if (
      receipt.operation !== "release"
      || receipt.controller !== dispatch.controller
      || receipt.targetId !== dispatch.targetId
      || receipt.psmRunId !== dispatch.psmRunId
      || receipt.repository !== controller.repository
      || receipt.workflow !== controller.workflow
      || receipt.ref !== controller.ref
    ) {
      throw new GitHubExecutorError("artifact-integrity", "Release receipt does not match its dispatch");
    }
    const polled = await this.pollRun(receipt, options);
    if (!polled.run) {
      throw new GitHubExecutorError("github-run-not-found", "Release workflow run has not appeared", {
        retryable: true,
      });
    }
    if (polled.run.status !== "completed") {
      throw new GitHubExecutorError("artifact-integrity", "Release workflow is not complete");
    }
    let result: StaticReleaseResult;
    try {
      result = parseStaticReleaseResult(resultValue);
    } catch (error) {
      if (error instanceof ExecutorContractError) {
        throw new GitHubExecutorError("artifact-integrity", error.message);
      }
      throw error;
    }
    const artifact = dispatch.artifact;
    const expected: Array<[unknown, unknown]> = [
      [result.psmRunId, dispatch.psmRunId],
      [result.projectId, dispatch.projectId],
      [result.environmentId, dispatch.environmentId],
      [result.unitId, dispatch.unitId],
      [result.releaseId, dispatch.releaseId],
      [result.planDigest, dispatch.planDigest],
      [result.executionContractDigest, dispatch.executionContractDigest],
      [result.controllerRepository, controller.repository],
      [result.controllerWorkflow, controller.workflow],
      [result.controllerRef, controller.ref],
      [result.controllerCommitSha, controller.expectedHeadSha],
      [result.providerRunId, polled.run.providerRunId],
      [result.targetId, dispatch.targetId],
      [result.targetFingerprint, dispatch.executionContract.target.fingerprint],
      [result.targetContractRevision, dispatch.executionContract.target.contractRevision],
      [result.psmArtifactId, artifact.psmArtifactId],
      [result.githubArtifactId, artifact.githubArtifactId],
      [result.producerRunId, artifact.producerRunId],
      [result.payloadAlgorithm, artifact.payloadAlgorithm],
      [result.payloadDigest, artifact.payloadDigest],
      [result.archiveDigest, artifact.archiveDigest],
    ];
    if (expected.some(([observed, wanted]) => observed !== wanted)) {
      throw new GitHubExecutorError(
        "artifact-integrity",
        "Release result did not match its approved dispatch and controller pins",
      );
    }
    if (
      (result.state === "failed" && polled.run.conclusion === "success")
      || (result.state !== "failed" && polled.run.conclusion !== "success")
    ) {
      throw new GitHubExecutorError(
        "artifact-integrity",
        "Release result state disagreed with the GitHub workflow conclusion",
      );
    }
    const probeIds = new Set(dispatch.executionContract.probes.map((probe) => probe.id));
    if (result.verification.some((probe) => !probeIds.has(probe.id))) {
      throw new GitHubExecutorError(
        "artifact-integrity",
        "Release result contained an unapproved verification probe",
      );
    }
    return result;
  }
}
