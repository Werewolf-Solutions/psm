import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PlanConflictError,
  PlanStore,
  PlanValidationError,
} from "./plans.ts";

function samplePlan() {
  return {
    id: "plan_attach",
    title: "Attach capabilities",
    phases: [
      {
        id: "phase_contract",
        title: "Contracts",
        summary: "Define the durable model.",
        steps: [
          {
            id: "step_types",
            text: "Add the types",
            done: false,
            children: [{ id: "step_tests", text: "Test validation", done: false }],
          },
        ],
      },
    ],
    notes: "Keep it reversible.",
  };
}

test("plan revisions reject stale human writes and stale AI reviews", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-plans-"));
  const store = new PlanStore(root);
  const draft = store.ingestAiPlan("psm", samplePlan());
  assert.equal(draft.revision, 1);
  assert.equal(draft.status, "draft");

  const reviewing = store.saveEdited(
    "psm",
    draft.id,
    { ...draft, title: "Edited attach plan" },
    draft.revision,
  );
  assert.equal(reviewing.revision, 2);
  assert.equal(reviewing.status, "reviewing");
  assert.throws(
    () => store.saveEdited("psm", draft.id, draft, 1),
    PlanConflictError,
  );
  assert.throws(
    () =>
      store.recordReview("psm", {
        planId: draft.id,
        revision: 1,
        summary: "stale",
        issues: [],
      }),
    PlanConflictError,
  );

  const reviewed = store.recordReview("psm", {
    planId: draft.id,
    revision: 2,
    summary: "Ordering is sound.",
    issues: [{ severity: "warning", message: "Keep detach in phase one.", stepId: "step_types" }],
  });
  assert.equal(reviewed.status, "ai-reviewed");
  assert.equal(reviewed.review?.revision, 2);
  assert.equal(reviewed.review?.issues[0].severity, "warning");
});

test("confirmed progress is revision-bound and completes the plan", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-plans-"));
  const store = new PlanStore(root);
  const draft = store.ingestAiPlan("psm", samplePlan());
  assert.throws(() => store.confirm("psm", draft.id, draft.revision), PlanConflictError);
  const reviewing = store.requestReview("psm", draft.id, draft.revision);
  const reviewed = store.recordReview("psm", {
    planId: reviewing.id,
    revision: reviewing.revision,
    summary: "Ready to implement.",
    issues: [],
  });
  const confirmed = store.confirm("psm", reviewed.id, reviewed.revision);
  assert.equal(confirmed.confirmedRevision, 1);
  assert.throws(
    () => store.saveEdited("psm", draft.id, draft, reviewed.revision),
    PlanConflictError,
  );
  assert.throws(
    () => store.applyProgress("psm", {
      planId: draft.id,
      revision: 1,
      completedStepIds: ["step_types"],
    }),
    PlanConflictError,
  );
  assert.equal(store.markStarted("psm", draft.id).status, "in-progress");

  assert.throws(
    () =>
      store.applyProgress("psm", {
        planId: draft.id,
        revision: 2,
        completedStepIds: ["step_types"],
      }),
    PlanConflictError,
  );
  const complete = store.applyProgress("psm", {
    planId: draft.id,
    revision: 1,
    completedStepIds: ["step_types", "step_tests"],
  });
  assert.equal(complete.status, "done");
  assert.equal(complete.phases[0].steps[0].done, true);
  assert.equal(complete.phases[0].steps[0].children[0].done, true);
});

test("AI-produced plans can enter review without changing revision", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-plans-"));
  const store = new PlanStore(root);
  const draft = store.ingestAiPlan("print-shop", { ...samplePlan(), id: "loop-plan" });
  const reviewing = store.requestReview("print-shop", draft.id, draft.revision);
  assert.equal(reviewing.status, "reviewing");
  assert.equal(reviewing.revision, draft.revision);
  assert.throws(
    () => store.requestReview("print-shop", draft.id, draft.revision + 1),
    /current revision/,
  );
});

test("plan paths and required structure are validated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-plans-"));
  const store = new PlanStore(root);
  assert.throws(() => store.list("../outside"), PlanValidationError);
  assert.throws(
    () => store.ingestAiPlan("psm", { title: "No phases", phases: [] }),
    PlanValidationError,
  );
});

test("cloud plan import accepts newer drafts and refuses confirmed-state regression", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-plans-cloud-"));
  const store = new PlanStore(root);
  const local = store.ingestAiPlan("psm", samplePlan());
  const imported = store.importSnapshot("psm", {
    ...local,
    title: "Newer cloud draft",
    updatedAt: local.updatedAt + 1,
  });
  assert.equal(imported.title, "Newer cloud draft");

  const reviewing = store.requestReview("psm", imported.id, imported.revision);
  const reviewed = store.recordReview("psm", {
    planId: reviewing.id,
    revision: reviewing.revision,
    summary: "safe",
    issues: [],
  });
  const started = store.markStarted(
    "psm",
    store.confirm("psm", reviewed.id, reviewed.revision).id,
  );
  const done = store.importSnapshot("psm", {
    ...started,
    status: "done",
    phases: started.phases.map((phase) => ({
      ...phase,
      steps: phase.steps.map((step) => ({
        ...step,
        done: true,
        children: step.children.map((child) => ({ ...child, done: true })),
      })),
    })),
    updatedAt: started.updatedAt + 10,
  });
  assert.equal(done.status, "done");
  assert.throws(
    () => store.importSnapshot("psm", {
      ...done,
      status: "confirmed",
      updatedAt: done.updatedAt + 10,
    }),
    PlanConflictError,
  );
});

test("cloud plan import validates timestamps and confirmation invariants", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-plans-cloud-invalid-"));
  const store = new PlanStore(root);
  const local = store.ingestAiPlan("psm", samplePlan());
  assert.throws(
    () => store.importSnapshot("psm", { ...local, status: "confirmed" }),
    PlanValidationError,
  );
  assert.throws(
    () => store.importSnapshot("psm", { ...local, updatedAt: -1 }),
    PlanValidationError,
  );
});
