/**
 * A project's database scripts, as buttons.
 *
 * The convention psm recognises is the one werewolf-dapp already follows: a
 * script under a `scripts/` folder that reports by default and only writes when
 * given `--apply`. Such a script gets two buttons, Preview and Apply, and a chip
 * naming the database it will touch.
 *
 * The target is worked out, never guessed: the `process.env.X` names the script
 * reads, matched against the `.env` in its own package directory. A script
 * whose target psm cannot pin down to exactly one database gets no buttons.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { databaseKey, databaseVariables, ENGINE_LABEL, parseDatabaseUri, type DatabaseTarget } from "./discover.ts";

export interface ScriptTarget {
  key: string;
  label: string;
  database: string | null;
  local: boolean;
  /** The `.env` variables it was resolved from (names only). */
  variables: string[];
}

export interface DbScript {
  id: string;
  project: string;
  /** Path of the script relative to the project. */
  path: string;
  /** Directory it runs in, relative to the project: the nearest package.json. */
  directory: string;
  title: string;
  target: ScriptTarget | null;
  /** Why there is no target, when there is none. */
  reason: string | null;
  /** Inherited variables removed before it runs (names only), so only its .env decides. */
  unset: string[];
}

const SCRIPT_FILE = /^[A-Za-z0-9._-]+\.(?:c|m)?js$/;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const MAX_SOURCE = 200 * 1024;

export function scriptId(project: string, relative: string): string {
  return crypto.createHash("sha256").update(`${project}\0${relative}`).digest("hex").slice(0, 12);
}

/** First line of the first doc comment that says something. */
export function scriptTitle(source: string, fallback: string): string {
  const comment = /\/\*\*([\s\S]*?)\*\//.exec(source)?.[1] ?? "";
  // The first paragraph, joined, up to its first full stop: a sentence wrapped
  // over two comment lines should not read as "Deliberate and".
  const paragraph: string[] = [];
  for (const raw of comment.split("\n")) {
    const line = raw.replace(/^\s*\*\s?/, "").trim();
    if (!line) {
      if (paragraph.length) break;
      continue;
    }
    if (line.startsWith("@") || /^(node|npm|npx)\s/.test(line)) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line);
  }
  if (!paragraph.length) return fallback;
  const text = paragraph.join(" ").replace(/^P\d+\s+[A-Z]\d*:\s*/, "");
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text;
  return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence;
}

/** `process.env.MONGODB_URI`, `process.env['X']`, `const { MONGODB_URI } = process.env`. */
export function envNamesRead(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1]);
  for (const match of source.matchAll(/process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g)) names.add(match[1]);
  for (const match of source.matchAll(/\{([^}]*)\}\s*=\s*process\.env\b/g)) {
    for (const part of match[1].split(",")) {
      const name = part.split(":")[0].split("=")[0].trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

function targetLabel(target: DatabaseTarget): string {
  const where = target.local ? "local" : target.host;
  return `${where} ${ENGINE_LABEL[target.engine]}${target.database ? ` · ${target.database}` : ""}`;
}

/** Variables a script may read that say nothing about which database it uses. */
const BASIC_ENV = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "TERM", "PWD", "FORCE_COLOR", "NO_COLOR"]);

/** A host given on its own, not as a connection string: `MONGO_HOSTNAME`, `PGHOST`, `DB_HOST`. */
const HOST_VARIABLE = /^(?:.*(?:MONGO|POSTGRES|PG|MYSQL|MARIADB|REDIS|DB|DATABASE).*(?:HOST|HOSTNAME|SERVER|ADDR|ADDRESS)|PGHOST)$/;

/** `KEY=value` lines → names that have a non-empty value. Values are not kept. */
function namesWithValues(envText: string): Set<string> {
  const names = new Set<string>();
  for (const line of envText.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match && match[2].trim().replace(/^(['"])(.*)\1$/, "$2").trim()) names.add(match[1]);
  }
  return names;
}

/** Hard-coded fallbacks such as `|| 'mongodb://localhost:27017/app'`. Templates are skipped. */
export function literalTargets(source: string): DatabaseTarget[] {
  const found: DatabaseTarget[] = [];
  for (const match of source.matchAll(/['"`]((?:mongodb(?:\+srv)?|postgres(?:ql)?|rediss?|mysql|mariadb):\/\/[^'"`\s]+)['"`]/g)) {
    if (match[1].includes("${")) continue;
    const target = parseDatabaseUri(match[1]);
    if (target) found.push(target);
  }
  return found;
}

/**
 * Resolve which database a script will touch, from its sources (the script and
 * the local files it requires) and its package's `.env`.
 *
 * Refuses rather than guesses: a host set on its own (`MONGO_HOSTNAME`) means the
 * connection may be built another way than psm can read; two different targets
 * mean psm would be picking one.
 */
export function resolveTarget(sources: string[], envText: string | null): { target: ScriptTarget | null; reason: string | null; unset: string[] } {
  const read = new Set<string>();
  for (const source of sources) for (const name of envNamesRead(source)) read.add(name);
  // Whatever the script reads comes from its .env and nowhere else, so a value
  // exported in psm's own shell can never redirect it.
  const unset = [...read].filter((name) => !BASIC_ENV.has(name)).sort();
  const refuse = (reason: string) => ({ target: null, reason, unset });
  if (envText === null) return refuse("No .env next to this script, so psm cannot tell which database it uses.");

  const present = namesWithValues(envText);
  const hosts = [...read].filter((name) => HOST_VARIABLE.test(name) && present.has(name));
  if (hosts.length) return refuse(`Its .env sets ${hosts.join(", ")}, so the script may build its connection another way. psm will not guess which database that is.`);

  let candidates = databaseVariables(envText).filter((entry) => read.has(entry.variable));
  let variables = candidates.map((entry) => entry.variable);
  if (!candidates.length) {
    // Nothing set in .env: the script falls back to what is written in its code.
    const literals = sources.flatMap(literalTargets);
    candidates = literals.map((target) => ({ variable: "", target }));
    variables = [];
  }
  if (!candidates.length) return refuse("This script does not read a database variable psm can see in its .env.");
  const keys = new Set(candidates.map((entry) => databaseKey(entry.target)));
  if (keys.size > 1) return refuse("This script can reach more than one database; psm will not pick one for you.");
  const first = candidates[0].target;
  const databases = new Set(candidates.map((entry) => entry.target.database));
  return {
    target: {
      key: databaseKey(first),
      label: targetLabel(first),
      database: databases.size === 1 ? first.database : null,
      local: first.local,
      variables,
    },
    reason: null,
    unset,
  };
}

const LOCAL_REQUIRE = /(?:require\(\s*|from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** The script plus the local files it requires, inside its package, a few levels deep. */
export function scriptSources(file: string, packageDir: string, limit = 16): string[] {
  const sources: string[] = [];
  const seen = new Set<string>();
  const visit = (current: string, depth: number) => {
    if (seen.has(current) || seen.size >= limit) return;
    seen.add(current);
    const source = readText(current);
    if (source === null) return;
    sources.push(source);
    if (depth >= 3) return;
    for (const match of source.matchAll(LOCAL_REQUIRE)) {
      const base = path.resolve(path.dirname(current), match[1]);
      const next = [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, "index.js")].find((candidate) => {
        try {
          return fs.statSync(candidate).isFile();
        } catch {
          return false;
        }
      });
      if (next && (next === packageDir || next.startsWith(packageDir + path.sep))) visit(next, depth + 1);
    }
  };
  visit(file, 0);
  return sources;
}

/** The nearest directory at or above `file` (inside `root`) with a package.json. */
function packageDirectory(root: string, file: string): string {
  let dir = path.dirname(file);
  while (dir.startsWith(root)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return root;
}

function readText(file: string, limit = MAX_SOURCE): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > limit) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** `scripts/` at the root and one level down (`server/scripts/`). */
function scriptDirectories(root: string): string[] {
  const dirs = [path.join(root, "scripts")];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    /* unreadable project */
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") dirs.push(path.join(root, entry.name, "scripts"));
  }
  return dirs.filter((dir) => fs.existsSync(dir));
}

export function detectScripts(project: { name: string; path: string }): DbScript[] {
  const root = path.resolve(project.path);
  const found: DbScript[] = [];
  for (const dir of scriptDirectories(root)) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      // A test file mentions --apply to exercise it; it is not a script to run.
      if (!SCRIPT_FILE.test(name) || /\.(?:test|spec)\.[cm]?js$/.test(name)) continue;
      const file = path.join(dir, name);
      const source = readText(file);
      if (!source || !source.includes("--apply")) continue;
      const relative = path.relative(root, file);
      if (!SAFE_PATH.test(relative)) continue;
      const pkg = packageDirectory(root, file);
      const { target, reason, unset } = resolveTarget(scriptSources(file, pkg), readText(path.join(pkg, ".env"), 256 * 1024));
      found.push({
        id: scriptId(project.name, relative),
        project: project.name,
        path: relative,
        directory: path.relative(root, pkg),
        title: scriptTitle(source, name),
        target,
        reason,
        unset,
      });
    }
  }
  return found;
}

/**
 * The exact command for a detected script. Built only from a detected relative
 * path (checked against SAFE_PATH again), so nothing from a request is spliced
 * into a shell.
 */
export function scriptCommand(script: DbScript, mode: "preview" | "apply"): string {
  const fromPackage = path.relative(script.directory || ".", script.path);
  if (!SAFE_PATH.test(fromPackage) || fromPackage.startsWith("..")) throw new Error("Refusing a script path outside its package.");
  return `node ${fromPackage}${mode === "apply" ? " --apply" : ""}`;
}
