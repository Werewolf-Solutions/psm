import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase } from "../db.ts";
import { SecretBroker } from "./connections.ts";
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
    }),
  };
}

/** todo-app waits on werewolf-dapp; the dapp waits on nobody. */
function workspace() {
  const todo = repository(TODO, "todo-app", [
    { id: "dapp-api", kind: "http-status@1", projectId: DAPP, request: { url: "https://api.example.com/todo", method: "GET" }, expect: { status: 401 } },
    { id: "own-health", kind: "http-status@1", request: { url: "https://todo.example.com/health", method: "GET" }, expect: { status: 200 } },
  ]);
  const dapp = repository(DAPP, "werewolf-dapp", []);
  return service([
    { id: TODO, name: "todo-app", path: todo },
    { id: DAPP, name: "werewolf-dapp", path: dapp },
  ]);
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
