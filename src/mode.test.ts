import assert from "node:assert/strict";
import test from "node:test";

import { ModeError, acceptsPairedOrigins, psmMode, scansImplicitly, setModeForTesting } from "./mode.ts";

test("no PSM_MODE means the original local tool", () => {
  setModeForTesting(undefined);
  const previous = process.env.PSM_MODE;
  delete process.env.PSM_MODE;
  try {
    assert.equal(psmMode(), "dev");
    assert.equal(scansImplicitly(), true);
    assert.equal(acceptsPairedOrigins(), false);
  } finally {
    if (previous !== undefined) process.env.PSM_MODE = previous;
    setModeForTesting(undefined);
  }
});

test("agent runs locally but only over linked folders", () => {
  setModeForTesting("agent");
  try {
    assert.equal(scansImplicitly(), false, "agent links explicitly");
    assert.equal(acceptsPairedOrigins(), true);
  } finally {
    setModeForTesting(undefined);
  }
});

test("hosted is refused loudly, pointing at the static site", () => {
  // Someone setting this expects a psm server on the internet. There isn't one,
  // and quietly demoting them to agent would hide that.
  const previous = process.env.PSM_MODE;
  for (const spelling of ["hosted", "production", "prod"]) {
    setModeForTesting(undefined);
    process.env.PSM_MODE = spelling;
    assert.throws(() => psmMode(), /retired|static site/, spelling);
  }
  setModeForTesting(undefined);
  if (previous === undefined) delete process.env.PSM_MODE;
  else process.env.PSM_MODE = previous;
});

test("an unknown mode fails loudly instead of defaulting", () => {
  const previous = process.env.PSM_MODE;
  setModeForTesting(undefined);
  process.env.PSM_MODE = "staging";
  try {
    assert.throws(() => psmMode(), ModeError);
  } finally {
    if (previous === undefined) delete process.env.PSM_MODE;
    else process.env.PSM_MODE = previous;
    setModeForTesting(undefined);
  }
});
