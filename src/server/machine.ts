/**
 * What is actually running on this machine.
 *
 * psm already tracks the processes *it* started (procs.ts), but the ones that
 * cause trouble are the ones it did not: a dev server from a terminal three
 * hours ago, still holding 5173, so today's `npm run dev` climbs to 5176 and
 * nothing points at the port you expected. This module is the honest answer to
 * "what have I got running, and which of it is stale?"
 *
 * Deliberately narrow. It lists processes that hold a listening TCP port, plus
 * processes that look like dev servers even without one, and it can stop them.
 * It does not enumerate the whole process table — a psm panel is not `htop`, and
 * the less of someone's machine it reports, the better.
 *
 * Local modes only. A hosted psm has no machine to look at.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { activeProcesses } from "./procs.ts";

export interface MachineProcess {
  pid: number;
  ppid: number;
  /** Full command line, trimmed to something a panel can show. */
  command: string;
  /** A short human label: "vite", "nodemon ./bin/www", "tsx src/server/index.ts". */
  label: string;
  /** Listening TCP ports this process (or something below it) holds. */
  ports: number[];
  /**
   * The port this project is configured to serve on, when nothing is actually
   * listening. A dev server that died still answers "which port was that for?".
   */
  expectedPort: number | null;
  /** Working directory, when readable. */
  cwd: string | null;
  /** The project this belongs to, matched against psm's linked folders. */
  project: string | null;
  ageSeconds: number;
  rssBytes: number;
  /** psm started this one, and can account for it. */
  psmManaged: boolean;
  /** This psm process (or its own tree) — never offer to kill it by accident. */
  self: boolean;
  /**
   * An older twin of another process in this list: same project, same command,
   * started earlier. This is the "left running from last time" case.
   */
  duplicateOf: number | null;
}

/** Dev servers worth listing even when they hold no port yet. */
const DEV_HINTS = /\b(vite|nodemon|next|webpack|ng serve|react-scripts|tsx|ts-node|nest|astro|remix|parcel|storybook|expo)\b/;

/** Things that must never be offered up for killing. */
const PROTECTED = new Set([1]);

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 });
  } catch {
    return "";
  }
}

/** pid → listening ports, via `ss` (Linux) falling back to `lsof` (macOS/BSD). */
function listeningByPid(): Map<number, Set<number>> {
  const found = new Map<number, Set<number>>();
  const add = (pid: number, port: number) => {
    if (!Number.isFinite(pid) || !Number.isFinite(port)) return;
    if (!found.has(pid)) found.set(pid, new Set());
    found.get(pid)!.add(port);
  };

  // ss -tlnp → ... 127.0.0.1:4317 ... users:(("node",pid=238681,fd=33))
  for (const line of run("ss", ["-tlnp"]).split("\n")) {
    if (!line.includes("LISTEN")) continue;
    const port = Number(line.match(/[:.](\d+)\s+[\d.:*[\]]+\s/)?.[1] ?? line.match(/:(\d+)\s/)?.[1]);
    for (const match of line.matchAll(/pid=(\d+)/g)) add(Number(match[1]), port);
  }
  if (found.size) return found;

  // lsof -nP -iTCP -sTCP:LISTEN → node 238681 user 33u IPv4 ... TCP 127.0.0.1:4317 (LISTEN)
  for (const line of run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]).split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    add(Number(parts[1]), Number(parts[8].split(":").pop()));
  }
  return found;
}

interface PsRow {
  pid: number;
  ppid: number;
  etimes: number;
  rss: number;
  args: string;
}

function processTable(): Map<number, PsRow> {
  const rows = new Map<number, PsRow>();
  // etimes is elapsed seconds — far easier to reason about than ps's [[dd-]hh:]mm:ss
  for (const line of run("ps", ["-eo", "pid=,ppid=,etimes=,rss=,args="]).split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.set(Number(match[1]), {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      etimes: Number(match[3]),
      rss: Number(match[4]) * 1024,
      args: match[5],
    });
  }
  return rows;
}

function cwdOf(pid: number): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null; // not Linux, or not ours to read
  }
}

const INTERPRETERS = /^(node|nodejs|python3?|ruby|deno|bun|sh|bash|zsh|fish)$/;

const basename = (token: string) => token.split("/").pop() || token;

/** Keep a path recognisable without printing someone's whole home directory. */
function shorten(token: string): string {
  if (token.includes("node_modules")) return basename(token);
  const segments = token.split("/").filter(Boolean);
  return segments.length <= 2 ? token : segments.slice(-2).join("/");
}

/**
 * A short label. The raw command line of a node process is mostly absolute paths
 * into node_modules and loader flags, which tells you nothing at a glance:
 *
 *   node --require …/tsx/preflight.cjs --import …/loader.mjs src/server/index.ts
 *     → "server/index.ts"
 *   node /home/…/client/node_modules/.bin/vite  → "vite"
 */
function labelFor(args: string): string {
  const tokens = args.split(/\s+/).filter(Boolean);
  let i = 0;
  if (tokens[i] && INTERPRETERS.test(basename(tokens[i]))) {
    const interpreter = basename(tokens[i]);
    i++;
    // skip the interpreter's own flags, and the path values some of them take
    while (tokens[i]?.startsWith("-")) {
      const flag = tokens[i++];
      // an inline script is not a path to shorten — everything after -e is
      // source code, and splitting it on spaces produces nonsense
      if (/^(-e|--eval|-p|--print|-c)$/.test(flag)) return `${interpreter} -e (inline script)`;
      if (!flag.includes("=") && tokens[i] && !tokens[i].startsWith("-") && /[/.]/.test(tokens[i])) i++;
    }
  }
  const parts: string[] = [];
  for (; i < tokens.length && parts.length < 3; i++) {
    // an eval flag anywhere means the rest is source code, not arguments —
    // this catches runners like `tsx -e …` whose first token is not an interpreter
    if (/^(-e|--eval|-p|--print)$/.test(tokens[i])) {
      parts.push("-e (inline script)");
      break;
    }
    if (!tokens[i].startsWith("-")) parts.push(shorten(tokens[i]));
  }
  return (parts.join(" ") || basename(tokens[0] || "?")).slice(0, 70);
}

/** Which linked project a path sits inside, longest match wins. */
function projectFor(
  cwd: string | null,
  roots: { name: string; path: string; port?: number | null }[],
): { label: string; port: number | null } | null {
  if (!cwd) return null;
  let best: { name: string; path: string; port?: number | null } | null = null;
  for (const root of roots) {
    if (cwd !== root.path && !cwd.startsWith(root.path + path.sep)) continue;
    if (!best || root.path.length > best.path.length) best = root;
  }
  if (!best) return null;
  // keep the sub-path, so werewolf-dapp's client and server read differently
  const suffix = cwd.slice(best.path.length).replace(/^\//, "");
  return {
    label: suffix ? `${best.name} · ${suffix.split(path.sep)[0]}` : best.name,
    // psm stores one port per project. In a monorepo that is whichever app it
    // detected, so claiming it for a *sub*-directory would be confidently wrong —
    // werewolf-dapp's port is its client's 5173, not its server's 3000.
    port: suffix ? null : best.port ?? null,
  };
}

/** psm's own process tree, so the panel never invites you to kill the panel. */
function selfPids(table: Map<number, PsRow>): Set<number> {
  const mine = new Set<number>([process.pid]);
  // walk up: tsx/npm wrappers above us are just as fatal to kill
  let cursor = table.get(process.pid)?.ppid;
  for (let depth = 0; cursor && cursor > 1 && depth < 6; depth++) {
    const row = table.get(cursor);
    if (!row) break;
    // stop at the shell/terminal — that is not psm
    if (/^(bash|zsh|sh|fish|login|tmux|systemd)\b/.test(labelFor(row.args))) break;
    mine.add(cursor);
    cursor = row.ppid;
  }
  return mine;
}

export interface MachineOptions {
  /** Linked project roots, so processes can be attributed to a project. */
  roots?: { name: string; path: string; port?: number | null }[];
}

export function machineProcesses(options: MachineOptions = {}): MachineProcess[] {
  const table = processTable();
  const ports = listeningByPid();
  const mine = selfPids(table);
  const managed = new Set(activeProcesses().map((proc) => proc.pid).filter(Boolean) as number[]);
  const roots = options.roots || [];

  const interesting = new Set<number>([...ports.keys()]);
  // match the label, not the raw args: a shell whose command line merely *mentions*
  // vite is not a dev server, and its args often quote a whole script
  for (const row of table.values()) if (DEV_HINTS.test(labelFor(row.args))) interesting.add(row.pid);

  // `npm exec tsx …` → `sh -c tsx …` → `tsx` → `node …` is one dev server wearing
  // four hats. Keep the one that actually holds the port: drop any candidate that
  // has no port of its own but has another candidate somewhere below it.
  const childrenOf = new Map<number, number[]>();
  for (const row of table.values()) {
    if (!childrenOf.has(row.ppid)) childrenOf.set(row.ppid, []);
    childrenOf.get(row.ppid)!.push(row.pid);
  }
  /** Ports held anywhere below `pid` — a wrapper's listener is its child's. */
  const descendantPorts = (
    pid: number,
    children: Map<number, number[]>,
    held: Map<number, Set<number>>,
    depth = 0,
  ): number[] => {
    if (depth > 8) return [];
    const found: number[] = [];
    for (const child of children.get(pid) || []) {
      for (const port of held.get(child) || []) found.push(port);
      found.push(...descendantPorts(child, children, held, depth + 1));
    }
    return found;
  };

  const hasCandidateDescendant = (pid: number, depth = 0): boolean => {
    if (depth > 8) return false;
    for (const child of childrenOf.get(pid) || []) {
      if (interesting.has(child) || hasCandidateDescendant(child, depth + 1)) return true;
    }
    return false;
  };

  const list: MachineProcess[] = [];
  for (const pid of interesting) {
    const row = table.get(pid);
    if (!row) continue;
    if (!ports.has(pid) && hasCandidateDescendant(pid)) continue;

    const cwd = cwdOf(pid);
    const owner = projectFor(cwd, roots);
    // A wrapper we kept (nodemon, a runner) holds no socket itself — the port is
    // one level down. Roll descendants up so every server row names its port.
    const own = new Set(ports.get(pid) || []);
    if (!own.size) for (const port of descendantPorts(pid, childrenOf, ports)) own.add(port);
    list.push({
      pid,
      ppid: row.ppid,
      command: row.args.slice(0, 300),
      label: labelFor(row.args),
      ports: [...own].sort((a, b) => a - b),
      expectedPort: own.size ? null : owner?.port ?? null,
      cwd,
      project: owner?.label ?? null,
      ageSeconds: row.etimes,
      rssBytes: row.rss,
      psmManaged: managed.has(pid),
      self: mine.has(pid),
      duplicateOf: null,
    });
  }

  // Same project + same label, more than one alive: everything but the newest is
  // very likely a leftover. This is the case that fills up 5173, 5174, 5175.
  const groups = new Map<string, MachineProcess[]>();
  for (const proc of list) {
    if (proc.self || proc.psmManaged) continue;
    const key = `${proc.project || proc.cwd || "?"}\0${proc.label}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(proc);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const newest = group.reduce((a, b) => (a.ageSeconds <= b.ageSeconds ? a : b));
    for (const proc of group) if (proc !== newest) proc.duplicateOf = newest.pid;
  }

  return list.sort(
    (a, b) => (a.project || "~").localeCompare(b.project || "~") || a.ageSeconds - b.ageSeconds,
  );
}

export class StopError extends Error {}

/**
 * Stop a process. SIGTERM by default so it can clean up; SIGKILL only when the
 * caller explicitly insists, because a dev server killed mid-write can leave a
 * corrupt build cache behind.
 */
export function stopProcess(pid: number, force = false): { ok: true; signal: string } {
  if (!Number.isInteger(pid) || pid <= 0) throw new StopError("not a valid pid");
  if (PROTECTED.has(pid)) throw new StopError("that is a system process");
  if (pid === process.pid) throw new StopError("that is psm itself");

  const table = processTable();
  if (!table.has(pid)) throw new StopError("that process is no longer running");
  if (selfPids(table).has(pid)) throw new StopError("that is psm itself");

  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") throw new StopError("that process is no longer running");
    if (code === "EPERM") throw new StopError("psm does not have permission to stop that process");
    throw new StopError((err as Error).message || "could not stop that process");
  }
  return { ok: true, signal };
}
