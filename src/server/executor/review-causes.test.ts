import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { causeLabel, parseReviewCause, ReviewCauses } from "./review-causes.ts";

test("a review must say why it is going back, and a project cause must say what", () => {
  assert.match((parseReviewCause({}) as { error: string }).error, /why it is going back/);
  assert.match((parseReviewCause({ cause: "other" }) as { error: string }).error, /why it is going back/);
  assert.deepEqual(parseReviewCause({ cause: "one-off", causeNote: "ignored" }), { cause: "one-off", note: "" });
  assert.match((parseReviewCause({ cause: "project", causeNote: "  " }) as { error: string }).error, /what in the project/);
  assert.deepEqual(parseReviewCause({ cause: "project", causeNote: " phone number is hard-coded in three components " }), { cause: "project", note: "phone number is hard-coded in three components" });
});

test("on Revise the comment stands in for a missing project note", () => {
  assert.deepEqual(parseReviewCause({ cause: "project" }, "use the contact setting, not the footer's number"), { cause: "project", note: "use the contact setting, not the footer's number" });
  assert.equal(causeLabel("project", "stale example"), "project cause: stale example");
  assert.equal(causeLabel("one-off", ""), "one-off");
});

test("project causes are kept per project, newest first, across restarts", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-causes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "causes.json");
  let clock = 1000;
  const causes = new ReviewCauses(file, () => clock++);
  causes.record({ jobId: "job_1", projectId: "prj_a", action: "reject", cause: "project", note: "hard-coded number", task: "x".repeat(300) });
  causes.record({ jobId: "job_2", projectId: "prj_a", action: "revise", cause: "one-off", note: "", task: "tweak" });
  causes.record({ jobId: "job_3", projectId: "prj_b", action: "reject", cause: "project", note: "no fixture", task: "other" });
  causes.record({ jobId: "job_4", projectId: "prj_a", action: "revise", cause: "project", note: "hard-coded number again", task: "quote button" });

  const reloaded = new ReviewCauses(file);
  const found = reloaded.projectCauses("prj_a");
  assert.deepEqual(found.map((record) => record.jobId), ["job_4", "job_1"]);
  assert.equal(found[1].task.length, 201);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(reloaded.projectCauses("prj_none"), []);
});
