/**
 * Workrooms: the record of which projects one conversation is allowed to touch.
 *
 * Membership decides scope, so the interesting cases are all about what cannot
 * get into the list — an unknown project, a single project, the same one twice.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "./db.ts";
import {
  WorkSessionNotFoundError,
  WorkSessionStore,
  WorkSessionValidationError,
  parseWorkSessionId,
  workSessionKey,
} from "./work-sessions.ts";

const known = new Set(["todo-app", "werewolf-dapp", "psm", "bystander"]);
const store = () => new WorkSessionStore(openDatabase(":memory:"));

test("a room keeps its projects in the order they were given", () => {
  const s = store();
  const room = s.create({ projects: ["werewolf-dapp", "todo-app"] }, known);
  assert.deepEqual(room.projects, ["werewolf-dapp", "todo-app"]);
  assert.equal(room.primaryProject, "werewolf-dapp", "the AI starts in the first member");
  assert.equal(room.title, "werewolf-dapp ↔ todo-app", "an unnamed room names itself after its members");
});

test("a room needs more than one project", () => {
  const s = store();
  assert.throws(
    () => s.create({ projects: ["todo-app"] }, known),
    WorkSessionValidationError,
    "one project is a project, not a room",
  );
});

test("a project psm cannot see is refused at creation", () => {
  const s = store();
  assert.throws(
    () => s.create({ projects: ["todo-app", "no-such-thing"] }, known),
    WorkSessionValidationError,
    "better to refuse the name than to discover a missing directory on the first turn",
  );
});

test("a refused room leaves nothing behind", () => {
  const s = store();
  try {
    s.create({ projects: ["todo-app", "ghost"] }, known);
  } catch {
    /* expected */
  }
  assert.deepEqual(s.list(), []);
});

test("the same project twice collapses toward its first mention", () => {
  const s = store();
  const room = s.create({ projects: ["todo-app", "werewolf-dapp", "todo-app"] }, known);
  assert.deepEqual(room.projects, ["todo-app", "werewolf-dapp"]);
});

test("a room survives being read back", () => {
  const s = store();
  const made = s.create(
    { projects: ["todo-app", "werewolf-dapp"], title: "Contract change", objective: "Add /v2/todos", engine: "codex" },
    known,
  );
  const read = s.get(made.id);
  assert.deepEqual(read, made);
  assert.equal(read.engine, "codex");
  assert.equal(read.objective, "Add /v2/todos");
});

test("archiving takes it out of the list without deleting it", () => {
  const s = store();
  const room = s.create({ projects: ["todo-app", "psm"] }, known);
  s.archive(room.id);
  assert.deepEqual(s.list(), [], "an archived room is off the list");
  assert.ok(s.get(room.id).archivedAt, "but it is still there, and still readable");
  assert.equal(s.list({ includeArchived: true }).length, 1);
});

test("rooms list by what was worked on most recently", async () => {
  const s = store();
  const first = s.create({ projects: ["todo-app", "psm"] }, known);
  await new Promise((resolve) => setTimeout(resolve, 5));
  s.create({ projects: ["werewolf-dapp", "psm"] }, known);
  await new Promise((resolve) => setTimeout(resolve, 5));
  s.touch(first.id);
  assert.equal(s.list()[0].id, first.id);
});

test("a project can say which rooms it is in", () => {
  const s = store();
  const room = s.create({ projects: ["todo-app", "werewolf-dapp"] }, known);
  s.create({ projects: ["psm", "bystander"] }, known);
  assert.deepEqual(
    s.forProject("todo-app").map((r) => r.id),
    [room.id],
  );
  assert.deepEqual(s.forProject("bystander").length, 1);
});

test("an unknown room is not found rather than empty", () => {
  const s = store();
  assert.throws(() => s.get("wrk_000000000000"), WorkSessionNotFoundError);
});

test("an id from a URL has to look like one", () => {
  assert.throws(() => parseWorkSessionId("../../etc"), WorkSessionValidationError);
  assert.throws(() => parseWorkSessionId("wrk_nothex"), WorkSessionValidationError);
  assert.equal(parseWorkSessionId("wrk_0123456789ab"), "wrk_0123456789ab");
});

test("the AI session key is namespaced away from every project name", () => {
  assert.equal(workSessionKey("wrk_abc"), "__psm_work__:wrk_abc");
});

test("a project can be added to a room after it is made", () => {
  const s = store();
  const room = s.create({ projects: ["todo-app", "werewolf-dapp"] }, known);
  const wider = s.setProjects(room.id, ["todo-app", "werewolf-dapp", "psm"], known);
  assert.deepEqual(wider.projects, ["todo-app", "werewolf-dapp", "psm"]);
  assert.equal(wider.primaryProject, "todo-app", "adding at the end leaves the start where it was");
});

test("removing the first project moves where the AI starts", () => {
  const s = store();
  const room = s.create({ projects: ["todo-app", "werewolf-dapp", "psm"] }, known);
  const narrower = s.setProjects(room.id, ["werewolf-dapp", "psm"], known);
  assert.deepEqual(narrower.projects, ["werewolf-dapp", "psm"]);
  assert.equal(narrower.primaryProject, "werewolf-dapp");
});

test("a room cannot be narrowed down to one project", () => {
  const s = store();
  const room = s.create({ projects: ["todo-app", "werewolf-dapp"] }, known);
  assert.throws(
    () => s.setProjects(room.id, ["todo-app"], known),
    WorkSessionValidationError,
  );
  assert.deepEqual(s.get(room.id).projects, ["todo-app", "werewolf-dapp"], "and the room is unchanged");
});

test("a project psm cannot see cannot be added either", () => {
  const s = store();
  const room = s.create({ projects: ["todo-app", "werewolf-dapp"] }, known);
  assert.throws(
    () => s.setProjects(room.id, ["todo-app", "werewolf-dapp", "ghost"], known),
    WorkSessionValidationError,
  );
  assert.deepEqual(s.get(room.id).projects, ["todo-app", "werewolf-dapp"]);
});

/**
 * Which AI a room runs.
 *
 * This is a setting, not a fact about the moment the room was created: a
 * conversation outlives any one provider's usage window, and being stuck on the
 * engine that was current at creation is how a room becomes unusable for hours.
 */
test("a room can be moved to the other engine", () => {
  const s = store();
  const room = s.create({ projects: ["todo-app", "psm"], engine: "codex", model: "gpt-5", effort: "high" }, known);
  const moved = s.setEngine(room.id, { engine: "claude" });
  assert.equal(moved.engine, "claude");
  assert.equal(moved.model, null, "a model names something only the previous engine has");
  assert.equal(moved.effort, null);
});

test("changing the model alone leaves the engine where it was", () => {
  const s = store();
  const room = s.create({ projects: ["todo-app", "psm"], engine: "codex", model: "gpt-5", effort: "high" }, known);
  const tuned = s.setEngine(room.id, { model: "gpt-5-codex" });
  assert.equal(tuned.engine, "codex");
  assert.equal(tuned.model, "gpt-5-codex");
  assert.equal(tuned.effort, "high", "an effort the caller never mentioned is not theirs to reset");
});

test("a room cannot be pointed at an engine psm does not run", () => {
  const s = store();
  const room = s.create({ projects: ["todo-app", "psm"], engine: "claude" }, known);
  assert.throws(() => s.setEngine(room.id, { engine: "gpt-4" }), WorkSessionValidationError);
  assert.equal(s.get(room.id).engine, "claude", "and the room is unchanged");
});

test("re-selecting the engine a room already runs keeps its model", () => {
  const s = store();
  const room = s.create({ projects: ["todo-app", "psm"], engine: "claude", model: "opus", effort: "high" }, known);
  const same = s.setEngine(room.id, { engine: "claude" });
  assert.equal(same.model, "opus", "this is not a switch, so nothing it named is stale");
  assert.equal(same.effort, "high");
});

test("preparation requirements persist through engine changes and cannot be set by room input", () => {
  const s = store();
  const room = s.create({ projects: ["todo-app"], engine: "claude" }, known, { preparation: true });
  assert.equal(room.permissionProfile, "deployment-preparation");
  assert.equal(s.setEngine(room.id, { engine: "codex" }).permissionProfile, "deployment-preparation");
  const ordinary = s.create({ projects: ["todo-app", "psm"], permissionProfile: "deployment-preparation" }, known);
  assert.equal(ordinary.permissionProfile, null);
});
