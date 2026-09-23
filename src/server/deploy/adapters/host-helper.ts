import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { minimalEnvironment, SecretBroker, type ConnectionProfile } from "../connections.ts";
import type { JsonValue } from "../store.ts";

export const HOST_HELPER_REQUEST_SCHEMA = "psm.werewolf.solutions/host-helper-request/v1" as const;
export const HOST_HELPER_RESPONSE_SCHEMA = "psm.werewolf.solutions/host-helper-response/v1" as const;

const MAX_HEADER_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface HostHelperRequest {
  schema: typeof HOST_HELPER_REQUEST_SCHEMA;
  requestId: string;
  targetId: string;
  operation: string;
  idempotencyKey?: string;
  planDigest?: string;
  expiresAt?: string;
  archiveBytes?: number;
  desired: JsonValue;
}

export interface HostHelperResponse {
  schema: typeof HOST_HELPER_RESPONSE_SCHEMA;
  requestId: string;
  targetId: string;
  operation: string;
  outcome: "succeeded" | "failed";
  code: string;
  detail: string;
  observedAt: string;
  data?: JsonValue;
}

export interface HostHelperInvocation {
  connection: ConnectionProfile;
  request: HostHelperRequest;
  archive?: Uint8Array;
  signal?: AbortSignal;
}

export interface HostHelperTransport {
  invoke(input: HostHelperInvocation): Promise<HostHelperResponse>;
}

export class HostHelperError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "HostHelperError";
  }
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedText(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HostHelperError(`${label} is invalid`, "helper-response-invalid");
  }
  return value;
}

export function encodeHostHelperFrame(request: HostHelperRequest, archive?: Uint8Array): Uint8Array {
  const payload = archive ?? new Uint8Array();
  if (payload.byteLength > MAX_ARCHIVE_BYTES) throw new HostHelperError("archive exceeds the helper limit", "helper-request-invalid");
  if ((request.archiveBytes ?? 0) !== payload.byteLength) {
    throw new HostHelperError("archive byte count differs from the request", "helper-request-invalid");
  }
  const raw = Buffer.from(JSON.stringify(request), "utf8");
  if (raw.byteLength === 0 || raw.byteLength > MAX_HEADER_BYTES) {
    throw new HostHelperError("request header exceeds the helper limit", "helper-request-invalid");
  }
  const output = Buffer.allocUnsafe(4 + raw.byteLength + payload.byteLength);
  output.writeUInt32BE(raw.byteLength, 0);
  raw.copy(output, 4);
  output.set(payload, 4 + raw.byteLength);
  return output;
}

export function decodeHostHelperFrame(value: Uint8Array, expected: HostHelperRequest): HostHelperResponse {
  const input = Buffer.from(value);
  if (input.byteLength < 4) throw new HostHelperError("helper response was truncated", "helper-response-invalid");
  const size = input.readUInt32BE(0);
  if (size === 0 || size > MAX_RESPONSE_BYTES || input.byteLength !== size + 4) {
    throw new HostHelperError("helper response framing is invalid", "helper-response-invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.subarray(4).toString("utf8"));
  } catch {
    throw new HostHelperError("helper response is not valid JSON", "helper-response-invalid");
  }
  const body = plainObject(parsed);
  if (!body) throw new HostHelperError("helper response is not an object", "helper-response-invalid");
  const allowed = new Set(["schema", "requestId", "targetId", "operation", "outcome", "code", "detail", "observedAt", "data"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new HostHelperError("helper response contains unknown fields", "helper-response-invalid");
  }
  if (
    body.schema !== HOST_HELPER_RESPONSE_SCHEMA
    || body.requestId !== expected.requestId
    || body.targetId !== expected.targetId
    || body.operation !== expected.operation
    || (body.outcome !== "succeeded" && body.outcome !== "failed")
  ) {
    throw new HostHelperError("helper response identity is mismatched", "helper-response-invalid");
  }
  const observedAt = boundedText(body.observedAt, "helper observedAt", 40);
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new HostHelperError("helper observedAt is invalid", "helper-response-invalid");
  }
  const response: HostHelperResponse = {
    schema: HOST_HELPER_RESPONSE_SCHEMA,
    requestId: expected.requestId,
    targetId: expected.targetId,
    operation: expected.operation,
    outcome: body.outcome,
    code: boundedText(body.code, "helper code", 120),
    detail: boundedText(body.detail, "helper detail", 500),
    observedAt,
    ...(body.data === undefined ? {} : { data: body.data as JsonValue }),
  };
  if (response.outcome === "failed") throw new HostHelperError(response.detail, response.code);
  return response;
}

export function knownHostFingerprint(line: string): string {
  if (line.includes("\n") || line.includes("\r") || line.length > 16_384) {
    throw new HostHelperError("known-host entry must be one bounded line", "helper-config-invalid");
  }
  const fields = line.trim().split(/\s+/);
  if (fields.length < 3 || !/^(?:ssh-|ecdsa-)[A-Za-z0-9@._+-]+$/.test(fields[1])) {
    throw new HostHelperError("known-host entry is invalid", "helper-config-invalid");
  }
  let key: Buffer;
  try {
    key = Buffer.from(fields[2], "base64");
  } catch {
    throw new HostHelperError("known-host key is not base64", "helper-config-invalid");
  }
  if (key.byteLength < 16 || key.toString("base64").replace(/=+$/, "") !== fields[2].replace(/=+$/, "")) {
    throw new HostHelperError("known-host key is invalid", "helper-config-invalid");
  }
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function knownHost(profile: ConnectionProfile): string {
  const value = profile.publicMetadata?.knownHost;
  if (typeof value !== "string") throw new HostHelperError("connection has no pinned known-host entry", "helper-config-invalid");
  const constraint = profile.constraints.ssh;
  if (!constraint) throw new HostHelperError("connection has no SSH endpoint constraint", "helper-config-invalid");
  const expectedHost = constraint.port === 22 ? constraint.host : `[${constraint.host}]:${constraint.port}`;
  const hosts = value.trim().split(/\s+/, 1)[0].split(",");
  if (!hosts.includes(expectedHost) || knownHostFingerprint(value) !== constraint.hostKeyFingerprint) {
    throw new HostHelperError("known-host entry differs from the pinned SSH endpoint", "helper-config-invalid");
  }
  return `${value.trim()}\n`;
}

export async function collect(child: ReturnType<typeof spawn>, maximum: number, signal?: AbortSignal): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      operation();
    };
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => finish(() => reject(error)));
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maximum) child.kill("SIGKILL");
      else stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= 16 * 1024) stderr.push(chunk);
    });
    child.on("close", (code) => finish(() => resolve({
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString("utf8").replace(/[\u0000-\u001f\u007f]/g, " ").slice(-1_000),
      code,
    })));
  });
}

export class SshHostHelperTransport implements HostHelperTransport {
  readonly #broker: SecretBroker;
  readonly #sshPath: string;
  readonly #timeoutMs: number;

  constructor(options: { broker: SecretBroker; sshPath?: string; timeoutMs?: number }) {
    this.#broker = options.broker;
    this.#sshPath = options.sshPath ?? "ssh";
    this.#timeoutMs = Math.min(300_000, Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  }

  async invoke(input: HostHelperInvocation): Promise<HostHelperResponse> {
    const ssh = input.connection.constraints.ssh;
    if (!ssh || input.connection.kind !== "ssh-host-helper@1") {
      throw new HostHelperError("connection is not an SSH host-helper profile", "helper-config-invalid");
    }
    if (!input.connection.requiredSecretSlots.includes("privateKey")) {
      throw new HostHelperError("host-helper connection must declare privateKey", "helper-config-invalid");
    }
    const frame = encodeHostHelperFrame(input.request, input.archive);
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "psm-host-helper-"));
    try {
      const keyPath = path.join(temporary, "identity");
      const hostsPath = path.join(temporary, "known_hosts");
      await fs.writeFile(hostsPath, knownHost(input.connection), { mode: 0o600, flag: "wx" });
      return await this.#broker.withLease(input.connection.connectionId, ["privateKey"], async (lease) => {
        lease.useBytes("privateKey", (key) => writeFileSync(keyPath, key, { mode: 0o600, flag: "wx" }));
        const controller = new AbortController();
        const abort = () => controller.abort(input.signal?.reason);
        if (input.signal?.aborted) abort();
        else input.signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => controller.abort(new Error("SSH helper request timed out")), this.#timeoutMs);
        try {
          const child = spawn(this.#sshPath, [
            "-F", "/dev/null",
            "-o", "BatchMode=yes",
            "-o", "IdentitiesOnly=yes",
            "-o", "IdentityAgent=none",
            "-o", "PasswordAuthentication=no",
            "-o", "KbdInteractiveAuthentication=no",
            "-o", "StrictHostKeyChecking=yes",
            "-o", `UserKnownHostsFile=${hostsPath}`,
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "RequestTTY=no",
            "-p", String(ssh.port),
            "-i", keyPath,
            "--", `${ssh.user}@${ssh.host}`,
            "psm-host-helper-client",
          ], {
            env: minimalEnvironment(),
            stdio: ["pipe", "pipe", "pipe"],
            signal: controller.signal,
            windowsHide: true,
          });
          child.stdin.end(frame);
          const result = await collect(child, MAX_RESPONSE_BYTES + 4, controller.signal);
          if (result.code !== 0) {
            throw new HostHelperError(`SSH helper exited ${result.code}: ${result.stderr || "no diagnostic"}`, "helper-transport-failed", true);
          }
          return decodeHostHelperFrame(result.stdout, input.request);
        } finally {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", abort);
        }
      }, this.#timeoutMs + 5_000);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
}

export function hostHelperRequest(input: {
  targetId: string;
  operation: string;
  desired: JsonValue;
  planDigest?: string;
  idempotencyKey?: string;
  expiresAt?: number;
  archiveBytes?: number;
}): HostHelperRequest {
  return {
    schema: HOST_HELPER_REQUEST_SCHEMA,
    requestId: `req_${randomUUID().replaceAll("-", "")}`,
    targetId: input.targetId,
    operation: input.operation,
    desired: input.desired,
    ...(input.planDigest ? { planDigest: input.planDigest } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z") } : {}),
    ...(input.archiveBytes ? { archiveBytes: input.archiveBytes } : {}),
  };
}
