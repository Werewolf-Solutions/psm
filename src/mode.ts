/**
 * How this psm process is running.
 *
 * psm is one codebase in three postures, because "hosted" and "scans your local
 * folders" cannot be the same process — a page served from the internet has no
 * disk. See docs/hosted-psm-plan.md.
 *
 *   dev      the original local tool: auto-scans the workspace root next to the
 *            repo, no auth, everything available. What `npm run server` gives you.
 *   agent    local too, but headless-ish: nothing is scanned until you link a
 *            folder, and a paired hosted origin is allowed to drive it.
 *   hosted   the deployed front end: authenticated, multi-tenant, and physically
 *            unable to run a command or read a project — those routes are never
 *            registered in this mode.
 *
 * Every branch in the server should ask one of the predicates below rather than
 * comparing the mode string, so adding a fourth posture stays a local change.
 */
export type PsmMode = "dev" | "agent" | "hosted";

const MODES: PsmMode[] = ["dev", "agent", "hosted"];

export class ModeError extends Error {}

function parseMode(raw: string | undefined): PsmMode {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "dev";
  // "production" is what a deploy config naturally says; it means the hosted half
  if (value === "production" || value === "prod") return "hosted";
  if (value === "local") return "dev";
  if ((MODES as string[]).includes(value)) return value as PsmMode;
  throw new ModeError(
    `PSM_MODE must be one of ${MODES.join(", ")} (or production/local) — got "${raw}"`,
  );
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

/** Does this process have the machine's disk under it? */
export const isLocal = () => psmMode() !== "hosted";

/** May it start processes, stream logs, and run AI turns? */
export const canRunCommands = () => isLocal();

/** Does it scan a workspace root implicitly, or only what has been linked? */
export const scansImplicitly = () => psmMode() === "dev";

/** Must every request carry an authenticated user? */
export const requiresAuth = () => psmMode() === "hosted";

/** Does it serve state for many accounts rather than one machine's owner? */
export const isMultiTenant = () => psmMode() === "hosted";

/** May a paired browser origin other than loopback talk to it? */
export const acceptsPairedOrigins = () => psmMode() === "agent";

export function describeMode(): string {
  switch (psmMode()) {
    case "dev":
      return "dev — local workspace scan, no auth";
    case "agent":
      return "agent — local, linked folders only, paired origins allowed";
    case "hosted":
      return "hosted — authenticated, multi-tenant, no local execution";
  }
}
