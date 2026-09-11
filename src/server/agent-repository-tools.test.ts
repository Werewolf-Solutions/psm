import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { openDatabase } from "./db.ts";
import { AgentPermissionStore } from "./agent-permissions.ts";
import { RepositoryTools } from "./agent-repository-tools.ts";
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
  for (const permission of ["repo.read", "repo.edit", "git.commit", "git.branch"]) store.change(project, permission, true, store.snapshot(project).revision, "operator");
  const tools = new RepositoryTools(store.snapshot(project), store);
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, database, store, project, tools, git };
}

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

test("Git branch grant creates without switching or accepting command syntax", (t) => {
  const { tools, git } = fixture(t);
  const before = git("branch", "--show-current");
  tools.branch("repair/source");
  assert.equal(git("branch", "--show-current"), before);
  assert.throws(() => tools.branch("-D main"), /simple local branch/);
  assert.throws(() => tools.branch("fix && curl localhost"), /simple local branch/);
});

test("managed SDK tools exclude shell, inherited config and external integrations", async () => {
  const options = managedAgentOptions(createSdkMcpServer({ name: "psm", tools: [] }), new AbortController());
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.permissionMode, "dontAsk");
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.persistSession, false);
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
