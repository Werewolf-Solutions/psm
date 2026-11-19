import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assemblePack } from "./context.ts";
import {
  SYSTEM_PROMPT,
  claudeEngine,
  claudeTriageArgs,
  fileTriageCache,
  memoryTriageCache,
  readClaudeJson,
  runTriage,
  triageCacheKey,
  type EngineRequest,
  type TriageEngine,
} from "./run.ts";

const VERDICT = {
  verdict: "fits",
  size: "S",
  dependsOn: [],
  conflictsWith: [],
  queue: { after: ["P01 inbox"], note: "after the inbox" },
  questions: [],
  rationale: "Small and in scope.",
};

const pack = assemblePack([{ title: "README.md", body: "# Demo" }]);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-triage-run-"));

function fakeEngine(answer: string | ((req: EngineRequest) => string)): TriageEngine & { calls: EngineRequest[] } {
  const calls: EngineRequest[] = [];
  const engine = (async (req: EngineRequest) => {
    calls.push(req);
    return { ok: true as const, text: typeof answer === "function" ? answer(req) : answer };
  }) as TriageEngine & { calls: EngineRequest[] };
  engine.calls = calls;
  return engine;
}

test("the argv turns every tool off and isolates project settings", () => {
  const args = claudeTriageArgs("sys", "sonnet");
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(at("--tools"), "");
  assert.match(at("--disallowedTools"), /Bash/);
  assert.match(at("--disallowedTools"), /Edit/);
  assert.match(at("--disallowedTools"), /Write/);
  assert.equal(at("--setting-sources"), "user");
  assert.equal(at("--output-format"), "json");
  assert.equal(at("--model"), "sonnet");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(!args.some((arg) => /bypassPermissions|dangerously|acceptEdits/.test(arg)));
});

test("claude's JSON output is reduced to the answer text", () => {
  const answer = readClaudeJson('{"type":"result","result":"hi","is_error":false}');
  assert.equal(answer.ok && answer.text, "hi");
  assert.equal(readClaudeJson('{"is_error":true,"result":"limit"}').ok, false);
  assert.equal(readClaudeJson("not json").ok, false);
  assert.equal(readClaudeJson("{}").ok, false);
});

test("a fenced valid answer becomes a verdict, with the pack and intake in the prompt", async () => {
  const engine = fakeEngine("```json\n" + JSON.stringify(VERDICT) + "\n```");
  const result = await runTriage({ projectDir: dir, projectName: "demo", intakeText: "Add an inbox", pack, engine });
  assert.ok(result.ok);
  assert.equal(result.verdict.verdict, "fits");
  assert.equal(result.cached, false);
  const [call] = engine.calls;
  assert.equal(call.cwd, dir);
  assert.equal(call.systemPrompt, SYSTEM_PROMPT);
  assert.equal(call.timeoutMs, 5 * 60_000);
  assert.match(call.prompt, /<context>\n## README\.md\n\n# Demo/);
  assert.match(call.prompt, /<intake>\nAdd an inbox\n<\/intake>/);
});

test("invalid answers and engine failures come back as reasons, not verdicts", async () => {
  const dated = await runTriage({
    projectDir: dir, projectName: "demo", intakeText: "x", pack,
    engine: fakeEngine(JSON.stringify({ ...VERDICT, rationale: "Ship it next week" })),
  });
  assert.equal(dated.ok, false);
  assert.match((dated as any).reason, /calendar date/);

  const prose = await runTriage({ projectDir: dir, projectName: "demo", intakeText: "x", pack, engine: fakeEngine("Looks fine to me.") });
  assert.match((prose as any).reason, /not a JSON verdict/);

  const down = await runTriage({
    projectDir: dir, projectName: "demo", intakeText: "x", pack,
    engine: async () => ({ ok: false, error: "the engine timed out after 300 s" }),
  });
  assert.match((down as any).reason, /timed out/);

  const thrown = await runTriage({
    projectDir: dir, projectName: "demo", intakeText: "x", pack,
    engine: async () => { throw new Error("boom"); },
  });
  assert.match((thrown as any).reason, /boom/);

  const empty = await runTriage({ projectDir: dir, projectName: "demo", intakeText: "  ", pack, engine: fakeEngine("{}") });
  assert.match((empty as any).reason, /no text/);
});

test("identical triage is served from cache; a changed text or context is not", async () => {
  const cache = memoryTriageCache();
  const engine = fakeEngine(JSON.stringify(VERDICT));
  const run = (intakeText: string, p = pack) => runTriage({ projectDir: dir, projectName: "demo", intakeText, pack: p, engine, cache });
  assert.equal(((await run("Add an inbox")) as any).cached, false);
  assert.equal(((await run("  Add an inbox ")) as any).cached, true);
  assert.equal(engine.calls.length, 1);
  await run("Add an outbox");
  await run("Add an inbox", assemblePack([{ title: "README.md", body: "# Changed" }]));
  assert.equal(engine.calls.length, 3);
});

test("the predicted scope comes back with the verdict, cached or not", async () => {
  const cache = memoryTriageCache();
  const engine = fakeEngine(JSON.stringify({ ...VERDICT, touches: ["routes/registry.js"] }));
  const run = () => runTriage({ projectDir: dir, projectName: "demo", intakeText: "Search the registry", pack, engine, cache });
  const first = await run();
  const second = await run();
  assert.deepEqual(first.ok && first.scope, ["routes/registry.js"]);
  assert.deepEqual(second.ok && second.cached && second.scope, ["routes/registry.js"]);
  assert.equal(engine.calls.length, 1);
});

test("failed runs are never cached", async () => {
  const cache = memoryTriageCache();
  let answer = "nope";
  const engine = fakeEngine(() => answer);
  const run = () => runTriage({ projectDir: dir, projectName: "demo", intakeText: "retry me", pack, engine, cache });
  assert.equal((await run()).ok, false);
  answer = JSON.stringify(VERDICT);
  assert.equal((await run()).ok, true);
  assert.equal(engine.calls.length, 2);
});

test("the file cache survives a new instance and keys on text plus digest", () => {
  const file = path.join(dir, "cache.json");
  const key = triageCacheKey("text", "digest");
  assert.notEqual(key, triageCacheKey("text", "other"));
  fileTriageCache(file).set(key, VERDICT as any);
  assert.deepEqual(fileTriageCache(file).get(key), VERDICT);
  assert.equal(fileTriageCache(file).get("missing"), null);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

/* ---------- the real spawn path, against a fake `claude` ---------- */

function fakeCli(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
}

test("claudeEngine pipes the prompt on stdin and reads the JSON result", async () => {
  const command = fakeCli(
    "claude-ok",
    `let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const tools = args[args.indexOf("--tools") + 1];
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: JSON.stringify({ input, tools, cwd: process.cwd() }) }));
});`,
  );
  const answer = await claudeEngine({ command })({ cwd: dir, systemPrompt: "s", prompt: "the prompt", timeoutMs: 10_000 });
  assert.ok(answer.ok);
  const seen = JSON.parse(answer.text);
  assert.equal(seen.input, "the prompt");
  assert.equal(seen.tools, "");
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(dir));
});

test("claudeEngine kills a run that outlives its timeout", async () => {
  const command = fakeCli("claude-slow", "setTimeout(() => {}, 60_000);");
  const started = Date.now();
  const answer = await claudeEngine({ command })({ cwd: dir, systemPrompt: "s", prompt: "p", timeoutMs: 200 });
  assert.equal(answer.ok, false);
  assert.match((answer as any).error, /timed out/);
  assert.ok(Date.now() - started < 5_000);
});

test("claudeEngine stops on abort and reports a failing exit", async () => {
  const command = fakeCli("claude-slow2", "setTimeout(() => {}, 60_000);");
  const controller = new AbortController();
  const pending = claudeEngine({ command })({ cwd: dir, systemPrompt: "s", prompt: "p", timeoutMs: 60_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  assert.match(((await pending) as any).error, /aborted/);

  const failing = fakeCli("claude-fail", 'process.stderr.write("not logged in\\n"); process.exit(2);');
  const answer = await claudeEngine({ command: failing })({ cwd: dir, systemPrompt: "s", prompt: "p", timeoutMs: 10_000 });
  assert.match((answer as any).error, /exited with code 2: not logged in/);

  const missing = await claudeEngine({ command: path.join(dir, "no-such-cli") })({ cwd: dir, systemPrompt: "s", prompt: "p", timeoutMs: 10_000 });
  assert.match((missing as any).error, /could not launch/);
});
