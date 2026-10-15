/**
 * Suggested levels. Shown beside an unset resource as one chip ("Set to Full"),
 * never applied on their own — a new resource is None until you choose.
 */
import os from "node:os";
import path from "node:path";

import type { Resource } from "./discover.ts";
import type { Level } from "./store.ts";

export interface Suggestion {
  level: Level;
  reason: string;
}

const PERSONAL = ["Pictures", "Videos", "Documents", "Music", "Desktop", "Downloads", "Photos", "Movies"];

export function suggest(resource: Resource, home = os.homedir()): Suggestion | null {
  if (resource.kind === "database") {
    if (!resource.local) return { level: "read", reason: "Looks shared or hosted. Choose Full only if it is yours to change." };
    const users = [...new Set((resource.usedBy ?? []).map((use) => (use.directory ? `${use.project}/${use.directory}` : use.project)))];
    if (users.length) return { level: "full", reason: `Development database on this machine, used by ${users.join(", ")}.` };
    return null;
  }
  if (resource.kind === "folder" && resource.path) {
    const inside = PERSONAL.some((name) => {
      const root = path.join(home, name);
      return resource.path === root || resource.path!.startsWith(root + path.sep);
    });
    if (inside) return { level: "none", reason: "Personal files." };
  }
  return null;
}

/** What a level allows, in the words the panel and CLAUDE.md both use. */
export const LEVEL_RULE: Record<Level, string> = {
  none: "do not read or modify",
  read: "read-only: inspect and dry-run, no writes",
  full: "development: writes allowed",
};
