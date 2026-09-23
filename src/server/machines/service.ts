/**
 * Machine onboarding, server side: register a machine once per workspace, plan
 * access per project environment, and run setup as a durable job.
 *
 * A setup job never trusts its own history. Every attempt starts by checking
 * the pinned host identity and inspecting the server; what it finds decides
 * whether to apply, skip (already set up) or stop (a conflict). A job cut off
 * mid-apply is marked uncertain, and the retry inspects before touching
 * anything, so a privileged step is never replayed blind. Success is declared
 * only after PSM logs in as the new account and observes what it can and
 * cannot do.
 */
import { randomBytes } from "node:crypto";

import type { SecretBroker } from "../deploy/connections.ts";
import type { DeploymentStore } from "../deploy/store.ts";
import {
  buildCommandAccessPlan,
  compatibility,
  copyableSetupCommand,
  machineInspectionScript,
  MachinePlanError,
  newId,
  parseInspection,
  parseKnownHost,
  validateHost,
  validateId,
  validateMachineName,
  validatePort,
  validateRisk,
  type CommandAccessPlan,
  type InspectionReport,
  type MachineIdentity,
} from "./plan.ts";
import { MachineTransportError, type MachineTransport, type SshEndpoint } from "./ssh.ts";
import {
  MachineStoreError,
  type MachineAccessRecord,
  type MachineRecord,
  type MachineStore,
  type SetupJobRecord,
  type SetupMethod,
  type SetupStep,
  type VerificationCheck,
} from "./store.ts";

export const ADMIN_CONNECTION_KIND = "ssh-machine-admin@1";
export const COMMAND_CONNECTION_KIND = "ssh-command@1";
const HELPER_SOCKET = "/run/psm-deploy/helper.sock";
const LEASE_MS = 90_000;

export class MachineServiceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "MachineServiceError";
  }
}

export interface MachineProject {
  id: string;
  name: string;
  workspaceId: string;
}

export interface MachineServiceOptions {
  store: MachineStore;
  deployments: DeploymentStore;
  broker: SecretBroker;
  transport: MachineTransport;
  now?: () => number;
}

const STEP_TITLES: Record<SetupStep["id"], string> = {
  identity: "Verify machine identity",
  inspect: "Inspect the server",
  apply: "Prepare the project account and directory",
  verify: "Verify the account's access",
  save: "Save the connection",
};

function freshSteps(): SetupStep[] {
  return (Object.keys(STEP_TITLES) as SetupStep["id"][]).map((id) => ({ id, title: STEP_TITLES[id], status: "pending", detail: "", startedAt: null, finishedAt: null }));
}

function identity(machine: MachineRecord): MachineIdentity {
  return { id: machine.id, name: machine.name, host: machine.host, port: machine.port, knownHost: machine.knownHost, hostKeyFingerprint: machine.hostKeyFingerprint, hostKeySource: machine.hostKeySource };
}

class StepFailure extends Error {
  constructor(message: string, readonly code: string, readonly status: "failed" | "uncertain" = "failed", readonly waiting = false) {
    super(message);
  }
}

export class MachineService {
  readonly #store: MachineStore;
  readonly #deployments: DeploymentStore;
  readonly #broker: SecretBroker;
  readonly #transport: MachineTransport;
  readonly #now: () => number;
  readonly #owner = `psm_${process.pid}_${randomBytes(4).toString("hex")}`;
  readonly #machineQueues = new Map<string, Promise<unknown>>();
  readonly #running = new Map<string, AbortController>();

  constructor(options: MachineServiceOptions) {
    this.#store = options.store;
    this.#deployments = options.deployments;
    this.#broker = options.broker;
    this.#transport = options.transport;
    this.#now = options.now ?? Date.now;
  }

  /** Jobs a stopped process left running are failed as uncertain, never resumed blind. */
  recoverInterrupted(): number {
    const abandoned = this.#store.abandonedJobs(this.#now());
    for (const job of abandoned) {
      for (const step of job.steps) if (step.status === "running") { step.status = "uncertain"; step.detail = "PSM stopped while this step was running. Retry inspects the server before changing anything."; }
      this.#store.saveJob({ ...job, state: "failed", lease: null, error: { code: "interrupted", message: "PSM stopped while this setup was running." }, updatedAt: this.#now() });
    }
    return abandoned.length;
  }

  /* ---------- machines ---------- */

  listMachines(workspaceId: string) {
    return this.#store.listMachines(workspaceId).map((machine) => this.view(machine));
  }

  view(machine: MachineRecord) {
    const access = this.#store.listAccess(machine.id);
    return {
      ...machine,
      trusted: machine.hostKeySource !== "scanned-unverified",
      access: access.map((entry) => this.accessView(entry)),
      jobs: this.#store.listJobs(machine.id).slice(0, 10),
    };
  }

  accessView(access: MachineAccessRecord) {
    const { plan, ...rest } = access;
    return { ...rest, plan: { digest: plan.digest, operations: plan.operations, authority: plan.authority, scriptDigest: plan.scriptDigest, account: plan.account, workdir: plan.workdir, publicKeyFingerprint: plan.publicKeyFingerprint } };
  }

  getMachine(id: string, workspaceId: string) {
    return this.view(this.#store.getMachine(id, workspaceId));
  }

  /** Offer the host keys the network presents, clearly as unverified candidates. */
  async discover(hostInput: unknown, portInput: unknown) {
    const host = validateHost(hostInput);
    const port = validatePort(portInput);
    const lines = await this.#transport.scanHostKeys(host, port);
    const candidates = [];
    for (const line of lines) {
      try { candidates.push(parseKnownHost(line, host, port)); } catch { /* a key for another name, or an unsupported type */ }
    }
    if (!candidates.length) throw new MachineServiceError(`No usable SSH host key answered at ${host}:${port}.`, 502, "no-host-key");
    return { host, port, candidates, verified: false, advice: "Compare one of these fingerprints with the provider console or an existing trusted connection before confirming." };
  }

  /**
   * Register a machine. Trust comes from the operator confirming the exact
   * fingerprint, or from an existing connection that already pinned this
   * endpoint. A scanned key is stored as unverified and cannot be set up.
   */
  register(input: { workspaceId: string; name: unknown; host: unknown; port: unknown; knownHost?: unknown; confirmFingerprint?: unknown; fromConnectionId?: unknown }): MachineRecord {
    const host = validateHost(input.host);
    const port = validatePort(input.port);
    const name = validateMachineName(input.name);
    let knownHost: string;
    let fingerprint: string;
    let source: MachineRecord["hostKeySource"] = "scanned-unverified";
    if (input.fromConnectionId) {
      const pinned = this.#pinnedFromConnection(String(input.fromConnectionId), host, port);
      knownHost = pinned.knownHost;
      fingerprint = pinned.fingerprint;
      source = "pinned-connection";
    } else {
      const parsed = parseKnownHost(input.knownHost, host, port);
      knownHost = parsed.knownHost;
      fingerprint = parsed.fingerprint;
      if (input.confirmFingerprint !== undefined && input.confirmFingerprint !== null && input.confirmFingerprint !== "") {
        if (String(input.confirmFingerprint).trim() !== fingerprint) throw new MachineServiceError("The fingerprint you confirmed does not match this host key. Do not continue until you know why.", 409, "fingerprint-mismatch");
        source = "operator-confirmed";
      }
    }
    const now = this.#now();
    return this.#store.createMachine({
      id: newId("mch"), workspaceId: input.workspaceId, name, host, port, knownHost, hostKeyFingerprint: fingerprint,
      hostKeySource: source, adminConnectionId: null, lastInspection: null, createdAt: now, updatedAt: now,
    });
  }

  /** Confirm a stored, unverified key by fingerprint. A different key is a new registration, never a silent swap. */
  confirmHostKey(id: string, workspaceId: string, expectedRevision: number, fingerprint: unknown): MachineRecord {
    const machine = this.#store.getMachine(id, workspaceId);
    if (String(fingerprint ?? "").trim() !== machine.hostKeyFingerprint) throw new MachineServiceError("That fingerprint does not match the stored host key.", 409, "fingerprint-mismatch");
    return this.#store.updateMachine(id, expectedRevision, (current) => ({ ...current, hostKeySource: current.hostKeySource === "scanned-unverified" ? "operator-confirmed" : current.hostKeySource, updatedAt: this.#now() }));
  }

  /** Let setup use a saved administrator SSH connection, which must pin exactly this endpoint. */
  setAdminConnection(id: string, workspaceId: string, expectedRevision: number, connectionId: unknown): MachineRecord {
    const machine = this.#store.getMachine(id, workspaceId);
    if (connectionId === null || connectionId === "") {
      return this.#store.updateMachine(id, expectedRevision, (current) => ({ ...current, adminConnectionId: null, updatedAt: this.#now() }));
    }
    const endpoint = this.#adminEndpoint({ ...machine, adminConnectionId: String(connectionId) });
    return this.#store.updateMachine(id, expectedRevision, (current) => ({ ...current, adminConnectionId: endpoint.connectionId, updatedAt: this.#now() }));
  }

  remove(id: string, workspaceId: string, expectedRevision: number): void {
    this.#store.getMachine(id, workspaceId);
    this.#store.removeMachine(id, expectedRevision);
  }

  /** Read-only inspection through the administrator connection. */
  async inspect(id: string, workspaceId: string): Promise<InspectionReport> {
    const machine = this.#store.getMachine(id, workspaceId);
    this.#requireTrusted(machine);
    const endpoint = this.#adminEndpoint(machine);
    return this.#serialize(machine.id, async () => {
      const report = await this.#runScript(endpoint, machineInspectionScript(machine.id), "--inspect");
      const current = this.#store.getMachine(machine.id);
      this.#store.updateMachine(machine.id, current.revision, (value) => ({ ...value, lastInspection: { ...report, at: this.#now(), as: endpoint.user }, updatedAt: this.#now() }));
      return report;
    });
  }

  /* ---------- access ---------- */

  /**
   * Plan command access for one project environment. Re-planning an existing
   * access returns it unchanged, which is what makes a second visit (or a
   * second project on the same machine) skip everything already done.
   */
  async planCommandAccess(input: { machineId: string; workspaceId: string; project: MachineProject; environmentId: unknown; risk: unknown }): Promise<MachineAccessRecord> {
    const machine = this.#store.getMachine(input.machineId, input.workspaceId);
    this.#requireTrusted(machine);
    if (input.project.workspaceId !== machine.workspaceId) {
      throw new MachineServiceError("This project belongs to a different workspace than the machine.", 403, "workspace-mismatch");
    }
    const environmentId = validateId(input.environmentId, "environmentId");
    const risk = validateRisk(input.risk);
    return this.#serialize(machine.id, async () => {
      const existing = this.#store.findAccess(machine.id, input.project.id, environmentId, "command");
      if (existing && existing.state !== "revoked") return existing;
      if (existing) this.#store.removeAccess(existing.id);
      const keys = await this.#transport.generateKeyPair(`psm ${input.project.id}/${environmentId}`);
      const now = this.#now();
      const accessId = newId("mac");
      const connectionId = `machine-command-${accessId.slice(4, 20)}`;
      let plan: CommandAccessPlan;
      try {
        plan = buildCommandAccessPlan({ machine: identity(machine), projectId: input.project.id, projectName: input.project.name, environmentId, risk, publicKey: keys.publicKey, now });
        this.#deployments.createConnection({
          connectionId,
          kind: COMMAND_CONNECTION_KIND,
          label: `${input.project.name} ${environmentId} on ${machine.name}`,
          secretGeneration: 0,
          readiness: "missing-secret",
          metadata: {
            publicMetadata: { knownHost: machine.knownHost, machineId: machine.id, accessId, account: plan.account, workdir: plan.workdir },
            credentialIdentity: { kind: "public-key", value: plan.publicKeyFingerprint },
            requiredSecretSlots: ["privateKey"],
          },
          constraints: {
            allowedProjectIds: [input.project.id],
            allowedEnvironmentIds: [environmentId],
            maximumAuthorizedRisk: risk,
            ssh: { host: machine.host, user: plan.account, port: machine.port, hostKeyFingerprint: machine.hostKeyFingerprint },
          },
          createdAt: now,
        });
        // The key is stored, but the connection stays "unknown" until setup
        // has logged in with it; a stored key is not a working connection.
        const generation = await this.#broker.put(connectionId, "privateKey", keys.privateKey);
        const connection = this.#deployments.getConnection(connectionId);
        this.#deployments.updateConnectionSecretStatus({ connectionId, expectedSecretGeneration: connection.secretGeneration, secretGeneration: generation, readiness: "unknown", updatedAt: now });
      } catch (error) {
        await this.#discardConnection(connectionId);
        throw error;
      } finally {
        keys.privateKey.fill(0);
      }
      return this.#store.createAccess({
        id: accessId, machineId: machine.id, projectId: input.project.id, projectName: input.project.name, environmentId, role: "command", risk,
        account: plan.account, workdir: plan.workdir, publicKeyFingerprint: plan.publicKeyFingerprint, connectionId, state: "planned", plan,
        checks: [], verifiedAt: null, createdAt: now, updatedAt: now,
      });
    });
  }

  getAccess(id: string, workspaceId: string): MachineAccessRecord {
    const access = this.#store.getAccess(id);
    this.#store.getMachine(access.machineId, workspaceId);
    return access;
  }

  /** The generated script, for Advanced → View setup changes. */
  setupScript(id: string, workspaceId: string) {
    const access = this.getAccess(id, workspaceId);
    return { script: access.plan.script, digest: access.plan.scriptDigest, command: copyableSetupCommand(access.plan) };
  }

  /**
   * Revoke PSM's use of this access: its connection and key are removed so no
   * later job can use them. The server account is left in place — removing it
   * is a separate, reviewed cleanup, never a side effect of disconnecting.
   */
  async revokeAccess(id: string, workspaceId: string, expectedRevision: number): Promise<MachineAccessRecord> {
    const access = this.getAccess(id, workspaceId);
    this.#running.get(access.id)?.abort(new Error("access revoked"));
    const revoked = this.#store.updateAccess(id, expectedRevision, (current) => ({ ...current, state: "revoked", updatedAt: this.#now() }));
    await this.#discardConnection(access.connectionId);
    return revoked;
  }

  async #discardConnection(connectionId: string): Promise<void> {
    try {
      const connection = this.#deployments.getConnection(connectionId);
      this.#deployments.removeConnection(connection.connectionId, connection.metadataRevision);
    } catch (error) {
      if (!(error instanceof Error && /not found/.test(error.message))) throw error;
    }
    await this.#broker.purge(connectionId);
  }

  /* ---------- setup jobs ---------- */

  /**
   * Approve the displayed plan and start setup. The digest the operator saw
   * must still be the plan's digest; anything else means they approved
   * something that is no longer what would run.
   */
  startSetup(input: { accessId: string; workspaceId: string; planDigest: unknown; method: unknown; actor: string }): SetupJobRecord {
    const access = this.getAccess(input.accessId, input.workspaceId);
    const machine = this.#store.getMachine(access.machineId);
    this.#requireTrusted(machine);
    if (access.state === "revoked") throw new MachineServiceError("This access was revoked. Plan it again.", 409, "access-revoked");
    if (input.planDigest !== access.plan.digest) throw new MachineServiceError("The setup plan changed since it was reviewed. Review it again.", 409, "plan-changed");
    const method: SetupMethod = input.method === "manual-command" ? "manual-command" : "admin-ssh";
    if (method === "admin-ssh") this.#adminEndpoint(machine);
    const active = this.#store.listJobs(machine.id).find((job) => job.accessId === access.id && (job.state === "running" || job.state === "waiting"));
    if (active) throw new MachineServiceError("Setup for this access is already in progress.", 409, "job-active");
    const now = this.#now();
    const job: SetupJobRecord = {
      id: newId("msj"), machineId: machine.id, accessId: access.id, method, planDigest: access.plan.digest, state: "running", steps: freshSteps(),
      receipt: [], error: null, approvedBy: input.actor, lease: { owner: this.#owner, expiresAt: now + LEASE_MS }, attempts: 1, createdAt: now, updatedAt: now,
    };
    this.#store.saveJob(job);
    this.#store.updateAccess(access.id, access.revision, (current) => ({ ...current, state: "setting-up", updatedAt: now }));
    this.#launch(job.id);
    return job;
  }

  /** Try again from inspection. Completed work is found, not redone. */
  retry(jobId: string, workspaceId: string): SetupJobRecord {
    const job = this.#store.getJob(jobId);
    this.#store.getMachine(job.machineId, workspaceId);
    if (job.state === "running") throw new MachineServiceError("This setup is still running.", 409, "job-active");
    if (job.state === "succeeded") return job;
    const access = this.#store.getAccess(job.accessId);
    if (access.state === "revoked") throw new MachineServiceError("This access was revoked. Plan it again.", 409, "access-revoked");
    if (access.plan.digest !== job.planDigest) throw new MachineServiceError("The plan changed since this setup was approved. Review it again.", 409, "plan-changed");
    const now = this.#now();
    const next = this.#store.saveJob({ ...job, state: "running", steps: freshSteps(), error: null, lease: { owner: this.#owner, expiresAt: now + LEASE_MS }, attempts: job.attempts + 1, updatedAt: now });
    this.#launch(next.id);
    return next;
  }

  cancel(jobId: string, workspaceId: string): SetupJobRecord {
    const job = this.#store.getJob(jobId);
    this.#store.getMachine(job.machineId, workspaceId);
    if (job.state === "succeeded" || job.state === "cancelled") return job;
    this.#running.get(job.accessId)?.abort(new Error("cancelled"));
    const cancelled = this.#store.saveJob({
      ...job, state: "cancelled", lease: null, updatedAt: this.#now(),
      error: { code: "cancelled", message: job.receipt.length ? `Cancelled. Already changed: ${job.receipt.join("; ")}. Removing it is a separate reviewed action.` : "Cancelled before anything was changed." },
    });
    return cancelled;
  }

  getJob(jobId: string, workspaceId: string) {
    const job = this.#store.getJob(jobId);
    this.#store.getMachine(job.machineId, workspaceId);
    const access = this.#store.getAccess(job.accessId);
    return { ...job, command: job.method === "manual-command" ? copyableSetupCommand(access.plan) : null };
  }

  /** Resolves when a job stops running; tests and the API's `wait` use it. */
  async settled(jobId: string): Promise<SetupJobRecord> {
    await this.#machineQueues.get(this.#store.getJob(jobId).machineId)?.catch(() => undefined);
    return this.#store.getJob(jobId);
  }

  #launch(jobId: string): void {
    const job = this.#store.getJob(jobId);
    const controller = new AbortController();
    this.#running.set(job.accessId, controller);
    void this.#serialize(job.machineId, () => this.#execute(jobId, controller.signal))
      .catch(() => undefined)
      .finally(() => { if (this.#running.get(job.accessId) === controller) this.#running.delete(job.accessId); });
  }

  async #execute(jobId: string, signal: AbortSignal): Promise<void> {
    let job = this.#store.claimJob(jobId, this.#owner, this.#now(), LEASE_MS);
    if (!job || job.state !== "running") return;
    const access = this.#store.getAccess(job.accessId);
    const machine = this.#store.getMachine(job.machineId);

    const save = (change: Partial<SetupJobRecord>) => {
      const latest = this.#store.getJob(jobId);
      if (latest.state === "cancelled") throw new StepFailure("Setup was cancelled.", "cancelled");
      job = this.#store.saveJob({ ...latest, ...change, lease: { owner: this.#owner, expiresAt: this.#now() + LEASE_MS }, updatedAt: this.#now() });
      return job;
    };
    const step = async <T>(id: SetupStep["id"], work: () => Promise<{ value: T; detail: string; status?: "done" | "skipped" }>): Promise<T> => {
      if (signal.aborted) throw new StepFailure("Setup was cancelled.", "cancelled");
      save({ steps: job!.steps.map((entry) => entry.id === id ? { ...entry, status: "running", startedAt: this.#now(), detail: "" } : entry) });
      try {
        const result = await work();
        save({ steps: job!.steps.map((entry) => entry.id === id ? { ...entry, status: result.status ?? "done", detail: result.detail, finishedAt: this.#now() } : entry) });
        return result.value;
      } catch (error) {
        const failure = error instanceof StepFailure ? error : this.#failure(error);
        save({ steps: job!.steps.map((entry) => entry.id === id ? { ...entry, status: failure.status, detail: failure.message, finishedAt: this.#now() } : entry) });
        throw failure;
      }
    };

    try {
      const admin = job.method === "admin-ssh" ? this.#adminEndpoint(machine) : null;
      let report: InspectionReport | null = null;
      if (admin) {
        await step("identity", async () => {
          const result = await this.#transport.run(admin, "echo psm-identity-ok", "", { signal, timeoutMs: 30_000 });
          if (!result.stdout.includes("psm-identity-ok")) throw new StepFailure("The server answered, but not as expected.", "identity-failed");
          return { value: null, detail: `Host key ${machine.hostKeyFingerprint} matched the pinned identity.` };
        });
        report = await step("inspect", async () => {
          const found = await this.#runScript(admin, access.plan.script, "--inspect", signal);
          const compatible = compatibility(found);
          if (!compatible.supported) throw new StepFailure(compatible.reasons.join(" "), "unsupported-host");
          if (found.conflicts.length) throw new StepFailure(`Stopped before changing anything: ${found.conflicts.map(describeConflict).join("; ")}.`, "conflict");
          return { value: found, detail: `${found.osId} ${found.osVersion} ${found.arch}; account ${found.account}, key ${found.key}.` };
        });
        const alreadyDone = report.account === "present" && report.key === "match" && report.workdir === "present";
        await step("apply", async () => {
          if (alreadyDone) return { value: null, detail: `${access.account} already exists with this key; nothing to change.`, status: "skipped" as const };
          let applied: InspectionReport;
          try {
            applied = await this.#runScript(admin, access.plan.script, "--apply", signal);
          } catch (error) {
            if (error instanceof StepFailure) throw error;
            const transport = this.#failure(error);
            // The script may or may not have run. Only a fresh inspection can tell.
            throw new StepFailure(`${transport.message} The server may be partly set up; retry inspects it first.`, "uncertain", "uncertain");
          }
          if (applied.result !== "applied") throw new StepFailure(`Setup did not complete (${applied.result || "no result"}).`, applied.result === "conflict" ? "conflict" : "apply-failed");
          save({ receipt: [...job!.receipt, `account ${access.account}`, `directory ${access.workdir}`, `authorized key ${access.publicKeyFingerprint}`] });
          return { value: null, detail: `Created ${access.account} and ${access.workdir}.` };
        });
      } else {
        const waiting = this.#store.getJob(jobId);
        if (waiting.steps.find((entry) => entry.id === "apply")?.status !== "done") {
          // Manual path: wait for the operator's terminal, then verify from PSM.
          save({
            state: "waiting",
            steps: job.steps.map((entry) => entry.id === "identity" || entry.id === "inspect" ? { ...entry, status: "skipped", detail: "Performed by the setup command on the server." }
              : entry.id === "apply" ? { ...entry, status: "running", detail: "Waiting for the setup command to be run on the server.", startedAt: this.#now() } : entry),
            lease: null,
          });
          return;
        }
      }

      const checks = await step("verify", async () => {
        const observed = await this.#verifyAccess(machine, access, signal);
        const failed = observed.filter((check) => !check.ok);
        if (failed.length) throw new StepFailure(`Verification failed: ${failed.map((check) => `${check.title}: ${check.detail}`).join("; ")}.`, "verification-failed");
        return { value: observed, detail: observed.map((check) => check.title).join(", ") };
      });
      await step("save", async () => {
        const current = this.#store.getAccess(access.id);
        this.#store.updateAccess(access.id, current.revision, (value) => ({ ...value, state: "ready", checks, verifiedAt: this.#now(), updatedAt: this.#now() }));
        const connection = this.#deployments.getConnection(access.connectionId);
        const status = await this.#broker.status(access.connectionId, ["privateKey"]);
        this.#deployments.updateConnectionSecretStatus({ connectionId: connection.connectionId, expectedSecretGeneration: connection.secretGeneration, secretGeneration: status.generation, readiness: status.ready ? "ready" : "missing-secret", updatedAt: this.#now() });
        return { value: null, detail: `Connection ${access.connectionId} is ready for ${access.projectName} ${access.environmentId}.` };
      });
      save({ state: "succeeded", lease: null, error: null });
    } catch (error) {
      const failure = error instanceof StepFailure ? error : this.#failure(error);
      const latest = this.#store.getJob(jobId);
      if (latest.state === "cancelled") return;
      this.#store.saveJob({ ...latest, state: "failed", lease: null, error: { code: failure.code, message: failure.message }, updatedAt: this.#now() });
      const current = this.#store.getAccess(access.id);
      if (current.state !== "revoked") this.#store.updateAccess(access.id, current.revision, (value) => ({ ...value, state: "failed", updatedAt: this.#now() }));
    }
  }

  /**
   * The operator ran the copyable command. PSM does not take their word (or
   * the command's output) for it: it logs in as the new account and checks.
   */
  async confirmManualSetup(jobId: string, workspaceId: string): Promise<SetupJobRecord> {
    const job = this.#store.getJob(jobId);
    this.#store.getMachine(job.machineId, workspaceId);
    if (job.method !== "manual-command" || job.state !== "waiting") throw new MachineServiceError("This setup is not waiting for a command.", 409, "not-waiting");
    const now = this.#now();
    this.#store.saveJob({
      ...job, state: "running", lease: { owner: this.#owner, expiresAt: now + LEASE_MS }, updatedAt: now,
      steps: job.steps.map((entry) => entry.id === "apply" ? { ...entry, status: "done", detail: "Reported as run on the server; verifying from PSM.", finishedAt: now } : entry),
    });
    this.#launch(jobId);
    return this.settled(jobId);
  }

  async #verifyAccess(machine: MachineRecord, access: MachineAccessRecord, signal: AbortSignal): Promise<VerificationCheck[]> {
    const endpoint: SshEndpoint = { host: machine.host, port: machine.port, user: access.account, knownHost: machine.knownHost, connectionId: access.connectionId };
    // Fixed text: the only interpolated value is the validated working directory.
    const command = [
      "printf 'user=%s\\n' \"$(id -un)\"",
      "printf 'groups=%s\\n' \"$(id -Gn)\"",
      `cd '${access.workdir}' && t=$(mktemp -p .) && rm -f -- "$t" && echo write=ok || echo write=no`,
      "if sudo -n true 2>/dev/null; then echo sudo=yes; else echo sudo=no; fi",
      `if [ -w '${HELPER_SOCKET}' ]; then echo helper=yes; else echo helper=no; fi`,
    ].join("; ");
    let result;
    try {
      result = await this.#transport.run(endpoint, command, "", { signal, timeoutMs: 30_000 });
    } catch (error) {
      const failure = this.#failure(error);
      return [{ id: "login", title: "Log in with the new key", ok: false, detail: failure.message }];
    }
    const values = new Map(result.stdout.split("\n").map((line) => line.trim().split("=", 2) as [string, string]).filter((pair) => pair.length === 2));
    return [
      { id: "login", title: "Log in with the new key", ok: true, detail: `Authenticated as ${values.get("user") ?? "?"} with host key ${machine.hostKeyFingerprint}.` },
      { id: "identity", title: "Runs as its own account", ok: values.get("user") === access.account, detail: `user ${values.get("user") ?? "unknown"}` },
      { id: "groups", title: "Belongs only to its own group", ok: values.get("groups") === access.account, detail: `groups ${values.get("groups") ?? "unknown"}` },
      { id: "workdir", title: "Can write its working directory", ok: values.get("write") === "ok", detail: access.workdir },
      { id: "no-sudo", title: "Has no sudo", ok: values.get("sudo") === "no", detail: values.get("sudo") === "no" ? "sudo -n refused" : "sudo -n succeeded" },
      { id: "no-helper", title: "Cannot reach the deployment helper", ok: values.get("helper") === "no", detail: HELPER_SOCKET },
    ];
  }

  async #runScript(endpoint: SshEndpoint, script: string, mode: "--inspect" | "--apply", signal?: AbortSignal): Promise<InspectionReport> {
    const privileged = endpoint.user === "root" ? "" : "sudo -n ";
    const result = await this.#transport.run(endpoint, `${privileged}bash -s -- ${mode}`, script, { signal, timeoutMs: 120_000 });
    if (/a password is required|a terminal is required/i.test(result.stderr)) {
      throw new StepFailure(`${endpoint.user} needs a password for sudo, so PSM cannot run setup on its own. Use "Run a setup command once" instead.`, "sudo-password-required");
    }
    try {
      return parseInspection(result.stdout);
    } catch {
      throw new StepFailure(`The server did not return a setup report (exit ${result.code}): ${result.stderr.slice(-300) || "no diagnostic"}`, "no-report");
    }
  }

  #failure(error: unknown): StepFailure {
    if (error instanceof StepFailure) return error;
    if (error instanceof MachineTransportError) {
      const messages: Record<MachineTransportError["code"], string> = {
        "host-key-mismatch": "The server presented a different host key than the one pinned for this machine. Nothing was changed; repair the machine's identity before continuing.",
        "auth-failed": "The server refused the SSH key.",
        timeout: "The server did not answer in time.",
        unreachable: "PSM could not reach the server.",
        "transport-failed": `SSH failed: ${error.message}`,
      };
      return new StepFailure(messages[error.code], error.code);
    }
    if (error instanceof MachinePlanError || error instanceof MachineServiceError || error instanceof MachineStoreError) return new StepFailure(error.message, "invalid");
    return new StepFailure(error instanceof Error ? error.message : String(error), "unexpected");
  }

  #requireTrusted(machine: MachineRecord): void {
    if (machine.hostKeySource === "scanned-unverified") {
      throw new MachineServiceError("Confirm this machine's host key fingerprint before PSM connects to it.", 409, "host-key-unverified");
    }
  }

  #adminEndpoint(machine: MachineRecord): SshEndpoint {
    if (!machine.adminConnectionId) throw new MachineServiceError("Choose an administrator connection for this machine, or use the one-time setup command.", 409, "admin-connection-missing");
    let connection;
    try {
      connection = this.#deployments.getConnection(machine.adminConnectionId);
    } catch {
      throw new MachineServiceError("The machine's administrator connection no longer exists.", 409, "admin-connection-missing");
    }
    if (connection.kind !== ADMIN_CONNECTION_KIND) throw new MachineServiceError(`An administrator connection must be of kind ${ADMIN_CONNECTION_KIND}.`, 400, "admin-connection-kind");
    const metadata = connection.metadata as { publicMetadata?: { knownHost?: unknown }; requiredSecretSlots?: unknown };
    const ssh = (connection.constraints as { ssh?: { host: string; user: string; port: number; hostKeyFingerprint: string } }).ssh;
    if (!ssh || ssh.host !== machine.host || ssh.port !== machine.port || ssh.hostKeyFingerprint !== machine.hostKeyFingerprint) {
      throw new MachineServiceError("The administrator connection pins a different endpoint or host key than this machine.", 409, "admin-connection-mismatch");
    }
    if (!Array.isArray(metadata.requiredSecretSlots) || !metadata.requiredSecretSlots.includes("privateKey")) {
      throw new MachineServiceError("The administrator connection must hold a private key.", 400, "admin-connection-kind");
    }
    const pinned = parseKnownHost(metadata.publicMetadata?.knownHost, machine.host, machine.port);
    if (pinned.fingerprint !== machine.hostKeyFingerprint) throw new MachineServiceError("The administrator connection's known host differs from this machine's.", 409, "admin-connection-mismatch");
    return { host: machine.host, port: machine.port, user: ssh.user, knownHost: pinned.knownHost, connectionId: connection.connectionId };
  }

  #pinnedFromConnection(connectionId: string, host: string, port: number): { knownHost: string; fingerprint: string } {
    let connection;
    try { connection = this.#deployments.getConnection(connectionId); } catch { throw new MachineServiceError("That connection does not exist.", 404, "connection-not-found"); }
    const metadata = connection.metadata as { publicMetadata?: { knownHost?: unknown } };
    const ssh = (connection.constraints as { ssh?: { host: string; port: number; hostKeyFingerprint: string } }).ssh;
    if (!ssh || ssh.host !== host || ssh.port !== port) throw new MachineServiceError("That connection is for a different endpoint.", 409, "connection-mismatch");
    const pinned = parseKnownHost(metadata.publicMetadata?.knownHost, host, port);
    if (pinned.fingerprint !== ssh.hostKeyFingerprint) throw new MachineServiceError("That connection's pinned host key is inconsistent.", 409, "connection-mismatch");
    return pinned;
  }

  /** One mutation at a time per machine: accounts and locks on one host must not race. */
  #serialize<T>(machineId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#machineQueues.get(machineId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    this.#machineQueues.set(machineId, next);
    void next.catch(() => undefined).finally(() => { if (this.#machineQueues.get(machineId) === next) this.#machineQueues.delete(machineId); });
    return next;
  }
}

function describeConflict(conflict: string): string {
  const [kind, subject = ""] = conflict.split(/:(.*)/s);
  const text: Record<string, string> = {
    "account-differs": `an account named ${subject} already exists with different settings`,
    "account-groups": `${subject} belongs to unexpected groups`,
    "group-exists": `a group named ${subject} exists without its account`,
    "home-exists": `${subject} already exists`,
    "workdir-exists": `${subject} already exists`,
    "workdir-owner": `${subject} is owned by someone else`,
    "key-differs": "a different key is already authorized; rotate it explicitly",
    "authorized-keys-owner": "the authorized_keys file has unexpected ownership",
    symlink: `${subject} is a symlink`,
    "not-root-owned": `${subject} is not root-owned`,
    "writable-by-others": `${subject} is writable by other users`,
  };
  return text[kind] ?? conflict;
}
