import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JobSandboxShell } from "./sandbox-shell.ts";

test("an implement shell mounts only its clone and has no container network", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-shell-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clone = path.join(root, "job");
  fs.mkdirSync(clone);
  execFileSync("git", ["init", "-q", clone]);
  const calls: string[][] = [];
  const shell = new JobSandboxShell(clone, async (args) => { calls.push(args); return "ok"; });
  assert.equal(await shell.run("git status && echo ready", new AbortController().signal), "ok");
  const run = calls[0];
  assert.ok(run.includes("--network=none"));
  assert.ok(run.includes("--read-only"));
  assert.ok(run.includes("--cap-drop=ALL"));
  assert.ok(run.includes(`type=bind,source=${fs.realpathSync(clone)},target=/workspace`));
  assert.ok(run.includes(`type=bind,source=${path.join(fs.realpathSync(clone), ".git", "config")},target=/workspace/.git/config,readonly`));
  assert.ok(run.includes("GIT_AUTHOR_NAME=PSM Implement Job"));
  assert.ok(run.includes("GIT_COMMITTER_EMAIL=psm-job@localhost"));
  assert.equal(run.at(-1), "git status && echo ready");
  assert.equal(run.filter((entry) => entry.startsWith("type=bind,")).length, 2);
  assert.deepEqual(calls[1].slice(0, 2), ["rm", "-f"]);
});

test("the real Docker shell edits and commits only in its mounted clone", { skip: process.env.PSM_AGENT_DOCKER !== "1" && "set PSM_AGENT_DOCKER=1" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-shell-docker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clone = path.join(root, "job");
  fs.mkdirSync(clone);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: clone, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "dev");
  git("config", "user.name", "PSM Test");
  git("config", "user.email", "psm-test@example.invalid");
  fs.writeFileSync(path.join(clone, "file.txt"), "before\n");
  git("add", "."); git("commit", "-q", "-m", "start");
  git("config", "--unset", "user.name"); git("config", "--unset", "user.email");
  fs.writeFileSync(path.join(root, "outside.txt"), "host only\n");
  const output = await new JobSandboxShell(clone).run("test ! -e /workspace/../outside.txt && printf 'after\\n' > file.txt && git add file.txt && git commit -qm change && git status --short && ! curl --max-time 2 -fsS https://example.com >/dev/null 2>&1 && echo isolated", new AbortController().signal);
  assert.match(output, /isolated/);
  assert.equal(fs.readFileSync(path.join(clone, "file.txt"), "utf8"), "after\n");
  assert.equal(git("log", "-1", "--format=%s"), "change");
  assert.equal(fs.readFileSync(path.join(root, "outside.txt"), "utf8"), "host only\n");
});
