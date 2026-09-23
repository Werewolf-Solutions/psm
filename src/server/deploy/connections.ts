import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import { TextDecoder, TextEncoder } from "node:util";
import { compareRisk, type RiskClass } from "./policy.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ConnectionCredentialIdentity =
  | { kind: "provider-principal"; value: string }
  | { kind: "public-key"; value: string };

export interface SshConnectionConstraint {
  host: string;
  user: string;
  port: number;
  hostKeyFingerprint: string;
}

/** Server-owned boundaries a committed manifest cannot widen. */
export interface ConnectionConstraints {
  allowedProjectIds: readonly string[];
  allowedEnvironmentIds: readonly string[];
  minimumRequiredRisk?: RiskClass;
  maximumAuthorizedRisk: RiskClass;
  allowedTargetIds?: readonly string[];
  allowedProviderAccountIds?: readonly string[];
  allowedZones?: readonly string[];
  allowedRepositories?: readonly string[];
  allowedSourceRefs?: readonly string[];
  allowedMonitorIds?: readonly string[];
  allowedTargetRootPrefixes?: readonly string[];
  ssh?: SshConnectionConstraint;
}

export interface ConnectionProfile {
  connectionId: string;
  name: string;
  kind: string;
  metadataRevision: string | number;
  /** This object must contain only values safe to return from the API. */
  publicMetadata?: Readonly<Record<string, JsonValue>>;
  credentialIdentity?: ConnectionCredentialIdentity;
  requiredSecretSlots: readonly string[];
  constraints: ConnectionConstraints;
}

export interface ManifestConnectionSlot {
  slot: string;
  kind: string;
}

export interface ConnectionBinding {
  checkoutId: string;
  environmentId: string;
  slot: string;
  connectionId: string;
  bindingRevision: string | number;
}

export interface ConnectionScopeRequest {
  projectId: string;
  environmentId: string;
  risk: RiskClass;
  targetId?: string;
  providerAccountId?: string;
  zone?: string;
  repository?: string;
  sourceRef?: string;
  monitorId?: string;
  targetRoot?: string;
  ssh?: { host: string; user: string; port: number; hostKeyFingerprint: string };
}

export type ConnectionIssueCode =
  | "connection-invalid"
  | "connection-kind-mismatch"
  | "connection-binding-mismatch"
  | "connection-out-of-scope"
  | "connection-risk-mismatch";

export interface ConnectionIssue {
  code: ConnectionIssueCode;
  field: string;
  message: string;
}

export interface ConnectionValidationResult {
  ok: boolean;
  issues: ConnectionIssue[];
}

export class ConnectionValidationError extends Error {
  readonly issues: ConnectionIssue[];

  constructor(issues: readonly ConnectionIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "ConnectionValidationError";
    this.issues = [...issues];
  }
}

export class SecretUnavailableError extends Error {
  readonly connectionId: string;
  readonly missingSlots: string[];

  constructor(connectionId: string, missingSlots: readonly string[]) {
    super(`Connection ${connectionId} is missing secret slots: ${missingSlots.join(", ")}`);
    this.name = "SecretUnavailableError";
    this.connectionId = connectionId;
    this.missingSlots = [...missingSlots];
  }
}

export class SecretLeaseExpiredError extends Error {
  constructor() {
    super("The secret lease has expired");
    this.name = "SecretLeaseExpiredError";
  }
}

const SECRET_SLOT_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RISK_CLASSES = new Set<RiskClass>(["development", "staging", "production"]);
const SENSITIVE_METADATA_KEY = /(?:^|[_-])(?:secret|token|password|credential|private[_-]?key|api[_-]?key)(?:$|[_-])/i;
const SAFE_IDENTITY_RE = /^(?:SHA256:|MD5:|sha256:|provider:|principal:|key:)?[^\u0000-\u001f\u007f]{1,512}$/;

function validateBoundedText(value: string, field: string, max = 512): ConnectionIssue | null {
  if (!value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    return {
      code: "connection-invalid",
      field,
      message: `${field} must be non-empty, bounded text without control characters`,
    };
  }
  return null;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function validateStringList(values: readonly string[], field: string, required: boolean): ConnectionIssue[] {
  const issues: ConnectionIssue[] = [];
  if (required && values.length === 0) {
    issues.push({
      code: "connection-invalid",
      field,
      message: `${field} must contain at least one explicit value`,
    });
  }
  if (!unique(values)) {
    issues.push({ code: "connection-invalid", field, message: `${field} contains duplicates` });
  }
  for (const value of values) {
    const issue = validateBoundedText(value, field);
    if (issue) issues.push(issue);
  }
  return issues;
}

function validatePublicMetadata(
  value: JsonValue,
  field: string,
  seen: Set<object>,
  depth = 0,
): ConnectionIssue[] {
  const issues: ConnectionIssue[] = [];
  if (depth > 32) {
    return [{ code: "connection-invalid", field, message: `${field} is nested too deeply` }];
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    issues.push({ code: "connection-invalid", field, message: `${field} must be finite JSON` });
  }
  if (typeof value === "string") {
    const issue = validateBoundedText(value, field, 4096);
    if (issue) issues.push(issue);
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) {
      issues.push({ code: "connection-invalid", field, message: `${field} must not contain cycles` });
      return issues;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 256) {
        issues.push({ code: "connection-invalid", field, message: `${field} is too large` });
      }
      value.forEach((item, index) => issues.push(
        ...validatePublicMetadata(item, `${field}[${index}]`, seen, depth + 1),
      ));
    } else {
      const entries = Object.entries(value);
      if (entries.length > 256) {
        issues.push({ code: "connection-invalid", field, message: `${field} is too large` });
      }
      for (const [key, item] of entries) {
        const keyIssue = validateBoundedText(key, `${field} key`, 128);
        if (keyIssue) issues.push(keyIssue);
        if (SENSITIVE_METADATA_KEY.test(key) && !/fingerprint/i.test(key)) {
          issues.push({
            code: "connection-invalid",
            field: `${field}.${key}`,
            message: `${field}.${key} looks secret-bearing; store it in a secret slot`,
          });
        }
        issues.push(...validatePublicMetadata(item, `${field}.${key}`, seen, depth + 1));
      }
    }
    seen.delete(value);
  }
  return issues;
}

function canonicalRemotePath(value: string): string | null {
  if (!value.startsWith("/") || value.includes("\0") || value.includes("\\")) return null;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== "/" ? normalized : null;
}

/** Component-aware remote-path containment; `/srv/app2` is not inside `/srv/app`. */
export function isWithinAllowedRoot(targetRoot: string, allowedPrefix: string): boolean {
  const target = canonicalRemotePath(targetRoot);
  const prefix = canonicalRemotePath(allowedPrefix);
  if (!target || !prefix) return false;
  return target === prefix || target.startsWith(`${prefix}/`);
}

export function validateConnectionProfile(profile: ConnectionProfile): ConnectionValidationResult {
  const issues: ConnectionIssue[] = [];
  for (const [field, value] of [
    ["connectionId", profile.connectionId],
    ["name", profile.name],
    ["kind", profile.kind],
    ["metadataRevision", String(profile.metadataRevision)],
  ] as const) {
    const issue = validateBoundedText(value, field);
    if (issue) issues.push(issue);
  }
  if (typeof profile.metadataRevision === "number" && !Number.isFinite(profile.metadataRevision)) {
    issues.push({
      code: "connection-invalid",
      field: "metadataRevision",
      message: "metadata revision must be finite",
    });
  }
  if (!profile.kind.includes("@")) {
    issues.push({
      code: "connection-invalid",
      field: "kind",
      message: "connection kind must include an explicit adapter version",
    });
  }
  issues.push(...validateStringList(
    profile.constraints.allowedProjectIds,
    "constraints.allowedProjectIds",
    true,
  ));
  issues.push(...validateStringList(
    profile.constraints.allowedEnvironmentIds,
    "constraints.allowedEnvironmentIds",
    true,
  ));
  for (const [field, values] of [
    ["constraints.allowedTargetIds", profile.constraints.allowedTargetIds],
    ["constraints.allowedProviderAccountIds", profile.constraints.allowedProviderAccountIds],
    ["constraints.allowedZones", profile.constraints.allowedZones],
    ["constraints.allowedRepositories", profile.constraints.allowedRepositories],
    ["constraints.allowedSourceRefs", profile.constraints.allowedSourceRefs],
    ["constraints.allowedMonitorIds", profile.constraints.allowedMonitorIds],
    ["constraints.allowedTargetRootPrefixes", profile.constraints.allowedTargetRootPrefixes],
  ] as const) {
    if (values) issues.push(...validateStringList(values, field, true));
  }
  for (const root of profile.constraints.allowedTargetRootPrefixes ?? []) {
    if (!canonicalRemotePath(root)) {
      issues.push({
        code: "connection-invalid",
        field: "constraints.allowedTargetRootPrefixes",
        message: `${root} is not a normalized absolute non-root POSIX path`,
      });
    }
  }
  if (!RISK_CLASSES.has(profile.constraints.maximumAuthorizedRisk)) {
    issues.push({
      code: "connection-invalid",
      field: "constraints.maximumAuthorizedRisk",
      message: "maximum-authorized risk is not recognized",
    });
  }
  if (
    profile.constraints.minimumRequiredRisk !== undefined
    && !RISK_CLASSES.has(profile.constraints.minimumRequiredRisk)
  ) {
    issues.push({
      code: "connection-invalid",
      field: "constraints.minimumRequiredRisk",
      message: "minimum-required risk is not recognized",
    });
  }
  if (
    profile.constraints.minimumRequiredRisk
    && RISK_CLASSES.has(profile.constraints.minimumRequiredRisk)
    && RISK_CLASSES.has(profile.constraints.maximumAuthorizedRisk)
    && compareRisk(
      profile.constraints.minimumRequiredRisk,
      profile.constraints.maximumAuthorizedRisk,
    ) > 0
  ) {
    issues.push({
      code: "connection-invalid",
      field: "constraints.maximumAuthorizedRisk",
      message: "maximum-authorized risk is below the connection's minimum-required risk",
    });
  }
  if (!unique(profile.requiredSecretSlots)) {
    issues.push({
      code: "connection-invalid",
      field: "requiredSecretSlots",
      message: "required secret slots contain duplicates",
    });
  }
  for (const slot of profile.requiredSecretSlots) {
    if (!SECRET_SLOT_RE.test(slot)) {
      issues.push({
        code: "connection-invalid",
        field: "requiredSecretSlots",
        message: `${slot} is not a valid secret slot name`,
      });
    }
  }
  if (profile.publicMetadata) {
    issues.push(...validatePublicMetadata(profile.publicMetadata as JsonValue, "publicMetadata", new Set()));
  }
  if (
    profile.credentialIdentity
    && !SAFE_IDENTITY_RE.test(profile.credentialIdentity.value)
  ) {
    issues.push({
      code: "connection-invalid",
      field: "credentialIdentity",
      message: "credential identity must be a bounded public identifier",
    });
  }
  if (profile.constraints.ssh) {
    const ssh = profile.constraints.ssh;
    for (const [field, value] of [["host", ssh.host], ["user", ssh.user], ["hostKeyFingerprint", ssh.hostKeyFingerprint]] as const) {
      const issue = validateBoundedText(value, `constraints.ssh.${field}`);
      if (issue) issues.push(issue);
    }
    if (!Number.isInteger(ssh.port) || ssh.port < 1 || ssh.port > 65_535) {
      issues.push({
        code: "connection-invalid",
        field: "constraints.ssh.port",
        message: "SSH port must be an integer from 1 to 65535",
      });
    }
  }
  return { ok: issues.length === 0, issues };
}

function requireAllowed(
  issues: ConnectionIssue[],
  field: string,
  value: string | undefined,
  allowed: readonly string[] | undefined,
): void {
  if (value === undefined) return;
  if (!allowed?.includes(value)) {
    issues.push({
      code: "connection-out-of-scope",
      field,
      message: `${field} is not explicitly allowed by the connection profile`,
    });
  }
}

export function validateConnectionScope(
  profile: ConnectionProfile,
  requiredKind: string,
  scope: ConnectionScopeRequest,
): ConnectionValidationResult {
  const profileResult = validateConnectionProfile(profile);
  const issues = [...profileResult.issues];
  if (!RISK_CLASSES.has(scope.risk)) {
    issues.push({
      code: "connection-invalid",
      field: "risk",
      message: "requested risk is not recognized",
    });
  }
  if (profile.kind !== requiredKind) {
    issues.push({
      code: "connection-kind-mismatch",
      field: "kind",
      message: `connection kind ${profile.kind} does not satisfy ${requiredKind}`,
    });
  }
  requireAllowed(issues, "projectId", scope.projectId, profile.constraints.allowedProjectIds);
  requireAllowed(
    issues,
    "environmentId",
    scope.environmentId,
    profile.constraints.allowedEnvironmentIds,
  );
  requireAllowed(issues, "targetId", scope.targetId, profile.constraints.allowedTargetIds);
  requireAllowed(
    issues,
    "providerAccountId",
    scope.providerAccountId,
    profile.constraints.allowedProviderAccountIds,
  );
  requireAllowed(issues, "zone", scope.zone, profile.constraints.allowedZones);
  requireAllowed(issues, "repository", scope.repository, profile.constraints.allowedRepositories);
  requireAllowed(issues, "sourceRef", scope.sourceRef, profile.constraints.allowedSourceRefs);
  requireAllowed(issues, "monitorId", scope.monitorId, profile.constraints.allowedMonitorIds);

  if (
    RISK_CLASSES.has(scope.risk)
    && profile.constraints.minimumRequiredRisk
    && RISK_CLASSES.has(profile.constraints.minimumRequiredRisk)
    && compareRisk(scope.risk, profile.constraints.minimumRequiredRisk) < 0
  ) {
    issues.push({
      code: "connection-risk-mismatch",
      field: "risk",
      message: `connection requires at least ${profile.constraints.minimumRequiredRisk} risk handling`,
    });
  }
  if (
    RISK_CLASSES.has(scope.risk)
    && RISK_CLASSES.has(profile.constraints.maximumAuthorizedRisk)
    && compareRisk(scope.risk, profile.constraints.maximumAuthorizedRisk) > 0
  ) {
    issues.push({
      code: "connection-risk-mismatch",
      field: "risk",
      message: `connection authorizes at most ${profile.constraints.maximumAuthorizedRisk} risk`,
    });
  }

  if (scope.targetRoot !== undefined) {
    const roots = profile.constraints.allowedTargetRootPrefixes;
    if (!roots?.some((root) => isWithinAllowedRoot(scope.targetRoot!, root))) {
      issues.push({
        code: "connection-out-of-scope",
        field: "targetRoot",
        message: "target root is not within an allowed component-aware prefix",
      });
    }
  }
  if (scope.ssh) {
    const allowed = profile.constraints.ssh;
    if (
      !allowed
      || allowed.host !== scope.ssh.host
      || allowed.user !== scope.ssh.user
      || allowed.port !== scope.ssh.port
      || allowed.hostKeyFingerprint !== scope.ssh.hostKeyFingerprint
    ) {
      issues.push({
        code: "connection-out-of-scope",
        field: "ssh",
        message: "SSH endpoint does not exactly match the pinned connection profile",
      });
    }
  }
  return { ok: issues.length === 0, issues };
}

/** Resolve a local binding without allowing either the manifest or binding to change scope. */
export function resolveConnectionBinding(
  slot: ManifestConnectionSlot,
  binding: ConnectionBinding,
  profile: ConnectionProfile,
  expected: { checkoutId: string; environmentId: string },
  scope: ConnectionScopeRequest,
): ConnectionProfile {
  const bindingMatches = binding.checkoutId === expected.checkoutId
    && binding.environmentId === expected.environmentId
    && binding.slot === slot.slot
    && binding.connectionId === profile.connectionId;
  const result = validateConnectionScope(profile, slot.kind, scope);
  if (!bindingMatches) {
    result.issues.unshift({
      code: "connection-binding-mismatch",
      field: "binding",
      message: "connection binding does not match the selected checkout, environment, slot and profile",
    });
  }
  if (result.issues.length) throw new ConnectionValidationError(result.issues);
  return profile;
}

export interface SecretBackend {
  read(connectionId: string, slot: string): Promise<Uint8Array | null>;
  write(connectionId: string, slot: string, value: Uint8Array): Promise<void>;
  delete(connectionId: string, slot: string): Promise<boolean>;
  listSlots(connectionId: string): Promise<string[]>;
}

/** Default broker storage: process memory only, with explicit zeroization. */
export class InMemorySecretBackend implements SecretBackend {
  readonly #connections = new Map<string, Map<string, Uint8Array>>();

  async read(connectionId: string, slot: string): Promise<Uint8Array | null> {
    const value = this.#connections.get(connectionId)?.get(slot);
    return value ? new Uint8Array(value) : null;
  }

  async write(connectionId: string, slot: string, value: Uint8Array): Promise<void> {
    let slots = this.#connections.get(connectionId);
    if (!slots) {
      slots = new Map();
      this.#connections.set(connectionId, slots);
    }
    slots.get(slot)?.fill(0);
    slots.set(slot, new Uint8Array(value));
  }

  async delete(connectionId: string, slot: string): Promise<boolean> {
    const slots = this.#connections.get(connectionId);
    const value = slots?.get(slot);
    if (!slots || !value) return false;
    value.fill(0);
    slots.delete(slot);
    if (slots.size === 0) this.#connections.delete(connectionId);
    return true;
  }

  async listSlots(connectionId: string): Promise<string[]> {
    return [...(this.#connections.get(connectionId)?.keys() ?? [])].sort();
  }

  clear(): void {
    for (const slots of this.#connections.values()) {
      for (const value of slots.values()) value.fill(0);
      slots.clear();
    }
    this.#connections.clear();
  }
}

export interface SecretGenerationStore {
  readGeneration(connectionId: string): Promise<number>;
  writeGeneration(connectionId: string, generation: number): Promise<void>;
}

/** Replace with the SQLite metadata store when deployment migrations land. */
export class InMemorySecretGenerationStore implements SecretGenerationStore {
  readonly #generations = new Map<string, number>();

  async readGeneration(connectionId: string): Promise<number> {
    return this.#generations.get(connectionId) ?? 0;
  }

  async writeGeneration(connectionId: string, generation: number): Promise<void> {
    this.#generations.set(connectionId, generation);
  }
}

export interface SecretStatus {
  ready: boolean;
  generation: number;
  availableSlots: string[];
  missingSlots: string[];
  credentialFingerprint: string | null;
  fingerprintKind: "public-identity" | "keyed-hmac" | null;
}

export interface SecretLease {
  readonly connectionId: string;
  readonly generation: number;
  readonly credentialFingerprint: string;
  readonly expiresAt: number;
  useBytes<T>(slot: string, operation: (value: Uint8Array) => T): T;
  useUtf8<T>(slot: string, operation: (value: string) => T): T;
}

class BoundedSecretLease implements SecretLease {
  readonly connectionId: string;
  readonly generation: number;
  readonly credentialFingerprint: string;
  readonly expiresAt: number;
  readonly #values: Map<string, Uint8Array>;
  #expired = false;

  constructor(input: {
    connectionId: string;
    generation: number;
    credentialFingerprint: string;
    expiresAt: number;
    values: Map<string, Uint8Array>;
  }) {
    this.connectionId = input.connectionId;
    this.generation = input.generation;
    this.credentialFingerprint = input.credentialFingerprint;
    this.expiresAt = input.expiresAt;
    this.#values = input.values;
  }

  #value(slot: string): Uint8Array {
    if (this.#expired || Date.now() >= this.expiresAt) {
      this.expire();
      throw new SecretLeaseExpiredError();
    }
    const value = this.#values.get(slot);
    if (!value) throw new SecretUnavailableError(this.connectionId, [slot]);
    return value;
  }

  useBytes<T>(slot: string, operation: (value: Uint8Array) => T): T {
    const copy = new Uint8Array(this.#value(slot));
    try {
      return operation(copy);
    } finally {
      copy.fill(0);
    }
  }

  useUtf8<T>(slot: string, operation: (value: string) => T): T {
    return operation(new TextDecoder("utf-8", { fatal: true }).decode(this.#value(slot)));
  }

  expire(): void {
    if (this.#expired) return;
    this.#expired = true;
    for (const value of this.#values.values()) value.fill(0);
    this.#values.clear();
  }
}

function validateSecretConnectionId(connectionId: string): void {
  const idIssue = validateBoundedText(connectionId, "connectionId");
  if (idIssue) throw new ConnectionValidationError([idIssue]);
}

function validateSecretAddress(connectionId: string, slot: string): void {
  validateSecretConnectionId(connectionId);
  if (!SECRET_SLOT_RE.test(slot)) {
    throw new ConnectionValidationError([{
      code: "connection-invalid",
      field: "slot",
      message: `${slot} is not a valid secret slot name`,
    }]);
  }
}

function encodeSecret(value: string | Uint8Array): Uint8Array {
  // `new Uint8Array(x)` always copies. `Buffer#slice` is a view, so zeroing its
  // result would also wipe the caller's buffer (and a stored secret).
  const encoded = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  if (encoded.byteLength === 0 || encoded.byteLength > 1024 * 1024) {
    encoded.fill(0);
    throw new Error("A secret must contain between 1 byte and 1 MiB");
  }
  return encoded;
}

function fingerprintSecrets(
  hmacKey: Uint8Array,
  connectionId: string,
  generation: number,
  values: ReadonlyMap<string, Uint8Array>,
): string {
  const hmac = createHmac("sha256", hmacKey);
  const add = (value: string | Uint8Array) => {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hmac.update(length);
    hmac.update(bytes);
  };
  add("psm-connection-secret-fingerprint@1");
  add(connectionId);
  add(String(generation));
  for (const [slot, value] of [...values.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    add(slot);
    add(value);
  }
  return `hmac-sha256:${hmac.digest("hex")}`;
}

/**
 * Secret values are fetched only inside `withLease`; no getter returns them to
 * an API layer. The process-random HMAC key intentionally invalidates old plan
 * fingerprints after restart unless an integration supplies a stable local key.
 */
export class SecretBroker {
  readonly #backend: SecretBackend;
  readonly #generations: SecretGenerationStore;
  readonly #hmacKey: Uint8Array;
  readonly #operations = new Map<string, Promise<unknown>>();

  constructor(options: {
    backend?: SecretBackend;
    generations?: SecretGenerationStore;
    fingerprintKey?: Uint8Array;
  } = {}) {
    this.#backend = options.backend ?? new InMemorySecretBackend();
    this.#generations = options.generations ?? new InMemorySecretGenerationStore();
    this.#hmacKey = options.fingerprintKey ? new Uint8Array(options.fingerprintKey) : randomBytes(32);
    if (this.#hmacKey.byteLength < 32) throw new Error("fingerprint key must be at least 32 bytes");
  }

  async #serialize<T>(connectionId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#operations.get(connectionId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    this.#operations.set(connectionId, next);
    try {
      return await next;
    } finally {
      if (this.#operations.get(connectionId) === next) this.#operations.delete(connectionId);
    }
  }

  async put(connectionId: string, slot: string, value: string | Uint8Array): Promise<number> {
    validateSecretAddress(connectionId, slot);
    const encoded = encodeSecret(value);
    try {
      return await this.#serialize(connectionId, async () => {
        await this.#backend.write(connectionId, slot, encoded);
        const generation = (await this.#generations.readGeneration(connectionId)) + 1;
        await this.#generations.writeGeneration(connectionId, generation);
        return generation;
      });
    } finally {
      encoded.fill(0);
    }
  }

  async delete(connectionId: string, slot: string): Promise<number> {
    validateSecretAddress(connectionId, slot);
    return this.#serialize(connectionId, async () => {
      let generation = await this.#generations.readGeneration(connectionId);
      if (await this.#backend.delete(connectionId, slot)) {
        generation = (await this.#generations.readGeneration(connectionId)) + 1;
        await this.#generations.writeGeneration(connectionId, generation);
      }
      return generation;
    });
  }

  /**
   * Remove every stored value after the public profile has been durably deleted. This deliberately
   * does not touch the generation store, which may no longer contain that connection. It returns
   * no bytes and exists only to prevent an orphaned credential becoming live if an ID is reused.
   */
  async purge(connectionId: string): Promise<number> {
    validateSecretConnectionId(connectionId);
    return this.#serialize(connectionId, async () => {
      const slots = await this.#backend.listSlots(connectionId);
      let removed = 0;
      for (const slot of slots) if (await this.#backend.delete(connectionId, slot)) removed += 1;
      return removed;
    });
  }

  async status(
    connectionId: string,
    requiredSlots: readonly string[],
    identity?: ConnectionCredentialIdentity,
  ): Promise<SecretStatus> {
    validateSecretConnectionId(connectionId);
    for (const slot of requiredSlots) validateSecretAddress(connectionId, slot);
    return this.#serialize(connectionId, async () => {
      const generation = await this.#generations.readGeneration(connectionId);
      const available = new Set(await this.#backend.listSlots(connectionId));
      const missingSlots = [...new Set(requiredSlots)].filter((slot) => !available.has(slot)).sort();
      const availableSlots = [...available].sort();
      let credentialFingerprint: string | null = null;
      let fingerprintKind: SecretStatus["fingerprintKind"] = null;

      if (identity) {
        credentialFingerprint = `${identity.kind}:${identity.value}`;
        fingerprintKind = "public-identity";
      } else if (missingSlots.length === 0 && requiredSlots.length > 0) {
        const values = new Map<string, Uint8Array>();
        try {
          for (const slot of [...new Set(requiredSlots)].sort()) {
            const value = await this.#backend.read(connectionId, slot);
            if (!value) {
              missingSlots.push(slot);
              break;
            }
            values.set(slot, value);
          }
          if (missingSlots.length === 0) {
            credentialFingerprint = fingerprintSecrets(this.#hmacKey, connectionId, generation, values);
            fingerprintKind = "keyed-hmac";
          }
        } finally {
          for (const value of values.values()) value.fill(0);
        }
      }

      return {
        ready: missingSlots.length === 0,
        generation,
        availableSlots,
        missingSlots: [...new Set(missingSlots)].sort(),
        credentialFingerprint,
        fingerprintKind,
      };
    });
  }

  async withLease<T>(
    connectionId: string,
    requiredSlots: readonly string[],
    operation: (lease: SecretLease) => T | Promise<T>,
    maxLeaseMs = 30_000,
  ): Promise<T> {
    if (!Number.isFinite(maxLeaseMs) || maxLeaseMs < 1 || maxLeaseMs > 300_000) {
      throw new Error("secret lease duration must be between 1 ms and 5 minutes");
    }
    const slots = [...new Set(requiredSlots)].sort();
    validateSecretConnectionId(connectionId);
    for (const slot of slots) validateSecretAddress(connectionId, slot);
    const acquired = await this.#serialize(connectionId, async () => {
      const generation = await this.#generations.readGeneration(connectionId);
      const values = new Map<string, Uint8Array>();
      const missing: string[] = [];
      for (const slot of slots) {
        const value = await this.#backend.read(connectionId, slot);
        if (value) values.set(slot, value);
        else missing.push(slot);
      }
      if (missing.length) {
        for (const value of values.values()) value.fill(0);
        throw new SecretUnavailableError(connectionId, missing);
      }
      return {
        generation,
        values,
        fingerprint: fingerprintSecrets(this.#hmacKey, connectionId, generation, values),
      };
    });
    try {
      const lease = new BoundedSecretLease({
        connectionId,
        generation: acquired.generation,
        credentialFingerprint: acquired.fingerprint,
        expiresAt: Date.now() + maxLeaseMs,
        values: acquired.values,
      });
      const timer = setTimeout(() => lease.expire(), maxLeaseMs);
      timer.unref();
      try {
        return await operation(lease);
      } finally {
        clearTimeout(timer);
        lease.expire();
      }
    } catch (error) {
      for (const value of acquired.values.values()) value.fill(0);
      acquired.values.clear();
      throw error;
    }
  }
}

export interface ConnectionReadinessView {
  connectionId: string;
  name: string;
  kind: string;
  metadataRevision: string | number;
  publicMetadata: Readonly<Record<string, JsonValue>>;
  constraints: ConnectionConstraints;
  ready: boolean;
  secretGeneration: number;
  missingSecretSlots: string[];
  credentialFingerprint: string | null;
  fingerprintKind: SecretStatus["fingerprintKind"];
}

/** Public view contains status and non-secret identity, never secret values. */
export async function connectionReadinessView(
  profile: ConnectionProfile,
  broker: SecretBroker,
): Promise<ConnectionReadinessView> {
  const validation = validateConnectionProfile(profile);
  if (!validation.ok) throw new ConnectionValidationError(validation.issues);
  const status = await broker.status(
    profile.connectionId,
    profile.requiredSecretSlots,
    profile.credentialIdentity,
  );
  return {
    connectionId: profile.connectionId,
    name: profile.name,
    kind: profile.kind,
    metadataRevision: profile.metadataRevision,
    publicMetadata: structuredClone(profile.publicMetadata ?? {}),
    constraints: structuredClone(profile.constraints),
    ready: status.ready,
    secretGeneration: status.generation,
    missingSecretSlots: status.missingSlots,
    credentialFingerprint: status.credentialFingerprint,
    fingerprintKind: status.fingerprintKind,
  };
}

export const DEFAULT_MINIMAL_ENV_ALLOWLIST = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

/**
 * Build an adapter subprocess environment from an explicit allowlist. It never
 * begins with `{ ...process.env }`, so unrelated ambient credentials stay out.
 */
export function minimalEnvironment(options: {
  inherit?: readonly string[];
  source?: NodeJS.ProcessEnv;
  values?: Readonly<Record<string, string>>;
} = {}): NodeJS.ProcessEnv {
  const source = options.source ?? process.env;
  const inherit = options.inherit ?? DEFAULT_MINIMAL_ENV_ALLOWLIST;
  const environment: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const name of inherit) {
    if (!ENV_NAME_RE.test(name)) throw new Error(`${name} is not a valid environment variable name`);
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(options.values ?? {})) {
    if (!ENV_NAME_RE.test(name)) throw new Error(`${name} is not a valid environment variable name`);
    if (value.includes("\0")) throw new Error(`${name} contains a NUL byte`);
    environment[name] = value;
  }
  return environment;
}
