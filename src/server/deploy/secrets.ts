import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sharedStateDir, writeFileAtomic } from "../../store.ts";
import type { SecretGenerationStore } from "./connections.ts";
import type { DeploymentStore } from "./store.ts";

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* filesystem does not expose POSIX modes */ }
}

/** Owners of a managed service's runtime secrets; see serviceSecretOwner. */
export const SERVICE_SECRET_OWNER_PREFIX = "service-secrets:";

/**
 * Where a unit's runtime secrets live in PSM's secret store: one owner per
 * project, environment and unit, one slot per variable name.
 */
export function serviceSecretOwner(projectId: string, environmentId: string, unitId: string): string {
  return `${SERVICE_SECRET_OWNER_PREFIX}${projectId}:${environmentId}:${unitId}`;
}

export function serviceSecretSlot(name: string): string {
  return `env.${name}`;
}

/** Persist secret generations in SQLite so a restart cannot revive an approved old plan. */
export class DeploymentSecretGenerationStore implements SecretGenerationStore {
  constructor(private readonly store: DeploymentStore) {}

  async readGeneration(connectionId: string): Promise<number> {
    if (connectionId.startsWith(SERVICE_SECRET_OWNER_PREFIX)) return this.store.getServiceSecretGeneration(connectionId);
    return this.store.getConnection(connectionId).secretGeneration;
  }

  async writeGeneration(connectionId: string, generation: number): Promise<void> {
    if (connectionId.startsWith(SERVICE_SECRET_OWNER_PREFIX)) {
      this.store.setServiceSecretGeneration(connectionId, generation, Date.now());
      return;
    }
    const current = this.store.getConnection(connectionId);
    this.store.updateConnectionSecretStatus({
      connectionId,
      expectedSecretGeneration: current.secretGeneration,
      secretGeneration: generation,
      readiness: current.readiness,
      updatedAt: Date.now(),
    });
  }
}

/** Stable local HMAC key used only to bind secret identity into plans, never as provider auth. */
export function deploymentFingerprintKey(root = sharedStateDir("credentials")): Uint8Array {
  ensurePrivateDirectory(root);
  const file = path.join(root, ".fingerprint-key");
  try {
    const value = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    if (value.byteLength !== 32) throw new Error("deployment credential fingerprint key is invalid");
    return new Uint8Array(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const value = randomBytes(32);
  try {
    fs.writeFileSync(file, value.toString("base64"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    value.fill(0);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return deploymentFingerprintKey(root);
    throw error;
  }
  return new Uint8Array(value);
}
