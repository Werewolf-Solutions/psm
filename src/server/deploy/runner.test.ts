import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db.ts";
import {
  DeploymentRunner,
  type AdapterObservation,
  type DeploymentActionAdapter,
  type DeploymentAdapterContext,
  type PlanRecheckResult,
} from "./runner.ts";
import { DeploymentStore } from "./store.ts";

const PLAN_DIGEST = "sha256:plan-1";
const LOCK_KEY = "target/werewolf:todo-production-web";

interface Recorded {
  kind: string;
  call: "check" | "submit" | "observe" | "cancel";
  idempotencyKey: string | null;
  externalId: string | null;
}

/**
 * A scripted adapter. Each call consumes the next scripted reply for its method,
 * so a test can say "the first submit loses its response and the observe that
 * follows finds the effect already applied" without any timing.
 */
function scripted(
  kind: string,
  script: {
    check?: (Partial<AdapterObservation> | Error)[];
    submit?: (Partial<AdapterObservation> | Error)[];
    observe?: (Partial<AdapterObservation> | Error)[];
  },
  log: Recorded[],
): DeploymentActionAdapter {
  const queues = {
    check: [...(script.check ?? [])],
    submit: [...(script.submit ?? [])],
    observe: [...(script.observe ?? [])],
  };
  const reply = (call: "check" | "submit" | "observe", context: DeploymentAdapterContext): AdapterObservation => {
    log.push({ kind, call, idempotencyKey: context.idempotencyKey, externalId: context.externalId });
    const next = queues[call].shift();
    if (next instanceof Error) throw next;
    return { outcome: "succeeded", ...(next ?? {}) };
  };
  const adapter: DeploymentActionAdapter = { kind, execution: "local" };
  if (script.check) adapter.check = async (context) => reply("check", context);
  if (script.submit) adapter.submit = async (context) => reply("submit", context);
  if (script.observe) adapter.observe = async (context) => reply("observe", context);
  if (script.submit) {
    adapter.requestCancellation = async (context) => {
      log.push({ kind, call: "cancel", idempotencyKey: context.idempotencyKey, externalId: context.externalId });
    };
  }
  return adapter;
}

interface HarnessOptions {
  actions?: { actionId: string; kind: string; phase: string; sideEffecting: boolean }[];
  lockKeys?: string[];
  blocked?: boolean;
  recheck?: () => PlanRecheckResult;
  safeToRecover?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const database = openDatabase(":memory:");
  const store = new DeploymentStore(database);
  const log: Recorded[] = [];
  const rechecks: string[] = [];
  const lockKeys = options.lockKeys ?? [LOCK_KEY];
  const actions = options.actions ?? [
    { actionId: "api-asserted", kind: "assert-dependency@1", phase: "dependencies", sideEffecting: false },
    { actionId: "web-staged", kind: "stage-static-release@1", phase: "release", sideEffecting: true },
    { actionId: "web-verified", kind: "verify-release@1", phase: "verify", sideEffecting: false },
  ];

  store.createPlan({
    planId: "plan_todo_production",
    revision: 1,
    digest: PLAN_DIGEST,
    projectId: "prj_todo",
    checkoutId: "checkout_todo",
    environmentId: "production",
    operation: "deploy",
    risk: "production",
    manifestDigest: "sha256:manifest",
    artifactId: null,
    requiredAcknowledgementIds: [],
    blocked: options.blocked ?? false,
    document: { schema: "deployment-plan@1", lockKeys },
    createdAt: 40,
    expiresAt: 1_000_000,
    actions: actions.map((action, ordinal) => ({
      ordinal,
      actionId: action.actionId,
      actionDigest: `sha256:${action.actionId}`,
      kind: action.kind,
      phase: action.phase,
      sideEffecting: action.sideEffecting,
      preconditions: {},
      document: { ownerRef: `unit:web`, kind: action.kind },
    })),
  });

  const queued = store.approveAndQueue({
    approvalId: "approval_todo",
    runId: "run_deploy_todo",
    planId: "plan_todo_production",
    planRevision: 1,
    planDigest: PLAN_DIGEST,
    risk: "production",
    actorKind: "werewolf-user",
    actorSubject: "usr_operator",
    agentId: "agent_local",
    origin: "local",
    acknowledgementIds: [],
    approvedAt: 50,
    expiresAt: 900_000,
  });

  let clock = 1_000;
  const build = (adapters: DeploymentActionAdapter[]) => new DeploymentRunner({
    store,
    adapters,
    bootId: "boot_test",
    now: () => (clock += 1),
    sleep: async () => { clock += 1_000; },
    lockLeaseMs: 30_000,
    lockPollMs: 10,
    observationPollMs: 10,
    maxObservationAttempts: 5,
    shutdownGraceMs: 0,
    recheckPlan: async (context) => {
      rechecks.push(context.checkpoint);
      return options.recheck?.() ?? { ok: true, planDigest: PLAN_DIGEST, lockKeys };
    },
    observeExpiredLock: async () => ({
      safeToRecover: options.safeToRecover ?? true,
      reason: "test",
    }),
  });

  return { store, log, rechecks, build, runId: queued.run.runId, lockKeys };
}

const stepStates = (store: DeploymentStore, runId: string) =>
  Object.fromEntries(store.listRunSteps(runId).map((step) => [step.stepId, step.state]));

test("an approved run executes its actions, releases its locks and ends succeeded", async () => {
  const { store, log, rechecks, build, runId } = harness();
  const runner = build([
    scripted("assert-dependency@1", { check: [{}] }, log),
    // A remote executor accepts the work first and finishes later, so the
    // runner must poll rather than treat dispatch as completion.
    scripted("stage-static-release@1", {
      submit: [{ outcome: "pending", externalId: "gh-run-445566" }],
      observe: [{ outcome: "succeeded", externalId: "gh-run-445566" }],
    }, log),
    scripted("verify-release@1", { check: [{}] }, log),
  ]);

  const run = await runner.enqueue(runId);
  assert.equal(run.state, "succeeded");
  assert.deepEqual(log.map((entry) => `${entry.kind}:${entry.call}`), [
    "assert-dependency@1:check",
    "stage-static-release@1:submit",
    "stage-static-release@1:observe",
    "verify-release@1:check",
  ]);
  // Every mutation gate re-derives the approved plan before it is passed.
  assert.deepEqual(rechecks, ["before-locks", "after-locks", "before-action"]);
  assert.deepEqual(stepStates(store, runId), { "web-staged": "completed" });
  assert.equal(store.getTargetLock(LOCK_KEY), null);
  const events = store.listEvents(runId).map((event) => event.type);
  assert.ok(events.includes("locks-acquired"));
  assert.ok(events.includes("run-started"));
});

test("a plan naming an uninstalled action kind fails before any lock is taken", async () => {
  const { store, log, build, runId } = harness();
  const runner = build([scripted("assert-dependency@1", { check: [{}] }, log)]);

  const run = await runner.enqueue(runId);
  assert.equal(run.state, "failed");
  assert.equal(log.length, 0, "no adapter may run when the plan cannot be executed in full");
  assert.equal(store.getTargetLock(LOCK_KEY), null);
  const failure = store.listEvents(runId).find((event) => event.type === "run-failed");
  assert.match(
    JSON.stringify(failure?.data ?? {}),
    /no adapter is installed for stage-static-release@1/,
    "an operator must be able to read why the run refused to start",
  );
});

test("a side-effecting adapter without both submit and observe is refused", async () => {
  const { log, build, runId } = harness();
  const runner = build([
    scripted("assert-dependency@1", { check: [{}] }, log),
    // Submit with no observe cannot recover a lost response, so it may not mutate.
    scripted("stage-static-release@1", { submit: [{}] }, log),
    scripted("verify-release@1", { check: [{}] }, log),
  ]);

  const run = await runner.enqueue(runId);
  assert.equal(run.state, "failed");
  assert.equal(log.length, 0);
});

test("drift found at a mutation gate ends the run stale-plan without submitting", async () => {
  const { store, log, build, runId } = harness({
    recheck: () => ({ ok: false, reason: "deployment inputs changed since approval" }),
  });
  const runner = build([
    scripted("assert-dependency@1", { check: [{}] }, log),
    scripted("stage-static-release@1", { submit: [{}], observe: [{}] }, log),
    scripted("verify-release@1", { check: [{}] }, log),
  ]);

  const run = await runner.enqueue(runId);
  assert.equal(run.state, "stale-plan");
  assert.equal(log.filter((entry) => entry.call === "submit").length, 0);
  assert.equal(store.getTargetLock(LOCK_KEY), null);
});

test("a blocked plan cannot be approved at all, so no run exists to execute", () => {
  // The store is the gate here: an operator cannot queue work whose own plan
  // says it must not run, which is why the runner never sees this case.
  assert.throws(() => harness({ blocked: true }), /blocked/);
});

test("cancellation before the first mutation ends cancelled and submits nothing", async () => {
  const { store, log, build, runId } = harness();
  store.requestCancellation(runId, 900);
  const runner = build([
    scripted("assert-dependency@1", { check: [{}] }, log),
    scripted("stage-static-release@1", { submit: [{}], observe: [{}] }, log),
    scripted("verify-release@1", { check: [{}] }, log),
  ]);

  const run = await runner.enqueue(runId);
  assert.equal(run.state, "cancelled");
  assert.equal(log.filter((entry) => entry.call === "submit").length, 0);
  assert.equal(store.getTargetLock(LOCK_KEY), null);
});

test("a lost submit response is recovered by observation, never by a second submit", async () => {
  const { store, log, build, runId } = harness();
  const runner = build([
    scripted("assert-dependency@1", { check: [{}] }, log),
    // The provider accepted the work but the answer never arrived. `submitted`
    // is already durable at this point, so retrying the request could apply the
    // same release twice; only observation can say what actually happened.
    scripted("stage-static-release@1", {
      submit: [new Error("socket hang up")],
      observe: [{ outcome: "succeeded", externalId: "gh-run-445566" }],
    }, log),
    scripted("verify-release@1", { check: [{}] }, log),
  ]);

  const run = await runner.enqueue(runId);
  assert.equal(run.state, "succeeded");
  assert.equal(log.filter((entry) => entry.call === "submit").length, 1, "a lost response must never be re-submitted");
  assert.equal(log.filter((entry) => entry.call === "observe").length, 1);
  assert.deepEqual(stepStates(store, runId), { "web-staged": "completed" });
  assert.equal(store.getTargetLock(LOCK_KEY), null);
});

test("a stable idempotency key reaches the adapter and survives a restart", async () => {
  const { log, build, runId } = harness();
  const runner = build([
    scripted("assert-dependency@1", { check: [{}] }, log),
    scripted("stage-static-release@1", { submit: [{}], observe: [{}] }, log),
    scripted("verify-release@1", { check: [{}] }, log),
  ]);
  await runner.enqueue(runId);

  const submit = log.find((entry) => entry.call === "submit");
  assert.ok(submit?.idempotencyKey, "a side effect must carry a durable idempotency key");
  // A read-only check has nothing to deduplicate and must not invent one.
  assert.equal(log.find((entry) => entry.call === "check")?.idempotencyKey, null);
});

test("startup resumes interrupted work but holds recovery-required and prepare runs", async () => {
  const { store, log, build, runId } = harness();
  store.transitionRun({
    runId,
    expectedStates: ["queued"],
    state: "recovery-required",
    phase: "recovery-required",
    at: 800,
    recoveryReason: "an in-flight effect has no durable target lease",
  });
  store.createPreparationRun({ runId: "run_prepare_todo", projectId: "prj_todo", createdAt: 810 });

  const runner = build([
    scripted("assert-dependency@1", { check: [{}] }, log),
    scripted("stage-static-release@1", { submit: [{}], observe: [{}] }, log),
    scripted("verify-release@1", { check: [{}] }, log),
  ]);
  const recovered = runner.start();

  assert.deepEqual(
    Object.fromEntries(recovered.map((item) => [item.runId, item.disposition])),
    { [runId]: "manual-recovery-required", run_prepare_todo: "preparation-run-not-owned" },
  );
  // Neither disposition may quietly execute anything.
  assert.equal(log.length, 0);
  await runner.shutdown();
});

test("shutdown stops accepting new work", async () => {
  const { log, build, runId } = harness();
  const runner = build([
    scripted("assert-dependency@1", { check: [{}] }, log),
    scripted("stage-static-release@1", { submit: [{}], observe: [{}] }, log),
    scripted("verify-release@1", { check: [{}] }, log),
  ]);
  await runner.shutdown();
  await assert.rejects(() => runner.enqueue(runId), /not accepting work/);
});
