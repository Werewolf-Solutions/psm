import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Response } from "express";

/**
 * The AI pane: shells out to a coding CLI (`claude` by default, `codex`
 * optionally) running inside a project's directory, parses its JSON event
 * stream, and relays a transcript to the browser over SSE. One conversation
 * per project, resumed across turns via the provider's session id.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOUSE_RULES = path.resolve(__dirname, "..", "..", "house-rules.md");

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
}

const MAX_LOG = 2000;
const sessions = new Map<string, AiSession>();

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
    s = { name, cwd, engine, sessionId: null, busy: false, child: null, log: [], subscribers: new Set() };
    sessions.set(name, s);
  }
  if (s.engine !== engine) {
    // switching engines starts a fresh conversation
    s.engine = engine;
    s.sessionId = null;
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
}

function broadcast(s: AiSession, event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of s.subscribers) res.write(payload);
}

export function aiState(name: string) {
  const s = sessions.get(name);
  return { busy: !!s?.busy, engine: s?.engine ?? "claude", hasSession: !!s?.sessionId };
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

  s.subscribers.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(ping);
    s.subscribers.delete(res);
  });
}
