import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, Override, Project, Signals, Status } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERRIDES_FILE = path.resolve(__dirname, "..", "overrides.json");

export function loadOverrides(): Record<string, Override> {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function saveOverrides(all: Record<string, Override>): void {
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(all, null, 2) + "\n");
}

function daysSince(iso: string | null): number {
  if (!iso) return Infinity;
  const then = new Date(iso + "T00:00:00Z").getTime();
  return (Date.now() - then) / 86_400_000;
}

function matchesArchivePattern(name: string, patterns: string[]): boolean {
  return patterns.some((p) => new RegExp(p, "i").test(name));
}

/** Auto status when no human override forces one. */
function autoStatus(s: Signals, cfg: Config): Status {
  if (matchesArchivePattern(s.name, cfg.archivePatterns)) return "archived";
  return daysSince(s.lastActivity) <= cfg.activeDays ? "active" : "paused";
}

const CATEGORY_ORDER = [
  "Flagship & platform",
  "AI & automation",
  "Client & business websites",
  "Blockchain & DeFi",
  "Apps, libraries & other",
  "Archived · demos · templates",
];

function autoCategory(status: Status): string {
  if (status === "archived") return "Archived · demos · templates";
  return "Apps, libraries & other";
}

export function merge(
  signals: Signals[],
  overrides: Record<string, Override>,
  cfg: Config,
): Project[] {
  const projects = signals.map((s): Project => {
    const o = overrides[s.name] || {};
    const overridden = Object.keys(o) as (keyof Override)[];

    const archived =
      o.archived === true ||
      (o.status ? o.status === "archived" : matchesArchivePattern(s.name, cfg.archivePatterns));

    const status: Status = o.status ?? (archived ? "archived" : autoStatus(s, cfg));

    const description =
      o.description ||
      s.pkgDescription ||
      s.readmeSummary ||
      o.note ||
      "(no description yet)";

    const stack = o.stack || s.stack.join(", ") || "—";

    return {
      name: s.name,
      path: s.path,
      status,
      category: o.category || autoCategory(status),
      description,
      stack,
      next: o.next ?? s.notesNext ?? null,
      priority: o.priority ?? null,
      pinned: o.pinned ?? false,
      archived,
      note: o.note ?? null,
      lastActivity: s.lastActivity,
      lastActivitySource: s.lastActivitySource,
      gitBranch: s.gitBranch,
      gitVersion: s.gitVersion,
      gitLastSubject: s.gitLastSubject,
      hasGit: s.hasGit,
      overridden,
    };
  });

  projects.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastActivity || "").localeCompare(a.lastActivity || "");
  });
  return projects;
}

export function categoryOrder(cat: string): number {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? CATEGORY_ORDER.length - 0.5 : i;
}

export { CATEGORY_ORDER };
