import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  DEPLOYMENT_API_VERSION,
  DEPLOYMENT_MANIFEST_KIND,
  type ConnectionKind,
  type DependencyManifest,
  type DeploymentManifestV1,
  type EnvironmentManifest,
  type LoadedDeploymentManifest,
  type ManifestValidationIssue,
  type ManifestValidationOptions,
  type ProbeRequest,
  type ResourceManifest,
  type UnitManifest,
  type VerificationManifest,
} from "./types.ts";

const MAX_MANIFEST_BYTES = 1024 * 1024;
/** errnos that all mean the same thing here: there is nothing at that path to read. */
const ABSENT = new Set(["ENOENT", "ENOTDIR"]);
const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PROJECT_ID_RE = /^prj_[a-f0-9]{20}$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_RE = /^[A-Za-z0-9_.-]+\.ya?ml$/;
const TARGET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
const PUBLIC_INPUT_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const HOST_LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const SECRET_KEY_RE = /(?:^|[_-])(secret|token|password|passwd|credential|authorization|private[_-]?key|api[_-]?key|env[_-]?file)(?:$|[_-])/i;
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i,
  /\bBasic\s+[A-Za-z0-9+/=]{12,}\b/i,
  // A JWT: its header always encodes `{"`, so it starts with eyJ. Without that
  // anchor a hostname such as handyman-staging.werewolf.solutions matched.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /:\/\/[^/?#\s:@]+:[^/?#\s@]+@/,
];

const CONNECTION_KINDS = new Set<ConnectionKind>([
  "github-actions@1",
  "digitalocean-api@1",
  "ssh-host-helper@1",
  "werewolf-api@1",
  "external-monitor@1",
]);

const RESOURCE_KINDS = new Set([
  "digitalocean-dns-record@1",
  "host-release-directory@1",
  "nginx-static-site@1",
  "letsencrypt-certificate@1",
  "systemd-node-service@1",
  "service-secrets@1",
  "nginx-node-proxy@1",
]);
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,99}$/;
const SCRIPT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
const URL_PATH_RE = /^\/[A-Za-z0-9._~/-]{0,200}$/;

/** Names the service unit owns, or that change how Node or the loader behave (mirrors the host helper). */
function reservedEnvironmentName(name: string): boolean {
  if (["HOST", "PORT", "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "NODE_ENV_FILE"].includes(name)) return true;
  if (name.startsWith("NODE_") && name !== "NODE_ENV") return true;
  return ["LD_", "PSM_", "SYSTEMD_", "INVOCATION_", "NOTIFY_", "LISTEN_", "CREDENTIALS_"].some((prefix) => name.startsWith(prefix));
}

function validateEnvironmentName(v: Validator, name: string, at: string): void {
  if (!ENV_NAME_RE.test(name)) v.issue("invalid-env-name", at, "must be an upper-case environment variable name");
  else if (reservedEnvironmentName(name)) v.issue("reserved-env-name", at, `${name} is set by the service unit or changes how Node runs`);
}

const DEPENDENCY_KINDS = new Set([
  "http-status@1",
  "http-json@1",
  "github-checks@1",
  "project-release@1",
  "werewolf-backup-policy@1",
]);

const VERIFICATION_KINDS = new Set(["http-status@1", "http-json@1", "release-metadata@1"]);

export class DeploymentManifestValidationError extends Error {
  readonly issues: ManifestValidationIssue[];

  constructor(issues: ManifestValidationIssue[]) {
    super(issues.length === 1
      ? `Invalid deployment manifest: ${issues[0].path}: ${issues[0].message}`
      : `Invalid deployment manifest (${issues.length} issues)`);
    this.name = "DeploymentManifestValidationError";
    this.issues = issues;
  }
}

class Validator {
  readonly issues: ManifestValidationIssue[] = [];

  issue(code: string, at: string, message: string): void {
    if (this.issues.length < 200) this.issues.push({ code, path: at, message });
  }

  object(value: unknown, at: string, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.issue("type", at, "must be an object");
      return null;
    }
    const object = value as Record<string, unknown>;
    for (const key of Object.keys(object)) {
      if (!allowed.includes(key)) this.issue("unknown-field", `${at}.${key}`, "unknown field");
    }
    for (const key of required) {
      if (!Object.hasOwn(object, key)) this.issue("required", `${at}.${key}`, "is required");
    }
    return object;
  }

  array(value: unknown, at: string, min = 0, max = 100): unknown[] {
    if (!Array.isArray(value)) {
      this.issue("type", at, "must be an array");
      return [];
    }
    if (value.length < min) this.issue("range", at, `must contain at least ${min} item(s)`);
    if (value.length > max) this.issue("range", at, `must contain no more than ${max} items`);
    return value;
  }

  string(value: unknown, at: string, min = 1, max = 500): string {
    if (typeof value !== "string") {
      this.issue("type", at, "must be a string");
      return "";
    }
    if (value.length < min || value.length > max) this.issue("range", at, `must be ${min}-${max} characters`);
    if (/\0|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      this.issue("control-character", at, "must not contain control characters");
    }
    return value;
  }

  boolean(value: unknown, at: string): boolean {
    if (typeof value !== "boolean") {
      this.issue("type", at, "must be a boolean");
      return false;
    }
    return value;
  }

  integer(value: unknown, at: string, min: number, max: number): number {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
      this.issue("range", at, `must be an integer from ${min} to ${max}`);
      return min;
    }
    return value as number;
  }

  oneOf<T extends string>(value: unknown, at: string, allowed: readonly T[]): T {
    const text = this.string(value, at, 1, 200);
    if (!allowed.includes(text as T)) this.issue("invalid-value", at, `must be one of: ${allowed.join(", ")}`);
    return text as T;
  }
}

function hasSecretShape(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function scanSecretShapes(v: Validator, value: unknown, at: string, seen = new WeakSet<object>()): void {
  if (typeof value === "string") {
    if (hasSecretShape(value)) v.issue("secret-shaped", at, "value resembles credential material");
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSecretShapes(v, entry, `${at}[${index}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childAt = `${at}.${key}`;
    if (SECRET_KEY_RE.test(key)) v.issue("secret-shaped", childAt, "secret-shaped properties are forbidden");
    scanSecretShapes(v, child, childAt, seen);
  }
}

function validateId(v: Validator, value: unknown, at: string): string {
  const id = v.string(value, at, 1, 63);
  if (!ID_RE.test(id)) v.issue("invalid-id", at, "must use lowercase kebab-case and start with a letter");
  return id;
}

function validateProjectId(v: Validator, value: unknown, at: string): string {
  const id = v.string(value, at, 24, 24);
  if (!PROJECT_ID_RE.test(id)) v.issue("invalid-project-id", at, "must be a stable prj_ ID");
  return id;
}

function validateHostname(v: Validator, value: unknown, at: string): string {
  let hostname = v.string(value, at, 1, 253).toLowerCase();
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (net.isIP(hostname) || hostname === "localhost" || hostname.endsWith(".localhost")) {
    v.issue("invalid-hostname", at, "must be a public DNS hostname, not a local name or IP literal");
  } else if (hostname.split(".").length < 2 || !hostname.split(".").every((label) => HOST_LABEL_RE.test(label))) {
    v.issue("invalid-hostname", at, "must be a normalized DNS hostname");
  }
  return hostname;
}

function isPublicIpLiteral(hostname: string): boolean {
  const family = net.isIP(hostname.replace(/^\[|\]$/g, ""));
  if (!family) return true;
  if (family === 4) {
    const parts = hostname.split(".").map(Number);
    const [a, b] = parts;
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0)
      || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
  }
  const ip = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return !(ip === "::" || ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd")
    || /^fe[89ab]/.test(ip) || ip.startsWith("ff") || ip.startsWith("2001:db8:"));
}

function validateProbeRequest(v: Validator, value: unknown, at: string, risk: string, isPrivate: boolean): ProbeRequest {
  const object = v.object(value, at,
    ["url", "method", "timeoutMs", "maxResponseBytes", "followSameOriginRedirects"], ["url", "method"]);
  const rawUrl = v.string(object?.url, `${at}.url`, 1, 2048);
  const method = v.oneOf(object?.method, `${at}.method`, ["GET", "HEAD"] as const);
  let normalizedUrl = rawUrl;
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) v.issue("url-credentials", `${at}.url`, "must not contain credentials");
    if (url.hash) v.issue("url-fragment", `${at}.url`, "must not contain a fragment");
    if (url.protocol !== "https:" && !(risk === "development" && url.protocol === "http:")) {
      v.issue("url-scheme", `${at}.url`, "must use HTTPS outside development");
    }
    if (!isPrivate && (!isPublicIpLiteral(url.hostname) || url.hostname === "localhost" || url.hostname.endsWith(".localhost"))) {
      v.issue("public-probe-target", `${at}.url`, "public probes must not target local, private, reserved or link-local addresses");
    }
    url.hostname = url.hostname.toLowerCase();
    normalizedUrl = url.toString();
  } catch {
    v.issue("invalid-url", `${at}.url`, "must be an absolute HTTP(S) URL");
  }
  const request: ProbeRequest = { url: normalizedUrl, method };
  if (object && Object.hasOwn(object, "timeoutMs")) {
    request.timeoutMs = v.integer(object.timeoutMs, `${at}.timeoutMs`, 100, 30_000);
  }
  if (object && Object.hasOwn(object, "maxResponseBytes")) {
    request.maxResponseBytes = v.integer(object.maxResponseBytes, `${at}.maxResponseBytes`, 1, 1024 * 1024);
  }
  if (object && Object.hasOwn(object, "followSameOriginRedirects")) {
    request.followSameOriginRedirects = v.boolean(object.followSameOriginRedirects, `${at}.followSameOriginRedirects`);
  }
  return request;
}

function normalizeAbsolutePath(v: Validator, value: unknown, at: string): string {
  const raw = v.string(value, at, 2, 1024);
  if (!raw.startsWith("/") || raw.includes("\\")) {
    v.issue("invalid-path", at, "must be an absolute POSIX path");
    return raw;
  }
  const normalized = path.posix.normalize(raw).replace(/\/$/, "") || "/";
  if (normalized === "/") v.issue("invalid-path", at, "must not select the filesystem root");
  return normalized;
}

function normalizeArtifactPath(v: Validator, value: unknown, at: string, projectRoot: string): string {
  const raw = v.string(value, at, 1, 500);
  if (path.posix.isAbsolute(raw) || raw.includes("\\")) {
    v.issue("invalid-artifact-path", at, "must be a relative POSIX path");
    return raw;
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    v.issue("path-traversal", at, "must stay inside the project checkout");
    return normalized;
  }
  const root = path.resolve(projectRoot);
  let cursor = root;
  for (const part of normalized.split("/")) {
    cursor = path.join(cursor, part);
    try {
      if (!fs.existsSync(cursor)) break;
      const resolved = fs.realpathSync(cursor);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        v.issue("symlink-escape", at, "resolves outside the project checkout");
        break;
      }
    } catch {
      v.issue("invalid-artifact-path", at, "could not inspect an existing path component");
      break;
    }
  }
  return normalized;
}

function validateStringArray(v: Validator, value: unknown, at: string, min = 0, max = 100): string[] {
  return v.array(value, at, min, max).map((item, index) => v.string(item, `${at}[${index}]`, 1, 500));
}

function validateConnectionReference(
  v: Validator,
  alias: unknown,
  at: string,
  connections: Record<string, { kind: string }>,
  expected: ConnectionKind,
): string {
  const name = validateId(v, alias, at);
  const connection = connections[name];
  if (!connection) v.issue("missing-connection", at, `references undeclared connection slot ${JSON.stringify(name)}`);
  else if (connection.kind !== expected) v.issue("connection-kind", at, `requires ${expected}, found ${connection.kind}`);
  return name;
}

function validateHttpExpectation(v: Validator, value: unknown, at: string): { status: number } {
  const object = v.object(value, at, ["status"], ["status"]);
  return { status: v.integer(object?.status, `${at}.status`, 100, 599) };
}

function validateDependency(
  v: Validator,
  value: unknown,
  at: string,
  risk: string,
  connections: Record<string, { kind: string }>,
): DependencyManifest {
  const base = v.object(value, at,
    ["id", "kind", "projectId", "connection", "request", "expect", "repository", "commit", "environment", "capability"],
    ["id", "kind", "expect"]);
  const id = validateId(v, base?.id, `${at}.id`);
  const kind = v.string(base?.kind, `${at}.kind`, 1, 100);
  if (!DEPENDENCY_KINDS.has(kind)) v.issue("unknown-kind", `${at}.kind`, `unsupported dependency kind ${JSON.stringify(kind)}`);

  if (kind === "http-status@1" || kind === "http-json@1") {
    const exact = v.object(value, at, ["id", "kind", "projectId", "connection", "request", "expect"], ["id", "kind", "request", "expect"]);
    const connection = exact && Object.hasOwn(exact, "connection")
      ? validateId(v, exact.connection, `${at}.connection`)
      : undefined;
    if (connection && !connections[connection]) v.issue("missing-connection", `${at}.connection`, "references an undeclared connection slot");
    const result: Record<string, unknown> = {
      id,
      kind,
      request: validateProbeRequest(v, exact?.request, `${at}.request`, risk, Boolean(connection)),
    };
    if (exact && Object.hasOwn(exact, "projectId")) result.projectId = validateProjectId(v, exact.projectId, `${at}.projectId`);
    if (connection) result.connection = connection;
    if (kind === "http-status@1") result.expect = validateHttpExpectation(v, exact?.expect, `${at}.expect`);
    else {
      const expect = v.object(exact?.expect, `${at}.expect`, ["status", "equals"], ["status", "equals"]);
      const equals = v.array(expect?.equals, `${at}.expect.equals`, 1, 50).map((entry, index) => {
        const equality = v.object(entry, `${at}.expect.equals[${index}]`, ["path", "value"], ["path", "value"]);
        const jsonPath = v.string(equality?.path, `${at}.expect.equals[${index}].path`, 2, 200);
        if (!/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(jsonPath)) {
          v.issue("invalid-json-path", `${at}.expect.equals[${index}].path`, "must be a simple absolute JSON property path");
        }
        const scalar = equality?.value;
        if (scalar !== null && !["string", "number", "boolean"].includes(typeof scalar)) {
          v.issue("type", `${at}.expect.equals[${index}].value`, "must be a JSON scalar");
        } else if (typeof scalar === "number" && !Number.isFinite(scalar)) {
          v.issue("type", `${at}.expect.equals[${index}].value`, "must be a finite JSON number");
        }
        return { path: jsonPath, value: scalar as string | number | boolean | null };
      });
      result.expect = { status: v.integer(expect?.status, `${at}.expect.status`, 100, 599), equals };
    }
    return result as unknown as DependencyManifest;
  }

  if (kind === "github-checks@1") {
    const exact = v.object(value, at, ["id", "kind", "connection", "repository", "commit", "expect"],
      ["id", "kind", "connection", "repository", "commit", "expect"]);
    const repository = v.string(exact?.repository, `${at}.repository`, 3, 200);
    if (!REPOSITORY_RE.test(repository)) v.issue("invalid-repository", `${at}.repository`, "must be owner/repository");
    const commit = v.string(exact?.commit, `${at}.commit`, 40, 40);
    if (!/^[a-f0-9]{40}$/.test(commit)) v.issue("invalid-commit", `${at}.commit`, "must be a full lowercase commit SHA");
    const expect = v.object(exact?.expect, `${at}.expect`, ["checks", "conclusion"], ["checks", "conclusion"]);
    return {
      id,
      kind,
      connection: validateConnectionReference(v, exact?.connection, `${at}.connection`, connections, "github-actions@1"),
      repository,
      commit,
      expect: {
        checks: validateStringArray(v, expect?.checks, `${at}.expect.checks`, 1, 50),
        conclusion: v.oneOf(expect?.conclusion, `${at}.expect.conclusion`, ["success"] as const),
      },
    } as DependencyManifest;
  }

  if (kind === "project-release@1") {
    const exact = v.object(value, at, ["id", "kind", "projectId", "environment", "capability", "expect"],
      ["id", "kind", "projectId", "environment", "capability", "expect"]);
    const expect = v.object(exact?.expect, `${at}.expect`, ["state"], ["state"]);
    return {
      id,
      kind,
      projectId: validateProjectId(v, exact?.projectId, `${at}.projectId`),
      environment: validateId(v, exact?.environment, `${at}.environment`),
      capability: validateId(v, exact?.capability, `${at}.capability`),
      expect: { state: v.oneOf(expect?.state, `${at}.expect.state`, ["active"] as const) },
    } as DependencyManifest;
  }

  if (kind === "werewolf-backup-policy@1") {
    const exact = v.object(value, at, ["id", "kind", "connection", "projectId", "environment", "expect"],
      ["id", "kind", "connection", "projectId", "environment", "expect"]);
    const expect = v.object(exact?.expect, `${at}.expect`, ["scheduled", "lastSuccessMaxAgeHours"],
      ["scheduled", "lastSuccessMaxAgeHours"]);
    return {
      id,
      kind,
      connection: validateConnectionReference(v, exact?.connection, `${at}.connection`, connections, "werewolf-api@1"),
      projectId: validateProjectId(v, exact?.projectId, `${at}.projectId`),
      environment: validateId(v, exact?.environment, `${at}.environment`),
      expect: {
        scheduled: v.boolean(expect?.scheduled, `${at}.expect.scheduled`),
        lastSuccessMaxAgeHours: v.integer(expect?.lastSuccessMaxAgeHours, `${at}.expect.lastSuccessMaxAgeHours`, 1, 24 * 30),
      },
    } as DependencyManifest;
  }

  return { id, kind } as unknown as DependencyManifest;
}

function validateResource(
  v: Validator,
  value: unknown,
  at: string,
  connections: Record<string, { kind: string }>,
): ResourceManifest {
  const base = v.object(value, at, ["id", "kind", "connection", "dependsOn", "desired"], ["id", "kind", "connection", "desired"]);
  const id = validateId(v, base?.id, `${at}.id`);
  const kind = v.string(base?.kind, `${at}.kind`, 1, 100);
  if (!RESOURCE_KINDS.has(kind)) v.issue("unknown-kind", `${at}.kind`, `unsupported resource kind ${JSON.stringify(kind)}`);
  const dependsOn = base && Object.hasOwn(base, "dependsOn")
    ? validateStringArray(v, base.dependsOn, `${at}.dependsOn`, 1, 100)
    : undefined;

  if (kind === "digitalocean-dns-record@1") {
    const desired = v.object(base?.desired, `${at}.desired`, ["zone", "type", "name", "valueFrom", "ttl"],
      ["zone", "type", "name", "valueFrom", "ttl"]);
    const valueFrom = v.object(desired?.valueFrom, `${at}.desired.valueFrom`, ["connection", "field"], ["connection", "field"]);
    return {
      id,
      kind,
      connection: validateConnectionReference(v, base?.connection, `${at}.connection`, connections, "digitalocean-api@1"),
      ...(dependsOn ? { dependsOn } : {}),
      desired: {
        zone: validateHostname(v, desired?.zone, `${at}.desired.zone`),
        type: v.oneOf(desired?.type, `${at}.desired.type`, ["A"] as const),
        name: validateId(v, desired?.name, `${at}.desired.name`),
        valueFrom: {
          connection: validateConnectionReference(v, valueFrom?.connection, `${at}.desired.valueFrom.connection`, connections, "ssh-host-helper@1"),
          field: v.oneOf(valueFrom?.field, `${at}.desired.valueFrom.field`, ["address"] as const),
        },
        ttl: v.integer(desired?.ttl, `${at}.desired.ttl`, 30, 86_400),
      },
    };
  }

  if (kind === "host-release-directory@1") {
    const desired = v.object(base?.desired, `${at}.desired`, ["root", "retainReleases"], ["root", "retainReleases"]);
    return {
      id,
      kind,
      connection: validateConnectionReference(v, base?.connection, `${at}.connection`, connections, "ssh-host-helper@1"),
      ...(dependsOn ? { dependsOn } : {}),
      desired: {
        root: normalizeAbsolutePath(v, desired?.root, `${at}.desired.root`),
        retainReleases: v.integer(desired?.retainReleases, `${at}.desired.retainReleases`, 5, 100),
      },
    };
  }

  if (kind === "nginx-static-site@1") {
    const desired = v.object(base?.desired, `${at}.desired`,
      ["hostname", "documentRoot", "spaFallback", "denyPrefixes", "cachePolicy", "securityHeaders"],
      ["hostname", "documentRoot", "spaFallback", "denyPrefixes", "cachePolicy", "securityHeaders"]);
    const denyPrefixes = validateStringArray(v, desired?.denyPrefixes, `${at}.desired.denyPrefixes`, 1, 30).map((prefix, index) => {
      if (!prefix.startsWith("/") || prefix.includes("\\") || prefix.includes("..")) {
        v.issue("invalid-url-path", `${at}.desired.denyPrefixes[${index}]`, "must be an absolute URL path prefix without traversal");
      }
      return prefix;
    });
    return {
      id,
      kind,
      connection: validateConnectionReference(v, base?.connection, `${at}.connection`, connections, "ssh-host-helper@1"),
      ...(dependsOn ? { dependsOn } : {}),
      desired: {
        hostname: validateHostname(v, desired?.hostname, `${at}.desired.hostname`),
        documentRoot: normalizeAbsolutePath(v, desired?.documentRoot, `${at}.desired.documentRoot`),
        spaFallback: v.boolean(desired?.spaFallback, `${at}.desired.spaFallback`),
        denyPrefixes,
        cachePolicy: v.oneOf(desired?.cachePolicy, `${at}.desired.cachePolicy`, ["vite-hashed", "no-cache"] as const),
        securityHeaders: v.oneOf(desired?.securityHeaders, `${at}.desired.securityHeaders`, ["werewolf-static-spa@1"] as const),
      },
    };
  }

  if (kind === "letsencrypt-certificate@1") {
    const desired = v.object(base?.desired, `${at}.desired`, ["hostname", "renewal"], ["hostname", "renewal"]);
    return {
      id,
      kind,
      connection: validateConnectionReference(v, base?.connection, `${at}.connection`, connections, "ssh-host-helper@1"),
      ...(dependsOn ? { dependsOn } : {}),
      desired: {
        hostname: validateHostname(v, desired?.hostname, `${at}.desired.hostname`),
        renewal: v.oneOf(desired?.renewal, `${at}.desired.renewal`, ["automatic"] as const),
      },
    };
  }

  if (kind === "systemd-node-service@1") {
    const desired = v.object(base?.desired, `${at}.desired`, ["entry", "healthPath", "startupTimeoutSeconds", "memoryMaxMb", "config", "switching", "drainSeconds"],
      ["entry", "healthPath", "startupTimeoutSeconds", "memoryMaxMb", "config"]);
    if (desired?.switching !== undefined && desired.switching !== "health-checked") v.issue("unsupported", `${at}.desired.switching`, "must be health-checked, or omitted to restart in place");
    if (desired?.drainSeconds !== undefined && desired.switching !== "health-checked") v.issue("unsupported", `${at}.desired.drainSeconds`, "needs switching: health-checked");
    const rawConfig = v.object(desired?.config, `${at}.desired.config`, Object.keys((desired?.config as object | undefined) ?? {}));
    const config: Record<string, string> = {};
    if (rawConfig) {
      if (Object.keys(rawConfig).length > 64) v.issue("range", `${at}.desired.config`, "must contain no more than 64 entries");
      for (const [name, rawValue] of Object.entries(rawConfig).sort(([a], [b]) => a.localeCompare(b))) {
        const valueAt = `${at}.desired.config.${name}`;
        validateEnvironmentName(v, name, valueAt);
        // Config is committed and shown in plans: anything secret-shaped belongs in service-secrets@1.
        if (SECRET_KEY_RE.test(name)) v.issue("secret-shaped", valueAt, `${name} looks like a secret; declare it in a service-secrets@1 resource instead`);
        const value = v.string(rawValue, valueAt, 0, 4096);
        if (hasSecretShape(value)) v.issue("secret-shaped", valueAt, "value resembles credential material; declare it as a secret instead");
        config[name] = value;
      }
    }
    const healthPath = v.string(desired?.healthPath, `${at}.desired.healthPath`, 1, 200);
    if (!URL_PATH_RE.test(healthPath)) v.issue("invalid-url-path", `${at}.desired.healthPath`, "must be an absolute URL path");
    return {
      id,
      kind,
      connection: validateConnectionReference(v, base?.connection, `${at}.connection`, connections, "ssh-host-helper@1"),
      ...(dependsOn ? { dependsOn } : {}),
      desired: {
        entry: validateRelativeFile(v, desired?.entry, `${at}.desired.entry`),
        healthPath,
        startupTimeoutSeconds: v.integer(desired?.startupTimeoutSeconds, `${at}.desired.startupTimeoutSeconds`, 5, 300),
        memoryMaxMb: v.integer(desired?.memoryMaxMb, `${at}.desired.memoryMaxMb`, 64, 4096),
        config,
        ...(desired?.switching === "health-checked" ? { switching: "health-checked" as const } : {}),
        ...(desired?.drainSeconds !== undefined ? { drainSeconds: v.integer(desired.drainSeconds, `${at}.desired.drainSeconds`, 1, 60) } : {}),
      },
    };
  }

  if (kind === "service-secrets@1") {
    const desired = v.object(base?.desired, `${at}.desired`, ["names"], ["names"]);
    const names = validateStringArray(v, desired?.names, `${at}.desired.names`, 1, 64);
    names.forEach((name, index) => validateEnvironmentName(v, name, `${at}.desired.names[${index}]`));
    if (new Set(names).size !== names.length) v.issue("duplicate-id", `${at}.desired.names`, "names must be unique");
    return {
      id,
      kind,
      connection: validateConnectionReference(v, base?.connection, `${at}.connection`, connections, "ssh-host-helper@1"),
      ...(dependsOn ? { dependsOn } : {}),
      desired: { names: [...names].sort() },
    };
  }

  if (kind === "nginx-node-proxy@1") {
    const desired = v.object(base?.desired, `${at}.desired`, ["hostname", "securityHeaders", "maxBodyMb"], ["hostname", "securityHeaders", "maxBodyMb"]);
    return {
      id,
      kind,
      connection: validateConnectionReference(v, base?.connection, `${at}.connection`, connections, "ssh-host-helper@1"),
      ...(dependsOn ? { dependsOn } : {}),
      desired: {
        hostname: validateHostname(v, desired?.hostname, `${at}.desired.hostname`),
        securityHeaders: v.oneOf(desired?.securityHeaders, `${at}.desired.securityHeaders`, ["app-managed@1"] as const),
        maxBodyMb: v.integer(desired?.maxBodyMb, `${at}.desired.maxBodyMb`, 1, 100),
      },
    };
  }

  return { id, kind, connection: "", desired: {} } as unknown as ResourceManifest;
}

/** A canonical relative file path such as bin/www: no traversal, spaces or shell characters. */
function validateRelativeFile(v: Validator, value: unknown, at: string): string {
  const raw = v.string(value, at, 1, 200);
  if (!/^[A-Za-z0-9._/-]+$/.test(raw) || raw.startsWith("/") || path.posix.normalize(raw) !== raw || raw.split("/").some((part) => !part || part === "." || part === "..")) {
    v.issue("invalid-path", at, "must be a canonical relative path without traversal");
  }
  return raw;
}

function validateVerification(
  v: Validator,
  value: unknown,
  at: string,
  risk: string,
  connections: Record<string, { kind: string }>,
): VerificationManifest {
  const base = v.object(value, at, ["id", "kind", "request", "expect", "projectId", "connection"], ["id", "kind", "request", "expect"]);
  const id = validateId(v, base?.id, `${at}.id`);
  const kind = v.string(base?.kind, `${at}.kind`, 1, 100);
  if (!VERIFICATION_KINDS.has(kind)) v.issue("unknown-kind", `${at}.kind`, `unsupported verification kind ${JSON.stringify(kind)}`);
  if (kind === "release-metadata@1") {
    const exact = v.object(value, at, ["id", "kind", "request", "expect"], ["id", "kind", "request", "expect"]);
    const expect = v.object(exact?.expect, `${at}.expect`, ["commit", "psmArtifactId", "version"], ["commit", "psmArtifactId"]);
    const commit = v.oneOf(expect?.commit, `${at}.expect.commit`, ["$release.commit"] as const);
    const psmArtifactId = v.oneOf(expect?.psmArtifactId, `${at}.expect.psmArtifactId`, ["$release.psmArtifactId"] as const);
    const result: Record<string, unknown> = {
      id,
      kind,
      request: validateProbeRequest(v, exact?.request, `${at}.request`, risk, false),
      expect: { commit, psmArtifactId },
    };
    if (expect && Object.hasOwn(expect, "version")) {
      (result.expect as Record<string, unknown>).version = v.oneOf(expect.version, `${at}.expect.version`, ["$release.version"] as const);
    }
    return result as unknown as VerificationManifest;
  }
  return validateDependency(v, value, at, risk, connections) as VerificationManifest;
}

function validateUnit(
  v: Validator,
  value: unknown,
  at: string,
  risk: string,
  connections: Record<string, { kind: string }>,
  projectRoot: string,
): UnitManifest {
  const object = v.object(value, at,
    ["id", "recipe", "resourceRefs", "artifact", "executor", "target", "verification"],
    ["id", "recipe", "resourceRefs", "artifact", "executor", "target", "verification"]);
  const id = validateId(v, object?.id, `${at}.id`);
  const recipe = v.oneOf(object?.recipe, `${at}.recipe`, ["static-ssh-nginx@1", "node-service-ssh-nginx@1"] as const);
  const resourceRefs = validateStringArray(v, object?.resourceRefs, `${at}.resourceRefs`, 1, 50);
  const service = recipe === "node-service-ssh-nginx@1";

  const artifact = service
    ? v.object(object?.artifact, `${at}.artifact`,
      ["kind", "runtime", "install", "buildScript", "serviceRoot", "entry", "publicDir", "buildProfile"],
      ["kind", "runtime", "install", "buildScript", "serviceRoot", "entry", "publicDir", "buildProfile"])
    : v.object(object?.artifact, `${at}.artifact`, ["kind", "output", "buildProfile"], ["kind", "output", "buildProfile"]);
  const buildProfile = v.object(artifact?.buildProfile, `${at}.artifact.buildProfile`, ["id", "publicInputs"], ["id", "publicInputs"]);
  const publicInputsObject = v.object(buildProfile?.publicInputs, `${at}.artifact.buildProfile.publicInputs`, Object.keys((buildProfile?.publicInputs as object | undefined) ?? {}));
  const publicInputs: Record<string, string> = {};
  if (publicInputsObject) {
    if (Object.keys(publicInputsObject).length > 100) v.issue("range", `${at}.artifact.buildProfile.publicInputs`, "must contain no more than 100 entries");
    for (const [key, rawValue] of Object.entries(publicInputsObject).sort(([a], [b]) => a.localeCompare(b))) {
      if (!PUBLIC_INPUT_RE.test(key)) v.issue("invalid-public-input", `${at}.artifact.buildProfile.publicInputs.${key}`, "key must be uppercase env-style text");
      if (SECRET_KEY_RE.test(key)) v.issue("secret-shaped", `${at}.artifact.buildProfile.publicInputs.${key}`, "secret-shaped public input keys are forbidden");
      const stringValue = v.string(rawValue, `${at}.artifact.buildProfile.publicInputs.${key}`, 0, 2048);
      if (hasSecretShape(stringValue)) v.issue("secret-shaped", `${at}.artifact.buildProfile.publicInputs.${key}`, "value resembles credential material");
      publicInputs[key] = stringValue;
    }
  }

  const executor = v.object(object?.executor, `${at}.executor`,
    ["kind", "connection", "sourceRepository", "prepareWorkflow", "releaseController"],
    ["kind", "connection", "sourceRepository", "prepareWorkflow", "releaseController"]);
  const sourceRepository = v.string(executor?.sourceRepository, `${at}.executor.sourceRepository`, 3, 200);
  if (!REPOSITORY_RE.test(sourceRepository)) v.issue("invalid-repository", `${at}.executor.sourceRepository`, "must be owner/repository");
  const prepareWorkflow = v.string(executor?.prepareWorkflow, `${at}.executor.prepareWorkflow`, 5, 200);
  if (!WORKFLOW_RE.test(prepareWorkflow)) v.issue("invalid-workflow", `${at}.executor.prepareWorkflow`, "must be a workflow filename ending in .yml or .yaml");

  const target = v.object(object?.target, `${at}.target`, ["kind", "targetId", "observerConnection", "root"],
    ["kind", "targetId", "observerConnection", "root"]);
  const targetId = v.string(target?.targetId, `${at}.target.targetId`, 1, 200);
  if (!TARGET_ID_RE.test(targetId)) v.issue("invalid-target-id", `${at}.target.targetId`, "contains unsupported characters");

  const profile = { id: validateId(v, buildProfile?.id, `${at}.artifact.buildProfile.id`), publicInputs };
  let unitArtifact: UnitManifest["artifact"];
  if (service) {
    const buildScript = v.string(artifact?.buildScript, `${at}.artifact.buildScript`, 1, 64);
    if (!SCRIPT_NAME_RE.test(buildScript)) v.issue("invalid-script", `${at}.artifact.buildScript`, "must be the name of a package.json script");
    unitArtifact = {
      kind: v.oneOf(artifact?.kind, `${at}.artifact.kind`, ["node-service@1"] as const),
      runtime: v.oneOf(artifact?.runtime, `${at}.artifact.runtime`, ["node@20", "node@22", "node@24"] as const),
      install: v.array(artifact?.install, `${at}.artifact.install`, 1, 10)
        .map((dir, index) => dir === "." ? "." : normalizeArtifactPath(v, dir, `${at}.artifact.install[${index}]`, projectRoot)),
      buildScript,
      serviceRoot: normalizeArtifactPath(v, artifact?.serviceRoot, `${at}.artifact.serviceRoot`, projectRoot),
      entry: validateRelativeFile(v, artifact?.entry, `${at}.artifact.entry`),
      publicDir: validateRelativeFile(v, artifact?.publicDir, `${at}.artifact.publicDir`),
      buildProfile: profile,
    };
  } else {
    unitArtifact = {
      kind: v.oneOf(artifact?.kind, `${at}.artifact.kind`, ["static-files@1"] as const),
      output: normalizeArtifactPath(v, artifact?.output, `${at}.artifact.output`, projectRoot),
      buildProfile: profile,
    };
  }

  return {
    id,
    recipe,
    resourceRefs,
    artifact: unitArtifact,
    executor: {
      kind: v.oneOf(executor?.kind, `${at}.executor.kind`, ["github-actions@1"] as const),
      connection: validateConnectionReference(v, executor?.connection, `${at}.executor.connection`, connections, "github-actions@1"),
      sourceRepository,
      prepareWorkflow,
      releaseController: v.oneOf(executor?.releaseController, `${at}.executor.releaseController`, ["werewolf-static@1"] as const),
    },
    target: {
      kind: v.oneOf(target?.kind, `${at}.target.kind`, ["ssh-release-directory@1"] as const),
      targetId,
      observerConnection: validateConnectionReference(v, target?.observerConnection, `${at}.target.observerConnection`, connections, "ssh-host-helper@1"),
      root: normalizeAbsolutePath(v, target?.root, `${at}.target.root`),
    },
    verification: v.array(object?.verification, `${at}.verification`, 1, 50)
      .map((probe, index) => validateVerification(v, probe, `${at}.verification[${index}]`, risk, connections)),
  } as UnitManifest;
}

function validateBranch(v: Validator, value: unknown, at: string): string {
  const branch = v.string(value, at, 1, 250);
  if (branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".")
    || branch.includes("..") || /[\s~^:?*[\\]/.test(branch) || branch.includes("@{")) {
    v.issue("invalid-branch", at, "must be a safe Git branch name");
  }
  return branch;
}

function validateResourceReference(v: Validator, reference: string, at: string): { id: string; substate?: string } | null {
  const match = /^resource:([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:#([a-z][a-z0-9-]*))?$/.exec(reference);
  if (!match) {
    v.issue("invalid-reference", at, "must be a typed resource:<id> reference");
    return null;
  }
  return { id: match[1], ...(match[2] ? { substate: match[2] } : {}) };
}

function validateEnvironment(v: Validator, value: unknown, at: string, projectRoot: string): EnvironmentManifest {
  const object = v.object(value, at,
    ["id", "risk", "releasePolicy", "connections", "dependencies", "resources", "units", "watch", "policy"],
    ["id", "risk", "releasePolicy", "connections", "dependencies", "resources", "units", "watch", "policy"]);
  const id = validateId(v, object?.id, `${at}.id`);
  const risk = v.oneOf(object?.risk, `${at}.risk`, ["development", "staging", "production"] as const);

  const releasePolicyObject = v.object(object?.releasePolicy, `${at}.releasePolicy`,
    ["allowedBranch", "requireReachableFromBranch", "requireChecks", "approval"],
    ["allowedBranch", "requireReachableFromBranch", "requireChecks", "approval"]);
  const releasePolicy = {
    allowedBranch: validateBranch(v, releasePolicyObject?.allowedBranch, `${at}.releasePolicy.allowedBranch`),
    requireReachableFromBranch: v.boolean(releasePolicyObject?.requireReachableFromBranch, `${at}.releasePolicy.requireReachableFromBranch`),
    requireChecks: v.boolean(releasePolicyObject?.requireChecks, `${at}.releasePolicy.requireChecks`),
    approval: v.oneOf(releasePolicyObject?.approval, `${at}.releasePolicy.approval`, ["authenticated-local-operator", "none"] as const),
  };

  const rawConnections = v.object(object?.connections, `${at}.connections`, Object.keys((object?.connections as object | undefined) ?? {}));
  const connections: Record<string, { kind: ConnectionKind }> = {};
  if (rawConnections) {
    if (Object.keys(rawConnections).length > 30) v.issue("range", `${at}.connections`, "must contain no more than 30 slots");
    for (const [alias, rawConnection] of Object.entries(rawConnections).sort(([a], [b]) => a.localeCompare(b))) {
      validateId(v, alias, `${at}.connections.${alias}`);
      const connection = v.object(rawConnection, `${at}.connections.${alias}`, ["kind"], ["kind"]);
      const kind = v.string(connection?.kind, `${at}.connections.${alias}.kind`, 1, 100) as ConnectionKind;
      if (!CONNECTION_KINDS.has(kind)) v.issue("unknown-kind", `${at}.connections.${alias}.kind`, `unsupported connection kind ${JSON.stringify(kind)}`);
      connections[alias] = { kind };
    }
  }

  const dependencies = v.array(object?.dependencies, `${at}.dependencies`, 0, 100)
    .map((dependency, index) => validateDependency(v, dependency, `${at}.dependencies[${index}]`, risk, connections));
  const resources = v.array(object?.resources, `${at}.resources`, 1, 100)
    .map((resource, index) => validateResource(v, resource, `${at}.resources[${index}]`, connections));
  const units = v.array(object?.units, `${at}.units`, 1, 30)
    .map((unit, index) => validateUnit(v, unit, `${at}.units[${index}]`, risk, connections, projectRoot));

  const watch = v.array(object?.watch, `${at}.watch`, 0, 50).map((entry, index) => {
    const watchAt = `${at}.watch[${index}]`;
    const watchObject = v.object(entry, watchAt,
      ["id", "kind", "connection", "unit", "monitorKey", "hostname", "maxObservationAgeSeconds"],
      ["id", "kind", "connection", "unit", "monitorKey", "hostname", "maxObservationAgeSeconds"]);
    return {
      id: validateId(v, watchObject?.id, `${watchAt}.id`),
      kind: v.oneOf(watchObject?.kind, `${watchAt}.kind`, ["external-http-monitor@1"] as const),
      connection: validateConnectionReference(v, watchObject?.connection, `${watchAt}.connection`, connections, "external-monitor@1"),
      unit: validateId(v, watchObject?.unit, `${watchAt}.unit`),
      monitorKey: v.string(watchObject?.monitorKey, `${watchAt}.monitorKey`, 1, 200),
      hostname: validateHostname(v, watchObject?.hostname, `${watchAt}.hostname`),
      maxObservationAgeSeconds: v.integer(watchObject?.maxObservationAgeSeconds, `${watchAt}.maxObservationAgeSeconds`, 30, 86_400),
    };
  });

  const policyObject = v.object(object?.policy, `${at}.policy`,
    ["planTtlSeconds", "rollbackOnVerificationFailure", "allowDelete", "requireFreshWatchBeforeRelease"],
    ["planTtlSeconds", "rollbackOnVerificationFailure", "allowDelete", "requireFreshWatchBeforeRelease"]);
  const policy = {
    planTtlSeconds: v.integer(policyObject?.planTtlSeconds, `${at}.policy.planTtlSeconds`, 60, 3600),
    rollbackOnVerificationFailure: v.boolean(policyObject?.rollbackOnVerificationFailure, `${at}.policy.rollbackOnVerificationFailure`),
    allowDelete: v.boolean(policyObject?.allowDelete, `${at}.policy.allowDelete`),
    requireFreshWatchBeforeRelease: v.boolean(policyObject?.requireFreshWatchBeforeRelease, `${at}.policy.requireFreshWatchBeforeRelease`),
  };

  const seen = new Map<string, string>();
  for (const [category, entries] of [
    ["dependency", dependencies as Array<{ id: string }>],
    ["resource", resources as Array<{ id: string }>],
    ["unit", units as Array<{ id: string }>],
    ["watch", watch as Array<{ id: string }>],
  ] as const) {
    entries.forEach((entry, index) => {
      const previous = seen.get(entry.id);
      if (previous) v.issue("duplicate-id", `${at}.${category === "dependency" ? "dependencies" : `${category}s`}[${index}].id`, `duplicates environment ID already used by ${previous}`);
      else seen.set(entry.id, `${category}:${entry.id}`);
    });
  }
  units.forEach((unit, unitIndex) => {
    unit.verification.forEach((verification, verificationIndex) => {
      const previous = seen.get(verification.id);
      const issueAt = `${at}.units[${unitIndex}].verification[${verificationIndex}].id`;
      if (previous) v.issue("duplicate-id", issueAt, `duplicates environment ID already used by ${previous}`);
      else seen.set(verification.id, `verification:${unit.id}/${verification.id}`);
    });
  });

  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
  const allowedSubstates: Record<string, Set<string>> = {
    "nginx-static-site@1": new Set(["http-ready", "tls-ready"]),
    "nginx-node-proxy@1": new Set(["http-ready", "tls-ready"]),
    "letsencrypt-certificate@1": new Set(["certificate-ready"]),
  };
  resources.forEach((resource, resourceIndex) => {
    const dependencyRefs = new Set<string>();
    resource.dependsOn?.forEach((reference, referenceIndex) => {
      const referenceAt = `${at}.resources[${resourceIndex}].dependsOn[${referenceIndex}]`;
      if (dependencyRefs.has(reference)) v.issue("duplicate-reference", referenceAt, `${reference} is listed more than once`);
      dependencyRefs.add(reference);
      const parsed = validateResourceReference(v, reference, referenceAt);
      if (!parsed) return;
      const targetResource = resourceById.get(parsed.id);
      if (!targetResource) v.issue("missing-reference", referenceAt, `resource ${parsed.id} does not exist`);
      if (parsed.id === resource.id) v.issue("cyclic-reference", referenceAt, "a resource cannot depend on itself");
      if (parsed.substate && targetResource && !allowedSubstates[targetResource.kind]?.has(parsed.substate)) {
        v.issue("invalid-substate", referenceAt, `${targetResource.kind} does not expose #${parsed.substate}`);
      }
    });
  });

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (resourceId: string): void => {
    if (visiting.has(resourceId)) {
      v.issue("cyclic-reference", `${at}.resources`, `resource dependency cycle includes ${resourceId}`);
      return;
    }
    if (visited.has(resourceId)) return;
    visiting.add(resourceId);
    const resource = resourceById.get(resourceId);
    for (const reference of resource?.dependsOn ?? []) {
      const match = /^resource:([^#]+)/.exec(reference);
      if (match && resourceById.has(match[1])) visit(match[1]);
    }
    visiting.delete(resourceId);
    visited.add(resourceId);
  };
  for (const resource of resources) visit(resource.id);

  units.forEach((unit, unitIndex) => {
    const refs = new Set<string>();
    unit.resourceRefs.forEach((reference, referenceIndex) => {
      const refAt = `${at}.units[${unitIndex}].resourceRefs[${referenceIndex}]`;
      const parsed = validateResourceReference(v, reference, refAt);
      if (!parsed) return;
      if (parsed.substate) v.issue("invalid-reference", refAt, "unit resourceRefs must name the whole resource, not a substate");
      if (!resourceById.has(parsed.id)) v.issue("missing-reference", refAt, `resource ${parsed.id} does not exist`);
      if (refs.has(parsed.id)) v.issue("duplicate-reference", refAt, `resource ${parsed.id} is referenced more than once`);
      refs.add(parsed.id);
    });
    const requiredKinds = unit.recipe === "node-service-ssh-nginx@1"
      ? ["digitalocean-dns-record@1", "host-release-directory@1", "systemd-node-service@1", "nginx-node-proxy@1", "letsencrypt-certificate@1"]
      : ["digitalocean-dns-record@1", "host-release-directory@1", "nginx-static-site@1", "letsencrypt-certificate@1"];
    const referenced = [...refs].map((ref) => resourceById.get(ref)).filter(Boolean) as ResourceManifest[];
    for (const kind of requiredKinds) {
      const count = referenced.filter((resource) => resource.kind === kind).length;
      if (count !== 1) v.issue("recipe-resource-set", `${at}.units[${unitIndex}].resourceRefs`, `${unit.recipe} requires exactly one ${kind}; found ${count}`);
    }
    const allowedKinds = new Set([...requiredKinds, ...(unit.recipe === "node-service-ssh-nginx@1" ? ["service-secrets@1"] : [])]);
    for (const resource of referenced) {
      if (!allowedKinds.has(resource.kind)) v.issue("recipe-resource-set", `${at}.units[${unitIndex}].resourceRefs`, `${unit.recipe} cannot assemble ${resource.kind}`);
    }
    if (referenced.filter((resource) => resource.kind === "service-secrets@1").length > 1) {
      v.issue("recipe-resource-set", `${at}.units[${unitIndex}].resourceRefs`, `${unit.recipe} takes at most one service-secrets@1`);
    }
    if (unit.recipe === "node-service-ssh-nginx@1") {
      const serviceResource = referenced.find((resource) => resource.kind === "systemd-node-service@1");
      const secrets = referenced.find((resource) => resource.kind === "service-secrets@1");
      const proxy = referenced.find((resource) => resource.kind === "nginx-node-proxy@1");
      const certificate = referenced.find((resource) => resource.kind === "letsencrypt-certificate@1");
      const directoryResource = referenced.find((resource) => resource.kind === "host-release-directory@1");
      if (directoryResource?.kind === "host-release-directory@1" && directoryResource.desired.root !== unit.target.root) {
        v.issue("target-root-mismatch", `${at}.units[${unitIndex}].target.root`, "must equal the referenced release-directory root");
      }
      if (serviceResource?.kind === "systemd-node-service@1" && unit.artifact.kind === "node-service@1" && serviceResource.desired.entry !== unit.artifact.entry) {
        v.issue("entry-mismatch", `${at}.units[${unitIndex}].artifact.entry`, "must equal the service resource's entry");
      }
      if (serviceResource?.kind === "systemd-node-service@1" && secrets?.kind === "service-secrets@1") {
        for (const name of secrets.desired.names) {
          if (Object.hasOwn(serviceResource.desired.config, name)) v.issue("config-secret-overlap", `${at}.units[${unitIndex}]`, `${name} is both config and a secret`);
        }
      }
      if (proxy?.kind === "nginx-node-proxy@1" && certificate?.kind === "letsencrypt-certificate@1" && proxy.desired.hostname !== certificate.desired.hostname) {
        v.issue("hostname-mismatch", `${at}.units[${unitIndex}]`, "ingress and TLS hostnames must match");
      }
      return;
    }
    const directory = referenced.find((resource) => resource.kind === "host-release-directory@1");
    const ingress = referenced.find((resource) => resource.kind === "nginx-static-site@1");
    const tls = referenced.find((resource) => resource.kind === "letsencrypt-certificate@1");
    if (directory?.kind === "host-release-directory@1" && directory.desired.root !== unit.target.root) {
      v.issue("target-root-mismatch", `${at}.units[${unitIndex}].target.root`, "must equal the referenced release-directory root");
    }
    if (ingress?.kind === "nginx-static-site@1") {
      if (ingress.desired.documentRoot !== `${unit.target.root}/current`) {
        v.issue("document-root-mismatch", `${at}.units[${unitIndex}]`, "ingress documentRoot must be target root plus /current");
      }
      if (!ingress.desired.spaFallback || !ingress.desired.denyPrefixes.includes("/api/")) {
        v.issue("recipe-invariant", `${at}.units[${unitIndex}]`, "static SPA ingress must enable fallback and seal /api/");
      }
      if (tls?.kind === "letsencrypt-certificate@1" && tls.desired.hostname !== ingress.desired.hostname) {
        v.issue("hostname-mismatch", `${at}.units[${unitIndex}]`, "ingress and TLS hostnames must match");
      }
    }
  });

  const unitIds = new Set(units.map((unit) => unit.id));
  const targetIds = new Set<string>();
  const targetRoots = new Set<string>();
  const exclusivelyOwnedResources = new Map<string, string>();
  units.forEach((unit, unitIndex) => {
    if (targetIds.has(unit.target.targetId)) v.issue("duplicate-target", `${at}.units[${unitIndex}].target.targetId`, "target ID must be unique in an environment");
    if (targetRoots.has(unit.target.root)) v.issue("duplicate-target", `${at}.units[${unitIndex}].target.root`, "target root must be unique in an environment");
    targetIds.add(unit.target.targetId);
    targetRoots.add(unit.target.root);
    for (const reference of unit.resourceRefs) {
      const parsed = /^resource:([^#]+)$/.exec(reference);
      const resource = parsed ? resourceById.get(parsed[1]) : undefined;
      if (!resource || resource.kind === "digitalocean-dns-record@1") continue;
      const previous = exclusivelyOwnedResources.get(resource.id);
      if (previous) v.issue("shared-recipe-resource", `${at}.units[${unitIndex}].resourceRefs`, `${resource.kind} ${resource.id} is already assembled by unit ${previous}`);
      else exclusivelyOwnedResources.set(resource.id, unit.id);
    }
  });
  watch.forEach((entry, index) => {
    if (!unitIds.has(entry.unit)) v.issue("missing-reference", `${at}.watch[${index}].unit`, `unit ${entry.unit} does not exist`);
  });
  if (policy.requireFreshWatchBeforeRelease && watch.length === 0) {
    v.issue("recipe-invariant", `${at}.watch`, "must configure Watch when requireFreshWatchBeforeRelease is true");
  }

  return { id, risk, releasePolicy, connections, dependencies, resources, units, watch, policy };
}

function resolveContext(options: ManifestValidationOptions, v: Validator): { root: string; projectId: string; packageVersion: string } {
  let root = path.resolve(options.projectRoot);
  try {
    root = fs.realpathSync(root);
  } catch (error) {
    v.issue("project-root-unavailable", "$.context.projectRoot", `could not resolve project root: ${error instanceof Error ? error.message : String(error)}`);
  }
  let projectId = options.identityProjectId ?? options.expectedProjectId ?? "";
  if (!options.identityProjectId) {
    try {
      const identityPath = path.join(root, ".psm", "identity.json");
      const identityStat = fs.lstatSync(identityPath);
      if (!identityStat.isFile() || identityStat.isSymbolicLink()) throw new Error("identity.json must be a regular, non-symlink file");
      const identity = JSON.parse(fs.readFileSync(identityPath, "utf8")) as unknown;
      const object = v.object(identity, "$.context.identity", ["version", "id", "name", "createdAt"], ["id"]);
      projectId = validateProjectId(v, object?.id, "$.context.identity.id");
    } catch (error) {
      v.issue("identity-unavailable", "$.context.identity", `could not read .psm/identity.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (options.expectedProjectId && projectId && projectId !== options.expectedProjectId) {
    v.issue("project-id-mismatch", "$.context.identity.id", "does not match the expected project ID");
  }

  let packageVersion = options.packageVersion ?? "";
  if (options.packageVersion === undefined) {
    try {
      const packagePath = path.join(root, "package.json");
      const packageStat = fs.lstatSync(packagePath);
      if (!packageStat.isFile() || packageStat.isSymbolicLink()) throw new Error("package.json must be a regular, non-symlink file");
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as Record<string, unknown>;
      packageVersion = typeof packageJson.version === "string" ? packageJson.version : "";
    } catch (error) {
      v.issue("package-unavailable", "$.context.package", `could not read repo-root package.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!VERSION_RE.test(packageVersion)) {
    v.issue("invalid-version", "$.context.package.version", "repo-root package.json version must be X.Y.Z using non-negative integers");
  }
  return { root, projectId, packageVersion };
}

/**
 * Strictly validates and normalizes an already-decoded v1 manifest. This is pure except for
 * read-only repository containment and context checks named by `options`.
 */
export function parseDeploymentManifest(document: unknown, options: ManifestValidationOptions): DeploymentManifestV1 {
  const v = new Validator();
  scanSecretShapes(v, document, "$");
  const context = resolveContext(options, v);
  const object = v.object(document, "$", ["apiVersion", "kind", "projectId", "environments"],
    ["apiVersion", "kind", "projectId", "environments"]);
  const apiVersion = v.oneOf(object?.apiVersion, "$.apiVersion", [DEPLOYMENT_API_VERSION] as const);
  const kind = v.oneOf(object?.kind, "$.kind", [DEPLOYMENT_MANIFEST_KIND] as const);
  const projectId = validateProjectId(v, object?.projectId, "$.projectId");
  if (context.projectId && projectId !== context.projectId) {
    v.issue("project-id-mismatch", "$.projectId", "must equal the committed .psm/identity.json ID");
  }
  const environments = v.array(object?.environments, "$.environments", 1, 30)
    .map((environment, index) => validateEnvironment(v, environment, `$.environments[${index}]`, context.root));
  const environmentIds = new Set<string>();
  environments.forEach((environment, index) => {
    if (environmentIds.has(environment.id)) v.issue("duplicate-id", `$.environments[${index}].id`, "environment ID must be unique");
    environmentIds.add(environment.id);
  });
  if (v.issues.length) throw new DeploymentManifestValidationError(v.issues);
  return { apiVersion, kind, projectId, environments };
}

/** Reads `.psm/deployments.json`, returning null when a project has not adopted managed deploy. */
export function loadDeploymentManifest(projectRoot: string, expectedProjectId?: string): LoadedDeploymentManifest | null {
  // A project whose directory has been moved, deleted or unmounted has not adopted managed
  // deploy either. Letting the raw errno out here turns that into a 500 carrying a filesystem
  // path, which is both a leak and a worse answer than "there is no manifest".
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(projectRoot));
  } catch (error) {
    if (ABSENT.has(String((error as NodeJS.ErrnoException).code))) return null;
    throw error;
  }
  const manifestPath = path.join(root, ".psm", "deployments.json");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(manifestPath);
  } catch (error) {
    if (ABSENT.has(String((error as NodeJS.ErrnoException).code))) return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new DeploymentManifestValidationError([{ code: "not-file", path: "$", message: `${manifestPath} is not a regular file` }]);
  }
  if (stat.size > MAX_MANIFEST_BYTES) {
    throw new DeploymentManifestValidationError([{ code: "manifest-too-large", path: "$", message: `manifest exceeds ${MAX_MANIFEST_BYTES} bytes` }]);
  }
  let document: unknown;
  try {
    document = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new DeploymentManifestValidationError([{ code: "invalid-json", path: "$", message: error instanceof Error ? error.message : String(error) }]);
  }
  const manifest = parseDeploymentManifest(document, { projectRoot: root, expectedProjectId });
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  return {
    manifest,
    manifestPath,
    projectRoot: root,
    projectId: manifest.projectId,
    packageVersion: packageJson.version,
  };
}

export function deploymentManifestIssues(document: unknown, options: ManifestValidationOptions): ManifestValidationIssue[] {
  try {
    parseDeploymentManifest(document, options);
    return [];
  } catch (error) {
    if (error instanceof DeploymentManifestValidationError) return error.issues;
    throw error;
  }
}
