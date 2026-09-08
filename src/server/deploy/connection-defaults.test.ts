import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverConnectionDefaults } from "./connection-defaults.ts";
import type { ConnectionProfile } from "./connections.ts";
import type { EnvironmentManifest } from "./types.ts";

const environment = {
  id: "production", risk: "production", connections: { github: { kind: "github-actions@1" }, host: { kind: "ssh-host-helper@1" } },
  units: [{ executor: { connection: "github", sourceRepository: "example/site", prepareWorkflow: "build.yml" }, target: { targetId: "werewolf:site-production-web", observerConnection: "host", root: "/srv/site" } }],
} as unknown as EnvironmentManifest;
const input = { project: { id: "prj_example", name: "site", path: "/nonexistent" }, environment, slot: "github", profiles: [], projects: [], github: async () => ({}) };
const sha = "a".repeat(40);
const blob = "b".repeat(40);

test("known release defaults are suggested without inventing missing refs or hashes", async () => {
  const defaults = await discoverConnectionDefaults(input);
  assert.equal(defaults.values.controllerRepository, "Werewolf-Solutions/deployment-control");
  assert.equal(defaults.values.controllerWorkflow, "release-static.yml");
  assert.equal(defaults.values.githubEnvironment0, "site-production-web");
  assert.equal(defaults.values.controllerRef, undefined);
  assert.equal(defaults.values.controllerSha, undefined);
  assert.ok(defaults.notes.length);
});

test("GitHub metadata fills missing release settings when no local checkout is available", async () => {
  const defaults = await discoverConnectionDefaults({ ...input, github: async (repo, workflow, ref) => {
    assert.equal(repo, "Werewolf-Solutions/deployment-control");
    assert.equal(workflow, "release-static.yml");
    assert.equal(ref, undefined);
    return { ref: "main", commit: sha, blob };
  } });
  assert.equal(defaults.values.controllerRef, "main");
  assert.equal(defaults.values.controllerSha, sha);
  assert.equal(defaults.values.workflowSha, blob);
  assert.match(defaults.sources.controllerSha, /GitHub:/);
});

test("local discovery verifies the repository and reads the workflow hash at the selected release ref", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-connection-defaults-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("remote", "add", "origin", "git@github.com:Werewolf-Solutions/deployment-control.git");
  fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, ".github/workflows/release-static.yml"), "name: Release\non: workflow_dispatch\n");
  git("add", ".");
  git("commit", "-qm", "release workflow");
  git("tag", "v1");
  const options = { ...input, projects: [{ name: "deployment-control", path: root }] };
  const defaults = await discoverConnectionDefaults(options);
  assert.equal(defaults.values.controllerRef, "refs/tags/v1");
  assert.equal(defaults.values.controllerSha, git("rev-parse", "v1^{commit}"));
  assert.equal(defaults.values.workflowSha, git("rev-parse", "v1:.github/workflows/release-static.yml"));
  // A coincidentally named source checkout must never supply the controller's hashes.
  git("remote", "set-url", "origin", "https://github.com/example/site.git");
  assert.equal((await discoverConnectionDefaults(options)).values.controllerSha, undefined);
});

function saved(kind: string, publicMetadata: ConnectionProfile["publicMetadata"]): ConnectionProfile {
  return { connectionId: "saved", name: "Existing production", kind, metadataRevision: 1, requiredSecretSlots: ["apiToken"], publicMetadata,
    constraints: { allowedProjectIds: ["prj_example"], allowedEnvironmentIds: ["production"], maximumAuthorizedRisk: "production", allowedTargetIds: ["werewolf:site-production-web"] } };
}

test("saved release controller settings and reviewed pins take precedence over discovery", async () => {
  const profile = saved("github-actions@1", { releaseControllers: [{ targetId: "werewolf:site-production-web", repository: "example/controller", workflow: "deploy.yml", ref: "refs/tags/reviewed", expectedHeadSha: sha, expectedWorkflowBlobSha: blob, githubEnvironment: "live" }] });
  const defaults = await discoverConnectionDefaults({ ...input, profiles: [profile], github: async () => { throw new Error("complete saved pins must not be refreshed"); } });
  assert.equal(defaults.values.controllerRepository, "example/controller");
  assert.equal(defaults.values.controllerSha, sha);
  assert.equal(defaults.values.workflowSha, blob);
  assert.equal(defaults.values.githubEnvironment0, "live");
});

test("host defaults reuse only public settings from a compatible saved connection", async () => {
  const profile = saved("ssh-host-helper@1", { address: "192.0.2.1", knownHost: "host.example ssh-ed25519 public-key", targetContracts: { "werewolf:site-production-web": { fingerprint: `sha256:${"c".repeat(64)}`, revision: "7" } }, unrelatedSetting: "must-not-be-copied" });
  profile.constraints.ssh = { host: "host.example", user: "psm", port: 2222, hostKeyFingerprint: "SHA256:verified" };
  const defaults = await discoverConnectionDefaults({ ...input, slot: "host", profiles: [profile] });
  assert.equal(defaults.values.host, "host.example");
  assert.equal(defaults.values.port, "2222");
  assert.equal(defaults.values.revision0, "7");
  assert.ok(!JSON.stringify(defaults).includes("must-not-be-copied"));
  profile.constraints.allowedProjectIds = ["prj_unrelated"];
  assert.equal((await discoverConnectionDefaults({ ...input, slot: "host", profiles: [profile] })).values.host, undefined);
});

test("a release repository that does not exist is named as the obstacle, not worked around", async () => {
  const defaults = await discoverConnectionDefaults({ ...input, github: async () => ({ status: "repository-missing" as const }) });
  assert.equal(defaults.values.controllerSha, undefined);
  assert.equal(defaults.values.workflowSha, undefined);
  assert.ok(defaults.notes.some((note) => note.includes("does not exist yet") && note.includes("Werewolf-Solutions/deployment-control")));
  assert.ok(!defaults.notes.some((note) => note.includes("git rev-parse")));
});

test("the GitHub Environment is taken from the release repository instead of the target's name", async () => {
  const named = await discoverConnectionDefaults({ ...input, github: async () => ({ status: "ok" as const, ref: "main", commit: sha, blob, environments: ["site-production-web", "staging"] }) });
  assert.equal(named.values.githubEnvironment0, "site-production-web");
  assert.match(named.sources.githubEnvironment0, /Environment configured in/);
  // A single configured environment is unambiguous even when the target is named differently.
  const single = await discoverConnectionDefaults({ ...input, github: async () => ({ status: "ok" as const, ref: "main", commit: sha, blob, environments: ["production"] }) });
  assert.equal(single.values.githubEnvironment0, "production");
});

test("an unmatched GitHub Environment lists what the release repository actually configures", async () => {
  const defaults = await discoverConnectionDefaults({ ...input, github: async () => ({ status: "ok" as const, ref: "main", commit: sha, blob, environments: ["live", "preview"] }) });
  assert.equal(defaults.values.githubEnvironment0, "site-production-web");
  assert.ok(defaults.notes.some((note) => note.includes("live, preview")));
});
