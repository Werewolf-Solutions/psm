/**
 * Applying an infrastructure plan under a standing rule.
 *
 * The plan still has to be exactly the plan PSM built: the approval binds its
 * id, revision and digest like an operator's review does, and it is recorded
 * with the rule and the policy revision that decided it. What a rule cannot do
 * is claim a review nobody made: a plan that asks for acknowledgements (every
 * production plan asks "I reviewed this exact production target…") is covered
 * only by a rule the operator scoped to exactly that environment.
 */
import type { AgentPermissionStore, PermissionProject } from "../agent-permissions.ts";
import type { DeploymentStore } from "./store.ts";

export interface StandingApprovalDeps {
  permissions: AgentPermissionStore;
  project: (projectId: string) => PermissionProject;
  store: DeploymentStore;
  enqueue: (runId: string) => unknown;
  agentId: () => string;
  now?: () => number;
}

export async function approveByStandingRule(deps: StandingApprovalDeps, input: { projectId: string; environmentId: string; planId: string }): Promise<{ runId: string; reason: string } | null> {
  const plan = deps.store.getPlan(input.planId);
  const now = deps.now?.() ?? Date.now();
  if (plan.blocked || plan.projectId !== input.projectId || plan.environmentId !== input.environmentId || plan.expiresAt <= now) return null;
  const snapshot = deps.permissions.snapshot(deps.project(input.projectId));
  const context = { environmentId: input.environmentId };
  const decision = deps.permissions.decide(snapshot, "deploy.approve", context);
  if (decision.effect !== "allow" || !decision.rule) return null;
  if (plan.requiredAcknowledgementIds.length && decision.rule.scope.environmentId !== input.environmentId) return null;
  deps.permissions.check(snapshot, "deploy.approve", context); // consumes a one-time rule
  const result = deps.store.approveAndQueue({
    planId: plan.planId,
    planRevision: plan.revision,
    planDigest: plan.digest,
    risk: plan.risk,
    actorKind: "local-operator",
    // Which rule, at which policy revision, stood in for the review.
    actorSubject: `policy:${decision.rule.id}@r${snapshot.revision}`,
    agentId: deps.agentId(),
    origin: "local",
    acknowledgementIds: plan.requiredAcknowledgementIds,
    approvedAt: now,
    expiresAt: plan.expiresAt,
  });
  if (result.created) await deps.enqueue(result.run.runId);
  return { runId: result.run.runId, reason: decision.reason };
}
