import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyManagedRegion,
  composeSystemRules,
  readProfile,
  suggestPractices,
  writeGlobalRules,
  writeProfile,
  writeProjectRules,
} from "./rules.ts";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "psm-rules-"));
}

test("composed system rules layer global + project overlay + practice snippets", () => {
  // NOTE: writeGlobalRules touches the repo's house-rules.md; restore it after.
  const original = (() => {
    try {
      return fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "house-rules.md"), "utf8");
    } catch {
      return null;
    }
  })();
  try {
    writeGlobalRules("GLOBAL BASELINE");
    const dir = tmpProject();
    writeProjectRules(dir, "Deploy only on Fridays.");
    writeProfile(dir, ["versioning"]);

    const composed = composeSystemRules(dir);
    assert.match(composed, /GLOBAL BASELINE/);
    assert.match(composed, /Deploy only on Fridays\./);
    assert.match(composed, /Project house rules/);
    assert.match(composed, /Engineering practices/);
    assert.match(composed, /SemVer/);
    // ordering: global before overlay before practices
    assert.ok(composed.indexOf("GLOBAL BASELINE") < composed.indexOf("Deploy only on Fridays."));
    assert.ok(composed.indexOf("Deploy only on Fridays.") < composed.indexOf("SemVer"));
  } finally {
    if (original !== null) writeGlobalRules(original);
  }
});

test("adopting a practice scaffolds starter files without overwriting existing ones", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "PRE-EXISTING\n");
  writeProfile(dir, ["versioning", "docs"]);

  assert.equal(fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"), "PRE-EXISTING\n");
  assert.equal(fs.readFileSync(path.join(dir, "VERSION"), "utf8").trim(), "0.0.1");
  assert.ok(fs.existsSync(path.join(dir, "docs", "adr", "0000-template.md")));
  assert.deepEqual(readProfile(dir).practices, ["versioning", "docs"]);
});

test("managed region is idempotent and only rewrites its own markers", () => {
  const dir = tmpProject();
  const claude = path.join(dir, "CLAUDE.md");
  fs.writeFileSync(claude, "# Hand-written preamble\n\nKeep me.\n");
  writeProjectRules(dir, "First version.");
  const first = fs.readFileSync(claude, "utf8");
  assert.match(first, /Hand-written preamble/);
  assert.match(first, /psm:rules:start/);
  assert.match(first, /First version\./);

  applyManagedRegion(dir); // no change → identical bytes
  assert.equal(fs.readFileSync(claude, "utf8"), first);

  writeProjectRules(dir, "Second version.");
  const second = fs.readFileSync(claude, "utf8");
  assert.match(second, /Hand-written preamble/); // preamble survives
  assert.match(second, /Second version\./);
  assert.doesNotMatch(second, /First version\./); // old region replaced, not duplicated
  assert.equal(second.match(/psm:rules:start/g)?.length, 1);
});

test("suggestPractices keys off the detected stack", () => {
  assert.deepEqual(suggestPractices([]), ["human-gated-ai"]);
  assert.deepEqual(suggestPractices(["Static HTML site"]), ["human-gated-ai"]);
  assert.ok(suggestPractices(["Node · TypeScript"]).includes("versioning"));
});
