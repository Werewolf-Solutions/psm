import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Response } from "express";

/** A managed process: a project's dev server, or a deploy to a target. */
export type ProcKind = "run" | "deploy:staging" | "deploy:production";
export type ProcStatus = "running" | "exited" | "error";

export interface LogLine {
  t: number; // epoch ms
  stream: "out" | "err" | "sys";
  line: string;
}

interface ProcEntry {
  name: string;
  kind: ProcKind;
  command: string;
  cwd: string;
  child: ChildProcess | null;
  status: ProcStatus;
  exitCode: number | null;
  startedAt: number;
  detectedPort: number | null; // web port sniffed from the run output
  log: LogLine[];
  file: fs.WriteStream | null; // the full transcript, for Download
  subscribers: Set<Response>;
}

/** Ring-buffer cap per process. Exported so a capped download can say so. */
export const MAX_LOG_LINES = 3000;
const registry = new Map<string, ProcEntry>();

/**
 * The full transcript, on disk.
 *
 * The in-memory buffer above is a ring, so a chatty dev server pushes its own
 * startup out of it within a minute — which is exactly the part you want when
 * something went wrong at boot. Download promises "since it started", so the
 * lines go to a file as well and the ring stays what the console replays.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env.PSM_LOG_DIR || path.resolve(__dirname, "..", "..", ".psm-logs");

/** One file per process, named so it is obvious what it holds. */
export function logFile(name: string, kind: ProcKind): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(LOG_DIR, `${safe(name)}__${safe(kind)}.log`);
}

/** Truncate and reopen: a run's transcript starts when the run does. */
function openLogFile(p: ProcEntry): void {
  p.file?.end();
  p.file = null;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    p.file = fs.createWriteStream(logFile(p.name, p.kind), { flags: "w", mode: 0o600 });
    // A disk that fills up, or a read-only checkout: the console must keep
    // working, so a failed transcript is dropped rather than thrown.
    p.file.on("error", () => {
      p.file = null;
    });
  } catch {
    p.file = null;
  }
}

// strip terminal colour/cursor escape sequences so logs read as plain text
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");
// a dev server announcing its URL, e.g. "Local: http://localhost:5173/"
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/;

const keyOf = (name: string, kind: ProcKind) => `${name}::${kind}`;

/**
 * The environment anything psm spawns should run in.
 *
 * Emphatically **not** psm's. psm's server has `PORT` set — that is the port psm
 * itself is listening on — and a child inheriting it is a genuine trap: dotenv
 * does not overwrite variables that already exist, so the project silently
 * ignores its own `.env` and tries to bind psm's port. Running werewolf-dapp
 * from psm's Run button did exactly that, and its server died on 4317 with
 * "address already in use" while its `.env` plainly said 3000.
 *
 * `PSM_*` goes too: psm's mode, data directory and session secret are psm's
 * business, and one of them is a credential.
 *
 * Exported because a project's dev server is no longer the only child psm
 * starts. The AI pane shells out to a coding CLI (see `ai.ts`) which reads its
 * environment, prints it when asked, and starts dev servers of its own — every
 * reason above applies to it at least as strongly.
 *
 * A denylist rather than an allowlist, deliberately: the CLI needs `PATH`,
 * `HOME`, the provider's own credentials and whatever else the user's shell
 * carries, and psm cannot enumerate that. What psm *can* enumerate is its own
 * variables, which are exactly the ones that should not travel.
 */
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PORT;
  for (const key of Object.keys(env)) {
    if (key.startsWith("PSM_")) delete env[key];
  }
  return env;
}

export function getProc(name: string, kind: ProcKind): ProcEntry | undefined {
  return registry.get(keyOf(name, kind));
}

/** Public snapshot (no child handle / subscribers) for the API. */
export function procState(name: string, kind: ProcKind) {
  const p = registry.get(keyOf(name, kind));
  if (!p) return { status: "idle" as const, command: null, exitCode: null, startedAt: null };
  return {
    status: p.status,
    command: p.command,
    exitCode: p.exitCode,
    startedAt: p.startedAt,
  };
}

/** All known process states, keyed by "name::kind" — for dashboard dots. */
export function allProcStates() {
  const out: Record<string, { status: ProcStatus }> = {};
  for (const [key, p] of registry) out[key] = { status: p.status };
  return out;
}

/** Running project processes for the Working on lane. */
export function activeProcesses() {
  return [...registry.values()]
    .filter((p) => p.status === "running")
    .map((p) => ({
      name: p.name,
      kind: p.kind,
      command: p.command,
      startedAt: p.startedAt,
      // the machine panel uses this to tell "psm started this" from "this was
      // already here"; a shell-wrapped child's group is what actually holds ports
      pid: p.child?.pid ?? null,
    }));
}

function pushLine(p: ProcEntry, stream: LogLine["stream"], text: string) {
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    if (raw === "") continue;
    const entry: LogLine = { t: Date.now(), stream, line: raw };
    p.log.push(entry);
    if (p.log.length > MAX_LOG_LINES) p.log.shift();
    // Timestamped on disk, because a downloaded transcript is read away from
    // the console that showed when each line arrived.
    p.file?.write(`${new Date(entry.t).toISOString()} ${stream} ${raw}\n`);
    const payload = `data: ${JSON.stringify(entry)}\n\n`;
    for (const res of p.subscribers) res.write(payload);
    // sniff the dev-server URL from a run's own output (the reliable source of truth)
    if (p.kind === "run" && p.detectedPort == null) {
      const m = raw.match(URL_RE);
      if (m) {
        p.detectedPort = Number(m[1]);
        broadcastPort(p, p.detectedPort);
      }
    }
  }
}

function broadcastPort(p: ProcEntry, port: number) {
  const payload = `event: port\ndata: ${JSON.stringify({ port })}\n\n`;
  for (const res of p.subscribers) res.write(payload);
}

function broadcastStatus(p: ProcEntry) {
  const payload = `event: status\ndata: ${JSON.stringify({ status: p.status, exitCode: p.exitCode })}\n\n`;
  for (const res of p.subscribers) res.write(payload);
}

/** Start (or return the already-running) process for name+kind. */
export function start(name: string, kind: ProcKind, command: string, cwd: string): ProcEntry {
  const key = keyOf(name, kind);
  const existing = registry.get(key);
  if (existing && existing.status === "running") return existing;

  const p: ProcEntry = existing ?? {
    name,
    kind,
    command,
    cwd,
    child: null,
    status: "running",
    exitCode: null,
    startedAt: Date.now(),
    detectedPort: null,
    log: [],
    file: null,
    subscribers: new Set(),
  };
  p.command = command;
  p.cwd = cwd;
  p.status = "running";
  p.exitCode = null;
  p.startedAt = Date.now();
  p.detectedPort = null; // re-sniff on each run
  p.log = []; // a restart's console starts clean, like its transcript
  registry.set(key, p);

  openLogFile(p);
  pushLine(p, "sys", `$ ${command}`);

  // detached so we can signal the whole process group (kills grandchildren too);
  // NO_COLOR/FORCE_COLOR ask tools to skip escape codes (we also strip defensively)
  const child = spawn(command, {
    cwd,
    shell: true,
    detached: true,
    env: { ...childEnv(), FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  p.child = child;

  child.stdout?.on("data", (d) => pushLine(p, "out", d.toString()));
  child.stderr?.on("data", (d) => pushLine(p, "err", d.toString()));
  child.on("error", (err) => {
    p.status = "error";
    pushLine(p, "sys", `[psm] failed to start: ${err.message}`);
    broadcastStatus(p);
  });
  child.on("exit", (code, signal) => {
    p.exitCode = code;
    p.status = code === 0 || signal ? "exited" : "error";
    p.child = null;
    pushLine(p, "sys", `[psm] process exited (${signal ? `signal ${signal}` : `code ${code}`})`);
    broadcastStatus(p);
    // Flush before the file can be downloaded — the last lines are the ones
    // someone downloading after a crash has come for.
    p.file?.end();
    p.file = null;
  });

  return p;
}

/** Stop the process group for name+kind. Returns whether anything was running. */
export function stop(name: string, kind: ProcKind): boolean {
  const p = registry.get(keyOf(name, kind));
  if (!p || !p.child || p.status !== "running") return false;
  const pid = p.child.pid;
  if (pid == null) return false;
  pushLine(p, "sys", "[psm] stopping…");
  try {
    process.kill(-pid, "SIGTERM"); // negative pid → whole group
  } catch {
    try {
      p.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  // hard-kill if it ignores SIGTERM
  const child = p.child;
  setTimeout(() => {
    if (child.pid && p.status === "running") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }, 4000);
  return true;
}

/** Stop every managed run/deploy process for a project. */
export function stopAll(name: string): ProcKind[] {
  const stopped: ProcKind[] = [];
  for (const p of registry.values()) {
    if (p.name === name && p.status === "running" && stop(name, p.kind)) stopped.push(p.kind);
  }
  return stopped;
}

/**
 * The whole transcript of the current (or last) run, as plain text.
 *
 * The file is the real answer — it holds every line since the process started.
 * The ring buffer is the fallback for a run that predates this feature, or one
 * whose file could not be opened; it is capped, so it is labelled as such.
 */
export function transcript(name: string, kind: ProcKind): { text: string; complete: boolean } | null {
  const p = registry.get(keyOf(name, kind));
  try {
    const text = fs.readFileSync(logFile(name, kind), "utf8");
    // An entry that was never started this session must not claim a stale file
    // from a previous one is its own.
    if (p?.startedAt || text) return { text, complete: true };
  } catch {
    /* fall back to whatever is in memory */
  }
  if (!p || !p.log.length) return null;
  const text = p.log
    .map((entry) => `${new Date(entry.t).toISOString()} ${entry.stream} ${entry.line}\n`)
    .join("");
  return { text, complete: p.log.length < MAX_LOG_LINES };
}

/** Attach an SSE response: replay the buffered log, then stream live. */
export function subscribe(res: Response, name: string, kind: ProcKind): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let p = registry.get(keyOf(name, kind));
  if (!p) {
    // no process yet — hold the stream open so it picks up when one starts
    p = {
      name,
      kind,
      command: "",
      cwd: "",
      child: null,
      status: "exited",
      exitCode: null,
      startedAt: 0,
      detectedPort: null,
      log: [],
      file: null,
      subscribers: new Set(),
    };
    registry.set(keyOf(name, kind), p);
  }

  // replay buffered lines
  for (const entry of p.log) res.write(`data: ${JSON.stringify(entry)}\n\n`);
  // a process that never started should read as "idle", not "exited"
  const initial = p.startedAt === 0 ? "idle" : p.status;
  res.write(`event: status\ndata: ${JSON.stringify({ status: initial, exitCode: p.exitCode })}\n\n`);
  if (p.detectedPort != null) // catch up a late subscriber
    res.write(`event: port\ndata: ${JSON.stringify({ port: p.detectedPort })}\n\n`);

  p.subscribers.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(ping);
    p!.subscribers.delete(res);
  });
}
