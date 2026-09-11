import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../db.ts";
import { DeploymentPreparationController, PreparationRepository, type ReadinessResult } from "./make-ready.ts";
import type { DeploymentService } from "./service.ts";

function harness(reviewCapabilities?: () => string | null, reviewCheckout?: () => string | null) {
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
    service, repository, background: false, reviewCapabilities, reviewCheckout,
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


test("publication pauses before a GitHub build and resumes after verified operator approval", async (t) => {
  const h = harness(); t.after(h.close);
  let published = false;
  const plan = { id: "publication", state: "pending", expiresAt: Date.now() + 60_000, events: [] };
  h.controller.options.publisher = { review: async () => published ? null : plan, get: () => plan, cancel: () => { plan.state = "cancelled"; } } as never;
  h.blockers(["prepare-artifact"]); h.start(); await h.advance();
  assert.equal(h.current().phase, "publish"); assert.equal(h.current().state, "awaiting-approval");
  assert.equal(h.counts().builds, 0); assert.equal(h.counts().repairs, 0);
  await h.advance(); assert.equal(h.counts().builds, 0);
  published = true; plan.state = "succeeded"; await h.advance();
  assert.equal(h.current().phase, "build"); assert.equal(h.counts().builds, 1);
});

test("granting the missing capabilities resumes a blocked preparation without another click", async (t) => {
  let gap: string | null = "Review capabilities — todo-app requires repo.read, repo.edit, git.commit; project grants: none.";
  const h = harness(() => gap); t.after(h.close);
  h.blockers(["review-source"]); h.start(); await h.advance();
  assert.equal(h.current().state, "blocked"); assert.equal(h.current().blockedBy, "capabilities");
  const id = h.current().id;

  // One grant of three: still waiting, and the banner names what is left.
  gap = "Review capabilities — todo-app requires repo.edit, git.commit; project grants: repo.read.";
  assert.deepEqual(h.controller.capabilitiesChanged("project"), []);
  assert.equal(h.current().state, "blocked");
  assert.match(h.current().message, /requires repo.edit, git.commit/);

  gap = null;
  assert.equal(h.controller.capabilitiesChanged("project").length, 1);
  assert.equal(h.current().id, id, "the same preparation continues, not a new one");
  assert.equal(h.current().state, "running");
  assert.equal(h.current().blockedBy, null);
  assert.match(h.current().message, /Resuming preparation/);
  await h.advance();
  assert.equal(h.counts().repairs, 1, "and it goes straight on to the repair it was stopped before");
});

test("grant changes only resume preparations that were waiting on grants", async (t) => {
  const h = harness(() => null); t.after(h.close);
  h.blockers(["review-source"]); h.start(); await h.advance();
  h.controller.recover();
  assert.equal(h.current().state, "blocked");
  assert.deepEqual(h.controller.capabilitiesChanged("project"), []);
  assert.equal(h.current().state, "blocked", "an agent restart still waits for the button");
  assert.deepEqual(h.controller.capabilitiesChanged("another-project"), []);
});

test("a preparation stopped while waiting for grants stays stopped when they arrive", async (t) => {
  let gap: string | null = "Review capabilities — requires git.commit; project grants: none.";
  const h = harness(() => gap); t.after(h.close);
  h.blockers(["review-source"]); h.start(); await h.advance();
  assert.equal(h.current().blockedBy, "capabilities");
  await h.controller.cancel("project", "staging");
  assert.equal(h.current().state, "cancelled", "waiting on grants is armed, so Stop has to reach it");
  gap = null;
  assert.deepEqual(h.controller.capabilitiesChanged("project"), []);
  assert.equal(h.current().state, "cancelled");
  assert.equal(h.counts().repairs, 0);
});

test("a checkout problem is not mistaken for missing grants", async (t) => {
  let checkout: string | null = "Check the Git checkout — The index contains previously staged work.";
  const h = harness(() => null, () => checkout); t.after(h.close);
  h.blockers(["review-source"]); h.start(); await h.advance();
  assert.equal(h.current().state, "blocked");
  assert.equal(h.current().blockedBy, "checkout", "no grant fixes this, so a grant is not what it waits for");
  assert.match(h.current().message, /previously staged work/);
  assert.equal(h.counts().repairs, 0);
  assert.deepEqual(h.controller.capabilitiesChanged("project"), [], "and a grant change does not resume it");
  checkout = null; h.start(); await h.advance();
  assert.equal(h.counts().repairs, 1, "resuming after the checkout is fixed carries on");
});

test("grants arriving onto a checkout problem report that problem instead of a resume", async (t) => {
  let grants: string | null = "Review capabilities — todo-app requires git.commit; project grants: repo.read, repo.edit.";
  const checkout = "Check the Git checkout — Managed Git requires an ordinary checkout; linked worktrees are not supported.";
  const h = harness(() => grants, () => checkout); t.after(h.close);
  h.blockers(["review-source"]); h.start(); await h.advance();
  assert.equal(h.current().blockedBy, "capabilities", "grants are checked first");
  grants = null;
  assert.deepEqual(h.controller.capabilitiesChanged("project"), []);
  assert.equal(h.current().state, "blocked");
  assert.equal(h.current().blockedBy, "checkout");
  assert.equal(h.current().message, checkout);
});

test("a job saved under an older rule is corrected by the first recheck", async (t) => {
  const h = harness(() => null, () => null); t.after(h.close);
  h.blockers(["review-source"]); h.start();
  h.repository.save({ ...h.current(), state: "blocked", blockedBy: "capabilities", message: "Review capabilities — Configure Git user.name and user.email before a managed commit." });
  assert.equal(h.controller.recheckBlocked().length, 1, "nothing blocks it any more");
  assert.equal(h.current().state, "running");
  assert.equal(h.current().blockedBy, null);
  assert.doesNotMatch(h.current().message, /user\.name/);
  await h.advance();
  assert.equal(h.counts().repairs, 1);
});

test("a checkout fixed outside psm resumes preparation on the next recheck", async (t) => {
  let checkout: string | null = "Check the Git checkout — The index contains previously staged work.";
  const h = harness(() => null, () => checkout); t.after(h.close);
  h.blockers(["review-source"]); h.start(); await h.advance();
  assert.equal(h.current().blockedBy, "checkout");
  const updatedAt = h.current().updatedAt;
  assert.deepEqual(h.controller.recheckBlocked(), []);
  assert.equal(h.current().updatedAt, updatedAt, "a recheck that finds nothing new writes nothing");
  checkout = null;
  assert.equal(h.controller.recheckBlocked().length, 1);
  await h.advance();
  assert.equal(h.counts().repairs, 1);
});

test("Stop reaches a preparation waiting on its checkout", async (t) => {
  let checkout: string | null = "Check the Git checkout — HEAD is not on a branch.";
  const h = harness(() => null, () => checkout); t.after(h.close);
  h.blockers(["review-source"]); h.start(); await h.advance();
  await h.controller.cancel("project", "staging");
  assert.equal(h.current().state, "cancelled");
  checkout = null;
  assert.deepEqual(h.controller.recheckBlocked(), []);
  assert.equal(h.current().state, "cancelled", "fixing the checkout later does not revive it");
});
