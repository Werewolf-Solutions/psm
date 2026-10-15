/**
 * Two switches for this psm process, flipped from the cockpit and remembered
 * across restarts, so neither needs an environment variable or a different
 * start command:
 *
 *   executor  claim and run the hub's triage jobs (what PSM_EXECUTOR=1 did)
 *   pairing   let psm.werewolf.solutions drive this machine with the pairing
 *             token (what PSM_MODE=agent did) — while still scanning the
 *             workspace like dev mode, so one process can be both
 *
 * The environment still wins where it says more: PSM_EXECUTOR=1 keeps the
 * executor on, and agent mode always pairs. The file only ever adds.
 *
 * Kept in memory after the first read, because pairing is consulted on every
 * request with an Origin.
 */
import fs from "node:fs";

import { statePath } from "../store.ts";

export interface Switches {
  executor: boolean;
  pairing: boolean;
}

const DEFAULTS: Switches = { executor: false, pairing: false };

export function switchesFile(): string {
  return process.env.PSM_SWITCHES_FILE || statePath(".psm-switches.json");
}

let cached: Switches | null = null;

export function readSwitches(file = switchesFile()): Switches {
  if (cached) return { ...cached };
  let parsed: Partial<Switches> = {};
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* none saved yet: everything off */
  }
  cached = { executor: parsed.executor === true, pairing: parsed.pairing === true };
  return { ...cached };
}

export function writeSwitches(change: Partial<Switches>, file = switchesFile()): Switches {
  const next: Switches = { ...readSwitches(file) };
  if (typeof change.executor === "boolean") next.executor = change.executor;
  if (typeof change.pairing === "boolean") next.pairing = change.pairing;
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
  cached = next;
  return { ...next };
}

/** Tests only. */
export function resetSwitchesForTesting(): void {
  cached = null;
}

export { DEFAULTS as SWITCH_DEFAULTS };
