/**
 * Read-only filesystem browsing, so the link picker can find a folder without
 * the user reciting an absolute path from memory.
 *
 * Deliberately narrow: directories only, one level at a time, never file
 * contents. It exists only in processes that have a disk (dev and agent) and,
 * cross-origin, only behind the pairing token — a listing of someone's home
 * directory is worth protecting even though it holds no file data.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface BrowseEntry {
  name: string;
  path: string;
  /** Looks like a project on its own — shown as a one-click "link this" target. */
  isProject: boolean;
  /** How many project-looking children it has — hints "directory of projects". */
  projectChildren: number;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  home: string;
  entries: BrowseEntry[];
}

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "pubspec.yaml",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "*.csproj",
];

const NOISE = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "vendor", "__pycache__"]);

function looksLikeProject(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  const names = new Set(entries);
  for (const marker of PROJECT_MARKERS) {
    if (marker.startsWith("*")) {
      const suffix = marker.slice(1);
      if (entries.some((e) => e.endsWith(suffix))) return true;
    } else if (names.has(marker)) {
      return true;
    }
  }
  return false;
}

function subdirectories(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !NOISE.has(e.name))
    .map((e) => path.join(dir, e.name));
}

export class BrowseError extends Error {}

/** List the directories inside `target`, defaulting to the user's home. */
export function browse(target?: string): BrowseResult {
  const raw = String(target || "").trim();
  const home = os.homedir();
  const start = !raw ? home : raw.startsWith("~") ? path.join(home, raw.slice(1)) : raw;
  if (!path.isAbsolute(start)) throw new BrowseError("Use an absolute path");

  let dir: string;
  try {
    dir = fs.realpathSync(start);
  } catch {
    throw new BrowseError(`No such folder: ${start}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new BrowseError(`Cannot read ${dir}`);
  }
  if (!stat.isDirectory()) throw new BrowseError(`Not a folder: ${dir}`);

  let children: string[];
  try {
    children = subdirectories(dir);
  } catch {
    throw new BrowseError(`No permission to read ${dir}`);
  }

  const entries: BrowseEntry[] = children
    .map((child) => ({
      name: path.basename(child),
      path: child,
      isProject: looksLikeProject(child),
      // counting grandchildren is what distinguishes "a project" from "a folder
      // of projects" in the picker, and it is one readdir per child at most
      projectChildren: subdirectories(child).filter(looksLikeProject).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, home, entries };
}
