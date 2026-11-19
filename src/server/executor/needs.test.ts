import assert from "node:assert/strict";
import test from "node:test";

import { describeNeeds, intakeTitle, needsFor, referencedIntakes, type NeedIntake } from "./needs.ts";

const id = (n: number) => `int_${String(n).padStart(24, "0")}`;
const intake = (n: number, refs: string[] = [], extra: Partial<NeedIntake> = {}): NeedIntake => ({
  intakeId: id(n), projectId: "prj_a", status: "triaged", createdAt: n, text: `[t${n}] Task ${n}. Details.`,
  verdict: { dependsOn: refs.map((ref) => `${ref} (why)`), queue: { after: [], note: "" } as any }, ...extra,
});
const map = (...list: NeedIntake[]) => new Map(list.map((entry) => [entry.intakeId, entry]));

test("intake ids come from dependsOn and queue.after, once each; other text is ignored", () => {
  assert.deepEqual(referencedIntakes({ dependsOn: [`${id(1)} (grid lab 1)`, "commit 99c992a"], queue: { after: [id(2), id(1)] } }), [id(1), id(2)]);
  assert.deepEqual(referencedIntakes(null), []);
  assert.deepEqual(referencedIntakes({ dependsOn: "int_x" as any }), []);
});

test("a ticket's title skips the requested-by header and keeps the tag", () => {
  assert.equal(intakeTitle("[New feature requested by Claude Code on werewolf.solutions over psm MCP]\n\n[grid lab 2] Live grid preview. In trading-bot's form…"), "grid lab 2: Live grid preview.");
  assert.equal(intakeTitle("Fix the login button"), "Fix the login button");
  assert.equal(intakeTitle("x".repeat(200)).length, 80);
});

test("only unmerged dependencies on the same project count", () => {
  const intakes = map(intake(1), intake(2), intake(3, [id(1), id(2), id(9)]), intake(4, [], { projectId: "prj_b" }), intake(5, [id(4)]));
  const jobs = new Map([[id(1), { jobId: "job_1", status: "accepted" }], [id(2), { jobId: "job_2", status: "review" }]]);
  assert.deepEqual(needsFor(id(3), intakes, jobs).map((need) => [need.intakeId, need.status, need.jobId]), [[id(2), "review", "job_2"]]);
  assert.deepEqual(needsFor(id(5), intakes, jobs), [], "another project's ticket is not a dependency");
});

test("dropped dependencies (withdrawn, rejected, cancelled) do not hold a job", () => {
  const intakes = map(intake(1, [], { status: "withdrawn" }), intake(2), intake(3), intake(4, [id(1), id(2), id(3)]));
  const jobs = new Map([[id(2), { jobId: "job_2", status: "rejected" }], [id(3), { jobId: "job_3", status: "cancelled" }]]);
  assert.deepEqual(needsFor(id(4), intakes, jobs), []);
});

test("in a cycle only the younger ticket waits, so one of them can start", () => {
  const intakes = map(intake(1, [id(3)]), intake(2, [id(1)]), intake(3, [id(2)]));
  const none = new Map();
  assert.deepEqual(needsFor(id(1), intakes, none), [], "oldest goes first");
  assert.deepEqual(needsFor(id(2), intakes, none).map((need) => need.intakeId), [id(1)]);
  assert.deepEqual(needsFor(id(3), intakes, none).map((need) => need.intakeId), [id(2)]);
});

test("the description tells the owner what to do with each dependency", () => {
  const text = describeNeeds([
    { intakeId: id(1), title: "grid lab 2: Live preview.", jobId: "job_c2725", status: "review" },
    { intakeId: id(2), title: "grid lab 1: Spacing modes.", jobId: null, status: "not-started" },
  ]);
  assert.match(text, /^Waiting for 2 other tickets to be merged first: /);
  assert.match(text, /"grid lab 2: Live preview\." \(job_c2725, ready for review: Accept it\)/);
  assert.match(text, /"grid lab 1: Spacing modes\." \(not started: click Go on it\)/);
});
