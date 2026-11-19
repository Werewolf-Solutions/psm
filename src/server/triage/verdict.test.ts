import assert from "node:assert/strict";
import test from "node:test";

import { findCalendarDate, parseTriageAnswer, parseVerdictAnswer, validateVerdict } from "./verdict.ts";

function base(overrides: Record<string, unknown> = {}) {
  return {
    verdict: "fits",
    size: "M",
    dependsOn: ["P05 walkthrough"],
    conflictsWith: [],
    queue: { after: ["intake int_abc"], note: "after the walkthrough lands" },
    rationale: "Fits the current roadmap; touches only the inbox view.",
    ...overrides,
  };
}

function error(value: unknown): string {
  const result = validateVerdict(value);
  assert.equal(result.ok, false, "expected the verdict to be refused");
  return (result as { error: string }).error;
}

test("a complete fits verdict is accepted and normalised", () => {
  const result = validateVerdict(base({ rationale: "  padded  " }));
  assert.ok(result.ok);
  assert.deepEqual(result.verdict.questions, []);
  assert.equal(result.verdict.rationale, "padded");
});

test("every verdict kind and size is accepted", () => {
  for (const verdict of ["fits", "doesnt_fit"]) {
    for (const size of ["S", "M", "L", "XL"]) assert.ok(validateVerdict(base({ verdict, size })).ok);
  }
  assert.ok(validateVerdict(base({ verdict: "needs_decision", questions: ["Which tier?"] })).ok);
});

test("unknown verdicts, sizes and extra fields are refused", () => {
  assert.match(error(base({ verdict: "maybe" })), /verdict must be one of/);
  assert.match(error(base({ size: "XXL" })), /size must be one of/);
  assert.match(error(base({ size: "m" })), /size must be one of/);
  assert.match(error(base({ eta: "soon" })), /unexpected field eta/);
  assert.match(error(base({ queue: { after: [], note: "", position: 3 } })), /unexpected field queue\.position/);
});

test("missing or mistyped fields are refused", () => {
  const missing: Record<string, unknown> = base();
  delete missing.dependsOn;
  assert.match(error(missing), /dependsOn must be a list/);
  assert.match(error(base({ conflictsWith: "none" })), /conflictsWith must be a list/);
  assert.match(error(base({ queue: null })), /queue must be an object/);
  assert.match(error(base({ queue: { after: [] } })), /queue\.note must be a string/);
  assert.match(error(base({ dependsOn: [3] })), /dependsOn\[0\] must be a string/);
  assert.match(error(base({ dependsOn: ["  "] })), /dependsOn\[0\] is empty/);
  assert.match(error(base({ rationale: "" })), /rationale must be a non-empty string/);
  assert.match(error([]), /must be a JSON object/);
  assert.match(error(null), /must be a JSON object/);
});

test("questions are required for needs_decision and refused otherwise", () => {
  assert.match(error(base({ verdict: "needs_decision" })), /questions must be a list/);
  assert.match(error(base({ verdict: "needs_decision", questions: [] })), /must not be empty/);
  assert.match(error(base({ questions: ["Why?"] })), /only allowed when the verdict is needs_decision/);
  // An empty list on a non-decision verdict is harmless.
  assert.ok(validateVerdict(base({ questions: [] })).ok);
});

test("list and length limits are enforced", () => {
  const eleven = Array.from({ length: 11 }, (_, i) => `item ${i}`);
  assert.match(error(base({ dependsOn: eleven })), /11 entries; at most 10/);
  assert.match(error(base({ queue: { after: eleven, note: "" } })), /queue\.after has 11 entries/);
  assert.ok(validateVerdict(base({ dependsOn: eleven.slice(0, 10) })).ok);
  assert.match(error(base({ conflictsWith: ["x".repeat(201)] })), /201 characters; at most 200/);
  assert.ok(validateVerdict(base({ conflictsWith: ["x".repeat(200)] })).ok);
  assert.match(error(base({ rationale: "r".repeat(2001) })), /rationale is 2001 characters/);
  assert.ok(validateVerdict(base({ rationale: "r".repeat(2000) })).ok);
});

test("calendar dates are refused in every text field", () => {
  const dated: Array<[Record<string, unknown>, RegExp]> = [
    [{ rationale: "Ship by 2026-10-30." }, /rationale contains a calendar date \(ISO date/],
    [{ rationale: "Deadline 2026-11-02T09:00" }, /ISO date/],
    [{ rationale: "Planned for 2026-11" }, /year-month/],
    [{ rationale: "Do it on 10/30/2026" }, /numeric date/],
    [{ rationale: "Do it on 30.10.2026" }, /numeric date/],
    [{ rationale: "Due Oct 30" }, /month and day/],
    [{ rationale: "Due October 30th" }, /month and day/],
    [{ rationale: "Due Sept. 3" }, /month and day/],
    [{ rationale: "Due the 3rd of March" }, /day and month/],
    [{ rationale: "Due 12 December" }, /day and month/],
    [{ rationale: "Lands in November 2026" }, /month and year/],
    [{ rationale: "Lands in Q3 2026" }, /quarter/],
    [{ rationale: "Pair on it Friday" }, /weekday/],
    [{ rationale: "Standups on mondays" }, /weekday/],
    [{ rationale: "Start tomorrow" }, /relative date/],
    [{ rationale: "Start next week" }, /relative date/],
    [{ rationale: "Revisit this quarter" }, /relative date/],
    [{ rationale: "Done in two weeks" }, /relative date/],
    [{ rationale: "Done within 3 days" }, /relative date/],
    [{ rationale: "Done in a few days" }, /relative date/],
    [{ rationale: "Broken 5 days ago" }, /relative date/],
    [{ rationale: "By end of the month" }, /relative date/],
    [{ rationale: "Need it EOD" }, /relative date/],
    [{ dependsOn: ["release on Monday"] }, /dependsOn\[0\] contains a calendar date/],
    [{ conflictsWith: ["freeze until Jan 5"] }, /conflictsWith\[0\]/],
    [{ queue: { after: ["P05"], note: "after next week" } }, /queue\.note/],
    [{ queue: { after: ["2026-10-20 release"], note: "" } }, /queue\.after\[0\]/],
    [{ verdict: "needs_decision", questions: ["Ship before Dec 1?"] }, /questions\[0\]/],
  ];
  for (const [overrides, pattern] of dated) assert.match(error(base(overrides)), pattern, JSON.stringify(overrides));
});

test("ordinary prose with numbers is not mistaken for a date", () => {
  const fine = [
    "Bump psm to 0.2.10 and rerun 851 tests.",
    "P14 phase D depends on B3; it may 2x the queue.",
    "Today psm has no executor, so this fits after B5.",
    "Mark the 2 items, then march on with the inbox.",
    "Uses port 4317 and the 120 s lease.",
    "A 3-step change across 2 files.",
    "Monitoring and sundry cleanup.",
  ];
  for (const text of fine) {
    assert.equal(findCalendarDate(text), null, text);
    assert.ok(validateVerdict(base({ rationale: text })).ok, text);
  }
});

test("the answer parser accepts bare JSON and exactly one fenced block", () => {
  const json = JSON.stringify(base());
  assert.ok(parseVerdictAnswer(json).ok);
  assert.ok(parseVerdictAnswer(`\n  ${json}  \n`).ok);
  assert.ok(parseVerdictAnswer("```json\n" + json + "\n```").ok);
  assert.ok(parseVerdictAnswer("```\n" + json + "\n```").ok);
  assert.ok(parseVerdictAnswer("Here is the verdict:\n\n```json\n" + JSON.stringify(base(), null, 2) + "\n```\n").ok);
});

test("the answer parser refuses everything else", () => {
  const json = JSON.stringify(base());
  assert.match((parseVerdictAnswer("") as any).error, /empty answer/);
  assert.match((parseVerdictAnswer("It fits.") as any).error, /not a JSON verdict/);
  assert.match((parseVerdictAnswer(`The verdict is ${json}`) as any).error, /not a JSON verdict/);
  assert.match(
    (parseVerdictAnswer("```json\n" + json + "\n```\n```json\n" + json + "\n```") as any).error,
    /2 fenced blocks/,
  );
  assert.match((parseVerdictAnswer("```json\n{ verdict: fits }\n```") as any).error, /not valid JSON/);
  assert.match((parseVerdictAnswer("{\"verdict\": \"fits\"") as any).error, /not valid JSON/);
  assert.match((parseVerdictAnswer("```json\n[1, 2]\n```") as any).error, /must be a JSON object/);
  assert.match((parseVerdictAnswer(JSON.stringify(base({ rationale: "ship tomorrow" }))) as any).error, /calendar date/);
});

test("touches is split off the verdict; a bad list is an unknown scope, never a refused verdict", () => {
  const base = { verdict: "fits", size: "S", dependsOn: [], conflictsWith: [], queue: { after: [], note: "" }, questions: [], rationale: "ok" };
  const good = parseTriageAnswer(JSON.stringify({ ...base, touches: ["./routes/registry.js", "routes/__tests__/"] }));
  assert.ok(good.ok);
  assert.deepEqual(good.ok && good.scope, ["routes/__tests__/", "routes/registry.js"]);
  assert.equal(good.ok && "touches" in good.verdict, false, "the verdict stays the hub's shape");
  for (const touches of [[], ["../x"], "routes/", undefined]) {
    const answer = parseTriageAnswer(JSON.stringify({ ...base, ...(touches === undefined ? {} : { touches }) }));
    assert.ok(answer.ok);
    assert.equal(answer.ok && answer.scope, null);
  }
  assert.equal(parseTriageAnswer(JSON.stringify({ ...base, verdict: "maybe", touches: ["a.js"] })).ok, false);
  assert.equal(parseVerdictAnswer(JSON.stringify({ ...base, touches: ["a.js"] })).ok, false, "the hub's own validator still refuses unknown keys");
});
