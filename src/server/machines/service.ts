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
import fs from "node:fs";

import { HostHelperError, hostHelperRequest, SshHostHelperTransport, type HostHelperTransport } from "../deploy/adapters/host-helper.ts";
import type { SecretBroker } from "../deploy/connections.ts";
import { profileFromRecord } from "../deploy/service.ts";
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
import { buildAdminAccessPlan, buildDeployAccessPlan, buildHelperInstallPlan, buildHostHelper, type AdminAccessPlan, type DeployAccessPlan, type HelperBuild, type HelperInstallPlan } from "./roles.ts";
import { MachineTransportError, type MachineTransport, type SshEndpoint } from "./ssh.ts";
import {
  MachineStoreError,
  type AccessPlan,
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
export const HELPER_CONNECTION_KIND = "ssh-host-helper@1";
const MACHINE_PROJECT = "_machine";
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
  /** Talks to the installed helper as a deploy identity; defaults to SSH. */
  helper?: HostHelperTransport;
  /** Builds the helper binary for an architecture; tests substitute a fixture. */
  buildHelper?: (arch: string) => HelperBuild;
  now?: () => number;
}

const STEP_TITLES: Record<SetupStep["id"], string> = {
  identity: "Verify machine identity",
  inspect: "Inspect the server",
  apply: "Make the planned changes",
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
  readonly #helper: HostHelperTransport;
  readonly #buildHelper: (arch: string) => HelperBuild;
  readonly #now: () => number;
  readonly #owner = `psm_${process.pid}_${randomBytes(4).toString("hex")}`;
  readonly #machineQueues = new Map<string, Promise<unknown>>();
  readonly #running = new Map<string, AbortController>();

  constructor(options: MachineServiceOptions) {
    this.#store = options.store;
    this.#deployments = options.deployments;
    this.#broker = options.broker;
    this.#transport = options.transport;
    this.#helper = options.helper ?? new SshHostHelperTransport({ broker: options.broker });
    this.#buildHelper = options.buildHelper ?? ((arch) => buildHostHelper(arch));
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
    return {
      ...rest,
      machineLevel: access.projectId === MACHINE_PROJECT,
      plan: {
        role: access.role, digest: plan.digest, operations: plan.operations, authority: plan.authority, scriptDigest: plan.scriptDigest,
        account: plan.account, workdir: plan.workdir, publicKeyFingerprint: plan.publicKeyFingerprint,
        ...(plan.role === "deploy" ? { release: plan.release, target: plan.target } : {}),
        ...(plan.role === "helper" ? { helper: plan.helper } : {}),
      },
    };
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

  /**
   * Plan the machine-wide host helper install. It needs the architecture, so
   * the machine is inspected first when that is not known yet.
   */
  async planHelperInstall(input: { machineId: string; workspaceId: string }): Promise<MachineAccessRecord> {
    let machine = this.#store.getMachine(input.machineId, input.workspaceId);
    this.#requireTrusted(machine);
    if (!machine.lastInspection) {
      await this.inspect(machine.id, input.workspaceId);
      machine = this.#store.getMachine(machine.id);
    }
    const arch = machine.lastInspection!.arch;
    return this.#serialize(machine.id, async () => {
      const existing = this.#store.findAccess(machine.id, MACHINE_PROJECT, "helper", "helper");
      const build = this.#buildHelper(arch);
      // A plan for another build is replaced; a current one is reused.
      if (existing && existing.state !== "revoked" && existing.plan.role === "helper" && existing.plan.helper.sha256 === build.sha256) return existing;
      if (existing) this.#store.removeAccess(existing.id);
      const plan = buildHelperInstallPlan({ machine: identity(machine), build, now: this.#now() });
      const now = this.#now();
      return this.#store.createAccess({
        id: newId("mac"), machineId: machine.id, projectId: MACHINE_PROJECT, projectName: machine.name, environmentId: "helper", role: "helper", risk: "production",
        account: plan.account, workdir: plan.workdir, publicKeyFingerprint: "", connectionId: "", state: "planned", plan,
        checks: [], verifiedAt: null, createdAt: now, updatedAt: now,
      });
    });
  }

  /**
   * Plan a project environment's deployment identities on this machine: an
   * infrastructure and a release account, each with its own PSM-generated key,
   * and the helper target they may act on. The infrastructure connection is
   * the one a deployment manifest's host slot binds to.
   */
  async planDeployAccess(input: { machineId: string; workspaceId: string; project: MachineProject; environmentId: unknown; risk: unknown; unitId?: unknown; targetId?: unknown; hostname: unknown; certbotEmail: unknown; canonicalRoot?: unknown; allowedRootPrefix?: unknown }): Promise<MachineAccessRecord> {
    const machine = this.#store.getMachine(input.machineId, input.workspaceId);
    this.#requireTrusted(machine);
    if (input.project.workspaceId !== machine.workspaceId) {
      throw new MachineServiceError("This project belongs to a different workspace than the machine.", 403, "workspace-mismatch");
    }
    const environmentId = validateId(input.environmentId, "environmentId");
    return this.#serialize(machine.id, async () => {
      const existing = this.#store.findAccess(machine.id, input.project.id, environmentId, "deploy");
      if (existing && existing.state !== "revoked") return existing;
      if (existing) this.#store.removeAccess(existing.id);
      const infraKeys = await this.#transport.generateKeyPair(`psm infra ${input.project.id}/${environmentId}`);
      const releaseKeys = await this.#transport.generateKeyPair(`psm release ${input.project.id}/${environmentId}`);
      const now = this.#now();
      const accessId = newId("mac");
      const infraConnection = `machine-infra-${accessId.slice(4, 20)}`;
      const releaseConnection = `machine-release-${accessId.slice(4, 20)}`;
      let plan: DeployAccessPlan;
      try {
        plan = buildDeployAccessPlan({
          machine: identity(machine), projectId: input.project.id, projectName: input.project.name, environmentId, risk: input.risk,
          unitId: input.unitId, targetId: input.targetId, hostname: input.hostname, certbotEmail: input.certbotEmail,
          canonicalRoot: input.canonicalRoot, allowedRootPrefix: input.allowedRootPrefix,
          infraPublicKey: infraKeys.publicKey, releasePublicKey: releaseKeys.publicKey, now,
        });
        const create = async (connectionId: string, role: "infrastructure" | "release", user: string, fingerprint: string, key: Buffer) => {
          this.#deployments.createConnection({
            connectionId, kind: HELPER_CONNECTION_KIND, label: `${input.project.name} ${environmentId} ${role} on ${machine.name}`,
            secretGeneration: 0, readiness: "missing-secret",
            metadata: {
              publicMetadata: { knownHost: machine.knownHost, machineId: machine.id, accessId, role, targetContracts: {} },
              credentialIdentity: { kind: "public-key", value: fingerprint },
              requiredSecretSlots: ["privateKey"],
            },
            constraints: {
              allowedProjectIds: [input.project.id], allowedEnvironmentIds: [environmentId], maximumAuthorizedRisk: plan.risk,
              allowedTargetIds: [plan.target.targetId], allowedTargetRootPrefixes: [plan.target.allowedRootPrefix],
              ssh: { host: machine.host, user, port: machine.port, hostKeyFingerprint: machine.hostKeyFingerprint },
            },
            createdAt: now,
          });
          const generation = await this.#broker.put(connectionId, "privateKey", key);
          const connection = this.#deployments.getConnection(connectionId);
          this.#deployments.updateConnectionSecretStatus({ connectionId, expectedSecretGeneration: connection.secretGeneration, secretGeneration: generation, readiness: "unknown", updatedAt: now });
        };
        await create(infraConnection, "infrastructure", plan.account, plan.publicKeyFingerprint, infraKeys.privateKey);
        await create(releaseConnection, "release", plan.release.account, plan.release.publicKeyFingerprint, releaseKeys.privateKey);
      } catch (error) {
        await this.#discardConnection(infraConnection);
        await this.#discardConnection(releaseConnection);
        throw error;
      } finally {
        infraKeys.privateKey.fill(0);
        releaseKeys.privateKey.fill(0);
      }
      return this.#store.createAccess({
        id: accessId, machineId: machine.id, projectId: input.project.id, projectName: input.project.name, environmentId, role: "deploy", risk: plan.risk,
        account: plan.account, workdir: plan.workdir, publicKeyFingerprint: plan.publicKeyFingerprint, connectionId: infraConnection,
        releaseConnectionId: releaseConnection, state: "planned", plan, checks: [], verifiedAt: null, createdAt: now, updatedAt: now,
      });
    });
  }

  /**
   * Plan PSM's own administrator access to a machine: the one-time handoff for
   * a server whose administrator needs a password. Once verified it becomes
   * the machine's administrator connection; release it after setup.
   */
  async planAdminAccess(input: { machineId: string; workspaceId: string }): Promise<MachineAccessRecord> {
    const machine = this.#store.getMachine(input.machineId, input.workspaceId);
    this.#requireTrusted(machine);
    return this.#serialize(machine.id, async () => {
      const existing = this.#store.findAccess(machine.id, MACHINE_PROJECT, "admin", "admin");
      if (existing && existing.state !== "revoked") return existing;
      if (existing) this.#store.removeAccess(existing.id);
      const keys = await this.#transport.generateKeyPair("psm administrator");
      const now = this.#now();
      const accessId = newId("mac");
      const connectionId = `machine-admin-${accessId.slice(4, 20)}`;
      let plan: AdminAccessPlan;
      try {
        plan = buildAdminAccessPlan({ machine: identity(machine), publicKey: keys.publicKey, now });
        this.#deployments.createConnection({
          connectionId, kind: ADMIN_CONNECTION_KIND, label: `PSM administrator on ${machine.name}`, secretGeneration: 0, readiness: "missing-secret",
          metadata: { publicMetadata: { knownHost: machine.knownHost, machineId: machine.id, accessId, account: plan.account }, credentialIdentity: { kind: "public-key", value: plan.publicKeyFingerprint }, requiredSecretSlots: ["privateKey"] },
          constraints: { allowedProjectIds: ["*"], allowedEnvironmentIds: ["*"], maximumAuthorizedRisk: "production", ssh: { host: machine.host, user: plan.account, port: machine.port, hostKeyFingerprint: machine.hostKeyFingerprint } },
          createdAt: now,
        });
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
        id: accessId, machineId: machine.id, projectId: MACHINE_PROJECT, projectName: machine.name, environmentId: "admin", role: "admin", risk: "production",
        account: plan.account, workdir: "/", publicKeyFingerprint: plan.publicKeyFingerprint, connectionId, state: "planned", plan,
        checks: [], verifiedAt: null, createdAt: now, updatedAt: now,
      });
    });
  }

  /**
   * Remove PSM's administrator access: delete its sudoers entry and key on the
   * server (using that access one last time), then forget the connection.
   */
  async releaseAdminAccess(id: string, workspaceId: string): Promise<MachineAccessRecord> {
    const access = this.getAccess(id, workspaceId);
    if (access.plan.role !== "admin") throw new MachineServiceError("Only administrator access can be released this way.", 400, "not-admin");
    const plan = access.plan;
    const machine = this.#store.getMachine(access.machineId);
    return this.#serialize(machine.id, async () => {
      if (access.state === "ready") {
        const endpoint: SshEndpoint = { host: machine.host, port: machine.port, user: plan.account, knownHost: machine.knownHost, connectionId: access.connectionId };
        const result = await this.#transport.run(endpoint, `sudo -n rm -f -- '${plan.sudoersFile}' '/home/${plan.account}/.ssh/authorized_keys' && echo released`, "", { timeoutMs: 30_000 });
        if (!result.stdout.includes("released")) throw new MachineServiceError(`The server did not confirm removal: ${result.stderr || "no diagnostic"}`, 502, "release-failed");
      }
      const latest = this.#store.getMachine(machine.id);
      if (latest.adminConnectionId === access.connectionId) {
        this.#store.updateMachine(machine.id, latest.revision, (value) => ({ ...value, adminConnectionId: null, updatedAt: this.#now() }));
      }
      const current = this.#store.getAccess(access.id);
      const revoked = this.#store.updateAccess(access.id, current.revision, (value) => ({ ...value, state: "revoked", updatedAt: this.#now() }));
      await this.#discardConnection(access.connectionId);
      return revoked;
    });
  }

  /**
   * For a job waiting on the copyable command: check quietly whether the
   * machine is set up now, and if so continue the job. Safe to call often.
   */
  async probeManualSetup(jobId: string, workspaceId: string): Promise<SetupJobRecord> {
    const job = this.#store.getJob(jobId);
    const machine = this.#store.getMachine(job.machineId, workspaceId);
    if (job.method !== "manual-command" || job.state !== "waiting") return job;
    const access = this.#store.getAccess(job.accessId);
    const observed = access.role === "admin" ? await this.#verifyAdmin(machine, access) : access.role === "deploy" ? (await this.#verifyDeploy(machine, access, new AbortController().signal)).checks : await this.#verifyAccess(machine, access, new AbortController().signal);
    if (!observed.every((check) => check.ok)) return this.#store.getJob(jobId);
    return this.confirmManualSetup(jobId, workspaceId);
  }

  async #verifyAdmin(machine: MachineRecord, access: MachineAccessRecord): Promise<VerificationCheck[]> {
    const endpoint: SshEndpoint = { host: machine.host, port: machine.port, user: access.account, knownHost: machine.knownHost, connectionId: access.connectionId };
    try {
      const result = await this.#transport.run(endpoint, "printf 'user=%s\\n' \"$(id -un)\"; if sudo -n true 2>/dev/null; then echo sudo=yes; else echo sudo=no; fi", "", { timeoutMs: 30_000 });
      const values = new Map(result.stdout.split("\n").map((line) => line.trim().split("=", 2) as [string, string]).filter((pair) => pair.length === 2));
      return [
        { id: "login", title: "Log in with the new key", ok: true, detail: `Authenticated with host key ${machine.hostKeyFingerprint}.` },
        { id: "identity", title: "Runs as the PSM administrator account", ok: values.get("user") === access.account, detail: `user ${values.get("user") ?? "unknown"}` },
        { id: "sudo", title: "Has administrator authority", ok: values.get("sudo") === "yes", detail: values.get("sudo") === "yes" ? "sudo -n works" : "sudo -n refused" },
      ];
    } catch (error) {
      return [{ id: "login", title: "Log in with the new key", ok: false, detail: this.#failure(error).message }];
    }
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
    if (access.releaseConnectionId) await this.#discardConnection(access.releaseConnectionId);
    return revoked;
  }

  async #discardConnection(connectionId: string): Promise<void> {
    if (!connectionId) return;
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
    if (method === "admin-ssh" && access.role === "admin" && machine.adminConnectionId === access.connectionId) {
      throw new MachineServiceError("This is already the machine's administrator connection.", 409, "already-admin");
    }
    if (method === "manual-command" && access.role === "helper") {
      throw new MachineServiceError("Installing the helper uploads its binary, so it needs an administrator connection for now.", 409, "admin-connection-required");
    }
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
          return { value: found, detail: inspectDetail(access.plan, found) };
        });
        const alreadyDone = isAlreadyDone(access.plan, report);
        await step("apply", async () => {
          if (alreadyDone) return { value: null, detail: "Already set up as planned; nothing to change.", status: "skipped" as const };
          const extra = await this.#beforeApply(admin, access.plan, report!, signal);
          let applied: InspectionReport;
          try {
            applied = await this.#runScript(admin, access.plan.script, "--apply", signal, extra);
          } catch (error) {
            if (error instanceof StepFailure) throw error;
            const transport = this.#failure(error);
            // The script may or may not have run. Only a fresh inspection can tell.
            throw new StepFailure(`${transport.message} The server may be partly set up; retry inspects it first.`, "uncertain", "uncertain");
          }
          if (applied.result !== "applied") throw new StepFailure(`Setup did not complete (${applied.result || "no result"}).`, applied.result === "conflict" ? "conflict" : "apply-failed");
          save({ receipt: [...job!.receipt, ...receiptFor(access.plan)] });
          return { value: null, detail: receiptFor(access.plan).join("; ") };
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

      const verified = await step("verify", async () => {
        const observed = access.role === "helper" ? await this.#verifyHelper(machine, access.plan as HelperInstallPlan, signal)
          : access.role === "deploy" ? await this.#verifyDeploy(machine, access, signal)
          : access.role === "admin" ? { checks: await this.#verifyAdmin(machine, access), targetDigest: null }
          : { checks: await this.#verifyAccess(machine, access, signal), targetDigest: null };
        const failed = observed.checks.filter((check) => !check.ok);
        if (failed.length) throw new StepFailure(`Verification failed: ${failed.map((check) => `${check.title}: ${check.detail}`).join("; ")}.`, "verification-failed");
        return { value: observed, detail: observed.checks.map((check) => check.title).join(", ") };
      });
      await step("save", async () => {
        const current = this.#store.getAccess(access.id);
        this.#store.updateAccess(access.id, current.revision, (value) => ({ ...value, state: "ready", checks: verified.checks, verifiedAt: this.#now(), updatedAt: this.#now() }));
        if (access.plan.role === "admin") {
          await this.#markConnectionReady(access.connectionId, null);
          const latest = this.#store.getMachine(machine.id);
          this.#store.updateMachine(machine.id, latest.revision, (value) => ({ ...value, adminConnectionId: access.connectionId, updatedAt: this.#now() }));
          return { value: null, detail: `PSM now administers ${machine.name} as ${access.account}. Remove this access after setup if you prefer.` };
        }
        if (access.plan.role === "helper") {
          const plan = access.plan;
          const latest = this.#store.getMachine(machine.id);
          this.#store.updateMachine(machine.id, latest.revision, (value) => ({ ...value, helper: { sha256: plan.helper.sha256, arch: plan.helper.arch, sourceDigest: plan.helper.sourceDigest, verifiedAt: this.#now() }, updatedAt: this.#now() }));
          return { value: null, detail: `Host helper ${plan.helper.sha256.slice(0, 16)}… is running on ${machine.name}.` };
        }
        const pinned = access.plan.role === "deploy" && verified.targetDigest
          ? { [access.plan.target.targetId]: { fingerprint: verified.targetDigest, revision: access.plan.target.revision } }
          : null;
        for (const connectionId of [access.connectionId, access.releaseConnectionId].filter((value): value is string => Boolean(value))) {
          await this.#markConnectionReady(connectionId, pinned);
        }
        return { value: null, detail: `Connection ${access.connectionId} is ready for ${access.projectName} ${access.environmentId}${pinned ? `; target contract ${verified.targetDigest} pinned` : ""}.` };
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

  async #runScript(endpoint: SshEndpoint, script: string, mode: "--inspect" | "--apply", signal?: AbortSignal, extra: string[] = []): Promise<InspectionReport> {
    const privileged = endpoint.user === "root" ? "" : "sudo -n ";
    // Extra arguments are PSM-generated paths checked against a fixed pattern by the script too.
    for (const argument of extra) if (!/^\/tmp\/psm-host-helper\.[A-Za-z0-9]{6,32}$/.test(argument)) throw new StepFailure("Refusing an unexpected setup argument.", "invalid");
    const result = await this.#transport.run(endpoint, `${privileged}bash -s -- ${mode}${extra.map((argument) => ` ${argument}`).join("")}`, script, { signal, timeoutMs: 300_000 });
    if (/a password is required|a terminal is required/i.test(result.stderr)) {
      throw new StepFailure(`${endpoint.user} needs a password for sudo, so PSM cannot run setup on its own. Use "Run a setup command once" instead.`, "sudo-password-required");
    }
    try {
      const report = parseInspection(result.stdout);
      if (!report.result && mode === "--apply") {
        throw new StepFailure(`Setup stopped early (exit ${result.code}): ${result.stderr.slice(-400) || "no diagnostic"}`, "apply-failed");
      }
      return report;
    } catch (error) {
      if (error instanceof StepFailure) throw error;
      throw new StepFailure(`The server did not return a setup report (exit ${result.code}): ${result.stderr.slice(-300) || "no diagnostic"}`, "no-report");
    }
  }

  /** Anything the apply step needs first. The helper binary is uploaded unprivileged; the script checks its digest. */
  async #beforeApply(admin: SshEndpoint, plan: AccessPlan, report: InspectionReport, signal: AbortSignal): Promise<string[]> {
    if (plan.role !== "helper" || report.values.binary !== "absent") return [];
    const build = this.#buildHelper(plan.helper.arch);
    if (build.sha256 !== plan.helper.sha256) throw new StepFailure("The helper build changed since this plan was reviewed. Plan the install again.", "plan-changed");
    const result = await this.#transport.run(admin, "umask 077; f=$(mktemp /tmp/psm-host-helper.XXXXXXXX) && cat > \"$f\" && echo \"$f\"", fs.readFileSync(build.file), { signal, timeoutMs: 300_000 });
    const uploaded = result.stdout.trim();
    if (result.code !== 0 || !/^\/tmp\/psm-host-helper\.[A-Za-z0-9]{6,32}$/.test(uploaded)) throw new StepFailure(`Uploading the helper failed: ${result.stderr || "no diagnostic"}`, "upload-failed");
    return [uploaded];
  }

  async #verifyHelper(machine: MachineRecord, plan: HelperInstallPlan, signal: AbortSignal): Promise<{ checks: VerificationCheck[]; targetDigest: null }> {
    const report = await this.#runScript(this.#adminEndpoint(machine), plan.script, "--inspect", signal);
    const values = report.values;
    return {
      targetDigest: null,
      checks: [
        { id: "binary", title: "Helper binary matches the reviewed build", ok: values.binary === "match", detail: `${values.binary ?? "unknown"} (sha256 ${plan.helper.sha256.slice(0, 16)}…)` },
        { id: "files", title: "Client and service unit match", ok: values.client === "match" && values.unit === "match", detail: `client ${values.client}, unit ${values.unit}` },
        { id: "service", title: "Service is running", ok: values.service === "active", detail: `psm-host-helper.service ${values.service ?? "unknown"}` },
        { id: "socket", title: "Helper socket is listening", ok: values.socket === "present", detail: "/run/psm-deploy/helper.sock" },
        { id: "packages", title: "nginx and certbot are installed", ok: !values.missing_packages, detail: values.missing_packages ? `missing ${values.missing_packages}` : "present" },
      ],
    };
  }

  /**
   * Observe the target through the helper as each identity, and check each
   * can do only what its role allows. The contract fingerprint pinned into
   * the connections is the one the helper itself reports.
   */
  async #verifyDeploy(machine: MachineRecord, access: MachineAccessRecord, signal: AbortSignal): Promise<{ checks: VerificationCheck[]; targetDigest: string | null }> {
    const plan = access.plan as DeployAccessPlan;
    const profile = (connectionId: string) => profileFromRecord(this.#deployments.getConnection(connectionId));
    const observe = async (connectionId: string, operation: string) => {
      try {
        return await this.#helper.invoke({ connection: profile(connectionId), request: hostHelperRequest({ targetId: plan.target.targetId, operation, desired: {} }), signal });
      } catch (error) {
        // A refusal arrives as HostHelperError carrying the helper's own code.
        const code = error instanceof HostHelperError ? error.code : "transport";
        return { outcome: "failed" as const, code, detail: error instanceof Error ? error.message : String(error), data: undefined };
      }
    };
    const infra = await observe(access.connectionId, "observe-target");
    const release = await observe(access.releaseConnectionId!, "observe-target");
    const crossRole = await observe(access.releaseConnectionId!, "observe-resource");
    const digestOf = (response: { data?: unknown }) => {
      const value = (response.data as { targetDigest?: unknown } | undefined)?.targetDigest;
      return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value) ? value : null;
    };
    let shell = "";
    try {
      const result = await this.#transport.run({ host: machine.host, port: machine.port, user: plan.account, knownHost: machine.knownHost, connectionId: access.connectionId }, "id", "", { signal, timeoutMs: 30_000 });
      shell = result.stdout;
    } catch { /* refused outright is also no shell */ }
    const targetDigest = digestOf(infra);
    return {
      targetDigest,
      checks: [
        { id: "infra-observe", title: "Infrastructure identity reaches the helper", ok: infra.outcome === "succeeded" && Boolean(targetDigest), detail: infra.outcome === "succeeded" ? `target ${targetDigest}` : `${infra.code}: ${infra.detail}` },
        { id: "release-observe", title: "Release identity reaches the helper", ok: release.outcome === "succeeded" && digestOf(release) === targetDigest, detail: release.outcome === "succeeded" ? "same target contract" : `${release.code}: ${release.detail}` },
        { id: "release-scope", title: "Release identity cannot run infrastructure operations", ok: crossRole.outcome === "failed" && crossRole.code === "not-authorized", detail: `${crossRole.code}: ${crossRole.detail}` },
        { id: "no-shell", title: "Deploy keys open no shell", ok: !/uid=\d+/.test(shell), detail: shell ? "a command ran" : "forced to the helper client" },
      ],
    };
  }

  async #markConnectionReady(connectionId: string, targetContracts: Record<string, { fingerprint: string; revision: string }> | null): Promise<void> {
    let connection = this.#deployments.getConnection(connectionId);
    if (targetContracts) {
      const metadata = connection.metadata as { publicMetadata?: Record<string, unknown> };
      const publicMetadata = { ...(metadata.publicMetadata ?? {}), targetContracts };
      connection = this.#deployments.updateConnection({
        connectionId, expectedMetadataRevision: connection.metadataRevision, label: connection.label, readiness: connection.readiness,
        metadata: { ...(connection.metadata as object), publicMetadata } as never, constraints: connection.constraints, secretGeneration: connection.secretGeneration, updatedAt: this.#now(),
      });
    }
    const status = await this.#broker.status(connectionId, ["privateKey"]);
    this.#deployments.updateConnectionSecretStatus({ connectionId, expectedSecretGeneration: connection.secretGeneration, secretGeneration: status.generation, readiness: status.ready ? "ready" : "missing-secret", updatedAt: this.#now() });
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

function inspectDetail(plan: AccessPlan, report: InspectionReport): string {
  const values = report.values;
  if (plan.role === "helper") return `${report.arch}; helper ${values.binary}, service ${values.service}${values.missing_packages ? `; will install ${values.missing_packages}` : ""}.`;
  if (plan.role === "deploy") return `helper ${values.helper}; ${plan.account} ${values.infra}/${values.infra_key}, ${plan.release.account} ${values.release}/${values.release_key}; target ${values.target}.`;
  if (plan.role === "admin") return `account ${values.account}, key ${values.key}, sudoers ${values.sudoers}.`;
  return `${report.osId} ${report.osVersion} ${report.arch}; account ${report.account}, key ${report.key}.`;
}

function isAlreadyDone(plan: AccessPlan, report: InspectionReport): boolean {
  const values = report.values;
  if (plan.role === "helper") return values.binary === "match" && values.client === "match" && values.unit === "match" && values.service === "active" && values.socket === "present" && !values.missing_packages;
  if (plan.role === "deploy") return values.infra === "present" && values.infra_key === "match" && values.release === "present" && values.release_key === "match" && values.target === "match";
  if (plan.role === "admin") return values.account === "present" && values.key === "match" && values.sudoers === "match";
  return report.account === "present" && report.key === "match" && report.workdir === "present";
}

function receiptFor(plan: AccessPlan): string[] {
  if (plan.role === "helper") return [`host helper ${plan.helper.sha256.slice(0, 16)}… and psm-host-helper.service`, "psm-deploy group", "/etc/psm-deploy and /var/lib/psm-deploy"];
  if (plan.role === "admin") return [`administrator account ${plan.account}`, `sudoers entry ${plan.sudoersFile}`, `authorized key ${plan.publicKeyFingerprint}`];
  if (plan.role === "deploy") return [`accounts ${plan.account} and ${plan.release.account}`, `authorized keys ${plan.publicKeyFingerprint}, ${plan.release.publicKeyFingerprint}`, `enrolled target ${plan.target.targetId} (${plan.target.revision})`];
  return [`account ${plan.account}`, `directory ${plan.workdir}`, `authorized key ${plan.publicKeyFingerprint}`];
}
