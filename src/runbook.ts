/**
 * A project's runbook (P18): every script it has, what each one is for, and
 * how psm may run it.
 *
 * Detection reads package scripts in the project root and in nested packages
 * (`server/`, `client/`, `mcp/` …), follows `cd X && npm run Y` delegation to
 * the real script, turns `concurrently` scripts into composites of the units
 * they start, and guesses each unit's kind, port, environment variable names,
 * cost and dependencies. Repository text (a README "Scripts" list, a script
 * file's header comment) supplies descriptions. The operator's own text, in
 * the committed `.psm/runbook.json`, wins field by field.
 *
 * Nothing here runs anything. Environment files are read for variable names
 * and the PORT value only; no other value leaves this module.
 */
import fs from "node:fs";
import path from "node:path";

export type UnitKind = "service" | "agent" | "task" | "data" | "mcp" | "install" | "deploy";
export type FieldSource = "curated" | "readme" | "script" | "detected";

export interface UnitRef {
  /** Another linked project; absent means this project. */
  project?: string;
  unit: string;
}

export interface RunbookUnit {
  /** `dev` for a root script, `server/dev` for one in `server/`. */
  id: string;
  title: string;
  folder: string;
  script: string;
  /** What psm runs, from the unit's folder. */
  command: string;
  /** The script's own text from package.json, for reading. */
  scriptText: string;
  kind: UnitKind;
  summary: string | null;
  whenToUse: string | null;
  port: number | null;
  dependsOn: UnitRef[];
  /** Environment variable names the folder documents. Never values. */
  env: string[];
  costs: boolean;
  /** Root scripts that only delegate here: `npm run server`. */
  aliases: string[];
  sources: Partial<Record<"summary" | "whenToUse" | "kind" | "port" | "dependsOn" | "title" | "costs", FieldSource>>;
}

export interface RunbookComposite {
  id: string;
  folder: string;
  script: string;
  scriptText: string;
  /** The units it starts, when every part resolved. */
  units: string[];
  unresolved: string[];
  summary: string | null;
}

export interface Runbook {
  units: RunbookUnit[];
  composites: RunbookComposite[];
  /** What "run this project" means: units started together. */
  defaultUnits: string[];
  /** Ports a dev server proxies to, for cross-project dependencies. */
  proxies: Array<{ unit: string; port: number }>;
  curated: boolean;
  warnings: string[];
}

export interface CuratedUnit {
  title?: string;
  summary?: string;
  whenToUse?: string;
  kind?: UnitKind;
  port?: number | null;
  dependsOn?: UnitRef[];
  costs?: boolean;
}

export interface CuratedRunbook {
  version: 1;
  units: Record<string, CuratedUnit>;
  defaultUnits?: string[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", "out", ".next", "vendor", "tmp", ".cache", "public", "docs", "test", "tests", "fixtures", "examples"]);
const MAX_DEPTH = 2;
const MAX_PACKAGES = 20;
export const UNIT_KINDS: readonly UnitKind[] = ["service", "agent", "task", "data", "mcp", "install", "deploy"];
export const STARTABLE: ReadonlySet<UnitKind> = new Set(["service", "agent", "task"]);
const UNIT_ID = /^[A-Za-z0-9._@/:-]{1,160}$/;

export const runbookFile = (projectDir: string) => path.join(projectDir, ".psm", "runbook.json");

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file: string, max = 256 * 1024): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > max) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Folders with a package.json: the root, then nested packages to MAX_DEPTH. */
export function findPackages(root: string): string[] {
  const found: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (found.length >= MAX_PACKAGES) return;
    const dir = path.join(root, rel);
    if (fs.existsSync(path.join(dir, "package.json"))) found.push(rel);
    if (depth >= MAX_DEPTH) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      // A nested git repository is its own project, not part of this one.
      if (fs.existsSync(path.join(dir, entry.name, ".git"))) continue;
      walk(rel ? `${rel}/${entry.name}` : entry.name, depth + 1);
    }
  };
  walk("", 0);
  return found;
}

const unitId = (folder: string, script: string) => (folder ? `${folder}/${script}` : script);
const npmCommand = (script: string) => (script === "start" || script === "test" ? `npm ${script}` : `npm run ${script}`);

/** `cd server && npm run dev` → { folder: "server", script: "dev" }, only when that is all it does. */
export function delegation(text: string): { folder: string; script: string } | null {
  const match = text.trim().match(/^cd\s+([A-Za-z0-9._/-]+)\s*&&\s*npm\s+(?:run\s+([A-Za-z0-9:._@-]+)|(start|test))\s*$/);
  if (!match) return null;
  const normalized = path.posix.normalize(match[1]);
  if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) return null;
  const folder = normalized.replace(/^\.\//, "").replace(/\/$/, "");
  if (!folder || folder === ".") return null;
  return { folder, script: match[2] ?? match[3] };
}

/** The quoted commands a `concurrently` script runs. */
export function concurrentParts(text: string): string[] | null {
  const at = text.search(/\bconcurrently\b/);
  if (at < 0) return null;
  const parts = [...text.slice(at).matchAll(/"([^"]+)"|'([^']+)'/g)].map((match) => (match[1] ?? match[2]).trim());
  return parts.length ? parts : null;
}

const DATA = /^(bootstrap|seed|migrate|migration|repair|import|export|rotate|reset|backfill|sync|restore|backup|purge|cleanup|db)(:|$|-)/i;
const AGENTISH = /(^|[^a-z])(agent|worker|cluster|bot|runner|daemon|cron|queue)([^a-z]|$)/i;

export function classify(script: string, text: string): UnitKind {
  const name = script.toLowerCase();
  if (/(^|:)(install|dev-install|postinstall|preinstall|prepare)$/.test(name) || /^install(:|$)/.test(name)) return "install";
  if (/(^|:)(deploy|release|publish)(:|$)/.test(name) || /(^|:)prod$/.test(name) || /^start:prod/.test(name) || /^build:prod/.test(name)) return "deploy";
  if (name === "mcp" || name.startsWith("mcp:")) return "mcp";
  if (DATA.test(name) || /:(create|remove|delete|setup|seed|reset|migrate)$/.test(name)) return "data";
  if (/--dry-run\b/.test(text) || /(^|:)dry$/.test(name)) return "task";
  if (/^(test|lint|typecheck|check|format|fmt|build|compile|coverage|audit|verify|bench)(:|$)/.test(name) || /:(test|lint|check|build)$/.test(name)) return "task";
  if (AGENTISH.test(name)) return "agent";
  if (/^(dev|develop|start|serve|server|client|watch|preview)(:|$)/.test(name)) return "service";
  if (/\b(nodemon|vite(?!\s+build)|next\s+dev|webpack\s+serve|--watch|tsx\s+watch|http-server|live-server)\b/.test(text)) return "service";
  if (AGENTISH.test(text) && !/\b(test|build)\b/.test(text)) return "agent";
  return "task";
}

/** The file a `node X` / `nodemon X` / `tsx X` command runs, inside the folder. */
function entryFile(dir: string, text: string): string | null {
  const match = text.match(/\b(?:node|nodemon|tsx|ts-node|bun)\b(?:\s+--?[A-Za-z][\w-]*(?:=\S+)?)*\s+((?:\.\/)?[A-Za-z0-9._/-]+)/);
  if (!match) return null;
  const rel = match[1];
  for (const candidate of [rel, `${rel}.js`, `${rel}.mjs`, `${rel}.ts`, `${rel}/index.js`]) {
    const file = path.resolve(dir, candidate);
    if (!file.startsWith(path.resolve(dir) + path.sep)) return null;
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* next */
    }
  }
  return null;
}

/** PORT from a folder's .env (and its parent project root's), the only value read from it. */
function envPort(dir: string, root: string): number | null {
  for (const folder of [dir, root]) {
    const text = readText(path.join(folder, ".env"), 64 * 1024);
    const match = text?.match(/^\s*(?:export\s+)?PORT\s*=\s*["']?(\d{2,5})["']?\s*$/m);
    if (match) return Number(match[1]);
  }
  return null;
}

function viteConfig(dir: string): string | null {
  for (const name of ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"]) {
    const text = readText(path.join(dir, name));
    if (text) return text;
  }
  return null;
}

function explicitPort(text: string): number | null {
  const flag = text.match(/(?:--port[= ]|\s-p\s+|\bPORT=)(\d{2,5})\b/);
  return flag ? Number(flag[1]) : null;
}

function detectPort(dir: string, root: string, text: string, entry: string | null): number | null {
  const flag = explicitPort(text);
  if (flag) return flag;
  if (/\bvite\b(?!\s+build)/.test(text)) {
    const config = viteConfig(dir);
    if (/\bvite\s+preview\b/.test(text)) {
      const preview = config?.match(/preview\s*:\s*\{[^}]*?\bport\s*:\s*(\d{2,5})/s);
      return preview ? Number(preview[1]) : 4173;
    }
    const configured = config?.match(/server\s*:\s*\{[^}]*?\bport\s*:\s*(\d{2,5})/s) ?? config?.match(/\bport\s*:\s*(\d{2,5})/);
    return configured ? Number(configured[1]) : 5173;
  }
  if (/\bnext\s+(dev|start)\b/.test(text)) return envPort(dir, root) ?? 3000;
  const fromEnv = envPort(dir, root);
  if (fromEnv) return fromEnv;
  const source = entry ? readText(entry) : null;
  const fallback = source?.match(/PORT\s*\|\|\s*["']?(\d{2,5})/);
  return fallback ? Number(fallback[1]) : null;
}

/** Ports a Vite dev server proxies to: `target: 'http://localhost:3000'`, or a variable defaulting to it. */
function proxyPorts(dir: string): number[] {
  const config = viteConfig(dir);
  if (!config || !/\bproxy\s*:/.test(config)) return [];
  const ports = [...config.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/g)].map((match) => Number(match[1]));
  return [...new Set(ports)];
}

function envNames(dir: string): string[] {
  for (const name of [".env.example", ".env.sample", ".env.template"]) {
    const text = readText(path.join(dir, name), 128 * 1024);
    if (!text) continue;
    const names = [...text.matchAll(/^\s*#?\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,60})\s*=/gm)].map((match) => match[1]);
    return [...new Set(names)].slice(0, 60);
  }
  return [];
}

/** First sentence or two of a file's leading comment. */
export function headerSummary(source: string | null): string | null {
  if (!source) return null;
  const body = source.replace(/^#!.*\n/, "").replace(/^\s*(?:(['"])use strict\1;?\s*)?/, "");
  let text = "";
  const block = body.match(/^\s*\/\*\*?([\s\S]*?)\*\//);
  if (block) text = block[1].split("\n").map((line) => line.replace(/^\s*\*\s?/, "")).join("\n");
  else {
    const lines = body.match(/^(?:\s*\/\/.*\n?)+/);
    if (lines) text = lines[0].split("\n").map((line) => line.replace(/^\s*\/\/\s?/, "")).join("\n");
  }
  const paragraph = text.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim();
  // Generator boilerplate says nothing about the script.
  if (!paragraph || paragraph.length < 24 || /^(module dependencies|dependencies|imports?|requires?)\b/i.test(paragraph)) return null;
  // A sentence ends at . ! ? before a capital letter, not inside `todo.md` or `package.json`.
  const short = paragraph.split(/(?<=[.!?])\s+(?=[A-Z(`])/).slice(0, 2).join(" ").trim();
  return short.length > 280 ? `${short.slice(0, 279)}…` : short;
}

/** `- \`npm run client\` - Run only the frontend` lines in a README. */
export function readmeScripts(readme: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!readme) return out;
  for (const match of readme.matchAll(/^\s*[-*]\s*`(?:npm\s+(?:run\s+)?|yarn\s+|pnpm\s+)([A-Za-z0-9:._@-]+)`\s*(?:[-–—:]\s*)(.+)$/gm)) {
    if (!out.has(match[1])) out.set(match[1], match[2].trim().slice(0, 280));
  }
  return out;
}

const COST = /@anthropic-ai\/sdk|\bopenai\b|ANTHROPIC_API_KEY|OPENAI_API_KEY|claude\s+-p|\bgenerate(Text|Content)\b/;

function detectedSummary(unit: RunbookUnit): string | null {
  const port = unit.port ? ` on :${unit.port}` : "";
  if (unit.kind === "service") {
    if (/\bvite\s+preview\b/.test(unit.scriptText)) return `Serves the production build locally${port}.`;
    if (/\bvite\b/.test(unit.scriptText)) return `Vite dev server${port}.`;
    if (/\bnodemon\b/.test(unit.scriptText)) return `Server with auto-reload (nodemon)${port}.`;
    if (/--watch\b/.test(unit.scriptText)) return `Server with auto-reload${port}.`;
    return `Long-running server${port}.`;
  }
  if (unit.kind === "data") return "Changes data or state. Run it through the Data card or by hand, never from here.";
  if (unit.kind === "mcp") return "An MCP server; an MCP client launches it.";
  if (unit.kind === "install") return "Installs dependencies.";
  if (unit.kind === "deploy") return "Production build or start. Use the Deploy flow.";
  return null;
}

/** Detect a project's runbook from its files. */
export function detectRunbook(root: string): Runbook {
  const warnings: string[] = [];
  const packages = findPackages(root);
  const scripts = new Map<string, Record<string, string>>();
  for (const folder of packages) {
    const pkg = readJson(path.join(root, folder, "package.json"));
    const entries = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    scripts.set(folder, Object.fromEntries(Object.entries(entries).filter(([, value]) => typeof value === "string")) as Record<string, string>);
  }
  if (packages.length >= MAX_PACKAGES) warnings.push(`Read the first ${MAX_PACKAGES} packages only.`);

  /** Follow delegation to the real unit: `npm run server` at the root → `server/dev`. */
  const resolve = (folder: string, script: string, seen = new Set<string>()): { folder: string; script: string } | null => {
    const key = unitId(folder, script);
    if (seen.has(key)) return null;
    seen.add(key);
    const text = scripts.get(folder)?.[script];
    if (text == null) return null;
    const target = delegation(text);
    if (!target) return { folder, script };
    const nested = path.posix.join(folder, target.folder);
    if (!scripts.has(nested)) return { folder, script };
    return resolve(nested, target.script, seen) ?? { folder, script };
  };
  /** One part of a concurrently script: `npm run server`, `cd client && npm test`. */
  const resolvePart = (folder: string, part: string): string | null => {
    const own = part.match(/^npm\s+(?:run\s+([A-Za-z0-9:._@-]+)|(start|test))$/);
    if (own) {
      const target = resolve(folder, own[1] ?? own[2]);
      return target ? unitId(target.folder, target.script) : null;
    }
    const delegated = delegation(part);
    if (delegated) {
      const nested = path.posix.join(folder, delegated.folder);
      const target = scripts.has(nested) ? resolve(nested, delegated.script) : null;
      return target ? unitId(target.folder, target.script) : null;
    }
    return null;
  };

  const readme = readmeScripts(readText(path.join(root, "README.md")));
  const units = new Map<string, RunbookUnit>();
  const composites: RunbookComposite[] = [];
  const aliases = new Map<string, string[]>();
  const proxies: Runbook["proxies"] = [];

  for (const [folder, entries] of scripts) {
    const dir = path.join(root, folder);
    const env = envNames(dir);
    const folderReadme = folder ? readmeScripts(readText(path.join(dir, "README.md"))) : new Map<string, string>();
    for (const [script, text] of Object.entries(entries)) {
      if (/^(pre|post)[a-z]/.test(script) && entries[script.replace(/^(pre|post)/, "")] != null) continue; // npm lifecycle hooks
      const target = resolve(folder, script);
      if (target && (target.folder !== folder || target.script !== script)) {
        const id = unitId(target.folder, target.script);
        aliases.set(id, [...(aliases.get(id) ?? []), `${folder ? `${folder}: ` : ""}${npmCommand(script)}`]);
        continue;
      }
      const parts = concurrentParts(text);
      if (parts) {
        const resolved = parts.map((part) => resolvePart(folder, part));
        composites.push({
          id: unitId(folder, script),
          folder,
          script,
          scriptText: text,
          units: resolved.filter((id): id is string => !!id),
          unresolved: parts.filter((_, index) => !resolved[index]),
          summary: (folder ? folderReadme : readme).get(script) ?? null,
        });
        continue;
      }
      const kind = classify(script, text);
      const entry = entryFile(dir, text);
      const source = entry ? readText(entry) : null;
      // An agent listens only when its command says so; it does not inherit the server's PORT.
      const port = kind === "service" ? detectPort(dir, root, text, entry) : kind === "agent" ? explicitPort(text) : null;
      const id = unitId(folder, script);
      const unit: RunbookUnit = {
        id,
        title: folder ? `${folder} · ${script}` : script,
        folder,
        script,
        command: npmCommand(script),
        scriptText: text,
        kind,
        summary: null,
        whenToUse: null,
        port,
        dependsOn: [],
        env: kind === "service" || kind === "agent" || kind === "data" ? env : [],
        costs: kind === "agent" && (COST.test(source ?? "") || COST.test(text)),
        aliases: [],
        sources: { kind: "detected", title: "detected" },
      };
      const fromReadme = (folder ? folderReadme : readme).get(script);
      const fromHeader = headerSummary(source);
      if (fromReadme) [unit.summary, unit.sources.summary] = [fromReadme, "readme"];
      else if (fromHeader) [unit.summary, unit.sources.summary] = [fromHeader, "script"];
      if (port) unit.sources.port = "detected";
      if (unit.costs) unit.sources.costs = "detected";
      if (kind === "service" && /\bvite\b(?!\s+(?:build|preview))/.test(text)) for (const proxy of proxyPorts(dir)) proxies.push({ unit: id, port: proxy });
      units.set(id, unit);
    }
  }

  for (const [id, list] of aliases) {
    const unit = units.get(id);
    if (!unit) continue;
    unit.aliases = list;
    // The root README documents the root alias: `npm run client - Run only the frontend`.
    // It is the author describing the command, so it beats a script comment.
    if (unit.sources.summary !== "readme") {
      for (const alias of list) {
        const name = alias.replace(/^npm (run )?/, "");
        const text = readme.get(name);
        if (text) {
          [unit.summary, unit.sources.summary] = [text, "readme"];
          break;
        }
      }
    }
  }
  // Same-project proxy targets: a client that proxies to :3000 depends on the server on :3000.
  for (const proxy of proxies) {
    const server = [...units.values()].find((unit) => unit.kind === "service" && unit.port === proxy.port && unit.id !== proxy.unit);
    const client = units.get(proxy.unit);
    if (server && client && !client.dependsOn.some((ref) => !ref.project && ref.unit === server.id)) {
      client.dependsOn.push({ unit: server.id });
      client.sources.dependsOn = "detected";
    }
  }
  for (const unit of units.values()) if (!unit.summary) unit.summary = detectedSummary(unit);

  // A root composite that only starts units is what "run the project" means; otherwise the first dev-like service.
  const dev = composites.find((composite) => !composite.folder && composite.script === "dev" && composite.units.length && !composite.unresolved.length);
  const services = [...units.values()].filter((unit) => unit.kind === "service");
  const main = services.find((unit) => !unit.folder && unit.script === "dev") ?? services.find((unit) => /^(dev|start)$/.test(unit.script)) ?? services[0];
  const defaultUnits = dev?.units ?? (main ? [main.id] : []);

  return { units: [...units.values()], composites, defaultUnits, proxies, curated: false, warnings };
}

/** Validate an operator's runbook edit; throws a readable message. */
export function validateCurated(value: unknown): CuratedRunbook {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A runbook is an object.");
  const raw = value as Record<string, unknown>;
  const units: Record<string, CuratedUnit> = {};
  const entries = raw.units && typeof raw.units === "object" && !Array.isArray(raw.units) ? Object.entries(raw.units as Record<string, unknown>) : [];
  if (entries.length > 200) throw new Error("Up to 200 units.");
  for (const [id, entry] of entries) {
    if (!UNIT_ID.test(id) || id.includes("::")) throw new Error(`Invalid unit id: ${id}`);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Unit ${id} must be an object.`);
    const e = entry as Record<string, unknown>;
    const unit: CuratedUnit = {};
    for (const field of ["title", "summary", "whenToUse"] as const) {
      if (e[field] == null || e[field] === "") continue;
      if (typeof e[field] !== "string") throw new Error(`${id}.${field} must be text.`);
      unit[field] = (e[field] as string).trim().slice(0, field === "title" ? 80 : 1000);
    }
    if (e.kind != null) {
      if (!UNIT_KINDS.includes(e.kind as UnitKind)) throw new Error(`${id}.kind must be one of ${UNIT_KINDS.join(", ")}.`);
      unit.kind = e.kind as UnitKind;
    }
    if (e.port !== undefined) {
      if (e.port !== null && !(Number.isInteger(e.port) && (e.port as number) > 0 && (e.port as number) < 65536)) throw new Error(`${id}.port must be a port number.`);
      unit.port = e.port as number | null;
    }
    if (e.costs != null) {
      if (typeof e.costs !== "boolean") throw new Error(`${id}.costs must be true or false.`);
      unit.costs = e.costs;
    }
    if (e.dependsOn != null) {
      if (!Array.isArray(e.dependsOn) || e.dependsOn.length > 20) throw new Error(`${id}.dependsOn must be a list.`);
      unit.dependsOn = e.dependsOn.map((ref) => {
        const r = (typeof ref === "string" ? { unit: ref } : ref) as Record<string, unknown>;
        if (!r || typeof r.unit !== "string" || !UNIT_ID.test(r.unit)) throw new Error(`${id}.dependsOn has an invalid unit.`);
        if (r.project != null && (typeof r.project !== "string" || !/^[A-Za-z0-9._ -]{1,120}$/.test(r.project))) throw new Error(`${id}.dependsOn has an invalid project.`);
        return r.project ? { project: r.project as string, unit: r.unit } : { unit: r.unit };
      });
    }
    if (Object.keys(unit).length) units[id] = unit;
  }
  const curated: CuratedRunbook = { version: 1, units };
  if (raw.defaultUnits != null) {
    if (!Array.isArray(raw.defaultUnits) || raw.defaultUnits.length > 20 || !raw.defaultUnits.every((id) => typeof id === "string" && UNIT_ID.test(id))) throw new Error("defaultUnits must be a list of unit ids.");
    curated.defaultUnits = raw.defaultUnits as string[];
  }
  return curated;
}

export function readCurated(projectDir: string): CuratedRunbook | null {
  const raw = readJson(runbookFile(projectDir));
  if (!raw) return null;
  try {
    return validateCurated(raw);
  } catch {
    return null;
  }
}

export function writeCurated(projectDir: string, curated: CuratedRunbook): void {
  const file = runbookFile(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(curated, null, 2) + "\n");
  fs.renameSync(temp, file);
}

/** Detected runbook with the operator's text on top, field by field. */
export function mergeRunbook(detected: Runbook, curated: CuratedRunbook | null): Runbook {
  if (!curated) return detected;
  const units = detected.units.map((unit) => {
    const own = curated.units[unit.id];
    if (!own) return unit;
    const merged: RunbookUnit = { ...unit, sources: { ...unit.sources } };
    for (const field of ["title", "summary", "whenToUse", "kind", "port", "dependsOn", "costs"] as const) {
      if (own[field] === undefined) continue;
      (merged as any)[field] = own[field];
      merged.sources[field] = "curated";
    }
    return merged;
  });
  const known = new Set(units.map((unit) => unit.id));
  const warnings = [...detected.warnings];
  for (const id of Object.keys(curated.units)) if (!known.has(id)) warnings.push(`.psm/runbook.json describes ${id}, which no package script defines any more.`);
  const defaultUnits = curated.defaultUnits?.filter((id) => known.has(id)) ?? detected.defaultUnits;
  return { ...detected, units, defaultUnits, curated: true, warnings };
}

/** The runbook psm shows and runs: detection plus `.psm/runbook.json`. */
export function projectRunbook(projectDir: string): Runbook {
  return mergeRunbook(detectRunbook(projectDir), readCurated(projectDir));
}
