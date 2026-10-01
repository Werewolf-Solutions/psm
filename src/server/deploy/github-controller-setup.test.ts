import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import nacl from "tweetnacl";
import { openDatabase } from "../db.ts";
import { SecretBroker } from "./connections.ts";
import { appControllerBundle, gitBlobSha, GitHubControllerSetup } from "./github-controller-setup.ts";
import { DeploymentStore } from "./store.ts";
import type { DeploymentService } from "./service.ts";

const now = 1_790_000_000_000;
const initialHead = "a".repeat(40);
const movedHead = "b".repeat(40);
const targetId = "example:site-staging";
const source = "example/site";
const controller = "example/deployment-control";
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

async function fixture(t: test.TestContext, missing = false, fullApply = false) {
  const database = openDatabase(":memory:"); t.after(() => database.close());
  const store = new DeploymentStore(database); const secretBroker = new SecretBroker();
  const unit = { id: "web", executor: { connection: "github", sourceRepository: source },
    target: { targetId, observerConnection: "host", root: "/var/www/site" } };
  const environment = { risk: "staging", releasePolicy: { allowedBranch: "main" } };
  const context = { projectId: "prj_site", checkoutId: "chk_site", unit, environment };
  const scope = { allowedProjectIds: [context.projectId], allowedEnvironmentIds: ["staging"], maximumAuthorizedRisk: "staging" as const,
    allowedTargetIds: [targetId] };
  const ssh = (user: string) => ({ host: "192.0.2.1", user, port: 22, hostKeyFingerprint: "SHA256:known-host" });
  const add = async (id: string, kind: "github-actions@1" | "ssh-host-helper@1", metadata: Record<string, unknown>, constraints: Record<string, unknown>, slot: string, value: string) => {
    store.createConnection({ connectionId: id, kind, label: id, readiness: "missing-secret", secretGeneration: 0,
      metadata: JSON.parse(JSON.stringify({ publicMetadata: metadata, requiredSecretSlots: [slot] })), constraints: constraints as never, createdAt: now });
    const generation = await secretBroker.put(id, slot, value);
    store.updateConnectionSecretStatus({ connectionId: id, expectedSecretGeneration: 0, secretGeneration: generation, readiness: "ready", updatedAt: now });
  };
  await add("github", "github-actions@1", { revision: 1, githubApp: { id: "42", installationId: "99", owner: "example", slug: "psm-example" },
    githubAppSetup: { accountKind: "organization", controllerRepository: controller }, prepareWorkflows: [], releaseControllers: [] },
  { ...scope, allowedRepositories: [source, controller] }, "appPrivateKey", pem);
  await add("host", "ssh-host-helper@1", { role: "infrastructure", targetContracts: { [targetId]: { revision: "r1", fingerprint: `sha256:${"c".repeat(64)}` } } },
    { ...scope, allowedTargetRootPrefixes: ["/var/www/site"], ssh: ssh("infra") }, "privateKey", "host-key");
  await add("ci", "ssh-host-helper@1", { role: "ci", knownHost: "192.0.2.1 ssh-ed25519 AAAA" },
    { ...scope, allowedTargetRootPrefixes: ["/var/www/site"], ssh: ssh("release") }, "privateKey", "release-key");
  for (const slot of ["github", "host"]) store.bindConnection({ projectId: context.projectId, checkoutId: context.checkoutId,
    environmentId: "staging", slot, connectionId: slot, expectedRevision: null, at: now });
  const service = { store, secretBroker, releaseControllerUnit: () => context, resolveProject: () => ({ id: context.projectId }) } as unknown as DeploymentService;
  let head = initialHead;
  let protectionForbidden: string | null = null;
  let freePlan = false;
  const writers = ["owner"];
  let fileTree: Array<{ path: string; sha: string; mode: string; type: string }> = [];
  const publicKey = Buffer.from(nacl.box.keyPair().publicKey).toString("base64");
  const calls: Array<{ path: string; method: string }> = [];
  const granted = new Map<string, Record<string, string>>();
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname; const method = init?.method || "GET";
    calls.push({ path, method });
    // GitHub files reading an environment and its branch policies under Actions, not Environments.
    const permissions = granted.get(String(new Headers(init?.headers).get("authorization")).replace(/^Bearer /, "")) ?? {};
    if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/environments\/[^/]+(\/deployment-branch-policies)?$/.test(path) && !permissions.actions)
      return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    if (protectionForbidden !== null && path === `/repos/${controller}/branches/main/protection`)
      return Response.json({ message: protectionForbidden }, { status: 403 });
    if (path === `/repos/${controller}/collaborators`)
      return Response.json(writers.map((login) => ({ login, permissions: { pull: true, push: true } })).concat({ login: "reader", permissions: { pull: true, push: false } } as never));
    if (path === "/app/installations/99/access_tokens") {
      const body = JSON.parse(String(init?.body)); const repo = body.repositories[0];
      if (missing && repo === "deployment-control") return Response.json({}, { status: 422 });
      granted.set(`token-${repo}-${calls.length}`, body.permissions);
      return Response.json({ token: `token-${repo}-${calls.length}`, expires_at: new Date(now + 3_600_000).toISOString(),
        repositories: [{ full_name: `example/${repo}` }], permissions: { ...body.permissions, metadata: "read" } });
    }
    if (path === `/repos/${controller}`) return missing ? Response.json({}, { status: 404 }) : Response.json({ default_branch: "main" });
    if (path === `/repos/${controller}/git/ref/heads/main`) return Response.json({ object: { sha: head } });
    if (path === `/repos/${controller}/git/trees/${head}`) return Response.json({ truncated: false, tree: fileTree });
    if (fullApply) {
      if (path === `/repos/${controller}/git/commits/${initialHead}`) return Response.json({ tree: { sha: "c".repeat(40) } });
      if (path === `/repos/${controller}/git/trees` && method === "POST") {
        const body = JSON.parse(String(init?.body));
        fileTree = body.tree.map((entry: { path: string; content: string }) => ({ path: entry.path, sha: gitBlobSha(entry.content), mode: "100644", type: "blob" }));
        return Response.json({ sha: "e".repeat(40) });
      }
      if (path === `/repos/${controller}/git/commits` && method === "POST") return Response.json({ sha: "d".repeat(40) });
      if (path === `/repos/${controller}/git/refs/heads/main` && method === "PATCH") { head = "d".repeat(40); return Response.json({ object: { sha: head } }); }
      if (path === `/repos/${controller}/branches/main/protection`) return method === "GET" ? Response.json({}, { status: 404 }) : Response.json({});
      if (path === `/repos/${controller}/environments/example-site-staging`) {
        if (freePlan && method === "PUT" && JSON.parse(String(init?.body)).deployment_branch_policy)
          return Response.json({ message: "Upgrade to GitHub Pro or make this repository public to enable this feature." }, { status: 422 });
        return Response.json({ protection_rules: [] });
      }
      if (path === `/repos/${controller}/environments/example-site-staging/deployment-branch-policies`)
        return method === "GET" ? Response.json({ branch_policies: [] }) : Response.json({ name: "main", type: "branch" });
      if (path === `/repos/${controller}/environments/example-site-staging/secrets/public-key`) return Response.json({ key_id: "key1", key: publicKey });
      if (path.startsWith(`/repos/${controller}/environments/example-site-staging/secrets/`) && method === "PUT") return new Response(null, { status: 201 });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  const legacy = () => store.createConnection({ connectionId: "legacy-github", kind: "github-actions@1", label: "Previous connection",
    readiness: "ready", secretGeneration: 0, constraints: store.getConnection("github").constraints, createdAt: now,
    metadata: { requiredSecretSlots: ["apiToken"], publicMetadata: { revision: 1, prepareWorkflows: [], releaseControllers: [{
      targetId, repository: controller, ref: "refs/heads/main", githubEnvironment: "site-staging-web",
      workflow: "release-static.yml", workflowPath: ".github/workflows/release-static.yml",
      expectedHeadSha: initialHead,
    }] } } });
  return { setup: new GitHubControllerSetup(service, fetcher, () => now), store, calls, legacy,
    forbidProtection: (message = "Resource not accessible by integration") => { protectionForbidden = message; }, move: () => { head = movedHead; },
    freePlan: () => { freePlan = true; protectionForbidden = "Upgrade to GitHub Pro or make this repository public to enable this feature."; },
    grantPush: (login: string) => { writers.push(login); }, hideMembers: () => { writers.length = 0; } };
}

test("review shows the exact controller files and a changed branch cannot be applied", async (t) => {
  const { setup, store, calls, move } = await fixture(t);
  const preview = await setup.preview("prj_site", "staging");
  assert.equal(preview.head, initialHead);
  assert.equal(preview.changes.length, 3);
  assert.ok(preview.changes.some((change) => change.path === ".github/workflows/release-static.yml" && change.after.includes("secrets.PSM_SOURCE_READ_TOKEN")));
  assert.ok(preview.changes.some((change) => change.path === "targets/example__site-staging.json" && change.after.includes("release")));
  const beforeApply = calls.length;
  move();
  await assert.rejects(setup.apply(preview.id, "prj_site", "staging"), /Controller branch changed/);
  assert.ok(calls.slice(beforeApply).every((call) => call.method === "GET" || call.path.includes("/access_tokens")));
  assert.deepEqual((store.getConnection("github").metadata as any).publicMetadata.releaseControllers, []);
});

test("generated workflow uses only the scoped source token and keeps the release protocol", () => {
  const bundle = appControllerBundle({ targetId, sshUser: "release" });
  const workflow = bundle[".github/workflows/release-static.yml"];
  assert.ok(workflow.includes("secrets.PSM_SOURCE_READ_TOKEN"));
  assert.ok(!workflow.includes("PSM_ARTIFACT_READER_PRIVATE_KEY"));
  assert.ok(!workflow.includes("actions/create-github-app-token"));
  assert.ok(bundle["scripts/psm_controller.py"].includes("psm.werewolf.solutions/static-release-execution/v1"));
});

test("a new organization can preview controller creation before the App can mint a controller token", async (t) => {
  const { setup, calls } = await fixture(t, true);
  const preview = await setup.preview("prj_site", "staging");
  assert.equal(preview.head, null);
  assert.ok(preview.actions[0].includes("Repository is unavailable"));
  assert.ok(calls.every((call) => call.method === "GET" || call.path.includes("/access_tokens")));
});

test("an inaccessible previously configured controller is never offered for creation", async (t) => {
  const { setup, calls, legacy } = await fixture(t, true);
  legacy();
  await assert.rejects(setup.preview("prj_site", "staging"), /cannot access example\/deployment-control.*Manage App repositories.*https:\/\/github\.com\/organizations\/example\/settings\/installations\/99$/);
  assert.ok(calls.every((call) => call.method === "GET" || call.path.includes("/access_tokens")));
});

test("migration to a new App connection retains the previous controller environment", async (t) => {
  const { setup, legacy } = await fixture(t);
  legacy();
  const preview = await setup.preview("prj_site", "staging");
  assert.equal(preview.githubEnvironment, "site-staging-web");
  const target = preview.changes.find((entry) => entry.path === "targets/example__site-staging.json")!;
  assert.equal(JSON.parse(target.after).githubEnvironment, "site-staging-web");
});

test("preview reports inaccessible branch protection before offering setup", async (t) => {
  const { setup, calls, forbidProtection } = await fixture(t);
  forbidProtection();
  await assert.rejects(setup.preview("prj_site", "staging"), /GitHub refused the App access to branch protection.*https:\/\/github\.com\/organizations\/example\/settings\/apps\/psm-example\/permissions/);
  assert.ok(calls.every((call) => call.method === "GET" || call.path.includes("/access_tokens")));
});

test("a private controller on a plan without branch protection is guarded by its pin and reviewed writers", async (t) => {
  // Observed 2026-10-01: a private controller repository in a Free organization, where
  // branch protection and environment branch rules are paid features.
  const { setup, store, calls, freePlan } = await fixture(t, false, true);
  freePlan();
  const preview = await setup.preview("prj_site", "staging");
  assert.deepEqual(preview.writers, ["owner"]);
  assert.ok(preview.actions.some((action) => /refused if anyone other than owner can push/.test(action)), JSON.stringify(preview.actions));
  const result = await setup.apply(preview.id, "prj_site", "staging");
  assert.equal(result.pinned, true);
  assert.ok(!calls.some((call) => call.method === "PUT" && call.path.endsWith("/branches/main/protection")), "no protection is attempted");
  assert.ok(!calls.some((call) => call.method === "POST" && call.path.endsWith("/deployment-branch-policies")));
  const pinned = (store.getConnection("github").metadata as any).publicMetadata.releaseControllers[0];
  assert.equal(pinned.branchProtection, "unavailable-on-plan");
  assert.deepEqual(pinned.reviewedWriters, ["owner"]);
});

test("someone gaining push access after review stops the apply", async (t) => {
  const { setup, calls, freePlan, grantPush } = await fixture(t, false, true);
  freePlan();
  const preview = await setup.preview("prj_site", "staging");
  const beforeApply = calls.length;
  grantPush("newcomer");
  await assert.rejects(setup.apply(preview.id, "prj_site", "staging"), /Push access to example\/deployment-control changed since review \(now: newcomer, owner\)/);
  assert.ok(calls.slice(beforeApply).every((call) => call.method === "GET" || call.path.includes("/access_tokens")));
});

test("apply rechecks branch protection access before changing controller files", async (t) => {
  const { setup, calls, forbidProtection } = await fixture(t, false, true);
  const preview = await setup.preview("prj_site", "staging");
  const beforeApply = calls.length;
  forbidProtection();
  await assert.rejects(setup.apply(preview.id, "prj_site", "staging"), /GitHub refused the App access to branch protection/);
  assert.ok(calls.slice(beforeApply).every((call) => call.method === "GET" || call.path.includes("/access_tokens")));
});

test("apply commits reviewed files, verifies the tree, publishes sealed keys and pins the exact commit", async (t) => {
  const { setup, store, calls } = await fixture(t, false, true);
  const preview = await setup.preview("prj_site", "staging");
  const result = await setup.apply(preview.id, "prj_site", "staging");
  assert.equal(result.headSha, "d".repeat(40));
  assert.equal(result.pinned, true);
  assert.ok(calls.some((call) => call.method === "PUT" && call.path.endsWith("/secrets/PSM_TARGET_SSH_PRIVATE_KEY")));
  const pinned = (store.getConnection("github").metadata as any).publicMetadata.releaseControllers[0];
  assert.equal(pinned.expectedHeadSha, result.headSha);
  assert.equal(pinned.sourceAuthorization, "installation-token");
  assert.equal(pinned.expectedWorkflowBlobSha, gitBlobSha(appControllerBundle({ schema: "psm.werewolf.solutions/control-target/v1",
    targetId, contractRevision: "r1", githubEnvironment: "example-site-staging", sshHost: "192.0.2.1", sshUser: "release",
    sshPort: 22, hostKeyFingerprint: "SHA256:known-host", canonicalRoot: "/var/www/site",
    helperProtocol: "psm.werewolf.solutions/host-helper-request/v1" })[".github/workflows/release-static.yml"]));
});

test("an App that cannot see who can push is refused, never recorded as nobody", async (t) => {
  // Observed 2026-10-01: the App's tokens got an empty collaborator list for a
  // private organization repository, and setup had recorded "nobody" can push.
  const { setup, freePlan, hideMembers } = await fixture(t, false, true);
  freePlan();
  hideMembers();
  await assert.rejects(setup.preview("prj_site", "staging"), (error: Error) => {
    assert.match(error.message, /showed the App nobody who can push/);
    assert.match(error.message, /Members: Read at https:\/\/github\.com\/organizations\/example\/settings\/apps\/psm-example\/permissions/);
    return true;
  });
});
