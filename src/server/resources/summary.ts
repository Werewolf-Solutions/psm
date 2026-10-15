/**
 * Resources in the words agents read: which databases a project uses and the
 * level each one has. Built from the same `.env` parsing as discovery, so it
 * carries hosts and database names, never credentials.
 */
import { ENGINE_LABEL, databaseKey, envReferences } from "./discover.ts";
import type { Level, ResourceStore } from "./store.ts";

export interface ProjectDatabase {
  key: string;
  label: string;
  level: Level | null;
  /** Where in the project it is referenced, e.g. `server/.env MONGODB_URI`. */
  references: string[];
}

export function projectDatabases(project: { name: string; path: string }, store: Pick<ResourceStore, "get">): ProjectDatabase[] {
  const byKey = new Map<string, ProjectDatabase>();
  for (const ref of envReferences([project])) {
    const key = databaseKey(ref.target);
    let entry = byKey.get(key);
    if (!entry) {
      const where = ref.target.local ? `local ${ENGINE_LABEL[ref.target.engine]} :${ref.target.port ?? "srv"}` : `${ENGINE_LABEL[ref.target.engine]} at ${ref.target.host}`;
      entry = { key, label: where, level: store.get(key)?.level ?? null, references: [] };
      byKey.set(key, entry);
    }
    entry.references.push(`${ref.directory ? `${ref.directory}/` : ""}${ref.file} ${ref.variable}${ref.target.database ? ` (${ref.target.database})` : ""}`);
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}
