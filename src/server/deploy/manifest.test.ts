import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DeploymentManifestValidationError,
  deploymentManifestIssues,
  loadDeploymentManifest,
  parseDeploymentManifest,
} from "./manifest.ts";

const PROJECT_ID = "prj_0123456789abcdef0123";

function projectRoot(version = "0.5.2"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-deployment-manifest-"));
  fs.mkdirSync(path.join(root, ".psm"));
  fs.writeFileSync(path.join(root, ".psm", "identity.json"), JSON.stringify({
    version: 1,
    id: PROJECT_ID,
    name: "todo-app",
    createdAt: 1,
  }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "todo-app", version }));
  return root;
}

function validManifest(): any {
  return {
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
        infrastructure: { kind: "ssh-host-helper@1" },
        monitor: { kind: "external-monitor@1" },
      },
      dependencies: [{
        id: "api",
        kind: "http-status@1",
        projectId: "prj_abcdef0123456789abcd",
        request: { url: "https://api.example.com/todo", method: "GET" },
        expect: { status: 401 },
      }],
      resources: [{
        id: "public-dns",
        kind: "digitalocean-dns-record@1",
        connection: "dns",
        desired: {
          zone: "Example.COM.",
          type: "A",
          name: "todo",
          valueFrom: { connection: "infrastructure", field: "address" },
          ttl: 300,
        },
      }, {
        id: "site-directory",
        kind: "host-release-directory@1",
        connection: "infrastructure",
        desired: { root: "/var/www/todo.example.com/", retainReleases: 5 },
      }, {
        id: "ingress",
        kind: "nginx-static-site@1",
        connection: "infrastructure",
        dependsOn: ["resource:site-directory", "resource:public-dns"],
        desired: {
          hostname: "Todo.Example.COM.",
          documentRoot: "/var/www/todo.example.com/current/",
          spaFallback: true,
          denyPrefixes: ["/api/"],
          cachePolicy: "vite-hashed",
          securityHeaders: "werewolf-static-spa@1",
        },
      }, {
        id: "tls",
        kind: "letsencrypt-certificate@1",
        connection: "infrastructure",
        dependsOn: ["resource:public-dns", "resource:ingress#http-ready"],
        desired: { hostname: "todo.example.com", renewal: "automatic" },
      }],
      units: [{
        id: "web",
        recipe: "static-ssh-nginx@1",
        resourceRefs: ["resource:public-dns", "resource:site-directory", "resource:ingress", "resource:tls"],
        artifact: {
          kind: "static-files@1",
          output: "./client/dist",
          buildProfile: {
            id: "production",
            publicInputs: { VITE_API_BASE: "https://api.example.com/v1" },
          },
        },
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
          observerConnection: "infrastructure",
          root: "/var/www/todo.example.com/",
        },
        verification: [{
          id: "home",
          kind: "http-status@1",
          request: { url: "https://todo.example.com", method: "GET" },
          expect: { status: 200 },
        }, {
          id: "served-release",
          kind: "release-metadata@1",
          request: { url: "https://todo.example.com/version.json", method: "HEAD" },
          expect: { commit: "$release.commit", psmArtifactId: "$release.psmArtifactId" },
        }],
      }],
      watch: [{
        id: "public-web",
        kind: "external-http-monitor@1",
        connection: "monitor",
        unit: "web",
        monitorKey: "todo-production-web",
        hostname: "Todo.Example.COM.",
        maxObservationAgeSeconds: 180,
      }],
      policy: {
        planTtlSeconds: 600,
        rollbackOnVerificationFailure: true,
        allowDelete: false,
        requireFreshWatchBeforeRelease: true,
      },
    }],
  };
}

function issueCodes(document: unknown, root = projectRoot()): string[] {
  return deploymentManifestIssues(document, { projectRoot: root }).map((issue) => issue.code);
}

test("validates and normalizes a static-ssh-nginx manifest", () => {
  const parsed = parseDeploymentManifest(validManifest(), { projectRoot: projectRoot() });
  const environment = parsed.environments[0];
  const ingress = environment.resources.find((resource) => resource.kind === "nginx-static-site@1");
  assert.equal(ingress?.kind === "nginx-static-site@1" && ingress.desired.hostname, "todo.example.com");
  assert.equal(ingress?.kind === "nginx-static-site@1" && ingress.desired.documentRoot, "/var/www/todo.example.com/current");
  assert.equal(environment.units[0].target.root, "/var/www/todo.example.com");
  assert.equal((environment.units[0].artifact as { output: string }).output, "client/dist");
  assert.equal(environment.watch[0].hostname, "todo.example.com");
});

test("rejects release retention below the host helper minimum", () => {
  const manifest = validManifest();
  manifest.environments[0].resources[1].desired.retainReleases = 3;
  assert.ok(deploymentManifestIssues(manifest, { projectRoot: projectRoot() })
    .some((issue) => issue.path.endsWith("desired.retainReleases")));
});

test("fails closed on unknown fields and adapter kinds", () => {
  const unknownField = validManifest();
  unknownField.environments[0].units[0].executor.command = "deploy.sh";
  assert.ok(issueCodes(unknownField).includes("unknown-field"));

  const unknownKind = validManifest();
  unknownKind.environments[0].resources[0].kind = "route53-record@1";
  assert.ok(issueCodes(unknownKind).includes("unknown-kind"));
});

test("rejects traversal, state-changing probes and secret-shaped public inputs", () => {
  const traversal = validManifest();
  traversal.environments[0].units[0].artifact.output = "../outside";
  assert.ok(issueCodes(traversal).includes("path-traversal"));

  const post = validManifest();
  post.environments[0].dependencies[0].request.method = "POST";
  assert.ok(issueCodes(post).includes("invalid-value"));

  const secret = validManifest();
  secret.environments[0].units[0].artifact.buildProfile.publicInputs.VITE_API_TOKEN = "github_pat_abcdefghijklmnopqrstuvwxyz";
  const codes = issueCodes(secret);
  assert.ok(codes.includes("secret-shaped"));
});

test("rejects identity/version violations and an artifact symlink escape", () => {
  const badVersionRoot = projectRoot("v0.5.2");
  assert.ok(issueCodes(validManifest(), badVersionRoot).includes("invalid-version"));

  const mismatch = validManifest();
  mismatch.projectId = "prj_11111111111111111111";
  assert.ok(issueCodes(mismatch).includes("project-id-mismatch"));

  const root = projectRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "psm-deployment-outside-"));
  fs.symlinkSync(outside, path.join(root, "client"));
  assert.ok(issueCodes(validManifest(), root).includes("symlink-escape"));
});

test("rejects duplicate IDs, missing recipe resources and cyclic resource references", () => {
  const duplicate = validManifest();
  duplicate.environments[0].watch[0].id = "web";
  assert.ok(issueCodes(duplicate).includes("duplicate-id"));

  const missing = validManifest();
  missing.environments[0].units[0].resourceRefs.pop();
  assert.ok(issueCodes(missing).includes("recipe-resource-set"));

  const cyclic = validManifest();
  cyclic.environments[0].resources[0].dependsOn = ["resource:tls"];
  assert.ok(issueCodes(cyclic).includes("cyclic-reference"));
});

test("loadDeploymentManifest distinguishes legacy absence and reads a managed manifest", () => {
  const root = projectRoot();
  assert.equal(loadDeploymentManifest(root), null);
  fs.writeFileSync(path.join(root, ".psm", "deployments.json"), JSON.stringify(validManifest()));
  const loaded = loadDeploymentManifest(root);
  assert.equal(loaded?.projectId, PROJECT_ID);
  assert.equal(loaded?.packageVersion, "0.5.2");
  assert.equal(loaded?.manifestPath, path.join(root, ".psm", "deployments.json"));
});

const SCHEMA_PATH = path.resolve(import.meta.dirname, "../../../schemas/deployment-manifest.v1.schema.json");
const readSchema = () => JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));

/**
 * A validator for exactly the JSON Schema keywords this file uses.
 *
 * The schema is what an editor and a contributor read; `parseDeploymentManifest`
 * is what actually decides. Nothing keeps them honest except a test that runs
 * the same documents through both, so this covers the keywords in use and
 * fails loudly if the schema starts using one it does not implement.
 */
function schemaIssues(schema: any, value: unknown, root: any, at = "$"): string[] {
  const known = new Set([
    "$schema", "$id", "title", "$ref", "type", "const", "enum", "pattern", "format",
    "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "items",
    "properties", "required", "additionalProperties", "propertyNames", "oneOf", "$defs",
    "minProperties", "maxProperties",
  ]);
  for (const keyword of Object.keys(schema)) {
    if (!known.has(keyword)) return [`${at}: this test does not implement schema keyword "${keyword}"`];
  }
  if (schema.$ref) {
    const target = String(schema.$ref).replace(/^#\//, "").split("/")
      .reduce<any>((node, key) => node?.[key], root);
    return target ? schemaIssues(target, value, root, at) : [`${at}: unresolved $ref ${schema.$ref}`];
  }
  if (schema.oneOf) {
    const matched = schema.oneOf.filter((branch: any) => schemaIssues(branch, value, root, at).length === 0);
    return matched.length === 1 ? [] : [`${at}: matched ${matched.length} oneOf branches`];
  }
  const issues: string[] = [];
  if (schema.const !== undefined && value !== schema.const) issues.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value as never)) issues.push(`${at}: not one of ${schema.enum.join(", ")}`);
  if (schema.type === "string") {
    if (typeof value !== "string") return [...issues, `${at}: must be a string`];
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) issues.push(`${at}: does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push(`${at}: longer than ${schema.maxLength}`);
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number" || (schema.type === "integer" && !Number.isInteger(value))) return [...issues, `${at}: must be ${schema.type}`];
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(`${at}: above ${schema.maximum}`);
  }
  if (schema.type === "boolean" && typeof value !== "boolean") issues.push(`${at}: must be boolean`);
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [...issues, `${at}: must be an array`];
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => issues.push(...schemaIssues(schema.items, item, root, `${at}[${index}]`)));
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [...issues, `${at}: must be an object`];
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(object, key)) issues.push(`${at}.${key}: is required`);
    }
    const count = Object.keys(object).length;
    if (schema.minProperties !== undefined && count < schema.minProperties) issues.push(`${at}: fewer than ${schema.minProperties} properties`);
    if (schema.maxProperties !== undefined && count > schema.maxProperties) issues.push(`${at}: more than ${schema.maxProperties} properties`);
    for (const [key, entry] of Object.entries(object)) {
      if (schema.propertyNames) issues.push(...schemaIssues(schema.propertyNames, key, root, `${at}.${key} (name)`));
      const property = schema.properties?.[key];
      if (property) issues.push(...schemaIssues(property, entry, root, `${at}.${key}`));
      else if (schema.additionalProperties === false) issues.push(`${at}.${key}: is not allowed`);
      else if (schema.additionalProperties) issues.push(...schemaIssues(schema.additionalProperties, entry, root, `${at}.${key}`));
    }
  }
  return issues;
}

test("schema document is valid JSON and declares a closed root object", () => {
  const schema = readSchema();
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.apiVersion.const, "psm.werewolf.solutions/deployments/v1");
});

test("the published schema and the runtime parser accept the same manifest", () => {
  const schema = readSchema();
  assert.deepEqual(schemaIssues(schema, validManifest(), schema), []);
  assert.doesNotThrow(() => parseDeploymentManifest(validManifest(), { projectRoot: projectRoot() }));
});

test("the published schema and the runtime parser reject the same manifests", () => {
  const schema = readSchema();
  const rejections: Array<[string, (document: any) => void]> = [
    ["unknown root field", (document) => { document.deployType = "static"; }],
    ["unknown unit field", (document) => { document.environments[0].units[0].executor.command = "deploy.sh"; }],
    ["unknown resource kind", (document) => { document.environments[0].resources[0].kind = "route53-record@1"; }],
    ["wrong apiVersion", (document) => { document.apiVersion = "psm.werewolf.solutions/deployments/v2"; }],
    ["missing environments", (document) => { delete document.environments; }],
    ["malformed project id", (document) => { document.projectId = "todo-app"; }],
    ["state-changing probe method", (document) => { document.environments[0].dependencies[0].request.method = "POST"; }],
  ];
  for (const [label, mutate] of rejections) {
    const forSchema = validManifest();
    mutate(forSchema);
    assert.ok(schemaIssues(schema, forSchema, schema).length > 0, `schema accepted ${label}`);

    const forParser = validManifest();
    mutate(forParser);
    assert.throws(
      () => parseDeploymentManifest(forParser, { projectRoot: projectRoot() }),
      DeploymentManifestValidationError,
      `parser accepted ${label}`,
    );
  }
});

test("no adapter kind exists in the schema without the parser, or the reverse", () => {
  // The real drift: a kind added to one artifact and not the other, so an
  // editor validates a manifest psm will refuse, or the reverse.
  const kinds = (source: string) => new Set(source.match(/"[a-z0-9][a-z0-9-]*@\d+"/g) ?? []);
  const fromSchema = kinds(fs.readFileSync(SCHEMA_PATH, "utf8"));
  const fromParser = kinds(fs.readFileSync(path.resolve(import.meta.dirname, "manifest.ts"), "utf8"));

  assert.deepEqual([...fromSchema].filter((kind) => !fromParser.has(kind)).sort(), [], "kinds only in the schema");
  assert.deepEqual([...fromParser].filter((kind) => !fromSchema.has(kind)).sort(), [], "kinds only in the parser");
  assert.ok(fromSchema.size >= 20);
});

test("validation errors expose bounded structured issues", () => {
  assert.throws(
    () => parseDeploymentManifest({}, { projectRoot: projectRoot() }),
    (error: unknown) => {
      assert.ok(error instanceof DeploymentManifestValidationError);
      assert.ok(error.issues.length > 0 && error.issues.length <= 200);
      assert.equal(typeof error.issues[0].path, "string");
      return true;
    },
  );
});

test("psm's own committed manifest is valid against its own validator", () => {
  // psm is now a project the deployment engine has to be able to read. A schema
  // change that invalidates the manifest in this repository is a change that
  // would break every other project's manifest too, and should fail here first.
  const root = path.resolve(import.meta.dirname, "..", "..", "..");
  const loaded = loadDeploymentManifest(root, "prj_b59f38f33cea066492d8");
  assert.ok(loaded, "psm should carry .psm/deployments.json");
  const production = loaded.manifest.environments.find((item) => item.id === "production");
  assert.ok(production, "psm declares a production environment");
  assert.equal(production.risk, "production");
  const ingress = production.resources.find((item) => item.kind === "nginx-static-site@1");
  assert.equal(ingress?.kind === "nginx-static-site@1" && ingress.desired.hostname, "psm.werewolf.solutions");
  // The hosted page must never answer psm's own API: that belongs to the agent
  // on the user's machine, and a page that served it would be another product.
  assert.deepEqual(ingress?.kind === "nginx-static-site@1" ? ingress.desired.denyPrefixes : null, ["/api/"]);
  assert.ok(
    production.units[0].verification.some((probe) =>
      probe.kind === "http-status@1" && probe.request.url.endsWith("/api/projects") && probe.expect.status === 404),
    "a release is only verified if /api/ is proven sealed",
  );
});
