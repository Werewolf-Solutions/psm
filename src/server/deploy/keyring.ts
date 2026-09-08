import { AsyncEntry } from "@napi-rs/keyring";

import { InMemorySecretBackend, type SecretBackend } from "./connections.ts";

export const DEPLOYMENT_KEYRING_SERVICE = "werewolf.psm.deployments";

interface KeyringEntry {
  // Native bindings can return number[] despite declaring Uint8Array in their typings.
  getSecret(signal?: AbortSignal): Promise<Uint8Array | number[] | undefined>;
  setSecret(value: Uint8Array, signal?: AbortSignal): Promise<void>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
}

export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function secretAccount(connectionId: string, slot: string): string {
  return `v1:secret:${encoded(connectionId)}:${encoded(slot)}`;
}

function indexAccount(connectionId: string): string {
  return `v1:index:${encoded(connectionId)}`;
}

function parseIndex(value: Uint8Array | number[] | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(value)));
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return [];
    return [...new Set(parsed)].sort();
  } catch {
    return [];
  }
}

/** Secrets and their non-secret slot index live in the native credential service. */
export class KeyringSecretBackend implements SecretBackend {
  readonly #entry: KeyringEntryFactory;

  constructor(entry: KeyringEntryFactory = (service, account) => new AsyncEntry(service, account)) {
    this.#entry = entry;
  }

  #for(account: string): KeyringEntry {
    return this.#entry(DEPLOYMENT_KEYRING_SERVICE, account);
  }

  async probe(): Promise<void> {
    // A read of an intentionally absent account exercises the native service without writing a
    // sentinel credential or prompting the user to unlock anything PSM does not already need.
    await this.#for("v1:probe").getSecret();
  }

  async #slots(connectionId: string): Promise<string[]> {
    return parseIndex(await this.#for(indexAccount(connectionId)).getSecret());
  }

  async #writeSlots(connectionId: string, slots: readonly string[]): Promise<void> {
    const entry = this.#for(indexAccount(connectionId));
    const normalized = [...new Set(slots)].sort();
    if (normalized.length === 0) {
      await entry.deleteCredential().catch(() => false);
      return;
    }
    await entry.setSecret(Buffer.from(JSON.stringify(normalized), "utf8"));
  }

  async read(connectionId: string, slot: string): Promise<Uint8Array | null> {
    const value = await this.#for(secretAccount(connectionId, slot)).getSecret();
    // Buffer.slice() is a view, unlike Uint8Array.slice(). Copy explicitly so the broker's
    // zeroization never overwrites the keyring binding's returned storage.
    return value ? new Uint8Array(value) : null;
  }

  async write(connectionId: string, slot: string, value: Uint8Array): Promise<void> {
    const entry = this.#for(secretAccount(connectionId, slot));
    await entry.setSecret(new Uint8Array(value));
    try {
      await this.#writeSlots(connectionId, [...await this.#slots(connectionId), slot]);
    } catch (error) {
      await entry.deleteCredential().catch(() => false);
      throw error;
    }
  }

  async delete(connectionId: string, slot: string): Promise<boolean> {
    const entry = this.#for(secretAccount(connectionId, slot));
    const removed = await entry.deleteCredential().catch(() => false);
    if (removed) await this.#writeSlots(connectionId, (await this.#slots(connectionId)).filter((item) => item !== slot));
    return removed;
  }

  async listSlots(connectionId: string): Promise<string[]> {
    const slots = await this.#slots(connectionId);
    const present: string[] = [];
    for (const slot of slots) {
      const value = await this.read(connectionId, slot);
      if (value) {
        value.fill(0);
        present.push(slot);
      }
    }
    if (present.length !== slots.length) await this.#writeSlots(connectionId, present);
    return present;
  }
}

/** Select once per process; an unavailable keyring never causes a plaintext fallback. */
export class PreferredSecretBackend implements SecretBackend {
  readonly #persistent: KeyringSecretBackend;
  readonly #ephemeral: SecretBackend;
  #selected: Promise<SecretBackend> | null = null;

  constructor(persistent = new KeyringSecretBackend(), ephemeral: SecretBackend = new InMemorySecretBackend()) {
    this.#persistent = persistent;
    this.#ephemeral = ephemeral;
  }

  #backend(): Promise<SecretBackend> {
    this.#selected ??= this.#persistent.probe().then(
      () => this.#persistent,
      () => this.#ephemeral,
    );
    return this.#selected;
  }

  async read(connectionId: string, slot: string): Promise<Uint8Array | null> {
    return (await this.#backend()).read(connectionId, slot);
  }

  async write(connectionId: string, slot: string, value: Uint8Array): Promise<void> {
    return (await this.#backend()).write(connectionId, slot, value);
  }

  async delete(connectionId: string, slot: string): Promise<boolean> {
    return (await this.#backend()).delete(connectionId, slot);
  }

  async listSlots(connectionId: string): Promise<string[]> {
    return (await this.#backend()).listSlots(connectionId);
  }
}

export function defaultDeploymentSecretBackend(): SecretBackend {
  return new PreferredSecretBackend();
}
