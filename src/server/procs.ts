import { spawn, type ChildProcess } from "node:child_process";
import type { Response } from "express";

/** A managed long-running process (a project's dev server, a deploy, …). */
export type ProcKind = "run" | "deploy";
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
  log: LogLine[];
  subscribers: Set<Response>;
}

const MAX_LOG = 3000; // ring-buffer cap per process
const registry = new Map<string, ProcEntry>();

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
  for (const raw of text.split(/\r?\n/)) {
    if (raw === "") continue;
    const entry: LogLine = { t: Date.now(), stream, line: raw };
    p.log.push(entry);
    if (p.log.length > MAX_LOG) p.log.shift();
    const payload = `data: ${JSON.stringify(entry)}\n\n`;
    for (const res of p.subscribers) res.write(payload);
  }
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
    log: [],
    subscribers: new Set(),
  };
  p.command = command;
  p.cwd = cwd;
  p.status = "running";
  p.exitCode = null;
  p.startedAt = Date.now();
  registry.set(key, p);

  pushLine(p, "sys", `$ ${command}`);

  // detached so we can signal the whole process group (kills grandchildren too)
  const child = spawn(command, {
    cwd,
    shell: true,
    detached: true,
    env: { ...process.env, FORCE_COLOR: "0" },
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
      log: [],
      subscribers: new Set(),
    };
    registry.set(keyOf(name, kind), p);
  }

  // replay buffered lines
  for (const entry of p.log) res.write(`data: ${JSON.stringify(entry)}\n\n`);
  res.write(`event: status\ndata: ${JSON.stringify({ status: p.status, exitCode: p.exitCode })}\n\n`);

  p.subscribers.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(ping);
    p!.subscribers.delete(res);
  });
}
