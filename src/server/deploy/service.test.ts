import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase } from "../db.ts";
import { SecretBroker } from "./connections.ts";
import { canonicalDigest } from "./canonical.ts";
import { DeploymentService } from "./service.ts";
import { DeploymentStore } from "./store.ts";

const TODO = "prj_0123456789abcdefabcd";
const DAPP = "prj_abcdef0123456789abcd";

/** A real checkout: `loadCurrent` reads the committed manifest, so a fixture needs git. */
function repository(projectId: string, name: string, dependencies: unknown[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `psm-deploy-service-${name}-`));
  fs.mkdirSync(path.join(root, ".psm"));
  fs.writeFileSync(
    path.join(root, ".psm", "identity.json"),
    JSON.stringify({ version: 1, id: projectId, name, createdAt: 1 }) + "\n",
  );
  fs.writeFileSync(path.join(root, ".psm", "deployments.json"), JSON.stringify({
    apiVersion: "psm.werewolf.solutions/deployments/v1",
    kind: "DeploymentManifest",
    projectId,
    environments: [{
      id: "production",
      risk: "production",
      releasePolicy: { allowedBranch: "master", requireReachableFromBranch: true, requireChecks: true, approval: "authenticated-local-operator" },
      connections: {
        github: { kind: "github-actions@1" },
        dns: { kind: "digitalocean-api@1" },
        infrastructure: { kind: "ssh-host-helper@1" },
      },
      dependencies,
      resources: [{
        id: "public-dns",
        kind: "digitalocean-dns-record@1",
        connection: "dns",
        desired: { zone: "example.com", type: "A", name, valueFrom: { connection: "infrastructure", field: "address" }, ttl: 300 },
      }, {
        id: "tls",
        kind: "letsencrypt-certificate@1",
        connection: "infrastructure",
        dependsOn: ["resource:public-dns", "resource:ingress#http-ready"],
        desired: { hostname: `${name}.example.com`, renewal: "automatic" },
      }, {
        id: "site-directory",
        kind: "host-release-directory@1",
        connection: "infrastructure",
        desired: { root: `/var/www/${name}.example.com/`, retainReleases: 5 },
      }, {
        id: "ingress",
        kind: "nginx-static-site@1",
        connection: "infrastructure",
        dependsOn: ["resource:site-directory", "resource:public-dns"],
        desired: {
          hostname: `${name}.example.com`,
          documentRoot: `/var/www/${name}.example.com/current/`,
          spaFallback: true,
          denyPrefixes: ["/api/"],
          cachePolicy: "vite-hashed",
          securityHeaders: "werewolf-static-spa@1",
        },
      }],
      units: [{
        id: "web",
        recipe: "static-ssh-nginx@1",
        resourceRefs: ["resource:public-dns", "resource:site-directory", "resource:ingress", "resource:tls"],
        artifact: { kind: "static-files@1", output: "./dist", buildProfile: { id: "production", publicInputs: {} } },
        executor: {
          kind: "github-actions@1",
          connection: "github",
          sourceRepository: `Werewolf-Solutions/${name}`,
          prepareWorkflow: "build-static.yml",
          releaseController: "werewolf-static@1",
        },
        target: {
          kind: "ssh-release-directory@1",
          targetId: `werewolf:${name}-production-web`,
          observerConnection: "infrastructure",
          root: `/var/www/${name}.example.com/`,
        },
        verification: [{
          id: "home",
          kind: "http-status@1",
          request: { url: `https://${name}.example.com`, method: "GET" },
          expect: { status: 200 },
        }],
      }],
      watch: [],
      policy: { planTtlSeconds: 600, rollbackOnVerificationFailure: true, allowDelete: false, requireFreshWatchBeforeRelease: false },
    }],
  }) + "\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, version: "0.1.0" }) + "\n");
  execFileSync("git", ["-C", root, "init", "-q", "-b", "master"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "initial"]);
  return root;
}

function service(projects: { id: string; name: string; path: string }[]) {
  const store = new DeploymentStore(openDatabase(":memory:"));
  return {
    store,
    service: new DeploymentService({
      store,
      secretBroker: new SecretBroker({
        generations: { readGeneration: async () => 0, writeGeneration: async () => {} },
        fingerprintKey: new Uint8Array(32),
      }),
      projects: () => projects as never,
      githubConnectionDefaults: async () => ({}),
    }),
  };
}

/** todo-app waits on werewolf-dapp; the dapp waits on nobody. */
test("deployment source distinguishes an uncommitted version bump and follows its commit immediately", async (t) => {
  const root = repository(TODO, "todo-app", []);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const kit = service([{ id: TODO, name: "todo-app", path: root }]);
  const initial = await kit.service.environmentView(TODO, "production");
  assert.equal((initial.source as any).version, "0.1.0");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "todo-app", version: "0.1.1" }) + "\n");
  const pending = await kit.service.environmentView(TODO, "production");
  assert.equal((pending.source as any).version, "0.1.0", "artifacts must still use committed source");
  assert.equal((pending.source as any).workingTreeVersion, "0.1.1");
  assert.equal((pending.source as any).proposedVersion, "0.1.1");
  assert.equal((pending.source as any).inputsDirty, true);
  assert.match((pending.blockers as any[]).find((item) => item.code === "source-dirty").message, /Working files are 0.1.1; committed source is 0.1.0/);
  await assert.rejects(kit.service.artifactPreparationContext(TODO, "production"), /deployment inputs differ/);
  execFileSync("git", ["-C", root, "add", "package.json"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "Bump fixture version"]);
  const committed = await kit.service.environmentView(TODO, "production");
  assert.equal((committed.source as any).version, "0.1.1");
  assert.equal((committed.source as any).workingTreeVersion, "0.1.1");
  assert.equal((committed.source as any).proposedVersion, null);
  assert.equal((committed.source as any).inputsDirty, false);
  assert.ok(!(committed.blockers as any[]).some((item) => item.code === "source-dirty"));
});

test("dirty source previews a higher version before package.json is bumped", async (t) => {
  const root = repository(TODO, "todo-app", []);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "feature.js"), "export const feature = true;\n");
  const kit = service([{ id: TODO, name: "todo-app", path: root }]);
  const view = await kit.service.environmentView(TODO, "production");
  assert.equal((view.source as any).workingTreeVersion, "0.1.0");
  assert.equal((view.source as any).proposedVersion, "0.1.1");
  assert.equal((view.source as any).version, "0.1.0");
});

function workspace() {
  const todo = repository(TODO, "todo-app", [
    { id: "dapp-api", kind: "http-status@1", projectId: DAPP, request: { url: "https://api.example.com/todo", method: "GET" }, expect: { status: 401 } },
    { id: "own-health", kind: "http-status@1", request: { url: "https://todo.example.com/health", method: "GET" }, expect: { status: 200 } },
  ]);
  const dapp = repository(DAPP, "werewolf-dapp", []);
  return {
    ...service([
      { id: TODO, name: "todo-app", path: todo },
      { id: DAPP, name: "werewolf-dapp", path: dapp },
    ]),
    dappPath: dapp,
  };
}

test("a room reports the cross-project edges its members declare", () => {
  const kit = workspace();

  const edges = kit.service.crossProjectDependencies(["todo-app", "werewolf-dapp"]);
  assert.equal(edges.length, 1, JSON.stringify(edges));
  const [edge] = edges;
  assert.equal(edge.dependentProjectName, "todo-app");
  assert.equal(edge.dependentEnvironmentId, "production");
  assert.equal(edge.dependencyId, "dapp-api");
  assert.equal(edge.ownerProjectId, DAPP);
  assert.equal(edge.ownerProjectName, "werewolf-dapp");
  assert.equal(edge.ownerInRoom, true);
  // Nothing has been planned, so the honest answer is "not observed", never "failing".
  assert.equal(edge.state, "unknown");
});

test("room deployment coverage names every member and its declared release order", () => {
  const kit = workspace();
  const coverage = kit.service.deploymentCoverage(["todo-app", "werewolf-dapp", "missing"]);
  assert.equal(coverage[0].status, "managed");
  assert.equal(coverage[0].environments[0]?.id, "production");
  assert.deepEqual(coverage[0].environments[0]?.dependencies, [
    { id: "dapp-api", ownerProjectId: DAPP, ownerProjectName: "werewolf-dapp" },
  ]);
  assert.equal(coverage[1].status, "managed");
  assert.equal(coverage[2].status, "missing");

  fs.rmSync(path.join(kit.dappPath, ".psm", "deployments.json"));
  execFileSync("git", ["-C", kit.dappPath, "add", "-u"]);
  execFileSync("git", ["-C", kit.dappPath, "commit", "-qm", "remove manifest"]);
  const withoutManifest = kit.service.deploymentCoverage(["werewolf-dapp"]);
  assert.equal(withoutManifest[0].status, "unmanaged");
  assert.deepEqual(withoutManifest[0].environments, []);
});

test("a probe that names no owning project is not a cross-project edge", () => {
  const kit = workspace();

  const edges = kit.service.crossProjectDependencies(["todo-app", "werewolf-dapp"]);
  assert.ok(!edges.some((edge) => edge.dependencyId === "own-health"), "psm must not infer an owner from a URL");
});

test("an owner outside the room is still reported, and marked as outside it", () => {
  const kit = workspace();

  const edges = kit.service.crossProjectDependencies(["todo-app"]);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].ownerInRoom, false);
  assert.equal(edges[0].ownerProjectName, "werewolf-dapp", "the owner is named even when it is not a member");
});

test("a passing dependency is not reported, a blocked one is", () => {
  const kit = workspace();

  const observe = (state: string, detail: string) => {
    kit.store.createPlan({
      planId: `plan_${state}`,
      revision: 1,
      digest: `sha256:${state}`,
      projectId: TODO,
      checkoutId: "chk_todo",
      environmentId: "production",
      operation: "deploy",
      risk: "production",
      manifestDigest: "sha256:manifest",
      artifactId: null,
      requiredAcknowledgementIds: [],
      blocked: false,
      document: {
        schema: "deployment-plan@1",
        observations: {
          dependencies: [{ id: "dapp-api", kind: "http-status@1", state, title: "dapp-api", detail, observedAt: 500, fingerprint: "sha256:d" }],
          resources: [],
          watch: [],
          observedAt: 500,
        },
      },
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
      actions: [],
    });
  };

  observe("ready", "HTTP 401 in 12ms");
  assert.deepEqual(kit.service.crossProjectDependencies(["todo-app"]), [], "a satisfied edge is not a finding");

  observe("blocked", "HTTP 404 — the route is not deployed");
  const edges = kit.service.crossProjectDependencies(["todo-app"]);
  assert.equal(edges.length, 1, JSON.stringify(edges));
  assert.equal(edges[0].state, "blocked");
  assert.equal(edges[0].detail, "HTTP 404 — the route is not deployed");
  assert.equal(edges[0].observedAt, 500);
});

test("an unmanaged or missing member contributes nothing rather than failing the room", () => {

  // A project with no manifest, a project psm cannot see, and a path that is gone.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "psm-deploy-service-bare-"));
  const mixed = service([
    { id: TODO, name: "todo-app", path: bare },
    { id: "prj_ffffffffffffffffffff", name: "ghost", path: "/nonexistent/ghost" },
  ]);
  assert.deepEqual(mixed.service.crossProjectDependencies(["todo-app", "ghost", "never-linked"]), []);
});

test("an approved plan is still the approved plan when nothing has moved", async () => {
  // This is the gate the runner applies before every mutation: it re-derives
  // the plan from today's inputs and stops the run unless the digest matches.
  // werewolf-dapp declares no dependencies, so the rebuild reads no network and
  // the only thing that can differ between the two builds is the clock.
  const kit = workspace();
  const { plan } = await kit.service.createPlan(DAPP, { environment: "production", operation: "deploy" });
  const approved = plan as { id: string; revision: number; digest: string };
  const rebuilt = await kit.service.recheckPlan(approved.id, approved.revision);
  assert.equal(rebuilt.digest, approved.digest);
  assert.deepEqual([...rebuilt.lockKeys], [
    "resource/digitalocean-dns-record@1/public-dns",
    "resource/host-release-directory@1/site-directory",
    "resource/letsencrypt-certificate@1/tls",
    "resource/nginx-static-site@1/ingress",
    "target/werewolf:werewolf-dapp-production-web",
  ], "the rebuild must also claim the same set of targets");
});

test("readiness for a real project names what is missing, not that something is", async () => {
  // The whole path: read the committed manifest, build a fresh plan, turn its
  // blockers into the checklist the deploy pane shows. Nothing is bound in a
  // fixture workspace, which is exactly the state an operator starts from.
  const kit = workspace();
  assert.equal(kit.service.lastReadiness(DAPP, "production"), null, "nothing is answered before a check");
  const { readiness } = await kit.service.checkReadiness(DAPP, "production");
  const kept = kit.service.lastReadiness(DAPP, "production")!;
  assert.deepEqual(kept.readiness, readiness, "the last answer is kept for the page to show again");
  kept.readiness.items.length = 0;
  assert.ok(kit.service.lastReadiness(DAPP, "production")!.readiness.items.length > 0, "callers get a copy");

  assert.equal(readiness.ready, false);
  assert.equal(readiness.environmentId, "production");
  assert.equal(readiness.canMakeReady, false, "psm has no build provider to run and must not offer one");

  const connect = readiness.items.filter((item) => item.action === "connect");
  assert.deepEqual(connect.map((item) => item.slot).sort(), ["dns", "github", "infrastructure"]);
  assert.ok(connect.every((item) => item.status === "blocked"));

  // Readiness always answers for a deploy, so the build is on the list — as the
  // operator's step, since there is no build provider to run it for them.
  const build = readiness.items.find((item) => item.code === "artifact-missing");
  assert.ok(build, JSON.stringify(readiness.items));
  assert.equal(build.automatic, false);
  assert.equal(build.action, "prepare-artifact");

  // Work already done is on the list too, or the remaining count means nothing.
  assert.ok(readiness.items.some((item) => item.code === "source-ready" && item.status === "ready"));
});

test("after a new commit, readiness drops the old build and the old answer", async () => {
  const kit = workspace();
  const root = kit.dappPath;
  const commit = () => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const old = kit.store.recordArtifact({
    artifactId: "art_old", producingRunId: null, provenance: "external", projectId: DAPP, kind: "static-files",
    sourceRepository: "Werewolf-Solutions/werewolf-dapp", githubArtifactId: "1", producerRunId: "1",
    commitSha: commit(), version: "0.1.0",
    buildProfileDigest: canonicalDigest("psm-deployment-build-profile:v1", { id: "production", publicInputs: {} }),
    payloadAlgorithm: "psm-static-tree-sha256@1", payloadDigest: "sha256:p", archiveDigest: "sha256:a",
    providerLocator: {}, provenanceUrl: null, createdAt: Date.now(), retainedUntil: Date.now() + 600_000,
  });
  const first = await kit.service.checkReadiness(DAPP, "production");
  assert.ok(!first.readiness.items.some((item) => item.code === "artifact-missing" && item.status !== "ready"), "a build of the current commit is picked up");

  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "werewolf-dapp", version: "0.1.1" }) + "\n");
  execFileSync("git", ["-C", root, "commit", "-qam", "fix"]);
  assert.equal(kit.service.lastReadiness(DAPP, "production"), null, "an answer about the previous commit is not shown again");

  // An open page may still send the previous commit's selection.
  const { readiness } = await kit.service.checkReadiness(DAPP, "production", { artifactId: old.artifactId });
  const codes = readiness.items.filter((item) => item.status !== "ready").map((item) => item.code);
  assert.ok(codes.includes("artifact-missing"), JSON.stringify(codes));
  assert.ok(!codes.includes("artifact-source-mismatch"));
  assert.ok(!codes.includes("version-not-increased"));
});

test("connection setup suggests only the resources and workflows declared for each slot", async () => {
  const kit = workspace();
  const view = await kit.service.environmentView(DAPP, "production");
  const connections = view.connections as { slot: string; setup: Record<string, unknown> }[];
  const setup = (slot: string) => connections.find((connection) => connection.slot === slot)!.setup;
  assert.deepEqual(setup("dns").zones, ["example.com"]);
  assert.deepEqual(setup("dns").targets, []);
  assert.deepEqual(setup("infrastructure").targets, [{ id: "werewolf:werewolf-dapp-production-web", root: "/var/www/werewolf-dapp.example.com" }]);
  assert.deepEqual(setup("github").workflows, [{ repository: "Werewolf-Solutions/werewolf-dapp", workflow: "build-static.yml", targetId: "werewolf:werewolf-dapp-production-web" }]);
  assert.deepEqual(setup("github").targets, []);
});

test("a bound GitHub connection with no reviewed release workflow blocks the plan, not the dispatch", async () => {
  const kit = workspace();
  const target = "werewolf:werewolf-dapp-production-web";
  const profile = (releaseControllers: unknown[]) => ({
    connectionId: "con_release", kind: "github-actions@1", label: "Release", secretGeneration: 0,
    readiness: "ready" as const, createdAt: Date.now(),
    metadata: { publicMetadata: { revision: 1, prepareWorkflows: [], releaseControllers }, credentialIdentity: null, requiredSecretSlots: [] },
    constraints: { allowedProjectIds: [DAPP], allowedEnvironmentIds: ["production"], maximumAuthorizedRisk: "production", allowedTargetIds: [target], allowedRepositories: ["Werewolf-Solutions/werewolf-dapp"], allowedSourceRefs: ["master"] },
  });
  kit.store.createConnection(profile([]) as never);
  await kit.service.bindConnection(DAPP, "production", "github", "con_release", null);

  const blocked = (await kit.service.environmentView(DAPP, "production")).blockers as { code: string; message: string }[];
  assert.ok(blocked.some((item) => item.code === "release-controller-unpinned" && item.message.includes(target)), JSON.stringify(blocked));
  // The connection itself is bound and in scope; only the release workflow is unpinned.
  assert.ok(!blocked.some((item) => item.code === "connection-missing" && item.message.includes("github")));

  const reviewed = profile([{ controller: "werewolf-static@1", targetId: target }]);
  kit.store.updateConnection({ connectionId: "con_release", expectedMetadataRevision: 1, label: reviewed.label, readiness: "ready", metadata: reviewed.metadata as never, constraints: reviewed.constraints as never, secretGeneration: 0, updatedAt: Date.now() });
  const pinned = (await kit.service.environmentView(DAPP, "production")).blockers as { code: string }[];
  assert.ok(!pinned.some((item) => item.code === "release-controller-unpinned"));
});

test("live credential presence reconciles stale runtime readiness without overriding invalid profiles", async () => {
  const kit = workspace();
  const record = kit.store.createConnection({
    connectionId: "con_cached_dns", kind: "digitalocean-api@1", label: "DNS", secretGeneration: 0, readiness: "missing-secret", createdAt: Date.now(),
    metadata: { publicMetadata: {}, requiredSecretSlots: ["apiToken"] },
    constraints: { allowedProjectIds: [DAPP], allowedEnvironmentIds: ["production"], maximumAuthorizedRisk: "production", allowedZones: ["example.com"] },
  });
  await kit.service.bindConnection(DAPP, "production", "dns", record.connectionId, null);
  await kit.service.secretBroker.put(record.connectionId, "apiToken", "fixture-token");
  await kit.service.environmentView(DAPP, "production");
  assert.equal(kit.store.getConnection(record.connectionId).readiness, "ready");
  await kit.service.secretBroker.delete(record.connectionId, "apiToken");
  await kit.service.environmentView(DAPP, "production");
  assert.equal(kit.store.getConnection(record.connectionId).readiness, "missing-secret");
  await kit.service.secretBroker.put(record.connectionId, "apiToken", "fixture-token");
  kit.store.updateConnection({ connectionId: record.connectionId, expectedMetadataRevision: 1, label: record.label, readiness: "invalid", metadata: record.metadata, constraints: record.constraints, secretGeneration: 0, updatedAt: Date.now() });
  const view = await kit.service.environmentView(DAPP, "production");
  assert.equal(kit.store.getConnection(record.connectionId).readiness, "invalid");
  assert.equal((view.connections as { slot: string; ready: boolean }[]).find((connection) => connection.slot === "dns")?.ready, false);
  assert.throws(() => kit.store.updateConnectionSecretStatus({ connectionId: record.connectionId, expectedSecretGeneration: 0, expectedMetadataRevision: 1, secretGeneration: 0, readiness: "ready", updatedAt: Date.now() }), /changed/);
  assert.throws(() => kit.store.updateConnectionSecretStatus({ connectionId: record.connectionId, expectedSecretGeneration: 0, expectedMetadataRevision: 2, secretGeneration: 0, readiness: "ready", updatedAt: Date.now() }), /changed/);
});

test('monitor refresh needs no artifact or plan and unavailable or aged evidence never stays healthy', async(t) => {
 const root=repository(TODO,'todo-app',[]);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'.psm','deployments.json');const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
 manifest.environments[0].connections.monitor={kind:'external-monitor@1'};
 manifest.environments[0].watch=[{id:'todo-public-web',kind:'external-http-monitor@1',connection:'monitor',unit:'web',monitorKey:'todo-staging-web',hostname:'todo-app.example.com',maxObservationAgeSeconds:300}];
 fs.writeFileSync(file,JSON.stringify(manifest));execFileSync('git',['-C',root,'add','.psm/deployments.json']);execFileSync('git',['-C',root,'commit','-qm','monitor']);
 const database=openDatabase(':memory:'); const store=new DeploymentStore(database); t.after(()=>database.close());
 let unavailable=false;let at=Date.now()-301000;
 const service=new DeploymentService({store,secretBroker:new SecretBroker(),projects:()=>[{id:TODO,name:'todo-app',path:root}],githubConnectionDefaults:async()=>({}),observations:{watch:async()=>{if(unavailable)throw Error('do not leak secret');return {monitorId:'todo-public-web',providerState:'healthy',effectiveState:'healthy',observedAt:at,detail:'HTTPS verified',evidence:{provider:'werewolf-watch@1',failureDomain:'same-host'}};}}});
 const stale=await service.refreshWatch(TODO,'production');assert.equal((stale.watch as any).effectiveState,'stale');assert.equal(((await service.targets())[0].watch as any).effectiveState,'stale');
 at=Date.now();const healthy=await service.refreshWatch(TODO,'production');assert.equal((healthy.watch as any).effectiveState,'healthy');assert.equal((healthy.watch as any).evidence.provider,'werewolf-watch@1');
 unavailable=true;const unknown=await service.refreshWatch(TODO,'production');assert.equal((unknown.watch as any).effectiveState,'unknown');assert.doesNotMatch(JSON.stringify(unknown.watch),/do not leak secret/);
});
