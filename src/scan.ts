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

/** Best guess at the dev-server port — overridable, and refined live from run logs. */
function detectPort(dir: string, pkg: any | null, stack: string[]): number | null {
  const clamp = (n: number) => (n > 0 && n < 65536 ? n : null);
  const flag = (t: string) => {
    const m = t.match(/(?:--port|-p)[=\s]+['"]?(\d{2,5})/);
    return m ? clamp(Number(m[1])) : null;
  };
  // \bPORT avoids matching SMTP_PORT / IMAP_PORT / DB_PORT etc.
  const envPort = (t: string) => {
    const m = t.match(/\bPORT\s*[=:]\s*['"]?(\d{2,5})/i);
    return m ? clamp(Number(m[1])) : null;
  };
  const scripts = pkg?.scripts ? (Object.values(pkg.scripts) as string[]) : [];

  // 1) an explicit --port flag in a script is authoritative
  for (const v of scripts) {
    const p = flag(v);
    if (p) return p;
  }
  // 2) the web preview targets the frontend dev server — prefer its framework default
  //    over a stray PORT= (which is usually a backend/API port)
  if (stack.includes("Next.js")) return 3000;
  if (stack.includes("Vite")) return 5173;
  // 3) PORT= in a script or an env file
  for (const v of scripts) {
    const p = envPort(v);
    if (p) return p;
  }
  for (const f of [".env", ".env.local", ".env.development"]) {
    try {
      const p = envPort(fs.readFileSync(path.join(dir, f), "utf8"));
      if (p) return p;
    } catch {
      /* no such file */
    }
  }
  return null;
}

/** The Go module's short name, from go.mod. */
function goModuleName(dir: string): string | null {
  try {
    const m = fs.readFileSync(path.join(dir, "go.mod"), "utf8").match(/^module\s+(\S+)/m);
    return m ? m[1].split("/").pop() || null : null;
  } catch {
    return null;
  }
}

/** How to `go run` a project: root main.go, else the most "server-like" cmd/<x>. */
function detectGoRun(dir: string): string {
  if (fs.existsSync(path.join(dir, "main.go"))) return "go run .";
  const cmd = path.join(dir, "cmd");
  try {
    const dirs = fs
      .readdirSync(cmd, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(cmd, e.name, "main.go")))
      .map((e) => e.name);
    if (dirs.length) {
      const mod = goModuleName(dir);
      const prefer =
        dirs.find((n) => /(^|[-_])(core|server|serve|api|app|daemon|web|main)([-_]|$)/i.test(n)) ||
        (mod ? dirs.find((n) => n === mod || n.startsWith(mod)) : undefined) ||
        dirs[0];
      return `go run ./cmd/${prefer}`;
    }
  } catch {
    /* no cmd/ dir */
  }
  return "go run ./...";
}

const DOTNET_SKIP = new Set([
  "node_modules", ".git", "bin", "obj", ".toolchain", ".godot", ".vs", "dist", "build",
]);

/** Find .csproj files a few levels deep, skipping build/output dirs. */
function findCsprojs(dir: string, depth = 3): string[] {
  const out: string[] = [];
  const walk = (d: string, left: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (left <= 0 || DOTNET_SKIP.has(e.name) || e.name.startsWith(".")) continue;
        walk(path.join(d, e.name), left - 1);
      } else if (e.name.endsWith(".csproj")) {
        out.push(path.join(d, e.name));
      }
    }
  };
  walk(dir, depth);
  return out;
}

/** Does the project ship a build.sh that dispatches a `run` subcommand? */
function hasBuildRun(dir: string): boolean {
  try {
    return /(^|\n)\s*run\)/.test(fs.readFileSync(path.join(dir, "build.sh"), "utf8"));
  } catch {
    return false;
  }
}

/** How to run a .NET project: its own build.sh run, else `dotnet run` on the app project. */
function detectDotnetRun(dir: string): string | null {
  const csprojs = findCsprojs(dir);
  let hasSln = false;
  try {
    hasSln = fs.readdirSync(dir).some((f) => f.endsWith(".sln"));
  } catch {
    /* ignore */
  }
  if (!csprojs.length && !hasSln) return null;

  // a project's own one-command launcher wins — e.g. a Godot game needs its
  // runtime, which `dotnet run` can't provide but build.sh sets up
  if (hasBuildRun(dir)) return "./build.sh run";

  const rel = (p: string) => path.relative(dir, p);
  const isTestOrTool = (p: string) =>
    /(^|\/)(tests?|tools?|samples?|examples?|benchmarks?)(\/|$)/i.test(rel(p));
  const isExe = (p: string) => {
    try {
      return /<OutputType>\s*(Win)?Exe/i.test(fs.readFileSync(p, "utf8"));
    } catch {
      return false;
    }
  };
  const apps = csprojs.filter((p) => !isTestOrTool(p));
  const runnable =
    apps.find((p) => /(Host|App|Server|Api|Web|Cli|Console|Game|Desktop|Main)\.csproj$/i.test(p)) ||
    apps.find(isExe) ||
    apps[0] ||
    csprojs[0];
  return runnable ? `dotnet run --project ${rel(runnable)}` : "dotnet run";
}

/** Best guess at how to run a project — the user can override in the dashboard. */
function detectRunCommand(dir: string, pkg: any | null, stack: string[]): string | null {
  if (pkg?.scripts) {
    const s = pkg.scripts;
    // prefer a long-running dev/serve script; fall back to start
    for (const name of ["dev", "develop", "start:dev", "server", "serve", "start"]) {
      if (s[name]) return name === "start" ? "npm start" : `npm run ${name}`;
    }
  }
  if (fs.existsSync(path.join(dir, "Cargo.toml"))) return "cargo run";
  if (fs.existsSync(path.join(dir, "go.mod"))) return detectGoRun(dir);
  if (stack.includes(".NET/C#")) {
    const dn = detectDotnetRun(dir);
    if (dn) return dn;
  }
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
  const stack = detectStack(dir);

  return {
    name,
    path: dir,
    hasGit,
    gitBranch,
    gitVersion,
    gitLastSubject,
    lastActivity,
    lastActivitySource,
    stack,
    pkgName: pkg?.name ?? null,
    pkgDescription: pkg?.description ?? null,
    readmeSummary: readReadme(dir),
    notesNext: readNotesNext(dir),
    hasReadme:
      fs.existsSync(path.join(dir, "README.md")) ||
      fs.existsSync(path.join(dir, "readme.md")),
    runCommand: detectRunCommand(dir, pkg, stack),
    port: detectPort(dir, pkg, stack),
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
