/**
 * Reading a checkout's state.
 *
 * Real repositories in a sandbox rather than fixtures of git's output: the
 * parsing is only worth anything if it matches what the installed git actually
 * prints, and that is the thing a fixture stops testing the day git changes it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { repoStatus, repoStatuses } from "./git.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "psm-git-"));

function repo(name: string, { commit = true } = {}): string {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "tracked.txt"), "one\n");
  if (commit) {
    git("add", "-A");
    git("commit", "-qm", "first");
  }
  return dir;
}

test("a clean checkout reports its branch and says it is clean", async () => {
  const status = await repoStatus("clean", repo("clean"));
  assert.equal(status.isRepo, true);
  assert.equal(status.branch, "main");
  assert.equal(status.clean, true);
  assert.deepEqual(status.changes, []);
  assert.equal(status.lastCommit?.subject, "first");
});

test("staged, unstaged and untracked are counted apart", async () => {
  const dir = repo("mixed");
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "staged.txt"), "new\n");
  git("add", "staged.txt");
  fs.writeFileSync(path.join(dir, "tracked.txt"), "changed\n");
  fs.writeFileSync(path.join(dir, "untracked.txt"), "loose\n");

  const status = await repoStatus("mixed", dir);
  assert.equal(status.clean, false);
  assert.equal(status.staged, 1, "the added file");
  assert.equal(status.unstaged, 1, "the edited tracked file");
  assert.equal(status.untracked, 1, "the loose file");
  assert.deepEqual(
    status.changes.map((c) => c.path).sort(),
    ["staged.txt", "tracked.txt", "untracked.txt"],
  );
});

test("a file both staged and edited again counts once on each side", async () => {
  const dir = repo("both");
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "tracked.txt"), "staged\n");
  git("add", "tracked.txt");
  fs.writeFileSync(path.join(dir, "tracked.txt"), "and edited again\n");

  const status = await repoStatus("both", dir);
  assert.equal(status.staged, 1);
  assert.equal(status.unstaged, 1);
  assert.equal(status.changes.length, 1, "it is still one file");
});

test("every local branch is listed, with the current one marked", async () => {
  const dir = repo("branches");
  execFileSync("git", ["-C", dir, "branch", "feature/one"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "branch", "feature/two"], { stdio: "ignore" });

  const status = await repoStatus("branches", dir);
  assert.deepEqual(status.branches.map((b) => b.name).sort(), ["feature/one", "feature/two", "main"]);
  assert.deepEqual(status.branches.filter((b) => b.current).map((b) => b.name), ["main"]);
});

test("a folder that is not a checkout says so rather than failing", async () => {
  const dir = path.join(sandbox, "plain");
  fs.mkdirSync(dir, { recursive: true });
  const status = await repoStatus("plain", dir);
  assert.equal(status.isRepo, false);
  assert.equal(status.error, null, "not being a repository is not an error to report");
});

test("a repository with no commits yet is readable", async () => {
  const status = await repoStatus("fresh", repo("fresh", { commit: false }));
  assert.equal(status.isRepo, true);
  assert.equal(status.lastCommit, null);
  assert.equal(status.untracked, 1, "the uncommitted file still shows");
});

test("several repositories come back in the order they were asked for", async () => {
  const repos = [
    { project: "b", path: repo("order-b") },
    { project: "a", path: repo("order-a") },
  ];
  const all = await repoStatuses(repos);
  assert.deepEqual(all.map((r) => r.project), ["b", "a"], "the caller's order is the room's order");
});

test("one bad member does not take the others down", async () => {
  const all = await repoStatuses([
    { project: "good", path: repo("good") },
    { project: "gone", path: path.join(sandbox, "does-not-exist") },
  ]);
  assert.equal(all[0].isRepo, true);
  assert.equal(all[1].isRepo, false, "a missing directory is a state to show, not a throw");
});
