/**
 * What the executor does with a claimed `triage` job: find the project on this
 * machine, build its context pack, run triage, and turn the result into the
 * outcome the hub expects. Every dependency is passed in, so the end-to-end
 * test can drive it with a fake hub and a fake engine.
 */
import { buildContextPack, type OpenIntake } from "../triage/context.ts";
import { runTriage, type TriageCache, type TriageEngine } from "../triage/run.ts";
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
}

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
    const result = await runTriage({
      projectDir: project.path,
      projectName: project.name,
      intakeText: job.text,
      pack,
      engine: deps.engine,
      cache: deps.cache,
      timeoutMs: deps.timeoutMs,
      signal,
    });
    return result.ok ? { status: "triaged", verdict: result.verdict } : { status: "failed", error: result.reason };
  };
}
