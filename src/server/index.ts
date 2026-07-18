import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getProjects, writeMarkdown } from "../index.ts";
import { loadOverrides, saveOverrides } from "../classify.ts";
import { loadConfig, workspaceRoot } from "../scan.ts";
import { STATUS_META } from "../render.ts";
import type { Override } from "../types.ts";
import { allProcStates, procState, start, stop, subscribe, type ProcKind } from "./procs.ts";
import { activeSessions, aiLimit, aiState, cancel as aiCancel, recap as aiRecap, send as aiSend, subscribeAi, WORKSPACE_NAME, type AiEngine } from "./ai.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "..", "web");
const HOUSE_RULES = path.resolve(__dirname, "..", "..", "house-rules.md");
const PORT = Number(process.env.PORT || 4317);

const app = express();
app.use(cors());
app.use(express.json());

const OVERRIDE_KEYS: (keyof Override)[] = [
  "status",
  "category",
  "description",
  "stack",
  "next",
  "priority",
  "pinned",
  "archived",
  "note",
  "runCommand",
  "deployStaging",
  "deployProduction",
  "port",
  "aiEngine",
  "aiFullAccess",
];

app.get("/api/projects", (_req, res) => {
  res.json({ projects: getProjects(), statusMeta: STATUS_META });
});

// Update the human-curated override for one project.
app.patch("/api/projects/:name", (req, res) => {
  const name = req.params.name;
  const all = loadOverrides();
  const current: Override = all[name] || {};
  for (const key of OVERRIDE_KEYS) {
    if (!(key in req.body)) continue;
    const val = req.body[key];
    // empty string / null clears the override for that field
    if (val === "" || val === null) delete (current as any)[key];
    else (current as any)[key] = val;
  }
  if (Object.keys(current).length) all[name] = current;
  else delete all[name];
  saveOverrides(all);
  res.json({ ok: true, override: all[name] || null });
});

// Regenerate PROJECTS.md from the current merged state.
app.post("/api/export", (_req, res) => {
  const file = writeMarkdown();
  res.json({ ok: true, file });
});

/* ---------- house rules (shared AI system prompt) ---------- */

app.get("/api/house-rules", (_req, res) => {
  let content = "";
  try {
    content = fs.readFileSync(HOUSE_RULES, "utf8");
  } catch {
    /* file may not exist yet */
  }
  res.json({ content });
});

app.put("/api/house-rules", (req, res) => {
  fs.writeFileSync(HOUSE_RULES, String(req.body?.content ?? ""));
  res.json({ ok: true });
});

/* ---------- create a new project ---------- */

app.post("/api/projects/new", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  // folder-safe: starts alphanumeric, then letters/digits/._- ; no slashes/traversal
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    return res.status(400).json({ error: "use letters, digits, dashes or underscores" });

  const root = workspaceRoot(loadConfig());
  const dir = path.join(root, name);
  if (!dir.startsWith(root + path.sep))
    return res.status(400).json({ error: "invalid name" });
  if (fs.existsSync(dir))
    return res.status(409).json({ error: "a folder with that name already exists" });

  fs.mkdirSync(dir, { recursive: true });

  const description = String(req.body?.description ?? "").trim();
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n\n${description || "New project."}\n`);

  // drop the house rules in as CLAUDE.md so the project's AI picks them up
  if (req.body?.applyHouseRules !== false) {
    try {
      fs.writeFileSync(path.join(dir, "CLAUDE.md"), fs.readFileSync(HOUSE_RULES, "utf8"));
    } catch {
      /* no house rules yet — skip */
    }
  }

  if (req.body?.gitInit !== false) {
    try {
      execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
    } catch {
      /* git not available — the folder is still created */
    }
  }

  if (description) {
    const all = loadOverrides();
    all[name] = { ...(all[name] || {}), description };
    saveOverrides(all);
  }

  res.json({ ok: true, name });
});

/* ---------- cockpit: run a project & stream its logs ---------- */

function findProject(name: string) {
  return getProjects().find((p) => p.name === name);
}

function parseKind(v: unknown): ProcKind {
  return v === "deploy:staging" || v === "deploy:production" ? v : "run";
}

// the command a given process kind should run for a project
function commandForKind(proj: ReturnType<typeof findProject> & {}, kind: ProcKind): string | null {
  if (kind === "deploy:staging") return proj.deployStaging;
  if (kind === "deploy:production") return proj.deployProduction;
  return proj.runCommand;
}

// live status of every managed process (for dashboard "running" dots)
app.get("/api/procs", (_req, res) => {
  res.json({ procs: allProcStates() });
});

// projects with an ongoing AI conversation — the "Working on" lane
app.get("/api/sessions", (_req, res) => {
  res.json({ sessions: activeSessions() });
});

// current provider usage limit for an engine (so the AI pane can warn upfront)
app.get("/api/ai/limit", (req, res) => {
  res.json({ limit: aiLimit(parseEngine(req.query.engine, "claude")) });
});

// the workspace-wide chat target (its saved engine / full-access defaults)
app.get("/api/workspace", (_req, res) => {
  const o = loadOverrides()[WORKSPACE_NAME] || {};
  res.json({ name: WORKSPACE_NAME, aiEngine: o.aiEngine || "claude", aiFullAccess: !!o.aiFullAccess });
});

// snapshot status for one project+kind
app.get("/api/projects/:name/proc", (req, res) => {
  res.json(procState(req.params.name, parseKind(req.query.kind)));
});

// start the project's run (or deploy) command
app.post("/api/projects/:name/run", (req, res) => {
  const kind = parseKind(req.body?.kind);
  const proj = findProject(req.params.name);
  if (!proj) return res.status(404).json({ error: "unknown project" });
  const command =
    (req.body?.command && String(req.body.command).trim()) || commandForKind(proj, kind);
  if (!command)
    return res.status(400).json({ error: `no ${kind} command set for ${proj.name}` });
  const p = start(proj.name, kind, command, proj.path);
  res.json({ ok: true, status: p.status, command });
});

// stop it
app.post("/api/projects/:name/stop", (req, res) => {
  const stopped = stop(req.params.name, parseKind(req.body?.kind));
  res.json({ ok: true, stopped });
});

// SSE log stream (replays buffer, then live)
app.get("/api/projects/:name/logs/stream", (req, res) => {
  subscribe(res, req.params.name, parseKind(req.query.kind));
});

/* ---------- cockpit: AI pane ---------- */

function parseEngine(v: unknown, fallback: AiEngine): AiEngine {
  return v === "codex" || v === "claude" ? v : fallback;
}

// The AI target: a real project, or the workspace-wide chat (cwd = workspace root).
function aiTarget(name: string) {
  if (name === WORKSPACE_NAME) {
    const o = loadOverrides()[WORKSPACE_NAME] || {};
    return {
      name: WORKSPACE_NAME,
      path: workspaceRoot(loadConfig()),
      aiEngine: (o.aiEngine as AiEngine) || "claude",
      aiFullAccess: !!o.aiFullAccess,
    };
  }
  return findProject(name);
}

// a compact rundown of every project, so the workspace chat knows what exists
function workspaceRundown(): string {
  const lines = getProjects()
    .filter((p) => !p.archived)
    .map(
      (p) =>
        `- ${p.name} [${p.status}${p.stack && p.stack !== "—" ? `, ${p.stack}` : ""}] — ${p.description}`,
    );
  return (
    "You are the workspace-wide assistant for this folder of projects. Each project below is a " +
    "subdirectory you can read and edit. The psm tool (in ./psm) tracks them all and generates " +
    "psm/PROJECTS.md from psm/overrides.json — regenerate it with `npm run build:md` in ./psm " +
    "after anything that changes a project's description or status.\n\nProjects:\n" +
    lines.join("\n")
  );
}

// transcript stream (replays history, then live)
app.get("/api/projects/:name/ai/stream", (req, res) => {
  const t = aiTarget(req.params.name);
  if (!t) return res.status(404).end();
  subscribeAi(res, t.name, t.path, parseEngine(req.query.engine, t.aiEngine));
});

// send one message to the project's (or workspace's) AI
app.post("/api/projects/:name/ai", (req, res) => {
  const t = aiTarget(req.params.name);
  if (!t) return res.status(404).json({ error: "unknown project" });
  const engine = parseEngine(req.body?.engine, t.aiEngine);
  const fullAccess = req.body?.fullAccess ?? t.aiFullAccess;
  const extra = t.name === WORKSPACE_NAME ? workspaceRundown() : "";
  const r = aiSend(t.name, t.path, engine, String(req.body?.message ?? ""), !!fullAccess, extra);
  res.status(r.ok ? 200 : 409).json(r);
});

// cancel the in-flight turn
app.post("/api/projects/:name/ai/cancel", (req, res) => {
  res.json({ ok: true, cancelled: aiCancel(req.params.name) });
});

app.get("/api/projects/:name/ai/state", (req, res) => {
  res.json(aiState(req.params.name));
});

// "where we left off" recap — regenerated only when the transcript has grown
app.get("/api/projects/:name/ai/recap", async (req, res) => {
  try {
    res.json({ summary: await aiRecap(req.params.name) });
  } catch {
    res.json({ summary: null });
  }
});

app.use(express.static(WEB_DIR));

app.listen(PORT, () => {
  console.log(`psm dashboard → http://localhost:${PORT}`);
});
