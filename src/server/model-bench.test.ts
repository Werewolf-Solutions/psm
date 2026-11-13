import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { catalogRows, modelBenchRouter } from "./model-bench.ts";
import type { AiModelCatalog } from "./models.ts";

const claude: AiModelCatalog = {
  engine: "claude",
  source: "live",
  updatedAt: 0,
  message: null,
  effortLevels: ["low", "high"],
  models: [
    { id: "default", resolvedModel: "claude-opus-5-5", label: "Default (recommended)", description: "Opus 5.5 · Best for everyday", effortLevels: ["low", "high"], defaultEffort: null, isDefault: true },
    { id: "opus", resolvedModel: "claude-opus-5-5", label: "Opus 5.5", description: "For complex work", effortLevels: ["low", "high"], defaultEffort: null, isDefault: false },
    { id: "haiku", resolvedModel: "claude-haiku-5-5", label: "Haiku 5.5", description: "Fastest", effortLevels: ["low"], defaultEffort: null, isDefault: false },
    { id: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", label: "Opus 4.8", description: "", effortLevels: [], defaultEffort: null, isDefault: false },
  ],
};

test("Claude aliases collapse into one row per resolved model, keyed by the full id", () => {
  const rows = catalogRows(claude);
  assert.deepEqual(rows.map((r) => r.key), ["claude:claude-opus-5-5", "claude:claude-haiku-5-5", "claude:claude-opus-4-8"]);
  const opus = rows[0];
  assert.deepEqual(opus.aliases, ["default", "opus"]);
  assert.equal(opus.label, "Opus 5.5", "the named alias wins over “Default (recommended)”");
  assert.equal(opus.isDefault, true);
  assert.deepEqual(rows[2].aliases, []);
});

function fakeBench() {
  const started: any[] = [];
  const decided: any[] = [];
  const requests = [{ id: "req_1", model: "claude:claude-haiku-5-5", suites: ["stable-facts"], reason: "new", requestedBy: "mcp", requestedAt: 1, status: "pending", decidedAt: null }];
  const suite = { id: "stable-facts", version: 1, title: "Stable facts", category: "knowledge", scope: { kind: "general" }, tags: [], addedAt: "2026-11-13", tasks: [{ id: "a", prompt: "Q?", grader: { type: "exact", answer: "secret" } }] };
  const bench: any = {
    loadLibrary: () => ({ suites: [suite], errors: [] }),
    publicSuite: (s: any, withTasks = false) => ({ id: s.id, version: s.version, title: s.title, category: s.category, scope: s.scope, tags: s.tags, addedAt: s.addedAt, taskCount: s.tasks.length, ...(withTasks ? { tasks: s.tasks.map((t: any) => ({ id: t.id, prompt: t.prompt })) } : {}) }),
    appliesTo: () => true,
    profileFor: (engine: string, id: string) => (id === "claude-haiku-5-5" ? { displayName: "Claude Haiku 5.5", pricing: { inputPerMTok: 0.1, outputPerMTok: 0.5 }, capabilities: {} } : null),
    listRuns: () => [{ id: "run_a", model: { key: "claude:claude-haiku-5-5", label: "Haiku" }, suite: { id: "stable-facts", version: 1 }, status: "done", tasks: [{ taskId: "a", output: "x" }], summary: { score: 1 } }],
    readRun: (id: string) => id === "run_a" ? { id, suite: { id: "stable-facts", version: 1 }, tasks: [] } : null,
    deleteRun: () => true,
    listRequests: () => requests,
    decideRequest: (id: string, status: string) => { decided.push([id, status]); return { id, status }; },
    startRuns: (request: any) => { started.push(request); return request.suites.map((s: string) => ({ id: `run_${s}`, suite: { id: s }, tasks: [] })); },
    cancelRun: () => true,
    activeRuns: () => [],
    recoverInterrupted: () => 0,
    board: () => ({ suites: [], models: [{ key: "claude:claude-haiku-5-5", label: "Haiku", suites: {}, categories: {}, overall: 1, runs: 1 }, { key: "gguf:gone", label: "Gone", suites: {}, categories: {}, overall: 0.5, runs: 1 }] }),
    insights: () => ({ "claude:claude-haiku-5-5": { strong: [{ category: "knowledge", score: 1 }], weak: [] } }),
    newFor: () => [],
    listLocalEngines: async () => [{ engine: "gguf", status: "stopped", message: null, models: [{ id: "qwen3-1.7b-q8_0", label: "Qwen3 1.7B", efforts: ["on", "off"], available: true, sizeBytes: 5 }] }],
    MCP_ENTRY: "/x/model-bench/src/mcp.ts",
    MCP_COMMAND: { command: "/x/model-bench/node_modules/.bin/tsx", args: ["/x/model-bench/src/mcp.ts"] },
  };
  return { bench, started, decided };
}

async function serve(router: express.Router) {
  const app = express();
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

const options = (bench: any) => ({
  catalog: async (engine: "claude" | "codex") => engine === "claude" ? claude : { ...claude, engine: "codex" as const, models: [] },
  usage: async () => ({ id: "claude" as const, name: "Claude", status: "available" as const, plan: "Max", windows: [], metrics: [], credits: null, updatedAt: 0, message: null }),
  actor: () => "local:tester",
  bench: async () => bench,
});

test("GET /api/models merges CLI catalogs, local engines, profiles, scores and keeps retired measured models", async () => {
  const { bench } = fakeBench();
  const { base, close } = await serve(modelBenchRouter(options(bench)));
  try {
    const body = await (await fetch(`${base}/api/models`)).json();
    const keys = body.models.map((m: any) => m.key);
    assert.ok(keys.includes("claude:claude-opus-5-5"));
    assert.ok(keys.includes("gguf:qwen3-1.7b-q8_0"));
    const retired = body.models.find((m: any) => m.key === "gguf:gone");
    assert.equal(retired.available, false, "a measured model that is gone stays, marked unavailable");
    const haiku = body.models.find((m: any) => m.key === "claude:claude-haiku-5-5");
    assert.equal(haiku.profile.pricing.inputPerMTok, 0.1);
    assert.equal(haiku.scores.overall, 1);
    assert.equal(haiku.insight.strong[0].category, "knowledge");
    assert.deepEqual(body.suites.map((s: any) => s.id), ["stable-facts"]);
    assert.ok(!JSON.stringify(body).includes("secret"), "graders never reach the page");
    assert.equal(body.requests.length, 1);
    assert.deepEqual(body.bench.mcp, { command: "/x/model-bench/node_modules/.bin/tsx", args: ["/x/model-bench/src/mcp.ts"] });
    assert.deepEqual(body.engines.map((e: any) => e.engine), ["claude", "codex", "gguf"]);
  } finally {
    await close();
  }
});

test("run list omits outputs; a run's detail carries prompts but not graders", async () => {
  const { bench } = fakeBench();
  const { base, close } = await serve(modelBenchRouter(options(bench)));
  try {
    const list = await (await fetch(`${base}/api/models/runs`)).json();
    assert.equal(list.runs[0].tasks, undefined);
    assert.equal(list.runs[0].taskCount, 1);
    const detail = await (await fetch(`${base}/api/models/runs/run_a`)).json();
    assert.equal(detail.prompts.a, "Q?");
    assert.ok(!JSON.stringify(detail).includes("secret"));
    assert.equal((await fetch(`${base}/api/models/runs/run_zzz`)).status, 404);
  } finally {
    await close();
  }
});

test("POST /api/models/runs validates model keys and records who started it", async () => {
  const { bench, started } = fakeBench();
  const { base, close } = await serve(modelBenchRouter(options(bench)));
  try {
    const post = (body: unknown) => fetch(`${base}/api/models/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ models: ["nope"], suites: ["stable-facts"] })).status, 400);
    assert.equal((await post({ models: "claude:x", suites: [] })).status, 400);
    const ok = await post({ models: ["gguf:qwen3-1.7b-q8_0"], suites: ["stable-facts"], effort: "off", labels: { "gguf:qwen3-1.7b-q8_0": "Qwen3 1.7B" } });
    assert.equal(ok.status, 202);
    assert.deepEqual(started[0], { models: [{ engine: "gguf", id: "qwen3-1.7b-q8_0", label: "Qwen3 1.7B" }], suites: ["stable-facts"], effort: "off", startedBy: "local:tester" });
  } finally {
    await close();
  }
});

test("approving a model's request starts its runs; dismissing starts nothing", async () => {
  const { bench, started, decided } = fakeBench();
  const { base, close } = await serve(modelBenchRouter(options(bench)));
  try {
    const decide = (id: string, decision: string) => fetch(`${base}/api/models/requests/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) });
    assert.equal((await decide("req_1", "maybe")).status, 400);
    assert.equal((await decide("req_404", "approve")).status, 404);
    const body = await (await decide("req_1", "approve")).json();
    assert.equal(body.runs.length, 1);
    assert.equal(started[0].models[0].id, "claude-haiku-5-5");
    assert.match(started[0].startedBy, /approved request req_1/);
    assert.deepEqual(decided[0], ["req_1", "approved"]);
  } finally {
    await close();
  }
});

test("without model-bench the page still lists CLI models and says why benchmarks are missing", async () => {
  const { base, close } = await serve(modelBenchRouter({ ...options(null), bench: async () => { throw new Error("model-bench not found at /nowhere"); } }));
  try {
    const body = await (await fetch(`${base}/api/models`)).json();
    assert.equal(body.bench.found, false);
    assert.match(body.bench.error, /not found/);
    assert.ok(body.models.some((m: any) => m.key === "claude:claude-opus-5-5"));
    assert.equal((await fetch(`${base}/api/models/board`)).status, 503);
  } finally {
    await close();
  }
});
