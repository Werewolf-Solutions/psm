/**
 * psm-runner: leases jobs from the control service and runs them.
 *
 * It only ever connects outwards, so it can sit behind NAT. Its identity is a
 * credential the control service minted in exchange for a one-time
 * registration token; the credential file is 0600 and names the one workspace
 * the runner belongs to. While a job runs it renews the lease; if the control
 * service says the lease is gone (or asks it to cancel) it stops the job at
 * once. A runner that crashed and restarted first stops whatever it left
 * running — the control service then decides, from the job's own declaration,
 * whether it may run again.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { JobSpec } from "../control/service.ts";
import type { RunnerBackend } from "./backend.ts";

export interface RunnerIdentity {
  runnerId: string;
  credential: string;
  workspaceId: string;
  controlUrl: string;
}

export class ControlClient {
  constructor(private readonly identity: RunnerIdentity, private readonly fetchImpl: typeof fetch = fetch) {}

  async call(method: string, pathname: string, body?: unknown): Promise<{ status: number; data: any }> {
    const response = await this.fetchImpl(`${this.identity.controlUrl.replace(/\/+$/, "")}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${this.identity.credential}`, "X-Psm-Runner": this.identity.runnerId, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, data };
  }
}

/** Register with a one-time token, or load the saved identity. */
export async function loadOrRegister(options: { file: string; controlUrl: string; registrationToken?: string; name: string; capabilities: unknown; fetchImpl?: typeof fetch }): Promise<RunnerIdentity> {
  try {
    const saved = JSON.parse(fs.readFileSync(options.file, "utf8")) as RunnerIdentity;
    if ((fs.statSync(options.file).mode & 0o077) !== 0) throw new Error(`${options.file} must be private (chmod 600).`);
    return saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!options.registrationToken) throw new Error("This runner is not registered. Set PSM_RUNNER_REGISTRATION to a registration token from the workspace.");
  const response = await (options.fetchImpl ?? fetch)(`${options.controlUrl.replace(/\/+$/, "")}/runner/v1/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.registrationToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: options.name, capabilities: options.capabilities }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Registration failed: ${body.error ?? response.status}`);
  const identity: RunnerIdentity = { runnerId: body.runner.id, credential: body.credential, workspaceId: body.runner.workspaceId, controlUrl: options.controlUrl };
  fs.mkdirSync(path.dirname(options.file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(options.file, JSON.stringify(identity, null, 2), { mode: 0o600, flag: "wx" });
  return identity;
}

export class Runner {
  #stopped = false;
  #current: AbortController | null = null;

  constructor(
    private readonly client: ControlClient,
    private readonly backend: RunnerBackend,
    private readonly log: (line: string) => void = (line) => console.log(line),
    private readonly timing = { idleMs: 3_000, heartbeatMs: 15_000, flushMs: 1_000 },
  ) {}

  stop(): void { this.#stopped = true; this.#current?.abort(); }

  /** Lease and run jobs until stopped. */
  async loop(): Promise<void> {
    const cleaned = await this.backend.cleanup().catch(() => 0);
    if (cleaned) this.log(`psm-runner: stopped ${cleaned} container(s) left by a previous run`);
    while (!this.#stopped) {
      const ran = await this.once().catch((error) => { this.log(`psm-runner: ${error instanceof Error ? error.message : error}`); return false; });
      if (!ran && !this.#stopped) await new Promise((resolve) => setTimeout(resolve, this.timing.idleMs));
    }
  }

  /** Lease one job and run it to completion. Returns whether there was one. */
  async once(): Promise<boolean> {
    const leased = await this.client.call("POST", "/runner/v1/lease");
    if (leased.status === 204) return false;
    if (leased.status !== 200) throw new Error(`lease failed: ${leased.data?.error ?? leased.status}`);
    const job = leased.data.job as { id: string; attempt: number; spec: JobSpec };
    this.log(`psm-runner: running ${job.id} (${job.spec.title}, attempt ${job.attempt})`);
    const controller = new AbortController();
    this.#current = controller;
    const pending: Array<{ kind: string; text: string }> = [];
    let lost = false;
    let cancelled = false;
    const flush = async () => {
      if (!pending.length) return;
      const batch = pending.splice(0, 200);
      const sent = await this.client.call("POST", `/runner/v1/jobs/${job.id}/events`, { events: batch }).catch(() => null);
      if (sent?.status === 409) { lost = true; controller.abort(); }
    };
    const heartbeat = async (started: boolean) => {
      const beat = await this.client.call("POST", `/runner/v1/jobs/${job.id}/heartbeat`, { started }).catch(() => null);
      if (beat?.status === 409) { lost = true; controller.abort(); return; }
      if (beat?.data?.cancel) { cancelled = true; controller.abort(); }
    };
    await heartbeat(true);
    const beating = setInterval(() => void heartbeat(true), this.timing.heartbeatMs);
    const flushing = setInterval(() => void flush(), this.timing.flushMs);
    const timeout = setTimeout(() => controller.abort(), job.spec.timeoutSeconds * 1000);
    try {
      if (controller.signal.aborted) return true;
      const secrets = await this.client.call("POST", `/runner/v1/jobs/${job.id}/secrets`);
      if (secrets.status !== 200) throw new Error(`secrets unavailable: ${secrets.data?.error ?? secrets.status}`);
      const result = await this.backend.run({
        jobId: job.id, spec: job.spec, env: secrets.data.env ?? {}, signal: controller.signal,
        // Status lines go out at once, so a crash still shows how far the job got.
        output: (kind, text) => { pending.push({ kind, text }); if (kind === "status") void flush(); },
      });
      clearInterval(flushing);
      await flush();
      if (lost) { this.log(`psm-runner: lost the lease on ${job.id}; stopped it`); return true; }
      const timedOut = controller.signal.aborted && !cancelled && !this.#stopped;
      await this.client.call("POST", `/runner/v1/jobs/${job.id}/complete`, {
        exitCode: result.exitCode, cancelled: cancelled || this.#stopped,
        detail: timedOut ? `timed out after ${job.spec.timeoutSeconds}s` : result.detail,
      });
      return true;
    } catch (error) {
      pending.push({ kind: "status", text: `Runner error: ${error instanceof Error ? error.message : String(error)}` });
      await flush();
      if (!lost) await this.client.call("POST", `/runner/v1/jobs/${job.id}/complete`, { exitCode: null, detail: "runner error" }).catch(() => undefined);
      return true;
    } finally {
      clearInterval(beating); clearInterval(flushing); clearTimeout(timeout);
      this.#current = null;
    }
  }
}

export function defaultRunnerName(): string {
  return `${os.hostname()}-runner`;
}
