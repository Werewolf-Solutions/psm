import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProjects, writeMarkdown } from "../index.ts";
import { loadOverrides, saveOverrides } from "../classify.ts";
import { STATUS_META } from "../render.ts";
import type { Override } from "../types.ts";

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

app.use(express.static(WEB_DIR));

app.listen(PORT, () => {
  console.log(`psm dashboard → http://localhost:${PORT}`);
});
