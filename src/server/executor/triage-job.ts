/**
 * What the executor does with a claimed `triage` job: find the project on this
 * machine, build its context pack, run triage, and turn the result into the
 * outcome the hub expects. Every dependency is passed in, so the end-to-end
 * test can drive it with a fake hub and a fake engine.
 */
import { buildContextPack, type OpenIntake } from "../triage/context.ts";
import { runTriage, type TriageCache, type TriageEngine, type TriageStep } from "../triage/run.ts";
import type { ExecutorJob, JobOutcome } from "./client.ts";

export interface TriageJobDeps {
  /** The local project with this `prj_` id, or null when it is not on this machine. */
  findProject: (projectId: string) => { name: string; path: string } | null;
  /** The project's other intake, best effort: triage still runs without it. */
  listIntake?: (projectId: string) => Promise<OpenIntake[]>;
  /** The stored AI session recap for a project name, if psm has one. */
  recap?: (projectName: string) => string | null;
  engine?: TriageEngine;
  cache?: TriageCache | null;
  timeoutMs?: number;
  /** Told what the job is doing, for the cockpit's activity view. */
  onStep?: (job: ExecutorJob, step: JobStep) => void;
}

/** A triage step, or the context psm assembled before it. */
export type JobStep = TriageStep | { type: "context"; bytes: number; truncated: boolean; openIntake: number; project: string };

export function triageJobRunner(deps: TriageJobDeps) {
  return async (job: ExecutorJob, signal: AbortSignal): Promise<JobOutcome> => {
    const project = deps.findProject(job.projectId);
    if (!project) {
      return { status: "failed", error: `project ${job.projectId} (${job.projectName}) is not on this executor` };
    }
    let openIntake: OpenIntake[] = [];
    try {
      openIntake = (await deps.listIntake?.(job.projectId)) || [];
    } catch {
      /* context, not a precondition */
    }
    const pack = buildContextPack({
      projectDir: project.path,
      projectName: project.name,
      intakeId: job.intakeId,
      openIntake,
      recap: deps.recap?.(project.name) ?? null,
    });
    try {
      deps.onStep?.(job, { type: "context", bytes: pack.bytes, truncated: pack.truncated, openIntake: openIntake.length, project: project.name });
    } catch {
      /* watching must never change the outcome */
    }
    const result = await runTriage({
      projectDir: project.path,
      projectName: project.name,
      intakeText: job.text,
      pack,
      engine: deps.engine,
      cache: deps.cache,
      timeoutMs: deps.timeoutMs,
      signal,
      onStep: (step) => deps.onStep?.(job, step),
    });
    return result.ok ? { status: "triaged", verdict: result.verdict } : { status: "failed", error: result.reason };
  };
}
