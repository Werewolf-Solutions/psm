import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../db.ts";
import { DeploymentPreparationController, PreparationRepository, type ReadinessResult } from "./make-ready.ts";
import type { DeploymentService } from "./service.ts";

function harness(reviewCapabilities?: () => string | null) {
  const database = openDatabase(":memory:");
  const repository = new PreparationRepository(() => database);
  let outstanding: { action: string; status: string; detail: string }[] = [];
  let canPrepare = true;
  let busy = false;
  let question = false;
  let mutations = false;
  let repairs = 0;
  let builds = 0;
  let stops = 0;
  const cancellations: string[] = [];
  const runs: { runId: string; planId: string | null; runKind: string; terminal: boolean; state: string }[] = [];
  const service = {
    checkReadiness: async () => ({ readiness: { items: outstanding, canMakeReady: canPrepare, ready: !outstanding.length }, plan: {}, environment: {} } as unknown as ReadinessResult),
    createPlan: async () => ({ plan: { id: "infrastructure" } }),
    runView: (id: string) => runs.find((run) => run.runId === id),
    store: {
      listRuns: () => runs,
      // The real store returns the plan's own id on every read; the coordinator
      // records it so an operator's approval can be matched back to this job.
      getPlan: () => ({ planId: "infrastructure", expiresAt: Date.now() + 60_000, blocked: false,
        document: { actions: [{ sideEffecting: mutations }], blockers: [] } }),
      approveAndQueue: () => { throw new Error("Preparation must not approve infrastructure"); },
    },
  } as unknown as DeploymentService;
  const controller = new DeploymentPreparationController({
    service, repository, background: false, reviewCapabilities,
    preparer: { prepare: async () => {
      builds++;
      const run = { runId: `build-${builds}`, runKind: "prepare", planId: null, terminal: false, state: "running" };
      runs.push(run); return { runId: run.runId };
    } },
    runner: { enqueue: () => { throw new Error("Preparation must not queue infrastructure"); }, cancel: async (id) => { cancellations.push(id); } },
    repairs: {
      start: async () => { repairs++; busy = true; return "room"; },
      status: () => ({ busy, question }), stop: () => { stops++; busy = false; },
    },
  });
  return {
    controller, repository, runs, cancellations,
    start: () => controller.start("project", "staging"),
    advance: () => controller.advance("project", "staging"),
    current: () => repository.get("project", "staging")!,
    blockers: (actions: string[]) => { outstanding = actions.map((action) => ({ action, status: "blocked", detail: action })); },
    buildAvailable: (available: boolean) => { canPrepare = available; },
    worker: (state: { busy: boolean; question?: boolean }) => { busy = state.busy; question = state.question ?? false; },
    infrastructure: () => { mutations = true; },
    counts: () => ({ repairs, builds, stops }),
    close: () => { controller.close(); database.close(); },
  };
}

test("duplicate clicks and concurrent advances start one repair session", async (t) => {
  const h = harness(); t.after(h.close);
  h.blockers(["review-source"]);
  assert.equal(h.start().id, h.start().id);
  await Promise.all([h.advance(), h.advance()]);
  assert.equal(h.counts().repairs, 1);
  assert.equal(h.current().workroomId, "room");
});

test("source repair continues to build and verified readiness without another click", async (t) => {
  const h = harness(); t.after(h.close);
  h.blockers(["review-source", "prepare-artifact"]); h.start(); await h.advance();
  h.worker({ busy: false }); h.blockers(["prepare-artifact"]); await h.advance();
  assert.equal(h.current().phase, "build"); assert.equal(h.counts().builds, 1);
  await h.advance(); assert.equal(h.counts().builds, 1);
  Object.assign(h.runs[0], { terminal: true, state: "succeeded" }); h.blockers([]);
  await h.advance(); assert.equal(h.current().state, "succeeded");
});

test("missing build prerequisites go to repairs instead of spending a CI run", async (t) => {
  const h = harness(); t.after(h.close);
  h.blockers(["prepare-artifact"]); h.buildAvailable(false); h.start(); await h.advance();
  assert.deepEqual(h.counts(), { repairs: 1, builds: 0, stops: 0 });
});

test("questions pause preparation and answers resume it", async (t) => {
  const h = harness(); t.after(h.close);
  h.blockers(["resolve-dependency"]); h.start(); await h.advance();
  h.worker({ busy: false, question: true }); await h.advance();
  assert.equal(h.current().state, "waiting-input");
  h.worker({ busy: true }); await h.advance(); assert.equal(h.current().state, "running");
  h.worker({ busy: false }); h.blockers([]); await h.advance();
  assert.equal(h.current().state, "succeeded");
});

test("infrastructure always waits for the existing plan approval flow", async (t) => {
  const h = harness(); t.after(h.close);
  h.infrastructure(); h.start(); await h.advance();
  assert.equal(h.current().state, "awaiting-approval");
  assert.equal(h.current().planId, "infrastructure");
  await h.advance(); assert.equal(h.current().state, "awaiting-approval");
  h.runs.push({ runId: "approved-run", planId: "infrastructure", runKind: "deployment", state: "running", terminal: false });
  await h.advance(); assert.equal(h.current().runId, "approved-run");
});

test("a failed build enters repairs instead of reporting ready", async (t) => {
  const h = harness(); t.after(h.close);
  h.blockers(["prepare-artifact"]); h.start(); await h.advance();
  Object.assign(h.runs[0], { terminal: true, state: "failed" });
  await h.advance(); assert.equal(h.current().phase, "repair");
  assert.equal(h.counts().repairs, 1);
});

test("repair attempts are bounded and do not repeatedly launch unchanged work forever", async (t) => {
  const h = harness(); t.after(h.close);
  h.blockers(["resolve-dependency"]); h.start();
  for (let i = 0; i < 4; i++) { h.worker({ busy: false }); await h.advance(); }
  assert.equal(h.counts().repairs, 3); assert.equal(h.current().state, "blocked");
});

test("cancelled preparation cannot be revived by a stale repair result", async (t) => {
  const h = harness(); t.after(h.close);
  h.blockers(["review-source"]); h.start(); await h.advance();
  await h.controller.cancel("project", "staging");
  h.blockers([]); await h.advance();
  assert.equal(h.current().state, "cancelled"); assert.equal(h.counts().stops, 1);
});

test("agent restart preserves the workroom but requires a fresh resume", async (t) => {
  const h = harness(); t.after(h.close);
  h.blockers(["review-source"]); h.start(); await h.advance();
  h.controller.recover(); assert.equal(h.current().state, "blocked");
  assert.equal(h.start().workroomId, "room");
});


test("missing capabilities block before opening a room or consuming an attempt", async (t) => {
  let gap: string | null = "Review capabilities — requires git.commit; project grants: repo.read";
  const h = harness(() => gap); t.after(h.close);
  h.blockers(["review-source"]); h.start(); await h.advance();
  assert.equal(h.current().state, "blocked");
  assert.match(h.current().message, /requires git.commit/);
  assert.equal(h.current().repairs, 0);
  assert.equal(h.counts().repairs, 0);
  assert.equal(h.current().workroomId, null);
  gap = null; h.start(); await h.advance();
  assert.equal(h.counts().repairs, 1);
  assert.equal(h.current().repairs, 1);
});
