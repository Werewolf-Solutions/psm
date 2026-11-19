import assert from "node:assert/strict";
import test from "node:test";

import { blockersFor, collisionsAfter, mergedSince, normalizeScope, overlap, SCOPE_MAX, unionScope, widenScope, type ScheduledJob } from "./overlap.ts";

test("a scope is repo-relative paths; anything vague or outside the repo is unknown", () => {
  assert.deepEqual(normalizeScope(["./routes/registry.js", "/web/src/", "routes\\bots.js", "routes/registry.js"]), ["routes/bots.js", "routes/registry.js", "web/src/"]);
  assert.deepEqual(normalizeScope(["web/src/**/*.jsx"]), ["web/src/"], "a glob is as wide as its folder");
  for (const vague of [[], null, ["."], ["*"], ["../other/x.js"], ["src/../../x"], ["**/*.js"], [42], Array.from({ length: SCOPE_MAX + 1 }, (_, i) => `f${i}.js`)]) {
    assert.equal(normalizeScope(vague), null, JSON.stringify(vague));
  }
});

test("paths overlap when equal or one lies inside the other's folder; unknown overlaps everything", () => {
  assert.deepEqual(overlap(["routes/registry.js"], ["routes/"]), ["routes/registry.js"]);
  assert.deepEqual(overlap(["routes/"], ["routes/a.js", "web/x.js"]), ["routes/a.js"]);
  assert.equal(overlap(["routes/registry.js"], ["routes/registry.test.js"]), null, "a shared prefix is not a shared file");
  assert.equal(overlap(["routes-old/a.js"], ["routes/"]), null);
  assert.ok(overlap(null, ["a.js"]));
  assert.equal(unionScope(["a.js"], null), null);
  assert.deepEqual(unionScope(["b.js"], ["a.js", "b.js"]), ["a.js", "b.js"]);
});

const job = (jobId: string, status: string, scope: string[] | null, createdAt = 0, projectId = "p1"): ScheduledJob => ({ jobId, status, scope, createdAt, projectId });

test("a queued job waits for overlapping running, in-review and earlier queued jobs on its own project only", () => {
  const me = job("me", "queued", ["routes/a.js"], 10);
  const others = [
    job("running", "claimed", ["routes/"], 1),
    job("review", "review", ["routes/a.js"], 2),
    job("earlier", "queued", ["routes/a.js"], 5),
    job("later", "queued", ["routes/a.js"], 20),
    job("done", "accepted", ["routes/a.js"], 1),
    job("elsewhere", "claimed", ["routes/a.js"], 1, "p2"),
    job("apart", "claimed", ["web/"], 1),
  ];
  assert.deepEqual(blockersFor(me, others).map((blocker) => blocker.jobId), ["running", "review", "earlier"]);
});

test("after a job finishes only jobs already in review count as collisions", () => {
  const finished = job("me", "claimed", ["package.json", "a.js"]);
  const others = [job("review", "review", ["package.json"]), job("running", "claimed", ["a.js"]), job("queued", "queued", ["a.js"])];
  assert.deepEqual(collisionsAfter(finished, others), [{ jobId: "review", status: "review", paths: ["package.json"] }]);
});

test("a long list of changed files is widened to folders until it fits, never dropped for a guess", () => {
  const files = [
    "README.md", "server.js", "middleware/apiErrors.js", "test/api-errors.test.js",
    ...Array.from({ length: 10 }, (_, i) => `web/src/components/bots/Panel${i}.jsx`),
    ...Array.from({ length: 6 }, (_, i) => `web/src/pages/Page${i}.jsx`),
    "web/src/api/errors.js", "web/src/api/__tests__/errors.test.js",
  ];
  assert.equal(files.length, 22);
  const widened = widenScope(files)!;
  assert.ok(widened.length <= SCOPE_MAX);
  for (const file of files) assert.ok(overlap([file], widened), `${file} is still covered`);
  // Only as wide as it has to be: the deepest level gives way, the rest stay exact.
  assert.deepEqual(widened, [
    "README.md", "middleware/apiErrors.js", "server.js", "test/api-errors.test.js",
    "web/src/api/__tests__/", "web/src/api/errors.js", "web/src/components/bots/",
    ...Array.from({ length: 6 }, (_, i) => `web/src/pages/Page${i}.jsx`),
  ]);

  assert.deepEqual(widenScope(["a.js", "lib/b.js"]), ["a.js", "lib/b.js"], "a short list is kept as it is");
  assert.deepEqual(widenScope(["web/", "web/a.js", "web/x/b.js"]), ["web/"], "nothing inside a folder already listed");
  assert.equal(widenScope(Array.from({ length: SCOPE_MAX + 1 }, (_, i) => `f${i}.js`)), null, "too many files at the top: unknown");
  assert.equal(widenScope(["../x.js"]), null);
  assert.equal(normalizeScope(files), null, "a prediction that wide is still unknown");

  // Two scopes together stay a scope: widened, not unknown.
  const union = unionScope(Array.from({ length: 12 }, (_, i) => `src/a${i}.js`), Array.from({ length: 12 }, (_, i) => `lib/b${i}.js`))!;
  assert.deepEqual(union, ["lib/", "src/"]);
});

test("a finished job's merged-meanwhile overlaps: merged on or after its code was taken, its project, its files", () => {
  const me = { jobId: "me", projectId: "p1", scope: ["services/backtest.js", "README.md"] };
  const merged = [
    { jobId: "during", projectId: "p1", acceptedAt: 20, scope: ["services/backtest.js", "services/__tests__/backtest.test.js"] },
    { jobId: "before", projectId: "p1", acceptedAt: 5, scope: ["services/backtest.js"] },
    { jobId: "apart", projectId: "p1", acceptedAt: 30, scope: ["web/x.jsx"] },
    { jobId: "elsewhere", projectId: "p2", acceptedAt: 30, scope: ["README.md"] },
    { jobId: "unknown", projectId: "p1", acceptedAt: 10, scope: null },
  ];
  assert.deepEqual(mergedSince(me, 10, merged), [
    { jobId: "during", status: "accepted", paths: ["services/backtest.js"] },
    { jobId: "unknown", status: "accepted", paths: ["the whole project (scope unknown)"] },
  ]);
  assert.deepEqual(mergedSince(me, null, merged), [], "a job claimed before psm kept this cannot tell");
});
