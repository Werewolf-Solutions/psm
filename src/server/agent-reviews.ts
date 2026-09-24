/**
 * Operator reviews for operations an Ask rule holds back.
 *
 * A review records the exact operation (permission, scope, a readable
 * summary and a digest of its arguments). Approving it adds an Allow rule —
 * once for exactly that operation, for the rest of the task, or standing —
 * and the agent retries the same tool. Because the rule only adds authority,
 * the running turn stays valid; nothing is executed on the agent's behalf by
 * the review itself, so the retry goes through the same checks as any call.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { AgentPermissionStore, PermissionProject, PermissionSnapshot } from "./agent-permissions.ts";
import type { DecisionContext, PolicyScope } from "./agent-policy.ts";
import { db } from "./db.ts";

export type ReviewAnswer = "once" | "task" | "standing" | "reject";

export interface OperationReview {
  kind: "operation";
  id: string;
  projectId: string;
  checkout: string;
  permission: string;
  context: DecisionContext;
  /** What the agent asked to do, in words an operator can judge. */
  summary: string;
  reason: string;
  task: string | null;
  state: "pending" | "approved" | "rejected" | "expired";
  answer?: ReviewAnswer;
  actor?: string;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
}

const REVIEW_TTL_MS = 30 * 60_000;

export class OperationReviews {
  constructor(private readonly store: AgentPermissionStore, private readonly database: () => DatabaseSync = db) {}

  #save(review: OperationReview): OperationReview {
    this.database().prepare("INSERT INTO agent_tool_requests(id, project_id, document) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document")
      .run(review.id, review.projectId, JSON.stringify(review));
    return review;
  }

  #get(id: string): OperationReview {
    const row = this.database().prepare("SELECT document FROM agent_tool_requests WHERE id = ?").get(id) as { document: string } | undefined;
    const review = row ? JSON.parse(row.document) : null;
    if (!review || review.kind !== "operation") throw new Error("Review not found.");
    return review;
  }

  /** Record a held-back operation. An identical pending review is reused, not duplicated. */
  request(snapshot: PermissionSnapshot, permission: string, context: DecisionContext, summary: string, reason: string, now = Date.now()): OperationReview {
    const pending = this.list(snapshot.project.id).find((review) => review.state === "pending" && review.expiresAt > now
      && review.checkout === snapshot.project.path && review.permission === permission && JSON.stringify(review.context) === JSON.stringify(context));
    if (pending) return pending;
    return this.#save({
      kind: "operation", id: `rev_${randomUUID()}`, projectId: snapshot.project.id, checkout: snapshot.project.path, permission, context,
      summary: summary.slice(0, 2_000), reason, task: snapshot.task ?? null, state: "pending", createdAt: now, expiresAt: now + REVIEW_TTL_MS,
    });
  }

  list(projectId: string): OperationReview[] {
    return (this.database().prepare("SELECT document FROM agent_tool_requests WHERE project_id = ? ORDER BY rowid DESC LIMIT 200").all(projectId) as { document: string }[])
      .map((row) => JSON.parse(row.document))
      .filter((review) => review.kind === "operation")
      .map((review: OperationReview) => review.state === "pending" && review.expiresAt <= Date.now() ? { ...review, state: "expired" as const } : review);
  }

  /**
   * The operator's answer. "once" binds the allow to this exact operation;
   * "task" to the managed session that asked; "standing" to the operation's
   * scope (its environment, connection or tool), never wider than that.
   */
  decide(project: PermissionProject, id: string, answer: ReviewAnswer, actor: string, now = Date.now()): OperationReview {
    const review = this.#get(id);
    if (review.projectId !== project.id) throw new Error("Review is outside this project.");
    if (review.state !== "pending" || review.expiresAt <= now) throw new Error("This review was already answered or has expired. The agent can ask again.");
    if (!["once", "task", "standing", "reject"].includes(answer)) throw new Error("Invalid review answer.");
    if (answer === "reject") return this.#save({ ...review, state: "rejected", answer, actor, decidedAt: now });
    // "task" and "standing" drop the exact-operation binding; "task" re-adds the session below.
    const scope: PolicyScope = answer === "once" ? { ...review.context } : Object.fromEntries(Object.entries(review.context).filter(([key]) => key !== "operation" && key !== "task"));
    if (answer === "task" && !review.task) throw new Error("This request did not come from a task; approve it once or always.");
    const revision = this.store.snapshot(project).revision;
    this.store.addRule(project, {
      permission: review.permission, effect: "allow", scope,
      duration: answer === "once" ? { kind: "once" } : answer === "task" ? { kind: "task", task: review.task! } : { kind: "standing" },
      source: `review:${review.id}`, actor,
    }, revision);
    return this.#save({ ...review, state: "approved", answer, actor, decidedAt: now });
  }
}
