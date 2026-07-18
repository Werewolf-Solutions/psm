import { spawn, execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Response } from "express";

/**
 * The AI pane: shells out to a coding CLI (`claude` by default, `codex`
 * optionally) running inside a project's directory, parses its JSON event
 * stream, and relays a transcript to the browser over SSE. One conversation
 * per project, resumed across turns (and across restarts) via the provider's
 * session id, with the transcript + a recap persisted to disk.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOUSE_RULES = path.resolve(__dirname, "..", "..", "house-rules.md");
const SESSIONS_FILE = path.resolve(__dirname, "..", "..", ".psm-sessions.json");

export type AiEngine = "claude" | "codex";

export interface AiEvent {
  t: number;
  role: "user" | "assistant" | "system";
  text: string;
}

interface AiSession {
  name: string;
  cwd: string;
  engine: AiEngine;
  sessionId: string | null; // provider session/thread id, for resume
  busy: boolean;
  child: ChildProcess | null;
  log: AiEvent[];
  subscribers: Set<Response>;
  summary: string | null; // "where we left off" recap
  summaryAt: number; // log length the summary was generated at
}

const MAX_LOG = 2000;
const MAX_PERSIST = 400; // transcript lines kept on disk per project
const sessions = new Map<string, AiSession>();

/** Persisted shape (no live child/subscribers). */
interface PersistedSession {
  engine: AiEngine;
  sessionId: string | null;
  log: AiEvent[];
  summary: string | null;
  summaryAt: number;
  updatedAt: number;
}

function loadSessions(): void {
  let data: Record<string, PersistedSession>;
  try {
    data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  } catch {
    return; // no saved sessions yet
  }
  for (const [name, p] of Object.entries(data)) {
    sessions.set(name, {
      name,
      cwd: "", // filled in when the client next subscribes
      engine: p.engine || "claude",
      sessionId: p.sessionId ?? null,
      busy: false,
      child: null,
      log: p.log || [],
      subscribers: new Set(),
      summary: p.summary ?? null,
      summaryAt: p.summaryAt ?? 0,
    });
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveSessionsSoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(saveSessions, 500);
}
function saveSessions(): void {
  saveTimer = null;
  const out: Record<string, PersistedSession> = {};
  for (const [name, s] of sessions) {
    if (!s.sessionId && !s.log.length) continue;
    out[name] = {
      engine: s.engine,
      sessionId: s.sessionId,
      log: s.log.slice(-MAX_PERSIST),
      summary: s.summary,
      summaryAt: s.summaryAt,
      updatedAt: Date.now(),
    };
  }
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(out));
  } catch {
    /* best effort */
  }
}

loadSessions();

function houseRules(): string {
  try {
    return fs.readFileSync(HOUSE_RULES, "utf8").trim();
  } catch {
    return "";
  }
}

const sys = (text: string): AiEvent => ({ t: Date.now(), role: "system", text });
const short = (id: string | null) => (id ? id.slice(0, 8) : "—");

function getSession(name: string, cwd: string, engine: AiEngine): AiSession {
  let s = sessions.get(name);
  if (!s) {
    s = {
      name, cwd, engine, sessionId: null, busy: false, child: null,
      log: [], subscribers: new Set(), summary: null, summaryAt: 0,
    };
    sessions.set(name, s);
  }
  if (s.engine !== engine) {
    // switching engines starts a fresh conversation
    s.engine = engine;
    s.sessionId = null;
    s.summary = null;
    s.summaryAt = 0;
    pushEvent(s, sys(`— switched to ${engine}; starting a new conversation —`));
  }
  s.cwd = cwd;
  return s;
}

function pushEvent(s: AiSession, ev: AiEvent) {
  s.log.push(ev);
  if (s.log.length > MAX_LOG) s.log.shift();
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of s.subscribers) res.write(payload);
  saveSessionsSoon();
}

function broadcast(s: AiSession, event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of s.subscribers) res.write(payload);
}

export function aiState(name: string) {
  const s = sessions.get(name);
  return { busy: !!s?.busy, engine: s?.engine ?? "claude", hasSession: !!s?.sessionId };
}

/** Every project with an ongoing AI conversation, most-recently-active first. */
export function activeSessions() {
  const out = [];
  for (const [name, s] of sessions) {
    if (!s.sessionId && !s.log.length) continue;
    const lastUser = [...s.log].reverse().find((e) => e.role === "user");
    const lastEvent = s.log[s.log.length - 1];
    out.push({
      name,
      engine: s.engine,
      messages: s.log.filter((e) => e.role === "user").length,
      lastActive: lastEvent ? lastEvent.t : 0,
      snippet: (lastUser?.text ?? s.summary ?? "").replace(/\s+/g, " ").slice(0, 140),
      busy: s.busy,
    });
  }
  return out.sort((a, b) => b.lastActive - a.lastActive);
}

/** Build the argv for one turn (no shell — args are passed literally). */
function buildCommand(s: AiSession, message: string, fullAccess: boolean): { cmd: string; args: string[] } {
  const rules = houseRules();
  if (s.engine === "codex") {
    const sandbox = fullAccess
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : ["-s", "workspace-write"];
    const base = ["--json", "--skip-git-repo-check", ...sandbox];
    if (s.sessionId) {
      return { cmd: "codex", args: ["exec", "resume", s.sessionId, ...base, message] };
    }
    // codex has no system-prompt flag; fold the house rules into the first turn
    const prompt = rules ? `${rules}\n\n---\n\n${message}` : message;
    return { cmd: "codex", args: ["exec", ...base, prompt] };
  }
  // claude (default)
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  args.push("--permission-mode", fullAccess ? "bypassPermissions" : "acceptEdits");
  if (rules) args.push("--append-system-prompt", rules);
  if (s.sessionId) args.push("--resume", s.sessionId);
  args.push(message);
  return { cmd: "claude", args };
}

function toolSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick = o.file_path ?? o.path ?? o.command ?? o.pattern ?? o.url ?? o.prompt ?? "";
  return String(pick).replace(/\s+/g, " ").slice(0, 80);
}

function handleClaudeLine(s: AiSession, line: string) {
  line = line.trim();
  if (!line) return;
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (ev.session_id && !s.sessionId) s.sessionId = ev.session_id;
  if (ev.type === "system" && ev.subtype === "init") {
    pushEvent(s, sys(`● session ${short(ev.session_id)} · ${ev.model || ""} · ${ev.permissionMode || ""}`));
    return;
  }
  if (ev.type === "assistant" && ev.message?.content) {
    for (const b of ev.message.content) {
      if (b.type === "text" && b.text?.trim()) pushEvent(s, { t: Date.now(), role: "assistant", text: b.text });
      else if (b.type === "tool_use") pushEvent(s, sys(`→ ${b.name}(${toolSummary(b.input)})`));
    }
    return;
  }
  if (ev.type === "result") {
    if (ev.is_error) pushEvent(s, sys(`[error] ${ev.result || ev.subtype || "failed"}`));
    if (Array.isArray(ev.permission_denials) && ev.permission_denials.length)
      pushEvent(s, sys(`⚠ ${ev.permission_denials.length} action(s) blocked — turn on Full access to let the AI run commands`));
  }
}

function handleCodexLine(s: AiSession, line: string) {
  line = line.trim();
  if (!line) return;
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  switch (ev.type) {
    case "thread.started":
      if (ev.thread_id) s.sessionId = ev.thread_id;
      break;
    case "error":
      pushEvent(s, sys(`[error] ${ev.message}`));
      break;
    case "turn.failed":
      pushEvent(s, sys(`[error] ${ev.error?.message || "turn failed"}`));
      break;
    case "item.completed": {
      const it = ev.item || {};
      const t = it.item_type || it.type;
      if ((t === "agent_message" || t === "assistant_message") && it.text)
        pushEvent(s, { t: Date.now(), role: "assistant", text: it.text });
      else if (t === "command_execution" && it.command) pushEvent(s, sys(`→ $ ${String(it.command).slice(0, 80)}`));
      else if (t === "file_change" || t === "patch") pushEvent(s, sys(`→ edited files`));
      break;
    }
  }
}

/** Start one turn. Returns immediately; output arrives over the SSE stream. */
export function send(
  name: string,
  cwd: string,
  engine: AiEngine,
  message: string,
  fullAccess: boolean,
): { ok: boolean; error?: string } {
  const s = getSession(name, cwd, engine);
  if (s.busy) return { ok: false, error: "the AI is still working on the previous turn" };
  if (!message.trim()) return { ok: false, error: "empty message" };

  s.busy = true;
  pushEvent(s, { t: Date.now(), role: "user", text: message });
  broadcast(s, "status", { busy: true, engine });

  const { cmd, args } = buildCommand(s, message, fullAccess);
  const handleLine = engine === "codex" ? handleCodexLine : handleClaudeLine;

  let child: ChildProcess;
  try {
    // stdin 'ignore' so the CLI doesn't wait on stdin (prompt is an arg)
    child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0" } });
  } catch (err) {
    pushEvent(s, sys(`[psm] could not launch ${engine}: ${(err as Error).message}`));
    finishTurn(s);
    return { ok: true };
  }
  s.child = child;

  let buf = "";
  child.stdout?.on("data", (d) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      handleLine(s, line);
    }
  });
  child.stderr?.on("data", (d) => {
    const t = d.toString().trim();
    if (t) pushEvent(s, sys(t.slice(0, 400)));
  });
  child.on("error", (err) => {
    pushEvent(s, sys(`[psm] ${engine} failed: ${err.message}`));
    finishTurn(s);
  });
  child.on("exit", (code) => {
    if (buf.trim()) handleLine(s, buf);
    if (code && code !== 0) pushEvent(s, sys(`[psm] ${engine} exited with code ${code}`));
    finishTurn(s);
  });

  return { ok: true };
}

function finishTurn(s: AiSession) {
  s.busy = false;
  s.child = null;
  broadcast(s, "status", { busy: false, engine: s.engine });
  broadcast(s, "done", {});
  saveSessions(); // flush now so the session id / transcript survive a restart
}

/** A short "where we left off" recap, regenerated only when the log has grown. */
export async function recap(name: string): Promise<string | null> {
  const s = sessions.get(name);
  if (!s || !s.log.length) return null;
  if (s.summary && s.summaryAt >= s.log.length) return s.summary; // still current

  const transcript = s.log
    .map((e) =>
      e.role === "user" ? `User: ${e.text}` : e.role === "assistant" ? `Assistant: ${e.text}` : e.text,
    )
    .join("\n")
    .slice(-8000);
  const prompt =
    "Summarise the AI coding session transcript below so I can pick up where I left off. " +
    "Output ONLY 2-4 bullet points, each starting with '- ', covering what was done and what " +
    "we were working on. No introduction, no sign-off, no other text — just the bullets. " +
    "Do not use any tools; answer directly from the transcript.\n\n<transcript>\n" +
    transcript +
    "\n</transcript>";

  const raw = await claudeOneShot(prompt, s.cwd);
  if (raw) {
    // drop any preamble before the first bullet the model may have added anyway
    let clean = raw.trim();
    const firstBullet = clean.search(/^[-•*]\s/m);
    if (firstBullet > 0) clean = clean.slice(firstBullet).trim();
    s.summary = clean;
    s.summaryAt = s.log.length;
    saveSessionsSoon();
  }
  return s.summary;
}

/** Run claude headlessly for a plain text answer (used for the recap). */
function claudeOneShot(prompt: string, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["-p", "--output-format", "json", prompt],
      { cwd: cwd || process.cwd(), timeout: 90_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(stdout).result ?? null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** Cancel an in-flight turn. */
export function cancel(name: string): boolean {
  const s = sessions.get(name);
  if (!s || !s.child) return false;
  try {
    s.child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  pushEvent(s, sys("[psm] turn cancelled"));
  return true;
}

/** Attach an SSE response: replay transcript, then stream live. */
export function subscribeAi(res: Response, name: string, cwd: string, engine: AiEngine): void {
  const s = getSession(name, cwd, engine);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  for (const ev of s.log) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  res.write(`event: status\ndata: ${JSON.stringify({ busy: s.busy, engine: s.engine })}\n\n`);
  if (s.summary) // show the last recap instantly; the client refreshes it if stale
    res.write(`event: recap\ndata: ${JSON.stringify({ summary: s.summary })}\n\n`);

  s.subscribers.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(ping);
    s.subscribers.delete(res);
  });
}
