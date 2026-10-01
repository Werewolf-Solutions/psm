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
 * Still files, not a database: AI sessions, raw process/deployment logs and
 * backups. Those are documents or byte streams psm writes whole. Deployment
 * plans are different: approval, queueing, recovery and locking all depend on
 * several related facts changing atomically, so their structured state lives
 * here while their raw transcript remains a file.
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

  // 2 — workrooms: a place to work on several projects at once. The membership
  // is its own table rather than a JSON column, because "which rooms is this
  // project in" is a question the cockpit asks and a blob cannot answer.
  `CREATE TABLE work_sessions (
     id              TEXT PRIMARY KEY,
     title           TEXT NOT NULL,
     objective       TEXT NOT NULL DEFAULT '',
     primary_project TEXT NOT NULL,
     engine          TEXT NOT NULL DEFAULT 'claude',
     model           TEXT,
     effort          TEXT,
     created_at      INTEGER NOT NULL,
     updated_at      INTEGER NOT NULL,
     archived_at     INTEGER
   );
   CREATE TABLE work_session_projects (
     session_id TEXT NOT NULL REFERENCES work_sessions (id) ON DELETE CASCADE,
     project    TEXT NOT NULL,
     position   INTEGER NOT NULL,
     PRIMARY KEY (session_id, project)
   );
   CREATE INDEX work_session_projects_by_project ON work_session_projects (project);`,

  // 3 — managed deployment state. Repository manifests and plans are inputs,
  // but authority and execution are local state: connection bindings, policy,
  // approvals, leases and observations must never be inferred from a checkout
  // after the fact. JSON columns hold versioned documents and are guarded at
  // the relational boundary; secrets and raw provider responses never belong
  // in this database.
  `CREATE TABLE deployment_manifests (
     project_id     TEXT NOT NULL,
     checkout_id    TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     commit_sha     TEXT NOT NULL,
     digest         TEXT NOT NULL,
     schema_version INTEGER NOT NULL CHECK (schema_version > 0),
     document       TEXT NOT NULL CHECK (json_valid(document)),
     created_at     INTEGER NOT NULL,
     PRIMARY KEY (project_id, checkout_id, environment_id, commit_sha, digest)
   );
   CREATE INDEX deployment_manifests_by_digest
     ON deployment_manifests (digest);
   CREATE INDEX deployment_manifests_by_source
     ON deployment_manifests (project_id, checkout_id, environment_id, created_at DESC);

   CREATE TABLE deployment_connections (
     connection_id       TEXT PRIMARY KEY,
     kind                TEXT NOT NULL,
     label               TEXT NOT NULL,
     metadata_revision   INTEGER NOT NULL CHECK (metadata_revision > 0),
     secret_generation   INTEGER NOT NULL DEFAULT 0 CHECK (secret_generation >= 0),
     readiness           TEXT NOT NULL CHECK (readiness IN ('ready', 'missing-secret', 'invalid', 'unknown')),
     metadata            TEXT NOT NULL CHECK (json_valid(metadata)),
     constraints_document TEXT NOT NULL CHECK (json_valid(constraints_document)),
     created_at          INTEGER NOT NULL,
     updated_at          INTEGER NOT NULL CHECK (updated_at >= created_at)
   );
   CREATE INDEX deployment_connections_by_kind
     ON deployment_connections (kind, label);

   CREATE TABLE deployment_connection_bindings (
     project_id       TEXT NOT NULL,
     checkout_id      TEXT NOT NULL,
     environment_id   TEXT NOT NULL,
     slot             TEXT NOT NULL,
     connection_id    TEXT NOT NULL REFERENCES deployment_connections (connection_id) ON DELETE RESTRICT,
     binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
     created_at       INTEGER NOT NULL,
     updated_at       INTEGER NOT NULL CHECK (updated_at >= created_at),
     PRIMARY KEY (checkout_id, environment_id, slot)
   );
   CREATE INDEX deployment_connection_bindings_by_project
     ON deployment_connection_bindings (project_id, environment_id);
   CREATE INDEX deployment_connection_bindings_by_connection
     ON deployment_connection_bindings (connection_id);

   CREATE TABLE deployment_policies (
     scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'risk', 'project', 'environment', 'target')),
     scope_id   TEXT NOT NULL,
     revision   INTEGER NOT NULL CHECK (revision > 0),
     document   TEXT NOT NULL CHECK (json_valid(document)),
     created_at INTEGER NOT NULL,
     PRIMARY KEY (scope_kind, scope_id, revision)
   );
   CREATE INDEX deployment_policies_latest
     ON deployment_policies (scope_kind, scope_id, revision DESC);

   CREATE TABLE deployment_resource_bindings (
     project_id          TEXT NOT NULL,
     environment_id      TEXT NOT NULL,
     resource_id         TEXT NOT NULL,
     connection_id       TEXT NOT NULL REFERENCES deployment_connections (connection_id) ON DELETE RESTRICT,
     provider_account    TEXT NOT NULL,
     provider_object_id  TEXT NOT NULL,
     observed_fingerprint TEXT NOT NULL,
     binding_revision    INTEGER NOT NULL CHECK (binding_revision > 0),
     bound_at            INTEGER NOT NULL,
     updated_at          INTEGER NOT NULL CHECK (updated_at >= bound_at),
     PRIMARY KEY (project_id, environment_id, resource_id),
     UNIQUE (provider_account, provider_object_id)
   );
   CREATE INDEX deployment_resource_bindings_by_connection
     ON deployment_resource_bindings (connection_id);

   CREATE TABLE deployment_artifacts (
     psm_artifact_id     TEXT PRIMARY KEY,
     producing_run_id    TEXT REFERENCES deployment_runs (run_id) ON DELETE RESTRICT,
     provenance          TEXT NOT NULL CHECK (provenance IN ('managed', 'external')),
     project_id          TEXT NOT NULL,
     kind                TEXT NOT NULL,
     source_repository   TEXT NOT NULL,
     github_artifact_id  TEXT NOT NULL,
     producer_run_id     TEXT NOT NULL,
     commit_sha          TEXT NOT NULL,
     version             TEXT NOT NULL,
     build_profile_digest TEXT NOT NULL,
     payload_algorithm   TEXT NOT NULL,
     payload_digest      TEXT NOT NULL,
     archive_digest      TEXT NOT NULL,
     provider_locator    TEXT NOT NULL CHECK (json_valid(provider_locator)),
     provenance_url      TEXT,
     created_at          INTEGER NOT NULL,
     retained_until      INTEGER NOT NULL CHECK (retained_until >= created_at),
     tombstoned_at       INTEGER,
     UNIQUE (source_repository, github_artifact_id),
     CHECK ((provenance = 'managed' AND producing_run_id IS NOT NULL)
       OR (provenance = 'external' AND producing_run_id IS NULL)),
     CHECK (tombstoned_at IS NULL OR tombstoned_at >= created_at)
   );
   CREATE INDEX deployment_artifacts_by_source
     ON deployment_artifacts (project_id, source_repository, commit_sha, created_at DESC);
   CREATE INDEX deployment_artifacts_by_retention
     ON deployment_artifacts (retained_until) WHERE tombstoned_at IS NULL;

   CREATE TABLE deployment_plans (
     plan_id                    TEXT NOT NULL,
     revision                   INTEGER NOT NULL CHECK (revision > 0),
     digest                     TEXT NOT NULL,
     project_id                 TEXT NOT NULL,
     checkout_id                TEXT NOT NULL,
     environment_id             TEXT NOT NULL,
     operation                  TEXT NOT NULL CHECK (operation IN ('reconcile', 'release', 'deploy', 'rollback', 'adopt')),
     risk                       TEXT NOT NULL CHECK (risk IN ('development', 'staging', 'production')),
     manifest_digest            TEXT NOT NULL,
     psm_artifact_id            TEXT REFERENCES deployment_artifacts (psm_artifact_id) ON DELETE RESTRICT,
     required_acknowledgements  TEXT NOT NULL CHECK (json_valid(required_acknowledgements)),
     blocked                    INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
     immutable_document         TEXT NOT NULL CHECK (json_valid(immutable_document)),
     created_at                 INTEGER NOT NULL,
     expires_at                 INTEGER NOT NULL CHECK (expires_at > created_at),
     superseded_at              INTEGER,
     PRIMARY KEY (plan_id, revision),
     UNIQUE (plan_id, revision, digest),
     CHECK (superseded_at IS NULL OR superseded_at >= created_at)
   );
   CREATE INDEX deployment_plans_by_project
     ON deployment_plans (project_id, environment_id, created_at DESC);
   CREATE INDEX deployment_plans_runnable
     ON deployment_plans (expires_at) WHERE blocked = 0 AND superseded_at IS NULL;

   CREATE TABLE deployment_plan_actions (
     plan_id             TEXT NOT NULL,
     plan_revision       INTEGER NOT NULL,
     ordinal             INTEGER NOT NULL CHECK (ordinal >= 0),
     action_id           TEXT NOT NULL,
     action_digest       TEXT NOT NULL,
     kind                TEXT NOT NULL,
     phase               TEXT NOT NULL,
     side_effecting      INTEGER NOT NULL CHECK (side_effecting IN (0, 1)),
     preconditions       TEXT NOT NULL CHECK (json_valid(preconditions)),
     immutable_document  TEXT NOT NULL CHECK (json_valid(immutable_document)),
     PRIMARY KEY (plan_id, plan_revision, ordinal),
     UNIQUE (plan_id, plan_revision, action_id),
     FOREIGN KEY (plan_id, plan_revision)
       REFERENCES deployment_plans (plan_id, revision) ON DELETE CASCADE
   );

   CREATE TABLE deployment_approvals (
     approval_id        TEXT PRIMARY KEY,
     plan_id            TEXT NOT NULL,
     plan_revision      INTEGER NOT NULL,
     plan_digest        TEXT NOT NULL,
     risk               TEXT NOT NULL CHECK (risk IN ('development', 'staging', 'production')),
     actor_kind         TEXT NOT NULL CHECK (actor_kind IN ('local-operator', 'werewolf-user')),
     actor_subject      TEXT,
     agent_id           TEXT NOT NULL,
     origin             TEXT NOT NULL CHECK (origin IN ('local', 'paired')),
     acknowledgement_ids TEXT NOT NULL CHECK (json_valid(acknowledgement_ids)),
     approved_at        INTEGER NOT NULL,
     expires_at         INTEGER NOT NULL CHECK (expires_at > approved_at),
     consumed_at        INTEGER NOT NULL CHECK (consumed_at >= approved_at),
     UNIQUE (plan_id, plan_revision, plan_digest),
     FOREIGN KEY (plan_id, plan_revision, plan_digest)
       REFERENCES deployment_plans (plan_id, revision, digest) ON DELETE RESTRICT
   );

   CREATE TABLE deployment_runs (
     run_id             TEXT PRIMARY KEY,
     run_kind           TEXT NOT NULL CHECK (run_kind IN ('prepare', 'deployment')),
     project_id         TEXT NOT NULL,
     environment_id     TEXT,
     operation          TEXT NOT NULL CHECK (operation IN ('prepare', 'reconcile', 'release', 'deploy', 'rollback', 'adopt')),
     plan_id            TEXT,
     plan_revision      INTEGER,
     plan_digest        TEXT,
     approval_id        TEXT UNIQUE REFERENCES deployment_approvals (approval_id) ON DELETE RESTRICT,
     artifact_run_id    TEXT REFERENCES deployment_runs (run_id) ON DELETE RESTRICT,
     state              TEXT NOT NULL CHECK (state IN ('queued', 'acquiring-locks', 'checking-preconditions', 'reconciling', 'dispatching', 'waiting-executor', 'observing-result', 'importing-artifact', 'verifying', 'interrupting', 'recovery-required', 'succeeded', 'failed', 'cancelled', 'interrupted', 'stale-plan', 'rolled-back')),
     phase              TEXT NOT NULL,
     audit_degraded     INTEGER NOT NULL DEFAULT 0 CHECK (audit_degraded IN (0, 1)),
     cancellation_requested_at INTEGER,
     recovery_reason    TEXT,
     raw_log_path       TEXT,
     created_at         INTEGER NOT NULL,
     updated_at         INTEGER NOT NULL CHECK (updated_at >= created_at),
     started_at         INTEGER,
     finished_at        INTEGER,
     FOREIGN KEY (plan_id, plan_revision, plan_digest)
       REFERENCES deployment_plans (plan_id, revision, digest) ON DELETE RESTRICT,
     CHECK ((run_kind = 'prepare' AND plan_id IS NULL AND plan_revision IS NULL AND plan_digest IS NULL AND approval_id IS NULL)
       OR (run_kind = 'deployment' AND plan_id IS NOT NULL AND plan_revision IS NOT NULL AND plan_digest IS NOT NULL AND approval_id IS NOT NULL)),
     CHECK (finished_at IS NULL OR finished_at >= created_at)
   );
   CREATE INDEX deployment_runs_by_project
     ON deployment_runs (project_id, environment_id, created_at DESC);
   CREATE INDEX deployment_runs_recovery
     ON deployment_runs (state, updated_at);

   CREATE TABLE deployment_run_steps (
     run_id             TEXT NOT NULL REFERENCES deployment_runs (run_id) ON DELETE CASCADE,
     ordinal            INTEGER NOT NULL CHECK (ordinal >= 0),
     step_id            TEXT NOT NULL,
     action_digest      TEXT NOT NULL,
     adapter_kind       TEXT NOT NULL,
     idempotency_key    TEXT NOT NULL UNIQUE,
     state              TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'observed', 'completed', 'failed', 'cancelled', 'recovery-required')),
     external_id        TEXT,
     preconditions      TEXT NOT NULL CHECK (json_valid(preconditions)),
     intent             TEXT NOT NULL CHECK (json_valid(intent)),
     result             TEXT CHECK (result IS NULL OR json_valid(result)),
     prepared_at        INTEGER NOT NULL,
     submitted_at       INTEGER,
     observed_at        INTEGER,
     completed_at       INTEGER,
     updated_at         INTEGER NOT NULL CHECK (updated_at >= prepared_at),
     PRIMARY KEY (run_id, ordinal),
     UNIQUE (run_id, step_id),
     UNIQUE (adapter_kind, external_id)
   );
   CREATE INDEX deployment_run_steps_by_state
     ON deployment_run_steps (state, updated_at);

   CREATE TABLE deployment_events (
     run_id       TEXT NOT NULL REFERENCES deployment_runs (run_id) ON DELETE CASCADE,
     sequence     INTEGER NOT NULL CHECK (sequence > 0),
     occurred_at  INTEGER NOT NULL,
     event_type   TEXT NOT NULL,
     phase        TEXT NOT NULL,
     level        TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
     message      TEXT NOT NULL,
     payload      TEXT NOT NULL CHECK (json_valid(payload)),
     PRIMARY KEY (run_id, sequence)
   );

   CREATE TABLE deployment_target_locks (
     lock_key         TEXT PRIMARY KEY,
     owner_run_id     TEXT NOT NULL REFERENCES deployment_runs (run_id) ON DELETE RESTRICT,
     owner_boot_id    TEXT NOT NULL,
     acquired_at      INTEGER NOT NULL,
     heartbeat_at     INTEGER NOT NULL CHECK (heartbeat_at >= acquired_at),
     lease_expires_at INTEGER NOT NULL CHECK (lease_expires_at > heartbeat_at)
   );
   CREATE INDEX deployment_target_locks_by_owner
     ON deployment_target_locks (owner_run_id);
   CREATE INDEX deployment_target_locks_by_expiry
     ON deployment_target_locks (lease_expires_at);

   CREATE TABLE deployment_releases (
     release_id          TEXT PRIMARY KEY,
     psm_artifact_id     TEXT NOT NULL REFERENCES deployment_artifacts (psm_artifact_id) ON DELETE RESTRICT,
     activation_run_id   TEXT REFERENCES deployment_runs (run_id) ON DELETE RESTRICT,
     target_id           TEXT NOT NULL,
     project_id          TEXT NOT NULL,
     environment_id      TEXT NOT NULL,
     unit_id             TEXT NOT NULL,
     previous_release_id TEXT REFERENCES deployment_releases (release_id) ON DELETE RESTRICT,
     provenance          TEXT NOT NULL CHECK (provenance IN ('managed', 'external')),
     target_contract_digest TEXT NOT NULL,
     receipt             TEXT NOT NULL CHECK (json_valid(receipt)),
     activated_at        INTEGER NOT NULL,
     deactivated_at      INTEGER,
     tombstoned_at       INTEGER,
     UNIQUE (target_id, release_id),
     CHECK ((provenance = 'managed' AND activation_run_id IS NOT NULL)
       OR (provenance = 'external' AND activation_run_id IS NULL)),
     CHECK (deactivated_at IS NULL OR deactivated_at >= activated_at),
     CHECK (tombstoned_at IS NULL OR tombstoned_at >= activated_at)
   );
   CREATE UNIQUE INDEX deployment_releases_one_active
     ON deployment_releases (target_id)
     WHERE deactivated_at IS NULL AND tombstoned_at IS NULL;
   CREATE INDEX deployment_releases_by_unit
     ON deployment_releases (project_id, environment_id, unit_id, activated_at DESC);

   CREATE TABLE deployment_watch_snapshots (
     monitor_id       TEXT NOT NULL,
     project_id       TEXT NOT NULL,
     environment_id   TEXT NOT NULL,
     unit_id          TEXT NOT NULL,
     provider_state   TEXT NOT NULL,
     freshness        TEXT NOT NULL CHECK (freshness IN ('fresh', 'stale', 'missing')),
     effective_state  TEXT NOT NULL CHECK (effective_state IN ('healthy', 'down', 'degraded', 'unknown', 'stale', 'not-monitored')),
     observed_at      INTEGER NOT NULL,
     ingested_at      INTEGER NOT NULL CHECK (ingested_at >= observed_at),
     normalized_state TEXT NOT NULL CHECK (json_valid(normalized_state)),
     PRIMARY KEY (monitor_id, environment_id, unit_id)
   );
   CREATE INDEX deployment_watch_snapshots_by_project
     ON deployment_watch_snapshots (project_id, environment_id, unit_id);`,
  // Tracks automatic preparation across page reloads and agent restarts.
  `CREATE TABLE deployment_preparations (
     project_id TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     document TEXT NOT NULL,
     PRIMARY KEY (project_id, environment_id)
   );`,
  // Project permissions are local operator authority, never repository metadata.
  `CREATE TABLE agent_permissions (
     project_id TEXT NOT NULL, checkout TEXT NOT NULL,
     revision INTEGER NOT NULL, grants TEXT NOT NULL CHECK(json_valid(grants)),
     PRIMARY KEY(project_id, checkout)
   );
   CREATE TABLE agent_permission_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id TEXT NOT NULL, checkout TEXT NOT NULL, revision INTEGER NOT NULL,
     permission TEXT NOT NULL, granted INTEGER NOT NULL CHECK(granted IN (0,1)),
     actor TEXT NOT NULL, at INTEGER NOT NULL
   );
   CREATE INDEX agent_permission_events_project ON agent_permission_events(project_id, checkout, revision);`,
  `ALTER TABLE work_sessions ADD COLUMN permission_profile TEXT;
   UPDATE work_sessions SET permission_profile = 'deployment-preparation'
     WHERE id IN (SELECT json_extract(document, '$.workroomId') FROM deployment_preparations);`,
  `CREATE TABLE agent_tool_requests (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)));`,
  `CREATE TABLE source_publication_plans (id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document)));`,
  // Machines are registered once per owning workspace; access is granted per
  // project environment and role, so one project never inherits another's.
  `CREATE TABLE machines (
     id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
     revision INTEGER NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)),
     UNIQUE(workspace_id, host, port)
   );
   CREATE TABLE machine_access (
     id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
     project_id TEXT NOT NULL, environment_id TEXT NOT NULL, role TEXT NOT NULL,
     revision INTEGER NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)),
     UNIQUE(machine_id, project_id, environment_id, role)
   );
   CREATE TABLE machine_setup_jobs (
     id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
     access_id TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL,
     document TEXT NOT NULL CHECK(json_valid(document))
   );
   CREATE INDEX machine_setup_jobs_machine ON machine_setup_jobs(machine_id, updated_at DESC);`,
  // Scoped Allow/Ask/Deny rules beside the standing grants. Existing grants are
  // untouched, so migrated projects keep exactly the authority they had.
  // restricted_revision is the last revision that reduced authority; only those
  // invalidate running turns, so granting or approving more never kills a task.
  `ALTER TABLE agent_permissions ADD COLUMN rules TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(rules));
   ALTER TABLE agent_permissions ADD COLUMN restricted_revision INTEGER NOT NULL DEFAULT 0;
   UPDATE agent_permissions SET restricted_revision = revision;`,
  // Runtime secrets of a managed service live in the secret store under an owner
  // that is not a connection; their generation (never a value) is kept here so
  // changing one invalidates approved plans like a credential change does.
  `CREATE TABLE deployment_service_secret_generations (
     owner TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation >= 0), updated_at INTEGER NOT NULL
   );`,
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
