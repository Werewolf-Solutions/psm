import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acceptsPairedOrigins, pairsByMode, setModeForTesting, usePairingSwitch } from "../mode.ts";
import { readSwitches, resetSwitchesForTesting, writeSwitches } from "./switches.ts";

function file(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-switches-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    resetSwitchesForTesting();
  });
  resetSwitchesForTesting();
  return path.join(dir, ".psm-switches.json");
}

test("everything is off until switched on, and a choice survives a restart", (t) => {
  const target = file(t);
  assert.deepEqual(readSwitches(target), { executor: false, pairing: false });
  writeSwitches({ executor: true }, target);
  resetSwitchesForTesting(); // a new process
  assert.deepEqual(readSwitches(target), { executor: true, pairing: false });
  writeSwitches({ pairing: true }, target);
  assert.deepEqual(readSwitches(target), { executor: true, pairing: true }, "changing one keeps the other");
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test("a damaged file reads as everything off", (t) => {
  const target = file(t);
  fs.writeFileSync(target, "{not json");
  assert.deepEqual(readSwitches(target), { executor: false, pairing: false });
});

test("dev mode pairs only when switched on; agent mode always pairs", (t) => {
  let on = false;
  usePairingSwitch(() => on);
  t.after(() => { usePairingSwitch(() => false); setModeForTesting(undefined); });
  setModeForTesting("dev");
  assert.equal(acceptsPairedOrigins(), false);
  on = true;
  assert.equal(acceptsPairedOrigins(), true, "dev + switch: scans the workspace and pairs");
  assert.equal(pairsByMode(), false);
  setModeForTesting("agent");
  on = false;
  assert.equal(acceptsPairedOrigins(), true);
  assert.equal(pairsByMode(), true);
});
