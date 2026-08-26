import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deploymentFingerprintKey } from "./secrets.ts";

test("fingerprint key is stable and private", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-key-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(deploymentFingerprintKey(root), deploymentFingerprintKey(root));
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(root, ".fingerprint-key")).mode & 0o777, 0o600);
});
