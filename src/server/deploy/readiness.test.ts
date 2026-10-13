import assert from "node:assert/strict";
import test from "node:test";
import { buildDeploymentPlan, type BuildDeploymentPlanInput } from "./planner.ts";
import { deploymentReadiness, externalPreparationMessage, repositoryRepairItems } from "./readiness.ts";

/**
 * Readiness is read off a real plan, never a hand-built shape: the whole point
 * of the checklist is that it says the same thing the deploy button obeys.
 */
function plan(overrides: Partial<BuildDeploymentPlanInput> = {}) {
  const environment = {
    id: "staging",
    risk: "staging",
    releasePolicy: { allowedBranch: "master", requireReachableFromBranch: true, requireChecks: false, approval: "authenticated-local-operator" },
    connections: { github: { kind: "github-actions@1" }, host: { kind: "ssh-host-helper@1" } },
    dependencies: [],
    resources: [],
    units: [],
    watch: [],
    policy: { planTtlSeconds: 600, rollbackOnVerificationFailure: true, allowDelete: false, requireFreshWatchBeforeRelease: false },
  } as BuildDeploymentPlanInput["environment"];
  return buildDeploymentPlan({
    now: Date.now(),
    planId: "dpl_fixed",
    operation: "reconcile",
    manifest: { apiVersion: "psm.werewolf.solutions/deployments/v1", kind: "DeploymentManifest", projectId: "prj_11111111111111111111", environments: [environment] },
    environment,
    graph: { projectId: "prj_11111111111111111111", environmentId: "staging", nodes: [], order: [] },
    source: {
      checkoutId: "chk_test", checkoutPath: "/work", commit: "1".repeat(40), branch: "master",
      manifestText: "{}", manifestDigest: "sha256:m", identityText: "{}", identityDigest: "sha256:i",
      packageText: "{}", packageDigest: "sha256:p", projectId: "prj_11111111111111111111", version: "0.1.0", subject: "release",
    },
    sourceInputsDirty: false,
    sourceReachable: true,
    connections: [
      { slot: "github", kind: "github-actions@1", connectionId: "con_gh", profile: "werewolf-ci", ready: true, detail: "ready", metadataRevision: 1, bindingRevision: 1, secretGeneration: 1, principal: "token:ci", scopeFingerprint: "sha256:g" },
      { slot: "host", kind: "ssh-host-helper@1", connectionId: "con_host", profile: "droplet", ready: true, detail: "ready", metadataRevision: 1, bindingRevision: 1, secretGeneration: 1, principal: "key:test", scopeFingerprint: "sha256:h" },
    ],
    observations: { dependencies: [], resources: [], watch: [], observedAt: Date.now() },
    policy: {
      risk: "staging", planTtlSeconds: 600, maxWatchAgeSeconds: 180, requiredChecks: [], allowedSourceRefs: ["master"],
      approval: "authenticated-local-operator", requireFreshWatchBeforeRelease: false,
      authority: { delete: false, automaticRollback: false, breakGlass: false, pairedApproval: false }, inputRevisions: [],
    },
    ...overrides,
  }).document;
}

test("a plan with nothing outstanding is ready to deploy", () => {
  const readiness = deploymentReadiness(plan(), { canPrepare: false });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.canMakeReady, false);
  assert.ok(readiness.items.every((item) => item.status === "ready"), JSON.stringify(readiness.items));
});

test("readiness names the connection to make, not just that one is missing", () => {
  const document = plan();
  const readiness = deploymentReadiness(
    { ...document, blocked: true, blockers: [{ id: "connection-missing:connection:host", code: "connection-missing", title: "Connection Missing", message: "No profile is bound", ownerRef: "connection:host" }] },
    { canPrepare: false },
  );
  const item = readiness.items.find((entry) => entry.code === "connection-missing");
  assert.ok(item, JSON.stringify(readiness.items));
  assert.equal(item.action, "connect");
  assert.equal(item.slot, "host");
  assert.equal(item.title, "Connect host");
  assert.equal(readiness.ready, false);
  assert.equal(readiness.canMakeReady, false, "psm cannot supply a credential on the operator's behalf");
});

test("a connection that is bound is reported as done, not left silent", () => {
  // The checklist has to show the whole list, or "2 remaining" is unreadable.
  const readiness = deploymentReadiness(plan(), { canPrepare: false });
  const slots = readiness.items.filter((item) => item.code === "connection-ready").map((item) => item.slot);
  assert.deepEqual(slots.sort(), ["github", "host"]);
});

test("a missing build is the one step psm offers to run itself", () => {
  const readiness = deploymentReadiness(plan({ operation: "deploy" }), { canPrepare: true });
  const item = readiness.items.find((entry) => entry.code === "artifact-missing");
  assert.ok(item, JSON.stringify(readiness.items));
  assert.equal(item.action, "prepare-artifact");
  assert.equal(item.automatic, true);
  assert.equal(item.status, "action-required");
  assert.equal(readiness.canMakeReady, true);
  assert.equal(readiness.ready, false);
});

test("without a usable build provider the same step is the operator's, and says why", () => {
  const readiness = deploymentReadiness(plan({ operation: "deploy" }), { canPrepare: false });
  const item = readiness.items.find((entry) => entry.code === "artifact-missing");
  assert.ok(item);
  assert.equal(item.automatic, false);
  assert.equal(item.status, "blocked");
  assert.match(item.detail, /Connect the build provider/);
  assert.equal(readiness.canMakeReady, false, "offering a button that cannot run is worse than not offering it");
});

test("while a build runs, nothing invites a second one", () => {
  const readiness = deploymentReadiness(plan({ operation: "deploy" }), { canPrepare: true, preparing: true });
  const item = readiness.items.find((entry) => entry.code === "artifact-missing");
  assert.ok(item);
  assert.equal(item.status, "preparing");
  assert.equal(item.automatic, false);
  assert.equal(readiness.canMakeReady, false);
  assert.equal(readiness.ready, false);
});

test("an expired check is not a pass", () => {
  // Readiness answers "right now". A stale yes must not authorise a release.
  const document = plan();
  const readiness = deploymentReadiness({ ...document, expiresAt: Date.now() - 1 }, { canPrepare: false });
  assert.equal(document.blocked, false);
  assert.equal(readiness.ready, false);
});

test("a blocked action is not listed twice as its own cause", () => {
  // The graph reports "this action cannot run" for the same resource the
  // observation already explained. Listing both makes the operator fix one
  // thing and watch the count stay put.
  const document = plan();
  const readiness = deploymentReadiness({
    ...document,
    blocked: true,
    blockers: [
      { id: "resource-drift:resource:ingress", code: "resource-drift", title: "Resource Drift", message: "ingress: nginx config differs", ownerRef: "resource:ingress" },
      { id: "action-blocked:resource:ingress", code: "action-blocked", title: "Action Blocked", message: "ingress: nginx config differs", ownerRef: "resource:ingress" },
    ],
  }, { canPrepare: false });
  const outstanding = readiness.items.filter((item) => item.status !== "ready");
  assert.equal(outstanding.length, 1, JSON.stringify(outstanding));
  assert.equal(outstanding[0].code, "resource-drift");
  assert.equal(outstanding[0].action, "review-resource");
  assert.equal(outstanding[0].title, "Review ingress");
});

test("when psm knows why it cannot build, it says that instead of a shrug", () => {
  // "Connect the build provider, configure its workflow, and commit the
  // inputs" makes the operator check three things to discover it was one.
  const readiness = deploymentReadiness(plan({ operation: "deploy" }), {
    canPrepare: false,
    preparationDetail: "deployment inputs differ from committed HEAD",
  });
  const item = readiness.items.find((entry) => entry.code === "artifact-missing");
  assert.ok(item);
  assert.equal(item.detail, "deployment inputs differ from committed HEAD");
  assert.equal(item.action, "prepare-artifact");
  assert.equal(item.automatic, false);
});


test("readiness preserves upstream ownership and groups a failing host connection", () => {
  const document = plan();
  document.manifest.environments[0].dependencies = [{ id: "todo-api", kind: "http-status@1", projectId: "prj_upstream", request: { url: "https://example.com/todo", method: "GET", timeoutMs: 1000 }, expect: { status: 401 } }];
  document.manifest.environments[0].resources = ["directory", "ingress", "certificate"].map((id) => ({ id, connection: "host" })) as never;
  document.blocked = true;
  document.blockers = [
    { id: "dependency", code: "dependency-failed", title: "API", message: "expected HTTP 401, received 404", ownerRef: "dependency:todo-api" },
    ...["directory", "ingress", "certificate"].map((id) => ({ id, code: "resource-observation-failed", title: id, message: `SSH helper: Load key "/tmp/${id}/identity": error in libcrypto`, ownerRef: `resource:${id}` })),
  ];
  const readiness = deploymentReadiness(document, { canPrepare: false });
  const items = readiness.items.filter((item) => item.status !== "ready");
  assert.equal(items[0].ownerProjectId, "prj_upstream");
  assert.equal(items[0].repairScope, "external");
  assert.ok(items.slice(1).every((item) => item.action === "connect" && item.slot === "host" && item.connectionId === "con_host"));
  assert.deepEqual(repositoryRepairItems(readiness), []);
  const message = externalPreparationMessage(items);
  assert.equal(message.match(/error in libcrypto/g)?.length, 1);
  assert.match(message, /Project prj_upstream/); assert.match(message, /Connection host/);
});

test("App-managed controller prerequisites lead to scoped controller review", () => {
  const document = plan();
  const readiness = deploymentReadiness({ ...document, blocked: true, blockers:
    ["pin", "target", "credentials"].map((part) => ({ id: `executor-not-ready:executor:web:controller-${part}`,
      code: "executor-not-ready", title: "Executor Not Ready", ownerRef: `executor:web:controller-${part}`,
      message: "Press “Review controller setup / update” then apply the reviewed setup." })) }, { canPrepare: true });
  for (const item of readiness.items.filter((entry) => entry.status !== "ready")) {
    assert.equal(item.action, "review-controller");
    assert.equal(item.slot, "github");
    assert.equal(item.automatic, false);
    assert.equal(item.repairScope, "external");
  }
});
