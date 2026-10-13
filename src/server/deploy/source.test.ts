import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactOutputPath,
  bumpWorkspaceVersion,
  commitReachableFrom,
  compareWorkspaceVersions,
  deploymentInputsDirty,
  proposedDeploymentVersion,
  readDeploymentSource,
} from "./source.ts";

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-deploy-source-"));
  fs.mkdirSync(path.join(root, ".psm"));
  fs.writeFileSync(
    path.join(root, ".psm", "identity.json"),
    JSON.stringify({ version: 1, id: "prj_0123456789abcdefabcd", name: "demo", createdAt: 1 }) + "\n",
  );
  fs.writeFileSync(
    path.join(root, ".psm", "deployments.json"),
    JSON.stringify({ apiVersion: "psm.werewolf.solutions/deployments/v1", kind: "DeploymentManifest", projectId: "prj_0123456789abcdefabcd", environments: [] }) + "\n",
  );
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"demo","version":"0.1.0"}\n');
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "initial"]);
  return root;
}

test("deployment source reads identity, manifest and version from the exact commit", () => {
  const root = repository();
  const source = readDeploymentSource(root);
  assert.match(source.commit, /^[0-9a-f]{40}$/);
  assert.equal(source.projectId, "prj_0123456789abcdefabcd");
  assert.equal(source.version, "0.1.0");
  assert.equal(commitReachableFrom(root, source.commit, "HEAD"), true);

  fs.writeFileSync(path.join(root, "package.json"), '{"name":"demo","version":"9.9.9"}\n');
  assert.equal(readDeploymentSource(root).version, "0.1.0", "dirty worktree cannot change exact source");
  assert.equal(deploymentInputsDirty(root), true);
});

test("workspace versions use the house X.Y.Z ordering", () => {
  assert.equal(compareWorkspaceVersions("0.3.0", "0.2.99"), 1);
  assert.equal(compareWorkspaceVersions("0.2.2", "0.2.2"), 0);
  assert.equal(compareWorkspaceVersions("0.2.1", "0.2.2"), -1);
  assert.throws(() => compareWorkspaceVersions("v0.2.1", "0.2.2"));
});

test("deployment previews a patch floor while the managed commit can select a larger bump", () => {
  assert.equal(proposedDeploymentVersion("1.0.4", "1.0.4"), "1.0.5");
  assert.equal(proposedDeploymentVersion("1.0.4", "1.1.0"), "1.1.0");
  assert.equal(proposedDeploymentVersion("1.0.4", "0.9.0"), "1.0.5");
  assert.equal(bumpWorkspaceVersion("1.0.4", "major"), "2.0.0");
  assert.equal(bumpWorkspaceVersion("1.0.4", "minor"), "1.1.0");
  assert.equal(bumpWorkspaceVersion("1.0.4", "patch"), "1.0.5");
});

test("artifact output cannot escape its checkout", () => {
  const root = repository();
  assert.equal(artifactOutputPath(root, "client/dist"), path.join(root, "client", "dist"));
  assert.throws(() => artifactOutputPath(root, "../outside"));
  assert.throws(() => artifactOutputPath(root, "/tmp/outside"));
});

test("uncommitted application files are detected even when deployment metadata is unchanged", () => {
  const root = repository();
  assert.equal(deploymentInputsDirty(root), false);
  fs.writeFileSync(path.join(root, "new-code.js"), "export const fixed = true;\n");
  assert.equal(deploymentInputsDirty(root), true);
  execFileSync("git", ["-C", root, "add", "new-code.js"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "new code"]);
  assert.equal(deploymentInputsDirty(root), false);
  fs.writeFileSync(path.join(root, "new-code.js"), "export const fixed = false;\n");
  assert.equal(deploymentInputsDirty(root), true);
});
