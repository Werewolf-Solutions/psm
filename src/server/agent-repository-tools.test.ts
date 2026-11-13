import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { openDatabase } from "./db.ts";
import { AgentPermissionStore } from "./agent-permissions.ts";
import { RepositoryTools } from "./agent-repository-tools.ts";
import { taskInputs } from "./agent-task-inputs.ts";
import { managedAgentOptions } from "./agent-permission-runtime.ts";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-repository-tools-"));
  const database = openDatabase(":memory:");
  const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_test", name: "test", path: root };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  git("init", "-q"); git("config", "user.name", "PSM Test"); git("config", "user.email", "psm-test@example.invalid");
  fs.writeFileSync(path.join(root, "app.txt"), "before\n");
  fs.writeFileSync(path.join(root, "other.txt"), "unrelated\n");
  git("add", "."); git("commit", "-qm", "initial");
  for (const permission of ["repo.read", "repo.edit", "repo.delete", "git.commit", "git.branch", "git.switch", "git.merge", "git.fetch", "git.push"] as const) {
    store.change(project, permission, true, store.snapshot(project).revision, "operator");
  }
  const tools = new RepositoryTools(store.snapshot(project), store);
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, database, store, project, tools, git };
}

function versionedFixture(t: test.TestContext) {
  const kit = fixture(t);
  fs.writeFileSync(path.join(kit.root, "package.json"), JSON.stringify({ name: "app", version: "0.6.0" }, null, 2) + "\n");
  fs.writeFileSync(path.join(kit.root, "package-lock.json"), JSON.stringify({ name: "app", version: "0.6.0", lockfileVersion: 3, packages: { "": { name: "app", version: "0.6.0" }, "node_modules/dep": { version: "2.0.0" } } }, null, 2) + "\n");
  kit.git("add", "package.json", "package-lock.json"); kit.git("commit", "-qm", "initial version");
  return kit;
}

test("managed code commits assign the next version and synchronize only root lockfile versions", (t) => {
  const { tools, git } = versionedFixture(t);
  tools.write("app.txt", "fixed\n"); tools.write("other.txt", "unrelated edits\n");
  tools.stage(["app.txt"]);
  assert.match(tools.commit("fix calendar"), /release version 0.6.1/);
  assert.equal(JSON.parse(git("show", "HEAD:package.json")).version, "0.6.1");
  const lock = JSON.parse(git("show", "HEAD:package-lock.json"));
  assert.equal(lock.version, "0.6.1"); assert.equal(lock.packages[""].version, "0.6.1");
  assert.equal(lock.packages["node_modules/dep"].version, "2.0.0");
  assert.equal(git("show", "HEAD:other.txt"), "unrelated\n");
});

test("managed commits preserve an explicit newer version and sync its lockfile", (t) => {
  const { tools, git } = versionedFixture(t);
  tools.write("package.json", '{"name":"app","version":"0.7.0"}\n');
  tools.stage(["package.json"]); tools.commit("new work line");
  assert.equal(JSON.parse(git("show", "HEAD:package.json")).version, "0.7.0");
  assert.equal(JSON.parse(git("show", "HEAD:package-lock.json")).version, "0.7.0");
});

for (const [bump, expected] of [["major", "1.0.0"], ["minor", "0.7.0"]] as const) {
  test(`managed commits apply a selected ${bump} release bump`, (t) => {
    const { tools, git } = versionedFixture(t);
    tools.write("app.txt", "new behavior\n"); tools.stage(["app.txt"]);
    assert.match(tools.commit("new behavior", bump), new RegExp(`release version ${expected.replace(/\./g, "\\.")}`));
    assert.equal(JSON.parse(git("show", "HEAD:package.json")).version, expected);
    assert.equal(JSON.parse(git("show", "HEAD:package-lock.json")).version, expected);
  });
}

test("selected major bump takes precedence over a smaller staged version", (t) => {
  const { tools, git } = versionedFixture(t);
  tools.write("package.json", '{"name":"app","version":"0.6.1"}\n'); tools.stage(["package.json"]);
  tools.commit("breaking change", "major");
  assert.equal(JSON.parse(git("show", "HEAD:package.json")).version, "1.0.0");
});

test("documentation-only commits do not consume a release version", (t) => {
  const { tools, git } = versionedFixture(t);
  tools.write("README.md", "Updated docs\n"); tools.stage(["README.md"]); tools.commit("docs");
  assert.equal(JSON.parse(git("show", "HEAD:package.json")).version, "0.6.0");
});

test("version assignment preserves partially staged package edits and makes no writes", (t) => {
  const { tools, root, git } = versionedFixture(t);
  const before = git("rev-parse", "HEAD");
  const pkg = fs.readFileSync(path.join(root, "package.json"), "utf8");
  tools.write("app.txt", "fix\n"); tools.stage(["app.txt"]);
  tools.write("package-lock.json", '{"version":"9.0.0"}\n');
  assert.throws(() => tools.commit("fix"), /unstaged changes/);
  assert.equal(git("rev-parse", "HEAD"), before);
  assert.equal(fs.readFileSync(path.join(root, "package.json"), "utf8"), pkg);
  assert.equal(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"), '{"version":"9.0.0"}\n');
});

test("an externally committed change can receive a managed version-only release commit", (t) => {
  const { tools, git } = versionedFixture(t);
  tools.stage(["package.json"]); tools.commit("assign release version to external changes");
  assert.equal(JSON.parse(git("show", "HEAD:package.json")).version, "0.6.1");
});

test("automatic version changes require repo.edit even with commit permission", (t) => {
  const { root, project, store, git } = versionedFixture(t);
  store.change(project, "repo.edit", false, store.snapshot(project).revision, "operator");
  const tools = new RepositoryTools(store.snapshot(project), store);
  fs.writeFileSync(path.join(root, "app.txt"), "fix\n"); tools.stage(["app.txt"]);
  assert.throws(() => tools.commit("fix"), /repo.edit/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, "0.6.0");
  assert.equal(JSON.parse(git("show", "HEAD:package.json")).version, "0.6.0");
});

test("a staged version decrease requires an explicit rationale", (t) => {
  const { tools, git } = versionedFixture(t);
  tools.write("package.json", '{"name":"app","version":"0.5.0"}\n'); tools.stage(["package.json"]);
  assert.throws(() => tools.commit("fix"), /version-regression-reason/);
  assert.equal(JSON.parse(git("show", "HEAD:package.json")).version, "0.6.0");
  tools.commit("version-regression-reason: restore the previous release line");
  assert.equal(JSON.parse(git("show", "HEAD:package-lock.json")).version, "0.5.0");
});

test("untracked root lockfiles are preserved rather than silently committed", (t) => {
  const { tools, root, git } = versionedFixture(t);
  fs.writeFileSync(path.join(root, "npm-shrinkwrap.json"), '{"version":"0.6.0"}\n');
  tools.write("app.txt", "fix\n"); tools.stage(["app.txt"]);
  assert.throws(() => tools.commit("fix"), /untracked version file/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, "0.6.0");
  assert.equal(JSON.parse(git("show", "HEAD:package.json")).version, "0.6.0");
});

test("explicit staging and committing works without hooks, filters, or unrelated edits", (t) => {
  const { root, tools, git } = fixture(t);
  fs.writeFileSync(path.join(root, ".git/hooks/pre-commit"), "#!/bin/sh\ntouch hook-ran\nexit 1\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, ".gitattributes"), "*.txt filter=malicious\n");
  git("config", "filter.malicious.clean", "touch filter-ran; cat");
  tools.write("app.txt", "fixed\n");
  tools.write("other.txt", "user work remains\n");
  tools.gitRead("status");
  tools.gitRead("diff", "app.txt");
  tools.stage(["app.txt"]);
  tools.commit("fix source");
  assert.equal(git("show", "HEAD:app.txt"), "fixed\n");
  assert.equal(git("show", "HEAD:other.txt"), "unrelated\n");
  assert.equal(fs.readFileSync(path.join(root, "other.txt"), "utf8"), "user work remains\n");
  assert.equal(fs.existsSync(path.join(root, "hook-ran")), false);
  assert.equal(fs.existsSync(path.join(root, "filter-ran")), false);
});

test("pre-existing or subsequently changed staging is preserved and never committed", (t) => {
  const { root, tools, git } = fixture(t);
  fs.writeFileSync(path.join(root, "other.txt"), "operator staged\n");
  git("add", "other.txt");
  tools.write("app.txt", "repair\n");
  assert.throws(() => tools.stage(["app.txt"]), /outside this turn/);
  assert.equal(git("diff", "--cached", "--name-only").trim(), "other.txt");
  git("reset", "-q", "HEAD", "--", "other.txt");
  tools.stage(["app.txt"]);
  git("add", "other.txt");
  assert.throws(() => tools.commit("must not happen"), /index changed/);
  assert.equal(git("log", "-1", "--format=%s").trim(), "initial");
});

test("authority paths, traversal, symlinks and hard links are denied", (t) => {
  const { root, tools } = fixture(t);
  for (const file of ["../outside", "/tmp/outside", ".claude/settings.local.json", ".codex/config.toml", ".psm/identity.json", ".psm/capabilities.json", ".git/config", ".env", ".env.local", "private.key", ".psm-data/psm.db"]) {
    assert.throws(() => tools.write(file, "grant everything"), /protected|relative|operator-managed/);
  }
  fs.symlinkSync("app.txt", path.join(root, "alias"));
  assert.throws(() => tools.write("alias", "tampered"), /Symlinks/);
  fs.linkSync(path.join(root, "app.txt"), path.join(root, "hard"));
  assert.throws(() => tools.read("hard"), /hard-linked/);
});

test("revocation invalidates a live broker before its next write or commit", (t) => {
  const { tools, store, project, git } = fixture(t);
  tools.write("app.txt", "repair\n"); tools.stage(["app.txt"]);
  store.change(project, "git.commit", false, store.snapshot(project).revision, "operator");
  assert.throws(() => tools.commit("forbidden"), /permissions changed/);
  assert.throws(() => tools.write("app.txt", "another"), /permissions changed/);
  assert.equal(git("log", "-1", "--format=%s").trim(), "initial");
});

test("a project cannot borrow another project's grants", (t) => {
  const { root, store } = fixture(t);
  const tools = new RepositoryTools(store.snapshot({ id: "prj_other", name: "other", path: root }), store);
  assert.throws(() => tools.read("app.txt"), /has not granted/);
  assert.throws(() => tools.stage(["app.txt"]), /has not granted/);
});

test("file deletion is separately granted and keeps protected paths protected", (t) => {
  const { root, tools } = fixture(t);
  fs.writeFileSync(path.join(root, "delete-me.txt"), "temporary");
  fs.mkdirSync(path.join(root, "empty"));
  tools.delete("delete-me.txt");
  tools.delete("empty");
  assert.equal(fs.existsSync(path.join(root, "delete-me.txt")), false);
  assert.equal(fs.existsSync(path.join(root, "empty")), false);
  assert.throws(() => tools.delete(".git/config"), /protected/);
});

test("Git branch grant creates without switching or accepting command syntax", (t) => {
  const { tools, git } = fixture(t);
  const before = git("branch", "--show-current");
  tools.branch("repair/source");
  assert.equal(git("branch", "--show-current"), before);
  assert.throws(() => tools.branch("-D main"), /simple Git branch/);
  assert.throws(() => tools.branch("fix && curl localhost"), /simple Git branch/);
});

test("granted branch switching, merging, fetching, and pushing use validated names and configured remotes", (t) => {
  const { root, tools, git } = fixture(t);
  const base = git("branch", "--show-current").trim();
  tools.branch("feature/managed");
  tools.switchBranch("feature/managed");
  fs.writeFileSync(path.join(root, "app.txt"), "feature\n");
  git("add", "app.txt"); git("commit", "-qm", "feature");
  tools.switchBranch(base);
  tools.merge("feature/managed");
  assert.equal(fs.readFileSync(path.join(root, "app.txt"), "utf8"), "feature\n");
  tools.deleteBranch("feature/managed");

  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "psm-permission-remote-"));
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  execFileSync("git", ["init", "--bare", "-q", remote]);
  git("remote", "add", "origin", remote);
  tools.push("origin", base);
  tools.fetch("origin");
  assert.equal(execFileSync("git", ["--git-dir", remote, "rev-parse", `refs/heads/${base}`], { encoding: "utf8" }).trim(), git("rev-parse", "HEAD").trim());
  assert.throws(() => tools.push("https://example.invalid/repo", base), /configured Git remote/);
  assert.throws(() => tools.merge("--upload-pack=bad"), /simple Git branch/);
});

test("managed SDK tools exclude shell, inherited config and external integrations", async () => {
  const options = managedAgentOptions(createSdkMcpServer({ name: "psm", tools: [] }), new AbortController());
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.permissionMode, "dontAsk");
  assert.equal(options.strictMcpConfig, true);
  // Persisted so a later turn can resume it (P02/P05 decision, 2026-09-24). Tools,
  // settings and the deny hook are set on every turn, never read from the session.
  assert.equal(options.persistSession, true);
  assert.equal(options.resume, undefined);
  assert.equal(managedAgentOptions(createSdkMcpServer({ name: "psm", tools: [] }), new AbortController(), "session-1").resume, "session-1");
  const hook = options.hooks!.PreToolUse![0].hooks[0];
  const input = { session_id: "test", transcript_path: "", cwd: "/tmp", hook_event_name: "PreToolUse" as const, tool_use_id: "tool", tool_input: {} };
  for (const tool_name of ["Bash", "Write", "WebFetch", "mcp__other__grant"]) {
    const decision: any = await hook({ ...input, tool_name }, "tool", { signal: new AbortController().signal });
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  }
});

test("preflight identifies operator staging before an agent starts", (t) => {
  const { root, tools, git } = fixture(t);
  tools.preflightCommit();
  fs.writeFileSync(path.join(root, "other.txt"), "operator staged\n"); git("add", "other.txt");
  assert.throws(() => tools.preflightCommit(), /previously staged work/);
});

test("changing branch after staging cannot redirect a managed commit", (t) => {
  const { tools, git } = fixture(t);
  tools.write("app.txt", "repair\n"); tools.stage(["app.txt"]);
  git("switch", "-c", "operator-branch");
  assert.throws(() => tools.commit("do not redirect"), /index changed/);
  assert.equal(git("log", "-1", "--format=%s").trim(), "initial");
});

test("operator-created project identity can be committed but not rewritten by an agent", (t) => {
  const { root, tools, git } = fixture(t);
  fs.mkdirSync(path.join(root, ".psm"));
  fs.writeFileSync(path.join(root, ".psm/identity.json"), '{"version":1,"id":"prj_test"}\n');
  assert.throws(() => tools.write(".psm/identity.json", '{"id":"another-project"}'), /operator-managed/);
  tools.stage([".psm/identity.json"]); tools.commit("record project identity");
  assert.match(git("show", "HEAD:.psm/identity.json"), /prj_test/);
});

test("a parent checkout's grant cannot cross into a nested repository", (t) => {
  const { root, tools } = fixture(t);
  const nested = path.join(root, "nested"); fs.mkdirSync(nested); fs.mkdirSync(path.join(nested, ".git"));
  fs.writeFileSync(path.join(nested, "app.txt"), "another project");
  assert.throws(() => tools.read("nested/app.txt"), /Nested repositories/);
  assert.throws(() => tools.write("nested/app.txt", "unauthorized"), /Nested repositories/);
  assert.ok(!tools.list().includes("nested/app.txt"));
});

/**
 * Commit identity is resolved the way Git resolves it. A machine with no
 * user.name/user.email configured still commits by hand, from GIT_AUTHOR_* or
 * Git's own detection, and preparation must not be stricter than Git.
 */
function isolatedIdentity(t: test.TestContext, env: Record<string, string>) {
  const keys = ["HOME", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "psm-identity-home-"));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { HOME: home, ...env });
  t.after(() => {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    fs.rmSync(home, { recursive: true, force: true });
  });
}

test("a checkout with no configured Git identity commits as whoever Git would", (t) => {
  const { tools, git } = fixture(t);
  git("config", "--unset", "user.name"); git("config", "--unset", "user.email");
  isolatedIdentity(t, { GIT_AUTHOR_NAME: "Operator", GIT_AUTHOR_EMAIL: "operator@example.invalid", GIT_COMMITTER_NAME: "Operator", GIT_COMMITTER_EMAIL: "operator@example.invalid" });
  tools.preflightCommit();
  tools.write("app.txt", "repair\n"); tools.stage(["app.txt"]); tools.commit("repair without a configured identity");
  assert.equal(git("log", "-1", "--format=%an <%ae> | %cn <%ce>").trim(), "Operator <operator@example.invalid> | Operator <operator@example.invalid>");
});

test("when Git itself cannot name a committer, the checkout says what to set", (t) => {
  const { tools, git } = fixture(t);
  git("config", "--unset", "user.name"); git("config", "--unset", "user.email");
  git("config", "user.useConfigOnly", "true");
  isolatedIdentity(t, {});
  assert.throws(() => tools.preflightCommit(), /cannot tell who to commit as.*user\.name and user\.email/);
});

test("website commits require current builds and browser checks, including nested packages", async (t) => {
  const { taskInputs } = await import("./agent-task-inputs.ts");
  const { tools, root, git } = fixture(t);
  fs.mkdirSync(path.join(root, "client"));
  fs.writeFileSync(path.join(root, "client/package.json"), JSON.stringify({ scripts: { build: "tsc && vite build" }, dependencies: { react: "19" } }));
  git("add", "client/package.json"); git("commit", "-qm", "add website");
  tools.write("app.txt", "fixed\n"); tools.stage(["app.txt"]);
  const head = git("rev-parse", "HEAD");
  assert.throws(() => tools.commit("unverified"), /Commit blocked.*build in client.*browser preview in client/);
  assert.equal(git("rev-parse", "HEAD"), head);
  tools.recordVerification("client", "build", taskInputs(tools).digest);
  assert.throws(() => tools.commit("build alone"), /browser preview/);
  tools.recordVerification("client", "preview", taskInputs(tools).digest);
  tools.write("app.txt", "changed after checks\n"); tools.stage(["app.txt"]);
  assert.throws(() => tools.commit("stale checks"), /current source is unverified/);
  tools.recordVerification("client", "build", taskInputs(tools).digest);
  tools.recordVerification("client", "preview", taskInputs(tools).digest);
  tools.commit("verified website");
  assert.equal(git("show", "HEAD:app.txt"), "changed after checks\n");
});

test("builds cannot certify different staged source and docs-only changes need no runner", async (t) => {
  const { taskInputs } = await import("./agent-task-inputs.ts");
  const { tools, root, git } = fixture(t);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "node build.js" } }));
  git("add", "package.json"); git("commit", "-qm", "add build");
  tools.write("README.md", "docs\n"); tools.stage(["README.md"]); tools.commit("docs");
  tools.write("app.txt", "broken staged content\n"); tools.stage(["app.txt"]);
  tools.write("app.txt", "passing worktree content\n");
  tools.recordVerification(".", "build", taskInputs(tools).digest);
  assert.throws(() => tools.commit("partial staging"), /app.txt differs from verified source/);
});

test("the sandbox copy carries a project's committed .psm files, never psm's untracked state there", (t) => {
  const h = fixture(t);
  fs.mkdirSync(path.join(h.root, ".psm"));
  fs.writeFileSync(path.join(h.root, ".psm", "deployments.json"), "{}\n");
  h.git("add", ".psm"); h.git("commit", "-qm", "manifest");
  fs.writeFileSync(path.join(h.root, ".psm", "local-state.json"), "{}\n");
  fs.writeFileSync(path.join(h.root, ".psm-sessions.json"), "{}\n");
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "psm-task-copy-"));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  const files = taskInputs(h.tools, copy).entries.map((entry) => entry.file);
  assert.ok(files.includes(".psm/deployments.json"));
  assert.ok(fs.existsSync(path.join(copy, ".psm", "deployments.json")));
  assert.ok(!files.includes(".psm/local-state.json"));
  assert.ok(!files.some((file) => file.startsWith(".psm-")));
});
