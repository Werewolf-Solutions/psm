/**
 * psm's local database.
 *
 * The scratchpad beside a project — bugs and todos, features, ideas — is the
 * first thing psm keeps that is *the user's own writing* rather than a cache of
 * something it scanned. A rundown can be rebuilt by scanning the workspace
 * again; a note you took while looking at a stack trace cannot. That asymmetry
 * is what earns a database: one file, written transactionally, that a crash
 * mid-write leaves intact and that can be queried across every project at once.
 *
 * SQLite, through Node's built-in `node:sqlite`. No dependency to install and no
 * native module to rebuild on every Node upgrade, which matters for a tool the
 * user is expected to clone and run in one step. It is still marked experimental
 * upstream, so psm runs with `--disable-warning=ExperimentalWarning` rather than
 * printing a warning about its own storage on every boot.
 *
 * Still files, not a database: plans, sessions, logs and backups. Those are
 * documents psm writes whole and reads whole, and a row would only wrap them.
 * The rule for what belongs here is small things that are edited one at a time
 * and looked at together.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { sharedStateDir } from "../store.ts";

/** Where the database lives, unless `PSM_DB_FILE` says otherwise (tests do). */
export function databaseFile(): string {
  return process.env.PSM_DB_FILE || path.join(sharedStateDir("data"), "psm.db");
}

/**
 * Every schema change psm has ever made, in order. SQLite records how many of
 * these a file has seen in `PRAGMA user_version`, so opening an older database
 * runs exactly the ones it is missing.
 *
 * Append only. Editing a migration that has already shipped changes the schema
 * of new databases without touching existing ones, and the two then disagree
 * forever.
 */
const MIGRATIONS: readonly string[] = [
  // 1 — the project scratchpad, and a place to record one-off facts about the
  // database itself (which imports have run, so far).
  `CREATE TABLE meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
   CREATE TABLE notes (
     id         TEXT PRIMARY KEY,
     project    TEXT NOT NULL,
     kind       TEXT NOT NULL,
     text       TEXT NOT NULL,
     done       INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX notes_by_project ON notes (project, created_at DESC);`,
];

/** The schema version a database is brought up to by `openDatabase`. */
export const SCHEMA_VERSION = MIGRATIONS.length;

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * Bring `db` up to the current schema. Each migration is its own transaction:
 * one that fails leaves the database on the last version that fully applied,
 * rather than half-way into a schema no code has ever seen.
 */
export function migrate(db: DatabaseSync): number {
  for (let version = userVersion(db); version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]);
      // A pragma cannot be parameterised; `version` is a loop counter, not input.
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return userVersion(db);
}

/**
 * Keep the database to its owner: the directory psm creates for it is `0700`,
 * the file itself `0600`. Best-effort — an exotic filesystem that refuses a
 * chmod is not a reason to refuse to start.
 *
 * What is deliberately *not* done here is tightening a directory that already
 * existed. `PSM_DB_FILE` can point anywhere, including a home directory, and
 * psm has no business locking that down. The consequence is that WAL's `-wal`
 * and `-shm` sidecars — written on first write, with the process umask, outside
 * psm's control — are only as private as the directory holding them, the same
 * bargain `.psm-sessions.json` already makes.
 */
function restrict(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // A filesystem without modes. Carry on.
  }
}

/** Open (creating if needed) a psm database and migrate it to the current schema. */
export function openDatabase(file: string = databaseFile()): DatabaseSync {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(file);
  if (file !== ":memory:") restrict(file);
  // A read never blocks the write that is landing beside it, which is what lets
  // the notes pane reload while the AI pane is still writing.
  db.exec("PRAGMA journal_mode = WAL");
  // Two psm processes on one workspace is a mistake, not a design — but waiting
  // five seconds for the other one beats failing the request instantly.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

let shared: DatabaseSync | null = null;

/**
 * The database this psm process uses. Opened on first use rather than on import,
 * so loading a module that happens to mention notes never creates a file.
 */
export function db(): DatabaseSync {
  if (!shared) shared = openDatabase();
  return shared;
}

/** Close the shared handle. Tests use it; the process exiting does the rest. */
export function closeDatabase(): void {
  shared?.close();
  shared = null;
}

/** A fact about the database itself — which one-time imports have run, so far. */
export function readMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value?: string }
    | undefined;
  return row?.value ?? null;
}

export function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
