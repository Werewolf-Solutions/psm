import assert from "node:assert/strict";
import test from "node:test";

import { StopRules, failureSignature } from "./stop-rules.ts";

const FAIL = (n: number) => `Sandbox task failed: not ok 3 - rolls to the next port\n  at 2026-10-15T15:0${n}:00.000Z took ${n * 13} ms on :${3000 + n} in psm-task-${n}abc`;

test("the same failure, however its timings differ, is one signature", () => {
  assert.equal(failureSignature("run_tests:test", FAIL(1)), failureSignature("run_tests:test", FAIL(2)));
  assert.notEqual(failureSignature("run_tests:test", FAIL(1)), failureSignature("run_tests:test", "not ok 4 - something else"));
});

test("the third identical failure stops the job, even with edits in between", () => {
  let tree = 0;
  const rules = new StopRules({ treeState: () => String(tree) });
  for (let i = 1; i <= 2; i++) {
    tree++;
    rules.toolUse(`t${i}`, "mcp__psm__run_tests", "test");
    assert.equal(rules.toolResult(`t${i}`, true, FAIL(i)), null);
  }
  tree++;
  rules.toolUse("t3", "mcp__psm__run_tests", "test");
  assert.match(rules.toolResult("t3", true, FAIL(3))!.reason, /failed 3 times/);
});

test("the same failure twice with nothing changed is no progress", () => {
  const rules = new StopRules({ treeState: () => "same" });
  rules.toolUse("a", "mcp__psm__run_tests", "test");
  assert.equal(rules.toolResult("a", true, FAIL(1)), null);
  rules.toolUse("b", "mcp__psm__run_tests", "test");
  assert.match(rules.toolResult("b", true, FAIL(2))!.reason, /No progress/);
});

test("Codex dynamic tool names use the same failing-check rules", () => {
  const rules = new StopRules({ treeState: () => "same" });
  rules.toolUse("a", "psm_run_tests", "test");
  assert.equal(rules.toolResult("a", true, FAIL(1)), null);
  rules.toolUse("b", "psm_run_tests", "test");
  assert.match(rules.toolResult("b", true, FAIL(2))!.reason, /No progress/);
  assert.deepEqual([...rules.checks], [["run_tests:test", false]]);
});

test("passing checks, other tools and different failures do not stop it; checks are reported", () => {
  let tree = 0;
  const rules = new StopRules({ treeState: () => String(tree++) });
  rules.toolUse("r", "mcp__psm__read");
  assert.equal(rules.toolResult("r", true, "no such file"), null, "a failed read is not a failing check");
  for (const [i, name] of ["parses the port", "rolls forward", "stops at the limit", "logs the url", "keeps HOST"].entries()) {
    rules.toolUse(`x${i}`, "mcp__psm__run_tests", "test");
    assert.equal(rules.toolResult(`x${i}`, true, `not ok 1 - ${name}`), null, "each fix moves the failure on");
  }
  rules.toolUse("ok", "mcp__psm__run_script", "build");
  assert.equal(rules.toolResult("ok", false, "built"), null);
  assert.deepEqual([...rules.checks], [["run_tests:test", false], ["run_script:build", true]]);
});

test("the tool-call backstop", () => {
  const rules = new StopRules({ treeState: () => "", maxToolCalls: 3 });
  for (let i = 0; i < 3; i++) assert.equal(rules.toolUse(`c${i}`, "mcp__psm__read"), null);
  assert.match(rules.toolUse("c3", "mcp__psm__read")!.reason, /3 tool calls/);
});
