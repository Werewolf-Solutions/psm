/**
 * Project notes — the scratchpad the cockpit keeps beside each project.
 *
 * This pane used to be Todos: a read-only mirror of the Werewolf board, which
 * could show what was already tracked but could not take down the thing you
 * just noticed. Notes is the other half of that, and the half psm was missing —
 * a bug you hit while the dev server was still printing the stack trace, a
 * feature the project is obviously asking for, a thought worth keeping.
 *
 * Local, deliberately. A note is worth writing only if writing it is instant,
 * and that rules out a round trip to a cloud board that a signed-out psm cannot
 * reach anyway. Notes started as one JSON file per project and now live in
 * psm's own database (see `db.ts`): the whole file no longer has to be rewritten
 * to tick one checkbox, and "every open bug I have" is a query rather than a
 * directory walk. Notes written under the old scheme are imported on first open.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { db, readMeta, writeMeta } from "./db.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** What a note is about. The three the pane was asked for, and nothing else. */
export const NOTE_KINDS = ["bug", "feature", "idea"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export interface Note {
  id: string;
  kind: NoteKind;
  text: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

export class NoteValidationError extends Error {}
export class NoteNotFoundError extends Error {}

const MAX_TEXT = 10_000;
const MAX_NOTES = 2_000;
const MAX_PROJECT = 200;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Which project a note belongs to. This used to be a filename, so it had to
 * survive being pasted into a path; now it is a column, and a project called
 * "my app" can hold notes like any other. It is still bounded, because it
 * arrives from a request.
 */
function parseProject(value: unknown): string {
  const project = String(value ?? "").trim();
  if (!project) throw new NoteValidationError("a note needs a project");
  if (project.length > MAX_PROJECT) throw new NoteValidationError("project name is too long");
  return project;
}

export function parseKind(value: unknown, fallback: NoteKind | null = null): NoteKind {
  const kind = String(value ?? "").trim().toLowerCase();
  if ((NOTE_KINDS as readonly string[]).includes(kind)) return kind as NoteKind;
  if (fallback) return fallback;
  throw new NoteValidationError(`a note's kind must be one of ${NOTE_KINDS.join(", ")}`);
}

function parseText(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) throw new NoteValidationError("a note needs some text");
  return text.slice(0, MAX_TEXT);
}

const newId = () => `note_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

interface NoteRow {
  id: string;
  kind: string;
  text: string;
  done: number;
  created_at: number;
  updated_at: number;
}

const fromRow = (row: NoteRow): Note => ({
  id: row.id,
  kind: parseKind(row.kind, "idea"),
  text: row.text,
  done: row.done !== 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// Newest first: the pane is read from the top, and a note is written to be seen
// now rather than filed away. Two notes taken in the same millisecond fall back
// to insertion order, so a list never reshuffles itself between reads.
const SELECT = "SELECT id, kind, text, done, created_at, updated_at FROM notes";
const NEWEST_FIRST = "ORDER BY created_at DESC, rowid DESC";

export class NoteStore {
  #db: DatabaseSync | null;
  #imported: DatabaseSync | null = null;

  /** Tests pass their own database; the server takes psm's. */
  constructor(database: DatabaseSync | null = null) {
    this.#db = database;
  }

  /**
   * Resolved per call rather than cached, so this store follows psm's database
   * across a close and reopen. The one-time import of the old files runs once
   * per handle, on first use — never on import of this module, which would mean
   * creating a database just by mentioning notes.
   */
  private get database(): DatabaseSync {
    if (this.#db) return this.#db;
    const database = db();
    if (this.#imported !== database) {
      importLegacyNotes(database);
      this.#imported = database;
    }
    return database;
  }

  list(project: string): Note[] {
    const rows = this.database
      .prepare(`${SELECT} WHERE project = ? ${NEWEST_FIRST}`)
      .all(parseProject(project)) as unknown as NoteRow[];
    return rows.map(fromRow);
  }

  create(project: string, value: unknown): Note {
    const raw = (value ?? {}) as Record<string, unknown>;
    // Validate before touching the database, so a rejected note leaves no trace.
    const name = parseProject(project);
    const kind = parseKind(raw.kind);
    const text = parseText(raw.text);
    const { count } = this.database
      .prepare("SELECT COUNT(*) AS count FROM notes WHERE project = ?")
      .get(name) as { count: number };
    if (count >= MAX_NOTES) {
      throw new NoteValidationError(`a project can hold at most ${MAX_NOTES} notes`);
    }
    const now = Date.now();
    const note: Note = { id: newId(), kind, text, done: false, createdAt: now, updatedAt: now };
    this.database
      .prepare(
        `INSERT INTO notes (id, project, kind, text, done, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(note.id, name, note.kind, note.text, 0, now, now);
    return note;
  }

  update(project: string, id: string, value: unknown): Note {
    const raw = (value ?? {}) as Record<string, unknown>;
    const name = parseProject(project);
    const row = this.database
      .prepare(`${SELECT} WHERE project = ? AND id = ?`)
      .get(name, id) as unknown as NoteRow | undefined;
    if (!row) throw new NoteNotFoundError("note not found");
    const previous = fromRow(row);
    const updated: Note = {
      ...previous,
      ...(raw.kind === undefined ? {} : { kind: parseKind(raw.kind) }),
      ...(raw.text === undefined ? {} : { text: parseText(raw.text) }),
      ...(raw.done === undefined ? {} : { done: raw.done === true }),
      updatedAt: Date.now(),
    };
    this.database
      .prepare(`UPDATE notes SET kind = ?, text = ?, done = ?, updated_at = ? WHERE id = ?`)
      .run(updated.kind, updated.text, updated.done ? 1 : 0, updated.updatedAt, updated.id);
    return updated;
  }

  remove(project: string, id: string): void {
    const { changes } = this.database
      .prepare("DELETE FROM notes WHERE project = ? AND id = ?")
      .run(parseProject(project), id);
    if (!changes) throw new NoteNotFoundError("note not found");
  }
}

/* ---------- the notes that were written before there was a database ---------- */

const LEGACY_DIR =
  process.env.PSM_NOTES_DIR || path.resolve(__dirname, "..", "..", ".psm-notes");
const IMPORT_KEY = "notes.imported-from-files";

/** Drop anything that is not a well-formed note, rather than failing the import. */
function normalizeLegacy(value: unknown): Note | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  try {
    const createdAt = Number(raw.createdAt) || Date.now();
    return {
      id: ID_PATTERN.test(String(raw.id ?? "")) ? String(raw.id) : newId(),
      kind: parseKind(raw.kind, "idea"),
      text: parseText(raw.text),
      done: raw.done === true,
      createdAt,
      updatedAt: Number(raw.updatedAt) || createdAt,
    };
  } catch {
    return null;
  }
}

/**
 * Move `.psm-notes/<project>.json` into the database, once. The files are left
 * where they are — an import that ran against a half-written file should be
 * fixable by hand, and a stale directory costs nothing.
 *
 * Runs on the first read of the shared database, so upgrading psm is just
 * pulling and restarting.
 */
export function importLegacyNotes(database: DatabaseSync, dir: string = LEGACY_DIR): number {
  if (readMeta(database, IMPORT_KEY)) return 0;
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch {
    files = []; // nothing was ever written under the old scheme
  }
  let imported = 0;
  const insert = database.prepare(
    `INSERT OR IGNORE INTO notes (id, project, kind, text, done, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  database.exec("BEGIN");
  try {
    for (const file of files) {
      let notes: unknown[] = [];
      let project = path.basename(file, ".json");
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        if (typeof parsed?.project === "string" && parsed.project.trim()) project = parsed.project;
        notes = Array.isArray(parsed?.notes) ? parsed.notes : [];
      } catch {
        continue; // a file we cannot read is not worth failing the whole import
      }
      for (const value of notes) {
        const note = normalizeLegacy(value);
        if (!note) continue;
        const { changes } = insert.run(
          note.id,
          project.slice(0, MAX_PROJECT),
          note.kind,
          note.text,
          note.done ? 1 : 0,
          note.createdAt,
          note.updatedAt,
        );
        imported += changes ? 1 : 0;
      }
    }
    writeMeta(database, IMPORT_KEY, new Date().toISOString());
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
  return imported;
}

export const noteStore = new NoteStore();
