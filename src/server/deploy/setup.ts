import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { deploymentManifestIssues, loadDeploymentManifest } from "./manifest.ts";

/**
 * First-time managed deployment setup for a project that has no
 * `.psm/deployments.json` yet. PSM reads what it can from the checkout, drafts
 * the manifest for the one recipe it can run today (a static site built on
 * GitHub Actions and served by nginx through the host helper), validates it
 * with the same parser every plan uses, and writes it next to a generic build
 * workflow. Nothing is committed or pushed here; the normal readiness flow
 * reviews and publishes the source afterwards.
 */

const APP_DIRECTORIES = ["", "client", "web", "frontend", "app", "site"];
const SERVER_DIRECTORIES = ["", "server", "api", "backend"];
const SERVER_FRAMEWORKS = ["express", "fastify", "koa", "hono", "@nestjs/core", "next", "@remix-run/node", "@sveltejs/kit"];
const HOSTNAME = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
export const BUILD_WORKFLOW = ".github/workflows/build-static.yml";
export const PREPARE_SCRIPT = ".psm/scripts/prepare-static-artifact.mjs";
export const SERVICE_BUILD_WORKFLOW = ".github/workflows/build-node-service.yml";
export const SERVICE_PREPARE_SCRIPT = ".psm/scripts/prepare-node-service.mjs";
const RESERVED_ENV = /^(HOST|PORT|PATH|HOME|USER|NODE_(?!ENV$).*|LD_.*|PSM_.*)$/;

export class DeploymentSetupError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "DeploymentSetupError";
  }
}

export interface DeploymentSetupDetection {
  projectId: string;
  manifestExists: boolean;
  repository: string | null;
  branch: string | null;
  version: string | null;
  app: { dir: string; output: string } | null;
  server: { dir: string; framework: string } | null;
  recipe: "static-ssh-nginx@1" | "node-service-ssh-nginx@1" | null;
  /** For a client + Express project: what the Node-service recipe will build and run. */
  service: {
    root: string;
    entry: string;
    publicDir: string;
    install: string[];
    buildScript: string;
    config: Record<string, string>;
    secrets: string[];
  } | null;
  /** Why a managed setup cannot be drafted yet, in the operator's words. */
  blockers: string[];
  suggested: { environment: "staging"; hostname: string; zone: string };
}

function readJson(file: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return null; }
}

function dependencies(pkg: Record<string, unknown> | null): string[] {
  if (!pkg) return [];
  return [...Object.keys((pkg.dependencies as object) ?? {}), ...Object.keys((pkg.devDependencies as object) ?? {})];
}

function git(root: string, args: string[]): string | null {
  try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
}

/** `owner/repo` from a GitHub remote in SSH or HTTPS form. */
export function githubRepository(remote: string | null): string | null {
  const match = remote?.match(/github\.com[:/]([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app";
}

export function detectDeploymentSetup(project: { id: string; name: string; path: string }): DeploymentSetupDetection {
  const root = fs.realpathSync(project.path);
  const pkg = readJson(path.join(root, "package.json"));
  const version = typeof pkg?.version === "string" ? pkg.version : null;
  const repository = githubRepository(git(root, ["remote", "get-url", "origin"]));
  const branch = git(root, ["symbolic-ref", "--short", "HEAD"]);

  let app: DeploymentSetupDetection["app"] = null;
  for (const dir of APP_DIRECTORIES) {
    const candidate = readJson(path.join(root, dir, "package.json"));
    const scripts = (candidate?.scripts as Record<string, unknown> | undefined) ?? {};
    if (dependencies(candidate).includes("vite") && typeof scripts.build === "string") {
      app = { dir, output: dir ? `${dir}/dist` : "dist" };
      break;
    }
  }
  let server: DeploymentSetupDetection["server"] = null;
  for (const dir of SERVER_DIRECTORIES) {
    const framework = dependencies(readJson(path.join(root, dir, "package.json"))).find((name) => SERVER_FRAMEWORKS.includes(name));
    if (framework) { server = { dir: dir || ".", framework }; break; }
  }

  const blockers: string[] = [];
  if (!repository) blockers.push("The project has no GitHub `origin` remote. PSM builds releases on GitHub Actions, so push it to GitHub first.");
  if (!version || !VERSION.test(version)) blockers.push("The root package.json needs a version in X.Y.Z form; PSM stamps it into every release.");
  if (!app) blockers.push("PSM found no Vite app with a build script (checked the root, client/, web/, frontend/, app/ and site/).");
  const service = server ? detectService(root, pkg, app, server, blockers) : null;

  const name = slug(project.name);
  return {
    projectId: project.id,
    manifestExists: fs.existsSync(path.join(root, ".psm", "deployments.json")),
    repository,
    branch,
    version,
    app,
    server,
    recipe: blockers.length ? null : server ? "node-service-ssh-nginx@1" : "static-ssh-nginx@1",
    service,
    blockers,
    // Staging gets its own name: the bare one may already be the live site, served by something else.
    suggested: { environment: "staging", hostname: `${name}-staging.werewolf.solutions`, zone: "werewolf.solutions" },
  };
}

/**
 * A Vite client built into an Express server that serves it, like
 * handymanservices: the root build script fills the server's public directory,
 * and `node <entry>` starts it. Anything else stays blocked with the reason.
 */
function detectService(
  root: string,
  pkg: Record<string, unknown> | null,
  app: DeploymentSetupDetection["app"],
  server: { dir: string; framework: string },
  blockers: string[],
): DeploymentSetupDetection["service"] {
  const where = server.dir === "." ? "the repository root" : `${server.dir}/`;
  if (server.framework !== "express") {
    blockers.push(`This project runs a ${server.framework} server in ${where}. PSM's Node-service recipe supports Express servers so far.`);
    return null;
  }
  const serverDir = path.join(root, server.dir);
  const serverPkg = readJson(path.join(serverDir, "package.json"));
  const start = typeof (serverPkg?.scripts as Record<string, unknown> | undefined)?.start === "string"
    ? String((serverPkg!.scripts as Record<string, unknown>).start) : "";
  const entry = /^node\s+(?:\.\/)?([A-Za-z0-9._/-]+)$/.exec(start.trim())?.[1] ?? null;
  if (!entry) blockers.push(`${where}package.json needs a start script of the form \`node <file>\`, such as \`node ./bin/www\`, so PSM knows what to run.`);
  const buildScript = typeof (pkg?.scripts as Record<string, unknown> | undefined)?.build === "string" ? "build" : null;
  if (!buildScript) blockers.push("The root package.json needs a `build` script that builds the client into the server's public directory.");
  const publicDir = fs.existsSync(path.join(serverDir, "public")) ? "public" : null;
  if (!publicDir) blockers.push(`PSM expects the built client in ${where}public/, which the server serves; it does not exist.`);
  const install = ["", app?.dir ?? null, server.dir === "." ? "" : server.dir]
    .filter((dir): dir is string => dir !== null)
    .filter((dir, index, all) => all.indexOf(dir) === index)
    .filter((dir) => fs.existsSync(path.join(root, dir, "package.json")));
  for (const dir of install) {
    if (!fs.existsSync(path.join(root, dir, "package-lock.json"))) blockers.push(`${dir || "The repository root"} has a package.json but no package-lock.json; commit one so builds install exact versions.`);
  }
  // The release is healthy only when it answers here, on the loopback address PSM gives it.
  const code = serverSources(serverDir);
  if (!code.some((text) => /process\.env\.HOST\b/.test(text))) blockers.push(`The server must listen on the address PSM gives it: in ${where}${entry ?? "its entry file"}, call \`server.listen(port, process.env.HOST)\`.`);
  if (!code.some((text) => /["'`]\/healthz["'`]/.test(text))) blockers.push("The server must answer `GET /healthz` with 200 when it is up, without calling other services; PSM checks it after every release.");
  const { config, secrets } = runtimeEnvironment(serverDir);
  return { root: server.dir === "" ? "." : server.dir, entry: entry ?? "", publicDir: publicDir ?? "public", install: install.map((dir) => dir || "."), buildScript: buildScript ?? "build", config, secrets };
}

function serverSources(directory: string, found: string[] = [], depth = 0): string[] {
  if (depth > 4 || found.length > 300) return found;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "public" || entry.name.startsWith(".")) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) serverSources(file, found, depth + 1);
    else if (/\.(?:[cm]?js|ts)$|^www$/.test(entry.name) && fs.statSync(file).size < 512_000) found.push(fs.readFileSync(file, "utf8"));
  }
  return found;
}

/**
 * Names from the server's .env.example (never .env): URLs become reviewed
 * config, development-only localhost values are dropped, and everything else
 * becomes a secret whose value is entered in PSM.
 */
function runtimeEnvironment(serverDir: string): { config: Record<string, string>; secrets: string[] } {
  const config: Record<string, string> = { NODE_ENV: "production" };
  const secrets: string[] = [];
  let example = "";
  try { example = fs.readFileSync(path.join(serverDir, ".env.example"), "utf8"); } catch { return { config, secrets }; }
  for (const line of example.split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match || RESERVED_ENV.test(match[1]) || match[1] === "NODE_ENV") continue;
    const [, name, raw] = match;
    const value = raw.trim().replace(/^["']|["']$/g, "");
    if (/URL/.test(name)) {
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(value)) continue;
      if (/^https?:\/\/[^\s@]+$/.test(value)) config[name] = value;
      continue;
    }
    secrets.push(name);
  }
  return { config, secrets: secrets.sort() };
}

export interface DeploymentSetupInput {
  hostname: string;
  zone: string;
  environment?: "staging" | "production";
}

/** The manifest for one static site, in the shape todo-app's hand-written one proved. */
export function draftStaticManifest(detection: DeploymentSetupDetection, input: DeploymentSetupInput): Record<string, unknown> {
  if (!detection.recipe || !detection.app || !detection.repository) throw new DeploymentSetupError(detection.blockers[0] ?? "this project cannot use the static recipe", "setup-blocked");
  const hostname = input.hostname.trim().toLowerCase();
  const zone = input.zone.trim().toLowerCase();
  const environment = input.environment ?? "staging";
  if (!HOSTNAME.test(hostname)) throw new DeploymentSetupError("Enter a hostname such as shop.example.com.", "setup-hostname");
  if (!HOSTNAME.test(zone) || !(hostname === zone || hostname.endsWith(`.${zone}`))) throw new DeploymentSetupError("The DNS zone must be the domain the hostname belongs to, such as example.com.", "setup-zone");
  const record = hostname === zone ? "@" : hostname.slice(0, -(zone.length + 1));
  const root = `/var/www/${hostname}`;
  const namespace = zone.split(".")[0];
  const targetId = `${namespace}:${slug(detection.repository.split("/")[1])}-${environment}-web`;
  const url = (suffix: string) => `https://${hostname}${suffix}`;
  const probe = (id: string, suffix: string, status: number) => ({ id, kind: "http-status@1", request: { url: url(suffix), method: "GET", timeoutMs: 5000 }, expect: { status } });
  return {
    apiVersion: "psm.werewolf.solutions/deployments/v1",
    kind: "DeploymentManifest",
    projectId: detection.projectId,
    environments: [{
      id: environment,
      risk: environment,
      releasePolicy: { allowedBranch: detection.branch ?? "main", requireReachableFromBranch: false, requireChecks: false, approval: "none" },
      connections: { github: { kind: "github-actions@1" }, dns: { kind: "digitalocean-api@1" }, host: { kind: "ssh-host-helper@1" } },
      dependencies: [],
      resources: [
        { id: "dns", kind: "digitalocean-dns-record@1", connection: "dns", desired: { zone, type: "A", name: record, valueFrom: { connection: "host", field: "address" }, ttl: 300 } },
        { id: "directory", kind: "host-release-directory@1", connection: "host", dependsOn: ["resource:dns"], desired: { root, retainReleases: 5 } },
        { id: "ingress", kind: "nginx-static-site@1", connection: "host", dependsOn: ["resource:dns", "resource:directory"], desired: { hostname, documentRoot: `${root}/current`, spaFallback: true, denyPrefixes: ["/api/"], cachePolicy: "vite-hashed", securityHeaders: "werewolf-static-spa@1" } },
        { id: "certificate", kind: "letsencrypt-certificate@1", connection: "host", dependsOn: ["resource:dns", "resource:ingress#http-ready"], desired: { hostname, renewal: "automatic" } },
      ],
      units: [{
        id: "web",
        recipe: "static-ssh-nginx@1",
        resourceRefs: ["resource:dns", "resource:directory", "resource:ingress", "resource:certificate"],
        artifact: { kind: "static-files@1", output: detection.app.output, buildProfile: { id: environment, publicInputs: {} } },
        executor: { kind: "github-actions@1", connection: "github", sourceRepository: detection.repository, prepareWorkflow: path.basename(BUILD_WORKFLOW), releaseController: "werewolf-static@1" },
        target: { kind: "ssh-release-directory@1", targetId, observerConnection: "host", root },
        verification: [
          probe("home", "/", 200),
          // A static site answers no API: nginx must refuse /api/ rather than serve the SPA shell.
          probe("api-sealed", "/api/", 404),
          { id: "release-metadata", kind: "release-metadata@1", request: { url: url("/version.json"), method: "GET", timeoutMs: 5000 }, expect: { commit: "$release.commit", psmArtifactId: "$release.psmArtifactId", version: "$release.version" } },
        ],
      }],
      watch: [],
      policy: { planTtlSeconds: 900, rollbackOnVerificationFailure: true, allowDelete: false, requireFreshWatchBeforeRelease: false },
    }],
  };
}

/** The manifest for a client + Express server, in the shape the Node-service recipe expects. */
export function draftNodeServiceManifest(detection: DeploymentSetupDetection, input: DeploymentSetupInput): Record<string, unknown> {
  if (detection.recipe !== "node-service-ssh-nginx@1" || !detection.service || !detection.repository) {
    throw new DeploymentSetupError(detection.blockers[0] ?? "this project cannot use the Node-service recipe", "setup-blocked");
  }
  const hostname = input.hostname.trim().toLowerCase();
  const zone = input.zone.trim().toLowerCase();
  const environment = input.environment ?? "staging";
  if (!HOSTNAME.test(hostname)) throw new DeploymentSetupError("Enter a hostname such as shop.example.com.", "setup-hostname");
  if (!HOSTNAME.test(zone) || !(hostname === zone || hostname.endsWith(`.${zone}`))) throw new DeploymentSetupError("The DNS zone must be the domain the hostname belongs to, such as example.com.", "setup-zone");
  const record = hostname === zone ? "@" : hostname.slice(0, -(zone.length + 1));
  const root = `/srv/${hostname}`;
  const targetId = `${zone.split(".")[0]}:${slug(detection.repository.split("/")[1])}-${environment}-web`;
  const url = (suffix: string) => `https://${hostname}${suffix}`;
  const service = detection.service;
  // The app's own public URL follows the hostname being set up.
  const config = Object.fromEntries(Object.entries(service.config).map(([name, value]) => [name, /^FRONTEND_URL/.test(name) ? url("") : value]));
  const probe = (id: string, suffix: string, status: number) => ({ id, kind: "http-status@1", request: { url: url(suffix), method: "GET", timeoutMs: 5000 }, expect: { status } });
  const resources: Record<string, unknown>[] = [
    { id: "dns", kind: "digitalocean-dns-record@1", connection: "dns", desired: { zone, type: "A", name: record, valueFrom: { connection: "host", field: "address" }, ttl: 300 } },
    { id: "directory", kind: "host-release-directory@1", connection: "host", dependsOn: ["resource:dns"], desired: { root, retainReleases: 5 } },
    { id: "service", kind: "systemd-node-service@1", connection: "host", dependsOn: ["resource:directory"], desired: { entry: service.entry, healthPath: "/healthz", startupTimeoutSeconds: 20, memoryMaxMb: 256, config } },
    ...(service.secrets.length ? [{ id: "secrets", kind: "service-secrets@1", connection: "host", dependsOn: ["resource:service"], desired: { names: service.secrets } }] : []),
    { id: "ingress", kind: "nginx-node-proxy@1", connection: "host", dependsOn: ["resource:dns", "resource:service"], desired: { hostname, securityHeaders: "app-managed@1", maxBodyMb: 10 } },
    { id: "certificate", kind: "letsencrypt-certificate@1", connection: "host", dependsOn: ["resource:dns", "resource:ingress#http-ready"], desired: { hostname, renewal: "automatic" } },
  ];
  return {
    apiVersion: "psm.werewolf.solutions/deployments/v1",
    kind: "DeploymentManifest",
    projectId: detection.projectId,
    environments: [{
      id: environment,
      risk: environment,
      releasePolicy: { allowedBranch: detection.branch ?? "main", requireReachableFromBranch: false, requireChecks: false, approval: "none" },
      connections: { github: { kind: "github-actions@1" }, dns: { kind: "digitalocean-api@1" }, host: { kind: "ssh-host-helper@1" } },
      dependencies: [],
      resources,
      units: [{
        id: "web",
        recipe: "node-service-ssh-nginx@1",
        resourceRefs: resources.map((resource) => `resource:${resource.id}`),
        artifact: {
          kind: "node-service@1", runtime: "node@22", install: service.install, buildScript: service.buildScript,
          serviceRoot: service.root, entry: service.entry, publicDir: service.publicDir,
          buildProfile: { id: environment, publicInputs: {} },
        },
        executor: { kind: "github-actions@1", connection: "github", sourceRepository: detection.repository, prepareWorkflow: path.basename(SERVICE_BUILD_WORKFLOW), releaseController: "werewolf-static@1" },
        target: { kind: "ssh-release-directory@1", targetId, observerConnection: "host", root },
        verification: [
          probe("home", "/", 200),
          probe("health", "/healthz", 200),
          { id: "release-metadata", kind: "release-metadata@1", request: { url: url("/version.json"), method: "GET", timeoutMs: 5000 }, expect: { commit: "$release.commit", psmArtifactId: "$release.psmArtifactId", version: "$release.version" } },
        ],
      }],
      watch: [],
      policy: { planTtlSeconds: 900, rollbackOnVerificationFailure: true, allowDelete: false, requireFreshWatchBeforeRelease: false },
    }],
  };
}

/**
 * The build workflow for a Node service: install each lockfile, build, reinstall
 * the service's production dependencies as plain files with no install scripts,
 * then package app + exact runtime as one bundle.
 */
export function nodeServiceBuildWorkflow(service: NonNullable<DeploymentSetupDetection["service"]>, runtimeMajor = "22"): string {
  const locks = service.install.map((dir) => dir === "." ? "package-lock.json" : `${dir}/package-lock.json`);
  const contract = [
    "PSM_RUN_ID: ${{ inputs.psm_run_id }}",
    "PSM_ARTIFACT_ID: ${{ inputs.psm_artifact_id }}",
    "PSM_PROJECT_ID: ${{ inputs.project_id }}",
    "PSM_ENVIRONMENT_ID: ${{ inputs.environment_id }}",
    "PSM_UNIT_ID: ${{ inputs.unit_id }}",
    "PSM_COMMIT_SHA: ${{ inputs.commit_sha }}",
    "PSM_MANIFEST_DIGEST: ${{ inputs.manifest_digest }}",
    "PSM_BUILD_PROFILE_JSON: ${{ inputs.build_profile_json }}",
    "PSM_BUILD_PROFILE_DIGEST: ${{ inputs.build_profile_digest }}",
    `PSM_SERVICE_ROOT: ${service.root}`,
    `PSM_SERVICE_ENTRY: ${service.entry}`,
    `PSM_SERVICE_PUBLIC: ${service.publicDir}`,
    `PSM_RUNTIME_MAJOR: "${runtimeMajor}"`,
  ].map((line) => `          ${line}`).join("\n");
  const installs = service.install.map((dir) => `      - name: Install ${dir === "." ? "root" : dir} dependencies
        working-directory: ${dir}
        run: npm ci`).join("\n\n");
  return `# Written by PSM's managed deployment setup. PSM dispatches it with a contract,
# builds the exact commit, and reads back one service bundle and one result.
name: Prepare managed Node service
run-name: prepare \${{ inputs.psm_run_id }}

on:
  workflow_dispatch:
    inputs:
      psm_run_id: { required: true, type: string }
      psm_artifact_id: { required: true, type: string }
      project_id: { required: true, type: string }
      environment_id: { required: true, type: string }
      unit_id: { required: true, type: string }
      commit_sha: { required: true, type: string }
      manifest_digest: { required: true, type: string }
      build_profile_json: { required: true, type: string }
      build_profile_digest: { required: true, type: string }

permissions:
  contents: read

concurrency:
  group: prepare-\${{ inputs.psm_run_id }}
  cancel-in-progress: false

jobs:
  prepare:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          ref: \${{ inputs.commit_sha }}
          persist-credentials: false

      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: ${runtimeMajor}
          cache: npm
          cache-dependency-path: |
${locks.map((lock) => `            ${lock}`).join("\n")}

      - name: Validate contract and expose public build inputs
        env:
${contract}
        run: node ${SERVICE_PREPARE_SCRIPT} environment >> "$GITHUB_ENV"

${installs}

      - name: Build
        run: npm run ${service.buildScript}

      # Production dependencies only, as plain files (no .bin links), and no
      # install scripts: the bundle runs on another machine with no compiler.
      - name: Install production dependencies of the service
        working-directory: ${service.root}
        run: |
          rm -rf node_modules
          npm ci --omit=dev --install-links --no-bin-links --ignore-scripts

      - name: Package app and runtime, and independently identify the bundle
        env:
${contract}
        run: node ${SERVICE_PREPARE_SCRIPT} prepare

      - name: Upload immutable transport archive
        id: payload
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: \${{ inputs.psm_artifact_id }}
          path: \${{ runner.temp }}/psm-service-artifact/payload.tar
          if-no-files-found: error
          compression-level: 6
          retention-days: 30

      - name: Finalize redacted result
        env:
          PSM_GITHUB_ARTIFACT_ID: \${{ steps.payload.outputs.artifact-id }}
          PSM_GITHUB_RUN_ID: \${{ github.run_id }}
        run: node ${SERVICE_PREPARE_SCRIPT} result

      - name: Upload result contract separately
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: \${{ inputs.psm_artifact_id }}-result
          path: \${{ runner.temp }}/psm-service-artifact/psm-artifact-result.json
          if-no-files-found: error
          compression-level: 9
          retention-days: 30
`;
}

/** The build workflow for a Vite app in `appDir`; the prepare script reads the rest from its inputs. */
export function staticBuildWorkflow(appDir: string, output: string): string {
  const working = appDir || ".";
  const lock = appDir ? `${appDir}/package-lock.json` : "package-lock.json";
  const contract = [
    "PSM_RUN_ID: ${{ inputs.psm_run_id }}",
    "PSM_ARTIFACT_ID: ${{ inputs.psm_artifact_id }}",
    "PSM_PROJECT_ID: ${{ inputs.project_id }}",
    "PSM_ENVIRONMENT_ID: ${{ inputs.environment_id }}",
    "PSM_UNIT_ID: ${{ inputs.unit_id }}",
    "PSM_COMMIT_SHA: ${{ inputs.commit_sha }}",
    "PSM_MANIFEST_DIGEST: ${{ inputs.manifest_digest }}",
    "PSM_BUILD_PROFILE_JSON: ${{ inputs.build_profile_json }}",
    "PSM_BUILD_PROFILE_DIGEST: ${{ inputs.build_profile_digest }}",
    `PSM_STATIC_OUTPUT: ${output}`,
  ].map((line) => `          ${line}`).join("\n");
  return `# Written by PSM's managed deployment setup. PSM dispatches it with a contract,
# builds the exact commit, and reads back one artifact and one result.
name: Prepare managed static artifact
run-name: prepare \${{ inputs.psm_run_id }}

on:
  workflow_dispatch:
    inputs:
      psm_run_id: { required: true, type: string }
      psm_artifact_id: { required: true, type: string }
      project_id: { required: true, type: string }
      environment_id: { required: true, type: string }
      unit_id: { required: true, type: string }
      commit_sha: { required: true, type: string }
      manifest_digest: { required: true, type: string }
      build_profile_json: { required: true, type: string }
      build_profile_digest: { required: true, type: string }

permissions:
  contents: read

concurrency:
  group: prepare-\${{ inputs.psm_run_id }}
  cancel-in-progress: false

jobs:
  prepare:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          ref: \${{ inputs.commit_sha }}
          persist-credentials: false

      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: ${lock}

      - name: Validate contract and expose public build inputs
        env:
${contract}
        run: node ${PREPARE_SCRIPT} environment >> "$GITHUB_ENV"

      - name: Install dependencies
        working-directory: ${working}
        run: npm ci

      - name: Build
        working-directory: ${working}
        run: npm run build

      - name: Package and independently identify served bytes
        env:
${contract}
        run: node ${PREPARE_SCRIPT} prepare

      - name: Upload immutable transport archive
        id: payload
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: \${{ inputs.psm_artifact_id }}
          path: \${{ runner.temp }}/psm-static-artifact/payload.tar
          if-no-files-found: error
          compression-level: 0
          retention-days: 30

      - name: Finalize redacted result
        env:
          PSM_GITHUB_ARTIFACT_ID: \${{ steps.payload.outputs.artifact-id }}
          PSM_GITHUB_RUN_ID: \${{ github.run_id }}
        run: node ${PREPARE_SCRIPT} result

      - name: Upload result contract separately
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: \${{ inputs.psm_artifact_id }}-result
          path: \${{ runner.temp }}/psm-static-artifact/psm-artifact-result.json
          if-no-files-found: error
          compression-level: 9
          retention-days: 30
`;
}

/** The generic prepare script shipped with PSM, identical for every static project. */
export function staticPrepareScript(): string {
  return fs.readFileSync(new URL("./templates/prepare-static-artifact.mjs", import.meta.url), "utf8");
}

/** The prepare script shipped with PSM for every Node service project. */
export function nodeServicePrepareScript(): string {
  return fs.readFileSync(new URL("./templates/prepare-node-service.mjs", import.meta.url), "utf8");
}

/** Validate the draft exactly as a plan would, then write it and its build files. */
export function writeDeploymentSetup(
  project: { id: string; name: string; path: string },
  input: DeploymentSetupInput,
): { files: string[]; skipped: string[] } {
  const detection = detectDeploymentSetup(project);
  if (detection.manifestExists) throw new DeploymentSetupError("This project already has a deployment manifest.", "setup-exists");
  const service = detection.recipe === "node-service-ssh-nginx@1";
  const manifest = service ? draftNodeServiceManifest(detection, input) : draftStaticManifest(detection, input);
  const root = fs.realpathSync(project.path);
  const issues = deploymentManifestIssues(manifest, { projectRoot: root, expectedProjectId: project.id, identityProjectId: project.id, packageVersion: detection.version ?? "" });
  if (issues.length) throw new DeploymentSetupError(`The drafted manifest is invalid: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`, "setup-invalid");
  const planned: Array<[string, string]> = service ? [
    [SERVICE_PREPARE_SCRIPT, nodeServicePrepareScript()],
    [SERVICE_BUILD_WORKFLOW, nodeServiceBuildWorkflow(detection.service!)],
  ] : [
    [PREPARE_SCRIPT, staticPrepareScript()],
    [BUILD_WORKFLOW, staticBuildWorkflow(detection.app!.dir, detection.app!.output)],
  ];
  planned.push(
    // The manifest is the switch that exposes this as managed. Publish it last.
    [".psm/deployments.json", `${JSON.stringify(manifest, null, 2)}\n`],
  );
  const files: string[] = [];
  // A pre-existing workflow or script might not honor this contract. Do not
  // declare the project managed while silently retaining incompatible files.
  for (const [relative] of planned) {
    const target = path.join(root, relative);
    if (fs.existsSync(target)) throw new DeploymentSetupError(
      relative === ".psm/deployments.json"
        ? "This project already has a deployment manifest."
        : `${relative} already exists. Review it before using PSM's generated deployment setup.`,
      relative === ".psm/deployments.json" ? "setup-exists" : "setup-file-exists",
    );
  }
  try {
    for (const [relative, content] of planned) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, { flag: "wx", mode: 0o644 });
      files.push(relative);
    }
  } catch (error) {
    for (const relative of files.reverse()) fs.rmSync(path.join(root, relative), { force: true });
    throw error;
  }
  return { files, skipped: [] };
}

/** Add a separately scoped target without replacing the first environment. */
export function addDeploymentEnvironment(
  project: { id: string; name: string; path: string },
  input: DeploymentSetupInput,
): { files: string[]; environment: string } {
  const root = fs.realpathSync(project.path);
  const loaded = loadDeploymentManifest(root, project.id);
  if (!loaded) throw new DeploymentSetupError("Create deployment setup first.", "setup-missing");
  const environment = input.environment ?? "staging";
  if (loaded.manifest.environments.some((entry) => entry.id === environment)) {
    throw new DeploymentSetupError(`${environment} already exists.`, "setup-exists");
  }
  const detection = detectDeploymentSetup(project);
  const recipe = loaded.manifest.environments[0]?.units[0]?.recipe;
  const drafted = recipe === "node-service-ssh-nginx@1"
    ? draftNodeServiceManifest(detection, input)
    : recipe === "static-ssh-nginx@1" ? draftStaticManifest(detection, input)
      : null;
  if (!drafted) throw new DeploymentSetupError("This manifest uses a recipe the environment wizard cannot draft.", "setup-recipe");
  const next = (drafted.environments as Record<string, unknown>[])[0];
  if (environment === "production") {
    (next.releasePolicy as Record<string, unknown>).approval = "authenticated-local-operator";
    (next.policy as Record<string, unknown>).requireFreshWatchBeforeRelease = true;
    (next.connections as Record<string, unknown>).monitor = { kind: "external-monitor@1" };
    next.watch = [{ id: "watch-web", kind: "external-http-monitor@1", connection: "monitor", unit: "web", monitorKey: `${detection.projectId}:production:web`, hostname: input.hostname.trim().toLowerCase(), maxObservationAgeSeconds: 180 }];
  }
  const hostname = input.hostname.trim().toLowerCase();
  if (loaded.manifest.environments.some((entry) => entry.resources.some((resource) => "hostname" in resource.desired && resource.desired.hostname === hostname))) {
    throw new DeploymentSetupError("Use a hostname distinct from existing environments.", "setup-hostname-conflict");
  }
  const manifest = { ...loaded.manifest, environments: [...loaded.manifest.environments, next] };
  const issues = deploymentManifestIssues(manifest, { projectRoot: root, expectedProjectId: project.id, identityProjectId: project.id, packageVersion: detection.version ?? "" });
  if (issues.length) throw new DeploymentSetupError(`The new environment is invalid: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`, "setup-invalid");
  const file = loaded.manifestPath;
  const previous = fs.readFileSync(file, "utf8");
  const temporary = path.join(path.dirname(file), `.deployments-${process.pid}-${Date.now()}.tmp`);
  try {
    // Refuse to replace a concurrent edit made while the operator reviewed the form.
    if (fs.readFileSync(file, "utf8") !== previous) throw new DeploymentSetupError("The manifest changed. Review it and try again.", "setup-changed");
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return { files: [".psm/deployments.json"], environment };
}
