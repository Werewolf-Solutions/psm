import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { memoryTriageCache, readClaudeJson, type TriageEngine } from "../triage/run.ts";
import { activityLog, ExecutorActivity } from "./activity.ts";
import type { ExecutorJob, TriageJob } from "./client.ts";
import { triageJobRunner } from "./triage-job.ts";

const VERDICT = { verdict: "fits", size: "S", dependsOn: [], conflictsWith: [], queue: { after: [], note: "" }, questions: [], rationale: "Small UI tweak." };
const job = (over: Partial<TriageJob> = {}): TriageJob => ({
  jobId: "job_1", kind: "triage", intakeId: "int_1", projectId: "prj_aaaa", projectName: "todo-app",
  text: "this is a test to see if it is working", attempt: 1, leaseUntil: "", ...over,
});

function project(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-activity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "README.md"), "# todo-app\nA week-by-week todo board.\n");
  return dir;
}

test("a job's whole exchange is recorded: note, prompt, Claude's answer and cost, verdict, posting", async (t) => {
  const dir = project(t);
  const activity = new ExecutorActivity();
  const engine: TriageEngine = async () => ({ ok: true, text: JSON.stringify(VERDICT), meta: { model: "claude-x", costUsd: 0.0123, durationMs: 4200 } });
  const run = triageJobRunner({ findProject: () => ({ name: "todo-app", path: dir }), engine, onStep: (j, s) => activity.step(j, s) });

  activity.claimed(job());
  const outcome = await run(job(), new AbortController().signal);
  activity.finishing("job_1", outcome);
  activity.posted("job_1", outcome);

  const entry = activity.get("job_1")!;
  assert.equal(entry.state, "triaged");
  assert.equal(entry.text, "this is a test to see if it is working");
  assert.match(entry.prompt!, /<intake>\nthis is a test to see if it is working\n<\/intake>/);
  assert.match(entry.prompt!, /A week-by-week todo board/, "the project context psm gave Claude is visible");
  assert.match(entry.systemPrompt!, /project AI manager/);
  assert.equal(entry.answer, JSON.stringify(VERDICT));
  assert.equal(entry.meta?.costUsd, 0.0123);
  assert.equal(entry.verdict?.verdict, "fits");
  assert.deepEqual(entry.timeline.map((event) => event.label.split(":")[0].split(" ")[0]), ["Claimed", "Built", "Asked", "Claude", "Verdict", "Posted"]);
  assert.equal(activity.list()[0].jobId, "job_1");
  assert.equal("prompt" in activity.list()[0], false, "the list leaves the large fields out");
});

test("a cached verdict says so and makes no Claude call", async (t) => {
  const dir = project(t);
  const activity = new ExecutorActivity();
  let calls = 0;
  const engine: TriageEngine = async () => { calls++; return { ok: true, text: JSON.stringify(VERDICT) }; };
  const cache = memoryTriageCache();
  const run = triageJobRunner({ findProject: () => ({ name: "todo-app", path: dir }), engine, cache, onStep: (j, s) => activity.step(j, s) });
  await run(job({ jobId: "job_a" }), new AbortController().signal);
  activity.claimed(job({ jobId: "job_b" }));
  await run(job({ jobId: "job_b" }), new AbortController().signal);
  assert.equal(calls, 1);
  const entry = activity.get("job_b")!;
  assert.equal(entry.cached, true);
  assert.equal(entry.prompt, null);
});

test("failures and invalid answers are kept with their reason", async (t) => {
  const dir = project(t);
  const activity = new ExecutorActivity();
  const run = triageJobRunner({ findProject: () => ({ name: "todo-app", path: dir }), engine: async () => ({ ok: true, text: "I think it fits!" }), onStep: (j, s) => activity.step(j, s) });
  activity.claimed(job());
  const outcome = await run(job(), new AbortController().signal);
  activity.finishing("job_1", outcome);
  activity.posted("job_1", outcome);
  const entry = activity.get("job_1")!;
  assert.equal(entry.state, "failed");
  assert.equal(entry.answer, "I think it fits!", "the raw answer is shown even when it is not a verdict");
  assert.ok(entry.error);
});

test("history survives a restart; a job cut off mid-flight reads as abandoned", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-activity-file-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "activity.json");
  fs.writeFileSync(file, JSON.stringify([{ ...new ExecutorActivity().list(), jobId: "job_x", state: "asking-claude", finishedAt: null, claimedAt: 5, timeline: [], error: null }]));
  const restored = new ExecutorActivity(file);
  assert.equal(restored.get("job_x")!.state, "abandoned");
});

test("claude's JSON output yields the model, cost and time", () => {
  const answer = readClaudeJson(JSON.stringify({ result: "{}", total_cost_usd: 0.02, duration_ms: 3000, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { "claude-opus-5-5": {} } }));
  assert.ok(answer.ok);
  assert.deepEqual(answer.ok && answer.meta, { model: "claude-opus-5-5", costUsd: 0.02, durationMs: 3000, inputTokens: 10, outputTokens: 5 });
});

test("a job's log is plain text with tool output expanded, prompts only on request", () => {
  const activity = new ExecutorActivity();
  activity.claimed({ ...job(), kind: "implement" } as unknown as ExecutorJob);
  activity.started("job_1", "SYSTEM RULES", "TASK TEXT");
  activity.agentLine("job_1", { type: "message", text: "Let me run the tests." });
  activity.agentLine("job_1", { type: "tool", text: "run_tests" });
  const output = `TAP version 13\n${"ok 1 - fine\n".repeat(2000)}# fail 13\n# pass 59`;
  activity.agentLine("job_1", { type: "result", ok: false, text: output });

  const log = activityLog(activity.get("job_1")!);
  assert.match(log, /project: todo-app \(prj_aaaa\)/);
  assert.match(log, /AGENT\nLet me run the tests\./);
  assert.match(log, /→ run_tests/);
  assert.match(log, /✗ result\n```\nTAP version 13/);
  assert.match(log, /# fail 13\n# pass 59\n```/, "the end of long command output survives the cap");
  assert.match(log, /characters cut/);
  assert.doesNotMatch(log, /TASK TEXT/);
  assert.match(activityLog(activity.get("job_1")!, { full: true }), /## Prompt as sent\n```\nTASK TEXT/);
});
