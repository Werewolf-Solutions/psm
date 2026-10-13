/**
 * What a project's command inherits from psm — and what it must not — plus the
 * transcript psm keeps of everything that command printed.
 *
 * psm's server has PORT set (its own listening port). A child inheriting it is a
 * real trap: dotenv does not overwrite variables that already exist, so the
 * project silently ignores its own .env and tries to bind psm's port. Running
 * werewolf-dapp from psm's Run button did exactly that.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "psm-procs-"));
// Before the import: procs.ts resolves its log directory once, at load time.
// Without this the suite would write transcripts into the repo's own .psm-logs.
process.env.PSM_LOG_DIR = path.join(sandbox, "logs");

const { MAX_LOG_LINES, getProc, logFile, start, stop, transcript } = await import("./procs.ts");

test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

/** Run a command through psm and hand back everything it printed. */
async function runAndCollect(name: string, command: string): Promise<string> {
  start(name, "run", command, sandbox);
  for (let i = 0; i < 100; i++) {
    const proc = getProc(name, "run");
    if (proc && proc.status !== "running") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  stop(name, "run");
  await new Promise((r) => setTimeout(r, 50)); // let the transcript flush
  return (getProc(name, "run")?.log || []).map((line) => line.line).join("\n");
}

test("psm's own PORT is not passed to a project's command", async () => {
  const previous = process.env.PORT;
  process.env.PORT = "4317"; // as psm's dev script sets it
  try {
    const output = await runAndCollect("port-check", 'printf "PORT=[%s]\\n" "$PORT"');
    assert.match(output, /PORT=\[\]/, `a project must not inherit psm's port — got: ${output}`);
  } finally {
    if (previous === undefined) delete process.env.PORT;
    else process.env.PORT = previous;
  }
});

test("psm's own configuration and secrets are not passed either", async () => {
  const saved = { mode: process.env.PSM_MODE, secret: process.env.PSM_SESSION_SECRET };
  process.env.PSM_MODE = "dev";
  process.env.PSM_SESSION_SECRET = "super-secret";
  try {
    const output = await runAndCollect("psm-vars", 'printf "M=[%s] S=[%s]\\n" "$PSM_MODE" "$PSM_SESSION_SECRET"');
    assert.match(output, /M=\[\] S=\[\]/, `PSM_* must not leak into projects — got: ${output}`);
    assert.ok(!output.includes("super-secret"), "a session secret reaching a project command is a credential leak");
  } finally {
    if (saved.mode === undefined) delete process.env.PSM_MODE;
    else process.env.PSM_MODE = saved.mode;
    if (saved.secret === undefined) delete process.env.PSM_SESSION_SECRET;
    else process.env.PSM_SESSION_SECRET = saved.secret;
  }
});

test("the rest of the environment still comes through", async () => {
  const output = await runAndCollect("path-check", 'printf "HOME=[%s]\\n" "$HOME"');
  assert.ok(!/HOME=\[\]/.test(output), "scrubbing psm's own vars must not empty the environment");
});

/* ---- the transcript on disk, which is what Download hands back ---- */

test("a run's whole output is written to its own file", async () => {
  await runAndCollect("alpha", "printf 'one\\ntwo\\nthree\\n'");

  const file = logFile("alpha", "run");
  assert.equal(path.dirname(file), process.env.PSM_LOG_DIR);
  const written = fs.readFileSync(file, "utf8");
  for (const line of ["one", "two", "three"]) {
    assert.match(written, new RegExp(`^\\S+ out ${line}$`, "m"), `${line} should be in the file`);
  }
  // The command itself opens the transcript, and the exit closes it.
  assert.match(written, /sys \$ printf/);
  assert.match(written, /sys \[psm\] process exited/);
});

test("the transcript outlives the in-memory ring buffer", async () => {
  const lines = MAX_LOG_LINES + 500;
  await runAndCollect("chatty", `seq 1 ${lines}`);

  const log = transcript("chatty", "run");
  assert.ok(log, "there should be a transcript");
  assert.equal(log.complete, true);
  // The ring buffer dropped line 1 long ago; the file still has it, which is the
  // entire point of downloading rather than reading the console.
  assert.match(log.text, /^\S+ out 1$/m);
  assert.match(log.text, new RegExp(`^\\S+ out ${lines}$`, "m"));
});

test("a restart truncates the transcript rather than appending to the last run", async () => {
  await runAndCollect("restarted", "echo first-run");
  await runAndCollect("restarted", "echo second-run");

  const log = transcript("restarted", "run");
  assert.ok(log);
  assert.ok(!log.text.includes("first-run"), "the previous run should not bleed into this one");
  assert.match(log.text, /out second-run$/m);
});

test("a project that never ran has no transcript", () => {
  assert.equal(transcript("never-started", "run"), null);
});

test("custom commands run in their chosen directory without replacing the main run", async () => {
  const directory = path.join(sandbox, "werewolf-dapp");
  fs.mkdirSync(directory, { recursive: true });
  const kind = "custom:12345678-1234-1234-1234-123456789abc" as const;
  start("todo-app", "run", "sleep 10", sandbox);
  start("todo-app", kind, "pwd", directory);
  for (let i = 0; i < 50 && getProc("todo-app", kind)?.status === "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(getProc("todo-app", "run")?.status, "running");
  assert.match(getProc("todo-app", kind)?.log.map((line) => line.line).join("\n") || "", /werewolf-dapp/);
  stop("todo-app", "run");
});
