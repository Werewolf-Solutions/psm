/**
 * How this psm process is running.
 *
 * There are two postures, and both have a machine under them:
 *
 *   dev      the original local tool: auto-scans the workspace root next to the
 *            repo, serves its own cockpit at 127.0.0.1. What `npm run dev` gives you.
 *   agent    local too, but driven from elsewhere: nothing is scanned until you
 *            link a folder, and a paired browser origin is allowed to reach it.
 *
 * There used to be a third, `hosted` — a psm server on the internet. It is gone.
 * psm.werewolf.solutions is **static files**: nginx serves `web/`, the browser
 * signs in against werewolf-dapp directly, and every project operation goes to
 * the agent on the user's own machine. Nothing runs psm on a server, which is
 * why nothing here has to reason about multi-tenancy or shell-out isolation any
 * more. See docs/deploy/PUBLISHING-A-NEW-APP.md.
 *
 * Branch on the predicates below rather than comparing the mode string.
 */
export type PsmMode = "dev" | "agent";

const MODES: PsmMode[] = ["dev", "agent"];

export class ModeError extends Error {}

function parseMode(raw: string | undefined): PsmMode {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "dev";
  if (value === "local") return "dev";
  // Fail loudly rather than quietly demoting to agent: someone setting this is
  // expecting a server, and they need to know there isn't one.
  if (["hosted", "production", "prod"].includes(value)) {
    throw new ModeError(
      "PSM_MODE=hosted has been retired — psm.werewolf.solutions is a static site " +
        "served by nginx, with no psm process behind it. Use PSM_MODE=agent to let " +
        "that page drive this machine, or leave it unset for the local cockpit.",
    );
  }
  if ((MODES as string[]).includes(value)) return value as PsmMode;
  throw new ModeError(`PSM_MODE must be one of ${MODES.join(", ")} — got "${raw}"`);
}

let cached: PsmMode | null = null;

export function psmMode(): PsmMode {
  if (cached === null) cached = parseMode(process.env.PSM_MODE);
  return cached;
}

/** Tests and the CLI flip modes in-process; nothing else should call this. */
export function setModeForTesting(mode: PsmMode | undefined) {
  cached = mode ?? null;
}

/** Does it scan a workspace root implicitly, or only what has been linked? */
export const scansImplicitly = () => psmMode() === "dev";

/** May a paired browser origin other than loopback talk to it? */
export const acceptsPairedOrigins = () => psmMode() === "agent";

export function describeMode(): string {
  return psmMode() === "dev"
    ? "dev — local workspace scan, cockpit on loopback"
    : "agent — linked folders only, paired origins allowed";
}
