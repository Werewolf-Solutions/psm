import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Aggregated usage of one skill across Claude Code transcripts. */
export interface SkillUsage {
  skill: string;
  count: number;
  lastUsed: number; // epoch ms; 0 if unknown
  projects: string[]; // distinct cwds the skill was invoked in
}

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

/**
 * Mine Claude Code transcripts for Skill invocations.
 *
 * Skills are recorded as `tool_use` blocks `{ name: "Skill", input: { skill } }`
 * inside each transcript line. Optionally filter to a single project directory
 * (matched against each event's `cwd`).
 */
export function collectSkillUsage(projectDir?: string): SkillUsage[] {
  const agg = new Map<string, { count: number; lastUsed: number; projects: Set<string> }>();
  let files: string[] = [];
  try {
    files = listTranscripts(CLAUDE_PROJECTS_DIR);
  } catch {
    return [];
  }
  const want = projectDir ? path.resolve(projectDir) : null;

  for (const file of files) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.indexOf('"Skill"') < 0) continue;
      let ev: any;
      try {
        ev = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const cwd = typeof ev?.cwd === "string" ? path.resolve(ev.cwd) : null;
      if (want && cwd !== want) continue;
      const blocks = ev?.message?.content;
      if (!Array.isArray(blocks)) continue;
      const ts = Date.parse(ev?.timestamp ?? "") || 0;
      for (const block of blocks) {
        if (block?.type !== "tool_use" || block?.name !== "Skill") continue;
        const skill = String(block?.input?.skill ?? "").trim();
        if (!skill) continue;
        const entry = agg.get(skill) ?? { count: 0, lastUsed: 0, projects: new Set<string>() };
        entry.count += 1;
        if (ts > entry.lastUsed) entry.lastUsed = ts;
        if (cwd) entry.projects.add(cwd);
        agg.set(skill, entry);
      }
    }
  }

  return [...agg.entries()]
    .map(([skill, v]) => ({
      skill,
      count: v.count,
      lastUsed: v.lastUsed,
      projects: [...v.projects].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill));
}

function listTranscripts(root: string): string[] {
  const out: string[] = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const projectDir = path.join(root, dir.name);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(path.join(projectDir, entry.name));
      }
    }
  }
  return out;
}
