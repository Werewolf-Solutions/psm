/**
 * The atomic write every piece of psm's state goes through.
 *
 * What is being defended is narrow and worth stating: a reader must never see a
 * file mid-write. psm keeps JSON documents it writes whole, and half a JSON
 * document is not a document that parses — the loader drops it, and with it a
 * session's transcript or a workspace's overrides.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeFileAtomic } from "./store.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "psm-store-"));
const target = (name: string) => path.join(sandbox, name);
const modeOf = (file: string) => fs.statSync(file).mode & 0o777;
const leftovers = () => fs.readdirSync(sandbox).filter((entry) => entry.endsWith(".tmp"));

test("a new file is private by default", () => {
  const file = target("fresh.json");
  writeFileAtomic(file, '{"a":1}');
  assert.equal(fs.readFileSync(file, "utf8"), '{"a":1}');
  assert.equal(modeOf(file), 0o600, "state psm creates itself must not be world-readable");
});

test("an existing file keeps the mode it already had", () => {
  const file = target("existing.json");
  fs.writeFileSync(file, "{}", { mode: 0o644 });
  writeFileAtomic(file, '{"b":2}');
  assert.equal(modeOf(file), 0o644, "rewriting a file must not silently change who can read it");
});

test("an explicit mode overrules the mode on disk", () => {
  const file = target("sessions.json");
  fs.writeFileSync(file, "{}", { mode: 0o644 });
  writeFileAtomic(file, '{"c":3}', 0o600);
  assert.equal(modeOf(file), 0o600, "a file that must be private stays private across writes");
});

test("the replacement is whole — no truncate-then-fill window", () => {
  const file = target("replace.json");
  const long = JSON.stringify({ text: "x".repeat(100_000) });
  writeFileAtomic(file, long);
  writeFileAtomic(file, '{"short":true}');
  assert.equal(fs.readFileSync(file, "utf8"), '{"short":true}', "the old content must be gone entirely");
});

test("a successful write leaves no scratch file behind", () => {
  writeFileAtomic(target("clean.json"), "{}");
  assert.deepEqual(leftovers(), [], "a temp file surviving the write is one the next write trips over");
});

test("a failed write leaves no scratch file behind either, and still throws", () => {
  // A directory cannot be replaced by a rename from a file: the write succeeds,
  // the rename does not, which is exactly the half-way case the cleanup is for.
  const file = target("occupied");
  fs.mkdirSync(file);
  assert.throws(() => writeFileAtomic(file, "{}"), "the caller has to hear that its state was not saved");
  assert.deepEqual(leftovers(), [], "the scratch file must not outlive the attempt");
});
