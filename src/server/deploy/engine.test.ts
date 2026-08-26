import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db.ts";
import { createDeploymentEngine, observeExpiredLockFromRecords, recheckAgainstPlanner } from "./engine.ts";
import { installedExecutorKinds, defaultDeploymentAdapters } from "./executors.ts";
import type { DeploymentService } from "./service.ts";
import type { ExpiredLockObservationContext, PlanRecheckContext } from "./runner.ts";
import { DeploymentStore, type DeploymentPlan, type DeploymentRun, type DeploymentTargetLock } from "./store.ts";
import { SecretBroker } from "./connections.ts";

const PLAN_DIGEST = "sha256:plan-1";
const LOCK_KEY = "target/werewolf:todo-production-web";

function serviceStub(recheck: () => Promise<{ digest: string; lockKeys: readonly string[] }>): DeploymentService {
  return { recheckPlan: recheck } as unknown as DeploymentService;
}

function recheckContext(overrides: Partial<PlanRecheckContext> = {}): PlanRecheckContext {
  return {
    run: { runId: "run_deploy_todo" } as DeploymentRun,
    plan: { planId: "plan_todo_production", revision: 1, digest: PLAN_DIGEST } as DeploymentPlan,
    approval: {} as PlanRecheckContext["approval"],
    expectedLockKeys: [LOCK_KEY],
    checkpoint: "before-action",
    action: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("a rebuild that still produces the approved digest passes the gate", async () => {
  const result = await recheckAgainstPlanner(
    serviceStub(async () => ({ digest: PLAN_DIGEST, lockKeys: [LOCK_KEY] })),
    recheckContext(),
  );
  assert.deepEqual(result, { ok: true, planDigest: PLAN_DIGEST, lockKeys: [LOCK_KEY] });
});

test("a changed digest stops the run and reports the checkpoint it failed at", async () => {
  const result = await recheckAgainstPlanner(
    serviceStub(async () => ({ digest: "sha256:plan-2", lockKeys: [LOCK_KEY] })),
    recheckContext({ checkpoint: "after-locks" }),
  );
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /changed since approval \(after-locks\)/);
});

test("a plan that now mutates a different set of targets is not the approved plan", async () => {
  const result = await recheckAgainstPlanner(
    serviceStub(async () => ({ digest: PLAN_DIGEST, lockKeys: [LOCK_KEY, "target/werewolf:todo-staging-web"] })),
    recheckContext(),
  );
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /set of targets/);
});

test("a rebuild that throws is drift, never a pass", async () => {
  // An unreadable manifest or an unbound connection is exactly what this gate
  // exists to catch; treating the error as "unchanged" would apply a plan
  // against a world nobody re-reviewed.
  const result = await recheckAgainstPlanner(
    serviceStub(async () => { throw new Error("project has no managed deployment manifest"); }),
    recheckContext(),
  );
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /could not be re-derived/);
});

function lockContext(ownerRunId: string, sideEffecting: boolean): ExpiredLockObservationContext {
  return {
    lock: { lockKey: LOCK_KEY, ownerRunId, ownerBootId: "boot_previous" } as DeploymentTargetLock,
    nextRun: { runId: "run_deploy_next" } as DeploymentRun,
    plan: {
      planId: "plan_todo_production",
      actions: [{ actionId: "web-staged", kind: "stage-static-release@1", sideEffecting }],
    } as DeploymentPlan,
    signal: new AbortController().signal,
  } as ExpiredLockObservationContext;
}

test("a read-only plan may always take over an expired lease", () => {
  const store = new DeploymentStore(openDatabase(":memory:"));
  const observed = observeExpiredLockFromRecords(store, lockContext("run_gone", false));
  assert.equal(observed.safeToRecover, true);
  assert.match(observed.reason, /no mutation/);
});

test("an expired lease whose owner finished is stale bookkeeping, not a risk", () => {
  const store = new DeploymentStore(openDatabase(":memory:"));
  store.createPreparationRun({ runId: "run_previous", projectId: "prj_todo", createdAt: 10 });
  store.transitionRun({
    runId: "run_previous",
    expectedStates: ["queued"],
    state: "failed",
    phase: "complete",
    at: 20,
  });

  const observed = observeExpiredLockFromRecords(store, lockContext("run_previous", true));
  assert.equal(observed.safeToRecover, true);
  assert.match(observed.reason, /finished as failed/);
});

test("an expired lease whose owner may still be mutating is held, not seized", () => {
  const store = new DeploymentStore(openDatabase(":memory:"));
  store.createPreparationRun({ runId: "run_previous", projectId: "prj_todo", createdAt: 10 });

  const observed = observeExpiredLockFromRecords(store, lockContext("run_previous", true));
  assert.equal(observed.safeToRecover, false);
  assert.match(observed.reason, /no target-side observer/);
});

test("a lease naming a run this database has never seen is held", () => {
  const store = new DeploymentStore(openDatabase(":memory:"));
  const observed = observeExpiredLockFromRecords(store, lockContext("run_from_elsewhere", true));
  assert.equal(observed.safeToRecover, false);
  assert.match(observed.reason, /does not contain/);
});

test("the engine tells the planner exactly which action kinds it can execute", () => {
  const engine = createDeploymentEngine({
    store: new DeploymentStore(openDatabase(":memory:")),
    secretBroker: new SecretBroker({
      generations: { readGeneration: async () => 0, writeGeneration: async () => {} },
      fingerprintKey: new Uint8Array(32),
    }),
    projects: () => [],
  });
  assert.deepEqual(
    engine.service.installedActionKinds,
    installedExecutorKinds(defaultDeploymentAdapters()),
  );
  // The set is not empty and not a wildcard: a plan needing anything else is blocked.
  assert.ok((engine.service.installedActionKinds ?? []).length > 0);
  assert.equal(engine.service.artifactPreparationAvailable, false);
});

test("queueing an unknown run cannot crash the request that queued it", async () => {
  const engine = createDeploymentEngine({
    store: new DeploymentStore(openDatabase(":memory:")),
    secretBroker: new SecretBroker({
      generations: { readGeneration: async () => 0, writeGeneration: async () => {} },
      fingerprintKey: new Uint8Array(32),
    }),
    projects: () => [],
  });
  assert.doesNotThrow(() => engine.controller.enqueue("run_does_not_exist"));
  await engine.shutdown();
});
