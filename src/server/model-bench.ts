/**
 * The Models page: every model this machine can run, its profile, what it
 * costs, and how it scored on the model-bench library (a sibling repo).
 *
 * psm runs under tsx, so it imports model-bench's TypeScript entry directly;
 * runs execute inside this process, one at a time. If model-bench is not
 * checked out, the page still lists models and says how to add it.
 *
 * Starting a run spends a usage window or GPU time, so only the operator can:
 * every POST here sits behind operatorGate (index.ts). Models reach
 * model-bench over its own MCP server, which can file a request and nothing
 * more; the operator approves it here.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express, { type Request, type Response } from "express";
import type { AiEngine } from "./ai.ts";
import type { AiModelCatalog } from "./models.ts";
import type { SubscriptionUsageProvider } from "./usage.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MODEL_BENCH_DIR = process.env.MODEL_BENCH_DIR || path.resolve(HERE, "..", "..", "..", "model-bench");

const CATALOG_TTL_MS = 10 * 60_000;
const ENGINE_ORDER = ["claude", "codex", "ollama", "gguf"] as const;
type EngineId = (typeof ENGINE_ORDER)[number];

/** The parts of model-bench's public surface psm uses (src/index.ts there). */
interface Bench {
  loadLibrary(): { suites: any[]; errors: string[] };
  publicSuite(suite: any, withTasks?: boolean): any;
  appliesTo(suite: any, engine: EngineId, id: string): boolean;
  profileFor(engine: EngineId, id: string, aliases?: (string | null)[]): any;
  listRuns(filter?: { model?: string; suite?: string }): any[];
  readRun(id: string): any;
  deleteRun(id: string): boolean;
  listRequests(): any[];
  decideRequest(id: string, status: "approved" | "dismissed"): any;
  startRuns(request: { models: { engine: EngineId; id: string; label?: string }[]; suites: string[]; effort?: string | null; startedBy: string }): any[];
  cancelRun(id: string): boolean;
  activeRuns(): any[];
  recoverInterrupted(): number;
  board(filter?: { models?: string[]; suites?: string[]; categories?: string[]; effort?: string | null }): { suites: any[]; models: any[] };
  insights(board: { suites: any[]; models: any[] }): Record<string, { strong: any[]; weak: any[] }>;
  newFor(key: string): any[];
  listLocalEngines(): Promise<{ engine: EngineId; status: string; message: string | null; models: any[] }[]>;
  MCP_ENTRY: string;
  MCP_COMMAND?: { command: string; args: string[] };
}

let loading: Promise<Bench> | null = null;

export function loadBench(dir = MODEL_BENCH_DIR): Promise<Bench> {
  if (!loading) {
    const entry = path.join(dir, "src", "index.ts");
    loading = (fs.existsSync(entry)
      ? import(pathToFileURL(entry).href) as Promise<Bench>
      : Promise.reject(new Error(`model-bench not found at ${dir}`)))
      .then((bench) => {
        bench.recoverInterrupted();
        return bench;
      })
      .catch((error) => {
        loading = null; // try again next time: it may get cloned meanwhile
        throw error;
      });
  }
  return loading;
}

export interface ModelRow {
  key: string;
  engine: EngineId;
  id: string;
  label: string;
  description: string;
  aliases: string[];
  efforts: string[];
  available: boolean;
  detail: string | null;
  sizeBytes: number | null;
  params: string | null;
  quantization: string | null;
  family: string | null;
  isDefault: boolean;
}

/**
 * Claude lists the same model under several names (`default`, `opus`,
 * `claude-opus-5-5`). One row per resolved model, keyed by the full id so
 * results do not move when an alias starts pointing somewhere else.
 */
export function catalogRows(catalog: AiModelCatalog): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  for (const model of catalog.models) {
    const id = model.resolvedModel || model.id;
    const existing = rows.get(id);
    if (existing) {
      if (model.id !== id && !existing.aliases.includes(model.id)) existing.aliases.push(model.id);
      existing.isDefault ||= model.isDefault;
      // the named alias ("Opus 5.5") reads better than "Default (recommended)"
      if (existing.label.startsWith("Default") && !model.label.startsWith("Default")) {
        existing.label = model.label;
        existing.description = model.description;
      }
      continue;
    }
    rows.set(id, {
      key: `${catalog.engine}:${id}`,
      engine: catalog.engine,
      id,
      label: model.label,
      description: model.description,
      aliases: model.id !== id ? [model.id] : [],
      efforts: model.effortLevels,
      available: true,
      detail: null,
      sizeBytes: null,
      params: null,
      quantization: null,
      family: null,
      isDefault: model.isDefault,
    });
  }
  return [...rows.values()];
}

export interface ModelBenchRouterOptions {
  catalog: (engine: AiEngine) => Promise<AiModelCatalog>;
  usage: (engine: AiEngine) => Promise<SubscriptionUsageProvider>;
  actor: () => string;
  bench?: () => Promise<Bench>;
}

const listParam = (value: unknown): string[] => typeof value === "string" && value ? value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50) : [];

/** A run without the model's full outputs: the list view does not need them. */
function runSummary(run: any) {
  const { tasks, ...rest } = run;
  return { ...rest, taskCount: tasks?.length ?? 0 };
}

export function modelBenchRouter(options: ModelBenchRouterOptions): express.Router {
  const router = express.Router();
  const bench = options.bench ?? (() => loadBench());
  const catalogs = new Map<AiEngine, { at: number; value: Promise<AiModelCatalog> }>();

  const catalog = (engine: AiEngine, force: boolean) => {
    const cached = catalogs.get(engine);
    if (!force && cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value;
    const value = options.catalog(engine);
    catalogs.set(engine, { at: Date.now(), value });
    value.then((result) => { if (result.source !== "live") catalogs.delete(engine); }, () => catalogs.delete(engine));
    return value;
  };

  const fail = (res: Response, error: unknown, status = 400) => {
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  };

  router.get("/api/models", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const force = req.query.refresh === "1";
    const [claude, codex, claudeUsage, codexUsage] = await Promise.all([
      catalog("claude", force),
      catalog("codex", force),
      options.usage("claude").catch(() => null),
      options.usage("codex").catch(() => null),
    ]);
    let benchError: string | null = null;
    let b: Bench | null = null;
    try { b = await bench(); } catch (error) { benchError = (error as Error).message; }

    const engines: { engine: EngineId; status: string; message: string | null }[] = [
      { engine: "claude", status: claude.source === "live" ? "ready" : "error", message: claude.message },
      { engine: "codex", status: codex.source === "live" ? "ready" : "error", message: codex.message },
    ];
    const rows: ModelRow[] = [...catalogRows(claude), ...catalogRows(codex)];
    if (b) {
      for (const listing of await b.listLocalEngines().catch(() => [])) {
        engines.push({ engine: listing.engine, status: listing.status, message: listing.message });
        for (const model of listing.models) {
          rows.push({
            key: `${listing.engine}:${model.id}`, engine: listing.engine, id: model.id, label: model.label,
            description: model.description || "", aliases: [], efforts: model.efforts || [], available: model.available,
            detail: model.detail ?? null, sizeBytes: model.sizeBytes ?? null, params: model.params ?? null,
            quantization: model.quantization ?? null, family: model.family ?? null, isDefault: false,
          });
        }
      }
    } else {
      engines.push({ engine: "ollama", status: "missing", message: "Needs model-bench." }, { engine: "gguf", status: "missing", message: "Needs model-bench." });
    }

    const board = b ? b.board() : { suites: [], models: [] };
    const scores = new Map(board.models.map((model) => [model.key, model]));
    const insight = b ? b.insights(board) : {};
    const library = b ? b.loadLibrary() : { suites: [], errors: [] };
    // models measured before but no longer offered (retired alias, deleted file) stay visible
    for (const measured of board.models) {
      if (rows.some((row) => row.key === measured.key)) continue;
      const [engine, ...rest] = measured.key.split(":");
      rows.push({
        key: measured.key, engine: engine as EngineId, id: rest.join(":"), label: measured.label, description: "",
        aliases: [], efforts: [], available: false, detail: "No longer offered on this machine; results kept.",
        sizeBytes: null, params: null, quantization: null, family: null, isDefault: false,
      });
    }

    res.json({
      bench: {
        found: !!b,
        dir: MODEL_BENCH_DIR,
        error: benchError,
        libraryErrors: library.errors,
        mcp: b ? (b.MCP_COMMAND ?? { command: "npx", args: ["tsx", b.MCP_ENTRY] }) : null,
      },
      engines,
      usage: [claudeUsage, codexUsage].filter(Boolean),
      suites: library.suites.map((suite) => b!.publicSuite(suite)),
      models: rows.map((row) => ({
        ...row,
        profile: b ? b.profileFor(row.engine, row.id, row.aliases) : null,
        scores: scores.get(row.key) ?? null,
        insight: (insight as any)[row.key] ?? { strong: [], weak: [] },
        applicable: library.suites.filter((suite) => b!.appliesTo(suite, row.engine, row.id)).map((suite) => suite.id),
        newSuites: b ? b.newFor(row.key).map((suite) => suite.id) : [],
      })),
      requests: b ? b.listRequests().filter((request) => request.status === "pending") : [],
      active: b ? b.activeRuns().map(runSummary) : [],
    });
  });

  router.get("/api/models/board", async (req, res) => {
    try {
      const b = await bench();
      const board = b.board({
        models: listParam(req.query.models),
        suites: listParam(req.query.suites),
        categories: listParam(req.query.categories),
        effort: typeof req.query.effort === "string" && req.query.effort ? req.query.effort : null,
      });
      res.json({ ...board, insights: b.insights(board) });
    } catch (error) {
      fail(res, error, 503);
    }
  });

  router.get("/api/models/runs", async (req, res) => {
    try {
      const b = await bench();
      const model = typeof req.query.model === "string" ? req.query.model : undefined;
      const suite = typeof req.query.suite === "string" ? req.query.suite : undefined;
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      res.setHeader("Cache-Control", "no-store");
      res.json({ runs: b.listRuns({ model, suite }).slice(0, limit).map(runSummary), active: b.activeRuns().map(runSummary) });
    } catch (error) {
      fail(res, error, 503);
    }
  });

  router.get("/api/models/runs/:id", async (req, res) => {
    try {
      const b = await bench();
      const run = b.readRun(req.params.id);
      if (!run) return res.status(404).json({ error: "No such run." });
      const suite = b.loadLibrary().suites.find((entry) => entry.id === run.suite.id);
      // the operator sees prompts next to outputs; graders stay in the library
      const prompts = suite && suite.version === run.suite.version
        ? Object.fromEntries(b.publicSuite(suite, true).tasks.map((task: any) => [task.id, task.prompt]))
        : {};
      res.json({ run, prompts });
    } catch (error) {
      fail(res, error, 503);
    }
  });

  router.post("/api/models/runs", express.json(), async (req, res) => {
    try {
      const b = await bench();
      const keys: unknown = req.body?.models;
      const suites: unknown = req.body?.suites;
      if (!Array.isArray(keys) || !Array.isArray(suites)) return fail(res, new Error("models and suites must be lists"));
      const rows = (keys as unknown[]).map((key) => {
        const text = String(key);
        const at = text.indexOf(":");
        const engine = text.slice(0, at) as EngineId;
        if (at < 1 || !ENGINE_ORDER.includes(engine)) throw new Error(`Not a model key: ${text}`);
        return { engine, id: text.slice(at + 1), label: typeof req.body?.labels?.[text] === "string" ? req.body.labels[text] : undefined };
      });
      const effort = typeof req.body?.effort === "string" && req.body.effort ? req.body.effort : null;
      const runs = b.startRuns({ models: rows, suites: suites.map(String), effort, startedBy: options.actor() });
      res.status(202).json({ runs: runs.map(runSummary) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/api/models/runs/:id/cancel", async (req, res) => {
    try {
      const b = await bench();
      res.json({ cancelled: b.cancelRun(req.params.id) });
    } catch (error) {
      fail(res, error, 503);
    }
  });

  router.delete("/api/models/runs/:id", async (req, res) => {
    try {
      const b = await bench();
      const run = b.readRun(req.params.id);
      if (!run) return res.status(404).json({ error: "No such run." });
      if (run.status === "queued" || run.status === "running") return fail(res, new Error("Cancel the run before deleting it."), 409);
      res.json({ deleted: b.deleteRun(req.params.id) });
    } catch (error) {
      fail(res, error, 503);
    }
  });

  router.post("/api/models/requests/:id", express.json(), async (req, res) => {
    try {
      const b = await bench();
      const decision = req.body?.decision;
      if (decision !== "approve" && decision !== "dismiss") return fail(res, new Error("decision must be approve or dismiss"));
      const pending = b.listRequests().find((request) => request.id === req.params.id && request.status === "pending");
      if (!pending) return res.status(404).json({ error: "No pending request with that id." });
      let runs: any[] = [];
      if (decision === "approve") {
        const at = pending.model.indexOf(":");
        runs = b.startRuns({
          models: [{ engine: pending.model.slice(0, at), id: pending.model.slice(at + 1) }],
          suites: pending.suites,
          startedBy: `${options.actor()} (approved request ${pending.id})`,
        });
      }
      const request = b.decideRequest(pending.id, decision === "approve" ? "approved" : "dismissed");
      res.json({ request, runs: runs.map(runSummary) });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
