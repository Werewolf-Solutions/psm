/**
 * Workrooms — a place to work on several projects at once.
 *
 * A project's AI can already be pointed at another repository (see the scope
 * picker in its drawer), but that conversation still *belongs* to one project:
 * it is filed under it, it is the same thread as everything else that project
 * has been asked, and the second repository is a setting on it. When the work
 * itself spans two codebases — a contract on one side, its caller on the other —
 * that is the wrong shape. The conversation belongs to the work, not to whichever
 * repository it happened to start in.
 *
 * So a workroom is its own thing: a title, an objective, an ordered list of
 * member projects, and one AI conversation scoped to exactly those. It is
 * deliberately not a project — it has no run command, no logs, no deploy, and
 * nothing to preview. What it has is a chat that can edit every member and
 * nothing else.
 *
 * Membership is stored as project *names*, which is what the rest of psm keys on
 * (notes, overrides, plans). Paths are resolved from the current scan at the
 * moment they are needed, so a project renamed or unlinked since drops out of
 * the room's scope rather than pointing the AI at whatever now sits at a
 * remembered path.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { db } from "./db.ts";

export class WorkSessionValidationError extends Error {}
export class WorkSessionNotFoundError extends Error {}

export interface WorkSession {
  id: string;
  title: string;
  objective: string;
  /** The member the AI starts in. Always the first entry of `projects`. */
  primaryProject: string;
  projects: string[];
  engine: string;
  model: string | null;
  effort: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

const MAX_TITLE = 200;
const MAX_OBJECTIVE = 4_000;
const MAX_PROJECTS = 8;
const MIN_PROJECTS = 2;
const MAX_ROOMS = 200;

/** The session key the AI module files this room's conversation under. */
export const workSessionKey = (id: string): string => `__psm_work__:${id}`;

const ID_PATTERN = /^wrk_[0-9a-f]{12}$/;
const newId = () => `wrk_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

export function parseWorkSessionId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!ID_PATTERN.test(id)) throw new WorkSessionValidationError("not a workroom id");
  return id;
}

function parseTitle(value: unknown, fallback: string): string {
  const title = String(value ?? "").trim();
  return (title || fallback).slice(0, MAX_TITLE);
}

/**
 * The members, in the order they were given.
 *
 * `known` is the current scan: a room can only be built from projects psm can
 * actually see, so a typo or a stale name is refused at creation rather than
 * discovered as a missing directory on the first turn. Order carries meaning —
 * the first member is where the AI starts — so duplicates collapse toward their
 * first mention rather than being sorted away.
 */
function parseProjects(value: unknown, known: ReadonlySet<string>): string[] {
  const raw = Array.isArray(value) ? value : [];
  const names: string[] = [];
  for (const entry of raw) {
    const name = String(entry ?? "").trim();
    if (!name || names.includes(name)) continue;
    if (!known.has(name)) {
      throw new WorkSessionValidationError(`no project named ${name}`);
    }
    names.push(name);
  }
  if (names.length < MIN_PROJECTS) {
    throw new WorkSessionValidationError("a workroom needs at least two projects");
  }
  if (names.length > MAX_PROJECTS) {
    throw new WorkSessionValidationError(`a workroom holds at most ${MAX_PROJECTS} projects`);
  }
  return names;
}

interface WorkSessionRow {
  id: string;
  title: string;
  objective: string;
  primary_project: string;
  engine: string;
  model: string | null;
  effort: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

const SELECT =
  "SELECT id, title, objective, primary_project, engine, model, effort, created_at, updated_at, archived_at FROM work_sessions";

export class WorkSessionStore {
  #db: DatabaseSync | null;

  /** Tests pass their own database; the server takes psm's. */
  constructor(database: DatabaseSync | null = null) {
    this.#db = database;
  }

  private get database(): DatabaseSync {
    return this.#db ?? db();
  }

  private members(id: string): string[] {
    const rows = this.database
      .prepare("SELECT project FROM work_session_projects WHERE session_id = ? ORDER BY position")
      .all(id) as unknown as { project: string }[];
    return rows.map((row) => row.project);
  }

  private hydrate(row: WorkSessionRow): WorkSession {
    return {
      id: row.id,
      title: row.title,
      objective: row.objective,
      primaryProject: row.primary_project,
      projects: this.members(row.id),
      engine: row.engine,
      model: row.model,
      effort: row.effort,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
    };
  }

  /** Open rooms, most recently touched first. */
  list({ includeArchived = false } = {}): WorkSession[] {
    const where = includeArchived ? "" : " WHERE archived_at IS NULL";
    const rows = this.database
      .prepare(`${SELECT}${where} ORDER BY updated_at DESC, rowid DESC`)
      .all() as unknown as WorkSessionRow[];
    return rows.map((row) => this.hydrate(row));
  }

  get(id: string): WorkSession {
    const row = this.database.prepare(`${SELECT} WHERE id = ?`).get(parseWorkSessionId(id)) as
      | WorkSessionRow
      | undefined;
    if (!row) throw new WorkSessionNotFoundError("no such workroom");
    return this.hydrate(row);
  }

  create(value: unknown, known: ReadonlySet<string>): WorkSession {
    const raw = (value ?? {}) as Record<string, unknown>;
    // Validate before writing, so a rejected room leaves nothing behind.
    const projects = parseProjects(raw.projects, known);
    const title = parseTitle(raw.title, projects.join(" ↔ "));
    const objective = String(raw.objective ?? "").trim().slice(0, MAX_OBJECTIVE);
    const engine = raw.engine === "codex" ? "codex" : "claude";
    const model = String(raw.model ?? "").trim() || null;
    const effort = String(raw.effort ?? "").trim().toLowerCase() || null;

    const { count } = this.database
      .prepare("SELECT COUNT(*) AS count FROM work_sessions WHERE archived_at IS NULL")
      .get() as { count: number };
    if (count >= MAX_ROOMS) {
      throw new WorkSessionValidationError("too many open workrooms — archive one first");
    }

    const now = Date.now();
    const id = newId();
    this.database.exec("BEGIN");
    try {
      this.database
        .prepare(
          `INSERT INTO work_sessions
             (id, title, objective, primary_project, engine, model, effort, created_at, updated_at, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(id, title, objective, projects[0], engine, model, effort, now, now);
      const member = this.database.prepare(
        "INSERT INTO work_session_projects (session_id, project, position) VALUES (?, ?, ?)",
      );
      projects.forEach((project, position) => member.run(id, project, position));
      this.database.exec("COMMIT");
    } catch (err) {
      this.database.exec("ROLLBACK");
      throw err;
    }
    return this.get(id);
  }

  /** Bump `updated_at`, so the list is ordered by what is actually being worked on. */
  touch(id: string): void {
    this.database
      .prepare("UPDATE work_sessions SET updated_at = ? WHERE id = ?")
      .run(Date.now(), parseWorkSessionId(id));
  }

  archive(id: string): WorkSession {
    const session = this.get(id);
    this.database
      .prepare("UPDATE work_sessions SET archived_at = ?, updated_at = ? WHERE id = ?")
      .run(Date.now(), Date.now(), session.id);
    return this.get(session.id);
  }

  /** Rooms a project belongs to — so the cockpit can say where else it is in use. */
  forProject(project: string): WorkSession[] {
    const rows = this.database
      .prepare(
        `${SELECT} WHERE archived_at IS NULL AND id IN
           (SELECT session_id FROM work_session_projects WHERE project = ?)
         ORDER BY updated_at DESC`,
      )
      .all(project) as unknown as WorkSessionRow[];
    return rows.map((row) => this.hydrate(row));
  }
}

export const workSessions = new WorkSessionStore();
