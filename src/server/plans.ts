import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  ImplementationPlan,
  PlanPhase,
  PlanReview,
  PlanReviewIssue,
  PlanStep,
} from "../types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..", "..", ".psm-plans");
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class PlanValidationError extends Error {}
export class PlanConflictError extends Error {}
export class PlanNotFoundError extends Error {}

function requiredText(value: unknown, label: string, max: number): string {
  const text = String(value ?? "").trim();
  if (!text) throw new PlanValidationError(`${label} is required`);
  return text.slice(0, max);
}

function optionalText(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function safeSegment(value: unknown, label: string): string {
  const segment = String(value ?? "");
  if (!SAFE_SEGMENT.test(segment)) {
    throw new PlanValidationError(`invalid ${label}`);
  }
  return segment;
}

function generatedId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function normalizedId(value: unknown, prefix: string, seen: Set<string>): string {
  let id = String(value ?? "").trim();
  if (!SAFE_SEGMENT.test(id) || seen.has(id)) id = generatedId(prefix);
  seen.add(id);
  return id;
}

interface NormalizeBudget {
  steps: number;
}

function normalizeStep(
  value: unknown,
  seen: Set<string>,
  budget: NormalizeBudget,
  depth = 0,
): PlanStep {
  if (!value || typeof value !== "object") {
    throw new PlanValidationError("every plan step must be an object");
  }
  if (budget.steps >= 500) throw new PlanValidationError("a plan can contain at most 500 steps");
  if (depth > 5) throw new PlanValidationError("plan steps can nest at most five levels");
  budget.steps += 1;
  const raw = value as Record<string, unknown>;
  const children = Array.isArray(raw.children) ? raw.children : [];
  return {
    id: normalizedId(raw.id, "step", seen),
    text: requiredText(raw.text, "step text", 2_000),
    done: raw.done === true,
    ...(raw.blocked === true ? { blocked: true } : {}),
    children: children.map((child) => normalizeStep(child, seen, budget, depth + 1)),
  };
}

function normalizePhases(value: unknown): PlanPhase[] {
  if (!Array.isArray(value) || !value.length) {
    throw new PlanValidationError("a plan must contain at least one phase");
  }
  if (value.length > 100) throw new PlanValidationError("a plan can contain at most 100 phases");
  const seen = new Set<string>();
  const budget = { steps: 0 };
  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new PlanValidationError("every phase must be an object");
    }
    const raw = item as Record<string, unknown>;
    const steps = Array.isArray(raw.steps) ? raw.steps : [];
    return {
      id: normalizedId(raw.id, "phase", seen),
      title: requiredText(raw.title, "phase title", 300),
      summary: optionalText(raw.summary, 4_000),
      steps: steps.map((step) => normalizeStep(step, seen, budget)),
    };
  });
}

function allSteps(steps: PlanStep[]): PlanStep[] {
  return steps.flatMap((step) => [step, ...allSteps(step.children)]);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const PLAN_STATUSES = new Set([
  "draft", "edited", "reviewing", "ai-reviewed", "confirmed", "in-progress", "done",
]);

function positiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new PlanValidationError(label + " must be a positive integer");
  }
  return number;
}

function timestamp(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new PlanValidationError(label + " must be a valid timestamp");
  }
  return number;
}

export class PlanStore {
  constructor(readonly root = DEFAULT_ROOT) {}

  private projectDir(project: string): string {
    return path.join(this.root, safeSegment(project, "project name"));
  }

  private planFile(project: string, id: string): string {
    return path.join(this.projectDir(project), `${safeSegment(id, "plan id")}.json`);
  }

  private write(plan: ImplementationPlan): ImplementationPlan {
    const dir = this.projectDir(plan.project);
    fs.mkdirSync(dir, { recursive: true });
    const file = this.planFile(plan.project, plan.id);
    const temp = path.join(
      dir,
      `.${plan.id}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
    );
    fs.writeFileSync(temp, JSON.stringify(plan, null, 2) + os.EOL, { mode: 0o600 });
    fs.renameSync(temp, file);
    return clone(plan);
  }

  list(project: string): ImplementationPlan[] {
    const dir = this.projectDir(project);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
    } catch {
      return [];
    }
    const plans: ImplementationPlan[] = [];
    for (const file of files) {
      try {
        const plan = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        if (plan?.project === project && SAFE_SEGMENT.test(plan?.id)) plans.push(plan);
      } catch {
        // A corrupt plan is isolated to that file; callers can still use the rest.
      }
    }
    return plans.sort((a, b) => b.updatedAt - a.updatedAt || b.revision - a.revision);
  }

  latest(project: string): ImplementationPlan | null {
    return this.list(project)[0] ?? null;
  }

  get(project: string, id: string): ImplementationPlan | null {
    const file = this.planFile(project, id);
    try {
      const plan = JSON.parse(fs.readFileSync(file, "utf8")) as ImplementationPlan;
      return plan.project === project && plan.id === id ? plan : null;
    } catch {
      return null;
    }
  }

  ingestAiPlan(project: string, value: unknown): ImplementationPlan {
    if (!value || typeof value !== "object") throw new PlanValidationError("plan must be an object");
    const raw = value as Record<string, unknown>;
    const candidateId = String(raw.id ?? "");
    const id = SAFE_SEGMENT.test(candidateId) ? candidateId : generatedId("plan");
    const previous = this.get(project, id);
    if (previous?.status === "reviewing") {
      throw new PlanConflictError(
        "the AI returned a replacement plan while a human revision was under review; use a plan review marker",
      );
    }
    if (
      previous?.confirmedRevision != null &&
      ["confirmed", "in-progress", "done"].includes(previous.status)
    ) {
      throw new PlanConflictError(
        "the confirmed plan revision is immutable; emit a new plan id for changed scope",
      );
    }
    const now = Date.now();
    return this.write({
      id,
      project,
      title: requiredText(raw.title, "plan title", 500),
      status: "draft",
      revision: (previous?.revision ?? 0) + 1,
      phases: normalizePhases(raw.phases),
      notes: optionalText(raw.notes, 10_000),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    });
  }

  // Import a cloud copy without weakening the local plan state machine.
  // Newer unconfirmed drafts use last-write-wins. Once a revision is confirmed,
  // another device may only advance that exact confirmed revision.
  importSnapshot(project: string, value: unknown): ImplementationPlan {
    if (!value || typeof value !== "object") {
      throw new PlanValidationError("cloud plan must be an object");
    }
    const raw = value as Record<string, unknown>;
    const id = safeSegment(raw.id, "plan id");
    const status = String(raw.status ?? "");
    if (!PLAN_STATUSES.has(status)) throw new PlanValidationError("cloud plan has an invalid status");
    const revision = positiveInteger(raw.revision, "cloud plan revision");
    const confirmedRevision = raw.confirmedRevision == null
      ? undefined
      : positiveInteger(raw.confirmedRevision, "confirmed revision");
    if (confirmedRevision != null && confirmedRevision !== revision) {
      throw new PlanValidationError("confirmed revision must match the plan revision");
    }
    if (["confirmed", "in-progress", "done"].includes(status) && confirmedRevision == null) {
      throw new PlanValidationError("confirmed cloud plan state requires a confirmed revision");
    }
    const createdAt = timestamp(raw.createdAt, "cloud plan createdAt");
    const updatedAt = timestamp(raw.updatedAt, "cloud plan updatedAt");
    if (updatedAt < createdAt) throw new PlanValidationError("cloud plan updatedAt predates createdAt");

    let review: PlanReview | undefined;
    if (raw.review != null) {
      if (!raw.review || typeof raw.review !== "object") {
        throw new PlanValidationError("cloud plan review must be an object");
      }
      const source = raw.review as Record<string, unknown>;
      const reviewRevision = positiveInteger(source.revision, "review revision");
      if (reviewRevision !== revision) {
        throw new PlanValidationError("review revision does not match plan revision");
      }
      const issues = (Array.isArray(source.issues) ? source.issues : []).slice(0, 100).map((item) => {
        if (!item || typeof item !== "object") {
          throw new PlanValidationError("review issue must be an object");
        }
        const issue = item as Record<string, unknown>;
        const severity = String(issue.severity ?? "");
        if (!new Set(["info", "warning", "blocking"]).has(severity)) {
          throw new PlanValidationError("review issue has an invalid severity");
        }
        return {
          severity: severity as PlanReviewIssue["severity"],
          message: requiredText(issue.message, "review issue message", 4_000),
          ...(typeof issue.phaseId === "string" ? { phaseId: issue.phaseId.slice(0, 200) } : {}),
          ...(typeof issue.stepId === "string" ? { stepId: issue.stepId.slice(0, 200) } : {}),
        };
      });
      review = {
        revision: reviewRevision,
        summary: optionalText(source.summary, 10_000),
        issues,
        reviewedAt: timestamp(source.reviewedAt, "reviewedAt"),
      };
    }

    const incoming: ImplementationPlan = {
      id,
      project,
      title: requiredText(raw.title, "plan title", 500),
      status: status as ImplementationPlan["status"],
      revision,
      ...(confirmedRevision == null ? {} : { confirmedRevision }),
      phases: normalizePhases(raw.phases),
      notes: optionalText(raw.notes, 10_000),
      ...(review ? { review } : {}),
      createdAt,
      updatedAt,
    };
    const previous = this.get(project, id);
    if (!previous || previous.updatedAt < incoming.updatedAt) {
      if (previous?.confirmedRevision != null) {
        if (incoming.confirmedRevision !== previous.confirmedRevision) {
          throw new PlanConflictError("cloud plan conflicts with the locally confirmed revision");
        }
        const progress = { confirmed: 1, "in-progress": 2, done: 3 } as Record<string, number>;
        if ((progress[incoming.status] || 0) < (progress[previous.status] || 0)) {
          throw new PlanConflictError("cloud plan would move confirmed work backwards");
        }
      }
      return this.write(incoming);
    }
    return previous;
  }

  saveEdited(
    project: string,
    id: string,
    value: unknown,
    expectedRevision: number,
    requestReview = true,
  ): ImplementationPlan {
    const previous = this.get(project, id);
    if (!previous) throw new PlanNotFoundError("plan not found");
    if (previous.revision !== expectedRevision) {
      throw new PlanConflictError(
        `plan changed from revision ${expectedRevision} to ${previous.revision}`,
      );
    }
    if (!value || typeof value !== "object") throw new PlanValidationError("plan must be an object");
    if (!["draft", "edited", "ai-reviewed"].includes(previous.status)) {
      throw new PlanConflictError(`a plan in ${previous.status} state cannot be edited`);
    }
    const raw = value as Record<string, unknown>;
    return this.write({
      ...previous,
      title: requiredText(raw.title, "plan title", 500),
      phases: normalizePhases(raw.phases),
      notes: optionalText(raw.notes, 10_000),
      status: requestReview ? "reviewing" : "edited",
      revision: previous.revision + 1,
      confirmedRevision: undefined,
      review: undefined,
      updatedAt: Date.now(),
    });
  }

  recordReview(project: string, value: unknown): ImplementationPlan {
    if (!value || typeof value !== "object") {
      throw new PlanValidationError("plan review must be an object");
    }
    const raw = value as Record<string, unknown>;
    const id = safeSegment(raw.planId, "plan id");
    const revision = Number(raw.revision);
    if (!Number.isInteger(revision) || revision < 1) {
      throw new PlanValidationError("review revision must be a positive integer");
    }
    const previous = this.get(project, id);
    if (!previous) throw new PlanNotFoundError("plan not found");
    if (previous.revision !== revision) {
      throw new PlanConflictError(
        `ignored stale review for revision ${revision}; current revision is ${previous.revision}`,
      );
    }
    if (previous.status !== "reviewing") {
      throw new PlanConflictError(`a plan in ${previous.status} state is not awaiting review`);
    }
    const issues = (Array.isArray(raw.issues) ? raw.issues : []).slice(0, 100).map((item) => {
      const issue = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const severity =
        issue.severity === "blocking" || issue.severity === "warning" ? issue.severity : "info";
      const normalized: PlanReviewIssue = {
        severity,
        message: requiredText(issue.message, "review issue message", 4_000),
      };
      if (typeof issue.phaseId === "string") normalized.phaseId = issue.phaseId.slice(0, 200);
      if (typeof issue.stepId === "string") normalized.stepId = issue.stepId.slice(0, 200);
      return normalized;
    });
    const review: PlanReview = {
      revision,
      summary: optionalText(raw.summary, 10_000),
      issues,
      reviewedAt: Date.now(),
    };
    return this.write({
      ...previous,
      status: "ai-reviewed",
      review,
      updatedAt: review.reviewedAt,
    });
  }

  requestReview(project: string, id: string, revision: number): ImplementationPlan {
    const previous = this.get(project, id);
    if (!previous) throw new PlanNotFoundError("plan not found");
    if (previous.revision !== revision) {
      throw new PlanConflictError(
        `cannot review revision ${revision}; current revision is ${previous.revision}`,
      );
    }
    if (!["draft", "edited", "ai-reviewed", "reviewing"].includes(previous.status)) {
      throw new PlanConflictError(`a plan in ${previous.status} state cannot be reviewed`);
    }
    if (previous.status === "reviewing") return previous;
    return this.write({
      ...previous,
      status: "reviewing",
      review: undefined,
      updatedAt: Date.now(),
    });
  }

  markReviewUnavailable(project: string, id: string, revision: number): ImplementationPlan {
    const previous = this.get(project, id);
    if (!previous) throw new PlanNotFoundError("plan not found");
    if (previous.revision !== revision || previous.status !== "reviewing") return previous;
    return this.write({ ...previous, status: "edited", updatedAt: Date.now() });
  }

  confirm(project: string, id: string, expectedRevision: number): ImplementationPlan {
    const previous = this.get(project, id);
    if (!previous) throw new PlanNotFoundError("plan not found");
    if (previous.revision !== expectedRevision) {
      throw new PlanConflictError(
        `cannot confirm revision ${expectedRevision}; current revision is ${previous.revision}`,
      );
    }
    if (!["ai-reviewed", "confirmed"].includes(previous.status)) {
      throw new PlanConflictError("a plan must complete review before it can be confirmed");
    }
    return this.write({
      ...previous,
      status: "confirmed",
      confirmedRevision: previous.revision,
      updatedAt: Date.now(),
    });
  }

  markStarted(project: string, id: string): ImplementationPlan {
    const previous = this.get(project, id);
    if (!previous) throw new PlanNotFoundError("plan not found");
    if (previous.status !== "confirmed" || previous.confirmedRevision !== previous.revision) {
      throw new PlanConflictError("only the current confirmed revision can start");
    }
    return this.write({ ...previous, status: "in-progress", updatedAt: Date.now() });
  }

  applyProgress(project: string, value: unknown): ImplementationPlan {
    if (!value || typeof value !== "object") {
      throw new PlanValidationError("plan progress must be an object");
    }
    const raw = value as Record<string, unknown>;
    const id = safeSegment(raw.planId, "plan id");
    const revision = Number(raw.revision);
    const previous = this.get(project, id);
    if (!previous) throw new PlanNotFoundError("plan not found");
    if (previous.status !== "in-progress" && previous.status !== "done") {
      throw new PlanConflictError("progress is accepted only for an in-progress plan");
    }
    if (previous.confirmedRevision !== revision || previous.revision !== revision) {
      throw new PlanConflictError("progress does not match the confirmed plan revision");
    }
    const completed = new Set(
      (Array.isArray(raw.completedStepIds) ? raw.completedStepIds : []).map(String),
    );
    const blocked = new Set(
      (Array.isArray(raw.blockedStepIds) ? raw.blockedStepIds : []).map(String),
    );
    const update = (steps: PlanStep[]): PlanStep[] =>
      steps.map((step) => ({
        ...step,
        done: step.done || completed.has(step.id),
        ...(blocked.has(step.id) ? { blocked: true } : {}),
        children: update(step.children),
      }));
    const phases = previous.phases.map((phase) => ({ ...phase, steps: update(phase.steps) }));
    const steps = phases.flatMap((phase) => allSteps(phase.steps));
    const done = steps.length > 0 && steps.every((step) => step.done);
    return this.write({
      ...previous,
      phases,
      status: done ? "done" : "in-progress",
      updatedAt: Date.now(),
    });
  }
}

export const planStore = new PlanStore();
