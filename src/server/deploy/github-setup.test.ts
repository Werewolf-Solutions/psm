import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { openDatabase } from "../db.ts";
import { SecretBroker } from "./connections.ts";
import { GitHubSetup } from "./github-setup.ts";
import { DeploymentStore } from "./store.ts";
import type { DeploymentService } from "./service.ts";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const now = 1_790_000_000_000;
const unit = { executor: { connection: "github", sourceRepository: "example/site", prepareWorkflow: "build-static.yml" },
  target: { targetId: "example:site-staging" } };

function fixture(t: test.TestContext, tokenResult?: Record<string, unknown>) {
  const database = openDatabase(":memory:"); t.after(() => database.close());
  const store = new DeploymentStore(database);
  const secretBroker = new SecretBroker();
  const context = { projectId: "prj_site", checkoutId: "chk_site", unit, environment: { risk: "staging", releasePolicy: { allowedBranch: "main" } } };
  const service = { store, secretBroker, releaseControllerUnit: () => context,
    bindConnection: async (_project: string, environment: string, slot: string, connectionId: string, revision: number | null) =>
      store.bindConnection({ projectId: context.projectId, checkoutId: context.checkoutId, environmentId: environment, slot, connectionId, expectedRevision: revision, at: now }) } as unknown as DeploymentService;
  const calls: Array<{ path: string; body: Record<string, unknown> | null }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path === "/app-manifests/setup-code/conversions") return Response.json({ id: 42, pem, slug: "psm-example", owner: { login: "example" } });
    if (path === "/app/installations") return Response.json([{ id: 99, account: { login: "example" }, suspended_at: null }]);
    if (path === "/app/installations/99/access_tokens") return Response.json(tokenResult ?? {
      token: "token-example-site", expires_at: new Date(now + 3_600_000).toISOString(),
      repositories: [{ full_name: "example/site" }], permissions: { actions: "read", contents: "read", metadata: "read" },
    });
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  return { setup: new GitHubSetup(service, fetcher, () => now), store, secretBroker, calls };
}

test("manifest setup requires the same browser and never returns the App private key", async (t) => {
  const { setup, store, secretBroker, calls } = fixture(t);
  const started = setup.start("prj_site", "staging", { owner: "example", accountKind: "organization", controllerName: "deployment-control" }, "http://127.0.0.1:4317");
  assert.equal(started.manifest.default_permissions.actions, "write");
  assert.equal(started.manifest.redirect_url, "http://127.0.0.1:4317/api/deployment-github/callback");
  assert.deepEqual(started.manifest.hook_attributes, { url: "https://psm.werewolf.solutions/api/deployment-github/events", active: false });
  await assert.rejects(setup.convert(started.state, "setup-code", "other-browser"), /another browser/);
  assert.equal(calls.length, 0);
  const converted = await setup.convert(started.state, "setup-code", started.browserNonce);
  assert.ok(!JSON.stringify(converted).includes("BEGIN PRIVATE KEY"));
  await assert.rejects(setup.convert(started.state, "setup-code", started.browserNonce), /expired/);
  assert.equal(store.getConnection(converted.connectionId).readiness, "missing-secret");
  assert.equal((await secretBroker.status(converted.connectionId, ["appPrivateKey"])).ready, true);
  const installed = await setup.finish(converted.connectionId);
  assert.equal(installed.installationId, "99");
  assert.equal(store.getConnection(converted.connectionId).readiness, "ready");
  assert.equal(store.getConnectionBinding("chk_site", "staging", "github").connectionId, converted.connectionId);
  assert.deepEqual(calls.at(-1)?.body, { repositories: ["site"], permissions: { actions: "read", contents: "read" } });
});

test("installation is refused when GitHub does not narrow its token to the source", async (t) => {
  const { setup, store } = fixture(t, {
    token: "token-too-broad", expires_at: new Date(now + 3_600_000).toISOString(),
    repositories: [{ full_name: "example/site" }, { full_name: "example/other" }],
    permissions: { actions: "read", contents: "read" },
  });
  const started = setup.start("prj_site", "staging", { owner: "example", accountKind: "organization", controllerName: "deployment-control" }, "http://localhost:4317");
  const converted = await setup.convert(started.state, "setup-code", started.browserNonce);
  await assert.rejects(setup.finish(converted.connectionId), /restrict/);
  assert.equal(store.getConnection(converted.connectionId).readiness, "missing-secret");
  assert.throws(() => store.getConnectionBinding("chk_site", "staging", "github"));
});

test("stale GitHub setup cannot overwrite a binding changed during consent", async (t) => {
  const { setup, store } = fixture(t);
  const started = setup.start("prj_site", "staging", { owner: "example", accountKind: "organization", controllerName: "deployment-control" }, "http://localhost:4317");
  const converted = await setup.convert(started.state, "setup-code", started.browserNonce);
  store.createConnection({ connectionId: "other", kind: "github-actions@1", label: "Existing", readiness: "missing-secret", secretGeneration: 0,
    metadata: { requiredSecretSlots: ["apiToken"], publicMetadata: {} },
    constraints: { allowedProjectIds: ["prj_site"], allowedEnvironmentIds: ["staging"], maximumAuthorizedRisk: "staging" }, createdAt: now });
  store.bindConnection({ projectId: "prj_site", checkoutId: "chk_site", environmentId: "staging", slot: "github", connectionId: "other", expectedRevision: null, at: now });
  await assert.rejects(setup.finish(converted.connectionId), /changed during setup/);
  assert.equal(store.getConnectionBinding("chk_site", "staging", "github").connectionId, "other");
});
