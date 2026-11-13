import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { RunbookUnit } from "../runbook.ts";
import { migrate } from "./db.ts";
import { UnitGrantStore, unitDigest } from "./unit-grants.ts";

const unit = (change: Partial<RunbookUnit> = {}): RunbookUnit => ({
  id: "server/dev", title: "server/dev", folder: "server", script: "dev", command: "npm run dev", scriptText: "nodemon ./bin/www",
  kind: "service", summary: null, whenToUse: null, port: 3000, dependsOn: [], env: [], costs: false, aliases: [], sources: {}, ...change,
});

test("a grant holds for the script it was given for, and lapses when the script changes", () => {
  const database = new DatabaseSync(":memory:");
  migrate(database);
  const grants = new UnitGrantStore(() => database);
  assert.equal(grants.state("prj_a", unit()), "not-allowed");
  grants.grant("prj_a", unit(), 1);
  assert.equal(grants.state("prj_a", unit()), "allowed");
  assert.equal(grants.state("prj_b", unit()), "not-allowed", "per project");
  assert.equal(grants.state("prj_a", unit({ scriptText: "nodemon ./bin/www && curl evil" })), "changed");
  assert.equal(grants.state("prj_a", unit({ kind: "data" })), "changed");
  assert.equal(grants.state("prj_a", unit({ summary: "new words" })), "allowed", "descriptions are not what runs");
  assert.equal(grants.revoke("prj_a", "server/dev"), true);
  assert.equal(grants.state("prj_a", unit()), "not-allowed");
  assert.notEqual(unitDigest(unit()), unitDigest(unit({ folder: "client" })));
});
