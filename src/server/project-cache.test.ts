import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectCache } from "./project-cache.ts";

function kit(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-project-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const overrides = path.join(dir, "overrides.json");
  fs.writeFileSync(overrides, "{}");
  let clock = 1_000;
  let scans = 0;
  const cache = createProjectCache({
    scan: () => { scans++; return [{ name: "todo-app", scan: scans }]; },
    inputs: () => [overrides, path.join(dir, "links-not-created-yet.json")],
    ttlMs: 30_000,
    now: () => clock,
  });
  return { cache, overrides, scans: () => scans, tick: (ms: number) => { clock += ms; } };
}

test("repeated reads share one scan", (t) => {
  const h = kit(t);
  for (let i = 0; i < 5; i++) h.cache.get();
  assert.equal(h.scans(), 1, "switching tabs must not rescan the workspace");
});

test("a scan older than its lifetime is replaced", (t) => {
  const h = kit(t);
  h.cache.get();
  h.tick(29_999); h.cache.get();
  assert.equal(h.scans(), 1);
  h.tick(1); h.cache.get();
  assert.equal(h.scans(), 2, "git details lag by at most the lifetime");
});

test("an edited overrides file is picked up on the next read", (t) => {
  const h = kit(t);
  h.cache.get();
  fs.writeFileSync(h.overrides, JSON.stringify({ "todo-app": { pinned: true } }));
  assert.equal(h.cache.get()[0].scan, 2, "including edits made outside psm");
});

test("invalidate makes the next read rescan", (t) => {
  const h = kit(t);
  h.cache.get();
  h.cache.invalidate();
  h.cache.get();
  assert.equal(h.scans(), 2, "a new project folder is not visible in any input file");
});

test("a caller changing its copy does not change what the next caller reads", (t) => {
  const h = kit(t);
  h.cache.get()[0].name = "changed";
  assert.equal(h.cache.get()[0].name, "todo-app");
  assert.equal(h.scans(), 1);
});
