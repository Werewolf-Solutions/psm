import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubActionsAdapter,
  GitHubExecutorError,
  RELEASE_TARGET_STEP,
  type GitHubActionsConnectionMetadata,
} from "./github.ts";
import {
  PREPARE_ARTIFACT_RESULT_SCHEMA,
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

test("receiptless release recovery searches the complete GitHub submission window", async () => {
  const submittedAt = 1_760_000_000_000 - 60 * 60_000;
  const path = "/actions/workflows/release-static.yml/runs?";
  const run = (id: number, title: string, createdAt = submittedAt + 1_000) => ({
    id, display_title: title, created_at: new Date(createdAt).toISOString(),
  });
  const search = (workflow_runs: unknown[]) => adapter(fakeGitHub({ [path]: { body: { total_count: workflow_runs.length, workflow_runs } } }));
  const target = "werewolf:todo-production-web";
  const psmRun = "run_deploy_1";
  assert.equal(await search([run(4, "release unrelated", submittedAt - 20_000)]).findReleaseRunByCorrelation(target, psmRun, submittedAt), null);
  assert.equal(await search([run(4, `release ${psmRun} to ${target}`)]).findReleaseRunByCorrelation(target, psmRun, submittedAt), "4");
  assert.equal(await codeOf(() => search([run(4, "release-static")]).findReleaseRunByCorrelation(target, psmRun, submittedAt)), "github-run-unsettled");
  assert.equal(await codeOf(() => adapter(fakeGitHub({ [path]: { body: { total_count: 2, workflow_runs: [run(4, "release unrelated")] } } }))
    .findReleaseRunByCorrelation(target, psmRun, submittedAt)), "github-run-unsettled");
  const firstPage = Array.from({ length: 100 }, (_, index) => run(index + 1, "release unrelated", submittedAt + 20 * 60_000));
  const paged = adapter(fakeGitHub({
    [`${path}event=workflow_dispatch&per_page=100&page=1`]: { body: { total_count: 101, workflow_runs: firstPage } },
    [`${path}event=workflow_dispatch&per_page=100&page=2`]: { body: { total_count: 101, workflow_runs: [run(999, `release ${psmRun}`)] } },
  }));
  assert.equal(await paged.findReleaseRunByCorrelation(target, psmRun, submittedAt), "999");
  assert.equal(await codeOf(() => search([run(4, `release ${psmRun}`), run(5, `release ${psmRun}`)]).findReleaseRunByCorrelation(target, psmRun, submittedAt)), "github-run-ambiguous");
  assert.equal(await codeOf(() => search([]).findReleaseRunByCorrelation(target, psmRun, 1_760_000_000_000 - 1_000)), "github-run-unsettled");
});

test("an unpinned release controller is rejected locally before contacting GitHub", () => {
  const github = fakeGitHub();
  const policy = metadata();
  policy.releaseControllers = [];
  const kit = new GitHubActionsAdapter({ metadata: policy, token: () => TOKEN, fetch: github.fetch });
  assert.match(kit.releaseDispatchPolicyRejection(releaseDispatch()) || "", /not allowlisted/);
  assert.equal(github.calls.length, 0);
  assert.equal(adapter().releaseDispatchPolicyRejection(releaseDispatch()), null);
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

test("controller credentials go only to the pinned controller's environment, sealed to GitHub's key", async () => {
  const nacl = (await import("tweetnacl")).default;
  const { blake2b } = await import("../sealed-box.ts");
  const recipient = nacl.box.keyPair();
  const bodies = new Map<string, unknown>();
  const calls: Call[] = [];
  let created = false;
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: href, method });
    if (init?.body) bodies.set(`${method} ${new URL(href).pathname}`, JSON.parse(String(init.body)));
    const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (href.endsWith("/environments/todo-production-web") && method === "PUT") { created = true; return reply(200, { name: "todo-production-web" }); }

    if (href.endsWith("/secrets/public-key") && !created) return reply(404, { message: "Not Found" });
    if (href.endsWith("/secrets/public-key")) return reply(200, { key_id: "k1", key: Buffer.from(recipient.publicKey).toString("base64") });
    if (href.includes("/secrets/PSM_") && method === "PUT") return reply(201, {});
    if (href.includes("/secrets?per_page")) return reply(200, { total_count: 1, secrets: [{ name: "PSM_TARGET_KNOWN_HOSTS" }] });
    return reply(404, { message: "Not Found" });
  }) as unknown as typeof fetch;
  const github = new GitHubActionsAdapter({ metadata: metadata(), token: () => TOKEN, fetch: fetchStub });

  const published = await github.publishEnvironmentSecrets("werewolf:todo-production-web", { PSM_TARGET_SSH_PRIVATE_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n", PSM_TARGET_KNOWN_HOSTS: "203.0.113.4 ssh-ed25519 AAAA\n" });
  assert.deepEqual(published, { repository: "Werewolf-Solutions/deployment-control", environment: "todo-production-web", names: ["PSM_TARGET_KNOWN_HOSTS", "PSM_TARGET_SSH_PRIVATE_KEY"] });
  assert.ok(calls.every((call) => call.url.startsWith("https://api.github.com/repos/Werewolf-Solutions/deployment-control/environments/todo-production-web")));
  const sent = bodies.get("PUT /repos/Werewolf-Solutions/deployment-control/environments/todo-production-web/secrets/PSM_TARGET_SSH_PRIVATE_KEY") as { encrypted_value: string; key_id: string };
  assert.equal(sent.key_id, "k1");
  const sealed = Buffer.from(sent.encrypted_value, "base64");
  const ephemeral = sealed.subarray(0, 32);
  const opened = nacl.box.open(sealed.subarray(32), blake2b(new Uint8Array([...ephemeral, ...recipient.publicKey]), 24), ephemeral, recipient.secretKey);
  assert.equal(Buffer.from(opened!).toString("utf8"), "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n");
  assert.ok(!JSON.stringify([...bodies.values()]).includes("BEGIN OPENSSH"), "no plaintext leaves PSM");

  assert.deepEqual(await github.listEnvironmentSecretNames("werewolf:todo-production-web"), ["PSM_TARGET_KNOWN_HOSTS"]);
  const refusing = new GitHubActionsAdapter({ metadata: metadata(), token: () => TOKEN, fetch: (async (url: string | URL | Request, init?: RequestInit) =>
    String(url).endsWith("/secrets/public-key") ? new Response(JSON.stringify({ key_id: "k1", key: Buffer.from(recipient.publicKey).toString("base64") }), { status: 200 })
      : new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403 })) as unknown as typeof fetch });
  await assert.rejects(refusing.publishEnvironmentSecrets("werewolf:todo-production-web", { PSM_TARGET_KNOWN_HOSTS: "x" }),
    /Writing PSM_TARGET_KNOWN_HOSTS: GitHub API 403: Resource not accessible by personal access token\. The token needs Environments: read and write on Werewolf-Solutions\/deployment-control\./);
  await assert.rejects(github.publishEnvironmentSecrets("werewolf:other", { PSM_X: "1" }), (error: GitHubExecutorError) => error.code === "github-target-not-allowed");
  await assert.rejects(github.publishEnvironmentSecrets("werewolf:todo-production-web", { GITHUB_TOKEN: "1" }), (error: GitHubExecutorError) => error.code === "github-config-invalid");
});

test("the controller's target file is read at the pinned commit", async () => {
  const file = { schema: "psm.werewolf.solutions/control-target/v1", sshUser: "psm-r-todo" };
  const github = fakeGitHub({ "/contents/targets/": { body: { content: Buffer.from(JSON.stringify(file)).toString("base64") } } });
  assert.deepEqual(await adapter(github).readControllerJson("werewolf:todo-production-web", "targets/werewolf__todo-production-web.json"), file);
  assert.ok(github.calls.at(-1)!.url.endsWith(`/contents/targets/werewolf__todo-production-web.json?ref=${HEAD_SHA}`));
  await assert.rejects(adapter(github).readControllerJson("werewolf:todo-production-web", "../secrets.json"), /Unexpected controller file path/);
});

test("a branch saved by name allows its full ref, and nothing else", async () => {
  const saved = metadata();
  const named = { ...saved, prepareWorkflows: [{ ...saved.prepareWorkflows[0], refs: [{ ref: "master" }] }] };
  const github = fakeGitHub();
  const kit = new GitHubActionsAdapter({ metadata: named, token: () => TOKEN, fetch: github.fetch, now: () => 1_760_000_000_000 });
  assert.equal(await codeOf(() => kit.dispatchPrepare(prepareDispatch({ ref: "refs/heads/masterx" }))), "github-target-not-allowed");
  assert.equal(await codeOf(() => kit.dispatchPrepare(prepareDispatch({ ref: "refs/tags/master" }))), "github-target-not-allowed");
  assert.equal(github.calls.length, 0);
  // The full ref of the saved branch passes the allowlist and reaches GitHub.
  await kit.dispatchPrepare(prepareDispatch({ ref: "refs/heads/master" })).catch(() => undefined);
  assert.ok(github.calls.length > 0, "an allowlisted dispatch makes requests");
  assert.ok(github.calls.some((call) => call.url.includes("/commits/master")));
});

test("a run named by its dispatch may carry GitHub's placeholder title until it finishes", async () => {
  // Shape of GitHub's response for a just-dispatched run: named after the workflow
  // until run-name is evaluated (observed 2026-09-25, run 36110086343).
  const run = (overrides: Record<string, unknown>) => ({
    id: 36110086343, head_sha: "9450ccedb9ba08493a6461ab930467ad0ea07625", path: ".github/workflows/build-static.yml",
    event: "workflow_dispatch", repository: { full_name: "Werewolf-Solutions/todo-app" }, created_at: "2026-09-25T07:54:47Z",
    display_title: "Prepare managed static artifact", status: "queued", conclusion: null, run_attempt: 1, head_branch: "master",
    html_url: "https://github.com/Werewolf-Solutions/todo-app/actions/runs/36110086343", updated_at: "2026-09-25T07:54:47Z", ...overrides,
  });
  const kit = (body: unknown) => new GitHubActionsAdapter({
    metadata: { revision: 2, prepareWorkflows: [{ repository: "Werewolf-Solutions/todo-app", workflow: "build-static.yml", workflowPath: ".github/workflows/build-static.yml", refs: [{ ref: "master" }] }], releaseControllers: [] },
    token: () => TOKEN, fetch: (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch,
  });
  const receipt = {
    schema: "psm.werewolf.solutions/github-dispatch-receipt/v1", policyRevision: "2", operation: "prepare", repository: "Werewolf-Solutions/todo-app",
    workflow: "build-static.yml", workflowPath: ".github/workflows/build-static.yml", ref: "master", expectedHeadSha: "9450ccedb9ba08493a6461ab930467ad0ea07625",
    workflowBlobSha: "74bbf26a03266af77bd428451d5f20df048e02b5", psmRunId: "run_b5c3cc107bdd46e7", dispatchedAt: "2026-09-25T07:54:46.503Z",
    providerRunId: "36110086343", controller: null, targetId: null, githubEnvironment: null,
  } as never;
  assert.equal((await kit(run({})).pollRun(receipt)).run?.status, "queued", "a queued run with the placeholder is still being watched");
  assert.equal((await kit(run({ status: "in_progress" })).pollRun(receipt)).run?.status, "in-progress");
  assert.equal((await kit(run({ status: "completed", conclusion: "success", display_title: "prepare run_b5c3cc107bdd46e7" })).pollRun(receipt)).run?.conclusion, "success");
  // GitHub's own answer to the dispatch names the run, so a finished run keeps that
  // identity even when the workflow's run-name omits the PSM run (observed 2026-09-28,
  // run 36436534674). Any other identity differing is still refused.
  assert.equal((await kit(run({ status: "completed", conclusion: "failure" })).pollRun(receipt)).run?.conclusion, "failure");
  await assert.rejects(kit(run({ head_sha: "a".repeat(40) })).pollRun(receipt), (error: GitHubExecutorError) => error.code === "github-run-mismatch");
  await assert.rejects(kit(run({ id: 999 })).pollRun(receipt), (error: GitHubExecutorError) => error.code === "github-run-mismatch");
});

test("prepared artifacts import across branch spellings while identity checks stay strict", async () => {
  for (const [allowed, requested] of [["master", "refs/heads/master"], ["refs/heads/master", "master"], ["refs/heads/master", "refs/heads/master"]]) {
    const dispatch = prepareDispatch({ ref: requested, commitSha: HEAD_SHA });
    const run = {
      id: 445566, head_sha: HEAD_SHA, path: ".github/workflows/build-static.yml",
      event: "workflow_dispatch", repository: { full_name: dispatch.repository },
      display_title: `prepare ${dispatch.psmRunId}`, status: "completed", conclusion: "success",
      run_attempt: 1, head_branch: "master", created_at: "2025-10-09T08:53:20Z", updated_at: "2025-10-09T08:54:20Z",
    };
    const github = fakeGitHub({
      "/actions/runs/445566/artifacts": { body: { artifacts: [{
        id: 778899, name: dispatch.psmArtifactId, expired: false, size_in_bytes: 1024,
        expires_at: "2027-01-01T00:00:00Z", workflow_run: { id: 445566, head_sha: HEAD_SHA },
      }] } },
      "/actions/runs/445566": { body: run },
    });
    const saved = metadata();
    saved.prepareWorkflows = [{ ...saved.prepareWorkflows[0], refs: [{ ref: allowed, expectedWorkflowBlobSha: BLOB_SHA }] }];
    const kit = new GitHubActionsAdapter({ metadata: saved, token: () => TOKEN, fetch: github.fetch, now: () => 1_760_000_000_000 });
    const receipt = await kit.dispatchPrepare(dispatch);
    assert.equal(receipt.ref, allowed, "receipt keeps the policy's spelling");
    const result = {
      schema: PREPARE_ARTIFACT_RESULT_SCHEMA,
      psm_run_id: dispatch.psmRunId, psm_artifact_id: dispatch.psmArtifactId,
      project_id: dispatch.projectId, environment_id: dispatch.environmentId, unit_id: dispatch.unitId,
      source_repository: dispatch.repository, producer_run_id: "445566", github_artifact_id: "778899",
      commit_sha: HEAD_SHA, version: "1.2.3", manifest_digest: dispatch.manifestDigest,
      build_profile_digest: dispatch.buildProfileDigest, payload_algorithm: STATIC_PAYLOAD_ALGORITHM,
      payload_limits: artifactIdentity().payloadLimits, payload_digest: digest("1"), archive_digest: digest("2"),
      retained_until: "2027-01-01T00:00:00Z",
    };
    const imported = await kit.importPreparedArtifact(receipt, dispatch, result);
    assert.equal(imported.githubArtifactId, "778899");
    assert.equal(imported.provider.runId, "445566");
    const { provider, ...legacy } = imported;
    const compatible = await kit.importPreparedArtifact(receipt, dispatch, legacy);
    assert.deepEqual(compatible.provider, provider, "legacy field spelling preserves provider verification");
    for (const wrong of [{ commitSha: COMMIT }, { psmRunId: "run_other" }, { githubArtifactId: "999999" }]) {
      await assert.rejects(kit.importPreparedArtifact(receipt, dispatch, { ...legacy, ...wrong }),
        (error: GitHubExecutorError) => error.code === "artifact-integrity");
    }
    for (const wrong of [{ ref: "refs/tags/master" }, { ref: "refs/heads/other" }]) {
      await assert.rejects(kit.importPreparedArtifact(receipt, { ...dispatch, ...wrong }, result),
        (error: GitHubExecutorError) => error.code === "github-target-not-allowed");
    }
    for (const wrong of [{ commitSha: COMMIT }, { psmRunId: "run_other" }]) {
      await assert.rejects(kit.importPreparedArtifact(receipt, { ...dispatch, ...wrong }, result),
        /Prepare receipt does not match its dispatch/);
    }
    await assert.rejects(kit.importPreparedArtifact({ ...receipt, ref: "refs/tags/master" }, dispatch, result),
      /Prepare receipt does not match its dispatch/);
    for (const wrong of [{ commit_sha: COMMIT }, { psm_run_id: "run_other" }, { github_artifact_id: "999999" }]) {
      await assert.rejects(kit.importPreparedArtifact(receipt, dispatch, { ...result, ...wrong }),
        (error: GitHubExecutorError) => error.code === "artifact-integrity");
    }
  }
});

test("a failed release run proves it never reached the target only by a skipped target step", async () => {
  const receipt = {
    schema: "psm.werewolf.solutions/github-dispatch-receipt/v1", policyRevision: "2", operation: "release", repository: "Werewolf-Solutions/deployment-control",
    workflow: "release-static.yml", workflowPath: ".github/workflows/release-static.yml", ref: "refs/heads/main", expectedHeadSha: "c642f128d7103d5e3aaf3806749b3e925eeb1ad6",
    workflowBlobSha: "86f6a35672088bd9bb00da3f646c7b32a882bdb4", psmRunId: "run_e19a8daa9f8d4e57", dispatchedAt: "2026-09-28T14:30:49.214Z",
    providerRunId: "36436534674", controller: "werewolf-static@1", targetId: "werewolf:todo-staging-web", githubEnvironment: "todo-staging-web",
  } as never;
  const run = {
    id: 36436534674, head_sha: "c642f128d7103d5e3aaf3806749b3e925eeb1ad6", path: ".github/workflows/release-static.yml", event: "workflow_dispatch",
    repository: { full_name: "Werewolf-Solutions/deployment-control" }, created_at: "2026-09-28T14:30:47Z", updated_at: "2026-09-28T14:31:08Z",
    display_title: "release release_artifact_917da4d6407541cf9105feeb to werewolf:todo-staging-web", status: "completed", conclusion: "failure",
    run_attempt: 1, head_branch: "main",
  };
  const step = (name: string, conclusion: string) => ({ name, status: "completed", conclusion });
  const kit = (jobs: unknown[]) => new GitHubActionsAdapter({
    metadata: { revision: 2, prepareWorkflows: [], releaseControllers: [{
      controller: "werewolf-static@1", targetId: "werewolf:todo-staging-web", repository: "Werewolf-Solutions/deployment-control",
      workflow: "release-static.yml", workflowPath: ".github/workflows/release-static.yml", ref: "refs/heads/main",
      expectedHeadSha: "c642f128d7103d5e3aaf3806749b3e925eeb1ad6", expectedWorkflowBlobSha: "86f6a35672088bd9bb00da3f646c7b32a882bdb4",
      githubEnvironment: "todo-staging-web", allowedSourceRepositories: ["Werewolf-Solutions/todo-app"],
    }] } as never,
    token: () => TOKEN,
    fetch: (async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("/jobs") ? { jobs } : run), { status: 200 })) as unknown as typeof fetch,
  });
  const contract = { name: "contract", conclusion: "success", steps: [step("Verify the execution contract and resolve the target", "success")] };
  // Shape of run 36436534674: the token step failed and the target step was skipped.
  const stopped = { name: "release", conclusion: "failure", steps: [step("Mint a short-lived source-repository token", "failure"), step(RELEASE_TARGET_STEP, "skipped")] };
  assert.deepEqual(await kit([contract, stopped]).releaseTargetStep(receipt), { reached: false, stoppedAt: "Mint a short-lived source-repository token" });
  assert.equal((await kit([{ ...contract, conclusion: "failure" }, { name: "release", conclusion: "skipped", steps: [] }]).releaseTargetStep(receipt)).reached, false);
  // The target step ran, or the job data does not prove it did not: the effect stays uncertain.
  assert.equal((await kit([contract, { name: "release", conclusion: "failure", steps: [step(RELEASE_TARGET_STEP, "failure")] }]).releaseTargetStep(receipt)).reached, true);
  assert.equal((await kit([contract, { name: "release", conclusion: "failure", steps: [] }]).releaseTargetStep(receipt)).reached, true);

  // A step whose stored receipt was lost is found again by GitHub's run id, but only
  // when the run's title names the PSM run (observed 2026-09-28, run 36443918468).
  const failedInTarget = { name: "release", conclusion: "failure", steps: [step(RELEASE_TARGET_STEP, "failure")] };
  Object.assign(run, { display_title: "release run_042a09b37a534682 release_artifact_917da4d6407541cf9105feeb to werewolf:todo-staging-web" });
  const found = await kit([contract, failedInTarget]).releaseRunById("werewolf:todo-staging-web", "36436534674", "run_042a09b37a534682");
  assert.deepEqual({ completed: found.completed, conclusion: found.conclusion, reached: found.reached }, { completed: true, conclusion: "failure", reached: true });
  await assert.rejects(
    kit([contract, failedInTarget]).releaseRunById("werewolf:todo-staging-web", "36436534674", "run_somebody_else"),
    (error: GitHubExecutorError) => error.code === "github-run-mismatch",
  );
  Object.assign(run, { head_sha: "0".repeat(40) });
  await assert.rejects(
    kit([contract, failedInTarget]).releaseRunById("werewolf:todo-staging-web", "36436534674", "run_042a09b37a534682"),
    (error: GitHubExecutorError) => error.code === "github-run-mismatch",
  );
});
