import { spawn, type ChildProcess } from "node:child_process";
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
  subscribers: Set<Response>;
}

const MAX_LOG = 3000; // ring-buffer cap per process
const registry = new Map<string, ProcEntry>();

// strip terminal colour/cursor escape sequences so logs read as plain text
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");
// a dev server announcing its URL, e.g. "Local: http://localhost:5173/"
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/;

const keyOf = (name: string, kind: ProcKind) => `${name}::${kind}`;

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

function pushLine(p: ProcEntry, stream: LogLine["stream"], text: string) {
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    if (raw === "") continue;
    const entry: LogLine = { t: Date.now(), stream, line: raw };
    p.log.push(entry);
    if (p.log.length > MAX_LOG) p.log.shift();
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
    subscribers: new Set(),
  };
  p.command = command;
  p.cwd = cwd;
  p.status = "running";
  p.exitCode = null;
  p.startedAt = Date.now();
  p.detectedPort = null; // re-sniff on each run
  registry.set(key, p);

  pushLine(p, "sys", `$ ${command}`);

  // detached so we can signal the whole process group (kills grandchildren too);
  // NO_COLOR/FORCE_COLOR ask tools to skip escape codes (we also strip defensively)
  const child = spawn(command, {
    cwd,
    shell: true,
    detached: true,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
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
