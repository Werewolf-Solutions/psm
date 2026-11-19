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
  return { hub: localHub({ ...options, executorId }), second: localHub({ ...options, executorId: "psm-test-2" }), clock, handle };
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

async function triaged(hub: ReturnType<typeof localHub>, n: number, projectId = PROJECT, kind = "fits", scope?: string[] | null) {
  const { intake } = await hub.createIntake({ projectId, text: `task ${n}`, key: key(n) });
  await hub.claim(["triage"]);
  await hub.result(intake.intakeId, { status: "triaged", verdict: verdict(kind) as any, ...(scope !== undefined ? { scope } : {}) });
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

test("without a predicted scope, one running job per project; another project still runs", async () => {
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

/* ---------- parallel jobs on one repo (overlap.ts) ---------- */

const go = async (hub: ReturnType<typeof localHub>, n: number, scope: string[] | null) => hub.goJob(await triaged(hub, n, PROJECT, "fits", scope), { mode: "auto" });

test("jobs on one project whose files do not overlap run side by side", async () => {
  const { hub } = setup();
  const a = await go(hub, 1, ["routes/registry.js", "routes/__tests__/registry.test.js"]);
  const b = await go(hub, 2, ["services/strategies.js"]);
  const c = await go(hub, 3, ["web/src/pages/"]);
  const claimed = [await hub.claim(["implement"]), await hub.claim(["implement"]), await hub.claim(["implement"])].map((job) => job?.jobId);
  assert.deepEqual(claimed, [a.jobId, b.jobId, c.jobId]);
  assert.equal((await hub.listQueue()).find((item) => item.intakeId === a.intakeId)?.scope?.join(), "routes/__tests__/registry.test.js,routes/registry.js");
});

test("an overlapping job waits for the one it overlaps to finish, then runs; others go past it", async () => {
  const { hub } = setup();
  const a = await go(hub, 1, ["routes/"]);
  const b = await go(hub, 2, ["routes/registry.js"]); // inside a's folder
  const c = await go(hub, 3, ["services/bots.js"]);
  assert.equal((await hub.claim(["implement"]))?.jobId, a.jobId);
  assert.equal((await hub.claim(["implement"]))?.jobId, c.jobId, "b overlaps a, c does not");
  assert.equal(await hub.claim(["implement"]), null);

  const waiting = (await hub.listJobs()).find((job) => job.jobId === b.jobId)!;
  assert.deepEqual(waiting.waitingFor, [{ jobId: a.jobId, status: "claimed", paths: ["routes/registry.js"] }]);

  // In review still counts: b would start from code without a's change.
  await hub.result(a.jobId, { status: "review", result: { ...reviewResult(a.jobId), files: ["routes/bots.js"] } });
  assert.equal(await hub.claim(["implement"]), null, "a's branch is in review: b waits for it to be merged or dropped");
  await hub.reviewJob(a.jobId, "accept");
  assert.equal((await hub.claim(["implement"]))?.jobId, b.jobId);
});

test("an overlapping job queued ahead holds the later one; an unknown scope overlaps everything", async () => {
  const { hub } = setup();
  const running = await go(hub, 1, ["a.js"]);
  assert.equal((await hub.claim(["implement"]))?.jobId, running.jobId);
  const first = await go(hub, 2, ["a.js", "b.js"]); // waits for running
  const second = await go(hub, 3, ["b.js"]); // overlaps first, which is ahead of it
  const third = await go(hub, 4, ["c.js"]);
  assert.equal((await hub.claim(["implement"]))?.jobId, third.jobId);
  assert.equal(await hub.claim(["implement"]), null);
  const jobs = await hub.listJobs();
  assert.deepEqual(jobs.find((job) => job.jobId === second.jobId)?.waitingFor?.map((blocker) => blocker.jobId), [first.jobId]);

  const unknown = await go(hub, 5, null);
  const blockers = (await hub.listJobs()).find((job) => job.jobId === unknown.jobId)?.waitingFor?.map((blocker) => blocker.jobId).sort();
  assert.deepEqual(blockers, [first.jobId, running.jobId, second.jobId, third.jobId].sort());
});

test("a finished job whose real changes collide with one in review goes back to wait, then starts fresh", async () => {
  const { hub } = setup();
  const a = await go(hub, 1, ["routes/registry.js"]);
  const b = await go(hub, 2, ["routes/strategies.js"]);
  assert.equal((await hub.claim(["implement"]))?.jobId, a.jobId);
  assert.equal((await hub.claim(["implement"]))?.jobId, b.jobId);
  await hub.result(a.jobId, { status: "review", result: { ...reviewResult(a.jobId), files: ["routes/registry.js", "package.json"] } });

  // b's prediction missed package.json; its branch changes it too.
  const answer = await hub.result(b.jobId, { status: "review", result: { ...reviewResult(b.jobId), files: ["routes/strategies.js", "package.json"] } });
  assert.match((answer as { requeued: string }).requeued, new RegExp(`same files as ${a.jobId} \\(package.json\\)`));
  const back = (await hub.listJobs()).find((job) => job.jobId === b.jobId)!;
  assert.equal(back.status, "queued");
  assert.equal(back.result, null);
  assert.match(back.note ?? "", /starts again from the merged code/);
  assert.deepEqual(back.waitingFor?.map((blocker) => blocker.jobId), [a.jobId]);

  await hub.reviewJob(a.jobId, "accept");
  const again = await hub.claim(["implement"]);
  assert.equal(again?.jobId, b.jobId);
  assert.equal(again?.kind === "implement" && again.continueClone, false, "a fresh clone, from the merged code");
  assert.equal((await hub.listJobs()).find((job) => job.jobId === b.jobId)?.note, null);
});

test("a job that keeps colliding goes to review with a warning after three rounds", async () => {
  const { hub, handle } = setup();
  const a = await go(hub, 1, ["x.js"]);
  const b = await go(hub, 2, ["y.js"]);
  assert.equal((await hub.claim(["implement"]))?.jobId, a.jobId);
  assert.equal((await hub.claim(["implement"]))?.jobId, b.jobId);
  await hub.result(a.jobId, { status: "review", result: { ...reviewResult(a.jobId), files: ["shared.js"] } });
  handle.prepare("UPDATE hub_jobs SET requeues = 3 WHERE job_id = ?").run(b.jobId);
  assert.equal(await hub.result(b.jobId, { status: "review", result: { ...reviewResult(b.jobId), files: ["y.js", "shared.js"] } }), undefined);
  const final = (await hub.listJobs()).find((job) => job.jobId === b.jobId)!;
  assert.equal(final.status, "review");
  assert.match(final.note ?? "", new RegExp(`Overlaps ${a.jobId} \\(shared.js\\); merge that first`));
});

test("a project set to side by side runs overlapping jobs at once, and both reach review", async () => {
  const { hub } = setup();
  assert.deepEqual(hub.overlapModes!(), {});
  assert.equal(hub.setOverlapMode!(PROJECT, "conflict"), "conflict");
  assert.throws(() => hub.setOverlapMode!(PROJECT, "sometimes" as any), refused("bad_mode"));
  assert.throws(() => hub.setOverlapMode!("prj_cccccccccccccccccccc", "conflict"), refused("project_not_found"));
  assert.deepEqual(hub.overlapModes!(), { [PROJECT]: "conflict" });

  const a = await go(hub, 1, ["web/Panel.jsx"]);
  const b = await go(hub, 2, ["web/Panel.jsx", "web/Chart.jsx"]);
  const c = await go(hub, 3, null); // even an unknown scope runs
  const claimed = [await hub.claim(["implement"]), await hub.claim(["implement"]), await hub.claim(["implement"])].map((job) => job?.jobId);
  assert.deepEqual(claimed, [a.jobId, b.jobId, c.jobId]);

  // Both reach review although their changes overlap: Accept finds out.
  await hub.result(a.jobId, { status: "review", result: { ...reviewResult(a.jobId), files: ["web/Panel.jsx"] } });
  assert.equal(await hub.result(b.jobId, { status: "review", result: { ...reviewResult(b.jobId), files: ["web/Panel.jsx"] } }), undefined);
  const inReview = (await hub.listJobs()).find((job) => job.jobId === b.jobId)!;
  assert.equal(inReview.status, "review");
  assert.match(inReview.note ?? "", /If Accept conflicts, it starts again from the merged code/);

});

test("a redo after a conflicting Accept starts from fresh code, at most three times", async () => {
  const { hub, handle } = setup();
  hub.setOverlapMode!(PROJECT, "conflict");
  const a = await go(hub, 1, ["web/Panel.jsx"]);
  assert.equal((await hub.claim(["implement"]))?.jobId, a.jobId);
  await hub.result(a.jobId, { status: "review", result: reviewResult(a.jobId) });
  await hub.reviewJob(a.jobId, "revise", "Keep the old label");
  assert.equal((await hub.claim(["implement"]))?.jobId, a.jobId);
  await hub.result(a.jobId, { status: "review", result: reviewResult(a.jobId) });

  const redone = hub.redoAfterConflict!(a.jobId)!;
  assert.equal(redone.status, "queued");
  assert.equal(redone.result, null);
  assert.match(redone.note ?? "", /Accept conflicted/);
  const again = await hub.claim(["implement"]);
  assert.equal(again?.jobId, a.jobId);
  assert.equal(again?.kind === "implement" && again.continueClone, false, "a fresh clone from the merged code");
  assert.equal(again?.kind === "implement" && again.revisions.length, 1, "the owner's feedback still applies");

  assert.throws(() => hub.redoAfterConflict!(a.jobId), refused("not_in_review"));
  await hub.result(a.jobId, { status: "review", result: reviewResult(a.jobId) });
  handle.prepare("UPDATE hub_jobs SET requeues = 3 WHERE job_id = ?").run(a.jobId);
  assert.equal(hub.redoAfterConflict!(a.jobId), null, "kept in review for a hand merge");
  assert.equal((await hub.listJobs()).find((job) => job.jobId === a.jobId)?.status, "review");
});

test("a job whose files were merged while it ran starts again from the merged code", async () => {
  const { hub, clock } = setup();
  // Predictions that miss each other, so both run; their branches share services/backtest.js.
  const a = await go(hub, 1, ["routes/backtest.js"]);
  const b = await go(hub, 2, ["services/__tests__/backtest.test.js"]);
  assert.equal((await hub.claim(["implement"]))?.jobId, a.jobId);
  assert.equal((await hub.claim(["implement"]))?.jobId, b.jobId);
  clock.now += 1_000;
  await hub.result(a.jobId, { status: "review", result: { ...reviewResult(a.jobId), files: ["services/backtest.js"] } });
  clock.now += 1_000;
  await hub.reviewJob(a.jobId, "accept"); // merged while b still runs: collisionsAfter no longer sees it
  clock.now += 1_000;

  const answer = await hub.result(b.jobId, { status: "review", result: { ...reviewResult(b.jobId), files: ["services/backtest.js", "services/__tests__/backtest.test.js"] } });
  assert.match((answer as { requeued: string }).requeued, new RegExp(`same files as ${a.jobId} \\(services/backtest.js\\), merged while it ran; it starts again from the merged code$`));
  const back = (await hub.listJobs()).find((job) => job.jobId === b.jobId)!;
  assert.equal(back.status, "queued");
  assert.match(back.note ?? "", /merged while it ran\. Starts again from the merged code\./);
  assert.deepEqual(back.waitingFor, [], "nothing to wait for: the merge is done");

  const again = await hub.claim(["implement"]);
  assert.equal(again?.jobId, b.jobId);
  assert.equal(again?.kind === "implement" && again.continueClone, false, "a fresh clone, which has a's merge");
  clock.now += 1_000;
  assert.equal(await hub.result(b.jobId, { status: "review", result: { ...reviewResult(b.jobId), files: ["services/backtest.js"] } }), undefined);
  const done = (await hub.listJobs()).find((job) => job.jobId === b.jobId)!;
  assert.equal(done.status, "review");
  assert.equal(done.note, null, "its new code is newer than a's merge");
});

test("side by side: a job whose files were merged while it ran reaches review with a warning", async () => {
  const { hub, clock } = setup();
  hub.setOverlapMode!(PROJECT, "conflict");
  const a = await go(hub, 1, ["services/backtest.js"]);
  const b = await go(hub, 2, ["services/backtest.js"]);
  const c = await go(hub, 3, ["README.md"]);
  for (const job of [a, b, c]) assert.equal((await hub.claim(["implement"]))?.jobId, job.jobId);
  await hub.result(a.jobId, { status: "review", result: { ...reviewResult(a.jobId), files: ["services/backtest.js"] } });
  clock.now += 1_000;
  await hub.reviewJob(a.jobId, "accept");

  assert.equal(await hub.result(b.jobId, { status: "review", result: { ...reviewResult(b.jobId), files: ["services/backtest.js"] } }), undefined);
  const warned = (await hub.listJobs()).find((job) => job.jobId === b.jobId)!;
  assert.equal(warned.status, "review");
  assert.match(warned.note ?? "", new RegExp(`Started before ${a.jobId} \\(services/backtest.js\\) was merged.*if Accept conflicts, it starts again.*run the tests after merging`));

  await hub.result(c.jobId, { status: "review", result: { ...reviewResult(c.jobId), files: ["README.md"] } });
  assert.equal((await hub.listJobs()).find((job) => job.jobId === c.jobId)?.note, null, "other files: nothing to say");
});

test("a merge before a job's code was taken, or a revision in the same clone, keeps its starting point", async () => {
  const { hub, clock } = setup();
  const a = await go(hub, 1, ["x.js"]);
  assert.equal((await hub.claim(["implement"]))?.jobId, a.jobId);
  await hub.result(a.jobId, { status: "review", result: { ...reviewResult(a.jobId), files: ["x.js"] } });
  await hub.reviewJob(a.jobId, "accept");
  clock.now += 1_000;

  // b starts after a was merged: its clone already has a.
  const b = await go(hub, 2, ["x.js"]);
  assert.equal((await hub.claim(["implement"]))?.jobId, b.jobId);
  await hub.result(b.jobId, { status: "review", result: { ...reviewResult(b.jobId), files: ["x.js"] } });
  assert.equal((await hub.listJobs()).find((job) => job.jobId === b.jobId)?.status, "review");

  // A revision continues in b's clone, so a merge since b started still counts.
  const c = await go(hub, 3, ["y.js"]);
  assert.equal((await hub.claim(["implement"]))?.jobId, c.jobId);
  clock.now += 1_000;
  await hub.reviewJob(b.jobId, "revise", "Rename it");
  await hub.result(c.jobId, { status: "review", result: { ...reviewResult(c.jobId), files: ["x.js"] } }); // c's real change reaches x.js
  await hub.reviewJob(c.jobId, "accept");
  clock.now += 1_000;
  assert.equal((await hub.claim(["implement"]))?.jobId, b.jobId);
  const answer = await hub.result(b.jobId, { status: "review", result: { ...reviewResult(b.jobId), files: ["x.js"] } });
  assert.match((answer as { requeued: string }).requeued, new RegExp(`same files as ${c.jobId} \\(x.js\\), merged while it ran`));
});

test("a branch that changed more files than a scope holds keeps a widened list, not the prediction", async () => {
  const { hub } = setup();
  const wide = await go(hub, 1, ["web/src/api/errors.js"]); // the prediction misses most of it
  assert.equal((await hub.claim(["implement"]))?.jobId, wide.jobId);
  const files = [
    ...Array.from({ length: 15 }, (_, i) => `web/src/components/bots/Panel${i}.jsx`),
    ...Array.from({ length: 7 }, (_, i) => `web/src/pages/Page${i}.jsx`),
  ];
  await hub.result(wide.jobId, { status: "review", result: { ...reviewResult(wide.jobId), files } });
  const inReview = (await hub.listJobs()).find((job) => job.jobId === wide.jobId)!;
  assert.deepEqual(inReview.scope, ["web/src/api/errors.js", "web/src/components/bots/", ...Array.from({ length: 7 }, (_, i) => `web/src/pages/Page${i}.jsx`)]);

  const panel = await go(hub, 2, ["web/src/components/bots/BacktestPanel.jsx"]);
  const server = await go(hub, 3, ["services/backtest.js"]);
  assert.equal((await hub.claim(["implement"]))?.jobId, server.jobId, "the panel job waits for the wide branch; other files run");
  assert.deepEqual((await hub.listJobs()).find((job) => job.jobId === panel.jobId)?.waitingFor?.map((blocker) => blocker.jobId), [wide.jobId]);
});

test("switching a project back to one after another makes overlapping jobs wait again", async () => {
  const { hub } = setup();
  hub.setOverlapMode!(PROJECT, "conflict");
  const a = await go(hub, 1, ["x.js"]);
  const b = await go(hub, 2, ["x.js"]);
  assert.equal((await hub.claim(["implement"]))?.jobId, a.jobId);
  assert.deepEqual((await hub.listJobs()).find((job) => job.jobId === b.jobId)?.waitingFor, []);
  hub.setOverlapMode!(PROJECT, "wait");
  assert.equal(await hub.claim(["implement"]), null);
  assert.deepEqual((await hub.listJobs()).find((job) => job.jobId === b.jobId)?.waitingFor?.map((blocker) => blocker.jobId), [a.jobId]);
});

test("triage again sends a finished intake back to new, refused while a job is under way", async () => {
  const { hub } = setup();
  const intakeId = await triaged(hub, 1, PROJECT, "doesnt_fit", ["a.js"]);
  const back = await hub.retriageIntake(intakeId);
  assert.equal(back.status, "new");
  assert.equal(back.verdict, null);
  assert.equal(back.scope, null);
  assert.equal((await hub.claim(["triage"]))?.jobId, intakeId, "it is triaged again");
  await hub.result(intakeId, { status: "triaged", verdict: verdict("fits") as any, scope: ["a.js"] });
  const job = await hub.goJob(intakeId, { mode: "auto" });
  await assert.rejects(hub.retriageIntake(intakeId), refused("job_active"));
  await hub.claim(["implement"]);
  await hub.result(job.jobId, { status: "stalled", error: "checks fail" });
  assert.equal((await hub.retriageIntake(intakeId)).status, "new", "a stalled job no longer holds it");
});

test("after a restart, this executor's running work goes back at once; an implement job continues in its copy", async () => {
  const { hub, second } = setup();
  const job = await go(hub, 1, ["a.js"]);
  const otherProject = await hub.goJob(await triaged(hub, 2, OTHER), { mode: "auto" });
  assert.equal((await hub.claim(["implement"]))?.jobId, job.jobId);
  assert.equal((await second.claim(["implement"]))?.jobId, otherProject.jobId, "another executor's job");
  const { intake } = await hub.createIntake({ projectId: PROJECT, text: "being triaged", key: key(9) });
  await hub.claim(["triage"]);

  const recovered = hub.recoverInterrupted!();
  assert.deepEqual(recovered, { jobs: [job.jobId], intake: [intake.intakeId] });
  const jobs = await hub.listJobs();
  assert.equal(jobs.find((entry) => entry.jobId === otherProject.jobId)?.status, "claimed", "another executor's claim is left alone");
  const back = jobs.find((entry) => entry.jobId === job.jobId)!;
  assert.equal(back.status, "queued");
  assert.equal(back.attempts, 0, "an interruption is not a failed attempt");
  assert.match(back.note ?? "", /restarted/);
  assert.equal((await hub.listQueue()).find((item) => item.intakeId === intake.intakeId)?.status, "new");

  const again = await hub.claim(["implement"]);
  assert.equal(again?.jobId, job.jobId);
  assert.ok(again?.kind === "implement" && again.continueClone && again.resumed, "it continues in its clone");
});

test("Resume queues a stalled job again in its clone; only stalled or failed jobs", async () => {
  const { hub } = setup();
  const job = await go(hub, 1, ["a.js"]);
  await hub.claim(["implement"]);
  await assert.rejects(hub.resumeJob(job.jobId), refused("not_resumable"));
  await hub.result(job.jobId, { status: "stalled", error: "checks fail" });
  const resumed = await hub.resumeJob(job.jobId);
  assert.equal(resumed.status, "queued");
  const claimed = await hub.claim(["implement"]);
  assert.ok(claimed?.kind === "implement" && claimed.resumed && claimed.continueClone);
  await hub.result(job.jobId, { status: "stalled", error: "again" });
  const later = await hub.resumeJob(job.jobId);
  assert.equal(later.status, "queued");
  const third = await hub.claim(["implement"]);
  assert.ok(third?.kind === "implement" && third.resumed, "resume is per Resume, not left on");
});

test("a job whose ticket builds on another waits until that one is accepted, even side by side, and says so", async () => {
  const { hub } = setup();
  hub.setOverlapMode!(PROJECT, "conflict");
  const base = await triaged(hub, 1, PROJECT, "fits", ["web/Preview.jsx"]);
  // Triage names the ticket it builds on by intake id, in dependsOn and queue.after.
  const { intake } = await hub.createIntake({ projectId: PROJECT, text: "[New feature requested by Claude Code over psm MCP]\n\n[grid lab 3] Drag the grid's edges. More detail.", key: key(2) });
  await hub.claim(["triage"]);
  await hub.result(intake.intakeId, { status: "triaged", scope: ["web/Preview.jsx"], verdict: { ...verdict(), dependsOn: [`${base} (grid lab 2: creates Preview.jsx)`], queue: { after: [base], note: "after grid lab 2" } } as any });

  const dependent = await hub.goJob(intake.intakeId, { mode: "auto" });
  let listed = (await hub.listJobs()).find((job) => job.jobId === dependent.jobId)!;
  assert.deepEqual(listed.needs?.map((need) => [need.intakeId, need.status, need.jobId]), [[base, "not-started", null]]);
  assert.equal(await hub.claim(["implement"]), null, "nothing it builds on is merged, or even started");

  const first = await hub.goJob(base, { mode: "auto" });
  assert.equal((await hub.claim(["implement"]))?.jobId, first.jobId, "the one it builds on goes first");
  assert.equal(await hub.claim(["implement"]), null);
  await hub.result(first.jobId, { status: "review", result: reviewResult(first.jobId) });
  assert.equal(await hub.claim(["implement"]), null, "in review is not merged");
  listed = (await hub.listJobs()).find((job) => job.jobId === dependent.jobId)!;
  assert.deepEqual(listed.needs?.map((need) => [need.status, need.jobId]), [["review", first.jobId]]);

  await hub.reviewJob(first.jobId, "accept");
  assert.deepEqual((await hub.listJobs()).find((job) => job.jobId === dependent.jobId)!.needs, []);
  assert.equal((await hub.claim(["implement"]))?.jobId, dependent.jobId);
});

test("Resume of a job that stalled before its dependency was merged waits for it and says which", async () => {
  const { hub, handle } = setup();
  hub.setOverlapMode!(PROJECT, "conflict");
  const base = await triaged(hub, 1, PROJECT, "fits", ["a.js"]);
  const { intake } = await hub.createIntake({ projectId: PROJECT, text: "[lab 3] Use a.js", key: key(2) });
  await hub.claim(["triage"]);
  await hub.result(intake.intakeId, { status: "triaged", scope: ["b.js"], verdict: { ...verdict(), dependsOn: [base] } as any });
  const first = await hub.goJob(base, { mode: "auto" });
  await hub.claim(["implement"]);
  await hub.result(first.jobId, { status: "review", result: reviewResult(first.jobId) });
  // Stalled the old way: it ran before psm checked what it builds on.
  const dependent = await hub.goJob(intake.intakeId, { mode: "auto" });
  handle.prepare("UPDATE hub_jobs SET status = 'stalled', pinned_executor = 'psm-test-1', error = 'Finished without committing any verified work.' WHERE job_id = ?").run(dependent.jobId);
  const stalled = (await hub.listJobs()).find((job) => job.jobId === dependent.jobId)!;
  assert.deepEqual(stalled.needs?.map((need) => [need.jobId, need.status]), [[first.jobId, "review"]], "shown before Resume");

  const resumed = await hub.resumeJob(dependent.jobId);
  assert.equal(resumed.status, "queued");
  assert.match(resumed.note ?? "", new RegExp(`Waiting for another ticket to be merged first: .*${first.jobId}, ready for review: Accept it`));
  assert.equal(await hub.claim(["implement"]), null);
  await hub.reviewJob(first.jobId, "accept");
  const claimed = await hub.claim(["implement"]);
  assert.ok(claimed?.kind === "implement" && claimed.jobId === dependent.jobId && claimed.resumed);
});

test("a dropped dependency stops counting, and two tickets that name each other do not both wait", async () => {
  const { hub } = setup();
  const a = await triaged(hub, 1, PROJECT, "fits", ["a.js"]);
  const { intake: b } = await hub.createIntake({ projectId: PROJECT, text: "b", key: key(2) });
  await hub.claim(["triage"]);
  await hub.result(b.intakeId, { status: "triaged", scope: ["b.js"], verdict: { ...verdict(), dependsOn: [a] } as any });
  const { intake: c } = await hub.createIntake({ projectId: PROJECT, text: "c", key: key(3) });
  await hub.claim(["triage"]);
  await hub.result(c.intakeId, { status: "triaged", scope: ["c.js"], verdict: { ...verdict(), queue: { after: [a], note: "" } } as any });

  const jobA = await hub.goJob(a, { mode: "auto" });
  await hub.cancelJob(jobA.jobId);
  const jobB = await hub.goJob(b.intakeId, { mode: "auto" });
  assert.equal((await hub.claim(["implement"]))?.jobId, jobB.jobId, "a cancelled dependency does not hold it");

  await hub.withdrawIntake(a);
  const jobC = await hub.goJob(c.intakeId, { mode: "auto" });
  assert.equal((await hub.claim(["implement"]))?.jobId, jobC.jobId, "a withdrawn dependency does not hold it");
});
