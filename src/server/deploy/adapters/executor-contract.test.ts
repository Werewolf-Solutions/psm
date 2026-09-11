import assert from "node:assert/strict";
import test from "node:test";

import {
  ExecutorContractError,
  PREPARE_ARTIFACT_RESULT_SCHEMA,
  RELEASE_EXECUTION_CONTRACT_SCHEMA,
  STATIC_PAYLOAD_ALGORITHM,
  STATIC_RELEASE_RESULT_SCHEMA,
  parsePrepareArtifactResult,
  parseStaticReleaseExecutionContract,
  parseStaticReleaseResult,
  prepareDispatchInputs,
  releaseDispatchInputs,
  releaseExecutionContractDigest,
  validateCommitSha,
  validateDigest,
  validateProviderId,
  validateRepository,
  validateWorkflow,
  type PreparedArtifactIdentity,
  type StaticReleaseExecutionContract,
} from "./executor-contract.ts";

const COMMIT = "a".repeat(40);
const digest = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;
const PAYLOAD = digest("1");
const ARCHIVE = digest("2");

function artifactIdentity(): PreparedArtifactIdentity {
  return {
    psmArtifactId: "art_todo_web_0001",
    githubArtifactId: "778899",
    producerRunId: "112233",
    sourceRepository: "Werewolf-Solutions/todo-app",
    commitSha: COMMIT,
    version: "1.2.3",
    payloadAlgorithm: STATIC_PAYLOAD_ALGORITHM,
    payloadLimits: { maxFiles: 5_000, maxPathBytes: 1_024, maxFileBytes: 20_000_000, maxUnpackedBytes: 200_000_000 },
    payloadDigest: PAYLOAD,
    archiveDigest: ARCHIVE,
  };
}

function executionContract(): StaticReleaseExecutionContract {
  return {
    schema: RELEASE_EXECUTION_CONTRACT_SCHEMA,
    operation: "deploy",
    projectId: "prj_0123456789abcdef0123",
    environmentId: "production",
    unitId: "web",
    target: { id: "werewolf:todo-production-web", fingerprint: digest("3"), contractRevision: "2026-08-01" },
    artifact: artifactIdentity(),
    expectedCurrentRelease: null,
    intendedRelease: { releaseId: "rel_0002", payloadDigest: PAYLOAD },
    plan: { digest: digest("4"), expiresAt: "2026-08-25T12:00:00Z" },
    conditionalRollback: { allowed: false, previousReleaseId: null },
    pm2: { invariant: "unchanged", snapshotDigest: digest("5") },
    probes: [{
      id: "home",
      kind: "http-status@1",
      url: "https://todo.example.com/",
      method: "GET",
      expectedStatuses: [200],
      timeoutMs: 5_000,
    }, {
      id: "served-release",
      kind: "release-metadata@1",
      url: "https://todo.example.com/version.json",
      expectedCommitSha: COMMIT,
      expectedPsmArtifactId: "art_todo_web_0001",
      timeoutMs: 5_000,
    }],
  };
}

function fieldOf(run: () => unknown): string {
  try { run(); } catch (error) {
    assert.ok(error instanceof ExecutorContractError, `expected a contract error, got ${error}`);
    return error.field;
  }
  assert.fail("expected the contract to be rejected");
}

test("field validators accept exact provider identities and reject near misses", () => {
  assert.equal(validateRepository("Werewolf-Solutions/todo-app"), "Werewolf-Solutions/todo-app");
  assert.equal(validateWorkflow("release-static.yml"), "release-static.yml");
  assert.equal(validateCommitSha(COMMIT), COMMIT);
  assert.equal(validateDigest(PAYLOAD, "payloadDigest"), PAYLOAD);
  // A numeric provider ID is normalized to its decimal string, never trusted as identity.
  assert.equal(validateProviderId(778899, "githubArtifactId"), "778899");

  assert.throws(() => validateRepository("Werewolf-Solutions/todo-app.git"), ExecutorContractError);
  assert.throws(() => validateRepository("todo-app"), ExecutorContractError);
  assert.throws(() => validateWorkflow("release-static"), ExecutorContractError);
  assert.throws(() => validateWorkflow("../../etc/passwd.yml"), ExecutorContractError);
  // An abbreviated SHA is exactly the ambiguity a release must never name.
  assert.throws(() => validateCommitSha("a".repeat(7)), ExecutorContractError);
  assert.throws(() => validateCommitSha("A".repeat(40)), ExecutorContractError);
  assert.throws(() => validateDigest("sha1:" + "a".repeat(40), "payloadDigest"), ExecutorContractError);
  assert.throws(() => validateProviderId(0, "githubArtifactId"), ExecutorContractError);
  assert.throws(() => validateProviderId("-1", "githubArtifactId"), ExecutorContractError);
});

test("the execution contract digest is stable and covers every field", () => {
  const contract = executionContract();
  // A golden vector. This identity is written into a plan, a helper receipt and
  // a release result, so changing it silently rebinds all three; a new
  // canonical form needs a new schema ID, not a new expected value here.
  const baseline = "sha256:826dca46e4b1b12d94ca47dadac04aa879cafdb8d971eac7f525be7788a30f9c";
  assert.equal(releaseExecutionContractDigest(contract), baseline);
  assert.equal(releaseExecutionContractDigest(parseStaticReleaseExecutionContract(contract)), baseline);
  // Key order is not identity; the canonical form is.
  const reordered = JSON.parse(JSON.stringify(
    Object.fromEntries(Object.entries(contract).reverse()),
  ));
  assert.equal(releaseExecutionContractDigest(reordered), baseline);

  for (const mutate of [
    (value: StaticReleaseExecutionContract) => { value.operation = "rollback"; },
    (value: StaticReleaseExecutionContract) => { value.target.id = "werewolf:todo-staging-web"; },
    (value: StaticReleaseExecutionContract) => { value.artifact.payloadDigest = digest("6"); },
    (value: StaticReleaseExecutionContract) => { value.artifact.version = "9.9.9"; },
    (value: StaticReleaseExecutionContract) => { value.intendedRelease.releaseId = "rel_0003"; },
    (value: StaticReleaseExecutionContract) => { value.probes[0] = { ...value.probes[0], id: "front-page" }; },
  ]) {
    const changed = executionContract();
    mutate(changed);
    assert.notEqual(releaseExecutionContractDigest(changed), baseline);
  }
});

test("the execution contract fails closed on unknown, missing and incoherent fields", () => {
  assert.equal(fieldOf(() => {
    const value = { ...executionContract() } as Record<string, unknown>;
    value.command = "deploy.sh";
    return parseStaticReleaseExecutionContract(value);
  }), "executionContract.command");

  assert.equal(fieldOf(() => {
    const value = { ...executionContract() } as Record<string, unknown>;
    delete value.pm2;
    return parseStaticReleaseExecutionContract(value);
  }), "executionContract.pm2");

  // Rollback authority and a named previous release must agree, or the executor
  // could be told it may roll back to nothing.
  assert.equal(fieldOf(() => {
    const value = executionContract();
    value.conditionalRollback = { allowed: true, previousReleaseId: null };
    return parseStaticReleaseExecutionContract(value);
  }), "executionContract.conditionalRollback");

  assert.equal(fieldOf(() => {
    const value = executionContract();
    value.probes = [value.probes[0], { ...value.probes[0] }];
    return parseStaticReleaseExecutionContract(value);
  }), "executionContract.probes");

  assert.equal(fieldOf(() => {
    const value = executionContract();
    (value.artifact as { payloadAlgorithm: string }).payloadAlgorithm = "psm-static-tree-sha256@2";
    return parseStaticReleaseExecutionContract(value);
  }), "executionContract.artifact.payloadAlgorithm");
});

test("a probe may not name a private address the executor would reach from inside", () => {
  const value = executionContract();
  value.probes = [{ ...value.probes[0], url: "http://127.0.0.1:8080/" }];
  assert.throws(() => parseStaticReleaseExecutionContract(value), ExecutorContractError);
});

test("prepare dispatch inputs are exact workflow inputs, not free text", () => {
  const inputs = prepareDispatchInputs({
    repository: "Werewolf-Solutions/todo-app",
    workflow: "build-static.yml",
    ref: "refs/heads/master",
    psmRunId: "run_prepare_1",
    psmArtifactId: "art_todo_web_0001",
    projectId: "prj_0123456789abcdef0123",
    environmentId: "production",
    unitId: "web",
    commitSha: COMMIT,
    manifestDigest: digest("7"),
    buildProfile: { id: "production", publicInputs: { VITE_API_BASE: "https://api.example.com/v1" } },
    buildProfileDigest: digest("8"),
  });
  assert.deepEqual(Object.keys(inputs).sort(), [
    "build_profile_digest", "build_profile_json", "commit_sha", "environment_id",
    "manifest_digest", "project_id", "psm_artifact_id", "psm_run_id", "unit_id",
  ]);
  assert.equal(inputs.commit_sha, COMMIT);
  // Canonical JSON, so the digest the workflow re-derives matches ours.
  assert.equal(inputs.build_profile_json, JSON.stringify({ id: "production", publicInputs: { VITE_API_BASE: "https://api.example.com/v1" } }));
});

test("release dispatch refuses a contract whose digest does not match its own bytes", () => {
  const contract = executionContract();
  const dispatch = {
    controller: "werewolf-static@1" as const,
    psmRunId: "run_deploy_1",
    projectId: contract.projectId,
    environmentId: contract.environmentId,
    unitId: contract.unitId,
    releaseId: contract.intendedRelease.releaseId,
    targetId: contract.target.id,
    planDigest: contract.plan.digest,
    planExpiresAt: contract.plan.expiresAt,
    artifact: artifactIdentity(),
    executionContract: contract,
    executionContractDigest: releaseExecutionContractDigest(contract),
  };
  const inputs = releaseDispatchInputs(dispatch);
  assert.equal(inputs.psm_run_id, "run_deploy_1");
  assert.equal(inputs.execution_contract_digest, dispatch.executionContractDigest);

  assert.throws(
    () => releaseDispatchInputs({ ...dispatch, executionContractDigest: digest("9") }),
    ExecutorContractError,
  );

  // The target helper refuses a release without a version, so it travels inside the
  // approved contract rather than being read from a producer-owned file at release time.
  assert.equal(inputs.version, dispatch.artifact.version);
  assert.ok(Object.keys(inputs).length <= 25, "workflow_dispatch accepts at most 25 inputs");
  for (const invalid of ["", "1.2", "v1.2.3", "1.2.3-rc1", "latest"]) {
    const contract = { ...dispatch.executionContract, artifact: { ...dispatch.artifact, version: invalid } };
    assert.throws(
      () => parseStaticReleaseExecutionContract(contract),
      ExecutorContractError,
      `version ${JSON.stringify(invalid)} must be refused`,
    );
  }
  // A contract with no version at all is refused rather than defaulted.
  const { version: _dropped, ...withoutVersion } = dispatch.artifact;
  assert.throws(
    () => parseStaticReleaseExecutionContract({ ...dispatch.executionContract, artifact: withoutVersion }),
    ExecutorContractError,
  );
});

test("a prepare result must correlate with the run that asked for it", () => {
  // The executor speaks snake_case on the wire; PSM's camelCase record is the
  // parse output, never the accepted input.
  const result: Record<string, unknown> = {
    schema: PREPARE_ARTIFACT_RESULT_SCHEMA,
    psm_run_id: "run_prepare_1",
    psm_artifact_id: "art_todo_web_0001",
    project_id: "prj_0123456789abcdef0123",
    environment_id: "production",
    unit_id: "web",
    source_repository: "Werewolf-Solutions/todo-app",
    producer_run_id: "112233",
    github_artifact_id: "778899",
    commit_sha: COMMIT,
    version: "0.5.2",
    manifest_digest: digest("7"),
    build_profile_digest: digest("8"),
    payload_algorithm: STATIC_PAYLOAD_ALGORITHM,
    payload_limits: artifactIdentity().payloadLimits,
    payload_digest: PAYLOAD,
    archive_digest: ARCHIVE,
    retained_until: "2026-09-25T12:00:00Z",
  };
  const parsed = parsePrepareArtifactResult(result);
  assert.equal(parsed.psmArtifactId, "art_todo_web_0001");
  assert.equal(parsed.payloadDigest, PAYLOAD);
  assert.equal(parsed.producerRunId, "112233");

  assert.equal(fieldOf(() => parsePrepareArtifactResult({ ...result, version: "0.5" })), "result.version");
  assert.equal(fieldOf(() => parsePrepareArtifactResult({ ...result, schema: STATIC_RELEASE_RESULT_SCHEMA })), "result.schema");
  assert.equal(fieldOf(() => parsePrepareArtifactResult({ ...result, extra: 1 })), "result.extra");
  // A camelCase result is a different producer, not a lenient one.
  assert.equal(fieldOf(() => parsePrepareArtifactResult({ ...result, psmRunId: "run_prepare_1" })), "result.psmRunId");
});

test("a release result names both digests and an explicit terminal state", () => {
  const result: Record<string, unknown> = {
    schema: STATIC_RELEASE_RESULT_SCHEMA,
    psm_run_id: "run_deploy_1",
    project_id: "prj_0123456789abcdef0123",
    environment_id: "production",
    unit_id: "web",
    release_id: "rel_0002",
    previous_release_id: null,
    plan_digest: digest("4"),
    execution_contract_digest: releaseExecutionContractDigest(executionContract()),
    controller_repository: "Werewolf-Solutions/deployment-control",
    controller_workflow: "release-static.yml",
    controller_ref: "refs/tags/v1.4.0",
    controller_commit_sha: "b".repeat(40),
    provider_run_id: "445566",
    target_id: "werewolf:todo-production-web",
    target_fingerprint: digest("3"),
    target_contract_revision: "2026-08-01",
    psm_artifact_id: "art_todo_web_0001",
    github_artifact_id: "778899",
    producer_run_id: "112233",
    payload_algorithm: STATIC_PAYLOAD_ALGORITHM,
    payload_digest: PAYLOAD,
    archive_digest: ARCHIVE,
    state: "activated",
    activated_at: "2026-08-25T11:59:00Z",
    verification: [{ id: "home", state: "passed", code: "http-status-200" }],
  };
  const parsed = parseStaticReleaseResult(result);
  assert.equal(parsed.state, "activated");
  assert.equal(parsed.payloadDigest, PAYLOAD);
  assert.equal(parsed.previousReleaseId, null);

  assert.equal(fieldOf(() => parseStaticReleaseResult({ ...result, state: "probably-fine" })), "result.state");
  assert.equal(fieldOf(() => parseStaticReleaseResult({ ...result, payload_algorithm: "psm-static-tree-sha256@2" })), "result.payload_algorithm");
  assert.equal(fieldOf(() => parseStaticReleaseResult({ ...result, verification: [{ id: "home", state: "maybe", code: "x" }] })), "result.verification[0].state");
  // A failed release still reports; it simply has no activation time.
  assert.equal(parseStaticReleaseResult({ ...result, state: "failed", activated_at: null }).activatedAt, null);
});
