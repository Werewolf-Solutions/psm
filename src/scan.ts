import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, Signals } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PSM_ROOT = path.resolve(__dirname, "..");

export function loadConfig(): Config {
  const raw = JSON.parse(
    fs.readFileSync(path.join(PSM_ROOT, "psm.config.json"), "utf8"),
  );
  return raw as Config;
}

export function workspaceRoot(cfg: Config): string {
  return path.resolve(PSM_ROOT, cfg.workspaceRoot);
}

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Newest mtime among top-level entries, skipping heavy/noise dirs. */
function newestFileMtime(dir: string): number {
  let newest = 0;
  const skip = new Set(["node_modules", ".git", "dist", "build", ".next"]);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    try {
      const m = fs.statSync(path.join(dir, e.name)).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      /* ignore */
    }
  }
  return newest;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function readJSON(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function detectStack(dir: string): string[] {
  const stack: string[] = [];
  const has = (p: string) => fs.existsSync(path.join(dir, p));
  const glob = (re: RegExp, sub = "") => {
    try {
      return fs
        .readdirSync(path.join(dir, sub))
        .some((f) => re.test(f));
    } catch {
      return false;
    }
  };

  if (has("Cargo.toml")) stack.push("Rust");
  if (glob(/\.(sln|csproj)$/) || glob(/\.(sln|csproj)$/, "src")) stack.push(".NET/C#");
  if (has("go.mod")) stack.push("Go");
  if (has("requirements.txt") || has("pyproject.toml") || has("setup.py"))
    stack.push("Python");

  const pkg = readJSON(path.join(dir, "package.json"));
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const keys = Object.keys(deps).map((k) => k.toLowerCase());
    const map: [RegExp, string][] = [
      [/^next$/, "Next.js"],
      [/^react$/, "React"],
      [/^vite$/, "Vite"],
      [/^express$/, "Express"],
      [/tailwind/, "Tailwind"],
      [/^typescript$/, "TypeScript"],
      [/mongoose|^mongodb$/, "MongoDB"],
      [/sqlite/, "SQLite"],
      [/^electron$/, "Electron"],
      [/hardhat/, "Hardhat"],
      [/^ethers$/, "ethers"],
      [/telegraf|telegram/, "Telegram"],
      [/@anthropic-ai|openai/, "LLM"],
    ];
    for (const [re, label] of map) {
      if (keys.some((k) => re.test(k)) && !stack.includes(label)) stack.push(label);
    }
    if (!stack.length) stack.push("Node");
  }

  // Solidity: look shallowly for .sol
  const solDirs = ["", "contracts", "src", "src/contracts"];
  if (!stack.includes("Solidity")) {
    for (const s of solDirs) {
      if (glob(/\.sol$/, s)) {
        stack.push("Solidity");
        break;
      }
    }
  }
  return stack;
}

/** Best guess at how to run a project — the user can override in the dashboard. */
function detectRunCommand(dir: string, pkg: any | null): string | null {
  if (pkg?.scripts) {
    const s = pkg.scripts;
    // prefer a long-running dev/serve script; fall back to start
    for (const name of ["dev", "server", "serve", "start"]) {
      if (s[name]) return name === "start" ? "npm start" : `npm run ${name}`;
    }
  }
  if (fs.existsSync(path.join(dir, "Cargo.toml"))) return "cargo run";
  for (const entry of ["server.js", "index.js", "app.js", "main.py", "app.py"]) {
    if (fs.existsSync(path.join(dir, entry)))
      return entry.endsWith(".py") ? `python ${entry}` : `node ${entry}`;
  }
  return null;
}

function firstMeaningfulLine(text: string, max = 320): string | null {
  const lines = text.split(/\r?\n/);
  let title = "";
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("#")) {
      if (!title) title = l.replace(/^#+\s*/, "");
      continue;
    }
    if (l.startsWith(">") || l.startsWith("```") || l.startsWith("|")) continue;
    return l.replace(/\s+/g, " ").slice(0, max);
  }
  return title || null;
}

function readReadme(dir: string): string | null {
  for (const name of ["README.md", "readme.md", "README", "Readme.md"]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return firstMeaningfulLine(fs.readFileSync(p, "utf8"));
  }
  return null;
}

function readNotesNext(dir: string): string | null {
  for (const name of ["notes.md", "todo.md", "todos.md", "TODO.md"]) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    for (const raw of lines) {
      const l = raw.trim();
      // open checkbox items are the best "next" signal
      const m = l.match(/^-?\s*\[[ >x?]?\]\s*(.+)/i) || l.match(/^-\s+(.+)/);
      if (m && m[1] && m[1].length > 4 && !/^\*\*/.test(m[1])) {
        return m[1].replace(/\s+/g, " ").slice(0, 240);
      }
    }
  }
  return null;
}

export function scanOne(dir: string, name: string): Signals {
  const hasGit = fs.existsSync(path.join(dir, ".git"));
  let lastActivity: string | null = null;
  let lastActivitySource: Signals["lastActivitySource"] = null;
  let gitBranch: string | null = null;
  let gitVersion: string | null = null;
  let gitLastSubject: string | null = null;

  if (hasGit) {
    const iso = git(dir, ["log", "-1", "--format=%cI"]);
    if (iso) {
      lastActivity = iso.slice(0, 10);
      lastActivitySource = "git";
    }
    gitBranch = git(dir, ["branch", "--show-current"]) || null;
    // real tag only — no commit-hash fallback, which would just be noise
    gitVersion = git(dir, ["describe", "--tags", "--abbrev=0"]) || null;
    gitLastSubject = git(dir, ["log", "-1", "--format=%s"]) || null;
  }
  if (!lastActivity) {
    const m = newestFileMtime(dir);
    if (m) {
      lastActivity = isoDay(m);
      lastActivitySource = "files";
    }
  }

  const pkg = readJSON(path.join(dir, "package.json"));

  return {
    name,
    path: dir,
    hasGit,
    gitBranch,
    gitVersion,
    gitLastSubject,
    lastActivity,
    lastActivitySource,
    stack: detectStack(dir),
    pkgName: pkg?.name ?? null,
    pkgDescription: pkg?.description ?? null,
    readmeSummary: readReadme(dir),
    notesNext: readNotesNext(dir),
    hasReadme:
      fs.existsSync(path.join(dir, "README.md")) ||
      fs.existsSync(path.join(dir, "readme.md")),
    runCommand: detectRunCommand(dir, pkg),
  };
}

export function scanWorkspace(cfg: Config): Signals[] {
  const root = workspaceRoot(cfg);
  const ignore = new Set(cfg.ignore);
  const out: Signals[] = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    if (ignore.has(e.name)) continue;
    out.push(scanOne(path.join(root, e.name), e.name));
  }
  out.sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""));
  return out;
}
