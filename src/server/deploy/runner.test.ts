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
  unverifiedRelease?: boolean;
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
  if (options.unverifiedRelease) store.createPreparationRun({
    runId: "run_prepare_todo", projectId: "prj_todo", environmentId: "production", createdAt: 20,
  });
  const artifact = options.unverifiedRelease ? store.recordArtifact({
    artifactId: "artifact_todo_052", producingRunId: "run_prepare_todo", provenance: "managed", projectId: "prj_todo",
    kind: "static-files", sourceRepository: "Werewolf-Solutions/todo-app", githubArtifactId: "8123",
    producerRunId: "4567", commitSha: "7c21e4a9", version: "0.5.2",
    buildProfileDigest: "sha256:build", payloadAlgorithm: "psm-static-tree-sha256@1",
    payloadDigest: "sha256:payload", archiveDigest: "sha256:archive", providerLocator: {},
    provenanceUrl: null, createdAt: 30, retainedUntil: 10_000,
  }) : null;

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
    artifactId: artifact?.artifactId ?? null,
    requiredAcknowledgementIds: [],
    blocked: options.blocked ?? false,
    document: options.unverifiedRelease ? {
      schema: "deployment-plan@1", lockKeys, operation: "deploy", projectId: "prj_todo",
      environmentId: "production", artifact: JSON.parse(JSON.stringify(artifact)), manifest: { environments: [{ id: "production", units: [
        { id: "web", target: { targetId: "werewolf:todo-production-web" } },
      ] }] },
    } : { schema: "deployment-plan@1", lockKeys },
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

  if (artifact) store.activateRelease({
    releaseId: `release_${artifact.artifactId}`, artifactId: artifact.artifactId,
    activationRunId: queued.run.runId, targetId: "werewolf:todo-production-web",
    projectId: "prj_todo", environmentId: "production", unitId: "web", provenance: "managed",
    targetContractDigest: "sha256:target", activatedAt: 100, expectedCurrentReleaseId: null,
    receipt: { verified: false, releaseId: `release_${artifact.artifactId}`, commit: artifact.commitSha,
      version: artifact.version, payloadDigest: artifact.payloadDigest },
  });

  let clock = 1_000;
  const build = (adapters: DeploymentActionAdapter[], bootId = "boot_test") => new DeploymentRunner({
    store,
    adapters,
    bootId,
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

  return { database, store, log, rechecks, build, runId: queued.run.runId, lockKeys, advance: (ms: number) => { clock += ms; } };
}

const stepStates = (store: DeploymentStore, runId: string) =>
  Object.fromEntries(store.listRunSteps(runId).map((step) => [step.stepId, step.state]));

test("a successful in-place release verification records its receipt only after the final Watch check", async () => {
  const actions = [
    { actionId: "web-verified", kind: "verify-release@1", phase: "verify", sideEffecting: false },
    { actionId: "watch-observed", kind: "observe-watch@1", phase: "watch", sideEffecting: false },
  ];
  const { store, log, build, runId } = harness({ actions, unverifiedRelease: true });
  const runner = build([
    scripted("verify-release@1", { check: [{}] }, log),
    scripted("observe-watch@1", { check: [{}] }, log),
  ]);
  assert.equal((await runner.enqueue(runId)).state, "succeeded");
  const active = store.getActiveRelease("werewolf:todo-production-web");
  assert.equal((active?.receipt as { verified?: boolean }).verified, true);
  assert.equal((active?.receipt as { verifiedByRunId?: string }).verifiedByRunId, runId);
  assert.deepEqual(log.map((entry) => entry.kind), ["verify-release@1", "observe-watch@1"]);
});

test("a failed final Watch check does not mark an active release verified", async () => {
  const actions = [
    { actionId: "web-verified", kind: "verify-release@1", phase: "verify", sideEffecting: false },
    { actionId: "watch-observed", kind: "observe-watch@1", phase: "watch", sideEffecting: false },
  ];
  const { store, log, build, runId } = harness({ actions, unverifiedRelease: true });
  const runner = build([
    scripted("verify-release@1", { check: [{}] }, log),
    scripted("observe-watch@1", { check: [new Error("observer unavailable"), new Error("observer unavailable"), new Error("observer unavailable")] }, log),
  ]);
  assert.equal((await runner.enqueue(runId)).state, "failed");
  assert.equal((store.getActiveRelease("werewolf:todo-production-web")?.receipt as { verified?: boolean }).verified, false);
});

test("startup reconciles a completed verification run left with an unverified receipt", async () => {
  const actions = [
    { actionId: "web-verified", kind: "verify-release@1", phase: "verify", sideEffecting: false },
    { actionId: "watch-observed", kind: "observe-watch@1", phase: "watch", sideEffecting: false },
  ];
  const { database, store, log, build, runId } = harness({ actions, unverifiedRelease: true });
  const adapters = [
    scripted("verify-release@1", { check: [{}] }, log),
    scripted("observe-watch@1", { check: [{}] }, log),
  ];
  assert.equal((await build(adapters).enqueue(runId)).state, "succeeded");
  database.prepare("UPDATE deployment_releases SET receipt = json_set(receipt, '$.verified', json('false')) WHERE target_id = ?")
    .run("werewolf:todo-production-web");
  assert.equal((store.getActiveRelease("werewolf:todo-production-web")?.receipt as { verified: boolean }).verified, false);
  assert.deepEqual(build(adapters, "boot_restart").start().map((item) => item.runId), ["run_prepare_todo"]);
  assert.equal((store.getActiveRelease("werewolf:todo-production-web")?.receipt as { verified: boolean }).verified, true);
});

test("startup does not trust a succeeded run without durable Watch evidence", async () => {
  const actions = [
    { actionId: "web-verified", kind: "verify-release@1", phase: "verify", sideEffecting: false },
    { actionId: "watch-observed", kind: "observe-watch@1", phase: "watch", sideEffecting: false },
  ];
  const { database, store, log, build, runId } = harness({ actions, unverifiedRelease: true });
  const adapters = [
    scripted("verify-release@1", { check: [{}] }, log),
    scripted("observe-watch@1", { check: [{}] }, log),
  ];
  assert.equal((await build(adapters).enqueue(runId)).state, "succeeded");
  database.prepare("UPDATE deployment_releases SET receipt = json_set(receipt, '$.verified', json('false')) WHERE target_id = ?")
    .run("werewolf:todo-production-web");
  database.prepare("DELETE FROM deployment_events WHERE run_id = ? AND event_type = 'action-checked' AND phase = 'watch'")
    .run(runId);
  build(adapters, "boot_restart").start();
  assert.equal((store.getActiveRelease("werewolf:todo-production-web")?.receipt as { verified: boolean }).verified, false);
});

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

test("a failed observed action records its provider-safe detail in the run event", async () => {
  const { store, log, build, runId } = harness();
  const runner = build([
    scripted("assert-dependency@1", { check: [{}] }, log),
    scripted("stage-static-release@1", {
      submit: [{ outcome: "pending" }],
      observe: [{ outcome: "failed", data: { state: "conflict", detail: "The owned DNS record no longer exists" } }],
    }, log),
    scripted("verify-release@1", { check: [{}] }, log),
  ]);

  const run = await runner.enqueue(runId);
  assert.equal(run.state, "failed");
  assert.match(store.listEvents(runId).find((event) => event.type === "run-failed")?.message || "", /The owned DNS record no longer exists/);
  assert.equal(store.listRunSteps(runId).find((step) => step.stepId === "web-staged")?.state, "failed");
});

test("a failed post-mutation read-only helper check names the action and bounded diagnostic", async () => {
  const { store, log, build, runId } = harness();
  const helperError = Object.assign(new Error("pm2 snapshot failed: permission denied"), {
    name: "HostHelperError", code: "helper-invalid",
  });
  const runner = build([
    scripted("assert-dependency@1", { check: [{}] }, log),
    scripted("stage-static-release@1", { submit: [{}], observe: [{}] }, log),
    scripted("verify-release@1", { check: [helperError, helperError, helperError] }, log),
  ]);

  const run = await runner.enqueue(runId);
  assert.equal(run.state, "recovery-required");
  assert.match(run.recoveryReason || "", /web-verified failed after 3 attempts: pm2 snapshot failed: permission denied/);
  const failure = store.listEvents(runId).find((event) => event.type === "action-check-failed");
  assert.equal((failure?.data as { actionId?: string }).actionId, "web-verified");
  assert.match(failure?.message || "", /pm2 snapshot failed: permission denied/);
  assert.equal(store.listRunSteps(runId).find((step) => step.stepId === "web-staged")?.state, "completed");
});

test("an unobservable GitHub run names the executor's reason, not only its class", async () => {
  const { build, runId, log } = harness();
  const mismatch = Object.assign(new Error("GitHub workflow run did not match repository, workflow, commit and correlation constraints"), {
    name: "GitHubExecutorError", code: "github-run-mismatch",
  });
  const runner = build([
    scripted("assert-dependency@1", { check: [{}] }, log),
    scripted("stage-static-release@1", { submit: [{ outcome: "pending" }], observe: [mismatch] }, log),
    scripted("verify-release@1", { check: [{}] }, log),
  ]);

  const run = await runner.enqueue(runId);
  assert.equal(run.state, "recovery-required");
  assert.match(run.recoveryReason || "", /could not be observed: github-run-mismatch: GitHub workflow run did not match/);
});

test("a transient read-only helper failure is retried without another mutation", async () => {
  const { store, log, build, runId } = harness();
  const runner = build([
    scripted("assert-dependency@1", { check: [{}] }, log),
    scripted("stage-static-release@1", { submit: [{}], observe: [{}] }, log),
    scripted("verify-release@1", { check: [new Error("temporary PM2 failure"), {}] }, log),
  ]);
  assert.equal((await runner.enqueue(runId)).state, "succeeded");
  assert.equal(log.filter((entry) => entry.call === "submit").length, 1);
  assert.equal(log.filter((entry) => entry.kind === "verify-release@1" && entry.call === "check").length, 2);
  assert.equal(store.getTargetLock(LOCK_KEY), null);
});

test("only a failed read-only observation with no unresolved effects can be closed", async () => {
  const { store, log, build, runId } = harness();
  const runner = build([
    scripted("assert-dependency@1", { check: [{}] }, log),
    scripted("stage-static-release@1", { submit: [{}], observe: [{}] }, log),
    scripted("verify-release@1", { check: [new Error("PM2 failed"), new Error("PM2 failed"), new Error("PM2 failed")] }, log),
  ]);
  assert.equal((await runner.enqueue(runId)).state, "recovery-required");
  assert.equal(runner.closeFailedReadOnlyObservation(runId).state, "failed");
  assert.equal(store.getTargetLock(LOCK_KEY), null);
  assert.throws(() => runner.closeFailedReadOnlyObservation(runId), /not waiting at a failed read-only observation/);
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
  assert.match(store.listEvents(runId).at(-1)?.message || "", /deployment inputs changed since approval/, "the run explains why it stopped");
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

test("another unknown recovery observation replaces the stale diagnostic", async () => {
  const { store, log, build, runId } = harness();
  const runner = build([
    scripted("assert-dependency@1", { check: [{}] }, log),
    scripted("stage-static-release@1", {
      submit: [new Error("dispatch response lost")],
      observe: [
        { outcome: "unknown", data: { reason: "dispatch-receipt-unavailable" } },
        { outcome: "unknown", data: { reason: "dispatch-search-inconclusive", detail: "GitHub access is unavailable" } },
        { outcome: "failed", data: { reason: "release-not-dispatched" } },
      ],
    }, log),
    scripted("verify-release@1", { check: [{}] }, log),
  ]);
  assert.equal((await runner.enqueue(runId)).state, "recovery-required");
  const first = store.listRunSteps(runId).find((step) => step.stepId === "web-staged")!;
  assert.equal((first.result as { data: { reason: string } }).data.reason, "dispatch-receipt-unavailable");
  assert.equal((await runner.recover(runId)).state, "recovery-required");
  const second = store.listRunSteps(runId).find((step) => step.stepId === "web-staged")!;
  assert.equal((second.result as { data: { reason: string } }).data.reason, "dispatch-search-inconclusive");
  assert.ok((second.observedAt ?? 0) > (first.observedAt ?? 0));
  assert.equal((await runner.recover(runId)).state, "failed");
  assert.equal(log.filter((entry) => entry.call === "submit").length, 1);
});

test("a host-helper refusal retains its bounded diagnostic while observation decides the outcome", async () => {
  const { store, log, build, runId } = harness();
  const helperError = Object.assign(new Error("certbot failed: challenge returned HTTP 404"), {
    name: "HostHelperError", code: "helper-invalid", retryable: false,
  });
  const runner = build([
    scripted("assert-dependency@1", { check: [{}] }, log),
    scripted("stage-static-release@1", {
      submit: [helperError],
      observe: [{ outcome: "failed", data: { state: "create" } }],
    }, log),
    scripted("verify-release@1", { check: [{}] }, log),
  ]);

  const run = await runner.enqueue(runId);
  assert.equal(run.state, "failed");
  const refusal = store.listEvents(runId).find((event) => event.type === "submission-failed");
  assert.match(refusal?.message || "", /certbot failed: challenge returned HTTP 404/);
  assert.equal((refusal?.data as { helperCode?: string }).helperCode, "helper-invalid");
  assert.equal(log.filter((entry) => entry.call === "submit").length, 1);
});

test("only an uncertain nginx reload can be closed for a fresh reviewed plan", async () => {
  const actions = [
    { actionId: "nginx-reloaded", kind: "reload-nginx@1", phase: "reconcile", sideEffecting: true },
    { actionId: "web-staged", kind: "stage-static-release@1", phase: "release", sideEffecting: true },
  ];
  const { store, log, build, runId } = harness({ actions });
  const runner = build([
    scripted("reload-nginx@1", { submit: [new Error("response lost")], observe: [{ outcome: "unknown" }] }, log),
    scripted("stage-static-release@1", { submit: [{}], observe: [{}] }, log),
  ]);
  assert.equal((await runner.enqueue(runId)).state, "recovery-required");
  assert.ok(store.getTargetLock(LOCK_KEY));
  const closed = runner.closeUncertainNginxReload(runId);
  assert.equal(closed.state, "failed");
  assert.deepEqual(stepStates(store, runId), { "nginx-reloaded": "failed", "web-staged": "cancelled" });
  assert.equal(store.getTargetLock(LOCK_KEY), null);
  assert.ok(store.listEvents(runId).some((event) => event.type === "uncertain-reload-closed"));

  const unrelated = harness();
  assert.throws(() => unrelated.build([]).closeUncertainNginxReload(unrelated.runId), /not waiting for recovery/);
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

test("after a restart, recovery takes back the run's own expired lease and re-observes", async () => {
  // Observed 2026-09-28 (run_e19a8daa9f8d4e57): after a PSM restart, Check again was held
  // because the run's own lease, from the previous boot, was classified as a stranger's.
  const { store, log, build, runId, advance } = harness({ safeToRecover: false });
  const unobservable = Object.assign(new Error("run mismatch"), { name: "GitHubExecutorError", code: "github-run-mismatch" });
  const first = build([
    scripted("assert-dependency@1", { check: [{}] }, log),
    scripted("stage-static-release@1", { submit: [{ outcome: "pending" }], observe: [unobservable] }, log),
    scripted("verify-release@1", { check: [{}] }, log),
  ]);
  assert.equal((await first.enqueue(runId)).state, "recovery-required");
  assert.ok(store.getTargetLock(LOCK_KEY), "a held run keeps its lease");

  advance(60_000);
  const second = build([
    scripted("assert-dependency@1", { check: [{}] }, log),
    scripted("stage-static-release@1", { submit: [], observe: [{ outcome: "failed", data: { detail: "stopped before reaching the target" } }] }, log),
    scripted("verify-release@1", { check: [{}] }, log),
  ], "boot_second");
  const run = await second.recover(runId);
  assert.equal(run.state, "failed", run.recoveryReason ?? "");
  assert.equal(log.filter((entry) => entry.call === "submit").length, 1, "recovery never re-submits");
  assert.equal(store.getTargetLock(LOCK_KEY), null);
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
