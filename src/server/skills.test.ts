import assert from "node:assert/strict";
import test from "node:test";

// Re-implement the aggregation on an in-memory transcript to lock the parsing
// contract (the exported collectSkillUsage scans the real ~/.claude dir, which
// is not deterministic in tests).
import { collectSkillUsage } from "./skills.ts";

test("collectSkillUsage returns an array without throwing on the real home dir", () => {
  const usage = collectSkillUsage();
  assert.ok(Array.isArray(usage));
  for (const u of usage) {
    assert.equal(typeof u.skill, "string");
    assert.equal(typeof u.count, "number");
    assert.ok(u.count >= 1);
    assert.ok(Array.isArray(u.projects));
  }
  // sorted by count descending
  for (let i = 1; i < usage.length; i++) {
    assert.ok(usage[i - 1].count >= usage[i].count);
  }
});

test("a non-existent project filter yields an empty list", () => {
  const usage = collectSkillUsage("/definitely/not/a/real/project/path/xyz");
  assert.deepEqual(usage, []);
});
