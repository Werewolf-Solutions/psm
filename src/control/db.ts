/**
 * The control service's own database. Deliberately separate from the local
 * cockpit's psm.db: the control service is multi-workspace and runs where the
 * operator's machine is not, so nothing here may assume a single owner.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE runners (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     name TEXT NOT NULL,
     credential_hash TEXT NOT NULL,
     capabilities TEXT NOT NULL CHECK(json_valid(capabilities)),
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER,
     revoked_at INTEGER
   );
   CREATE INDEX runners_workspace ON runners(workspace_id);
   CREATE TABLE runner_registrations (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     token_hash TEXT NOT NULL,
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at INTEGER
   );
   CREATE TABLE jobs (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     state TEXT NOT NULL CHECK(state IN ('queued','leased','running','succeeded','failed','cancelled','uncertain')),
     spec TEXT NOT NULL CHECK(json_valid(spec)),
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     runner_id TEXT,
     lease_expires_at INTEGER,
     started_at INTEGER,
     finished_at INTEGER,
     cancel_requested INTEGER NOT NULL DEFAULT 0,
     result TEXT CHECK(result IS NULL OR json_valid(result))
   );
   CREATE INDEX jobs_queue ON jobs(workspace_id, state, created_at);
   CREATE TABLE job_events (
     job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     PRIMARY KEY (job_id, seq)
   );
   CREATE TABLE secrets (
     workspace_id TEXT NOT NULL,
     name TEXT NOT NULL,
     kind TEXT NOT NULL,
     sealed TEXT NOT NULL,
     fingerprint TEXT NOT NULL,
     created_by TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     verified_at INTEGER,
     verification TEXT,
     PRIMARY KEY (workspace_id, name)
   );
   CREATE TABLE enrollment_intents (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     purpose TEXT NOT NULL,
     binding TEXT NOT NULL CHECK(json_valid(binding)),
     token_hash TEXT NOT NULL,
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     claimed_at INTEGER,
     claim TEXT
   );
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     workspace_id TEXT NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     subject TEXT NOT NULL,
     at INTEGER NOT NULL
   );`,
];

export function openControlDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(file);
  if (file !== ":memory:") { try { fs.chmodSync(file, 0o600); } catch { /* filesystem without modes */ } }
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA foreign_keys = ON");
  const version = Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  for (let index = version; index < MIGRATIONS.length; index++) {
    database.exec("BEGIN");
    try {
      database.exec(MIGRATIONS[index]);
      database.exec(`PRAGMA user_version = ${index + 1}`);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }
  return database;
}
