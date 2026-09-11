import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubActionsAdapter,
  GitHubExecutorError,
  type GitHubActionsConnectionMetadata,
} from "./github.ts";
import {
  RELEASE_EXECUTION_CONTRACT_SCHEMA,
  STATIC_PAYLOAD_ALGORITHM,
  releaseExecutionContractDigest,
  type PreparedArtifactIdentity,
  type ReleaseControllerDispatch,
  type StaticReleaseExecutionContract,
} from "./executor-contract.ts";

const HEAD_SHA = "a".repeat(40);
const BLOB_SHA = "b".repeat(40);
const COMMIT = "c".repeat(40);
const TOKEN = "ghs_thisisaverysecrettokenvalue";
const digest = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

function metadata(): GitHubActionsConnectionMetadata {
  return {
    revision: "2026-08-01",
    prepareWorkflows: [{
      repository: "Werewolf-Solutions/todo-app",
      workflow: "build-static.yml",
      workflowPath: ".github/workflows/build-static.yml",
      refs: [{ ref: "refs/heads/master", expectedWorkflowBlobSha: BLOB_SHA }],
    }],
    releaseControllers: [{
      controller: "werewolf-static@1",
      targetId: "werewolf:todo-production-web",
      repository: "Werewolf-Solutions/deployment-control",
      workflow: "release-static.yml",
      workflowPath: ".github/workflows/release-static.yml",
      ref: "refs/tags/v1.4.0",
      expectedHeadSha: HEAD_SHA,
      expectedWorkflowBlobSha: BLOB_SHA,
      githubEnvironment: "todo-production-web",
      allowedSourceRepositories: ["Werewolf-Solutions/todo-app"],
    }],
  };
}

interface Call { url: string; method: string }

/** A GitHub that answers exactly what the trust check asks for, unless told otherwise. */
function fakeGitHub(overrides: Record<string, { status?: number; body?: unknown; text?: string }> = {}) {
  const calls: Call[] = [];
  const handler = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, method: init?.method ?? "GET" });
    for (const [fragment, reply] of Object.entries(overrides)) {
      if (!href.includes(fragment)) continue;
      const text = reply.text ?? JSON.stringify(reply.body ?? {});
      return new Response(text, { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("/commits/")) {
      return new Response(JSON.stringify({ sha: HEAD_SHA }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("/contents/")) {
      const path = href.includes("release-static")
        ? ".github/workflows/release-static.yml"
        : ".github/workflows/build-static.yml";
      return new Response(JSON.stringify({ type: "file", path, sha: BLOB_SHA }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("/dispatches")) {
      return new Response(JSON.stringify({ workflow_run_id: 445566 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetch: handler };
}

function adapter(github = fakeGitHub(), token: () => string = () => TOKEN) {
  return new GitHubActionsAdapter({ metadata: metadata(), token, fetch: github.fetch, now: () => 1_760_000_000_000 });
}

function prepareDispatch(overrides: Record<string, unknown> = {}) {
  return {
    repository: "Werewolf-Solutions/todo-app",
    workflow: "build-static.yml",
    ref: "refs/heads/master",
    psmRunId: "run_prepare_1",
    psmArtifactId: "art_todo_web_0001",
    projectId: "prj_todo",
    environmentId: "production",
    unitId: "web",
    commitSha: COMMIT,
    version: "1.2.3",
    manifestDigest: digest("7"),
    buildProfile: { id: "production" },
    buildProfileDigest: digest("8"),
    ...overrides,
  } as Parameters<GitHubActionsAdapter["dispatchPrepare"]>[0];
}

function artifactIdentity(sourceRepository = "Werewolf-Solutions/todo-app"): PreparedArtifactIdentity {
  return {
    psmArtifactId: "art_todo_web_0001",
    githubArtifactId: "778899",
    producerRunId: "112233",
    sourceRepository,
    commitSha: COMMIT,
    version: "1.2.3",
    payloadAlgorithm: STATIC_PAYLOAD_ALGORITHM,
    payloadLimits: { maxFiles: 5_000, maxPathBytes: 1_024, maxFileBytes: 20_000_000, maxUnpackedBytes: 200_000_000 },
    payloadDigest: digest("1"),
    archiveDigest: digest("2"),
  };
}

function releaseDispatch(sourceRepository?: string): ReleaseControllerDispatch {
  const artifact = artifactIdentity(sourceRepository);
  const contract: StaticReleaseExecutionContract = {
    schema: RELEASE_EXECUTION_CONTRACT_SCHEMA,
    operation: "deploy",
    projectId: "prj_todo",
    environmentId: "production",
    unitId: "web",
    target: { id: "werewolf:todo-production-web", fingerprint: digest("3"), contractRevision: "2026-08-01" },
    artifact,
    expectedCurrentRelease: null,
    intendedRelease: { releaseId: "rel_0002", payloadDigest: artifact.payloadDigest },
    plan: { digest: digest("4"), expiresAt: "2026-08-25T12:00:00Z" },
    conditionalRollback: { allowed: false, previousReleaseId: null },
    pm2: { invariant: "unchanged", snapshotDigest: digest("5") },
    probes: [],
  };
  return {
    controller: "werewolf-static@1",
    psmRunId: "run_deploy_1",
    projectId: "prj_todo",
    environmentId: "production",
    unitId: "web",
    releaseId: "rel_0002",
    targetId: "werewolf:todo-production-web",
    planDigest: contract.plan.digest,
    planExpiresAt: contract.plan.expiresAt,
    artifact,
    executionContract: contract,
    executionContractDigest: releaseExecutionContractDigest(contract),
  };
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try { await run(); } catch (error) {
    assert.ok(error instanceof GitHubExecutorError, `expected a GitHub executor error, got ${error}`);
    return error.code;
  }
  assert.fail("expected the dispatch to be refused");
}

test("a repository, workflow and ref outside the allowlist never reaches the network", async () => {
  const github = fakeGitHub();
  const kit = adapter(github);

  assert.equal(
    await codeOf(() => kit.dispatchPrepare(prepareDispatch({ repository: "attacker/todo-app" }))),
    "github-target-not-allowed",
  );
  assert.equal(
    await codeOf(() => kit.dispatchPrepare(prepareDispatch({ workflow: "release-anything.yml" }))),
    "github-target-not-allowed",
  );
  assert.equal(
    await codeOf(() => kit.dispatchPrepare(prepareDispatch({ ref: "refs/heads/attacker-branch" }))),
    "github-target-not-allowed",
  );
  assert.equal(github.calls.length, 0, "the allowlist is checked before any request is made");
});

test("a ref that no longer resolves to its pinned commit is not dispatched", async () => {
  const github = fakeGitHub({ "/commits/": { body: { sha: "d".repeat(40) } } });
  const kit = adapter(github);

  assert.equal(await codeOf(() => kit.dispatchRelease(releaseDispatch())), "github-run-mismatch");
  assert.equal(github.calls.filter((call) => call.url.includes("/dispatches")).length, 0);
});

test("a workflow file whose blob changed under a pinned tag is not dispatched", async () => {
  const github = fakeGitHub({
    "/contents/": { body: { type: "file", path: ".github/workflows/release-static.yml", sha: "e".repeat(40) } },
  });
  const kit = adapter(github);

  assert.equal(await codeOf(() => kit.dispatchRelease(releaseDispatch())), "github-run-mismatch");
  assert.equal(github.calls.filter((call) => call.url.includes("/dispatches")).length, 0);
});

test("GitHub returning a different file than the allowlisted path is refused", async () => {
  const github = fakeGitHub({
    "/contents/": { body: { type: "file", path: ".github/workflows/something-else.yml", sha: BLOB_SHA } },
  });
  assert.equal(await codeOf(() => adapter(github).dispatchRelease(releaseDispatch())), "github-response-invalid");
});

test("a release may only carry an artifact from an allowlisted source repository", async () => {
  const github = fakeGitHub();
  assert.equal(
    await codeOf(() => adapter(github).dispatchRelease(releaseDispatch("attacker/todo-app"))),
    "github-target-not-allowed",
  );
  assert.equal(github.calls.length, 0);
});

test("a verified dispatch returns a receipt carrying the exact trust pins", async () => {
  const github = fakeGitHub();
  const receipt = await adapter(github).dispatchRelease(releaseDispatch());

  assert.equal(receipt.schema, "psm.werewolf.solutions/github-dispatch-receipt/v1");
  assert.equal(receipt.operation, "release");
  assert.equal(receipt.repository, "Werewolf-Solutions/deployment-control");
  assert.equal(receipt.ref, "refs/tags/v1.4.0");
  assert.equal(receipt.expectedHeadSha, HEAD_SHA);
  assert.equal(receipt.workflowBlobSha, BLOB_SHA);
  assert.equal(receipt.githubEnvironment, "todo-production-web");
  assert.equal(receipt.providerRunId, "445566");
  assert.equal(receipt.policyRevision, "2026-08-01");
  // Trust is established before the dispatch, never after it.
  const order = github.calls.map((call) => call.url.includes("/dispatches") ? "dispatch" : "verify");
  assert.deepEqual(order, ["verify", "verify", "dispatch"]);
});

test("a provider error message can never carry the token back to a caller", async () => {
  const github = fakeGitHub({
    "/commits/": { status: 403, body: { message: `Bad credentials for ${TOKEN}` } },
  });
  try {
    await adapter(github).dispatchRelease(releaseDispatch());
    assert.fail("expected the request to fail");
  } catch (error) {
    assert.ok(error instanceof GitHubExecutorError);
    assert.equal(error.code, "github-api-error");
    assert.ok(!error.message.includes(TOKEN), `token leaked into: ${error.message}`);
    assert.ok(!JSON.stringify(error).includes(TOKEN));
  }
});

test("an unusable token fails before any request is attempted", async () => {
  const github = fakeGitHub();
  const kit = adapter(github, () => "");
  assert.equal(await codeOf(() => kit.dispatchRelease(releaseDispatch())), "github-config-invalid");
  assert.equal(github.calls.length, 0);
});

test("an oversized provider response is refused rather than parsed", async () => {
  const github = fakeGitHub({ "/commits/": { text: `{"sha":"${HEAD_SHA}","padding":"${"x".repeat(600 * 1024)}"}` } });
  assert.equal(await codeOf(() => adapter(github).dispatchRelease(releaseDispatch())), "github-response-too-large");
});

test("a dispatch that returns no usable run ID is an invalid response, not a success", async () => {
  const github = fakeGitHub({ "/dispatches": { body: { workflow_run_id: "not-a-number" } } });
  assert.equal(await codeOf(() => adapter(github).dispatchRelease(releaseDispatch())), "github-response-invalid");
});
