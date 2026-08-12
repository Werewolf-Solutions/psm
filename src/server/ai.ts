import { spawn, execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Response } from "express";
import type { ImplementationPlan } from "../types.ts";
import { planStore } from "./plans.ts";
import { composeSystemRules } from "./rules.ts";

/**
 * The AI pane: shells out to a coding CLI (`claude` by default, `codex`
 * optionally) running inside a project's directory, parses its JSON event
 * stream, and relays a transcript to the browser over SSE. One conversation
 * per project, resumed across turns (and across restarts) via the provider's
 * session id, with the transcript + a recap persisted to disk.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = path.resolve(__dirname, "..", "..", ".psm-sessions.json");

export type AiEngine = "claude" | "codex";
export type AiModel = string | null;
export type AiEffort = string | null;

/** Reserved session key for the workspace-wide chat (cwd = workspace root). */
export const WORKSPACE_NAME = "__workspace__";

export type AiSessionRole = "agent" | "planner" | "reviewer";
const PLANNING_PREFIX = "__psm_planning__";

export function planningSessionKey(project: string, role: Exclude<AiSessionRole, "agent">): string {
  return `${PLANNING_PREFIX}:${role}:${encodeURIComponent(project)}`;
}

function sessionIdentity(name: string): { project: string | null; role: AiSessionRole } {
  if (name === WORKSPACE_NAME) return { project: null, role: "agent" };
  const prefix = `${PLANNING_PREFIX}:`;
  if (!name.startsWith(prefix)) return { project: name, role: "agent" };
  const rest = name.slice(prefix.length);
  const separator = rest.indexOf(":");
  const role = rest.slice(0, separator);
  if (separator < 0 || (role !== "planner" && role !== "reviewer")) {
    return { project: null, role: "agent" };
  }
  try {
    return { project: decodeURIComponent(rest.slice(separator + 1)), role };
  } catch {
    return { project: null, role: "agent" };
  }
}

export interface PlanningLoopState {
  project: string;
  active: boolean;
  stage: "idle" | "planning" | "reviewing" | "revising" | "ready" | "ready-with-issues" | "error";
  planner: { engine: AiEngine; model: AiModel; effort: AiEffort };
  reviewer: { engine: AiEngine; model: AiModel; effort: AiEffort };
  round: number;
  maxRounds: number;
  planId: string | null;
  revision: number | null;
  message: string;
  startedAt: number;
  updatedAt: number;
}

const planningLoops = new Map<string, PlanningLoopState>();

export interface AiEvent {
  t: number;
  role: "user" | "assistant" | "system";
  text: string;
}

export interface AiQuestionOption {
  label: string;
  description: string;
}

export interface AiQuestion {
  id: string;
  header: string;
  question: string;
  options: AiQuestionOption[];
  multiSelect: boolean;
  isSecret: boolean;
}

export interface AiQuestionRequest {
  id: string;
  engine: AiEngine;
  askedAt: number;
  questions: AiQuestion[];
}

interface AiSession {
  name: string;
  cwd: string;
  engine: AiEngine;
  model: AiModel; // configured model id/alias for the selected CLI
  effort: AiEffort; // configured reasoning/effort level for the selected CLI
  actualModel: AiModel; // last model reported by the CLI, if available
  sessionId: string | null; // provider session/thread id, for resume
  busy: boolean;
  child: ChildProcess | null;
  log: AiEvent[];
  subscribers: Set<Response>;
  summary: string | null; // "where we left off" recap
  summaryAt: number; // log length the summary was generated at
  // messages sent while a turn was running, dispatched in order as it finishes.
  // the CLI resumes one session id at a time, so turns must stay sequential.
  queue: QueuedTurn[];
  question: AiQuestionRequest | null;
  // per-turn scratch, so a limit-blocked turn doesn't corrupt the resume state
  turnPrevSessionId?: string | null;
  turnHadAssistant?: boolean;
  turnStructured?: boolean;
  turnLimited?: boolean;
  turnPausedForQuestion?: boolean;
}

/** A message accepted while busy, held until the running turn finishes. */
interface QueuedTurn {
  message: string;
  model: AiModel;
  effort: AiEffort;
  fullAccess: boolean;
  extraContext: string;
}

function normalizeModel(model: unknown): AiModel {
  const trimmed = typeof model === "string" ? model.trim() : "";
  return trimmed || null;
}

function normalizeEffort(effort: unknown): AiEffort {
  const trimmed = typeof effort === "string" ? effort.trim().toLowerCase() : "";
  return /^[a-z][a-z0-9_-]{0,31}$/.test(trimmed) ? trimmed : null;
}

function modelLabel(model: AiModel): string {
  return model || "default model";
}

const INTERACTION_RULES = `PSM interaction protocol:
When you need user input that materially affects the work, prefer your native user-input/question tool.
If no native question tool is available, output exactly one marker and stop the turn:
<psm-question>{"questions":[{"id":"short_id","header":"Short label","question":"What do you need to know?","options":[{"label":"Choice","description":"What this choice changes"}],"multiSelect":false,"isSecret":false}]}</psm-question>
Use 1-3 questions. Options are optional. Do not wrap the marker in a code fence and do not continue until the user answers.
Only in a dedicated psm planner session, emit one <psm-plan> JSON marker with id, title, phases, and notes. Each phase has id, title, summary, and steps; each step has id, text, done, and children. Normal project-agent sessions implement confirmed plans and must not create plan markers.
Only in a dedicated psm reviewer session, emit one <psm-plan-review> marker with planId, revision, summary, and issues. Each issue has severity (info, warning, or blocking), message, and optional phaseId/stepId.
While executing a confirmed plan, report durable progress with <psm-plan-progress>{"planId":"...","revision":1,"completedStepIds":[],"blockedStepIds":[]}</psm-plan-progress>.
Never wrap psm markers in Markdown fences.`;

const MAX_LOG = 2000;
const MAX_PERSIST = 400; // transcript lines kept on disk per project
const sessions = new Map<string, AiSession>();

/** Persisted shape (no live child/subscribers). */
interface PersistedSession {
  engine: AiEngine;
  model?: string | null;
  effort?: string | null;
  actualModel?: string | null;
  sessionId: string | null;
  log: AiEvent[];
  summary: string | null;
  summaryAt: number;
  question?: AiQuestionRequest | null;
  updatedAt: number;
}

function loadSessions(): void {
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  } catch {
    return; // no saved sessions yet
  }
  // new format is { sessions, limits }; old format was the sessions map directly
  const map: Record<string, PersistedSession> = data.sessions ?? data;
  for (const [name, p] of Object.entries(map)) {
    sessions.set(name, {
      name,
      cwd: "", // filled in when the client next subscribes
      engine: p.engine || "claude",
      model: normalizeModel(p.model),
      effort: normalizeEffort(p.effort),
      actualModel: normalizeModel(p.actualModel),
      sessionId: p.sessionId ?? null,
      busy: false,
      child: null,
      log: p.log || [],
      subscribers: new Set(),
      summary: p.summary ?? null,
      summaryAt: p.summaryAt ?? 0,
      queue: [],
      question: p.question ?? null,
    });
  }
  if (data.limits) Object.assign(limits, data.limits);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveSessionsSoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(saveSessions, 500);
}
function saveSessions(): void {
  saveTimer = null;
  const map: Record<string, PersistedSession> = {};
  for (const [name, s] of sessions) {
    if (!s.sessionId && !s.log.length && !s.model && !s.effort && !s.actualModel && !s.question) continue;
    map[name] = {
      engine: s.engine,
      model: s.model,
      effort: s.effort,
      actualModel: s.actualModel,
      sessionId: s.sessionId,
      log: s.log.slice(-MAX_PERSIST),
      summary: s.summary,
      summaryAt: s.summaryAt,
      question: s.question,
      updatedAt: Date.now(),
    };
  }
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions: map, limits }));
  } catch {
    /* best effort */
  }
}

/* ---------- provider usage limits (per engine, not per project) ---------- */

interface LimitState {
  message: string;
  until: number | null; // epoch ms the limit resets, if known
  at: number; // when we recorded it
  hard: boolean; // true = actually blocked; false = a "you're getting close" warning
}
const limits: Partial<Record<AiEngine, LimitState>> = {};

/** Parse a reset time out of a limit message, e.g. "try again at Jul 30th, 2026 12:40 PM". */
function parseResetAt(message: string): number | null {
  const m = message.match(/try again (?:at|after)\s+([^.\n]+)/i);
  if (m) {
    const cleaned = m[1].replace(/(\d+)(st|nd|rd|th)/gi, "$1").trim();
    const t = Date.parse(cleaned);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

function setLimit(engine: AiEngine, message: string, until: number | null, hard: boolean): void {
  limits[engine] = { message: message.slice(0, 300), until, at: Date.now(), hard };
  saveSessionsSoon();
}

/** The active limit for an engine, or null. Clears itself once the window passes. */
export function aiLimit(engine: AiEngine): LimitState | null {
  const l = limits[engine];
  if (!l) return null;
  const expired = l.until ? Date.now() >= l.until : Date.now() - l.at > 15 * 60_000;
  if (expired) {
    delete limits[engine];
    saveSessionsSoon();
    return null;
  }
  return l;
}

loadSessions();

const sys = (text: string): AiEvent => ({ t: Date.now(), role: "system", text });
const short = (id: string | null) => (id ? id.slice(0, 8) : "—");

function getSession(name: string, cwd: string, engine: AiEngine, model: AiModel, effort: AiEffort): AiSession {
  const normalizedModel = normalizeModel(model);
  const normalizedEffort = normalizeEffort(effort);
  let s = sessions.get(name);
  if (!s) {
    s = {
      name, cwd, engine, model: normalizedModel, effort: normalizedEffort, actualModel: null, sessionId: null, busy: false, child: null,
      log: [], subscribers: new Set(), summary: null, summaryAt: 0, queue: [], question: null,
    };
    sessions.set(name, s);
  }
  if (s.engine !== engine) {
    // switching engines starts a fresh conversation
    s.engine = engine;
    s.model = normalizedModel;
    s.effort = normalizedEffort;
    s.actualModel = null;
    s.sessionId = null;
    s.summary = null;
    s.summaryAt = 0;
    if (s.question) broadcast(s, "question-cleared", { id: s.question.id });
    s.question = null;
    pushEvent(s, sys(`— switched to ${engine} (${modelLabel(normalizedModel)}); starting a new conversation —`));
  } else if (s.model !== normalizedModel) {
    s.model = normalizedModel;
    s.actualModel = null;
    pushEvent(s, sys(`— ${engine} model set to ${modelLabel(normalizedModel)} —`));
  }
  if (s.effort !== normalizedEffort) {
    s.effort = normalizedEffort;
    pushEvent(s, sys(`— ${engine} effort set to ${normalizedEffort || "default"} —`));
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

function resetConversation(name: string, cwd: string, engine: AiEngine, model: AiModel, effort: AiEffort): AiSession {
  const existing = sessions.get(name);
  if (existing?.busy || existing?.queue.length) {
    throw new Error(`${sessionIdentity(name).role} session is still working`);
  }
  const s = getSession(name, cwd, engine, model, effort);
  if (s.question) broadcast(s, "question-cleared", { id: s.question.id });
  s.engine = engine;
  s.model = normalizeModel(model);
  s.effort = normalizeEffort(effort);
  s.actualModel = null;
  s.sessionId = null;
  s.log = [];
  s.summary = null;
  s.summaryAt = 0;
  s.queue = [];
  s.question = null;
  s.turnPrevSessionId = null;
  s.turnHadAssistant = false;
  s.turnStructured = false;
  s.turnLimited = false;
  s.turnPausedForQuestion = false;
  broadcast(s, "reset", {});
  broadcast(s, "status", statusPayload(s));
  saveSessionsSoon();
  return s;
}

function broadcastProjectPlan(project: string, plan: ImplementationPlan): void {
  const keys = [
    project,
    planningSessionKey(project, "planner"),
    planningSessionKey(project, "reviewer"),
  ];
  for (const key of keys) {
    const session = sessions.get(key);
    if (session) broadcast(session, "plan", { plan });
  }
}

function broadcastPlanningState(project: string): void {
  const state = planningLoops.get(project);
  if (!state) return;
  for (const role of ["planner", "reviewer"] as const) {
    const session = sessions.get(planningSessionKey(project, role));
    if (session) broadcast(session, "planning", { state });
  }
}

function updatePlanningState(
  project: string,
  patch: Partial<Omit<PlanningLoopState, "project" | "planner" | "reviewer" | "startedAt">>,
): PlanningLoopState | null {
  const current = planningLoops.get(project);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  planningLoops.set(project, next);
  broadcastPlanningState(project);
  return next;
}

function plannerSystemContext(role: "planner" | "reviewer"): string {
  return (
    `You are the dedicated psm ${role}. This is a planning-only, read-only session. ` +
    "Inspect the repository as needed, but never edit files, run mutating commands, attach capabilities, " +
    "or begin implementation. The normal project agent receives the final confirmed plan in a separate session."
  );
}

function initialPlanningPrompt(project: string, brief: string): string {
  return (
    "[psm dedicated planning session]\n" +
    `Create an implementation plan for ${project}. Investigate the current repository before deciding. ` +
    "Keep phases dependency-ordered, steps small enough to verify, and include tests and rollout/safety work. " +
    "Ask focused questions if a missing product decision materially changes the plan. When the plan is ready " +
    "for another model to review, reply briefly and emit exactly one <psm-plan> JSON marker using a new unique plan id and the documented schema. " +
    "Do not implement anything.\n\nUser brief:\n" + brief
  );
}

function modelReviewPrompt(plan: ImplementationPlan, round: number, maxRounds: number): string {
  return (
    "[psm cross-model plan review]\n" +
    `You are review agent ${round} of at most ${maxRounds}. Independently review this exact revision. ` +
    "Look for incorrect assumptions, missing dependencies, unsafe ordering, vague tasks, missing verification, " +
    "and scope that should be split. Do not edit the repository or replace the plan. Emit exactly one " +
    "<psm-plan-review> JSON marker with planId, revision, summary, and issues. Use warning/blocking only when " +
    "the planner should revise; use info for optional observations.\n\n" +
    JSON.stringify(plan, null, 2)
  );
}

function revisionPrompt(plan: ImplementationPlan): string {
  return (
    "[psm planner revision]\n" +
    "A different model reviewed the plan below. Resolve every warning and blocking issue that is valid. " +
    "Preserve the same plan id, produce a complete replacement plan, and do not implement anything. " +
    "Reply briefly and emit exactly one <psm-plan> JSON marker.\n\n" +
    JSON.stringify(plan, null, 2)
  );
}

function failPlanning(project: string, message: string, plan?: ImplementationPlan): void {
  if (plan?.status === "reviewing") {
    try {
      const restored = planStore.markReviewUnavailable(project, plan.id, plan.revision);
      broadcastProjectPlan(project, restored);
    } catch {
      // The plan may have advanced independently; keep that newer state.
    }
  }
  updatePlanningState(project, { active: false, stage: "error", message });
}

function continuePlanningAfterPlan(s: AiSession, plan: ImplementationPlan): ImplementationPlan {
  const identity = sessionIdentity(s.name);
  if (identity.role !== "planner" || !identity.project) return plan;
  const loop = planningLoops.get(identity.project);
  if (!loop?.active) return plan;
  let reviewing: ImplementationPlan;
  try {
    reviewing = planStore.requestReview(identity.project, plan.id, plan.revision);
  } catch (err) {
    failPlanning(identity.project, (err as Error).message, plan);
    return plan;
  }
  const nextRound = loop.round + 1;
  updatePlanningState(identity.project, {
    stage: "reviewing",
    planId: reviewing.id,
    revision: reviewing.revision,
    message: `${loop.reviewer.engine} is reviewing revision ${reviewing.revision}`,
  });
  broadcastProjectPlan(identity.project, reviewing);
  const queued = send(
    planningSessionKey(identity.project, "reviewer"),
    s.cwd,
    loop.reviewer.engine,
    loop.reviewer.model,
    loop.reviewer.effort,
    modelReviewPrompt(reviewing, nextRound, loop.maxRounds),
    false,
    plannerSystemContext("reviewer"),
  );
  if (!queued.ok) failPlanning(identity.project, queued.error || "reviewer could not start", reviewing);
  return reviewing;
}

function continuePlanningAfterReview(s: AiSession, plan: ImplementationPlan): void {
  const identity = sessionIdentity(s.name);
  if (identity.role !== "reviewer" || !identity.project) return;
  const loop = planningLoops.get(identity.project);
  if (!loop?.active) return;
  const round = loop.round + 1;
  const actionable = !!plan.review?.issues.some(
    (issue) => issue.severity === "warning" || issue.severity === "blocking",
  );
  if (!actionable) {
    updatePlanningState(identity.project, {
      active: false,
      stage: "ready",
      round,
      planId: plan.id,
      revision: plan.revision,
      message: "Cross-model review passed; ready for your confirmation",
    });
    return;
  }
  if (round >= loop.maxRounds) {
    updatePlanningState(identity.project, {
      active: false,
      stage: "ready-with-issues",
      round,
      planId: plan.id,
      revision: plan.revision,
      message: "Review limit reached; inspect the remaining issues before confirming",
    });
    return;
  }
  updatePlanningState(identity.project, {
    stage: "revising",
    round,
    planId: plan.id,
    revision: plan.revision,
    message: `${loop.planner.engine} is revising after review ${round}`,
  });
  const queued = send(
    planningSessionKey(identity.project, "planner"),
    s.cwd,
    loop.planner.engine,
    loop.planner.model,
    loop.planner.effort,
    revisionPrompt(plan),
    false,
    plannerSystemContext("planner"),
  );
  if (!queued.ok) failPlanning(identity.project, queued.error || "planner could not revise");
}

function normalizeQuestionRequest(s: AiSession, raw: unknown, sourceId?: string): AiQuestionRequest | null {
  let source: any = raw;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return null;
    }
  }
  const list = Array.isArray(source) ? source : source?.questions;
  if (!Array.isArray(list)) return null;
  const questions: AiQuestion[] = [];
  for (const [index, value] of list.slice(0, 3).entries()) {
    if (!value || typeof value !== "object") continue;
    const q = value as Record<string, any>;
    const question = String(q.question ?? q.prompt ?? "").trim();
    if (!question) continue;
    const options = (Array.isArray(q.options) ? q.options : [])
      .slice(0, 8)
      .map((option: any) =>
        typeof option === "string"
          ? { label: option.trim(), description: "" }
          : { label: String(option?.label ?? "").trim(), description: String(option?.description ?? "").trim() },
      )
      .filter((option: AiQuestionOption) => option.label);
    questions.push({
      id: String(q.id ?? `question_${index + 1}`),
      header: String(q.header ?? `Question ${index + 1}`).slice(0, 80),
      question: question.slice(0, 2000),
      options,
      multiSelect: !!(q.multiSelect ?? q.multi_select),
      isSecret: !!(q.isSecret ?? q.is_secret),
    });
  }
  if (!questions.length) return null;
  return {
    id: sourceId || String(source?.id ?? `${s.engine}-${Date.now()}`),
    engine: s.engine,
    askedAt: Date.now(),
    questions,
  };
}

function noteQuestion(s: AiSession, raw: unknown, sourceId?: string): boolean {
  const question = normalizeQuestionRequest(s, raw, sourceId);
  if (!question) return false;
  if (s.question?.id === question.id) return true;
  s.question = question;
  pushEvent(s, sys(`[psm] ${s.engine} is waiting for your answer`));
  broadcast(s, "question", question);
  broadcast(s, "status", statusPayload(s));
  saveSessionsSoon();
  return true;
}

const QUESTION_MARKER_RE = /<psm-question>\s*([\s\S]*?)\s*<\/psm-question>/i;
const PLAN_MARKER_RE = /<psm-plan>\s*([\s\S]*?)\s*<\/psm-plan>/i;
const PLAN_REVIEW_MARKER_RE = /<psm-plan-review>\s*([\s\S]*?)\s*<\/psm-plan-review>/i;
const PLAN_PROGRESS_MARKER_RE = /<psm-plan-progress>\s*([\s\S]*?)\s*<\/psm-plan-progress>/i;

function handleAssistantText(s: AiSession, text: string): void {
  s.turnHadAssistant = true;
  let clean = text;
  const identity = sessionIdentity(s.name);
  const handlers: Array<{
    pattern: RegExp;
    handle: (value: unknown) => void;
  }> = [
    {
      pattern: QUESTION_MARKER_RE,
      handle: (value) => {
        if (!noteQuestion(s, value)) throw new Error("invalid question marker");
      },
    },
    {
      pattern: PLAN_REVIEW_MARKER_RE,
      handle: (value) => {
        if (!identity.project || identity.role !== "reviewer") {
          throw new Error("only the dedicated reviewer session can emit a plan review");
        }
        const plan = planStore.recordReview(identity.project, value);
        s.turnStructured = true;
        broadcastProjectPlan(identity.project, plan);
        pushEvent(s, sys(`[psm] reviewed plan ${plan.title} · revision ${plan.revision}`));
        continuePlanningAfterReview(s, plan);
      },
    },
    {
      pattern: PLAN_PROGRESS_MARKER_RE,
      handle: (value) => {
        if (!identity.project || identity.role !== "agent") {
          throw new Error("only the normal project agent can own plan progress");
        }
        const plan = planStore.applyProgress(identity.project, value);
        broadcastProjectPlan(identity.project, plan);
        pushEvent(s, sys(`[psm] plan progress updated · ${plan.status}`));
      },
    },
    {
      pattern: PLAN_MARKER_RE,
      handle: (value) => {
        if (!identity.project || identity.role !== "planner") {
          throw new Error("only the dedicated planner session can emit an implementation plan");
        }
        let plan = planStore.ingestAiPlan(identity.project, value);
        s.turnStructured = true;
        plan = continuePlanningAfterPlan(s, plan);
        broadcastProjectPlan(identity.project, plan);
        pushEvent(s, sys(`[psm] saved plan ${plan.title} · revision ${plan.revision}`));
      },
    },
  ];
  for (const entry of handlers) {
    const marker = clean.match(entry.pattern);
    if (!marker) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(marker[1]);
      entry.handle(parsed);
      clean = clean.replace(marker[0], "");
    } catch (err) {
      pushEvent(s, sys(`[psm] could not store structured AI output: ${(err as Error).message}`));
      // Keep the raw marker visible in the transcript so malformed content is never lost.
    }
  }
  clean = clean.replace(/```(?:json)?\s*```/gi, "").trim();
  if (clean) pushEvent(s, { t: Date.now(), role: "assistant", text: clean });
}

function trimSessionText(text: string | null | undefined, max = 600): string | null {
  if (!text) return null;
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function sessionActivity(s: AiSession): string {
  if (s.question) return "Waiting for your answer";
  if (!s.log.length) return s.busy ? "Starting" : "No AI session yet";
  const recent = [...s.log].reverse();
  if (s.busy) {
    const tool = recent.find((e) => e.role === "system" && /^→\s+/.test(e.text));
    if (tool) return tool.text.replace(/^→\s+/, "Working: ").slice(0, 160);
    return "Thinking";
  }
  const last = recent[0];
  if (last.role === "user") return "Waiting for the AI to answer";
  if (last.role === "assistant") return "Idle after assistant reply";
  return last.text.slice(0, 160);
}

function sessionStats(s: AiSession) {
  const lastEvent = s.log[s.log.length - 1];
  const lastUser = [...s.log].reverse().find((e) => e.role === "user");
  const lastAssistant = [...s.log].reverse().find((e) => e.role === "assistant");
  return {
    sessionId: s.sessionId,
    sessionShort: short(s.sessionId),
    queueDepth: s.queue.length,
    messages: s.log.filter((e) => e.role === "user").length,
    events: s.log.length,
    lastActive: lastEvent?.t ?? null,
    lastUser: trimSessionText(lastUser?.text),
    lastAssistant: trimSessionText(lastAssistant?.text),
    activity: sessionActivity(s),
  };
}

function statusPayload(s: AiSession) {
  const identity = sessionIdentity(s.name);
  return {
    busy: s.busy,
    role: identity.role,
    project: identity.project,
    engine: s.engine,
    model: s.model,
    effort: s.effort,
    actualModel: s.actualModel,
    hasSession: !!s.sessionId,
    question: s.question,
    ...sessionStats(s),
  };
}

export function aiState(
  name: string,
  fallbackEngine: AiEngine = "claude",
  fallbackModel: AiModel = null,
  fallbackEffort: AiEffort = null,
) {
  const s = sessions.get(name);
  if (!s) {
    const identity = sessionIdentity(name);
    return {
      busy: false,
      role: identity.role,
      project: identity.project,
      engine: fallbackEngine,
      model: normalizeModel(fallbackModel),
      effort: normalizeEffort(fallbackEffort),
      actualModel: null,
      hasSession: false,
      question: null,
      sessionId: null,
      sessionShort: "—",
      queueDepth: 0,
      messages: 0,
      events: 0,
      lastActive: null,
      lastUser: null,
      lastAssistant: null,
      activity: "No AI session yet",
      recent: [],
    };
  }
  return {
    ...statusPayload(s),
    recent: s.log.slice(-80).map((e) => ({ ...e, text: e.text.slice(0, 2000) })),
  };
}

/** Live AI sessions for the Working on lane. Saved history alone does not count. */
export function activeSessions() {
  const out = [];
  for (const [name, s] of sessions) {
    const identity = sessionIdentity(name);
    if (name === WORKSPACE_NAME || identity.role !== "agent") continue;
    const open = s.subscribers.size > 0;
    const queueDepth = s.queue.length;
    const waiting = !!s.question;
    if (!open && !s.busy && !queueDepth && !waiting) continue;
    const lastUser = [...s.log].reverse().find((e) => e.role === "user");
    const lastEvent = s.log[s.log.length - 1];
    out.push({
      name,
      engine: s.engine,
      model: s.model,
      effort: s.effort,
      actualModel: s.actualModel,
      messages: s.log.filter((e) => e.role === "user").length,
      lastActive: lastEvent ? lastEvent.t : 0,
      snippet: (s.question?.questions[0]?.question ?? lastUser?.text ?? s.summary ?? sessionActivity(s)).replace(/\s+/g, " ").slice(0, 140),
      busy: s.busy,
      open,
      queueDepth,
      waiting,
      question: s.question,
    });
  }
  return out.sort((a, b) => b.lastActive - a.lastActive);
}

/** Build the argv for one turn (no shell — args are passed literally). */
export function effortArgs(engine: AiEngine, effort: AiEffort): string[] {
  const value = normalizeEffort(effort);
  if (!value) return [];
  return engine === "codex"
    ? ["-c", `model_reasoning_effort="${value}"`]
    : ["--effort", value];
}

function buildCommand(
  s: AiSession,
  message: string,
  fullAccess: boolean,
  extraContext = "",
): { cmd: string; args: string[] } {
  const rules = [composeSystemRules(s.cwd), extraContext, INTERACTION_RULES]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
  const readOnly = sessionIdentity(s.name).role !== "agent";
  if (s.engine === "codex") {
    const sandbox = readOnly
      ? ["-s", "read-only"]
      : fullAccess
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : ["-s", "workspace-write"];
    const model = s.model ? ["--model", s.model] : [];
    const base = ["--json", "--skip-git-repo-check", ...model, ...effortArgs(s.engine, s.effort), ...sandbox];
    if (s.sessionId) {
      const prompt = `${INTERACTION_RULES}\n\n---\n\n${message}`;
      return { cmd: "codex", args: ["exec", ...base, "resume", s.sessionId, prompt] };
    }
    // codex has no system-prompt flag; fold the house rules into the first turn
    const prompt = rules ? `${rules}\n\n---\n\n${message}` : message;
    return { cmd: "codex", args: ["exec", ...base, prompt] };
  }
  // claude (default)
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (s.model) args.push("--model", s.model);
  args.push(...effortArgs(s.engine, s.effort));
  args.push(
    "--permission-mode",
    readOnly ? "plan" : fullAccess ? "bypassPermissions" : "acceptEdits",
  );
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
  // a usage/rate limit reported mid-stream. the engine emits three statuses:
  // "allowed" (fine), "allowed_warning" (approaching the cap, still allowed),
  // and "rejected" (actually blocked). only "rejected" is a hard limit — a
  // warning must not pause the chat or discard the turn's session id.
  if (ev.type === "rate_limit_event" && ev.rate_limit_info?.status) {
    const info = ev.rate_limit_info;
    const until = info.resetsAt ? info.resetsAt * 1000 : null;
    if (info.status === "rejected") {
      noteLimit(s, "claude", "Claude usage limit reached.", until, true);
    } else if (info.status === "allowed_warning") {
      noteLimit(s, "claude", "Approaching Claude usage limit.", until, false);
    }
  }
  if (ev.type === "system" && ev.subtype === "init") {
    const actual = normalizeModel(ev.model);
    if (actual) {
      s.actualModel = actual;
      broadcast(s, "status", statusPayload(s));
    }
    pushEvent(s, sys(`● session ${short(ev.session_id)} · ${actual || ""} · ${ev.permissionMode || ""}`));
    return;
  }
  if (ev.type === "assistant" && ev.message?.content) {
    for (const b of ev.message.content) {
      if (b.type === "text" && b.text?.trim()) {
        handleAssistantText(s, b.text);
      } else if (b.type === "tool_use") {
        if (/askuserquestion/i.test(String(b.name)) && noteQuestion(s, b.input, b.id)) {
          s.turnHadAssistant = true;
        } else {
          pushEvent(s, sys(`→ ${b.name}(${toolSummary(b.input)})`));
        }
      }
    }
    return;
  }
  if (ev.type === "result") {
    const text = String(ev.result || "");
    if (ev.is_error) pushEvent(s, sys(`[error] ${text || ev.subtype || "failed"}`));
    if (isLimitText(text)) noteLimit(s, "claude", text || "Claude usage limit reached.", parseResetAt(text), true);
    if (Array.isArray(ev.permission_denials) && ev.permission_denials.length)
      pushEvent(s, sys(`⚠ ${ev.permission_denials.length} action(s) blocked — turn on Full access to let the AI run commands`));
  }
}

const isLimitText = (t: string) => /usage limit|rate limit|quota|too many requests|429/i.test(t);

/** Record a limit hit during a turn, tell the open pane, and remember it. */
function noteLimit(s: AiSession, engine: AiEngine, message: string, until: number | null, hard: boolean): void {
  // only a hard limit corrupts the turn — a warning rides along a good reply,
  // so flagging turnLimited would wrongly make finishTurn() drop the session id.
  if (hard) s.turnLimited = true;
  setLimit(engine, message, until, hard);
  broadcast(s, "limit", aiLimit(engine));
}

function extractModel(ev: any): AiModel {
  const direct = normalizeModel(ev?.model ?? ev?.model_id ?? ev?.modelName);
  if (direct) return direct;
  for (const key of ["thread", "turn", "session", "config", "item"]) {
    const nested = ev?.[key];
    const found = normalizeModel(nested?.model ?? nested?.model_id ?? nested?.modelName);
    if (found) return found;
  }
  return null;
}

function noteActualModel(s: AiSession, model: AiModel): void {
  if (!model || model === s.actualModel) return;
  s.actualModel = model;
  broadcast(s, "status", statusPayload(s));
  saveSessionsSoon();
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
  noteActualModel(s, extractModel(ev));
  const item = ev.item || {};
  const itemType = String(item.item_type || item.type || item.name || "");
  if (/request.?user.?input/i.test(itemType)) {
    const input = item.input ?? item.arguments ?? item.questions ?? item;
    if (noteQuestion(s, input, item.id)) {
      s.turnHadAssistant = true;
      return;
    }
  }
  switch (ev.type) {
    case "thread.started":
      if (ev.thread_id) s.sessionId = ev.thread_id;
      pushEvent(s, sys(`● session ${short(s.sessionId)} · ${s.actualModel || s.model || "default"}`));
      break;
    case "error":
      pushEvent(s, sys(`[error] ${ev.message}`));
      if (isLimitText(ev.message || "")) noteLimit(s, "codex", ev.message, parseResetAt(ev.message || ""), true);
      break;
    case "turn.failed": {
      const msg = ev.error?.message || "turn failed";
      pushEvent(s, sys(`[error] ${msg}`));
      if (isLimitText(msg)) noteLimit(s, "codex", msg, parseResetAt(msg), true);
      break;
    }
    case "item.completed": {
      const it = ev.item || {};
      const t = it.item_type || it.type;
      if ((t === "agent_message" || t === "assistant_message") && it.text) {
        handleAssistantText(s, it.text);
      }
      else if (t === "command_execution" && it.command) pushEvent(s, sys(`→ $ ${String(it.command).slice(0, 80)}`));
      else if (t === "file_change" || t === "patch") pushEvent(s, sys(`→ edited files`));
      break;
    }
  }
}

/**
 * Accept one message. If the AI is idle it starts a turn immediately; if a turn
 * is already running the message is queued and dispatched when that turn ends,
 * so the user can keep typing without waiting. Returns right away; output
 * arrives over the SSE stream.
 */
export function send(
  name: string,
  cwd: string,
  engine: AiEngine,
  model: AiModel,
  effort: AiEffort,
  message: string,
  fullAccess: boolean,
  extraContext = "",
): { ok: boolean; error?: string; limited?: boolean; queued?: boolean; question?: boolean } {
  const s = getSession(name, cwd, engine, model, effort);
  if (!message.trim()) return { ok: false, error: "empty message" };
  if (s.question) return { ok: false, question: true, error: "AI is waiting for your answer" };
  // refuse to accept a turn into a known usage limit — it would just fail and
  // risk advancing the session id for nothing
  const limit = aiLimit(engine);
  if (limit?.hard) return { ok: false, limited: true, error: limit.message };

  // show the user's message in the transcript now, in the order it was sent
  pushEvent(s, { t: Date.now(), role: "user", text: message });

  if (s.busy) {
    // a turn is in flight — hold this one and run it when the current turn ends
    s.queue.push({ message, model: s.model, effort: s.effort, fullAccess, extraContext });
    broadcast(s, "queued", { depth: s.queue.length });
    return { ok: true, queued: true };
  }

  startTurn(s, message, fullAccess, extraContext, s.model, s.effort);
  return { ok: true };
}

function newPlanningState(
  project: string,
  plannerEngine: AiEngine,
  plannerModel: AiModel,
  plannerEffort: AiEffort,
): PlanningLoopState {
  const now = Date.now();
  return {
    project,
    active: true,
    stage: "planning",
    planner: { engine: plannerEngine, model: normalizeModel(plannerModel), effort: normalizeEffort(plannerEffort) },
    reviewer: {
      engine: plannerEngine === "claude" ? "codex" : "claude",
      model: null,
      effort: null,
    },
    round: 0,
    maxRounds: 3,
    planId: null,
    revision: null,
    message: `${plannerEngine} is investigating the project`,
    startedAt: now,
    updatedAt: now,
  };
}

export function planningOverview(
  project: string,
  fallbackEngine: AiEngine,
  fallbackModel: AiModel,
  fallbackEffort: AiEffort,
) {
  const state = planningLoops.get(project) ?? null;
  const plannerEngine = state?.planner.engine ?? fallbackEngine;
  const plannerModel = state?.planner.model ?? fallbackModel;
  const plannerEffort = state?.planner.effort ?? fallbackEffort;
  const reviewerEngine = state?.reviewer.engine ?? (fallbackEngine === "claude" ? "codex" : "claude");
  const reviewerModel = state?.reviewer.model ?? null;
  const reviewerEffort = state?.reviewer.effort ?? null;
  return {
    state,
    planner: aiState(planningSessionKey(project, "planner"), plannerEngine, plannerModel, plannerEffort),
    reviewer: aiState(planningSessionKey(project, "reviewer"), reviewerEngine, reviewerModel, reviewerEffort),
  };
}

export function startPlanningLoop(
  project: string,
  cwd: string,
  engine: AiEngine,
  model: AiModel,
  effort: AiEffort,
  brief: string,
): { ok: boolean; error?: string; state?: PlanningLoopState; limited?: boolean } {
  const request = brief.trim();
  if (!request) return { ok: false, error: "describe what the planner should plan" };
  try {
    const previous = planStore.latest(project);
    if (previous?.status === "reviewing") {
      const restored = planStore.markReviewUnavailable(project, previous.id, previous.revision);
      broadcastProjectPlan(project, restored);
    }
    const state = newPlanningState(project, engine, model, effort);
    for (const role of ["planner", "reviewer"] as const) {
      const session = sessions.get(planningSessionKey(project, role));
      if (session?.busy || session?.queue.length) {
        throw new Error(`${role} session is still working`);
      }
    }
    resetConversation(planningSessionKey(project, "planner"), cwd, state.planner.engine, state.planner.model, state.planner.effort);
    resetConversation(planningSessionKey(project, "reviewer"), cwd, state.reviewer.engine, state.reviewer.model, state.reviewer.effort);
    planningLoops.set(project, state);
    broadcastPlanningState(project);
    const result = send(
      planningSessionKey(project, "planner"),
      cwd,
      state.planner.engine,
      state.planner.model,
      state.planner.effort,
      initialPlanningPrompt(project, request),
      false,
      plannerSystemContext("planner"),
    );
    if (!result.ok) {
      failPlanning(project, result.error || "planner could not start");
      return { ...result, state: planningLoops.get(project) };
    }
    return { ok: true, state: planningLoops.get(project) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function sendPlanningMessage(
  project: string,
  cwd: string,
  engine: AiEngine,
  model: AiModel,
  effort: AiEffort,
  message: string,
): { ok: boolean; error?: string; limited?: boolean; queued?: boolean; question?: boolean } {
  const current = planningLoops.get(project);
  if (!current) return startPlanningLoop(project, cwd, engine, model, effort, message);
  if (!current.active) {
    updatePlanningState(project, {
      active: true,
      stage: "planning",
      round: 0,
      message: `${current.planner.engine} is updating the plan from your feedback`,
    });
  }
  return send(
    planningSessionKey(project, "planner"),
    cwd,
    current.planner.engine,
    current.planner.model,
    current.planner.effort,
    message,
    false,
    plannerSystemContext("planner"),
  );
}

export function queuePlanReview(
  project: string,
  cwd: string,
  engine: AiEngine,
  model: AiModel,
  effort: AiEffort,
  plan: ImplementationPlan,
): { ok: boolean; error?: string; limited?: boolean; queued?: boolean; question?: boolean } {
  let state = planningLoops.get(project);
  if (!state) state = newPlanningState(project, engine, model, effort);
  state = {
    ...state,
    active: true,
    stage: "reviewing",
    round: 0,
    planId: plan.id,
    revision: plan.revision,
    message: `${state.reviewer.engine} is reviewing your edited revision`,
    updatedAt: Date.now(),
  };
  planningLoops.set(project, state);
  broadcastPlanningState(project);
  const result = send(
    planningSessionKey(project, "reviewer"),
    cwd,
    state.reviewer.engine,
    state.reviewer.model,
    state.reviewer.effort,
    modelReviewPrompt(plan, 1, state.maxRounds),
    false,
    plannerSystemContext("reviewer"),
  );
  if (!result.ok) failPlanning(project, result.error || "reviewer could not start", plan);
  return result;
}

export function cancelPlanning(project: string): boolean {
  const planner = cancel(planningSessionKey(project, "planner"));
  const reviewer = cancel(planningSessionKey(project, "reviewer"));
  const state = planningLoops.get(project);
  if (state?.active) {
    if (state.planId && state.revision) {
      const plan = planStore.get(project, state.planId);
      if (plan?.status === "reviewing" && plan.revision === state.revision) {
        const restored = planStore.markReviewUnavailable(project, plan.id, plan.revision);
        broadcastProjectPlan(project, restored);
      }
    }
    updatePlanningState(project, {
      active: false,
      stage: "idle",
      message: "Planning stopped",
    });
  }
  return planner || reviewer;
}

export function startFreshAgentSession(
  project: string,
  cwd: string,
  engine: AiEngine,
  model: AiModel,
  effort: AiEffort,
  message: string,
  fullAccess: boolean,
): { ok: boolean; error?: string; limited?: boolean; queued?: boolean; question?: boolean } {
  const limit = aiLimit(engine);
  if (limit?.hard) return { ok: false, error: limit.message, limited: true };
  try {
    resetConversation(project, cwd, engine, model, effort);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return send(project, cwd, engine, model, effort, message, fullAccess);
}

export function answerQuestion(
  name: string,
  cwd: string,
  requestId: string,
  answers: Record<string, unknown>,
  fullAccess: boolean,
  extraContext = "",
): { ok: boolean; error?: string; queued?: boolean } {
  const s = sessions.get(name);
  if (!s?.question) return { ok: false, error: "no question is waiting" };
  if (requestId !== s.question.id) return { ok: false, error: "that question is no longer active" };

  const providerLines = ["Answers to your questions:"];
  const transcriptLines = ["Answered AI question:"];
  for (const question of s.question.questions) {
    const raw = answers[question.id];
    const values = (Array.isArray(raw) ? raw : [raw])
      .map((value) => String(value ?? "").trim().slice(0, 4000))
      .filter(Boolean);
    if (!values.length) return { ok: false, error: `answer required: ${question.header}` };
    const selected = question.multiSelect ? values : values.slice(0, 1);
    providerLines.push(`- ${question.header}: ${selected.join("; ")}`);
    transcriptLines.push(`- ${question.header}: ${question.isSecret ? "[answer hidden from transcript]" : selected.join("; ")}`);
  }
  providerLines.push("Continue the same task using these answers.");

  const request = s.question;
  const message = providerLines.join("\n");
  s.question = null;
  s.cwd = cwd;
  broadcast(s, "question-cleared", { id: request.id });
  pushEvent(s, { t: Date.now(), role: "user", text: transcriptLines.join("\n") });

  const turn = { message, model: s.model, effort: s.effort, fullAccess, extraContext };
  if (s.busy && s.child) {
    s.queue.unshift(turn);
    s.turnPausedForQuestion = true;
    broadcast(s, "queued", { depth: s.queue.length });
    try {
      s.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    saveSessionsSoon();
    return { ok: true, queued: true };
  }

  s.busy = false;
  s.child = null;
  startTurn(s, message, fullAccess, extraContext, s.model, s.effort);
  return { ok: true };
}

/** Spawn the CLI for one turn. The user message has already been logged. */
function startTurn(
  s: AiSession,
  message: string,
  fullAccess: boolean,
  extraContext: string,
  model: AiModel = s.model,
  effort: AiEffort = s.effort,
): void {
  const normalizedModel = normalizeModel(model);
  const normalizedEffort = normalizeEffort(effort);
  if (s.model !== normalizedModel) s.actualModel = null;
  s.model = normalizedModel;
  s.effort = normalizedEffort;
  s.busy = true;
  s.turnPrevSessionId = s.sessionId;
  s.turnHadAssistant = false;
  s.turnStructured = false;
  s.turnLimited = false;
  s.turnPausedForQuestion = false;
  broadcast(s, "status", statusPayload(s));

  const { cmd, args } = buildCommand(s, message, fullAccess, extraContext);
  const handleLine = s.engine === "codex" ? handleCodexLine : handleClaudeLine;

  let child: ChildProcess;
  try {
    // stdin 'ignore' so the CLI doesn't wait on stdin (prompt is an arg)
    child = spawn(cmd, args, { cwd: s.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0" } });
  } catch (err) {
    pushEvent(s, sys(`[psm] could not launch ${s.engine}: ${(err as Error).message}`));
    finishTurn(s);
    return;
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
    pushEvent(s, sys(`[psm] ${s.engine} failed: ${err.message}`));
    finishTurn(s);
  });
  child.on("exit", (code) => {
    if (buf.trim()) handleLine(s, buf);
    const pausedForQuestion = !!s.turnPausedForQuestion;
    if (code && code !== 0 && !pausedForQuestion) pushEvent(s, sys(`[psm] ${s.engine} exited with code ${code}`));
    finishTurn(s);
  });
}

function finishTurn(s: AiSession) {
  s.busy = false;
  s.child = null;
  // a limit-blocked turn produced no real reply — don't let it advance the
  // session id, so the next (post-limit) turn resumes the real conversation
  if (s.turnLimited && !s.turnHadAssistant && s.turnPrevSessionId !== undefined) {
    s.sessionId = s.turnPrevSessionId;
    pushEvent(s, sys("[psm] usage limit — session kept; try again after it resets"));
  }

  // a hard limit just tripped — don't fire queued messages into it; drop them
  // with a notice rather than burning the queue on turns that would only fail
  if (s.queue.length && aiLimit(s.engine)?.hard) {
    const n = s.queue.length;
    s.queue = [];
    pushEvent(s, sys(`[psm] usage limit — ${n} queued message${n > 1 ? "s" : ""} not sent`));
  }

  // A question pauses the whole session. Messages that were already queued
  // stay behind the answer and resume only after that answer turn completes.
  if (s.question) {
    broadcast(s, "status", statusPayload(s));
    broadcast(s, "done", {});
    saveSessions();
    return;
  }

  const identity = sessionIdentity(s.name);
  const loop = identity.project ? planningLoops.get(identity.project) : null;
  if (identity.project && identity.role !== "agent" && loop?.active && !s.turnStructured) {
    const plan = loop.planId ? planStore.get(identity.project, loop.planId) ?? undefined : undefined;
    failPlanning(
      identity.project,
      `${identity.role} finished without a valid ${identity.role === "planner" ? "<psm-plan>" : "<psm-plan-review>"} marker`,
      plan,
    );
  }

  // messages queued while this turn ran — start the next one and stay busy
  // rather than flipping the UI to idle and back
  const next = s.queue.shift();
  if (next) {
    saveSessions();
    startTurn(s, next.message, next.fullAccess, next.extraContext, next.model, next.effort);
    return;
  }

  broadcast(s, "status", statusPayload(s));
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

// Cached recap only: metadata sync must never launch an AI process.
export function cachedRecap(name: string): string | null {
  return sessions.get(name)?.summary ?? null;
}

// Restore a cloud recap without importing transcripts, provider ids, or credentials.
export function restoreCachedRecap(name: string, value: unknown): void {
  const summary = typeof value === "string" ? value.trim().slice(0, 20_000) : "";
  if (!summary) return;
  let session = sessions.get(name);
  if (!session) {
    session = {
      name, cwd: "", engine: "claude", model: null, effort: null, actualModel: null, sessionId: null,
      busy: false, child: null, log: [], subscribers: new Set(), summary: null,
      summaryAt: 0, queue: [], question: null,
    };
    sessions.set(name, session);
  }
  session.summary = summary;
  session.summaryAt = session.log.length;
  saveSessionsSoon();
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
  // drop anything queued behind this turn before we kill it — otherwise the
  // child's exit handler would immediately dispatch the next queued message,
  // defeating the Stop the user just asked for
  const dropped = s.queue.length;
  s.queue = [];
  try {
    s.child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  pushEvent(s, sys(dropped ? `[psm] turn cancelled — ${dropped} queued message${dropped > 1 ? "s" : ""} cleared` : "[psm] turn cancelled"));
  return true;
}

/** Stop live AI work and ask every open pane for this project to detach. */
export function stopSession(name: string): { cancelled: boolean; queuedCleared: number; questionCleared: boolean } {
  const s = sessions.get(name);
  if (!s) return { cancelled: false, queuedCleared: 0, questionCleared: false };

  const queuedCleared = s.queue.length;
  const questionCleared = !!s.question;
  const questionId = s.question?.id;
  s.queue = [];
  s.question = null;
  const cancelled = !!s.child;
  s.turnPausedForQuestion = cancelled;
  if (s.child) {
    try {
      s.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  if (questionCleared) broadcast(s, "question-cleared", { id: questionId });
  if (cancelled || queuedCleared || questionCleared) {
    pushEvent(
      s,
      sys(
        queuedCleared
          ? `[psm] stopped working — ${queuedCleared} queued message${queuedCleared > 1 ? "s" : ""} cleared`
          : "[psm] stopped working",
      ),
    );
  }
  broadcast(s, "working-stopped", {});
  saveSessionsSoon();
  return { cancelled, queuedCleared, questionCleared };
}

/** Attach an SSE response: replay transcript, then stream live. */
export function subscribeAi(
  res: Response,
  name: string,
  cwd: string,
  engine: AiEngine,
  model: AiModel,
  effort: AiEffort,
): void {
  const s = getSession(name, cwd, engine, model, effort);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  for (const ev of s.log) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  res.write(`event: status\ndata: ${JSON.stringify(statusPayload(s))}\n\n`);
  const identity = sessionIdentity(name);
  if (identity.project && identity.role !== "agent") {
    const planning = planningLoops.get(identity.project);
    if (planning) res.write(`event: planning\ndata: ${JSON.stringify({ state: planning })}\n\n`);
  }
  if (s.summary) // show the last recap instantly; the client refreshes it if stale
    res.write(`event: recap\ndata: ${JSON.stringify({ summary: s.summary })}\n\n`);
  const limit = aiLimit(engine); // surface a usage limit before the user types anything
  if (limit) res.write(`event: limit\ndata: ${JSON.stringify(limit)}\n\n`);

  s.subscribers.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(ping);
    s.subscribers.delete(res);
  });
}
