import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeploymentGraphError, expandDeploymentGraph, topologicallySortDeploymentActions } from "./graph.ts";
import { parseDeploymentManifest } from "./manifest.ts";
import type { DeploymentActionNode, DeploymentManifestV1 } from "./types.ts";

const PROJECT_ID = "prj_0123456789abcdef0123";

function parsedManifest(): DeploymentManifestV1 {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-deployment-graph-"));
  fs.mkdirSync(path.join(root, ".psm"));
  fs.writeFileSync(path.join(root, ".psm", "identity.json"), JSON.stringify({ id: PROJECT_ID }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.5.2" }));
  return parseDeploymentManifest({
    apiVersion: "psm.werewolf.solutions/deployments/v1",
    kind: "DeploymentManifest",
    projectId: PROJECT_ID,
    environments: [{
      id: "production",
      risk: "production",
      releasePolicy: {
        allowedBranch: "master",
        requireReachableFromBranch: true,
        requireChecks: true,
        approval: "authenticated-local-operator",
      },
      connections: {
        github: { kind: "github-actions@1" },
        dns: { kind: "digitalocean-api@1" },
        host: { kind: "ssh-host-helper@1" },
        monitor: { kind: "external-monitor@1" },
      },
      dependencies: [{
        id: "api",
        kind: "http-status@1",
        request: { url: "https://api.example.com/todo", method: "GET" },
        expect: { status: 401 },
      }],
      resources: [{
        id: "dns",
        kind: "digitalocean-dns-record@1",
        connection: "dns",
        desired: {
          zone: "example.com",
          type: "A",
          name: "todo",
          valueFrom: { connection: "host", field: "address" },
          ttl: 300,
        },
      }, {
        id: "directory",
        kind: "host-release-directory@1",
        connection: "host",
        desired: { root: "/var/www/todo.example.com", retainReleases: 5 },
      }, {
        id: "ingress",
        kind: "nginx-static-site@1",
        connection: "host",
        dependsOn: ["resource:directory", "resource:dns"],
        desired: {
          hostname: "todo.example.com",
          documentRoot: "/var/www/todo.example.com/current",
          spaFallback: true,
          denyPrefixes: ["/api/"],
          cachePolicy: "vite-hashed",
          securityHeaders: "werewolf-static-spa@1",
        },
      }, {
        id: "tls",
        kind: "letsencrypt-certificate@1",
        connection: "host",
        dependsOn: ["resource:dns", "resource:ingress#http-ready"],
        desired: { hostname: "todo.example.com", renewal: "automatic" },
      }],
      units: [{
        id: "web",
        recipe: "static-ssh-nginx@1",
        resourceRefs: ["resource:dns", "resource:directory", "resource:ingress", "resource:tls"],
        artifact: { kind: "static-files@1", output: "dist", buildProfile: { id: "production", publicInputs: {} } },
        executor: {
          kind: "github-actions@1",
          connection: "github",
          sourceRepository: "Werewolf-Solutions/todo-app",
          prepareWorkflow: "build-static.yml",
          releaseController: "werewolf-static@1",
        },
        target: {
          kind: "ssh-release-directory@1",
          targetId: "werewolf:todo-production-web",
          observerConnection: "host",
          root: "/var/www/todo.example.com",
        },
        verification: [{
          id: "home",
          kind: "http-status@1",
          request: { url: "https://todo.example.com/", method: "GET" },
          expect: { status: 200 },
        }],
      }],
      watch: [{
        id: "public-web",
        kind: "external-http-monitor@1",
        connection: "monitor",
        unit: "web",
        monitorKey: "todo-production-web",
        hostname: "todo.example.com",
        maxObservationAgeSeconds: 180,
      }],
      policy: {
        planTtlSeconds: 600,
        rollbackOnVerificationFailure: true,
        allowDelete: false,
        requireFreshWatchBeforeRelease: true,
      },
    }],
  }, { projectRoot: root });
}

test("static-ssh-nginx expansion follows dependency, staged TLS, release, activation, verify and Watch order", () => {
  const graph = expandDeploymentGraph(parsedManifest(), "production");
  const position = (id: string) => graph.order.indexOf(id);
  assert.ok(position("dependency:api#asserted") < position("resource:dns#reconciled"));
  assert.ok(position("resource:dns#reconciled") < position("resource:directory#reconciled"));
  assert.ok(position("resource:ingress#http-ready") < position("resource:tls#certificate-ready"));
  assert.ok(position("resource:tls#certificate-ready") < position("resource:ingress#tls-ready"));
  assert.ok(position("resource:ingress#tls-ready") < position("resource:ingress#nginx-valid"));
  assert.ok(position("resource:ingress#nginx-valid") < position("resource:ingress#reloaded"));
  assert.ok(position("unit:web#pm2-before") < position("unit:web#staged"));
  assert.ok(position("unit:web#staged") < position("unit:web#activated"));
  assert.ok(position("unit:web#activated") < position("unit:web/verification:home#passed"));
  assert.ok(position("unit:web/verification:home#passed") < position("unit:web#pm2-unchanged"));
  assert.ok(position("unit:web#pm2-unchanged") < position("watch:public-web#observed"));
  assert.equal(new Set(graph.order).size, graph.nodes.length);
});

test("recipe expansion is deterministic across input array order", () => {
  const first = parsedManifest();
  const second = structuredClone(first);
  second.environments[0].resources.reverse();
  second.environments[0].dependencies.reverse();
  second.environments[0].units[0].verification.reverse();
  assert.deepEqual(expandDeploymentGraph(second, "production"), expandDeploymentGraph(first, "production"));
});

test("topological sorter rejects missing edges and cycles", () => {
  const base = (id: string, dependsOn: string[]): DeploymentActionNode => ({
    id,
    kind: "assert-dependency@1",
    phase: "dependencies",
    ownerRef: id,
    dependsOn,
  });
  assert.throws(() => topologicallySortDeploymentActions([base("a", ["missing"])]), DeploymentGraphError);
  assert.throws(() => topologicallySortDeploymentActions([base("a", ["b"]), base("b", ["a"])]), DeploymentGraphError);
});

test("expansion rejects an unknown environment", () => {
  assert.throws(() => expandDeploymentGraph(parsedManifest(), "staging"), DeploymentGraphError);
});
