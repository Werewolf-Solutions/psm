import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepositoryTools } from "../agent-repository-tools.ts";
import { taskInputs } from "../agent-task-inputs.ts";
import { PermissionError } from "../agent-permissions.ts";
import { ExecutorActivity } from "./activity.ts";
import type { ImplementJob } from "./client.ts";
import { branchFor, clonePath, declaredPreviewServices, hydrateLocalSubmodules, implementJobRunner, jobGit, prepareClone, type ImplementDeps, implementPrompt } from "./implement-job.ts";
import { JobPermissions, jobSnapshot, previewServiceSnapshot } from "./job-permissions.ts";
import { previewServiceChecker } from "../agent-permission-runtime.ts";

const JOB_ID = "job_0123456789abcdef01234567";

function repo(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-implement-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, "real");
  fs.mkdirSync(real);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: real, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "dev");
  git("config", "user.name", "Owner");
  git("config", "user.email", "owner@example.com");
  fs.writeFileSync(path.join(real, "server.js"), "listen(3000)\n");
  git("add", ".");
  git("commit", "-q", "-m", "start");
  git("remote", "add", "origin", "git@example.com:owner/real.git");
  fs.writeFileSync(path.join(real, "uncommitted.txt"), "mine, not the job's\n");
  return { root, real, git, jobsDir: path.join(root, "jobs") };
}

const job = (over: Partial<ImplementJob> = {}): ImplementJob => ({
  jobId: JOB_ID, kind: "implement", intakeId: "int_1", projectId: "prj_a", projectName: "real",
  text: "Roll to the next port when 3000 is taken", attempt: 1, leaseUntil: "",
  selection: { mode: "auto" },
  verdict: { verdict: "fits", size: "S", dependsOn: [], conflictsWith: [], queue: { after: [], note: "" }, questions: [], rationale: "Small DX fix." },
  revisions: [], continueClone: false, ...over,
});

function deps(fx: ReturnType<typeof repo>, runAgent: ImplementDeps["runAgent"], activity = new ExecutorActivity()): ImplementDeps {
  return {
    findProject: (id) => (id === "prj_a" ? { id, name: "real", path: fx.real, workspaceId: "business:0123456789abcdef01234567" } : null),
    jobsDir: fx.jobsDir,
    store: {} as never,
    workspaceRules: (workspaceId) => {
      assert.equal(workspaceId, "business:0123456789abcdef01234567");
      return [];
    },
    // The default jobs directory is under PSM's own protected code root.
    protectedRoots: [fx.root],
    runAgent,
    selectModel: async () => ({ engine: "claude", model: "test-sonnet", effort: null, reason: "test" }),
    activity,
  };
}

const tool = (id: string, name: string, input: object = {}) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: `mcp__psm__${name}`, input }] } });
const result = (id: string, isError: boolean, text: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text }] }] } });

test("host Git refuses clone metadata that points outside the job", (t) => {
  const fx = repo(t);
  const clone = clonePath(fx.jobsDir, "real", JOB_ID);
  prepareClone(fx.real, clone, JOB_ID);
  fs.mkdirSync(path.join(clone, ".git", "objects", "info"), { recursive: true });
  fs.writeFileSync(path.join(clone, ".git", "objects", "info", "alternates"), "/tmp/other-objects\n");
  assert.throws(() => jobGit(clone, ["status", "--porcelain"]), /external Git metadata/);
  fs.rmSync(path.join(clone, ".git", "objects", "info", "alternates"));
  fs.symlinkSync("/tmp/other-objects", path.join(clone, ".git", "objects", "info", "outside"));
  assert.throws(() => jobGit(clone, ["status", "--porcelain"]), /linked Git metadata/);
});

test("a job copies local submodule source into its test snapshot and refuses changed submodule files", (t) => {
  const fx = repo(t);
  const submodule = path.join(fx.root, "source-submodule");
  fs.mkdirSync(submodule);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: submodule, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Owner"); git("config", "user.email", "owner@example.com");
  fs.writeFileSync(path.join(submodule, "math.js"), "module.exports = 1;\n");
  git("add", "."); git("commit", "-qm", "add helper");
  fx.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", submodule, "helpers");
  fx.git("commit", "-qm", "add helpers submodule");
  const clone = clonePath(fx.jobsDir, "real", JOB_ID);
  prepareClone(fx.real, clone, JOB_ID);
  const snapshot = jobSnapshot({ id: "prj_a", name: "real" }, clone, JOB_ID);
  const repository = new RepositoryTools(snapshot, { check() {} } as never);
  assert.ok(repository.taskFiles().includes("helpers/math.js"));
  assert.equal(repository.read("helpers/math.js"), "module.exports = 1;\n");
  const snapshotDir = path.join(fx.root, "test-snapshot");
  taskInputs(repository, snapshotDir);
  assert.equal(fs.readFileSync(path.join(snapshotDir, "helpers", "math.js"), "utf8"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(clone, "helpers", "math.js"), "module.exports = 2;\n");
  assert.throws(() => hydrateLocalSubmodules(fx.real, clone, true), /changed inside the job clone/);
});

test("a job works in its own clone on psm/job/<id>, commits, and goes to review; the real checkout is untouched", async (t) => {
  const fx = repo(t);
  const realHead = fx.git("rev-parse", "HEAD");
  const activity = new ExecutorActivity();
  activity.claimed(job());
  const run = implementJobRunner(deps(fx, async ({ cwd, event, policy }) => {
    assert.equal(policy.profile, "implement");
    assert.ok(policy.checker instanceof JobPermissions);
    assert.equal(cwd, fs.realpathSync(clonePath(fx.jobsDir, "real", JOB_ID)));
    assert.equal(fs.existsSync(path.join(cwd, "uncommitted.txt")), false, "a job starts from your last commit, not your working tree");
    event(tool("t1", "run_tests", { script: "test" }));
    event(result("t1", false, "ok 1 - rolls"));
    const tools = new RepositoryTools(policy.snapshots[0], policy.checker!, policy.protectedRoots);
    assert.deepEqual(tools.list(), ["server.js"]);
    assert.equal(tools.read("server.js"), "listen(3000)\n");
    assert.throws(() => tools.read("../outside"), PermissionError);
    assert.throws(() => tools.write(".psm/permissions.json", "{}"), PermissionError);
    tools.write("server.js", "listen(firstFree(3000))\n");
    jobGit(cwd, ["commit", "-q", "-am", "Roll to the next free port"]);
    event({ type: "assistant", message: { content: [{ type: "text", text: "Done: the server now rolls to the next free port." }] } });
  }, activity));

  const outcome = await run(job(), new AbortController().signal);
  assert.equal(outcome.status, "review", JSON.stringify(outcome));
  if (outcome.status !== "review") return;
  assert.equal(outcome.result.branch, branchFor(JOB_ID));
  assert.equal(outcome.result.baseCommit, realHead);
  assert.deepEqual(outcome.result.commits.map((c) => c.subject), ["Roll to the next free port"]);
  assert.deepEqual(outcome.result.diffStat, { files: 1, insertions: 1, deletions: 1 });
  assert.deepEqual(outcome.result.checks, [{ name: "run_tests test", ok: true }]);
  assert.match(outcome.result.summary, /next free port/);

  const clone = clonePath(fx.jobsDir, "real", JOB_ID);
  assert.equal(jobGit(clone, ["branch", "--show-current"]).trim(), branchFor(JOB_ID));
  assert.equal(jobGit(clone, ["remote"]).trim(), "", "no origin: nowhere to push");
  assert.equal(fs.lstatSync(path.join(clone, ".git")).isDirectory(), true, "an ordinary checkout, not a linked worktree");
  assert.equal(fx.git("rev-parse", "HEAD"), realHead, "your checkout did not move");
  assert.equal(fx.git("branch", "--list", "psm/*"), "", "the branch is not in your repo until you accept");
  assert.equal(fs.readFileSync(path.join(fx.real, "server.js"), "utf8"), "listen(3000)\n");

  const entry = activity.get(JOB_ID)!;
  assert.ok(entry.prompt!.includes("Roll to the next port when 3000 is taken"));
  assert.deepEqual(entry.agent.map((line) => line.type), ["tool", "result", "message", "check"]);
});

test("the same failing check three times stalls the job with the reason", async (t) => {
  const fx = repo(t);
  const run = implementJobRunner(deps(fx, async ({ cwd, event, signal }) => {
    for (let i = 1; i <= 5 && !signal.signal.aborted; i++) {
      fs.writeFileSync(path.join(cwd, `try-${i}.js`), `// attempt ${i}\n`);
      event(tool(`t${i}`, "run_tests", { script: "test" }));
      event(result(`t${i}`, true, `Sandbox task failed: not ok 1 - rolls to the next port (took ${i}0 ms)`));
    }
    if (signal.signal.aborted) throw new Error("aborted");
  }));
  const outcome = await run(job(), new AbortController().signal);
  assert.equal(outcome.status, "stalled");
  assert.match((outcome as { error: string }).error, /failed 3 times/);
});

test("finishing without a commit is not something to review", async (t) => {
  const fx = repo(t);
  const run = implementJobRunner(deps(fx, async ({ cwd }) => {
    fs.writeFileSync(path.join(cwd, "server.js"), "half done\n");
  }));
  const outcome = await run(job(), new AbortController().signal);
  assert.equal(outcome.status, "stalled");
  assert.match((outcome as { error: string }).error, /uncommitted changes/);
});

test("a committed job with failing tests cannot reach review", async (t) => {
  const fx = repo(t);
  const run = implementJobRunner(deps(fx, async ({ cwd, event }) => {
    fs.writeFileSync(path.join(cwd, "server.js"), "listen(firstFree(3000))\n");
    event(tool("failed", "run_tests", { script: "test" }));
    event(result("failed", true, "not ok - missing helper module"));
    jobGit(cwd, ["commit", "-qam", "Change startup port"]);
  }));
  const outcome = await run(job(), new AbortController().signal);
  assert.equal(outcome.status, "stalled");
  assert.match((outcome as { error: string }).error, /Checks still fail: run_tests test/);
});

test("server-only job does not require a separate web package preview", async (t) => {
  const fx = repo(t);
  fs.mkdirSync(path.join(fx.real, "web"));
  fs.writeFileSync(path.join(fx.real, "package.json"), JSON.stringify({ name: "server", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(fx.real, "web", "package.json"), JSON.stringify({ name: "web", scripts: { build: "vite build" }, devDependencies: { vite: "1.0.0" } }));
  fx.git("add", "package.json", "web/package.json"); fx.git("commit", "-qm", "add package scripts");
  const run = implementJobRunner(deps(fx, async ({ cwd, event, policy }) => {
    fs.writeFileSync(path.join(cwd, "server.js"), "listen(firstFree(3000))\n");
    const repository = new RepositoryTools(policy.snapshots[0], policy.checker!, policy.protectedRoots, policy.affectedFiles);
    assert.deepEqual(repository.verificationPackages(), []);
    event(tool("passed", "run_tests", { script: "test" }));
    event(result("passed", false, "1 test passed"));
    jobGit(cwd, ["commit", "-qam", "Change startup port"]);
  }));
  const outcome = await run(job(), new AbortController().signal);
  assert.equal(outcome.status, "review", JSON.stringify(outcome));
  const clone = clonePath(fx.jobsDir, "real", JOB_ID);
  const webRepository = new RepositoryTools(jobSnapshot({ id: "prj_a", name: "real" }, clone, JOB_ID), { check() {} } as never, [], () => ["web/src/app.js"]);
  assert.deepEqual(webRepository.verificationPackages(), [{ directory: "web", build: true, browser: true }]);
});

test("a sandbox Git commit cannot reach review without verification of the final source", async (t) => {
  const fx = repo(t);
  fs.writeFileSync(path.join(fx.real, "package.json"), JSON.stringify({ name: "sample", version: "1.0.0", scripts: { build: "node --check server.js" } }));
  fx.git("add", "package.json");
  fx.git("commit", "-q", "-m", "add build");
  const run = implementJobRunner(deps(fx, async ({ cwd, event }) => {
    event(tool("v", "verification_status"));
    event(result("v", false, JSON.stringify({ verified: true })));
    fs.writeFileSync(path.join(cwd, "server.js"), "listen(firstFree(3000))\n");
    jobGit(cwd, ["commit", "-q", "-am", "unverified edit"]);
  }));
  const outcome = await run(job(), new AbortController().signal);
  assert.equal(outcome.status, "stalled");
  assert.match((outcome as { error: string }).error, /final source has no passing build/);
});

test("the time limit stalls the job", async (t) => {
  const fx = repo(t);
  const run = implementJobRunner({ ...deps(fx, ({ signal }) => new Promise((_, reject) => signal.signal.addEventListener("abort", () => reject(new Error("aborted"))))), timeoutMs: 50 });
  const outcome = await run(job(), new AbortController().signal);
  assert.equal(outcome.status, "stalled");
  assert.match((outcome as { error: string }).error, /minute limit/);
});

test("a revised job continues in the same clone, on top of its commits", async (t) => {
  const fx = repo(t);
  const commitOnce = (message: string): ImplementDeps["runAgent"] => async ({ cwd }) => {
    fs.appendFileSync(path.join(cwd, "server.js"), `// ${message}\n`);
    jobGit(cwd, ["commit", "-q", "-am", message]);
  };
  const first = await implementJobRunner(deps(fx, commitOnce("first")))(job(), new AbortController().signal);
  assert.equal(first.status, "review");
  let prompt = "";
  const second = await implementJobRunner(deps(fx, async (input) => { prompt = input.message; await commitOnce("second")(input); }))(
    job({ continueClone: true, revisions: [{ comment: "Only roll in dev", at: "" }] }),
    new AbortController().signal,
  );
  assert.equal(second.status, "review");
  if (second.status !== "review") return;
  assert.deepEqual(second.result.commits.map((c) => c.subject), ["first", "second"]);
  assert.match(prompt, /Only roll in dev/);
});

test("the job's own grant refuses push, fetch and server commands even if a tool were called", (t) => {
  const fx = repo(t);
  const checker = new JobPermissions(JOB_ID, () => []);
  const tools = new RepositoryTools(jobSnapshot({ id: "prj_a", name: "real" }, fs.realpathSync(fx.real), JOB_ID), checker);
  assert.throws(() => tools.push("origin"), PermissionError);
  assert.throws(() => checker.check(jobSnapshot({ id: "prj_a", name: "real" }, fx.real, JOB_ID), "git.fetch"), /may not use git.fetch/);
  assert.throws(() => checker.check(jobSnapshot({ id: "prj_a", name: "real" }, fx.real, JOB_ID), "machine.command"), PermissionError);
  assert.equal(checker.check(jobSnapshot({ id: "prj_a", name: "real" }, fx.real, JOB_ID), "repo.edit").effect, "allow");
  const denied = new JobPermissions(JOB_ID, () => [{ id: "w", permission: "repo.delete", effect: "deny", scope: {}, expiresAt: null, remainingUses: null, source: "custom", actor: "me", at: 0 }]);
  assert.throws(() => denied.check(jobSnapshot({ id: "prj_a", name: "real" }, fx.real, JOB_ID), "repo.delete"), /workspace policy/i);
});

test("tests that already fail at the starting commit stall the job before any agent runs", async (t) => {
  const fx = repo(t);
  const activity = new ExecutorActivity();
  let agentRan = false;
  const run = implementJobRunner({
    ...deps(fx, async () => { agentRan = true; }, activity),
    baseline: async () => ({ status: "fail", stage: "tests", summary: "1 test failing, 79 passing", failing: ["buildDashboard: returns running bots"], output: "not ok 9 - buildDashboard: returns running bots" }),
  });
  activity.claimed(job());
  const outcome = await run(job(), new AbortController().signal);
  assert.equal(agentRan, false);
  assert.equal(outcome.status, "stalled");
  assert.match((outcome as { error: string }).error, /tests already fail before any change \(1 test failing, 79 passing\)\. Failing: buildDashboard/);
  assert.match(activity.get(JOB_ID)!.agent.at(-1)!.text, /psm's test run at the starting commit/);
});

test("green tests at the start are passed to the agent; a revision skips the check", async (t) => {
  const fx = repo(t);
  let prompt = "";
  let checked = 0;
  const run = implementJobRunner({
    ...deps(fx, async ({ message }) => { prompt = message; }),
    baseline: async () => { checked++; return { status: "pass", summary: "80 tests pass" }; },
  });
  await run(job(), new AbortController().signal);
  assert.equal(checked, 1);
  assert.match(prompt, /psm ran the project's tests at the starting commit: 80 tests pass\. .*install_packages before run_tests/);
  await run(job({ continueClone: true, revisions: [{ comment: "also log the port" }] as never }), new AbortController().signal);
  assert.equal(checked, 1, "a revision builds on the agent's own commits");
});

test("red tests do not block a task whose point is to fix them", async (t) => {
  const fx = repo(t);
  let prompt = "";
  const run = implementJobRunner({
    ...deps(fx, async ({ message }) => { prompt = message; }),
    baseline: async () => ({ status: "fail", stage: "tests", summary: "1 test failing, 79 passing", failing: ["buildDashboard: returns running bots"], output: "" }),
  });
  await run(job({ text: "fix the failing buildDashboard test" }), new AbortController().signal);
  assert.match(prompt, /they fail \(1 test failing, 79 passing\)\. Failing: buildDashboard: returns running bots\. This task is about making them pass/);
});

const preview = (project: string) => JSON.stringify({
  schema: "psm.werewolf.solutions/preview/v2", host: "localhost",
  services: [{ project, directory: "server", script: "dev", port: 3000, ready: "/" }],
});

test("preview services come from the committed preview file, not the clone's or working tree's copy", (t) => {
  const fx = repo(t);
  fs.mkdirSync(path.join(fx.real, "client"));
  fs.writeFileSync(path.join(fx.real, "client", "psm-preview.json"), preview("werewolf-dapp"));
  fx.git("add", ".");
  fx.git("commit", "-q", "-m", "preview");
  const commit = fx.git("rev-parse", "HEAD");
  // An uncommitted edit (or one an agent makes in its clone) cannot add a service.
  fs.writeFileSync(path.join(fx.real, "client", "psm-preview.json"), preview("secret-project"));
  assert.deepEqual(declaredPreviewServices(fx.real, commit), ["werewolf-dapp"]);
  assert.deepEqual(declaredPreviewServices(fx.real, "0000000000000000000000000000000000000000"), []);
});

test("a preview service can be read and started, never changed", () => {
  const snapshot = previewServiceSnapshot({ id: "prj_dapp", name: "werewolf-dapp", path: "/nowhere" }, JOB_ID);
  const checker = previewServiceChecker(new JobPermissions(JOB_ID, () => []));
  assert.equal(checker.check(snapshot, "repo.read").effect, "allow");
  assert.equal(checker.check(snapshot, "script.run").effect, "allow");
  for (const permission of ["repo.edit", "repo.delete", "git.commit", "pkg.install", "test.run"] as const) {
    assert.throws(() => checker.check(snapshot, permission), PermissionError);
  }
});

test("an implement job offers its declared preview services, and only those that exist", async (t) => {
  const fx = repo(t);
  fs.writeFileSync(path.join(fx.real, "psm-preview.json"), preview("werewolf-dapp"));
  fx.git("add", "psm-preview.json");
  fx.git("commit", "-q", "-m", "preview");
  let seen: string[] | null = null;
  const base = deps(fx, async ({ policy }) => { seen = (policy.previewServices ?? []).map((snapshot) => snapshot.project.name); });
  const run = implementJobRunner({ ...base, findProjectByName: (name) => (name === "werewolf-dapp" ? { id: "prj_dapp", name, path: fx.root } : null) });
  await run(job(), new AbortController().signal);
  assert.deepEqual(seen, ["werewolf-dapp"]);
});

test("a resumed job's prompt tells the agent to carry on from the clone's state", () => {
  const prompt = implementPrompt(job({ continueClone: true, resumed: true }), "app");
  assert.match(prompt, /stopped part-way/);
  assert.match(prompt, /git status and git log/);
  assert.doesNotMatch(implementPrompt(job(), "app"), /stopped part-way/);
  assert.match(prompt, new RegExp(`pass project "${job().projectId}"`));
});
