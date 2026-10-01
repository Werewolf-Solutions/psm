import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase } from "../db.ts";
import {
  DeploymentConflictError,
  DeploymentStore,
  DeploymentTransitionError,
  type DeploymentPlan,
} from "./store.ts";

const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), "psm-deployment-store-"));

function harness() {
  const database = openDatabase(":memory:");
  return { database, store: new DeploymentStore(database) };
}

function finishPreparation(store: DeploymentStore, runId = "run_prepare", start = 10) {
  store.createPreparationRun({ runId, projectId: "prj_todo", createdAt: start });
  store.transitionRun({
    runId,
    expectedStates: ["queued"],
    state: "dispatching",
    phase: "dispatching",
    at: start + 1,
  });
  store.transitionRun({
    runId,
    expectedStates: ["dispatching"],
    state: "waiting-executor",
    phase: "waiting-executor",
    at: start + 2,
  });
  store.transitionRun({
    runId,
    expectedStates: ["waiting-executor"],
    state: "importing-artifact",
    phase: "importing-artifact",
    at: start + 3,
  });
  return store.transitionRun({
    runId,
    expectedStates: ["importing-artifact"],
    state: "succeeded",
    phase: "complete",
    at: start + 4,
  });
}

function artifact(
  store: DeploymentStore,
  overrides: Partial<Parameters<DeploymentStore["recordArtifact"]>[0]> = {},
) {
  const input: Parameters<DeploymentStore["recordArtifact"]>[0] = {
    artifactId: "artifact_todo_052",
    producingRunId: "run_prepare",
    provenance: "managed",
    projectId: "prj_todo",
    kind: "static-files",
    sourceRepository: "Werewolf-Solutions/todo-app",
    githubArtifactId: "8123",
    producerRunId: "4567",
    commitSha: "7c21e4a9",
    version: "0.5.2",
    buildProfileDigest: "sha256:build",
    payloadAlgorithm: "psm-static-tree-sha256@1",
    payloadDigest: "sha256:payload",
    archiveDigest: "sha256:archive",
    providerLocator: { repository: "Werewolf-Solutions/todo-app", runId: "4567" },
    provenanceUrl: "https://github.com/Werewolf-Solutions/todo-app/actions/runs/4567",
    createdAt: 30,
    retainedUntil: 10_000,
    tombstonedAt: null,
    ...overrides,
  };
  return store.recordArtifact(input);
}

function plan(
  store: DeploymentStore,
  overrides: Partial<Omit<DeploymentPlan, "actions" | "supersededAt">> = {},
) {
  return store.createPlan({
    planId: "plan_todo_production",
    revision: 1,
    digest: "sha256:plan-1",
    projectId: "prj_todo",
    checkoutId: "checkout_todo",
    environmentId: "production",
    operation: "deploy",
    risk: "production",
    manifestDigest: "sha256:manifest",
    artifactId: "artifact_todo_052",
    requiredAcknowledgementIds: ["production-risk", "rollback-target"],
    blocked: false,
    document: { schema: "deployment-plan@1", targetId: "target_todo_production" },
    createdAt: 40,
    expiresAt: 1_000,
    ...overrides,
    actions: [
      {
        actionId: "nginx-update",
        actionDigest: "sha256:nginx-action",
        kind: "nginx-ingress@1",
        phase: "reconciling",
        sideEffecting: true,
        preconditions: { observedFingerprint: "sha256:old-nginx" },
        document: { type: "update-nginx", configProfile: "static-spa@1" },
      },
      {
        actionId: "http-verify",
        actionDigest: "sha256:http-probe",
        kind: "http-probe@1",
        phase: "verifying",
        sideEffecting: false,
        preconditions: {},
        document: { method: "GET", expectStatus: 200 },
      },
    ],
  });
}

function readyDeploymentStore() {
  const result = harness();
  finishPreparation(result.store);
  artifact(result.store);
  plan(result.store);
  return result;
}

function approve(store: DeploymentStore, overrides: Record<string, unknown> = {}) {
  return store.approveAndQueue({
    approvalId: "approval_todo",
    runId: "run_deploy_todo",
    planId: "plan_todo_production",
    planRevision: 1,
    planDigest: "sha256:plan-1",
    risk: "production",
    actorKind: "werewolf-user",
    actorSubject: "usr_operator",
    agentId: "agent_local",
    origin: "local",
    acknowledgementIds: ["rollback-target", "production-risk"],
    approvedAt: 50,
    expiresAt: 900,
    ...overrides,
  } as Parameters<DeploymentStore["approveAndQueue"]>[0]);
}

test("migration creates every managed deployment relation with foreign keys enabled", () => {
  const { database } = harness();
  const names = new Set(
    (database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'deployment_%'")
      .all() as unknown as { name: string }[]).map((row) => row.name),
  );
  assert.deepEqual(
    [...names].sort(),
    [
      "deployment_approvals",
      "deployment_artifacts",
      "deployment_connection_bindings",
      "deployment_connections",
      "deployment_events",
      "deployment_manifests",
      "deployment_plan_actions",
      "deployment_plans",
      "deployment_policies",
      "deployment_preparations",
      "deployment_releases",
      "deployment_resource_bindings",
      "deployment_run_steps",
      "deployment_runs",
      "deployment_target_locks",
      "deployment_watch_snapshots",
    ],
  );
  assert.equal(
    (database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys,
    1,
  );
  assert.throws(() =>
    database
      .prepare(
        `INSERT INTO deployment_events
         (run_id, sequence, occurred_at, event_type, phase, level, message, payload)
         VALUES ('absent', 1, 1, 'x', 'x', 'info', 'x', '{}')`,
      )
      .run(),
  );
});

test("manifest cache is immutable for an exact source tuple", () => {
  const { store } = harness();
  const source = {
    projectId: "prj_todo",
    checkoutId: "checkout_todo",
    environmentId: "production",
    commitSha: "7c21e4a9",
    digest: "sha256:manifest",
    schemaVersion: 1,
    document: { schema: "psm-deployments@1", projectId: "prj_todo" } as const,
    createdAt: 10,
  };
  assert.deepEqual(store.cacheManifest(source), source);
  assert.deepEqual(store.cacheManifest(source), source, "an identical cache write is idempotent");
  assert.throws(
    () => store.cacheManifest({ ...source, document: { changed: true } }),
    DeploymentConflictError,
  );
});

test("connection metadata and local bindings use optimistic revisions", () => {
  const { store } = harness();
  const created = store.createConnection({
    connectionId: "ssh:todo-production",
    kind: "ssh-host-helper@1",
    label: "Todo production",
    secretGeneration: 2,
    readiness: "ready",
    metadata: { principal: "deploy-todo" },
    constraints: { projects: ["prj_todo"], environments: ["production"] },
    createdAt: 10,
  });
  assert.equal(created.metadataRevision, 1);
  assert.equal(
    store.updateConnection({
      connectionId: created.connectionId,
      expectedMetadataRevision: 1,
      label: created.label,
      readiness: "ready",
      metadata: { principal: "deploy-todo", hostKey: "SHA256:host" },
      constraints: created.constraints,
      secretGeneration: 3,
      updatedAt: 11,
    }).metadataRevision,
    2,
  );
  assert.throws(
    () => store.updateConnection({
      connectionId: created.connectionId,
      expectedMetadataRevision: 1,
      label: created.label,
      readiness: "unknown",
      metadata: {},
      constraints: {},
      secretGeneration: 3,
      updatedAt: 12,
    }),
    DeploymentConflictError,
  );

  const rotated = store.updateConnectionSecretStatus({
    connectionId: created.connectionId,
    expectedSecretGeneration: 3,
    secretGeneration: 4,
    readiness: "ready",
    updatedAt: 13,
  });
  assert.equal(rotated.metadataRevision, 2, "secret rotation does not fabricate a metadata change");
  assert.equal(rotated.secretGeneration, 4);
  assert.throws(
    () => store.updateConnectionSecretStatus({
      connectionId: created.connectionId,
      expectedSecretGeneration: 3,
      secretGeneration: 5,
      readiness: "ready",
      updatedAt: 14,
    }),
    DeploymentConflictError,
  );

  const first = store.bindConnection({
    projectId: "prj_todo",
    checkoutId: "checkout_todo",
    environmentId: "production",
    slot: "infrastructure",
    connectionId: created.connectionId,
    expectedRevision: null,
    at: 20,
  });
  assert.equal(first.bindingRevision, 1);
  assert.equal(
    store.bindConnection({
      projectId: "prj_todo",
      checkoutId: "checkout_todo",
      environmentId: "production",
      slot: "infrastructure",
      connectionId: created.connectionId,
      expectedRevision: 1,
      at: 21,
    }).bindingRevision,
    2,
  );
  assert.throws(
    () => store.bindConnection({
      projectId: "prj_todo",
      checkoutId: "checkout_todo",
      environmentId: "production",
      slot: "infrastructure",
      connectionId: created.connectionId,
      expectedRevision: 1,
      at: 22,
    }),
    DeploymentConflictError,
  );
  assert.throws(
    () => store.removeConnection(created.connectionId, 2),
    DeploymentConflictError,
    "bound authority cannot be deleted",
  );
  assert.deepEqual(
    store.listConnectionBindings("prj_todo", "production", "checkout_todo").map((binding) => binding.slot),
    ["infrastructure"],
  );
});

test("policies retain history and provider objects have one owner", () => {
  const { store } = harness();
  store.createConnection({
    connectionId: "digitalocean:werewolf-dns",
    kind: "digitalocean-api@1",
    label: "Werewolf DNS",
    secretGeneration: 1,
    readiness: "ready",
    metadata: {},
    constraints: { zones: ["werewolf.solutions"] },
    createdAt: 1,
  });
  const first = store.appendPolicy({
    scopeKind: "target",
    scopeId: "target_todo_production",
    expectedRevision: null,
    document: { risk: "production", approval: "authenticated-local-operator" },
    createdAt: 2,
  });
  assert.equal(first.revision, 1);
  assert.equal(
    store.appendPolicy({
      scopeKind: "target",
      scopeId: first.scopeId,
      expectedRevision: 1,
      document: { risk: "production", approval: "authenticated-local-operator", automaticRollback: true },
      createdAt: 3,
    }).revision,
    2,
  );
  assert.throws(
    () => store.appendPolicy({
      scopeKind: "target",
      scopeId: first.scopeId,
      expectedRevision: 1,
      document: {},
      createdAt: 4,
    }),
    DeploymentConflictError,
  );

  const adopted = store.bindResource({
    projectId: "prj_todo",
    environmentId: "production",
    resourceId: "dns-public",
    connectionId: "digitalocean:werewolf-dns",
    providerAccount: "do:werewolf",
    providerObjectId: "record:123",
    observedFingerprint: "sha256:dns",
    expectedRevision: null,
    at: 5,
  });
  assert.equal(adopted.bindingRevision, 1);
  assert.deepEqual(store.listResourceBindings("prj_todo", "production"), [adopted]);
  assert.throws(() =>
    store.bindResource({
      projectId: "prj_other",
      environmentId: "production",
      resourceId: "dns-public",
      connectionId: "digitalocean:werewolf-dns",
      providerAccount: "do:werewolf",
      providerObjectId: "record:123",
      observedFingerprint: "sha256:dns",
      expectedRevision: null,
      at: 6,
    }),
  );
});

test("a plan revision supersedes the old exact plan and preserves ordered actions", () => {
  const { store } = harness();
  finishPreparation(store);
  artifact(store);
  const first = plan(store);
  const second = plan(store, {
    revision: 2,
    digest: "sha256:plan-2",
    createdAt: 60,
    expiresAt: 1_100,
  });
  assert.equal(store.getPlan(first.planId, 1).supersededAt, 60);
  assert.equal(second.actions[0].actionId, "nginx-update");
  assert.equal(second.actions[0].ordinal, 0);
  assert.equal(second.actions[1].sideEffecting, false);
  assert.deepEqual(store.listPlans("prj_todo", "production").map((entry) => entry.revision), [2, 1]);
  assert.deepEqual(
    store.listArtifacts({ projectId: "prj_todo", commitSha: "7c21e4a9" }).map((entry) => entry.artifactId),
    ["artifact_todo_052"],
  );
});

test("approval and queueing are one exact, one-use transaction", () => {
  const { database, store } = readyDeploymentStore();
  assert.throws(
    () => approve(store, { acknowledgementIds: ["production-risk"] }),
    DeploymentConflictError,
  );
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM deployment_approvals").get() as { count: number }).count,
    0,
    "a rejected approval leaves no authority record",
  );
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM deployment_runs WHERE run_kind = 'deployment'").get() as { count: number }).count,
    0,
    "and no runnable row",
  );

  const queued = approve(store);
  assert.equal(queued.created, true);
  assert.equal(queued.approval.consumedAt, 50);
  assert.equal(queued.run.state, "queued");
  assert.equal(queued.run.artifactRunId, "run_prepare");
  const steps = store.listRunSteps(queued.run.runId);
  assert.equal(steps.length, 1, "only side effects become idempotent executor steps");
  assert.equal(steps[0].state, "prepared");
  assert.deepEqual(steps[0].preconditions, { observedFingerprint: "sha256:old-nginx" });

  const retried = approve(store);
  assert.equal(retried.created, false);
  assert.equal(retried.run.runId, queued.run.runId);
  assert.throws(
    () => approve(store, { actorSubject: "usr_someone_else" }),
    DeploymentConflictError,
  );
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM deployment_runs WHERE run_kind = 'deployment'").get() as { count: number }).count,
    1,
  );
});

test("blocked, expired and artifact-expired plans cannot be queued", () => {
  {
    const { store } = harness();
    finishPreparation(store);
    artifact(store);
    plan(store, { blocked: true });
    assert.throws(() => approve(store), DeploymentConflictError);
  }
  {
    const { store } = harness();
    finishPreparation(store);
    artifact(store);
    plan(store, { expiresAt: 49 });
    assert.throws(() => approve(store), DeploymentConflictError);
  }
  {
    const { store } = harness();
    finishPreparation(store);
    artifact(store, { retainedUntil: 50 });
    plan(store);
    assert.throws(() => approve(store), DeploymentConflictError);
  }
});

test("run and side-effect transitions use compare-and-set", () => {
  const { store } = readyDeploymentStore();
  const { run } = approve(store);
  assert.equal(
    store.transitionRun({
      runId: run.runId,
      expectedStates: ["queued"],
      state: "acquiring-locks",
      phase: "locks",
      at: 60,
    }).startedAt,
    60,
  );
  assert.throws(
    () => store.transitionRun({
      runId: run.runId,
      expectedStates: ["queued"],
      state: "failed",
      phase: "failed",
      at: 61,
    }),
    DeploymentTransitionError,
  );

  assert.throws(
    () => store.transitionRunStep({
      runId: run.runId,
      ordinal: 0,
      expectedState: "prepared",
      state: "completed",
      at: 62,
    }),
    DeploymentTransitionError,
  );
  const submitted = store.transitionRunStep({
    runId: run.runId,
    ordinal: 0,
    expectedState: "prepared",
    state: "submitted",
    at: 63,
  });
  assert.equal(submitted.submittedAt, 63);
  assert.equal(submitted.externalId, null, "intent can be durable before a provider returns an id");
  const observed = store.transitionRunStep({
    runId: run.runId,
    ordinal: 0,
    expectedState: "submitted",
    state: "observed",
    externalId: "workflow:991842",
    result: { conclusion: "success" },
    at: 64,
  });
  assert.equal(observed.externalId, "workflow:991842");
  assert.deepEqual(observed.result, { conclusion: "success" });
  assert.equal(
    store.transitionRunStep({
      runId: run.runId,
      ordinal: 0,
      expectedState: "observed",
      state: "completed",
      at: 65,
    }).completedAt,
    65,
  );
});

test("event sequence and replay cursor survive a database reopen", () => {
  const file = path.join(sandbox(), "psm.db");
  const firstDb = openDatabase(file);
  const first = new DeploymentStore(firstDb);
  first.createPreparationRun({ runId: "run_prepare", projectId: "prj_todo", createdAt: 1 });
  assert.equal(
    first.appendEvent({
      runId: "run_prepare",
      at: 2,
      type: "prepare-dispatched@1",
      phase: "dispatching",
      level: "info",
      message: "workflow intent persisted",
      data: { repository: "Werewolf-Solutions/todo-app" },
    }).sequence,
    1,
  );
  firstDb.close();

  const secondDb = openDatabase(file);
  const second = new DeploymentStore(secondDb);
  assert.equal(
    second.appendEvent({
      runId: "run_prepare",
      at: 3,
      type: "prepare-observed@1",
      phase: "waiting-executor",
      level: "info",
      message: "workflow found by idempotency key",
      data: { workflowRunId: "4567" },
    }).sequence,
    2,
  );
  assert.deepEqual(second.listEvents("run_prepare", 1).map((event) => event.sequence), [2]);
  secondDb.close();
});

test("target locks are all-or-nothing and expiry requires explicit observed recovery", () => {
  const { store } = readyDeploymentStore();
  const first = approve(store);
  store.createPreparationRun({ runId: "run_contender", projectId: "prj_other", createdAt: 51 });
  const acquired = store.claimTargetLocks({
    runId: first.run.runId,
    bootId: "boot-a",
    lockKeys: ["target:ssh:todo", "resource:dns:todo"],
    now: 60,
    leaseExpiresAt: 100,
  });
  assert.equal(acquired.acquired, true);

  const contention = store.claimTargetLocks({
    runId: "run_contender",
    bootId: "boot-b",
    lockKeys: ["resource:dns:todo", "target:ssh:other"],
    now: 101,
    leaseExpiresAt: 150,
  });
  assert.equal(contention.acquired, false);
  if (!contention.acquired) {
    assert.deepEqual(contention.expired.map((lock) => lock.lockKey), ["resource:dns:todo"]);
  }
  assert.equal(store.getTargetLock("target:ssh:other"), null, "partial acquisition rolled back");
  assert.equal(store.getTargetLock("resource:dns:todo")?.ownerRunId, first.run.runId);

  assert.throws(
    () => store.recoverExpiredTargetLock({
      lockKey: "resource:dns:todo",
      expectedOwnerRunId: first.run.runId,
      expectedOwnerBootId: "boot-a",
      newOwnerRunId: "run_contender",
      newOwnerBootId: "boot-b",
      observedAt: 99,
      leaseExpiresAt: 160,
    }),
    DeploymentConflictError,
  );
  assert.equal(
    store.recoverExpiredTargetLock({
      lockKey: "resource:dns:todo",
      expectedOwnerRunId: first.run.runId,
      expectedOwnerBootId: "boot-a",
      newOwnerRunId: "run_contender",
      newOwnerBootId: "boot-b",
      observedAt: 101,
      leaseExpiresAt: 160,
    }).ownerRunId,
    "run_contender",
  );
  assert.throws(() => store.releaseTargetLocks("run_contender", "boot-b"), DeploymentConflictError);
  store.transitionRun({
    runId: "run_contender",
    expectedStates: ["queued"],
    state: "cancelled",
    phase: "cancelled",
    at: 102,
  });
  assert.equal(store.releaseTargetLocks("run_contender", "boot-b"), 1);
});

test("startup work returns queued and uncertain runs but never terminal history", () => {
  const { store } = harness();
  store.createPreparationRun({ runId: "run_queued", projectId: "prj_todo", createdAt: 1 });
  store.createPreparationRun({ runId: "run_uncertain", projectId: "prj_todo", createdAt: 2 });
  store.transitionRun({
    runId: "run_uncertain",
    expectedStates: ["queued"],
    state: "recovery-required",
    phase: "recovery",
    recoveryReason: "provider accepted an action with no response",
    at: 3,
  });
  store.createPreparationRun({ runId: "run_done", projectId: "prj_todo", createdAt: 4 });
  store.transitionRun({
    runId: "run_done",
    expectedStates: ["queued"],
    state: "cancelled",
    phase: "cancelled",
    at: 5,
  });
  assert.deepEqual(store.listStartupWork().map((run) => run.runId), ["run_queued", "run_uncertain"]);
});

test("only an unverified active release takes a later verified receipt", () => {
  const { store } = readyDeploymentStore();
  const run = approve(store).run;
  const base = {
    releaseId: "rel_todo_052", artifactId: "artifact_todo_052", activationRunId: run.runId, targetId: "target_todo_production",
    projectId: "prj_todo", environmentId: "production", unitId: "web", provenance: "managed" as const,
    targetContractDigest: "sha256:target-contract", activatedAt: 100, expectedCurrentReleaseId: null,
  };
  store.activateRelease({ ...base, receipt: { releaseId: "rel_todo_052", verified: false } });
  const verified = { releaseId: "rel_todo_052", state: "activated" };
  assert.equal(store.verifyActiveRelease({ releaseId: "rel_todo_052", targetId: "target_todo_production", activationRunId: run.runId, receipt: verified }), true);
  assert.deepEqual(store.getActiveRelease("target_todo_production")?.receipt, verified);
  // A verified receipt is never rewritten again.
  assert.equal(store.verifyActiveRelease({ releaseId: "rel_todo_052", targetId: "target_todo_production", activationRunId: run.runId, receipt: { other: true } }), false);
  assert.deepEqual(store.getActiveRelease("target_todo_production")?.receipt, verified);
});

test("release activation is exact-current CAS and rollback reuses retained bytes", () => {
  const { store } = readyDeploymentStore();
  const firstRun = approve(store).run;
  const first = store.activateRelease({
    releaseId: "rel_todo_052",
    artifactId: "artifact_todo_052",
    activationRunId: firstRun.runId,
    targetId: "target_todo_production",
    projectId: "prj_todo",
    environmentId: "production",
    unitId: "web",
    provenance: "managed",
    targetContractDigest: "sha256:target-contract",
    receipt: { releaseId: "rel_todo_052", active: true },
    activatedAt: 100,
    expectedCurrentReleaseId: null,
  });
  assert.equal(first.previousReleaseId, null);
  assert.equal(
    store.activateRelease({
      releaseId: "rel_todo_052",
      artifactId: "artifact_todo_052",
      activationRunId: firstRun.runId,
      targetId: "target_todo_production",
      projectId: "prj_todo",
      environmentId: "production",
      unitId: "web",
      provenance: "managed",
      targetContractDigest: "sha256:target-contract",
      receipt: { releaseId: "rel_todo_052", active: true },
      activatedAt: 101,
      expectedCurrentReleaseId: "rel_todo_052",
    }).activatedAt,
    100,
    "a recovered observation of the same activation is idempotent",
  );
  assert.throws(
    () => store.activateRelease({
      releaseId: "rel_wrong",
      artifactId: "artifact_todo_052",
      activationRunId: firstRun.runId,
      targetId: "target_todo_production",
      projectId: "prj_todo",
      environmentId: "production",
      unitId: "web",
      provenance: "managed",
      targetContractDigest: "sha256:target-contract",
      receipt: { releaseId: "rel_wrong", active: true },
      activatedAt: 101,
      expectedCurrentReleaseId: null,
    }),
    DeploymentConflictError,
  );

  finishPreparation(store, "run_prepare_053", 110);
  artifact(store, {
    artifactId: "artifact_todo_053",
    producingRunId: "run_prepare_053",
    githubArtifactId: "8124",
    producerRunId: "4568",
    commitSha: "8d32f5b0",
    version: "0.5.3",
    createdAt: 130,
  });
  // The activation run only carries integrity/provenance here; the runner owns
  // authorization and transitions. Reuse the existing deployment run in this
  // focused persistence test.
  const second = store.activateRelease({
    releaseId: "rel_todo_053",
    artifactId: "artifact_todo_053",
    activationRunId: firstRun.runId,
    targetId: "target_todo_production",
    projectId: "prj_todo",
    environmentId: "production",
    unitId: "web",
    provenance: "managed",
    targetContractDigest: "sha256:target-contract",
    receipt: { releaseId: "rel_todo_053", active: true },
    activatedAt: 140,
    expectedCurrentReleaseId: "rel_todo_052",
  });
  assert.equal(second.previousReleaseId, "rel_todo_052");
  assert.equal(store.listReleases(second.targetId).length, 2);

  const rolledBack = store.activateRelease({
    releaseId: "rel_todo_052",
    artifactId: "artifact_todo_052",
    activationRunId: firstRun.runId,
    targetId: "target_todo_production",
    projectId: "prj_todo",
    environmentId: "production",
    unitId: "web",
    provenance: "managed",
    targetContractDigest: "sha256:target-contract",
    receipt: { releaseId: "rel_todo_052", rollback: true },
    activatedAt: 150,
    expectedCurrentReleaseId: "rel_todo_053",
  });
  assert.equal(rolledBack.releaseId, "rel_todo_052");
  assert.equal(rolledBack.previousReleaseId, "rel_todo_053");
  assert.equal(store.listReleases(second.targetId).length, 2, "rollback does not invent new bytes");
});

test("watch storage keeps the newest provider observation", () => {
  const { store } = harness();
  const fresh = store.putWatchSnapshot({
    monitorId: "monitor:todo-public",
    projectId: "prj_todo",
    environmentId: "production",
    unitId: "web",
    providerState: "up",
    freshness: "fresh",
    effectiveState: "healthy",
    observedAt: 100,
    ingestedAt: 101,
    normalizedState: { status: 200, latencyMs: 84 },
  });
  assert.equal(fresh.effectiveState, "healthy");
  const result = store.putWatchSnapshot({
    ...fresh,
    providerState: "down",
    effectiveState: "down",
    observedAt: 90,
    ingestedAt: 102,
    normalizedState: { status: 503 },
  });
  assert.equal(result.effectiveState, "healthy", "an older response cannot replace the latest truth");
  assert.equal(result.observedAt, 100);
});
