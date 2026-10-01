import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadDeploymentManifest } from "./manifest.ts";
import { BUILD_WORKFLOW, detectDeploymentSetup, draftStaticManifest, githubRepository, PREPARE_SCRIPT, writeStaticDeploymentSetup } from "./setup.ts";

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

  const written = writeStaticDeploymentSetup(project, { hostname: "shop.werewolf.solutions", zone: "werewolf.solutions" });
  assert.deepEqual(written.files, [PREPARE_SCRIPT, BUILD_WORKFLOW, ".psm/deployments.json"]);
  const loaded = loadDeploymentManifest(project.path, PROJECT_ID);
  const unit = loaded?.manifest.environments[0].units[0];
  assert.equal(unit?.target.targetId, "werewolf:shop-staging-web");
  assert.equal(unit?.artifact.output, "client/dist");
  assert.match(fs.readFileSync(path.join(project.path, BUILD_WORKFLOW), "utf8"), /PSM_STATIC_OUTPUT: client\/dist/);
  assert.doesNotMatch(fs.readFileSync(path.join(project.path, PREPARE_SCRIPT), "utf8"), /client/);

  assert.throws(() => writeStaticDeploymentSetup(project, { hostname: "shop.werewolf.solutions", zone: "werewolf.solutions" }), /already has a deployment manifest/);
});

test("an existing build workflow blocks setup without overwriting it or leaving a manifest", (t) => {
  const project = checkout(t, { ...staticApp, [BUILD_WORKFLOW]: "name: mine\n" });
  assert.throws(() => writeStaticDeploymentSetup(project, { hostname: "shop.werewolf.solutions", zone: "werewolf.solutions" }), /already exists/);
  assert.equal(fs.readFileSync(path.join(project.path, BUILD_WORKFLOW), "utf8"), "name: mine\n");
  assert.equal(fs.existsSync(path.join(project.path, ".psm/deployments.json")), false);
});

test("a project that also runs its own API server is not drafted as a static site", (t) => {
  // handymanservices, observed 2026-09-29: a Vite client whose production build calls
  // same-origin /api routes served by Express under PM2.
  const project = checkout(t, { ...staticApp, "server/package.json": { name: "server", dependencies: { express: "^4.21.0" } } });
  const detection = detectDeploymentSetup(project);
  assert.equal(detection.recipe, null);
  assert.deepEqual(detection.server, { dir: "server", framework: "express" });
  assert.match(detection.blockers.join(" "), /its own express server in server\/.*P08/);
  assert.throws(() => draftStaticManifest(detection, { hostname: "shop.werewolf.solutions", zone: "werewolf.solutions" }), /express server/);
  assert.equal(fs.existsSync(path.join(project.path, ".psm/deployments.json")), false);
});

test("a hostname outside its DNS zone is refused before anything is written", (t) => {
  const project = checkout(t, staticApp);
  assert.throws(() => writeStaticDeploymentSetup(project, { hostname: "shop.example.com", zone: "werewolf.solutions" }), /DNS zone/);
  assert.equal(fs.existsSync(path.join(project.path, ".psm/deployments.json")), false);
});
