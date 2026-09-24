/**
 * The control service: durable jobs for runners that belong to one workspace.
 *
 * Invariants worth stating once:
 * - A runner belongs to exactly one workspace and only ever leases, sees and
 *   decrypts that workspace's jobs and secrets.
 * - Jobs outlive browsers and runners. A lease that lapses before a job
 *   started is simply returned to the queue — nothing ran. A lease that lapses
 *   after it started is retried only if the job said it is idempotent;
 *   otherwise it is "uncertain" until a person decides, so an external change
 *   is never made twice by accident.
 * - Secrets are handed to a runner only for a job it holds, only the ones that
 *   job declared, and every hand-out is audited.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { AuthError, requireMembership, type Principal } from "./auth.ts";
import { hashToken, newToken, SecretSealer, tokenMatches } from "./crypto.ts";

export class ControlError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "ControlError";
  }
}

export type JobState = "queued" | "leased" | "running" | "succeeded" | "failed" | "cancelled" | "uncertain";

export interface JobSpec {
  kind: "command";
  title: string;
  image: string;
  steps: string[];
  checkout?: { repository: string; ref: string; tokenSecret?: string };
  secrets: Array<{ name: string; env: string }>;
  network: "none" | "egress";
  timeoutSeconds: number;
  idempotent: boolean;
}

export interface JobRecord {
  id: string;
  workspaceId: string;
  state: JobState;
  spec: JobSpec;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  runnerId: string | null;
  leaseExpiresAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  cancelRequested: boolean;
  result: { exitCode: number | null; detail: string } | null;
}

export interface RunnerRecord {
  id: string;
  workspaceId: string;
  name: string;
  capabilities: { images: string[]; backend: string; version: string };
  createdBy: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export const LEASE_MS = 60_000;
/** The image a runner uses to clone a checkout; a runner must advertise it to take such jobs. */
export const CHECKOUT_IMAGE = "alpine/git:2.47.2";
const MAX_ATTEMPTS = 3;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._/-]{0,127}(:[A-Za-z0-9._-]{1,64})?(@sha256:[a-f0-9]{64})?$/;
const REPOSITORY_RE = /^https:\/\/[a-z0-9.-]+(:\d+)?\/[A-Za-z0-9._/-]+?(\.git)?$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function id(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export function validateJobSpec(input: unknown): JobSpec {
  const value = (input ?? {}) as Record<string, unknown>;
  const fail = (message: string): never => { throw new ControlError(message, 400, "invalid-job"); };
  if (value.kind !== "command") fail("Only command jobs are supported.");
  const title = String(value.title ?? "").trim();
  if (!title || title.length > 200 || /[\u0000-\u001f]/.test(title)) fail("Give the job a short title.");
  const image = String(value.image ?? "node:22-bookworm-slim");
  if (!IMAGE_RE.test(image)) fail("Invalid image name.");
  const steps = Array.isArray(value.steps) ? value.steps.map(String) : [];
  if (!steps.length || steps.length > 20 || steps.some((step) => !step.trim() || step.length > 8192 || step.includes("\0"))) fail("Give 1–20 steps of up to 8 KB each.");
  let checkout: JobSpec["checkout"];
  if (value.checkout !== undefined) {
    const raw = value.checkout as Record<string, unknown>;
    const repository = String(raw?.repository ?? "");
    const ref = String(raw?.ref ?? "");
    if (!REPOSITORY_RE.test(repository) || repository.includes("@") || repository.includes("..")) fail("Checkout needs an https repository URL without credentials.");
    if (!REF_RE.test(ref) || ref.includes("..")) fail("Invalid checkout ref.");
    const tokenSecret = raw?.tokenSecret === undefined ? undefined : String(raw.tokenSecret);
    if (tokenSecret !== undefined && !NAME_RE.test(tokenSecret)) fail("Invalid checkout token secret name.");
    checkout = { repository, ref, ...(tokenSecret ? { tokenSecret } : {}) };
  }
  const secrets = Array.isArray(value.secrets) ? value.secrets.map((entry) => ({ name: String((entry as any)?.name ?? ""), env: String((entry as any)?.env ?? "") })) : [];
  if (secrets.length > 32 || secrets.some((entry) => !NAME_RE.test(entry.name) || !ENV_RE.test(entry.env))) fail("Invalid secret reference.");
  if (new Set(secrets.map((entry) => entry.env)).size !== secrets.length) fail("Each secret needs its own environment variable.");
  const network = value.network === "egress" ? "egress" : "none";
  const timeoutSeconds = Number(value.timeoutSeconds ?? 600);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 3600) fail("Timeout must be 10–3600 seconds.");
  return { kind: "command", title, image, steps, ...(checkout ? { checkout } : {}), secrets, network, timeoutSeconds, idempotent: value.idempotent === true };
}

type Row = Record<string, any>;

function jobFromRow(row: Row): JobRecord {
  return {
    id: row.id, workspaceId: row.workspace_id, state: row.state, spec: JSON.parse(row.spec), createdBy: row.created_by,
    createdAt: row.created_at, updatedAt: row.updated_at, attempts: row.attempts, runnerId: row.runner_id ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null, startedAt: row.started_at ?? null, finishedAt: row.finished_at ?? null,
    cancelRequested: row.cancel_requested === 1, result: row.result ? JSON.parse(row.result) : null,
  };
}

function runnerFromRow(row: Row): RunnerRecord {
  return {
    id: row.id, workspaceId: row.workspace_id, name: row.name, capabilities: JSON.parse(row.capabilities), createdBy: row.created_by,
    createdAt: row.created_at, lastSeenAt: row.last_seen_at ?? null, revokedAt: row.revoked_at ?? null,
  };
}

export class ControlService {
  constructor(private readonly database: DatabaseSync, private readonly sealer: SecretSealer, private readonly now: () => number = Date.now) {}

  #tx<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  #audit(workspaceId: string, actor: string, action: string, subject: string): void {
    this.database.prepare("INSERT INTO audit (workspace_id, actor, action, subject, at) VALUES (?, ?, ?, ?, ?)").run(workspaceId, actor, action, subject, this.now());
  }

  audit(principal: Principal, workspaceId: string): Array<{ actor: string; action: string; subject: string; at: number }> {
    requireMembership(principal, workspaceId, "manage");
    return this.database.prepare("SELECT actor, action, subject, at FROM audit WHERE workspace_id = ? ORDER BY id DESC LIMIT 200").all(workspaceId) as any;
  }

  /* ---------- runners ---------- */

  /** A one-time token an operator gives a runner so it can register itself to this workspace. */
  createRegistration(principal: Principal, workspaceId: string, ttlMs = 60 * 60_000): { registrationId: string; token: string; expiresAt: number } {
    requireMembership(principal, workspaceId, "manage");
    const token = newToken("psmreg");
    const registrationId = id("reg");
    const expiresAt = this.now() + Math.min(Math.max(ttlMs, 60_000), 24 * 3_600_000);
    this.database.prepare("INSERT INTO runner_registrations (id, workspace_id, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(registrationId, workspaceId, hashToken(token), principal.subject, this.now(), expiresAt);
    this.#audit(workspaceId, principal.subject, "runner-registration.create", registrationId);
    return { registrationId, token, expiresAt };
  }

  /** Exchange a registration token for a runner credential. Single use. */
  registerRunner(registrationToken: string, input: { name: unknown; capabilities: unknown }): { runner: RunnerRecord; credential: string } {
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 80) throw new ControlError("Give the runner a name.", 400, "invalid-runner");
    const raw = (input.capabilities ?? {}) as Record<string, unknown>;
    const images = Array.isArray(raw.images) ? raw.images.map(String).filter((image) => IMAGE_RE.test(image)).slice(0, 32) : [];
    const capabilities = { images, backend: String(raw.backend ?? "unknown").slice(0, 40), version: String(raw.version ?? "").slice(0, 40) };
    return this.#tx(() => {
      const rows = this.database.prepare("SELECT * FROM runner_registrations WHERE used_at IS NULL AND expires_at > ?").all(this.now()) as Row[];
      const registration = rows.find((row) => tokenMatches(registrationToken, row.token_hash));
      if (!registration) throw new ControlError("This registration token is invalid, used or expired.", 401, "registration-invalid");
      this.database.prepare("UPDATE runner_registrations SET used_at = ? WHERE id = ?").run(this.now(), registration.id);
      const credential = newToken("psmrun");
      const runnerId = id("run");
      this.database.prepare("INSERT INTO runners (id, workspace_id, name, credential_hash, capabilities, created_by, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(runnerId, registration.workspace_id, name, hashToken(credential), JSON.stringify(capabilities), registration.created_by, this.now(), this.now());
      this.#audit(registration.workspace_id, registration.created_by, "runner.register", runnerId);
      return { runner: this.#runner(runnerId), credential };
    });
  }

  #runner(runnerId: string): RunnerRecord {
    const row = this.database.prepare("SELECT * FROM runners WHERE id = ?").get(runnerId) as Row | undefined;
    if (!row) throw new ControlError("Runner not found.", 404, "runner-not-found");
    return runnerFromRow(row);
  }

  /** Resolve a runner credential. Revoked runners stop at once. */
  authenticateRunner(runnerId: string, credential: string): RunnerRecord {
    const row = this.database.prepare("SELECT * FROM runners WHERE id = ?").get(runnerId) as Row | undefined;
    if (!row || row.revoked_at || !tokenMatches(credential, row.credential_hash)) throw new AuthError("Runner credential is not valid.", 401);
    this.database.prepare("UPDATE runners SET last_seen_at = ? WHERE id = ?").run(this.now(), runnerId);
    return runnerFromRow(row);
  }

  listRunners(principal: Principal, workspaceId: string): RunnerRecord[] {
    requireMembership(principal, workspaceId, "read");
    return (this.database.prepare("SELECT * FROM runners WHERE workspace_id = ? ORDER BY created_at").all(workspaceId) as Row[]).map(runnerFromRow);
  }

  revokeRunner(principal: Principal, workspaceId: string, runnerId: string): RunnerRecord {
    requireMembership(principal, workspaceId, "manage");
    const runner = this.#runner(runnerId);
    if (runner.workspaceId !== workspaceId) throw new ControlError("Runner not found.", 404, "runner-not-found");
    this.database.prepare("UPDATE runners SET revoked_at = ? WHERE id = ?").run(this.now(), runnerId);
    this.#audit(workspaceId, principal.subject, "runner.revoke", runnerId);
    return this.#runner(runnerId);
  }

  /* ---------- jobs ---------- */

  createJob(principal: Principal, workspaceId: string, specInput: unknown): JobRecord {
    requireMembership(principal, workspaceId, "write");
    const spec = validateJobSpec(specInput);
    for (const name of [...spec.secrets.map((entry) => entry.name), ...(spec.checkout?.tokenSecret ? [spec.checkout.tokenSecret] : [])]) {
      if (!this.database.prepare("SELECT 1 FROM secrets WHERE workspace_id = ? AND name = ?").get(workspaceId, name)) {
        throw new ControlError(`This workspace has no secret named ${name}.`, 400, "secret-missing");
      }
    }
    const jobId = id("job");
    const now = this.now();
    this.database.prepare("INSERT INTO jobs (id, workspace_id, state, spec, created_by, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?, ?)")
      .run(jobId, workspaceId, JSON.stringify(spec), principal.subject, now, now);
    this.#event(jobId, "status", `Queued by ${principal.name}.`);
    this.#audit(workspaceId, principal.subject, "job.create", jobId);
    return this.#job(jobId);
  }

  #job(jobId: string): JobRecord {
    const row = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as Row | undefined;
    if (!row) throw new ControlError("Job not found.", 404, "job-not-found");
    return jobFromRow(row);
  }

  getJob(principal: Principal, workspaceId: string, jobId: string): JobRecord {
    requireMembership(principal, workspaceId, "read");
    const job = this.#job(jobId);
    // Another workspace's job reads exactly like a missing one.
    if (job.workspaceId !== workspaceId) throw new ControlError("Job not found.", 404, "job-not-found");
    return job;
  }

  listJobs(principal: Principal, workspaceId: string): JobRecord[] {
    requireMembership(principal, workspaceId, "read");
    return (this.database.prepare("SELECT * FROM jobs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100").all(workspaceId) as Row[]).map(jobFromRow);
  }

  events(principal: Principal, workspaceId: string, jobId: string, after = 0): Array<{ seq: number; at: number; kind: string; text: string }> {
    this.getJob(principal, workspaceId, jobId);
    return this.database.prepare("SELECT seq, at, kind, text FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT 1000").all(jobId, after) as any;
  }

  #event(jobId: string, kind: string, text: string): void {
    const used = (this.database.prepare("SELECT COALESCE(SUM(LENGTH(text)), 0) AS bytes, COALESCE(MAX(seq), 0) AS seq FROM job_events WHERE job_id = ?").get(jobId) as { bytes: number; seq: number });
    if (used.bytes >= MAX_EVENT_BYTES && kind !== "status") return;
    this.database.prepare("INSERT INTO job_events (job_id, seq, at, kind, text) VALUES (?, ?, ?, ?, ?)").run(jobId, used.seq + 1, this.now(), kind, text.slice(0, 64 * 1024));
  }

  cancelJob(principal: Principal, workspaceId: string, jobId: string): JobRecord {
    requireMembership(principal, workspaceId, "write");
    const job = this.getJob(principal, workspaceId, jobId);
    this.#tx(() => {
      if (job.state === "queued" || job.state === "uncertain") {
        this.database.prepare("UPDATE jobs SET state = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?").run(this.now(), this.now(), jobId);
        this.#event(jobId, "status", `Cancelled by ${principal.name}.`);
      } else if (job.state === "leased" || job.state === "running") {
        this.database.prepare("UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?").run(this.now(), jobId);
        this.#event(jobId, "status", `Cancellation requested by ${principal.name}.`);
      }
      this.#audit(workspaceId, principal.subject, "job.cancel", jobId);
    });
    return this.#job(jobId);
  }

  /** Re-run a job whose outcome is unknown, after a person has decided it is safe. */
  retryUncertain(principal: Principal, workspaceId: string, jobId: string): JobRecord {
    requireMembership(principal, workspaceId, "write");
    const job = this.getJob(principal, workspaceId, jobId);
    if (job.state !== "uncertain" && job.state !== "failed") throw new ControlError("Only an uncertain or failed job can be retried.", 409, "job-state");
    this.database.prepare("UPDATE jobs SET state = 'queued', runner_id = NULL, lease_expires_at = NULL, started_at = NULL, finished_at = NULL, result = NULL, cancel_requested = 0, updated_at = ? WHERE id = ?").run(this.now(), jobId);
    this.#event(jobId, "status", `Retried by ${principal.name} after checking the previous attempt.`);
    this.#audit(workspaceId, principal.subject, "job.retry", jobId);
    return this.#job(jobId);
  }

  /* ---------- runner protocol ---------- */

  /** Give the runner the oldest queued job of its workspace it can run, if any. */
  lease(runner: RunnerRecord): JobRecord | null {
    return this.#tx(() => {
      const candidates = (this.database.prepare("SELECT * FROM jobs WHERE workspace_id = ? AND state = 'queued' ORDER BY created_at LIMIT 20").all(runner.workspaceId) as Row[]).map(jobFromRow);
      const job = candidates.find((entry) => runner.capabilities.images.includes(entry.spec.image) && (!entry.spec.checkout || runner.capabilities.images.includes(CHECKOUT_IMAGE)));
      if (!job) return null;
      const now = this.now();
      this.database.prepare("UPDATE jobs SET state = 'leased', runner_id = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND state = 'queued'")
        .run(runner.id, now + LEASE_MS, now, job.id);
      this.#event(job.id, "status", `Leased by runner ${runner.name} (attempt ${job.attempts + 1}).`);
      return this.#job(job.id);
    });
  }

  #held(runner: RunnerRecord, jobId: string): JobRecord {
    const job = this.#job(jobId);
    if (job.runnerId !== runner.id || job.workspaceId !== runner.workspaceId || !["leased", "running"].includes(job.state)) {
      throw new ControlError("This runner does not hold that job.", 409, "lease-lost");
    }
    return job;
  }

  /** Renew the lease; the answer tells the runner whether to stop. */
  heartbeat(runner: RunnerRecord, jobId: string, started = false): { cancel: boolean; leaseExpiresAt: number } {
    return this.#tx(() => {
      const job = this.#held(runner, jobId);
      const now = this.now();
      const state = started || job.state === "running" ? "running" : "leased";
      this.database.prepare("UPDATE jobs SET state = ?, lease_expires_at = ?, started_at = COALESCE(started_at, CASE WHEN ? = 'running' THEN ? END), updated_at = ? WHERE id = ?")
        .run(state, now + LEASE_MS, state, now, now, jobId);
      if (started && job.state === "leased") this.#event(jobId, "status", "Started.");
      return { cancel: job.cancelRequested, leaseExpiresAt: now + LEASE_MS };
    });
  }

  appendEvents(runner: RunnerRecord, jobId: string, events: unknown): void {
    this.#held(runner, jobId);
    const list = Array.isArray(events) ? events.slice(0, 200) : [];
    this.#tx(() => {
      for (const event of list) {
        const kind = ["stdout", "stderr", "status"].includes((event as any)?.kind) ? (event as any).kind : "stdout";
        this.#event(jobId, kind, String((event as any)?.text ?? ""));
      }
    });
  }

  /** Values for exactly the secrets this job declared, in its own workspace. */
  leaseSecrets(runner: RunnerRecord, jobId: string): Record<string, string> {
    const job = this.#held(runner, jobId);
    const out: Record<string, string> = {};
    const wanted = [...job.spec.secrets, ...(job.spec.checkout?.tokenSecret ? [{ name: job.spec.checkout.tokenSecret, env: "PSM_CHECKOUT_TOKEN" }] : [])];
    for (const entry of wanted) {
      const row = this.database.prepare("SELECT sealed FROM secrets WHERE workspace_id = ? AND name = ?").get(job.workspaceId, entry.name) as { sealed: string } | undefined;
      if (!row) throw new ControlError(`Secret ${entry.name} was removed.`, 409, "secret-missing");
      out[entry.env] = this.sealer.open(job.workspaceId, entry.name, row.sealed).toString("utf8");
    }
    this.#audit(job.workspaceId, `runner:${runner.id}`, "secrets.lease", `${jobId}:${wanted.map((entry) => entry.name).join(",")}`);
    return out;
  }

  complete(runner: RunnerRecord, jobId: string, input: { exitCode: unknown; cancelled?: unknown; detail?: unknown }): JobRecord {
    return this.#tx(() => {
      this.#held(runner, jobId);
      const exitCode = Number.isInteger(input.exitCode) ? Number(input.exitCode) : null;
      const state: JobState = input.cancelled === true ? "cancelled" : exitCode === 0 ? "succeeded" : "failed";
      const detail = String(input.detail ?? "").slice(0, 2000);
      this.database.prepare("UPDATE jobs SET state = ?, finished_at = ?, lease_expires_at = NULL, result = ?, updated_at = ? WHERE id = ?")
        .run(state, this.now(), JSON.stringify({ exitCode, detail }), this.now(), jobId);
      this.#event(jobId, "status", `${state === "succeeded" ? "Succeeded" : state === "cancelled" ? "Cancelled" : "Failed"}${exitCode !== null ? ` (exit ${exitCode})` : ""}${detail ? `: ${detail}` : ""}.`);
      return this.#job(jobId);
    });
  }

  /**
   * Leases that lapsed. Not started: back to the queue. Started: retried only
   * when idempotent (and attempts remain), otherwise uncertain.
   */
  sweep(): { requeued: string[]; uncertain: string[] } {
    return this.#tx(() => {
      const now = this.now();
      const lapsed = (this.database.prepare("SELECT * FROM jobs WHERE state IN ('leased','running') AND lease_expires_at <= ?").all(now) as Row[]).map(jobFromRow);
      const requeued: string[] = [];
      const uncertain: string[] = [];
      for (const job of lapsed) {
        if (job.cancelRequested) {
          this.database.prepare("UPDATE jobs SET state = 'cancelled', finished_at = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(now, now, job.id);
          this.#event(job.id, "status", "Cancelled: the runner stopped answering after cancellation was requested.");
        } else if (job.state === "leased" || (job.spec.idempotent && job.attempts < MAX_ATTEMPTS)) {
          this.database.prepare("UPDATE jobs SET state = 'queued', runner_id = NULL, lease_expires_at = NULL, started_at = NULL, updated_at = ? WHERE id = ?").run(now, job.id);
          this.#event(job.id, "status", job.state === "leased" ? "The runner stopped answering before starting; queued again." : "The runner stopped answering; this job is idempotent, so it is queued again.");
          requeued.push(job.id);
        } else {
          this.database.prepare("UPDATE jobs SET state = 'uncertain', lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(now, job.id);
          this.#event(job.id, "status", "The runner stopped answering while this job was running. Its effects are unknown; check them, then retry or cancel.");
          uncertain.push(job.id);
        }
      }
      return { requeued, uncertain };
    });
  }

  /* ---------- secrets ---------- */

  putSecret(principal: Principal, workspaceId: string, name: unknown, value: unknown, kind: unknown = "generic"): { name: string; kind: string; fingerprint: string } {
    requireMembership(principal, workspaceId, "manage");
    const secretName = String(name ?? "");
    const secretKind = String(kind ?? "generic");
    if (!NAME_RE.test(secretName)) throw new ControlError("Secret names start with a letter and use letters, digits, . _ -.", 400, "invalid-secret");
    if (!["generic", "anthropic-api-key", "openai-api-key", "git-token"].includes(secretKind)) throw new ControlError("Unknown secret kind.", 400, "invalid-secret");
    const bytes = Buffer.from(String(value ?? ""), "utf8");
    if (!bytes.byteLength || bytes.byteLength > 64 * 1024) throw new ControlError("A secret must be 1 byte to 64 KB.", 400, "invalid-secret");
    const fingerprint = this.sealer.fingerprint(workspaceId, secretName, bytes);
    this.database.prepare(`INSERT INTO secrets (workspace_id, name, kind, sealed, fingerprint, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, name) DO UPDATE SET kind = excluded.kind, sealed = excluded.sealed, fingerprint = excluded.fingerprint, created_by = excluded.created_by, updated_at = excluded.updated_at, verified_at = NULL, verification = NULL`)
      .run(workspaceId, secretName, secretKind, this.sealer.seal(workspaceId, secretName, bytes), fingerprint, principal.subject, this.now());
    bytes.fill(0);
    this.#audit(workspaceId, principal.subject, "secret.put", secretName);
    return { name: secretName, kind: secretKind, fingerprint };
  }

  listSecrets(principal: Principal, workspaceId: string): Array<{ name: string; kind: string; fingerprint: string; updatedAt: number; verifiedAt: number | null; verification: string | null }> {
    requireMembership(principal, workspaceId, "read");
    return (this.database.prepare("SELECT name, kind, fingerprint, updated_at, verified_at, verification FROM secrets WHERE workspace_id = ? ORDER BY name").all(workspaceId) as Row[])
      .map((row) => ({ name: row.name, kind: row.kind, fingerprint: row.fingerprint, updatedAt: row.updated_at, verifiedAt: row.verified_at ?? null, verification: row.verification ?? null }));
  }

  deleteSecret(principal: Principal, workspaceId: string, name: string): void {
    requireMembership(principal, workspaceId, "manage");
    this.database.prepare("DELETE FROM secrets WHERE workspace_id = ? AND name = ?").run(workspaceId, name);
    this.#audit(workspaceId, principal.subject, "secret.delete", name);
  }

  /** Check a model-provider key with the provider itself. The key never leaves this call. */
  async verifyProviderKey(principal: Principal, workspaceId: string, name: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
    requireMembership(principal, workspaceId, "manage");
    const row = this.database.prepare("SELECT kind, sealed FROM secrets WHERE workspace_id = ? AND name = ?").get(workspaceId, name) as { kind: string; sealed: string } | undefined;
    if (!row) throw new ControlError("Secret not found.", 404, "secret-missing");
    const key = this.sealer.open(workspaceId, name, row.sealed).toString("utf8");
    let request: [string, Record<string, string>];
    if (row.kind === "anthropic-api-key") request = ["https://api.anthropic.com/v1/models?limit=1", { "x-api-key": key, "anthropic-version": "2023-06-01" }];
    else if (row.kind === "openai-api-key") request = ["https://api.openai.com/v1/models", { Authorization: `Bearer ${key}` }];
    else throw new ControlError("Only model-provider keys can be verified.", 400, "not-verifiable");
    let result: { ok: boolean; detail: string };
    try {
      const response = await fetchImpl(request[0], { headers: request[1], signal: AbortSignal.timeout(10_000) });
      result = response.ok ? { ok: true, detail: "The provider accepted this key." }
        : response.status === 401 || response.status === 403 ? { ok: false, detail: "The provider rejected this key." }
        : { ok: false, detail: `The provider answered ${response.status}; try again later.` };
    } catch {
      result = { ok: false, detail: "The provider could not be reached." };
    }
    this.database.prepare("UPDATE secrets SET verified_at = ?, verification = ? WHERE workspace_id = ? AND name = ?").run(this.now(), JSON.stringify(result), workspaceId, name);
    this.#audit(workspaceId, principal.subject, "secret.verify", `${name}:${result.ok ? "ok" : "failed"}`);
    return result;
  }

  /* ---------- enrollment intents ---------- */

  /**
   * A single-use, expiring token a machine presents with its setup result. It
   * is bound to what the operator reviewed (e.g. a plan digest); a claim is
   * only a claim until PSM verifies the machine independently.
   */
  createEnrollmentIntent(principal: Principal, workspaceId: string, input: { purpose: unknown; binding: unknown; ttlMs?: number }): { intentId: string; token: string; expiresAt: number } {
    requireMembership(principal, workspaceId, "manage");
    const purpose = String(input.purpose ?? "");
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(purpose)) throw new ControlError("Invalid intent purpose.", 400, "invalid-intent");
    const binding = JSON.stringify(input.binding ?? {});
    if (binding.length > 4096) throw new ControlError("Intent binding is too large.", 400, "invalid-intent");
    const token = newToken("psmenr");
    const intentId = id("int");
    const expiresAt = this.now() + Math.min(Math.max(input.ttlMs ?? 30 * 60_000, 60_000), 24 * 3_600_000);
    this.database.prepare("INSERT INTO enrollment_intents (id, workspace_id, purpose, binding, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(intentId, workspaceId, purpose, binding, hashToken(token), principal.subject, this.now(), expiresAt);
    this.#audit(workspaceId, principal.subject, "intent.create", intentId);
    return { intentId, token, expiresAt };
  }

  claimEnrollmentIntent(intentId: string, token: string, claim: unknown): { intentId: string; claimedAt: number } {
    return this.#tx(() => {
      const row = this.database.prepare("SELECT * FROM enrollment_intents WHERE id = ?").get(intentId) as Row | undefined;
      if (!row || !tokenMatches(token, row.token_hash)) throw new ControlError("Unknown setup intent.", 401, "intent-invalid");
      if (row.claimed_at) throw new ControlError("This setup command was already used. Generate a new one.", 409, "intent-used");
      if (row.expires_at <= this.now()) throw new ControlError("This setup command expired. Generate a new one.", 410, "intent-expired");
      const text = JSON.stringify(claim ?? {}).slice(0, 64 * 1024);
      this.database.prepare("UPDATE enrollment_intents SET claimed_at = ?, claim = ? WHERE id = ?").run(this.now(), text, intentId);
      this.#audit(row.workspace_id, `intent:${intentId}`, "intent.claim", intentId);
      return { intentId, claimedAt: this.now() };
    });
  }

  getEnrollmentIntent(principal: Principal, workspaceId: string, intentId: string) {
    requireMembership(principal, workspaceId, "read");
    const row = this.database.prepare("SELECT * FROM enrollment_intents WHERE id = ? AND workspace_id = ?").get(intentId, workspaceId) as Row | undefined;
    if (!row) throw new ControlError("Setup intent not found.", 404, "intent-not-found");
    return {
      intentId: row.id, purpose: row.purpose, binding: JSON.parse(row.binding), createdAt: row.created_at, expiresAt: row.expires_at,
      state: row.claimed_at ? "claimed" : row.expires_at <= this.now() ? "expired" : "waiting",
      claimedAt: row.claimed_at ?? null, claim: row.claim ? JSON.parse(row.claim) : null,
    };
  }
}
