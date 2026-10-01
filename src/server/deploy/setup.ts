import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { deploymentManifestIssues } from "./manifest.ts";

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
  recipe: "static-ssh-nginx@1" | null;
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
  if (server) blockers.push(`This project also runs its own ${server.framework} server in ${server.dir === "." ? "the repository root" : `${server.dir}/`}. PSM's only recipe today serves static files, which would drop that server and every API it answers. Managed deployment of Node servers is roadmap phase P08; keep using the command deploy until then.`);

  const name = slug(project.name);
  return {
    projectId: project.id,
    manifestExists: fs.existsSync(path.join(root, ".psm", "deployments.json")),
    repository,
    branch,
    version,
    app,
    server,
    recipe: blockers.length ? null : "static-ssh-nginx@1",
    blockers,
    suggested: { environment: "staging", hostname: `${name}.werewolf.solutions`, zone: "werewolf.solutions" },
  };
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

/** Validate the draft exactly as a plan would, then write it and its build files. */
export function writeStaticDeploymentSetup(
  project: { id: string; name: string; path: string },
  input: DeploymentSetupInput,
): { files: string[]; skipped: string[] } {
  const detection = detectDeploymentSetup(project);
  if (detection.manifestExists) throw new DeploymentSetupError("This project already has a deployment manifest.", "setup-exists");
  const manifest = draftStaticManifest(detection, input);
  const root = fs.realpathSync(project.path);
  const issues = deploymentManifestIssues(manifest, { projectRoot: root, expectedProjectId: project.id, identityProjectId: project.id, packageVersion: detection.version ?? "" });
  if (issues.length) throw new DeploymentSetupError(`The drafted manifest is invalid: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`, "setup-invalid");
  const planned: Array<[string, string]> = [
    [PREPARE_SCRIPT, staticPrepareScript()],
    [BUILD_WORKFLOW, staticBuildWorkflow(detection.app!.dir, detection.app!.output)],
    // The manifest is the switch that exposes this as managed. Publish it last.
    [".psm/deployments.json", `${JSON.stringify(manifest, null, 2)}\n`],
  ];
  const files: string[] = [];
  // A pre-existing workflow or script might not honor this contract. Do not
  // declare the project managed while silently retaining incompatible files.
  for (const [relative] of planned) {
    const target = path.join(root, relative);
    if (fs.existsSync(target)) throw new DeploymentSetupError(
      relative === ".psm/deployments.json"
        ? "This project already has a deployment manifest."
        : `${relative} already exists. Review it before using PSM's generated static deployment setup.`,
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
