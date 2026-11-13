/**
 * Start and stop runbook units (P18 R4): one process per unit, in dependency
 * order, across projects.
 *
 * A unit's dependencies come from the runbook (`dependsOn`, detected or
 * curated) and from proxies: a client that proxies to :3000 needs whatever
 * linked project serves :3000. A dependency that is already up — started by
 * psm or not — is reused, never started twice. A unit whose own port is taken
 * by something else is refused, not retried. Only service, agent and task
 * units start here; data, deploy, install and MCP units have their own flows.
 */
import net from "node:net";
import path from "node:path";

import { STARTABLE, type Runbook, type RunbookUnit, type UnitRef } from "../runbook.ts";
import type { ProcKind, StartOptions } from "./procs.ts";

export const unitKind = (id: string): ProcKind => `unit:${id}`;
const UNIT_KIND = /^unit:[A-Za-z0-9._@/:-]{1,160}$/;
export const isUnitKind = (value: unknown): value is ProcKind => typeof value === "string" && UNIT_KIND.test(value) && !value.includes("::");

export interface UnitTarget {
  project: string;
  unit: string;
}

export type UnitOutcome =
  | "started"
  | "reused" // psm already runs this unit
  | "external" // a dependency whose port something else already serves
  | "blocked" // its own port is taken by something psm did not start for it
  | "not-startable"
  | "unknown"
  | "skipped" // a dependency failed
  | "failed"; // exited before it was ready, or never became ready

export interface UnitResult {
  project: string;
  unit: string;
  outcome: UnitOutcome;
  port: number | null;
  ready: boolean;
  /** Why it was started: "requested", or the unit that needed it. */
  reason: string;
  message?: string;
}

export interface UnitDeps {
  project: (name: string) => { name: string; path: string } | null;
  projects: () => string[];
  runbook: (name: string) => Runbook | null;
  status: (name: string, kind: ProcKind) => { status: string; port: number | null } | null;
  start: (name: string, kind: ProcKind, command: string, cwd: string, options: StartOptions) => void;
  stop: (name: string, kind: ProcKind) => boolean;
  portOpen: (port: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
}

/** Is anything listening on localhost:port (v4 or v6)? */
export async function portOpen(port: number): Promise<boolean> {
  const tryHost = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const done = (open: boolean) => {
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(400, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  return (await tryHost("127.0.0.1")) || (await tryHost("::1"));
}

const key = (target: UnitTarget) => `${target.project}\0${target.unit}`;

interface Step extends UnitTarget {
  definition: RunbookUnit | null;
  reason: string;
  dependency: boolean;
  needs: string[];
}

/** The service in another linked project that serves `port`, preferring a dev script. */
function portOwner(deps: UnitDeps, port: number, exclude: string): UnitTarget | null {
  const candidates: Array<{ target: UnitTarget; score: number }> = [];
  for (const name of deps.projects()) {
    if (name === exclude) continue;
    const runbook = deps.runbook(name);
    for (const unit of runbook?.units ?? []) {
      if (unit.kind !== "service" || unit.port !== port) continue;
      const score = (unit.script === "dev" ? 2 : 0) + (runbook!.defaultUnits.includes(unit.id) ? 1 : 0);
      candidates.push({ target: { project: name, unit: unit.id }, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.target ?? null;
}

/** Dependencies first, each unit once. A cycle is cut where it closes. */
export function planUnits(deps: UnitDeps, targets: UnitTarget[]): Step[] {
  const steps = new Map<string, Step>();
  const visiting = new Set<string>();
  const visit = (target: UnitTarget, reason: string, dependency: boolean) => {
    const id = key(target);
    if (steps.has(id)) {
      if (!dependency) steps.get(id)!.dependency = false;
      return;
    }
    if (visiting.has(id)) return;
    visiting.add(id);
    const runbook = deps.runbook(target.project);
    const definition = runbook?.units.find((unit) => unit.id === target.unit) ?? null;
    const needs: UnitTarget[] = [];
    if (definition) {
      for (const ref of definition.dependsOn) needs.push({ project: ref.project ?? target.project, unit: ref.unit });
      // A proxy this project does not serve itself points at another linked project.
      for (const proxy of runbook!.proxies.filter((entry) => entry.unit === definition.id)) {
        const local = runbook!.units.some((unit) => unit.kind === "service" && unit.port === proxy.port);
        const covered = needs.some((need) => deps.runbook(need.project)?.units.find((unit) => unit.id === need.unit)?.port === proxy.port);
        if (local || covered) continue;
        const owner = portOwner(deps, proxy.port, target.project);
        if (owner) needs.push(owner);
      }
    }
    const label = `${target.project} ${target.unit}`;
    for (const need of needs) visit(need, `needed by ${label}`, true);
    visiting.delete(id);
    steps.set(id, { ...target, definition, reason, dependency, needs: needs.map(key) });
  };
  for (const target of targets) visit(target, "requested", false);
  return [...steps.values()];
}

async function waitReady(deps: UnitDeps, step: Step): Promise<{ ready: boolean; message?: string }> {
  const kind = unitKind(step.unit);
  const port = step.definition?.port ?? null;
  const deadline = (deps.readyTimeoutMs ?? 45_000);
  if (step.definition?.kind === "task") return { ready: true };
  for (let waited = 0; waited <= deadline; waited += 500) {
    const state = deps.status(step.project, kind);
    if (!state || state.status !== "running") return { ready: false, message: "exited before it was ready" };
    if (!port) {
      if (waited >= 1_500) return { ready: true };
    } else if (await deps.portOpen(port)) return { ready: true };
    await deps.sleep(500);
  }
  return { ready: false, message: `nothing answered on :${port} after ${Math.round(deadline / 1000)} s` };
}

/** Start targets and what they need, in order. Waits for each dependency to be ready. */
export async function startUnits(deps: UnitDeps, targets: UnitTarget[]): Promise<UnitResult[]> {
  const results = new Map<string, UnitResult>();
  for (const step of planUnits(deps, targets)) {
    const port = step.definition?.port ?? null;
    const base = { project: step.project, unit: step.unit, port, reason: step.reason };
    const project = deps.project(step.project);
    const failedNeed = step.needs.map((need) => results.get(need)).find((result) => result && !result.ready);
    if (!project || !step.definition) {
      results.set(key(step), { ...base, outcome: "unknown", ready: false, message: project ? `${step.project} has no script ${step.unit}` : `${step.project} is not a linked project` });
      continue;
    }
    if (!STARTABLE.has(step.definition.kind)) {
      results.set(key(step), { ...base, outcome: "not-startable", ready: false, message: `${step.definition.kind} scripts do not start from here` });
      continue;
    }
    if (failedNeed) {
      results.set(key(step), { ...base, outcome: "skipped", ready: false, message: `${failedNeed.project} ${failedNeed.unit} is not ready` });
      continue;
    }
    const kind = unitKind(step.unit);
    if (deps.status(step.project, kind)?.status === "running") {
      results.set(key(step), { ...base, outcome: "reused", ready: true });
      continue;
    }
    if (port && (await deps.portOpen(port))) {
      results.set(key(step), step.dependency
        ? { ...base, outcome: "external", ready: true, message: `:${port} is already served` }
        : { ...base, outcome: "blocked", ready: false, message: `:${port} is in use by another process (one psm started before it restarted keeps running; stop it, or use it as it is)` });
      continue;
    }
    const setEnv = port && step.definition.sources.port === "curated" ? { PORT: String(port) } : undefined;
    deps.start(step.project, kind, step.definition.command, path.join(project.path, step.definition.folder), { setEnv });
    const ready = await waitReady(deps, step);
    results.set(key(step), { ...base, outcome: ready.ready ? "started" : "failed", ready: ready.ready, message: ready.message });
  }
  return [...results.values()];
}

/**
 * Stop targets. A unit another running unit still needs keeps running unless
 * `force`, which stops those dependents too.
 */
export function stopUnits(deps: UnitDeps, targets: UnitTarget[], running: UnitTarget[], force = false): Array<UnitTarget & { stopped: boolean; keptFor?: string[] }> {
  const stopping = new Set(targets.map(key));
  const out: Array<UnitTarget & { stopped: boolean; keptFor?: string[] }> = [];
  const others = running.filter((target) => !stopping.has(key(target)));
  const needers = (target: UnitTarget) =>
    others.filter((other) => planUnits(deps, [other]).some((step) => key(step) === key(target) && step.dependency));
  if (force) {
    for (const target of targets) for (const dependent of needers(target)) out.push({ ...dependent, stopped: deps.stop(dependent.project, unitKind(dependent.unit)) });
  }
  for (const target of targets) {
    const keptFor = force ? [] : needers(target).map((dependent) => `${dependent.project} ${dependent.unit}`);
    if (keptFor.length) out.push({ ...target, stopped: false, keptFor });
    else out.push({ ...target, stopped: deps.stop(target.project, unitKind(target.unit)) });
  }
  return out;
}

/**
 * What psm's MCP server needs to start and stop units (P18 R6), built on the
 * same planner and runner the cockpit uses. Policy — scope, grants, Full
 * resources, startable kinds — is checked in mcp/operations.ts from what this
 * returns; nothing here decides who may start what.
 */
export function mcpUnitControl(options: {
  deps: () => UnitDeps;
  projectId: (name: string) => string | null;
  grant: (projectId: string, unit: RunbookUnit) => "allowed" | "not-allowed" | "changed";
  resources: (project: string, folder: string) => Array<{ label: string; level: string | null }>;
  stack: (id: string) => { title: string; units: UnitTarget[] } | null;
  running: () => UnitTarget[];
}) {
  return {
    plan: (targets: UnitTarget[]) => planUnits(options.deps(), targets).map((step) => {
      const projectId = options.projectId(step.project);
      return {
        project: step.project,
        unit: step.unit,
        known: !!step.definition,
        kind: step.definition?.kind ?? null,
        costs: step.definition?.costs ?? false,
        reason: step.reason,
        grant: projectId && step.definition ? options.grant(projectId, step.definition) : ("not-allowed" as const),
        resources: step.definition ? options.resources(step.project, step.definition.folder) : [],
      };
    }),
    start: (targets: UnitTarget[]) => startUnits(options.deps(), targets),
    stop: (targets: UnitTarget[], force: boolean) => stopUnits(options.deps(), targets, options.running(), force),
    stack: options.stack,
    running: options.running,
  };
}

export function parseTargets(value: unknown): UnitTarget[] {
  if (!Array.isArray(value) || !value.length || value.length > 30) throw new Error("Name 1-30 units as { project, unit }.");
  return value.map((entry) => {
    const { project, unit } = (entry ?? {}) as Record<string, unknown>;
    if (typeof project !== "string" || !project || project.length > 200) throw new Error("Each unit needs its project.");
    if (typeof unit !== "string" || !isUnitKind(`unit:${unit}`)) throw new Error(`Invalid unit: ${String(unit)}`);
    return { project, unit };
  });
}

export type { UnitRef };
