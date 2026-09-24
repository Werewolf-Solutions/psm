/**
 * Matched comparison: one small task, the same model, run once through the
 * provider directly (Claude Code) and once through PSM's managed agent with
 * the Develop preset. Each run gets a fresh copy of the same fixture repo.
 *
 *   npx tsx scripts/compare-agents.mts [model]
 *
 * Records what the plan asks for: completion, verified state (tests pass,
 * change committed), tool calls, handoffs, elapsed time and reported cost.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentPermissionStore } from "../src/server/agent-permissions.ts";
import { runManagedAgent } from "../src/server/agent-permission-runtime.ts";
import { openDatabase } from "../src/server/db.ts";

const model = process.argv[2] || "sonnet";
const TASK = "math.js's sum() returns the wrong result when either argument is negative. Fix it, add a test for negative numbers to math.test.js, make sure the tests pass, and commit the change with a short message.";

function fixture(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-compare-"));
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", type: "commonjs", scripts: { test: "node --test" } }, null, 2));
  fs.writeFileSync(path.join(directory, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "fixture", version: "1.0.0" } } }, null, 2));
  fs.writeFileSync(path.join(directory, "math.js"), "function sum(a, b) {\n  return Math.abs(a) + Math.abs(b);\n}\nmodule.exports = { sum };\n");
  fs.writeFileSync(path.join(directory, "math.test.js"), "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('./math.js');\ntest('adds', () => assert.equal(sum(2, 3), 5));\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "ignore" });
  git("init", "-q"); git("add", "."); git("-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "fixture");
  return directory;
}

function verify(directory: string) {
  const tests = spawnSync("node", ["--test"], { cwd: directory, encoding: "utf8" });
  const commits = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: directory, encoding: "utf8" }).trim());
  const clean = execFileSync("git", ["status", "--porcelain"], { cwd: directory, encoding: "utf8" }).trim() === "";
  const negativeTest = /-\d/.test(fs.readFileSync(path.join(directory, "math.test.js"), "utf8"));
  // An independent check the agent never saw.
  const hidden = spawnSync("node", ["-e", "const {sum}=require('./math.js'); process.exit(sum(-2,5)===3 && sum(-2,-3)===-5 && sum(4,-1)===3 ? 0 : 1)"], { cwd: directory });
  return { testsPass: tests.status === 0, hiddenCheckPasses: hidden.status === 0, committed: commits > 1, cleanTree: clean, addedNegativeTest: negativeTest };
}

async function direct() {
  const directory = fixture();
  const started = Date.now();
  const result = spawnSync("claude", ["-p", TASK, "--model", model, "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,Bash(node --test*),Bash(npm test*),Bash(git add*),Bash(git commit*),Bash(git status*),Bash(git diff*)"], { cwd: directory, encoding: "utf8", timeout: 600_000 });
  let parsed: any = {};
  try { parsed = JSON.parse(result.stdout); } catch { parsed = { raw: result.stdout.slice(-500), stderr: result.stderr.slice(-500) }; }
  return { run: "direct Claude Code", elapsedMs: Date.now() - started, turns: parsed.num_turns ?? null, costUsd: parsed.total_cost_usd ?? null, finalText: String(parsed.result ?? "").slice(0, 300), ...verify(directory), directory };
}

async function managed() {
  const directory = fixture();
  const database = openDatabase(":memory:");
  const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_compare", name: "fixture", path: directory };
  store.applyPreset(project, "develop", 0, "compare");
  const tools: string[] = [];
  let questions = 0;
  let cost: number | null = null;
  let turns: number | null = null;
  let finalText = "";
  const started = Date.now();
  await runManagedAgent({
    policy: { store, snapshots: [store.snapshot(project)], protectedRoots: [] },
    engine: "claude", cwd: directory, model, effort: null, message: TASK,
    context: "You are working in one project through PSM tools. Use the project ID given in the scope.",
    signal: new AbortController(),
    event: (event: any) => {
      if (event.type === "assistant") for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use") tools.push(block.name.replace("mcp__psm__", ""));
        if (block.type === "text" && /\[\[psm-question/.test(block.text)) questions++;
      }
      if (event.type === "result") { cost = event.total_cost_usd ?? null; turns = event.num_turns ?? null; finalText = String(event.result ?? "").slice(0, 300); }
    },
  });
  database.close();
  return { run: "PSM managed (Develop preset)", elapsedMs: Date.now() - started, turns, costUsd: cost, toolCalls: tools.length, tools: [...new Set(tools)], handoffs: questions, finalText, ...verify(directory), directory };
}

const results = [await direct(), await managed()];
console.log(JSON.stringify({ task: TASK, model, at: new Date().toISOString(), results }, null, 2));
