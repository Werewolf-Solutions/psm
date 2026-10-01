import assert from "node:assert/strict";
import test from "node:test";
import { buildDeploymentPlan } from "./planner.ts";
import type { BuildDeploymentPlanInput } from "./planner.ts";

function input(): BuildDeploymentPlanInput {
  const environment = {
    id: "production",
    risk: "production",
    releasePolicy: { allowedBranch: "master", requireReachableFromBranch: true, requireChecks: true, approval: "authenticated-local-operator" },
    connections: { host: { kind: "ssh-host-helper@1" } },
    dependencies: [],
    resources: [],
    units: [],
    watch: [],
    policy: { planTtlSeconds: 600, rollbackOnVerificationFailure: true, allowDelete: false, requireFreshWatchBeforeRelease: false },
  } as BuildDeploymentPlanInput["environment"];
  return {
    now: 1_000,
    planId: "dpl_fixed",
    operation: "reconcile",
    manifest: { apiVersion: "psm.werewolf.solutions/deployments/v1", kind: "DeploymentManifest", projectId: "prj_11111111111111111111", environments: [environment] },
    environment,
    graph: { projectId: "prj_11111111111111111111", environmentId: "production", nodes: [], order: [] },
    source: {
      checkoutId: "chk_test", checkoutPath: "/work", commit: "1".repeat(40), branch: "master",
      manifestText: "{}", manifestDigest: "sha256:m", identityText: "{}", identityDigest: "sha256:i",
      packageText: "{}", packageDigest: "sha256:p", projectId: "prj_11111111111111111111", version: "0.1.0", subject: "release",
    },
    sourceInputsDirty: false,
    sourceReachable: true,
    connections: [{ slot: "host", kind: "ssh-host-helper@1", connectionId: "con_host", profile: "host", ready: true, detail: "ready", metadataRevision: 1, bindingRevision: 1, secretGeneration: 1, principal: "key:test", scopeFingerprint: "sha256:c" }],
    observations: { dependencies: [], resources: [], watch: [], observedAt: 1_000 },
    policy: {
      risk: "production", planTtlSeconds: 600, maxWatchAgeSeconds: 180, requiredChecks: [], allowedSourceRefs: ["master"],
      approval: "authenticated-local-operator", requireFreshWatchBeforeRelease: false,
      authority: { delete: false, automaticRollback: false, breakGlass: false, pairedApproval: false }, inputRevisions: [],
    },
  };
}

test("the same exact inputs produce the same plan digest", () => {
  const first = buildDeploymentPlan(input());
  const second = buildDeploymentPlan(input());
  assert.equal(first.digest, second.digest);
  assert.equal(first.blocked, false);
  assert.deepEqual(first.document.acknowledgements.map((item) => item.id), ["production-target"]);
});

test("HTTP latency does not change plan approval, while changed dependency identity does", () => {
  const first = inputWithAction("assert-dependency@1");
  const original = first.observations.dependencies[0];
  first.observations.dependencies[0] = {
    ...original, detail: "HTTP 401", evidence: { url: "https://api.example.test/health", status: 401, durationMs: 89, redirects: 0 },
  };
  const second = structuredClone(first);
  second.observations.dependencies[0] = {
    ...second.observations.dependencies[0], observedAt: 2_000,
    evidence: { url: "https://api.example.test/health", status: 401, durationMs: 157, redirects: 0 },
  };
  const approved = buildDeploymentPlan(first);
  const rechecked = buildDeploymentPlan(second);
  assert.equal(rechecked.digest, approved.digest, "a slower identical response cannot make a plan stale");
  assert.equal(rechecked.actions[0].digest, approved.actions[0].digest);
  assert.equal(rechecked.document.observations.dependencies[0].evidence?.durationMs, 157, "the real measurement remains visible");
  const changed = structuredClone(second);
  changed.observations.dependencies[0] = {
    ...changed.observations.dependencies[0], fingerprint: "sha256:changed", detail: "HTTP 503",
    state: "blocked", evidence: { url: "https://api.example.test/health", status: 503, durationMs: 157, redirects: 0 },
  };
  assert.notEqual(buildDeploymentPlan(changed).digest, approved.digest);
});

test("dirty deployment inputs block approval", () => {
  const changed = input();
  changed.sourceInputsDirty = true;
  const plan = buildDeploymentPlan(changed);
  assert.equal(plan.blocked, true);
  assert.ok(plan.document.blockers.some((item) => item.code === "source-dirty"));
});

test("production does not silently proceed with an unbound connection", () => {
  const changed = input();
  changed.connections[0].ready = false;
  changed.connections[0].detail = "No profile is bound";
  const plan = buildDeploymentPlan(changed);
  assert.equal(plan.blocked, true);
  assert.ok(plan.document.blockers.some((item) => item.code === "connection-missing"));
});

/** A graph with one real node, so `installedActionKinds` has something to judge. */
function inputWithAction(kind: string): BuildDeploymentPlanInput {
  const changed = input();
  const node = {
    id: "dependency:api#asserted",
    kind,
    phase: "dependencies",
    ownerRef: "dependency:api",
    dependsOn: [],
  } as BuildDeploymentPlanInput["graph"]["nodes"][number];
  changed.graph = { ...changed.graph, nodes: [node], order: [node.id] };
  changed.operation = "deploy";
  changed.observations = {
    dependencies: [{
      id: "api",
      kind: "http-status@1",
      state: "ready",
      title: "api",
      detail: "HTTP 401 in 12ms",
      observedAt: 1_000,
      fingerprint: "sha256:dep",
    }],
    resources: [],
    watch: [],
    observedAt: 1_000,
  };
  changed.artifact = {
    artifactId: "art_todo_web_0001",
    producingRunId: null,
    provenance: "managed",
    projectId: "prj_11111111111111111111",
    kind: "static-files",
    sourceRepository: "Werewolf-Solutions/todo-app",
    githubArtifactId: "778899",
    producerRunId: "112233",
    commitSha: "1".repeat(40),
    version: "0.1.0",
    buildProfileDigest: "sha256:b",
    payloadAlgorithm: "psm-static-tree-sha256@1",
    payloadDigest: "sha256:pd",
    archiveDigest: "sha256:ad",
    providerLocator: {},
    provenanceUrl: null,
    createdAt: 900,
    retainedUntil: 10_000,
    tombstonedAt: null,
  };
  return changed;
}

test("the exact active artifact may be redeployed for PSM verification", () => {
  const candidate = inputWithAction("assert-dependency@1");
  const artifact = candidate.artifact!;
  const targetId = "werewolf:todo-staging-web";
  candidate.environment = {
    ...candidate.environment,
    units: [{ id: "web", target: { targetId }, executor: { sourceRepository: artifact.sourceRepository }, artifact: { buildProfile: {} } }],
  } as BuildDeploymentPlanInput["environment"];
  candidate.manifest = { ...candidate.manifest, environments: [candidate.environment] };
  const active = {
    releaseId: `release_${artifact.artifactId}`, artifactId: artifact.artifactId,
    activationRunId: "run_failed", targetId, projectId: candidate.manifest.projectId,
    environmentId: candidate.environment.id, unitId: "web", previousReleaseId: null,
    provenance: "managed" as const, targetContractDigest: "sha256:target",
    receipt: { verified: false, version: artifact.version, commit: artifact.commitSha, payloadDigest: artifact.payloadDigest },
    activatedAt: 1, deactivatedAt: null, tombstonedAt: null,
  };
  candidate.activeReleases = [active];
  const stage = { id: "unit:web#staged", kind: "stage-static-release@1", phase: "release", ownerRef: "unit:web", dependsOn: [] } as BuildDeploymentPlanInput["graph"]["nodes"][number];
  candidate.graph = { ...candidate.graph, nodes: [...candidate.graph.nodes, stage], order: [...candidate.graph.order, stage.id] };
  const hasVersionBlocker = () => buildDeploymentPlan(candidate).document.blockers.some((item) => item.code === "version-not-increased");
  assert.equal(hasVersionBlocker(), false);
  assert.equal(buildDeploymentPlan(candidate).actions.find((item) => item.id === stage.id)?.sideEffecting, false,
    "verifying the active artifact must not upload it again");
  active.receipt.verified = true;
  assert.equal(hasVersionBlocker(), false, "the exact active release can be reverified after a later PSM probe failed");
  active.receipt.verified = false;
  active.artifactId = "art_other";
  assert.equal(hasVersionBlocker(), true, "another artifact with the same version stays blocked");
  assert.equal(buildDeploymentPlan(candidate).actions.find((item) => item.id === stage.id)?.sideEffecting, true);
  active.artifactId = artifact.artifactId;
  active.receipt.payloadDigest = "sha256:other";
  assert.equal(hasVersionBlocker(), true, "changed content cannot use the verification exception");
  candidate.source = { ...candidate.source, commit: "2".repeat(40), version: "0.1.1" };
  assert.equal(hasVersionBlocker(), false, "a stale artifact is a rebuild issue, not another version bump");
  assert.ok(buildDeploymentPlan(candidate).document.blockers.some((item) => item.code === "artifact-source-mismatch"));
  candidate.artifact = null;
  active.receipt.verified = true;
  candidate.source.version = active.receipt.version;
  assert.equal(hasVersionBlocker(), true, "external commits without a version bump are caught before spending a build");
  candidate.source.version = "0.1.1";
  assert.equal(hasVersionBlocker(), false, "a newer committed version just needs its own build");
});

test("a build from an older commit asks for a new build, not another version bump", () => {
  const candidate = inputWithAction("assert-dependency@1");
  const artifact = candidate.artifact!;
  candidate.source = { ...candidate.source, commit: "2".repeat(40), version: "0.1.1" };
  candidate.activeReleases = [{
    releaseId: `release_${artifact.artifactId}`, artifactId: artifact.artifactId,
    activationRunId: "run_ok", targetId: "werewolf:todo-staging-web", projectId: candidate.manifest.projectId,
    environmentId: candidate.environment.id, unitId: "web", previousReleaseId: null,
    provenance: "managed", targetContractDigest: "sha256:target",
    receipt: { verified: true, version: artifact.version, commit: artifact.commitSha, payloadDigest: artifact.payloadDigest },
    activatedAt: 1, deactivatedAt: null, tombstonedAt: null,
  }];
  const codes = buildDeploymentPlan(candidate).document.blockers.map((item) => item.code);
  assert.ok(codes.includes("artifact-source-mismatch"));
  assert.ok(!codes.includes("version-not-increased"));
});

test("an action kind no installed executor performs blocks the plan before approval", () => {
  // Without this the same refusal happens inside the runner, after an operator
  // has already approved a production release.
  const plan = buildDeploymentPlan({
    ...inputWithAction("reconcile-dns@1"),
    installedActionKinds: ["assert-dependency@1", "verify-release@1", "verify-resource@1"],
  });
  assert.equal(plan.blocked, true);
  const blocker = plan.document.blockers.find((item) => item.code === "executor-missing");
  assert.ok(blocker, JSON.stringify(plan.document.blockers));
  assert.match(blocker.message, /No installed executor performs reconcile-dns@1/);
  assert.equal(blocker.ownerRef, "action-kind:reconcile-dns@1");
});

test("a plan whose every action kind is installed is not blocked by that check", () => {
  const plan = buildDeploymentPlan({
    ...inputWithAction("assert-dependency@1"),
    installedActionKinds: ["assert-dependency@1", "verify-release@1", "verify-resource@1"],
  });
  assert.ok(!plan.document.blockers.some((item) => item.code === "executor-missing"), JSON.stringify(plan.document.blockers));
});

test("omitting the installed set does not invent an executor blocker", () => {
  // The runner still refuses; the planner simply has nothing to assert on.
  const plan = buildDeploymentPlan(inputWithAction("reconcile-dns@1"));
  assert.ok(!plan.document.blockers.some((item) => item.code === "executor-missing"));
});

test("nginx reload remains a mutation even when the config file already matches", () => {
  const changed = input();
  const node = {
    id: "resource:ingress#http-reloaded", kind: "reload-nginx@1", phase: "reconcile",
    ownerRef: "resource:ingress", dependsOn: [], connection: "host",
  } as BuildDeploymentPlanInput["graph"]["nodes"][number];
  changed.graph = { ...changed.graph, nodes: [node], order: [node.id] };
  const plan = buildDeploymentPlan(changed);
  assert.equal(plan.actions[0].operation, "apply");
  assert.equal(plan.actions[0].sideEffecting, true);
});

/** An adoption plan: one unowned provider resource, named as the thing to adopt. */
function adoptInput(observedState: string, adoptionResourceId: string | null = "public-dns"): BuildDeploymentPlanInput {
  const changed = input();
  changed.operation = "adopt";
  changed.adoptionResourceId = adoptionResourceId;
  changed.environment.resources = [{
    id: "public-dns",
    kind: "digitalocean-dns-record@1",
    connection: "dns",
    desired: { zone: "werewolf.solutions", type: "A", name: "todo", valueFrom: { connection: "host", field: "address" }, ttl: 300 },
  }] as BuildDeploymentPlanInput["environment"]["resources"];
  changed.observations = {
    ...changed.observations,
    resources: [{
      id: "public-dns",
      kind: "digitalocean-dns-record@1",
      state: observedState,
      title: "todo.werewolf.solutions",
      detail: observedState === "adopt" ? "A matching unowned DNS record requires explicit adoption" : "No provider record matches",
      observedAt: 1_000,
      fingerprint: "sha256:res",
    }] as BuildDeploymentPlanInput["observations"]["resources"],
  };
  return changed;
}

test("adopting a resource the provider never confirmed is blocked, not planned", () => {
  // "Adopt" binds PSM's ownership to an object it has actually seen. Without a live
  // `adopt` observation there is nothing to bind to, and claiming otherwise would
  // record ownership of a resource nobody looked at.
  const plan = buildDeploymentPlan(adoptInput("missing"));
  assert.equal(plan.blocked, true);
  const stale = plan.document.blockers.find((item) => item.code === "resource-adoption-stale");
  assert.ok(stale, JSON.stringify(plan.document.blockers));
  assert.equal(stale.ownerRef, "resource:public-dns");
});

test("an adoption naming no resource of its own is invalid", () => {
  const plan = buildDeploymentPlan(adoptInput("adopt", null));
  assert.equal(plan.blocked, true);
  assert.ok(plan.document.blockers.some((item) => item.code === "resource-adoption-invalid"), JSON.stringify(plan.document.blockers));
});

test("an observed unowned record is adoptable without an adoption blocker", () => {
  const plan = buildDeploymentPlan(adoptInput("adopt"));
  assert.ok(
    !plan.document.blockers.some((item) => item.code.startsWith("resource-adoption")),
    JSON.stringify(plan.document.blockers),
  );
});

/** One dependency observation, so the digest has a timestamp to be sensitive to. */
function inputWithObservation(at: number, state = "ready", fingerprint = "sha256:dep"): BuildDeploymentPlanInput {
  const changed = input();
  changed.observations = {
    dependencies: [{
      id: "api",
      kind: "http-status@1",
      state: state as BuildDeploymentPlanInput["observations"]["dependencies"][number]["state"],
      title: "api",
      detail: "HTTP 401 in 12ms",
      observedAt: at,
      fingerprint,
    }],
    resources: [],
    watch: [],
    observedAt: at,
  };
  return changed;
}

test("looking again at an unchanged world still produces the approved digest", () => {
  // The runner re-derives the plan at every mutation gate and stops the run
  // unless the digest matches. Observations are re-read there, so a digest that
  // moved with the clock stopped every approved run as if the plan had changed.
  const approved = buildDeploymentPlan(inputWithObservation(1_000));
  const rebuilt = buildDeploymentPlan(inputWithObservation(9_999));
  assert.equal(rebuilt.digest, approved.digest);
});

test("the plan still records when each thing was observed", () => {
  // Dropping the timestamps from the digest must not drop them from the plan:
  // the operator approved a document that says when it was checked.
  const plan = buildDeploymentPlan(inputWithObservation(1_234));
  assert.equal(plan.document.observations.observedAt, 1_234);
  assert.equal(plan.document.observations.dependencies[0].observedAt, 1_234);
});

test("a dependency that is no longer ready is a different plan", () => {
  const approved = buildDeploymentPlan(inputWithObservation(1_000));
  const rebuilt = buildDeploymentPlan(inputWithObservation(1_000, "blocked"));
  assert.notEqual(rebuilt.digest, approved.digest);
});

test("the same state observed on a different underlying thing is a different plan", () => {
  // State alone is too coarse: the fingerprint is what distinguishes "ready"
  // from "ready, but now pointing somewhere else".
  const approved = buildDeploymentPlan(inputWithObservation(1_000));
  const rebuilt = buildDeploymentPlan(inputWithObservation(1_000, "ready", "sha256:moved"));
  assert.notEqual(rebuilt.digest, approved.digest);
});
