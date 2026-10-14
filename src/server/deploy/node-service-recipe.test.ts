import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { expandDeploymentGraph } from "./graph.ts";
import { deploymentManifestIssues, parseDeploymentManifest } from "./manifest.ts";

const PROJECT_ID = "prj_a1557b3e3e9c57129fa8";

function projectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-node-service-"));
  fs.mkdirSync(path.join(root, ".psm"));
  fs.writeFileSync(path.join(root, ".psm", "identity.json"), JSON.stringify({ id: PROJECT_ID }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
  return root;
}

/** handymanservices staging: a Vite client built into an Express server. */
function handymanManifest(change: (environment: Record<string, any>) => void = () => {}): Record<string, unknown> {
  const hostname = "handyman-staging.werewolf.solutions";
  const root = "/srv/handyman-staging.werewolf.solutions";
  const environment: Record<string, any> = {
    id: "staging",
    risk: "staging",
    releasePolicy: { allowedBranch: "master", requireReachableFromBranch: false, requireChecks: false, approval: "none" },
    connections: { github: { kind: "github-actions@1" }, dns: { kind: "digitalocean-api@1" }, host: { kind: "ssh-host-helper@1" } },
    dependencies: [],
    resources: [
      { id: "dns", kind: "digitalocean-dns-record@1", connection: "dns", desired: { zone: "werewolf.solutions", type: "A", name: "handyman-staging", valueFrom: { connection: "host", field: "address" }, ttl: 300 } },
      { id: "directory", kind: "host-release-directory@1", connection: "host", dependsOn: ["resource:dns"], desired: { root, retainReleases: 5 } },
      { id: "service", kind: "systemd-node-service@1", connection: "host", dependsOn: ["resource:directory"], desired: {
        entry: "bin/www", healthPath: "/healthz", startupTimeoutSeconds: 20, memoryMaxMb: 256,
        config: { NODE_ENV: "production", WEREWOLF_API_URL: "https://staging.werewolf.solutions/api/v1", FRONTEND_URL: `https://${hostname}` },
      } },
      { id: "secrets", kind: "service-secrets@1", connection: "host", dependsOn: ["resource:service"], desired: { names: ["BUSINESS_ID", "API_KEY"] } },
      { id: "ingress", kind: "nginx-node-proxy@1", connection: "host", dependsOn: ["resource:dns", "resource:service"], desired: { hostname, securityHeaders: "app-managed@1", maxBodyMb: 10 } },
      { id: "certificate", kind: "letsencrypt-certificate@1", connection: "host", dependsOn: ["resource:dns", "resource:ingress#http-ready"], desired: { hostname, renewal: "automatic" } },
    ],
    units: [{
      id: "web",
      recipe: "node-service-ssh-nginx@1",
      resourceRefs: ["resource:dns", "resource:directory", "resource:service", "resource:secrets", "resource:ingress", "resource:certificate"],
      artifact: {
        kind: "node-service@1", runtime: "node@22", install: [".", "client", "server"], buildScript: "build",
        serviceRoot: "server", entry: "bin/www", publicDir: "public",
        buildProfile: { id: "staging", publicInputs: {} },
      },
      executor: { kind: "github-actions@1", connection: "github", sourceRepository: "Werewolf-Solutions/handymanservices", prepareWorkflow: "build-node-service.yml", releaseController: "werewolf-static@1" },
      target: { kind: "ssh-release-directory@1", targetId: "werewolf:handymanservices-staging-web", observerConnection: "host", root },
      verification: [
        { id: "home", kind: "http-status@1", request: { url: `https://${hostname}/`, method: "GET", timeoutMs: 5000 }, expect: { status: 200 } },
        { id: "health", kind: "http-status@1", request: { url: `https://${hostname}/healthz`, method: "GET", timeoutMs: 5000 }, expect: { status: 200 } },
        { id: "release-metadata", kind: "release-metadata@1", request: { url: `https://${hostname}/version.json`, method: "GET", timeoutMs: 5000 }, expect: { commit: "$release.commit", psmArtifactId: "$release.psmArtifactId", version: "$release.version" } },
      ],
    }],
    watch: [],
    policy: { planTtlSeconds: 900, rollbackOnVerificationFailure: true, allowDelete: false, requireFreshWatchBeforeRelease: false },
  };
  change(environment);
  return { apiVersion: "psm.werewolf.solutions/deployments/v1", kind: "DeploymentManifest", projectId: PROJECT_ID, environments: [environment] };
}

function issues(document: Record<string, unknown>): string[] {
  return deploymentManifestIssues(document, { projectRoot: projectRoot() }).map((issue) => `${issue.code}: ${issue.message}`);
}

test("a Node service manifest validates and expands with the service ready before nginx routes to it", () => {
  const manifest = parseDeploymentManifest(handymanManifest(), { projectRoot: projectRoot() });
  const secrets = manifest.environments[0].resources.find((resource) => resource.kind === "service-secrets@1");
  assert.deepEqual(secrets?.kind === "service-secrets@1" && secrets.desired.names, ["API_KEY", "BUSINESS_ID"], "names are sorted");
  const graph = expandDeploymentGraph(manifest, "staging");
  const at = (id: string) => {
    const index = graph.order.indexOf(id);
    assert.ok(index >= 0, `${id} is in the graph: ${graph.order.join(", ")}`);
    return index;
  };
  assert.ok(at("resource:directory#reconciled") < at("resource:service#reconciled"));
  assert.ok(at("resource:service#reconciled") < at("resource:secrets#reconciled"));
  assert.ok(at("resource:service#reconciled") < at("resource:ingress#http-ready"));
  assert.ok(at("resource:ingress#http-reloaded") < at("resource:certificate#certificate-ready"));
  assert.ok(at("resource:certificate#certificate-ready") < at("resource:ingress#tls-ready"));
  assert.ok(at("unit:web/resource:secrets#verified") < at("unit:web#pm2-before"), "secrets are in place before the release");
  assert.ok(at("unit:web#staged") < at("unit:web#activated"));
  assert.ok(at("unit:web#activated") < at("unit:web/verification:health#passed"));
  const kinds = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  assert.equal(kinds.get("resource:service#reconciled"), "reconcile-service@1");
  assert.equal(kinds.get("resource:secrets#reconciled"), "reconcile-service-secrets@1");
  assert.equal(kinds.get("unit:web#staged"), "stage-service-release@1");
  assert.equal(kinds.get("unit:web#activated"), "activate-service-release@1");
});

test("runtime configuration refuses reserved names, secrets in config and overlaps", () => {
  const service = (environment: Record<string, any>) => environment.resources.find((resource: { id: string }) => resource.id === "service").desired;
  assert.ok(issues(handymanManifest((environment) => { service(environment).config.PORT = "3001"; })).some((issue) => issue.startsWith("reserved-env-name")));
  assert.ok(issues(handymanManifest((environment) => { service(environment).config.NODE_OPTIONS = "--inspect"; })).some((issue) => issue.startsWith("reserved-env-name")));
  assert.ok(issues(handymanManifest((environment) => { service(environment).config.STRIPE_SECRET = "x"; })).some((issue) => issue.startsWith("secret-shaped")),
    "a secret-looking name in committed config is sent to service-secrets");
  assert.ok(issues(handymanManifest((environment) => { service(environment).config.BUSINESS_ID = "biz_1"; })).some((issue) => issue.startsWith("config-secret-overlap")));
});

test("health-checked switching is an explicit, bounded manifest choice", () => {
  const service = (environment: Record<string, any>) => environment.resources.find((resource: any) => resource.kind === "systemd-node-service@1");
  const parsed = parseDeploymentManifest(handymanManifest((environment) => { Object.assign(service(environment).desired, { switching: "health-checked", drainSeconds: 10 }); }), { projectRoot: projectRoot() });
  const resource = parsed.environments[0].resources.find((entry) => entry.kind === "systemd-node-service@1");
  assert.ok(resource?.kind === "systemd-node-service@1");
  assert.equal(resource.desired.switching, "health-checked");
  assert.equal(resource.desired.drainSeconds, 10);
  const plain = parseDeploymentManifest(handymanManifest(), { projectRoot: projectRoot() }).environments[0].resources.find((entry) => entry.kind === "systemd-node-service@1");
  assert.ok(plain?.kind === "systemd-node-service@1" && !("switching" in plain.desired), "a manifest without it sends the helper nothing new");
  assert.ok(issues(handymanManifest((environment) => { service(environment).desired.switching = "blue-green"; })).some((issue) => /or omitted to restart in place/.test(issue)));
  assert.ok(issues(handymanManifest((environment) => { service(environment).desired.drainSeconds = 10; })).some((issue) => /needs switching: health-checked/.test(issue)));
  assert.ok(issues(handymanManifest((environment) => { Object.assign(service(environment).desired, { switching: "health-checked", drainSeconds: 600 }); })).length > 0);
});

test("the service recipe requires its own resources and a matching entry point", () => {
  assert.ok(issues(handymanManifest((environment) => {
    environment.units[0].artifact.entry = "server.js";
  })).some((issue) => issue.startsWith("entry-mismatch")));
  assert.ok(issues(handymanManifest((environment) => {
    environment.resources.push({ id: "static", kind: "nginx-static-site@1", connection: "host", desired: { hostname: "handyman-staging.werewolf.solutions", documentRoot: "/srv/handyman-staging.werewolf.solutions/current", spaFallback: true, denyPrefixes: ["/api/"], cachePolicy: "vite-hashed", securityHeaders: "werewolf-static-spa@1" } });
    environment.units[0].resourceRefs.push("resource:static");
  })).some((issue) => issue.includes("cannot assemble nginx-static-site@1")));
  assert.ok(issues(handymanManifest((environment) => {
    environment.units[0].resourceRefs = environment.units[0].resourceRefs.filter((ref: string) => ref !== "resource:service");
    environment.resources = environment.resources.filter((resource: { id: string }) => resource.id !== "service");
    environment.resources.find((resource: { id: string }) => resource.id === "secrets").dependsOn = [];
    environment.resources.find((resource: { id: string }) => resource.id === "ingress").dependsOn = ["resource:dns"];
  })).some((issue) => issue.includes("requires exactly one systemd-node-service@1")));
  assert.ok(issues(handymanManifest((environment) => {
    environment.units[0].artifact.entry = "bin/www --inspect=0.0.0.0";
    environment.resources.find((resource: { id: string }) => resource.id === "service").desired.entry = "bin/www --inspect=0.0.0.0";
  })).some((issue) => issue.startsWith("invalid-path")), "the entry point cannot carry arguments");
});

test("the handymanservices staging manifest has no issues, and a long hostname is not taken for a token", () => {
  assert.deepEqual(issues(handymanManifest()), []);
  assert.ok(issues(handymanManifest((environment) => {
    environment.resources.find((resource: { id: string }) => resource.id === "service").desired.config.SESSION = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  })).some((issue) => issue.startsWith("secret-shaped")), "a real JWT is still caught");
});

test("runtime secrets are compared by verdict only, and a missing local value blocks the plan", async () => {
  const { compareServiceSecrets, serviceSecretsSummary, serviceSecretOwner } = await import("./runtime-adapters.ts");
  const { createHmac } = await import("node:crypto");
  const salt = Buffer.alloc(16, 7);
  const fingerprint = (value: string) => `hmac-sha256:${createHmac("sha256", salt).update(value).digest("hex")}`;
  const local = new Map([["API_KEY", "sk-live-1"], ["BUSINESS_ID", "biz_1"]]);
  const states = compareServiceSecrets(["API_KEY", "BUSINESS_ID", "SMTP_PASS"], local,
    { API_KEY: fingerprint("sk-live-1"), BUSINESS_ID: fingerprint("biz_old"), SMTP_PASS: null }, salt);
  assert.deepEqual(states, { API_KEY: "in-sync", BUSINESS_ID: "differs", SMTP_PASS: "missing-in-psm" });
  const blocked = serviceSecretsSummary(states);
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.detail, /Set SMTP_PASS in PSM/);
  const update = serviceSecretsSummary({ API_KEY: "in-sync", BUSINESS_ID: "differs" }, ["OLD_TOKEN"]);
  assert.equal(update.state, "update");
  assert.match(update.detail, /BUSINESS_ID will be written .* OLD_TOKEN on the host is no longer declared/);
  const serialized = JSON.stringify([blocked, update]);
  assert.ok(!serialized.includes("sk-live-1") && !serialized.includes("hmac-sha256"), "neither values nor fingerprints are kept");
  assert.equal(serviceSecretsSummary({ API_KEY: "in-sync" }).state, "in-sync");
  assert.equal(serviceSecretOwner(PROJECT_ID, "staging", "web"), `service-secrets:${PROJECT_ID}:staging:web`);
});

test("a service's secrets get their own generation without a connection record", async () => {
  const { openDatabase } = await import("../db.ts");
  const { DeploymentStore } = await import("./store.ts");
  const { SecretBroker } = await import("./connections.ts");
  const { DeploymentSecretGenerationStore } = await import("./secrets.ts");
  const { serviceSecretOwner, serviceSecretSlot } = await import("./runtime-adapters.ts");
  const database = openDatabase(":memory:");
  try {
    const store = new DeploymentStore(database);
    const broker = new SecretBroker({ generations: new DeploymentSecretGenerationStore(store) });
    const owner = serviceSecretOwner(PROJECT_ID, "staging", "web");
    assert.equal(await broker.put(owner, serviceSecretSlot("API_KEY"), "sk-live-1"), 1);
    assert.equal(await broker.put(owner, serviceSecretSlot("API_KEY"), "sk-live-2"), 2);
    assert.equal(store.getServiceSecretGeneration(owner), 2);
    const value = await broker.withLease(owner, [serviceSecretSlot("API_KEY")], (lease) => lease.useUtf8(serviceSecretSlot("API_KEY"), (secret) => secret));
    assert.equal(value, "sk-live-2");
  } finally {
    database.close();
  }
});

test("the build template's bundle digest matches the host helper's golden vector", async () => {
  // Pinned in host-helper/service_test.go TestServiceDigestGoldenVector as well.
  const { treeDigest } = await import("./templates/prepare-node-service.mjs");
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "psm-service-digest-"));
  for (const [name, content, mode] of [["version.json", "alpha\n", 0o644], ["app/bin/www", "require('./app')\n", 0o644], ["runtime/bin/node", "ELF\n", 0o755]] as const) {
    fs.mkdirSync(path.dirname(path.join(tree, name)), { recursive: true });
    fs.writeFileSync(path.join(tree, name), content);
    fs.chmodSync(path.join(tree, name), mode);
  }
  assert.deepEqual(treeDigest(tree), {
    payloadDigest: "sha256:69dd7860f326de5e41d8ec74256c7d3725e9272ec05b9cc9d96bbcda23e8fa5b", fileCount: 3, payloadBytes: 27,
  });
});
