/**
 * The one durable thing about resources: the access level someone chose.
 *
 *   none  personal or unknown — listed, never opened, no buttons
 *   read  inspect and dry-run only
 *   full  development — Apply buttons too
 *
 * A resource with no row is unset, and unset behaves exactly like `none`. A
 * level is never chosen for you: suggestions (levels.ts) are shown, not stored.
 *
 * Writes compare-and-set on a revision like the machine store, so two tabs
 * cannot silently undo each other's choice.
 */
import type { DatabaseSync } from "node:sqlite";

export type Level = "none" | "read" | "full";
export const LEVELS: readonly Level[] = ["none", "read", "full"];

export function isLevel(value: unknown): value is Level {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

export interface ResourceSetting {
  key: string;
  level: Level | null;
  /** Folders exist only because someone added them; they live here, not in discovery. */
  folder: string | null;
  revision: number;
  setAt: number;
  setBy: string;
}

export class ResourceStoreError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "ResourceStoreError";
  }
}

const KEY = /^(db|container|folder):.{1,1000}$/;

export class ResourceStore {
  constructor(private readonly database: () => DatabaseSync) {}

  #transaction<T>(operation: (database: DatabaseSync) => T): T {
    const database = this.database();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(database);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  list(): ResourceSetting[] {
    return (this.database().prepare("SELECT document FROM resources ORDER BY key").all() as { document: string }[])
      .map((row) => JSON.parse(row.document) as ResourceSetting);
  }

  get(key: string): ResourceSetting | null {
    const row = this.database().prepare("SELECT document FROM resources WHERE key = ?").get(key) as { document: string } | undefined;
    return row ? (JSON.parse(row.document) as ResourceSetting) : null;
  }

  /** The level that is actually enforced: unset is none. */
  effective(key: string): Level {
    return this.get(key)?.level ?? "none";
  }

  /**
   * Choose a level. `expectedRevision` is 0 for a resource that has no row yet,
   * which is how the page says "I saw it unset".
   */
  setLevel(key: string, level: Level, expectedRevision: number, actor: string): ResourceSetting {
    if (!KEY.test(key)) throw new ResourceStoreError("That is not a resource psm can set a level on.", 400, "resource-key");
    if (!isLevel(level)) throw new ResourceStoreError("Choose None, Read or Full.", 400, "resource-level");
    return this.#transaction((database) => {
      const current = this.get(key);
      if ((current?.revision ?? 0) !== expectedRevision) {
        throw new ResourceStoreError("Someone changed this resource since you loaded it. Reload and try again.", 409, "resource-revision");
      }
      const next: ResourceSetting = {
        key,
        level,
        folder: current?.folder ?? null,
        revision: (current?.revision ?? 0) + 1,
        setAt: Date.now(),
        setBy: actor,
      };
      database.prepare("INSERT INTO resources (key, revision, document) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET revision = excluded.revision, document = excluded.document")
        .run(key, next.revision, JSON.stringify(next));
      return next;
    });
  }

  /** Add a folder. It starts unset — None until you choose — like anything new. */
  addFolder(key: string, folder: string, actor: string): ResourceSetting {
    if (!key.startsWith("folder:")) throw new ResourceStoreError("Not a folder.", 400, "resource-key");
    return this.#transaction((database) => {
      const current = this.get(key);
      if (current) return current;
      const next: ResourceSetting = { key, level: null, folder, revision: 1, setAt: Date.now(), setBy: actor };
      database.prepare("INSERT INTO resources (key, revision, document) VALUES (?, ?, ?)").run(key, 1, JSON.stringify(next));
      return next;
    });
  }

  /** Forget a choice (or a folder). The resource goes back to unset. */
  forget(key: string, expectedRevision: number): void {
    this.#transaction((database) => {
      const current = this.get(key);
      if (!current) return;
      if (current.revision !== expectedRevision) throw new ResourceStoreError("Someone changed this resource since you loaded it.", 409, "resource-revision");
      database.prepare("DELETE FROM resources WHERE key = ?").run(key);
    });
  }

  folders(): string[] {
    return this.list().map((setting) => setting.folder).filter((folder): folder is string => !!folder);
  }
}
