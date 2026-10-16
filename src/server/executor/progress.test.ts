import assert from "node:assert/strict";
import test from "node:test";

import { ExecutorActivity } from "./activity.ts";
import type { ExecutorJob } from "./client.ts";
import { stepForTool, stepReporter } from "./progress.ts";

test("agent tool calls become short steps; nothing from the call itself leaks into them", () => {
  assert.equal(stepForTool("read server.js"), "Reading the code");
  assert.equal(stepForTool("run_tests"), "Running the tests");
  assert.equal(stepForTool("run_script build"), "Building");
  assert.equal(stepForTool("run_script lint"), "Running lint");
  assert.equal(stepForTool("preview_check dev"), "Checking the app in a browser");
  assert.equal(stepForTool("install_packages web"), "Installing packages");
  assert.equal(stepForTool("sandbox_shell cd /workspace && git add . && git commit -m \"secret plan\""), "Committing");
  assert.equal(stepForTool("sandbox_shell python3 - <<'PY'"), "Making the change");
  assert.equal(stepForTool("verification_status"), null);
});

test("a step is sent only when it changes, and a failing hub never throws", async () => {
  const sent: string[] = [];
  const logs: string[] = [];
  const reporter = stepReporter(async (jobId, step) => {
    sent.push(`${jobId}:${step}`);
    if (step === "Building") throw new Error("hub down");
  }, (line) => logs.push(line));
  for (const step of ["Reading the code", "Reading the code", null, "Running the tests", "Building"]) reporter.report("job_1", step);
  reporter.report("job_2", "Reading the code");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, ["job_1:Reading the code", "job_1:Running the tests", "job_1:Building", "job_2:Reading the code"]);
  assert.match(logs[0], /could not report the step for job_1: hub down/);
  reporter.forget("job_1");
  reporter.report("job_1", "Building");
  assert.equal(sent.length, 5, "a forgotten job reports again");
});

test("psm's history follows the review: merged, rejected, sent back", () => {
  const activity = new ExecutorActivity();
  const job = (jobId: string) => ({ jobId, kind: "implement", intakeId: "int_1", projectId: "prj_a", projectName: "trading-bot", text: "roll ports", attempt: 1, leaseUntil: "" }) as unknown as ExecutorJob;
  for (const id of ["job_a", "job_b", "job_c"]) activity.claimed(job(id));
  activity.reviewed("job_a", "accept", "cto (3130950a)");
  activity.reviewed("job_b", "reject");
  activity.reviewed("job_c", "revise", "also log the port");
  assert.equal(activity.get("job_a")!.state, "merged");
  assert.equal(activity.get("job_a")!.timeline.at(-1)!.label, "Merged into cto (3130950a)");
  assert.equal(activity.get("job_b")!.state, "rejected");
  assert.equal(activity.get("job_c")!.state, "revising");
  assert.match(activity.get("job_c")!.timeline.at(-1)!.label, /Sent back for changes: also log the port/);
});
