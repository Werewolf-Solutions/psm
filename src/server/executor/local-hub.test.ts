import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db.ts";
import { HubError, type ImplementResult } from "./client.ts";
import { LEASE_MS, localHub } from "./local-hub.ts";

const PROJECT = "prj_aaaaaaaaaaaaaaaaaaaa";
const OTHER = "prj_bbbbbbbbbbbbbbbbbbbb";
const key = (n: number) => `pst_${String(n).padStart(24, "0")}`;
const verdict = (kind = "fits") => ({ verdict: kind, size: "S", dependsOn: [], conflictsWith: [], queue: { after: [], note: "" }, questions: kind === "needs_decision" ? ["Which one?"] : [], rationale: "Small and clear." });
const reviewResult = (jobId: string): ImplementResult => ({
  model: { engine: "claude", model: "m", effort: null, reason: "auto" } as any,
  branch: `psm/job/${jobId}`, baseCommit: "a".repeat(40), headCommit: "b".repeat(40),
  commits: [{ sha: "b".repeat(40), subject: "Do it" }], diffStat: { files: 1, insertions: 2, deletions: 0 }, checks: [], summary: "Done.",
});

function setup(executorId = "psm-test-1") {
  const handle = openDatabase(":memory:");
  const clock = { now: 1_000_000 };
  const options = { database: () => handle, now: () => clock.now, claimWaitMs: 0, projects: () => [{ id: PROJECT, name: "app" }, { id: OTHER, name: "other" }, { id: "prj_cccccccccccccccccccc", name: "old", archived: true }] };
  return { hub: localHub({ ...options, executorId }), second: localHub({ ...options, executorId: "psm-test-2" }), clock };
}
const refused = (code: string) => (error: unknown) => error instanceof HubError && error.code === code;

test("a task is created once per key, triaged, and waits for Go", async () => {
  const { hub } = setup();
  const first = await hub.createIntake({ projectId: PROJECT, text: "  Fix the login button  ", key: key(1) });
  assert.equal(first.created, true);
  assert.equal(first.intake.text, "Fix the login button");
  assert.equal((await hub.createIntake({ projectId: PROJECT, text: "different", key: key(1) })).intake.intakeId, first.intake.intakeId);
  await assert.rejects(hub.createIntake({ projectId: "prj_cccccccccccccccccccc", text: "x", key: key(2) }), refused("project_not_found"));
  await assert.rejects(hub.createIntake({ projectId: "prj_zzzz", text: "x", key: key(3) }), refused("project_not_found"));

  const job = await hub.claim(["triage"]);
  assert.equal(job?.kind, "triage");
  assert.equal(job?.projectName, "app");
  assert.equal(await hub.claim(["triage", "implement"]), null, "nothing else to claim");
  await assert.rejects(hub.result(job!.jobId, { status: "triaged", verdict: { verdict: "maybe" } as any }), refused("invalid_verdict"));
  await hub.result(job!.jobId, { status: "triaged", verdict: verdict() as any });
  const [item] = await hub.listQueue();
  assert.equal(item.status, "triaged");
  assert.equal(item.verdict?.verdict, "fits");
  assert.equal(item.claim, null);
});

test("a failed triage is retried once, then stays failed; an expired lease returns the item", async () => {
  const { hub, clock } = setup();
  const { intake } = await hub.createIntake({ projectId: PROJECT, text: "x", key: key(1) });
  await hub.claim(["triage"]);
  clock.now += LEASE_MS + 1;
  await assert.rejects(hub.heartbeat(intake.intakeId), refused("not_held"));
  assert.equal((await hub.listQueue())[0].status, "new");
  const again = await hub.claim(["triage"]);
  assert.equal(again?.attempt, 2);
  await hub.result(intake.intakeId, { status: "failed", error: "model down" });
  assert.equal((await hub.listQueue())[0].status, "failed");
});

async function triaged(hub: ReturnType<typeof localHub>, n: number, projectId = PROJECT, kind = "fits") {
  const { intake } = await hub.createIntake({ projectId, text: `task ${n}`, key: key(n) });
  await hub.claim(["triage"]);
  await hub.result(intake.intakeId, { status: "triaged", verdict: verdict(kind) as any });
  return intake.intakeId;
}

test("Go, implement, review: accept closes it, revise queues it again in the same clone", async () => {
  const { hub } = setup();
  const { intake: raw } = await hub.createIntake({ projectId: PROJECT, text: "untriaged", key: key(9) });
  await assert.rejects(hub.goJob(raw.intakeId, { mode: "auto" }), refused("not_ready"));
  await hub.withdrawIntake(raw.intakeId);

  const intakeId = await triaged(hub, 1);
  const queued = await hub.goJob(intakeId, { mode: "auto" });
  await assert.rejects(hub.goJob(intakeId, { mode: "auto" }), refused("already_queued"));
  await assert.rejects(hub.withdrawIntake(intakeId), refused("job_active"));

  const job = await hub.claim(["implement"]);
  assert.equal(job?.kind, "implement");
  assert.equal(job?.jobId, queued.jobId);
  assert.equal((job as any).continueClone, false);
  assert.equal((job as any).verdict.verdict, "fits");
  await hub.heartbeat(queued.jobId, "Running the tests");
  await assert.rejects(hub.result(queued.jobId, { status: "review", result: { ...reviewResult(queued.jobId), branch: "main" } }), refused("bad_result"));
  await hub.result(queued.jobId, { status: "review", result: reviewResult(queued.jobId) });
  assert.equal((await hub.listJobs())[0].status, "review");

  await assert.rejects(hub.reviewJob(queued.jobId, "revise", "  "), refused("comment_required"));
  await hub.reviewJob(queued.jobId, "revise", "Also cover the empty case");
  const revised = await hub.claim(["implement"]);
  assert.equal((revised as any).continueClone, true);
  assert.deepEqual((revised as any).revisions.map((entry: any) => entry.comment), ["Also cover the empty case"]);
  await hub.result(queued.jobId, { status: "review", result: reviewResult(queued.jobId) });
  assert.equal((await hub.reviewJob(queued.jobId, "accept")).status, "accepted");
  await assert.rejects(hub.reviewJob(queued.jobId, "reject"), refused("not_in_review"));
});

test("one running job per project; another project still runs", async () => {
  const { hub } = setup();
  const a = await hub.goJob(await triaged(hub, 1), { mode: "auto" });
  const b = await hub.goJob(await triaged(hub, 2), { mode: "auto" });
  const c = await hub.goJob(await triaged(hub, 3, OTHER), { mode: "auto" });
  assert.equal((await hub.claim(["implement"]))?.jobId, a.jobId);
  assert.equal((await hub.claim(["implement"]))?.jobId, c.jobId, "the second job of the busy project is skipped");
  assert.equal(await hub.claim(["implement"]), null);
  await hub.result(a.jobId, { status: "stalled", error: "over budget" });
  assert.equal((await hub.claim(["implement"]))?.jobId, b.jobId);
});

test("a job whose executor went quiet is retried once, then stalled; cancel only when not running", async () => {
  const { hub, clock } = setup();
  const job = await hub.goJob(await triaged(hub, 1), { mode: "auto" });
  await hub.claim(["implement"]);
  await assert.rejects(hub.cancelJob(job.jobId), refused("not_cancellable"));
  clock.now += LEASE_MS + 1;
  assert.equal((await hub.listJobs())[0].status, "queued");
  await hub.claim(["implement"]);
  clock.now += LEASE_MS + 1;
  const stalled = (await hub.listJobs())[0];
  assert.equal(stalled.status, "stalled");
  assert.match(stalled.error!, /stopped answering/);
  assert.equal((await hub.cancelJob(job.jobId)).status, "cancelled");
});

test("an engine failure is retried once, then failed", async () => {
  const { hub } = setup();
  const job = await hub.goJob(await triaged(hub, 1), { mode: "auto" });
  await hub.claim(["implement"]);
  await hub.result(job.jobId, { status: "failed", error: "engine crashed" });
  assert.equal((await hub.listJobs())[0].status, "queued");
  await hub.claim(["implement"]);
  await hub.result(job.jobId, { status: "failed", error: "engine crashed" });
  assert.equal((await hub.listJobs())[0].status, "failed");
});

test("questions are the needs_decision items without a job; an edit sends an item back to triage", async () => {
  const { hub } = setup();
  const intakeId = await triaged(hub, 1, PROJECT, "needs_decision");
  await triaged(hub, 2);
  const questions = await hub.listQuestions();
  assert.deepEqual(questions.map((question) => question.intakeId), [intakeId]);
  assert.deepEqual(questions[0].questions, ["Which one?"]);

  const edited = await hub.updateIntake(intakeId, { text: "task 1, the blue one" });
  assert.equal(edited.status, "new");
  assert.equal(edited.verdict, null);
  assert.deepEqual(await hub.listQuestions(), []);
  assert.equal((await hub.updateIntake(intakeId, { text: "task 1, the blue one" })).status, "new", "no change, no reset");
});

test("a claim waits for work and stops when aborted", async () => {
  const handle = openDatabase(":memory:");
  const hub = localHub({ executorId: "psm-test-1", database: () => handle, projects: () => [{ id: PROJECT, name: "app" }], claimWaitMs: 2_000, claimPollMs: 10 });
  const waiting = hub.claim(["triage"]);
  await hub.createIntake({ projectId: PROJECT, text: "arrives later", key: key(1) });
  assert.equal((await waiting)?.text, "arrives later");
  const controller = new AbortController();
  const idle = hub.claim(["triage"], controller.signal);
  controller.abort();
  assert.equal(await idle, null);
});
