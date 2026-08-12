import assert from "node:assert/strict";
import test from "node:test";

import {
  ModeError,
  acceptsPairedOrigins,
  canRunCommands,
  isMultiTenant,
  psmMode,
  requiresAuth,
  scansImplicitly,
  setModeForTesting,
} from "./mode.ts";

test("no PSM_MODE means the original local tool", () => {
  setModeForTesting(undefined);
  const previous = process.env.PSM_MODE;
  delete process.env.PSM_MODE;
  try {
    assert.equal(psmMode(), "dev");
    assert.equal(scansImplicitly(), true);
    assert.equal(canRunCommands(), true);
    assert.equal(requiresAuth(), false);
  } finally {
    if (previous !== undefined) process.env.PSM_MODE = previous;
    setModeForTesting(undefined);
  }
});

test("a deploy config saying production gets the hosted posture", () => {
  const previous = process.env.PSM_MODE;
  for (const spelling of ["production", "prod", "hosted", "HOSTED"]) {
    setModeForTesting(undefined);
    process.env.PSM_MODE = spelling;
    assert.equal(psmMode(), "hosted", spelling);
  }
  setModeForTesting(undefined);
  if (previous === undefined) delete process.env.PSM_MODE;
  else process.env.PSM_MODE = previous;
  setModeForTesting(undefined);
});

test("hosted can neither run commands nor skip auth", () => {
  setModeForTesting("hosted");
  try {
    assert.equal(canRunCommands(), false);
    assert.equal(requiresAuth(), true);
    assert.equal(isMultiTenant(), true);
    assert.equal(scansImplicitly(), false);
    assert.equal(acceptsPairedOrigins(), false, "hosted is not the paired side");
  } finally {
    setModeForTesting(undefined);
  }
});

test("agent runs locally but only over linked folders", () => {
  setModeForTesting("agent");
  try {
    assert.equal(canRunCommands(), true);
    assert.equal(scansImplicitly(), false, "agent links explicitly");
    assert.equal(acceptsPairedOrigins(), true);
    assert.equal(requiresAuth(), false, "loopback is the trust boundary");
    assert.equal(isMultiTenant(), false);
  } finally {
    setModeForTesting(undefined);
  }
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
