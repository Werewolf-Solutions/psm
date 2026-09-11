import assert from "node:assert/strict";
import test from "node:test";
import { repairBrief, WorkroomPreparationRepairer, type RepairSessionHost } from "./repair-sessions.ts";
import type { PreparationJob, ReadinessResult } from "./make-ready.ts";

function job(overrides: Partial<PreparationJob> = {}): PreparationJob {
  return {
    id: "prep_1", projectId: "prj_todo", environmentId: "staging",
    state: "running", phase: "repair", message: "", createdAt: 0, updatedAt: 0,
    workroomId: null, waitingForRepair: false, repairs: 1, runId: null, planId: null, failure: null,
    engine: null, model: null, effort: null,
    ...overrides,
  };
}

function checked(items: { title: string; detail: string; status: string; action: string | null }[]): ReadinessResult {
  return { readiness: { items }, plan: {}, environment: {} } as unknown as ReadinessResult;
}

function host(overrides: Partial<RepairSessionHost> = {}) {
  const opened: { ai: { engine?: string | null } }[] = [];
  const sent: string[] = [];
  const stopped: string[] = [];
  const switches: string[] = [];
  let waiting = false;
  let engine: string | null = "codex";
  const base: RepairSessionHost = {
    open: (input) => { opened.push({ ai: input.ai }); engine = input.ai.engine ?? "codex"; return `room-${opened.length}`; },
    engine: () => engine,
    useAi: (_room, ai) => { engine = ai.engine ?? engine; switches.push(String(ai.engine)); },
    send: (_room, message) => { sent.push(message); return { ok: true }; },
    state: () => ({ busy: sent.length > 0, question: waiting }),
    stop: (room) => { stopped.push(room); },
  };
  return {
    host: { ...base, ...overrides }, opened, sent, stopped, switches,
    waitFor: () => { waiting = true; },
    engine: () => engine,
  };
}

test("the brief names the failing checks and leaves the passing ones out", async () => {
  const kit = host();
  const repairer = new WorkroomPreparationRepairer(kit.host);
  await repairer.start(job(), checked([
    { title: "Commit deployment inputs", detail: "inputs differ from committed HEAD", status: "blocked", action: "review-source" },
    { title: "Committed source ready", detail: "v1 · abc", status: "ready", action: null },
  ]));
  assert.equal(kit.sent.length, 1);
  assert.match(kit.sent[0], /Commit deployment inputs — inputs differ from committed HEAD \(review-source\)/);
  assert.doesNotMatch(kit.sent[0], /Committed source ready/, "a passing check is not work");
});

test("the brief carries the last failure and says which attempt this is", async () => {
  const kit = host();
  const repairer = new WorkroomPreparationRepairer(kit.host);
  await repairer.start(
    job({ repairs: 2, failure: "Build run run_7 ended failed." }),
    checked([{ title: "Prepare the deployment build", detail: "build it", status: "blocked", action: "prepare-artifact" }]),
  );
  assert.match(kit.sent[0], /What failed last time: Build run run_7 ended failed\./);
  assert.match(kit.sent[0], /attempt 2 of 3/);
});

test("the brief withholds the credentials and the deploy button from the repair", async () => {
  const kit = host();
  const repairer = new WorkroomPreparationRepairer(kit.host);
  await repairer.start(job(), checked([{ title: "Connect github", detail: "no credential", status: "blocked", action: "connect" }]));
  assert.match(kit.sent[0], /Do not read, write or invent deployment credentials/);
  assert.match(kit.sent[0], /do not run a deployment/);
  assert.match(kit.sent[0], /ask the operator a question instead of guessing/);
});

test("a second attempt continues the same room instead of opening another", async () => {
  const kit = host();
  const repairer = new WorkroomPreparationRepairer(kit.host);
  const room = await repairer.start(job(), checked([]));
  const again = await repairer.start(job({ workroomId: room, repairs: 2 }), checked([]));
  assert.equal(again, room);
  assert.equal(kit.opened.length, 1, "the operator follows one conversation, not one per retry");
  assert.equal(kit.sent.length, 2);
});

test("an unanswered question is not talked over", async () => {
  const kit = host();
  const repairer = new WorkroomPreparationRepairer(kit.host);
  const room = await repairer.start(job(), checked([]));
  kit.waitFor();
  await repairer.start(job({ workroomId: room, repairs: 2 }), checked([]));
  assert.equal(kit.sent.length, 1, "a second turn would bury what the operator was asked");
  assert.deepEqual(repairer.status(room), { busy: true, question: true });
});

test("a room that cannot take the work fails loudly enough to block preparation", async () => {
  const kit = host({ send: () => ({ ok: false, error: "claude has hit its usage limit" }) });
  const repairer = new WorkroomPreparationRepairer(kit.host);
  await assert.rejects(
    () => repairer.start(job(), checked([])),
    /claude has hit its usage limit/,
  );
});

/**
 * Switching provider mid-preparation.
 *
 * The case this exists for: a repair room opened on one engine, that engine hits
 * its usage window, and the operator wants the other one. The work is not lost
 * and the room is not abandoned — the same conversation continues elsewhere.
 */
test("the operator's engine moves the room preparation already opened", async () => {
  const kit = host();
  const repairer = new WorkroomPreparationRepairer(kit.host);
  const room = await repairer.start(job({ engine: "codex" }), checked([]));
  assert.equal(kit.engine(), "codex");

  const again = await repairer.start(job({ workroomId: room, engine: "claude", repairs: 2 }), checked([]));
  assert.equal(again, room, "the transcript the operator was reading is the one that continues");
  assert.deepEqual(kit.switches, ["claude"]);
  assert.equal(kit.engine(), "claude");
  assert.equal(kit.opened.length, 1);
});

test("a new room opens on the engine that was chosen for it", async () => {
  const kit = host();
  const repairer = new WorkroomPreparationRepairer(kit.host);
  await repairer.start(job({ engine: "claude", model: "opus" }), checked([]));
  assert.deepEqual(kit.opened[0].ai, { engine: "claude", model: "opus", effort: null });
});

test("no choice leaves the room on whatever it already runs", async () => {
  const kit = host();
  const repairer = new WorkroomPreparationRepairer(kit.host);
  const room = await repairer.start(job(), checked([]));
  await repairer.start(job({ workroomId: room, repairs: 2 }), checked([]));
  assert.deepEqual(kit.switches, [], "psm does not move a room the operator never asked to move");
});

test("a usage limit names the provider that refused and what to do about it", async () => {
  const kit = host({ send: () => ({ ok: false, limited: true, error: "You've hit your usage limit. Try again at 7:26 PM." }) });
  const repairer = new WorkroomPreparationRepairer(kit.host);
  await assert.rejects(
    () => repairer.start(job({ engine: "codex" }), checked([])),
    /^Error: codex: You've hit your usage limit\. Try again at 7:26 PM\. Choose a different AI for preparation, then resume\.$/,
  );
});
