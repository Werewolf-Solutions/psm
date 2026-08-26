import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeDeploymentAction,
  composeDeploymentPolicy,
  strictestApproval,
  type DeploymentPolicyLayer,
} from "./policy.ts";

const targetPolicy = (overrides: Partial<DeploymentPolicyLayer> = {}): DeploymentPolicyLayer => ({
  id: "target:todo-production",
  revision: 4,
  source: "local",
  scope: { kind: "target", id: "werewolf:todo-production-web" },
  minimumRisk: "production",
  maximumAuthorizedRisk: "production",
  planTtlSeconds: 900,
  maxWatchAgeSeconds: 300,
  approval: "local-operator",
  allowedSourceRefs: ["refs/heads/master", "refs/tags/release"],
  requiredChecks: [
    { context: "test", publisherKind: "app", publisherId: "github-actions" },
  ],
  requireFreshWatchBeforeRelease: false,
  authority: {
    delete: true,
    automaticRollback: true,
    breakGlass: true,
    pairedApproval: true,
  },
  ...overrides,
});

test("production fails closed without an explicit target-scoped local policy", () => {
  const result = composeDeploymentPolicy("production", [{
    id: "global",
    revision: 1,
    source: "local",
    scope: { kind: "global", id: "workspace" },
    minimumRisk: "production",
    approval: "local-operator",
  }]);

  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === "production-policy-missing"));
  assert.equal(result.policy.approval, "authenticated-local-operator");
  assert.deepEqual(result.policy.authority, {
    delete: false,
    automaticRollback: false,
    breakGlass: false,
    pairedApproval: false,
  });
});

test("policy composition only becomes stricter", () => {
  const result = composeDeploymentPolicy("staging", [
    targetPolicy(),
    {
      id: "connection:ssh",
      revision: "r7",
      source: "connection",
      scope: { kind: "connection", id: "ssh:todo-production" },
      minimumRisk: "staging",
      maximumAuthorizedRisk: "production",
      planTtlSeconds: 600,
      maxWatchAgeSeconds: 180,
      approval: "authenticated-operator",
      allowedSourceRefs: ["refs/heads/master"],
      requiredChecks: [
        { context: "test", publisherKind: "app", publisherId: "github-actions" },
        { context: "build", publisherKind: "app", publisherId: "github-actions" },
      ],
      requireFreshWatchBeforeRelease: true,
      authority: {
        delete: true,
        automaticRollback: true,
        breakGlass: true,
        pairedApproval: true,
      },
    },
    {
      id: "manifest",
      revision: "sha256:manifest",
      source: "manifest",
      scope: { kind: "manifest", id: "production" },
      planTtlSeconds: 700,
      maxWatchAgeSeconds: 240,
      allowedSourceRefs: ["refs/heads/master", "refs/heads/feature"],
      authority: { delete: false, automaticRollback: true },
    },
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.policy.risk, "production");
  assert.equal(result.policy.planTtlSeconds, 600);
  assert.equal(result.policy.maxWatchAgeSeconds, 180);
  assert.equal(result.policy.approval, "authenticated-local-operator");
  assert.equal(result.policy.requireFreshWatchBeforeRelease, true);
  assert.deepEqual(result.policy.allowedSourceRefs, ["refs/heads/master"]);
  assert.deepEqual(result.policy.requiredChecks.map((check) => check.context), ["build", "test"]);
  assert.deepEqual(result.policy.authority, {
    delete: false,
    automaticRollback: true,
    breakGlass: true,
    pairedApproval: true,
  });
  assert.equal(result.policy.inputRevisions.length, 3);
});

test("risk ceilings and disjoint source policies are blockers", () => {
  const result = composeDeploymentPolicy("production", [
    targetPolicy(),
    {
      id: "connection:staging-only",
      revision: 2,
      source: "connection",
      scope: { kind: "connection", id: "ssh:staging" },
      maximumAuthorizedRisk: "staging",
      allowedSourceRefs: ["refs/heads/not-master"],
    },
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === "connection-risk-exceeded"));
  assert.ok(result.blockers.some((blocker) => blocker.code === "source-ref-empty"));
});

test("approval requirements compose as independent authentication and locality requirements", () => {
  assert.equal(
    strictestApproval(["authenticated-operator", "local-operator"]),
    "authenticated-local-operator",
  );
});

test("authority guard enforces origin, identity, and explicit capability grants", () => {
  const policy = composeDeploymentPolicy("production", [targetPolicy({
    authority: {
      delete: false,
      automaticRollback: true,
      breakGlass: false,
      pairedApproval: false,
    },
  })]).policy;

  assert.deepEqual(
    authorizeDeploymentAction(policy, {
      action: "approve",
      origin: "local",
      authenticated: true,
    }),
    { allowed: true, reasons: [] },
  );
  const paired = authorizeDeploymentAction(policy, {
    action: "approve",
    origin: "paired",
    authenticated: true,
  });
  assert.equal(paired.allowed, false);
  assert.ok(paired.reasons.includes("approval requires local origin"));
  assert.ok(paired.reasons.includes("paired approval is not authorized"));

  assert.equal(authorizeDeploymentAction(policy, {
    action: "delete-resource",
    origin: "local",
    authenticated: true,
  }).allowed, false);
  assert.equal(authorizeDeploymentAction(policy, {
    action: "automatic-rollback",
    origin: "paired",
    authenticated: false,
  }).allowed, true);
  assert.equal(authorizeDeploymentAction(policy, {
    action: "mutate-secret",
    origin: "paired",
    authenticated: true,
  }).allowed, false);
});
