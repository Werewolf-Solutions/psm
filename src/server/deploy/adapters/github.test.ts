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
