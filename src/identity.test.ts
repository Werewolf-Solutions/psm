import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureProjectId, isProjectId, mintProjectId, readProjectId } from "./identity.ts";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "psm-identity-"));
}

test("a project has no id until one is assigned", () => {
  const dir = tmpProject();
  assert.equal(readProjectId(dir), null);
  assert.equal(fs.existsSync(path.join(dir, ".psm")), false);
});

test("ensureProjectId mints a committed id and is idempotent", () => {
  const dir = tmpProject();
  const first = ensureProjectId(dir, "demo");
  assert.ok(isProjectId(first.id));
  assert.equal(first.name, "demo");

  const stored = JSON.parse(fs.readFileSync(path.join(dir, ".psm", "identity.json"), "utf8"));
  assert.equal(stored.id, first.id);
  assert.equal(stored.version, 1);

  // a second call keeps the original id, even under a different folder name
  assert.equal(ensureProjectId(dir, "renamed").id, first.id);
  assert.equal(readProjectId(dir), first.id);
});

test("the id survives a folder rename", () => {
  const dir = tmpProject();
  const id = ensureProjectId(dir, "before").id;
  const renamed = path.join(path.dirname(dir), path.basename(dir) + "-renamed");
  fs.renameSync(dir, renamed);
  assert.equal(readProjectId(renamed), id);
});

test("malformed or foreign identity files read as no id", () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, ".psm"));
  const file = path.join(dir, ".psm", "identity.json");

  fs.writeFileSync(file, "not json");
  assert.equal(readProjectId(dir), null);

  fs.writeFileSync(file, JSON.stringify({ id: "../../etc/passwd" }));
  assert.equal(readProjectId(dir), null);

  fs.writeFileSync(file, JSON.stringify({ id: "prj_short" }));
  assert.equal(readProjectId(dir), null);
});

test("minted ids are unique and well formed", () => {
  const ids = new Set(Array.from({ length: 200 }, () => mintProjectId()));
  assert.equal(ids.size, 200);
  assert.ok([...ids].every(isProjectId));
});
