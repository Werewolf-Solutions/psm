import assert from "node:assert/strict";
import test from "node:test";

import { defaultDeploymentAdapters, installedExecutorKinds } from "./executors.ts";
import type { DeploymentActionAdapter, DeploymentAdapterContext } from "./runner.ts";
import type { DeploymentPlan, DeploymentPlanAction, DeploymentRun } from "./store.ts";

const COMMIT = "c".repeat(40);

/**
 * Every probe below uses `http://`, which `httpProbe` refuses before it resolves
 * anything. That keeps these tests off the network while still exercising the
 * real failure path: a probe that cannot be performed is evidence of nothing,
 * so the adapter must report `failed` rather than pass the action.
 */
function planDocument(overrides: Record<string, unknown> = {}) {
  return {
    schema: "psm.werewolf.solutions/deployment-plan/v1",
    planId: "plan_todo_production",
    revision: 1,
    projectId: "prj_todo",
    environmentId: "production",
    operation: "deploy",
    artifact: {
      artifactId: "art_todo_web_0001",
      commitSha: COMMIT,
      version: "0.5.2",
    },
    rollbackRelease: null,
    manifest: {
      projectId: "prj_todo",
      environments: [{
        id: "production",
        dependencies: [{
          id: "api",
          kind: "http-status@1",
          request: { url: "http://api.example.com/todo", method: "GET" },
          expect: { status: 401 },
        }],
        resources: [{
          id: "public-dns",
          kind: "digitalocean-dns-record@1",
          connection: "dns",
          desired: { zone: "example.com", type: "A", name: "todo", ttl: 300 },
        }],
        units: [{
          id: "web",
          verification: [{
            id: "home",
            kind: "http-status@1",
            request: { url: "http://todo.example.com/", method: "GET" },
            expect: { status: 200 },
          }, {
            id: "served-release",
            kind: "release-metadata@1",
            request: { url: "http://todo.example.com/version.json", method: "GET" },
            expect: { commit: "$release.commit", psmArtifactId: "$release.psmArtifactId" },
          }],
        }],
      }],
    },
    ...overrides,
  };
}

function context(kind: string, ownerRef: string, document = planDocument()): DeploymentAdapterContext {
  const action = {
    ordinal: 0,
    actionId: `${ownerRef}#action`,
    actionDigest: "sha256:action",
    kind,
    phase: "verify",
    sideEffecting: false,
    preconditions: {},
    document: { ownerRef, kind },
  } as unknown as DeploymentPlanAction;
  return {
    run: { runId: "run_deploy_todo" } as DeploymentRun,
    plan: { planId: "plan_todo_production", revision: 1, document } as unknown as DeploymentPlan,
    action,
    step: null,
    idempotencyKey: null,
    externalId: null,
    signal: new AbortController().signal,
  };
}

function adapter(kind: string): DeploymentActionAdapter {
  const found = defaultDeploymentAdapters().find((item) => item.kind === kind);
  assert.ok(found, `no default adapter for ${kind}`);
  return found;
}

test("every installed adapter is read-only and explicitly versioned", () => {
  const adapters = defaultDeploymentAdapters();
  assert.deepEqual(installedExecutorKinds(adapters), [
    "assert-dependency@1",
    "verify-release@1",
    "verify-resource@1",
  ]);
  for (const item of adapters) {
    assert.match(item.kind, /^[-a-z0-9]+@\d+$/);
    assert.ok(item.check, `${item.kind} must be usable as a read-only check`);
    assert.equal(item.submit, undefined, `${item.kind} must not be able to mutate anything`);
    assert.equal(item.observe, undefined);
  }
});

test("a dependency that cannot be probed fails the action instead of passing it", async () => {
  const observation = await adapter("assert-dependency@1").check!(context("assert-dependency@1", "dependency:api"));
  assert.equal(observation.outcome, "failed");
  assert.match(JSON.stringify(observation.data), /HTTPS/);
});

test("a resource with no discovery adapter fails closed", async () => {
  // Nothing local can observe a DigitalOcean record, and "unobserved" must
  // never read as "in sync".
  const observation = await adapter("verify-resource@1").check!(context("verify-resource@1", "resource:public-dns"));
  assert.equal(observation.outcome, "failed");
  assert.match(JSON.stringify(observation.data), /discovery adapter is configured/);
});

test("release verification is bound to the exact approved artifact", async () => {
  const observation = await adapter("verify-release@1").check!(context("verify-release@1", "verification:home"));
  assert.equal(observation.outcome, "failed");
  const data = observation.data as { expected: { commit: string; psmArtifactId: string; version: string } };
  assert.deepEqual(data.expected, { commit: COMMIT, psmArtifactId: "art_todo_web_0001", version: "0.5.2" });
});

test("a rollback verifies the retained release it reactivates, not the artifact", async () => {
  const document = planDocument({
    operation: "rollback",
    artifact: null,
    rollbackRelease: {
      releaseId: "rel_0001",
      artifactId: "art_todo_web_0000",
      receipt: { commit: "d".repeat(40), version: "0.5.1" },
    },
  });
  // A rollback names a whole unit, so every one of its probes runs.
  const observation = await adapter("verify-release@1").check!(context("verify-release@1", "unit:web", document));
  const data = observation.data as {
    expected: { commit: string; psmArtifactId: string; version: string };
    probes: { id: string }[];
  };
  assert.deepEqual(data.expected, { commit: "d".repeat(40), psmArtifactId: "art_todo_web_0000", version: "0.5.1" });
  assert.deepEqual(data.probes.map((probe) => probe.id), ["home", "served-release"]);
});

test("an action naming something the manifest does not declare is a plan defect", async () => {
  await assert.rejects(
    () => adapter("assert-dependency@1").check!(context("assert-dependency@1", "dependency:ghost")),
    /plan names dependency ghost/,
  );
  await assert.rejects(
    () => adapter("verify-release@1").check!(context("verify-release@1", "verification:ghost")),
    /plan names verification ghost/,
  );
  // A verify action pointed at a dependency owner is a graph bug, not a retry.
  await assert.rejects(
    () => adapter("verify-resource@1").check!(context("verify-resource@1", "dependency:api")),
    /expected a resource action/,
  );
});

test("a plan whose environment is missing from its own manifest is refused", async () => {
  const document = planDocument({ environmentId: "staging" });
  await assert.rejects(
    () => adapter("assert-dependency@1").check!(context("assert-dependency@1", "dependency:api", document)),
    /its own manifest does not declare/,
  );
});

test("a deploy plan that reached verification with no artifact is refused", async () => {
  const document = planDocument({ artifact: null });
  await assert.rejects(
    () => adapter("verify-release@1").check!(context("verify-release@1", "verification:home", document)),
    /without an approved artifact/,
  );
});
