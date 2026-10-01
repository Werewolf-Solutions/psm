import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadDeploymentManifest } from "./manifest.ts";
import { BUILD_WORKFLOW, detectDeploymentSetup, draftStaticManifest, githubRepository, PREPARE_SCRIPT, writeDeploymentSetup } from "./setup.ts";

const PROJECT_ID = "prj_a1557b3e3e9c57129fa8";

function checkout(t: test.TestContext, files: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-setup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, value] of Object.entries({ ".psm/identity.json": { version: 1, id: PROJECT_ID, name: "shop" }, ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), typeof value === "string" ? value : JSON.stringify(value));
  }
  execFileSync("git", ["-C", root, "init", "-q", "-b", "master"]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "git@github.com:Werewolf-Solutions/shop.git"]);
  return { id: PROJECT_ID, name: "Shop", path: root };
}

const staticApp = {
  "package.json": { name: "shop", version: "1.2.0", scripts: { build: "cd client && npm run build" } },
  "client/package.json": { name: "client", scripts: { build: "vite build" }, devDependencies: { vite: "^7.0.0" } },
};

test("GitHub remotes in SSH and HTTPS form name the same repository", () => {
  assert.equal(githubRepository("git@github.com:Werewolf-Solutions/handymanservices.git"), "Werewolf-Solutions/handymanservices");
  assert.equal(githubRepository("https://github.com/Werewolf-Solutions/todo-app"), "Werewolf-Solutions/todo-app");
  assert.equal(githubRepository("https://gitlab.com/a/b.git"), null);
});

test("a static Vite project gets a manifest that passes the plan parser, and its build files", (t) => {
  const project = checkout(t, staticApp);
  const detection = detectDeploymentSetup(project);
  assert.deepEqual({ recipe: detection.recipe, app: detection.app, repository: detection.repository, branch: detection.branch, blockers: detection.blockers },
    { recipe: "static-ssh-nginx@1", app: { dir: "client", output: "client/dist" }, repository: "Werewolf-Solutions/shop", branch: "master", blockers: [] });

  const written = writeDeploymentSetup(project, { hostname: "shop.werewolf.solutions", zone: "werewolf.solutions" });
  assert.deepEqual(written.files, [PREPARE_SCRIPT, BUILD_WORKFLOW, ".psm/deployments.json"]);
  const loaded = loadDeploymentManifest(project.path, PROJECT_ID);
  const unit = loaded?.manifest.environments[0].units[0];
  assert.equal(unit?.target.targetId, "werewolf:shop-staging-web");
  assert.equal((unit?.artifact as { output?: string } | undefined)?.output, "client/dist");
  assert.match(fs.readFileSync(path.join(project.path, BUILD_WORKFLOW), "utf8"), /PSM_STATIC_OUTPUT: client\/dist/);
  assert.doesNotMatch(fs.readFileSync(path.join(project.path, PREPARE_SCRIPT), "utf8"), /client/);

  assert.throws(() => writeDeploymentSetup(project, { hostname: "shop.werewolf.solutions", zone: "werewolf.solutions" }), /already has a deployment manifest/);
});

test("an existing build workflow blocks setup without overwriting it or leaving a manifest", (t) => {
  const project = checkout(t, { ...staticApp, [BUILD_WORKFLOW]: "name: mine\n" });
  assert.throws(() => writeDeploymentSetup(project, { hostname: "shop.werewolf.solutions", zone: "werewolf.solutions" }), /already exists/);
  assert.equal(fs.readFileSync(path.join(project.path, BUILD_WORKFLOW), "utf8"), "name: mine\n");
  assert.equal(fs.existsSync(path.join(project.path, ".psm/deployments.json")), false);
});

test("an Express project that is not ready for the Node-service recipe gets each step it needs", (t) => {
  // handymanservices, observed 2026-09-29: a Vite client whose production build calls
  // same-origin /api routes served by Express under PM2.
  const project = checkout(t, { ...staticApp, "server/package.json": { name: "server", dependencies: { express: "^4.21.0" } } });
  const detection = detectDeploymentSetup(project);
  assert.equal(detection.recipe, null);
  assert.deepEqual(detection.server, { dir: "server", framework: "express" });
  const blockers = detection.blockers.join(" ");
  assert.match(blockers, /start script of the form `node <file>`/);
  assert.match(blockers, /no package-lock.json/);
  assert.match(blockers, /server.listen\(port, process.env.HOST\)/);
  assert.match(blockers, /GET \/healthz/);
  assert.throws(() => draftStaticManifest(detection, { hostname: "shop.werewolf.solutions", zone: "werewolf.solutions" }), /start script/);
  assert.equal(fs.existsSync(path.join(project.path, ".psm/deployments.json")), false);
});

const expressApp = {
  ...staticApp,
  "package.json": { name: "shop", version: "1.2.0", scripts: { build: "cd client && npm run build && cp -r client/dist/. server/public/" } },
  "package-lock.json": "{}",
  "client/package-lock.json": "{}",
  "server/package.json": { name: "server", scripts: { start: "node ./bin/www" }, dependencies: { express: "^4.21.0" } },
  "server/package-lock.json": "{}",
  "server/public/robots.txt": "User-agent: *\n",
  "server/bin/www": "const server = http.createServer(app);\nserver.listen(port, process.env.HOST);\n",
  "server/app.js": "app.get('/healthz', (req, res) => res.sendStatus(200));\n",
  "server/.env.example": "PORT=3000\nFRONTEND_URL=http://localhost:5174\nFRONTEND_URL_PROD=https://shop.example.com/\nWEREWOLF_API_URL=https://werewolf.solutions/api/v1\nWEREWOLF_API_URL_DEV=http://localhost:3000/api/v1\nAPI_KEY=your-key\nBUSINESS_ID=your-business\n",
  "server/.env": "API_KEY=sk-live-must-not-be-read\n",
};

test("a client + Express project gets a Node-service manifest, its build workflow and a config/secret split", (t) => {
  const project = checkout(t, expressApp);
  const detection = detectDeploymentSetup(project);
  assert.deepEqual(detection.blockers, []);
  assert.equal(detection.recipe, "node-service-ssh-nginx@1");
  assert.deepEqual(detection.service, {
    root: "server", entry: "bin/www", publicDir: "public", install: [".", "client", "server"], buildScript: "build",
    config: { NODE_ENV: "production", FRONTEND_URL_PROD: "https://shop.example.com/", WEREWOLF_API_URL: "https://werewolf.solutions/api/v1" },
    secrets: ["API_KEY", "BUSINESS_ID"],
  });
  assert.ok(!JSON.stringify(detection).includes("sk-live"), "the real .env is never read");
  const written = writeDeploymentSetup(project, { hostname: "shop.werewolf.solutions", zone: "werewolf.solutions" });
  assert.deepEqual(written.files, [".psm/scripts/prepare-node-service.mjs", ".github/workflows/build-node-service.yml", ".psm/deployments.json"]);
  const loaded = loadDeploymentManifest(project.path, PROJECT_ID)!;
  const environment = loaded.manifest.environments[0];
  const service = environment.resources.find((resource) => resource.kind === "systemd-node-service@1");
  assert.deepEqual(service?.kind === "systemd-node-service@1" && service.desired.config, {
    FRONTEND_URL_PROD: "https://shop.werewolf.solutions", NODE_ENV: "production", WEREWOLF_API_URL: "https://werewolf.solutions/api/v1",
  }, "the app's own URL follows the hostname being set up");
  assert.equal(environment.units[0].recipe, "node-service-ssh-nginx@1");
  assert.equal(environment.units[0].target.root, "/srv/shop.werewolf.solutions");
  const workflow = fs.readFileSync(path.join(project.path, ".github/workflows/build-node-service.yml"), "utf8");
  assert.match(workflow, /npm ci --omit=dev --install-links --no-bin-links --ignore-scripts/);
  assert.match(workflow, /PSM_SERVICE_ENTRY: bin\/www/);
  assert.match(workflow, /run-name: prepare \$\{\{ inputs.psm_run_id \}\}/);
  assert.match(workflow, /client\/package-lock.json/);
});

test("a hostname outside its DNS zone is refused before anything is written", (t) => {
  const project = checkout(t, staticApp);
  assert.throws(() => writeDeploymentSetup(project, { hostname: "shop.example.com", zone: "werewolf.solutions" }), /DNS zone/);
  assert.equal(fs.existsSync(path.join(project.path, ".psm/deployments.json")), false);
});
