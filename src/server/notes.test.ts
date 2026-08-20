import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase } from "./db.ts";
import {
  NoteNotFoundError,
  NoteStore,
  NoteValidationError,
  importLegacyNotes,
} from "./notes.ts";

const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), "psm-notes-"));
const store = () => new NoteStore(openDatabase(":memory:"));

test("notes round-trip through the store, newest first", () => {
  const notes = store();
  notes.create("alpha", { kind: "bug", text: "the run button double-fires" });
  const idea = notes.create("alpha", { kind: "idea", text: "group the console by run" });

  const listed = notes.list("alpha");
  assert.equal(listed.length, 2);
  assert.equal(listed[0].id, idea.id, "the newest note is read first");
  assert.equal(listed[0].done, false);
  assert.deepEqual(
    listed.map((note) => note.kind).sort(),
    ["bug", "idea"],
  );
});

test("notes survive the process that wrote them", () => {
  const file = path.join(sandbox(), "psm.db");
  const written = new NoteStore(openDatabase(file)).create("alpha", {
    kind: "bug",
    text: "the run button double-fires",
  });

  // A second connection, as a restarted psm would open.
  const reopened = new NoteStore(openDatabase(file)).list("alpha");
  assert.deepEqual(reopened, [written]);
});

test("each project's notes stay its own", () => {
  const notes = store();
  notes.create("alpha", { kind: "bug", text: "alpha's bug" });
  notes.create("beta", { kind: "feature", text: "beta's feature" });

  assert.deepEqual(notes.list("alpha").map((n) => n.text), ["alpha's bug"]);
  assert.deepEqual(notes.list("beta").map((n) => n.text), ["beta's feature"]);
  assert.deepEqual(notes.list("never-written"), []);
});

test("a note can be edited, reclassified, closed and deleted", () => {
  const notes = store();
  const note = notes.create("alpha", { kind: "idea", text: "maybe a notes pane" });

  const edited = notes.update("alpha", note.id, { text: "definitely a notes pane" });
  assert.equal(edited.text, "definitely a notes pane");
  assert.equal(edited.createdAt, note.createdAt, "editing does not restart a note's life");

  assert.equal(notes.update("alpha", note.id, { kind: "feature" }).kind, "feature");
  assert.equal(notes.update("alpha", note.id, { done: true }).done, true);
  // A partial update leaves everything it did not mention alone.
  assert.equal(notes.list("alpha")[0].text, "definitely a notes pane");
  assert.equal(notes.list("alpha")[0].done, true);

  notes.remove("alpha", note.id);
  assert.deepEqual(notes.list("alpha"), []);
  assert.throws(() => notes.remove("alpha", note.id), NoteNotFoundError);
  assert.throws(() => notes.update("alpha", note.id, { text: "gone" }), NoteNotFoundError);
});

test("one project cannot read, edit or delete another's notes", () => {
  const notes = store();
  const note = notes.create("alpha", { kind: "bug", text: "alpha's bug" });

  assert.throws(() => notes.update("beta", note.id, { done: true }), NoteNotFoundError);
  assert.throws(() => notes.remove("beta", note.id), NoteNotFoundError);
  assert.equal(notes.list("alpha").length, 1, "alpha's note is untouched");
});

test("a note needs text and a kind the pane actually offers", () => {
  const notes = store();
  assert.throws(() => notes.create("alpha", { kind: "bug", text: "   " }), NoteValidationError);
  assert.throws(() => notes.create("alpha", { kind: "chore", text: "tidy up" }), NoteValidationError);
  assert.throws(() => notes.create("alpha", { text: "no kind at all" }), NoteValidationError);
  assert.deepEqual(notes.list("alpha"), [], "nothing invalid should have been written");
});

test("a note needs a project, and a project name is bounded", () => {
  const notes = store();
  for (const bad of ["", "   ", "x".repeat(201)]) {
    assert.throws(() => notes.create(bad, { kind: "bug", text: "x" }), NoteValidationError);
  }
  // A project name is a column now, not a filename, so an awkward one is fine.
  const note = notes.create("my app (2)", { kind: "bug", text: "still works" });
  assert.deepEqual(notes.list("my app (2)"), [note]);
});

test("notes written as files before the database are imported once", () => {
  const dir = sandbox();
  fs.writeFileSync(
    path.join(dir, "alpha.json"),
    JSON.stringify({
      project: "alpha",
      notes: [
        { id: "note_kept", kind: "bug", text: "written before the database", done: true,
          createdAt: 1, updatedAt: 2 },
        { id: "note_broken" }, // no text: not a note
        "a bare string",
      ],
    }),
  );
  fs.writeFileSync(path.join(dir, "beta.json"), "{ not json at all");

  const db = openDatabase(":memory:");
  assert.equal(importLegacyNotes(db, dir), 1, "the broken entries are skipped, not fatal");

  const notes = new NoteStore(db);
  assert.deepEqual(notes.list("alpha"), [
    { id: "note_kept", kind: "bug", text: "written before the database", done: true,
      createdAt: 1, updatedAt: 2 },
  ]);
  assert.deepEqual(notes.list("beta"), [], "an unreadable file imports as no notes, not a crash");

  // Importing again must not duplicate what is already there, nor resurrect a
  // note the user has since deleted.
  notes.remove("alpha", "note_kept");
  assert.equal(importLegacyNotes(db, dir), 0);
  assert.deepEqual(notes.list("alpha"), []);
});
