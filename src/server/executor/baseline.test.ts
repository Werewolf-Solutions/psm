import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentPermissionStore } from "../agent-permissions.ts";
import { RepositoryTools } from "../agent-repository-tools.ts";
import type { TaskExecutor } from "../agent-task-runner.ts";
import { openDatabase } from "../db.ts";
import { baselineProblem, fixesTests, readTestOutput, runBaseline } from "./baseline.ts";

function fixture(t: test.TestContext, pkg: object | null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-baseline-"));
  const database = openDatabase(":memory:");
  const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_test", name: "trading-bot", path: directory };
  for (const permission of ["repo.read", "test.run", "pkg.install"]) store.change(project, permission, true, store.snapshot(project).revision, "operator");
  if (pkg) fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(pkg));
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { repo: new RepositoryTools(store.snapshot(project), store), store };
}

const TAP_RED = `TAP version 13
# Subtest: computeRealisedPnl works
ok 1 - computeRealisedPnl works
# Subtest: buildDashboard: returns running bots
not ok 2 - buildDashboard: returns running bots
  ---
  error: 'undefined !== 0.1'
  ...
1..2
# tests 80
# pass 79
# fail 1`;

/** Executes `run` with the given outcome; `rm` (cleanup) always succeeds. */
const sandbox = (outcome: { ok: boolean; output: string }): TaskExecutor => async (args) => {
  if (args[0] !== "run") return "";
  if (!outcome.ok) throw new Error(`Sandbox task failed: ${outcome.output}`);
  return outcome.output;
};

test("test output is read for counts and failing names: node --test, Jest, Mocha", () => {
  assert.deepEqual(readTestOutput(TAP_RED), { total: 80, passed: 79, failed: 1, failing: ["buildDashboard: returns running bots"] });
  const jest = readTestOutput("  ● dashboard › sums P&L\n\nTests:       2 failed, 30 passed, 32 total");
  assert.deepEqual(jest, { total: 32, passed: 30, failed: 2, failing: ["dashboard"] });
  assert.deepEqual(readTestOutput("  12 passing (40ms)\n  1 failing"), { total: 13, passed: 12, failed: 1, failing: [] });
  assert.equal(readTestOutput("# tests 0\n# pass 0\n# fail 0").total, 0);
});

test("tests that already fail stop the job before the agent, naming what fails", async (t) => {
  const { repo, store } = fixture(t, { scripts: { test: "node --test" } });
  const baseline = await runBaseline(repo, store, new AbortController().signal, sandbox({ ok: false, output: TAP_RED }));
  assert.equal(baseline.status, "fail");
  const problem = baselineProblem(baseline, "trading-bot")!;
  assert.match(problem, /trading-bot's tests already fail before any change \(1 test failing, 79 passing\)/);
  assert.match(problem, /Failing: buildDashboard: returns running bots\./);
  assert.match(problem, /agent was not started/);
});

test("no package.json, no test script, npm's placeholder or zero tests all mean nothing to check against", async (t) => {
  const pass = sandbox({ ok: true, output: "# tests 0\n# pass 0\n# fail 0" });
  for (const pkg of [null, { scripts: {} }, { scripts: { test: 'echo "Error: no test specified" && exit 1' } }, { scripts: { test: "node --test" } }]) {
    const { repo, store } = fixture(t, pkg);
    const baseline = await runBaseline(repo, store, new AbortController().signal, pass);
    assert.equal(baseline.status, "no-tests", JSON.stringify(pkg));
    assert.match(baselineProblem(baseline, "trading-bot")!, /agent was not started/);
  }
});

test("green tests let the job start; a missing sandbox is psm's problem, not a red project", async (t) => {
  const green = fixture(t, { scripts: { test: "node --test" } });
  const ok = await runBaseline(green.repo, green.store, new AbortController().signal, sandbox({ ok: true, output: "# tests 80\n# pass 80\n# fail 0" }));
  assert.deepEqual(ok, { status: "pass", summary: "80 tests pass" });
  assert.equal(baselineProblem(ok, "trading-bot"), null);

  const down = fixture(t, { scripts: { test: "node --test" } });
  const unavailable = await runBaseline(down.repo, down.store, new AbortController().signal, async () => {
    throw new Error("The managed task sandbox is unavailable. Configure Docker and preload the Node sandbox image on the PSM host.");
  });
  assert.equal(unavailable.status, "unavailable");
  assert.match(baselineProblem(unavailable, "trading-bot")!, /could not check trading-bot's tests/);
});

test("a failing test run keeps verification_status unverified until tests pass again", async (t) => {
  const { repo, store } = fixture(t, { scripts: { test: "node --test" } });
  assert.equal(repo.verificationStatus().verified, true);
  await runBaseline(repo, store, new AbortController().signal, sandbox({ ok: false, output: TAP_RED }));
  const red = repo.verificationStatus();
  assert.equal(red.verified, false);
  assert.match(red.note, /latest run_tests failed/);
  await runBaseline(repo, store, new AbortController().signal, sandbox({ ok: true, output: "# tests 80\n# pass 80" }));
  assert.equal(repo.verificationStatus().verified, true);
});

test("a note counts as fixing tests only when it says so", () => {
  for (const note of ["fix the failing buildDashboard test", "tests are red on main", "make the dashboard tests pass", "repair broken specs"]) assert.equal(fixesTests(note), true, note);
  for (const note of [
    "when starting npm run dev if port is in use roll to the next one",
    "add a test for the port picker",
    "fix the login page; also add tests later for the new form",
    "Small fix. Per the rules, run tests before and after the change so it fails loudly.",
  ]) assert.equal(fixesTests(note), false, note);
});
