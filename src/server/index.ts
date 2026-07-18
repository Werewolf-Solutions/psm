import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProjects, writeMarkdown } from "../index.ts";
import { loadOverrides, saveOverrides } from "../classify.ts";
import { STATUS_META } from "../render.ts";
import type { Override } from "../types.ts";
import { allProcStates, procState, start, stop, subscribe, type ProcKind } from "./procs.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "..", "web");
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
  "deployCommand",
  "port",
  "aiEngine",
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

/* ---------- cockpit: run a project & stream its logs ---------- */

function findProject(name: string) {
  return getProjects().find((p) => p.name === name);
}

function parseKind(v: unknown): ProcKind {
  return v === "deploy" ? "deploy" : "run";
}

// live status of every managed process (for dashboard "running" dots)
app.get("/api/procs", (_req, res) => {
  res.json({ procs: allProcStates() });
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
    (req.body?.command && String(req.body.command).trim()) ||
    (kind === "deploy" ? proj.deployCommand : proj.runCommand);
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

app.use(express.static(WEB_DIR));

app.listen(PORT, () => {
  console.log(`psm dashboard → http://localhost:${PORT}`);
});
