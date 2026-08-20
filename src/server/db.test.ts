import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SCHEMA_VERSION, closeDatabase, db, migrate, openDatabase, readMeta, writeMeta } from "./db.ts";

const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), "psm-db-"));

test("a new database comes up on the current schema", () => {
  const handle = openDatabase(":memory:");
  const row = handle.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(row.user_version, SCHEMA_VERSION);
  assert.ok(SCHEMA_VERSION > 0, "there is at least one migration");
});

test("migrating an up-to-date database changes nothing", () => {
  const file = path.join(sandbox(), "psm.db");
  const first = openDatabase(file);
  first.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("k", "v");
  first.close();

  const second = openDatabase(file);
  assert.equal(migrate(second), SCHEMA_VERSION);
  assert.equal(readMeta(second, "k"), "v", "re-opening did not rebuild the schema");
});

test("meta values are written once and overwritten in place", () => {
  const handle = openDatabase(":memory:");
  assert.equal(readMeta(handle, "absent"), null);
  writeMeta(handle, "ran", "first");
  writeMeta(handle, "ran", "second");
  assert.equal(readMeta(handle, "ran"), "second");
  assert.equal(
    (handle.prepare("SELECT COUNT(*) AS n FROM meta").get() as { n: number }).n,
    1,
  );
});

test("the shared database lands where PSM_DB_FILE says, owner-readable only", () => {
  const file = path.join(sandbox(), "nested", "psm.db");
  const previous = process.env.PSM_DB_FILE;
  process.env.PSM_DB_FILE = file;
  try {
    db().exec("SELECT 1");
    assert.ok(fs.existsSync(file), "the directory was created along the way");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the database is the owner's alone");
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700, "so is the directory psm made for it");
  } finally {
    closeDatabase();
    if (previous === undefined) delete process.env.PSM_DB_FILE;
    else process.env.PSM_DB_FILE = previous;
  }
});
