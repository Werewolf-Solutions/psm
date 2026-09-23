/**
 * Durable machine state: the machines a workspace registered, the access each
 * project environment was given on them, and the setup jobs that created it.
 *
 * Every write is a compare-and-set on a revision, so two tabs (or a tab and a
 * resumed job) cannot silently overwrite each other. Jobs carry a lease: a job
 * whose lease expired belongs to a process that died, and is resumed by
 * re-inspecting the server rather than by replaying what it last attempted.
 */
import type { DatabaseSync } from "node:sqlite";

import type { CommandAccessPlan, HostKeySource, InspectionReport, MachineRole, RiskClass } from "./plan.ts";

export class MachineStoreError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "MachineStoreError";
  }
}

export interface MachineRecord {
  id: string;
  workspaceId: string;
  name: string;
  host: string;
  port: number;
  knownHost: string;
  hostKeyFingerprint: string;
  hostKeySource: HostKeySource;
  /** A saved administrator connection PSM may use for setup, if any. */
  adminConnectionId: string | null;
  lastInspection: (InspectionReport & { at: number; as: string }) | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type AccessState = "planned" | "setting-up" | "ready" | "failed" | "revoked";

export interface VerificationCheck {
  id: string;
  title: string;
  ok: boolean;
  detail: string;
}

export interface MachineAccessRecord {
  id: string;
  machineId: string;
  projectId: string;
  projectName: string;
  environmentId: string;
  role: MachineRole;
  risk: RiskClass;
  account: string;
  workdir: string;
  publicKeyFingerprint: string;
  /** Deployment connection holding the private key; the key itself lives in the broker. */
  connectionId: string;
  state: AccessState;
  plan: CommandAccessPlan;
  checks: VerificationCheck[];
  verifiedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type JobState = "awaiting-approval" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped" | "uncertain";
export type SetupMethod = "admin-ssh" | "manual-command";

export interface SetupStep {
  id: "identity" | "inspect" | "apply" | "verify" | "save";
  title: string;
  status: StepStatus;
  detail: string;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface SetupJobRecord {
  id: string;
  machineId: string;
  accessId: string;
  method: SetupMethod;
  planDigest: string;
  state: JobState;
  steps: SetupStep[];
  /** What the job observably changed, for cancellation and cleanup reviews. */
  receipt: string[];
  error: { code: string; message: string } | null;
  approvedBy: string | null;
  lease: { owner: string; expiresAt: number } | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

function parse<T>(row: { document: string } | undefined): T | null {
  return row ? JSON.parse(row.document) as T : null;
}

export class MachineStore {
  constructor(private readonly database: () => DatabaseSync) {}

  #transaction<T>(operation: (database: DatabaseSync) => T): T {
    const database = this.database();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(database);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  listMachines(workspaceId: string): MachineRecord[] {
    return (this.database().prepare("SELECT document FROM machines WHERE workspace_id = ? ORDER BY host, port").all(workspaceId) as { document: string }[])
      .map((row) => JSON.parse(row.document) as MachineRecord);
  }

  getMachine(id: string, workspaceId?: string): MachineRecord {
    const machine = parse<MachineRecord>(this.database().prepare("SELECT document FROM machines WHERE id = ?").get(id) as { document: string } | undefined);
    // A machine in another workspace answers exactly like one that does not exist.
    if (!machine || (workspaceId !== undefined && machine.workspaceId !== workspaceId)) throw new MachineStoreError("Machine not found.", 404, "machine-not-found");
    return machine;
  }

  createMachine(machine: Omit<MachineRecord, "revision">): MachineRecord {
    const record: MachineRecord = { ...machine, revision: 1 };
    try {
      this.database().prepare("INSERT INTO machines (id, workspace_id, host, port, revision, document) VALUES (?, ?, ?, ?, 1, ?)")
        .run(record.id, record.workspaceId, record.host, record.port, JSON.stringify(record));
    } catch (error) {
      if (/UNIQUE/.test(String(error))) throw new MachineStoreError("This workspace already registered that host and port.", 409, "machine-exists");
      throw error;
    }
    return record;
  }

  updateMachine(id: string, expectedRevision: number, change: (machine: MachineRecord) => MachineRecord): MachineRecord {
    return this.#transaction((database) => {
      const current = this.getMachine(id);
      if (current.revision !== expectedRevision) throw new MachineStoreError("This machine changed since you loaded it. Reload and try again.", 409, "machine-revision");
      const next = { ...change(structuredClone(current)), id, workspaceId: current.workspaceId, host: current.host, port: current.port, revision: current.revision + 1 };
      database.prepare("UPDATE machines SET revision = ?, document = ? WHERE id = ? AND revision = ?").run(next.revision, JSON.stringify(next), id, expectedRevision);
      return next;
    });
  }

  removeMachine(id: string, expectedRevision: number): void {
    this.#transaction((database) => {
      const current = this.getMachine(id);
      if (current.revision !== expectedRevision) throw new MachineStoreError("This machine changed since you loaded it.", 409, "machine-revision");
      const access = this.listAccess(id).filter((entry) => entry.state !== "revoked");
      if (access.length) throw new MachineStoreError("Disconnect this machine's projects first.", 409, "machine-in-use");
      database.prepare("DELETE FROM machine_setup_jobs WHERE machine_id = ?").run(id);
      database.prepare("DELETE FROM machine_access WHERE machine_id = ?").run(id);
      database.prepare("DELETE FROM machines WHERE id = ?").run(id);
    });
  }

  listAccess(machineId: string): MachineAccessRecord[] {
    return (this.database().prepare("SELECT document FROM machine_access WHERE machine_id = ? ORDER BY project_id, environment_id").all(machineId) as { document: string }[])
      .map((row) => JSON.parse(row.document) as MachineAccessRecord);
  }

  accessForProject(projectId: string): MachineAccessRecord[] {
    return (this.database().prepare("SELECT document FROM machine_access WHERE project_id = ? ORDER BY machine_id, environment_id").all(projectId) as { document: string }[])
      .map((row) => JSON.parse(row.document) as MachineAccessRecord);
  }

  getAccess(id: string): MachineAccessRecord {
    const access = parse<MachineAccessRecord>(this.database().prepare("SELECT document FROM machine_access WHERE id = ?").get(id) as { document: string } | undefined);
    if (!access) throw new MachineStoreError("Machine access not found.", 404, "access-not-found");
    return access;
  }

  findAccess(machineId: string, projectId: string, environmentId: string, role: MachineRole): MachineAccessRecord | null {
    return parse<MachineAccessRecord>(this.database().prepare("SELECT document FROM machine_access WHERE machine_id = ? AND project_id = ? AND environment_id = ? AND role = ?")
      .get(machineId, projectId, environmentId, role) as { document: string } | undefined);
  }

  createAccess(access: Omit<MachineAccessRecord, "revision">): MachineAccessRecord {
    const record: MachineAccessRecord = { ...access, revision: 1 };
    try {
      this.database().prepare("INSERT INTO machine_access (id, machine_id, project_id, environment_id, role, revision, document) VALUES (?, ?, ?, ?, ?, 1, ?)")
        .run(record.id, record.machineId, record.projectId, record.environmentId, record.role, JSON.stringify(record));
    } catch (error) {
      if (/UNIQUE/.test(String(error))) throw new MachineStoreError("That project environment already has this access on the machine.", 409, "access-exists");
      throw error;
    }
    return record;
  }

  updateAccess(id: string, expectedRevision: number, change: (access: MachineAccessRecord) => MachineAccessRecord): MachineAccessRecord {
    return this.#transaction((database) => {
      const current = this.getAccess(id);
      if (current.revision !== expectedRevision) throw new MachineStoreError("This access changed since you loaded it.", 409, "access-revision");
      const next = { ...change(structuredClone(current)), id, machineId: current.machineId, projectId: current.projectId, environmentId: current.environmentId, role: current.role, revision: current.revision + 1 };
      database.prepare("UPDATE machine_access SET revision = ?, document = ? WHERE id = ? AND revision = ?").run(next.revision, JSON.stringify(next), id, expectedRevision);
      return next;
    });
  }

  removeAccess(id: string): void {
    this.database().prepare("DELETE FROM machine_access WHERE id = ?").run(id);
  }

  saveJob(job: SetupJobRecord): SetupJobRecord {
    this.database().prepare(
      `INSERT INTO machine_setup_jobs (id, machine_id, access_id, state, updated_at, document) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, document = excluded.document`,
    ).run(job.id, job.machineId, job.accessId, job.state, job.updatedAt, JSON.stringify(job));
    return job;
  }

  getJob(id: string): SetupJobRecord {
    const job = parse<SetupJobRecord>(this.database().prepare("SELECT document FROM machine_setup_jobs WHERE id = ?").get(id) as { document: string } | undefined);
    if (!job) throw new MachineStoreError("Setup job not found.", 404, "job-not-found");
    return job;
  }

  listJobs(machineId: string): SetupJobRecord[] {
    return (this.database().prepare("SELECT document FROM machine_setup_jobs WHERE machine_id = ? ORDER BY updated_at DESC LIMIT 50").all(machineId) as { document: string }[])
      .map((row) => JSON.parse(row.document) as SetupJobRecord);
  }

  /** Jobs another process was running when it stopped renewing its lease. */
  abandonedJobs(now: number): SetupJobRecord[] {
    return (this.database().prepare("SELECT document FROM machine_setup_jobs WHERE state = 'running'").all() as { document: string }[])
      .map((row) => JSON.parse(row.document) as SetupJobRecord)
      .filter((job) => !job.lease || job.lease.expiresAt <= now);
  }

  /** Take the job's lease if nobody else holds a live one. */
  claimJob(id: string, owner: string, now: number, ttlMs: number): SetupJobRecord | null {
    return this.#transaction(() => {
      const job = this.getJob(id);
      if (job.lease && job.lease.owner !== owner && job.lease.expiresAt > now) return null;
      const claimed = { ...job, lease: { owner, expiresAt: now + ttlMs }, updatedAt: now };
      this.saveJob(claimed);
      return claimed;
    });
  }
}
