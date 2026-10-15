import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { clonePath, jobGit, prepareClone } from "./implement-job.ts";
import { acceptJob, discardClone, readJobDiff } from "./review.ts";

const JOB_ID = "job_aaaaaaaaaaaaaaaaaaaaaaaa";

/** A real repo on `dev`, and a job clone with one commit changing server.js. */
function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, "real");
  fs.mkdirSync(real);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: real, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "dev");
  git("config", "user.name", "Owner");
  git("config", "user.email", "owner@example.com");
  fs.writeFileSync(path.join(real, "server.js"), "listen(3000)\n");
  fs.writeFileSync(path.join(real, "README.md"), "# real\n");
  git("add", ".");
  git("commit", "-q", "-m", "start");
  const clone = clonePath(path.join(root, "jobs"), "real", JOB_ID);
  const base = prepareClone(real, clone, JOB_ID);
  fs.writeFileSync(`${clone}/.git/psm-job-base`, `${base}\n`);
  fs.writeFileSync(path.join(clone, "server.js"), "listen(firstFree(3000))\n");
  jobGit(clone, ["commit", "-q", "-am", "Roll to the next free port"]);
  return { real, clone, git };
}

test("the diff shows the job's commits and patch", (t) => {
  const { clone } = setup(t);
  const diff = readJobDiff(clone, JOB_ID)!;
  assert.deepEqual(diff.commits.map((c) => c.subject), ["Roll to the next free port"]);
  assert.match(diff.diff, /-listen\(3000\)\n\+listen\(firstFree\(3000\)\)/);
  assert.equal(diff.truncated, false);
});

test("accept merges the job into the checked-out branch as one merge commit", (t) => {
  const { real, clone, git } = setup(t);
  fs.writeFileSync(path.join(real, "notes.txt"), "my unrelated work\n"); // untracked work elsewhere is fine
  const outcome = acceptJob(real, clone, JOB_ID, "Merge psm/job: roll to the next free port");
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  if (!outcome.ok) return;
  assert.equal(outcome.into, "dev");
  assert.equal(fs.readFileSync(path.join(real, "server.js"), "utf8"), "listen(firstFree(3000))\n");
  assert.equal(git("log", "-1", "--format=%s"), "Merge psm/job: roll to the next free port");
  assert.equal(git("rev-list", "--count", "HEAD^@").split("\n").length >= 1, true);
  assert.equal(git("cat-file", "-p", "HEAD").match(/^parent /gm)?.length, 2, "a real merge commit");
  assert.equal(fs.readFileSync(path.join(real, "notes.txt"), "utf8"), "my unrelated work\n");
  discardClone(clone);
  assert.equal(fs.existsSync(clone), false);
});

test("your uncommitted edits to the same file stop the merge; nothing is lost", (t) => {
  const { real, clone, git } = setup(t);
  fs.writeFileSync(path.join(real, "server.js"), "listen(4000) // my local edit\n");
  const head = git("rev-parse", "HEAD");
  const outcome = acceptJob(real, clone, JOB_ID, "Merge");
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /uncommitted changes/);
  assert.equal(outcome.branchKept, true);
  assert.equal(git("rev-parse", "HEAD"), head, "your branch did not move");
  assert.equal(fs.readFileSync(path.join(real, "server.js"), "utf8"), "listen(4000) // my local edit\n", "your edit is untouched");
  assert.equal(git("branch", "--list", `psm/job/${JOB_ID}`).replace("*", "").trim(), `psm/job/${JOB_ID}`, "the branch is there to merge by hand");
});

test("a real conflict is aborted cleanly", (t) => {
  const { real, clone, git } = setup(t);
  fs.writeFileSync(path.join(real, "server.js"), "listen(8080)\n");
  git("commit", "-q", "-am", "Something else on dev");
  const head = git("rev-parse", "HEAD");
  const outcome = acceptJob(real, clone, JOB_ID, "Merge");
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /conflicts/);
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(fs.existsSync(path.join(real, ".git", "MERGE_HEAD")), false, "no merge left half-done");
  assert.equal(git("status", "--porcelain"), "");
});
