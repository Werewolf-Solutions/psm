import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decryptBackupObject,
  encryptBackupObject,
  exclusionReason,
  safeRestoreDestination,
  validateBackupManifest,
} from "./backups.ts";

test("backup objects round-trip and authenticate ciphertext plus context", () => {
  const key = crypto.randomBytes(32);
  const plaintext = Buffer.from("source code that stays private");
  const encrypted = encryptBackupObject(key, plaintext, "psm:blob:test");
  assert.deepEqual(decryptBackupObject(key, encrypted, "psm:blob:test"), plaintext);
  assert.throws(() => decryptBackupObject(key, encrypted, "psm:blob:other"));

  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptBackupObject(key, tampered, "psm:blob:test"));
});

test("backup exclusions always reject credentials, dependencies, and private keys", () => {
  assert.equal(exclusionReason(".env"), "environment file");
  assert.equal(exclusionReason(".env.production"), "environment file");
  assert.equal(exclusionReason("node_modules/package/index.js"), "generated/dependency directory");
  assert.equal(exclusionReason("secrets/client.pem"), "private key or credential store");
  assert.equal(exclusionReason(".psm-cloud-device.json"), "credential/session file");
  assert.equal(exclusionReason("logs/server.log"), "generated/dependency directory");
  assert.equal(exclusionReason(".aws/credentials"), "generated/dependency directory");
  assert.equal(exclusionReason("infra/prod.tfvars"), "private key or credential store");
  assert.equal(exclusionReason("src/index.ts"), null);
});

test("restore paths cannot be absolute or escape the destination", () => {
  const root = path.join(os.tmpdir(), "psm-safe-restore");
  assert.equal(safeRestoreDestination(root, "src/index.ts"), path.join(root, "src/index.ts"));
  assert.throws(() => safeRestoreDestination(root, "../outside"));
  assert.throws(() => safeRestoreDestination(root, path.resolve(root, "absolute")));
  assert.throws(() => safeRestoreDestination(root, "bad\0path"));
});

test("restore manifest validation bounds paths, chunks, and reconstructed sizes", () => {
  const id = "a".repeat(43);
  const valid = {
    version: 1,
    projectId: "psm",
    projectName: "PSM",
    createdAt: "2026-07-20T12:00:00.000Z",
    files: [{
      path: "src/index.ts",
      size: 4,
      mode: 0o644,
      mtimeMs: 1,
      chunks: [{ id, plainSize: 4 }],
    }],
    skipped: [],
  };
  assert.equal(validateBackupManifest(valid).files[0].size, 4);
  assert.throws(() => validateBackupManifest({
    ...valid,
    files: [{ ...valid.files[0], size: 5 }],
  }), /does not match/);
  assert.throws(() => validateBackupManifest({
    ...valid,
    files: [{ ...valid.files[0], path: "src\\ambiguous.ts" }],
  }), /file path/);
  assert.throws(() => validateBackupManifest({
    ...valid,
    files: [{ ...valid.files[0], chunks: [{ id: "short", plainSize: 4 }] }],
  }), /chunk is invalid/);
});
