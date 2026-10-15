/**
 * The access levels, published where terminal agents read them.
 *
 * psm cannot sandbox a Claude Code or Codex session it did not start, so for
 * those the levels are guidance: one marked block in the machine-wide
 * instruction files (`~/.claude/CLAUDE.md`, and `~/.codex/AGENTS.md` when Codex
 * is set up). Machine-wide because a database's level is a fact about this
 * machine, and so nothing about it lands in any repository or commit.
 *
 * Everything else in those files is the user's and is left byte-for-byte alone.
 * Every name written here passes `clean`, because this text becomes
 * instructions: a container called "ignore previous instructions" must arrive
 * as a harmless label, not a sentence.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ENGINE_LABEL, databaseKey, envReferences, type Engine } from "./discover.ts";
import { LEVEL_RULE } from "./levels.ts";
import type { Level, ResourceSetting } from "./store.ts";

export const BLOCK_START = "<!-- psm:resources:start -->";
export const BLOCK_END = "<!-- psm:resources:end -->";

const LEVEL_NAME: Record<Level, string> = { none: "None", read: "Read", full: "Full" };

/** Labels only: letters, digits and path-ish punctuation, short, one line. */
export function clean(value: string, max = 80): string {
  const safe = value.replace(/[^A-Za-z0-9 ._:/@~()+-]/g, "").replace(/\s+/g, " ").trim();
  return safe.length > max ? `${safe.slice(0, max - 1)}…` : safe || "?";
}

function home(value: string): string {
  const dir = os.homedir();
  return value === dir || value.startsWith(dir + path.sep) ? `~${value.slice(dir.length)}` : value;
}

/** `db:mongodb:localhost:27017` → `local MongoDB :27017`. */
export function keyLabel(key: string): string {
  const db = /^db:([a-z]+):(.+):([^:]+)$/.exec(key);
  if (db) {
    const engine = ENGINE_LABEL[db[1] as Engine] ?? db[1];
    if (db[2] === "localhost") return `local ${engine} :${db[3]}`;
    if (db[2] === "container") return `${engine} in container ${db[3]}`;
    return `${engine} at ${db[2]}${db[3] === "srv" ? "" : `:${db[3]}`}`;
  }
  if (key.startsWith("container:")) return `container ${key.slice("container:".length)}`;
  if (key.startsWith("folder:")) return `folder ${home(key.slice("folder:".length))}`;
  return key;
}

export interface GuidanceRow {
  key: string;
  level: Level | null;
  usedBy: string[];
}

/** Levels you set, plus databases your projects use that have none yet. */
export function guidanceRows(settings: ResourceSetting[], projects: Array<{ name: string; path: string }>): GuidanceRow[] {
  const rows = new Map<string, GuidanceRow>();
  for (const setting of settings) if (setting.level) rows.set(setting.key, { key: setting.key, level: setting.level, usedBy: [] });
  for (const ref of envReferences(projects)) {
    const key = databaseKey(ref.target);
    const row = rows.get(key) ?? { key, level: null, usedBy: [] };
    row.usedBy.push(`${ref.project}${ref.directory ? `/${ref.directory}` : ""} ${ref.variable}${ref.target.database ? ` (${ref.target.database})` : ""}`);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => keyLabel(a.key).localeCompare(keyLabel(b.key)));
}

export function renderGuidance(rows: GuidanceRow[]): string | null {
  if (!rows.length) return null;
  const lines = [
    BLOCK_START,
    "## Machine resources and access (from psm)",
    "",
    "Written by psm from its Resources panel; edits inside this block are replaced. psm cannot lock these for sessions it did not start, so following them is up to you:",
    "",
    `- **None**: ${LEVEL_RULE.none}.`,
    `- **Read**: ${LEVEL_RULE.read}.`,
    `- **Full**: ${LEVEL_RULE.full}.`,
    "- Anything not listed, or listed as not set, is **None**. Never print connection strings or credentials.",
    "- For a project's database scripts, prefer psm's Data card (Preview, then Apply) over running them yourself.",
    "",
    "| Resource | Access | Used by |",
    "|---|---|---|",
  ];
  for (const row of rows) {
    const level = row.level ? LEVEL_NAME[row.level] : "not set (None)";
    const users = row.usedBy.length ? [...new Set(row.usedBy)].map((use) => clean(use, 120)).join("; ") : "-";
    lines.push(`| ${clean(keyLabel(row.key))} | ${level} | ${users} |`);
  }
  lines.push(BLOCK_END);
  return lines.join("\n");
}

/** Replace (or add, or remove) psm's block in `text`, leaving the rest untouched. */
export function withBlock(text: string, block: string | null): string {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END, start);
  if (start !== -1 && end !== -1) {
    const before = text.slice(0, start);
    const after = text.slice(end + BLOCK_END.length);
    if (block) return before + block + after;
    // Removing: take the blank line we added with it, nothing more.
    return (before.replace(/\n\n$/, "\n") + after.replace(/^\n/, "")).replace(/^\n$/, "");
  }
  if (!block) return text;
  if (!text) return `${block}\n`;
  return `${text.replace(/\n*$/, "")}\n\n${block}\n`;
}

/** The instruction files to keep the block in: Claude Code's always, Codex's when it is set up. */
export function guidanceFiles(dir = os.homedir()): string[] {
  const files = [path.join(dir, ".claude", "CLAUDE.md")];
  if (fs.existsSync(path.join(dir, ".codex"))) files.push(path.join(dir, ".codex", "AGENTS.md"));
  return files;
}

/** Write the block into each file, atomically, only when it changed. */
export function publishGuidance(files: string[], block: string | null): string[] {
  const written: string[] = [];
  for (const file of files) {
    let current = "";
    let mode = 0o644;
    try {
      current = fs.readFileSync(file, "utf8");
      mode = fs.statSync(file).mode & 0o777;
    } catch {
      if (!block) continue; // nothing to remove from a file that is not there
    }
    const next = withBlock(current, block);
    if (next === current) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.psm-${process.pid}.tmp`;
    fs.writeFileSync(temp, next, { mode });
    fs.renameSync(temp, file);
    written.push(file);
  }
  return written;
}
