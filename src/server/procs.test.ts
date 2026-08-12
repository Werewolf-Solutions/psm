/**
 * What a project's command inherits from psm — and what it must not.
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

import { getProc, start, stop } from "./procs.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "psm-procs-"));

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
