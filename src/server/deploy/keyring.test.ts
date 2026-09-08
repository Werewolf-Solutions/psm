import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySecretBackend, SecretBroker } from "./connections.ts";
import {
  DEPLOYMENT_KEYRING_SERVICE,
  KeyringSecretBackend,
  PreferredSecretBackend,
  type KeyringEntryFactory,
} from "./keyring.ts";

function fakeKeyring(options: { failProbe?: boolean; arrayResults?: boolean } = {}) {
  const values = new Map<string, Uint8Array>();
  const factory: KeyringEntryFactory = (service, account) => {
    assert.equal(service, DEPLOYMENT_KEYRING_SERVICE);
    return {
      async getSecret() {
        if (account === "v1:probe" && options.failProbe) throw new Error("keyring locked");
        const value = values.get(account);
        return value ? options.arrayResults ? Array.from(value) : new Uint8Array(value) : undefined;
      },
      async setSecret(value) { values.set(account, new Uint8Array(value)); },
      async deleteCredential() { return values.delete(account); },
    };
  };
  return { values, factory, backend: new KeyringSecretBackend(factory) };
}

test("native array results preserve saved slots and readiness across broker recreation", async () => {
  const { backend, factory } = fakeKeyring({ arrayResults: true });
  const broker = new SecretBroker({ backend });
  await broker.put("dns:prod", "apiToken", "test-dns-token");
  assert.equal((await broker.status("dns:prod", ["apiToken"])).ready, true);

  // A second write must retain the first slot when it reads the existing native index.
  await broker.put("github:prod", "token", "test-api-token");
  await broker.put("github:prod", "app-key", "test-app-key");
  const restored = new SecretBroker({ backend: new KeyringSecretBackend(factory) });
  const status = await restored.status("github:prod", ["token", "app-key"]);
  assert.equal(status.ready, true);
  assert.deepEqual(status.availableSlots, ["app-key", "token"]);
  assert.match(status.credentialFingerprint!, /^hmac-sha256:/);
  assert.equal((await restored.status("dns:prod", ["apiToken"])).ready, true);
  await restored.withLease("dns:prod", ["apiToken"], (lease) => {
    assert.equal(lease.useUtf8("apiToken", (value) => value), "test-dns-token");
  });
  await restored.delete("github:prod", "app-key");
  assert.deepEqual((await restored.status("github:prod", ["token"])).availableSlots, ["token"]);
});

test("keyring secrets round-trip while slot names remain independently enumerable", async () => {
  const { backend, values } = fakeKeyring();
  await backend.write("github:prod", "token", Buffer.from("secret-one"));
  await backend.write("github:prod", "app-key", Buffer.from("secret-two"));
  assert.deepEqual(await backend.listSlots("github:prod"), ["app-key", "token"]);
  assert.equal(Buffer.from((await backend.read("github:prod", "token"))!).toString(), "secret-one");
  assert.ok([...values.keys()].every((account) => !account.includes("github") && !account.includes("token")));
  assert.equal(await backend.delete("github:prod", "token"), true);
  assert.deepEqual(await backend.listSlots("github:prod"), ["app-key"]);
});

test("an unavailable native keyring selects the zeroizing memory backend for the process", async () => {
  const { backend } = fakeKeyring({ failProbe: true });
  const memory = new InMemorySecretBackend();
  const preferred = new PreferredSecretBackend(backend, memory);
  await preferred.write("monitor:prod", "token", Buffer.from("ephemeral"));
  assert.equal(Buffer.from((await preferred.read("monitor:prod", "token"))!).toString(), "ephemeral");
  assert.deepEqual(await backend.listSlots("monitor:prod"), []);
});

test("a missing indexed credential is pruned instead of being reported ready", async () => {
  const { backend, values } = fakeKeyring();
  await backend.write("dns:prod", "token", Buffer.from("gone soon"));
  const secretKey = [...values.keys()].find((key) => key.startsWith("v1:secret:"))!;
  values.delete(secretKey);
  assert.deepEqual(await backend.listSlots("dns:prod"), []);
});
