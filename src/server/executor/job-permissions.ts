/**
 * What one implement job may do: the grant you gave by clicking Go.
 *
 * The managed tools (agent-repository-tools.ts, agent-task-runner.ts) ask a
 * store `check(snapshot, permission)` before every operation. A job uses this
 * checker instead of the project's stored grants: the same fixed set for every
 * job, held only for that job, inside its own clone — and nothing is written
 * to the project's Agent permissions. Workspace deny rules still apply, so a
 * workspace that forbids something forbids it for jobs too.
 *
 * Never allowed, whatever the tool list says: push, fetch, merge, switching
 * branches, server commands, attached integrations, deploy approvals.
 */
import { decide, type Decision, type DecisionContext, type PolicyRule } from "../agent-policy.ts";
import { PermissionError, type AgentPermission, type PermissionSnapshot } from "../agent-permissions.ts";

export const IMPLEMENT_GRANTS: readonly AgentPermission[] = Object.freeze([
  "repo.read",
  "repo.edit",
  "repo.delete",
  "test.run",
  "script.run",
  "pkg.install",
  "git.commit",
  "git.branch",
]);

export class JobPermissions {
  readonly #rules: PolicyRule[];

  constructor(
    readonly jobId: string,
    /** The real store's workspace rules, so a workspace deny still holds. */
    private readonly workspaceRules: (workspaceId?: string) => PolicyRule[],
    grants: readonly AgentPermission[] = IMPLEMENT_GRANTS,
    private readonly now: () => number = Date.now,
  ) {
    this.#rules = grants.map((permission) => ({
      id: `job:${jobId}:${permission}`,
      permission,
      effect: "allow",
      scope: {},
      expiresAt: null,
      remainingUses: null,
      source: `job:${jobId}`,
      actor: "go",
      at: 0,
    }));
  }

  decide(snapshot: PermissionSnapshot, permission: string, context: DecisionContext = {}): Decision {
    return decide({ permission, context, rules: this.#rules, workspaceRules: this.workspaceRules(snapshot.project.workspaceId), now: this.now() });
  }

  /** The one method the managed tools call. Anything not granted is refused outright: a job has no operator to ask mid-run. */
  check(snapshot: PermissionSnapshot, permission: AgentPermission, context: DecisionContext = {}): Decision {
    const decision = this.decide(snapshot, permission, context);
    if (decision.effect !== "allow") {
      throw new PermissionError(
        decision.workspace
          ? `${decision.reason} Implement jobs follow workspace policy.`
          : `Implement jobs may not use ${permission}. The job works only inside its own clone and never pushes, fetches, merges or runs server commands.`,
      );
    }
    return decision;
  }
}

/** The snapshot a job's tools act on: the project, pointed at the job's clone. */
export function jobSnapshot(project: { id: string; name: string; workspaceId?: string }, clonePath: string, jobId: string): PermissionSnapshot {
  return {
    project: { id: project.id, name: project.name, path: clonePath, ...(project.workspaceId ? { workspaceId: project.workspaceId } : {}) },
    revision: 0,
    grants: Object.fromEntries(IMPLEMENT_GRANTS.map((permission) => [permission, { granted: true, actor: "go", at: 0 }])),
    task: `job:${jobId}`,
  };
}

/**
 * A project a job's preview starts as a backend service: your real checkout,
 * read and started only. PSM copies its tracked files (never .env) into the
 * preview sandbox; the agent gets no tools in it.
 */
export function previewServiceSnapshot(project: { id: string; name: string; path: string; workspaceId?: string }, jobId: string): PermissionSnapshot {
  return {
    project: { id: project.id, name: project.name, path: project.path, ...(project.workspaceId ? { workspaceId: project.workspaceId } : {}) },
    revision: 0,
    grants: { "repo.read": { granted: true, actor: "go", at: 0 }, "script.run": { granted: true, actor: "go", at: 0 } },
    task: `job:${jobId}:preview-service`,
  };
}
