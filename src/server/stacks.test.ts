import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { migrate } from "./db.ts";
import { StackStore } from "./stacks.ts";

function store() {
  const database = new DatabaseSync(":memory:");
  migrate(database);
  return new StackStore(() => database);
}

test("create, list, update and remove a stack across projects", () => {
  const stacks = store();
  const todo = stacks.create({ title: "Todo work", units: [{ project: "werewolf-dapp", unit: "server/dev" }, { project: "todo-app", unit: "client/dev" }, { project: "todo-app", unit: "client/dev" }] }, 1);
  assert.match(todo.id, /^stk_[0-9a-f]{12}$/);
  assert.equal(todo.units.length, 2, "a unit listed twice is kept once");
  stacks.create({ title: "Feedback loop", units: [{ project: "feedback-hub", unit: "dev" }] }, 2);
  assert.deepEqual(stacks.list().map((stack) => stack.title), ["Feedback loop", "Todo work"]);

  const updated = stacks.update(todo.id, { title: "Todo + API", units: [{ project: "todo-app", unit: "client/dev" }] }, 5);
  assert.equal(updated.updatedAt, 5);
  assert.equal(updated.createdAt, 1);
  assert.deepEqual(stacks.get(todo.id)!.units, [{ project: "todo-app", unit: "client/dev" }]);

  assert.equal(stacks.remove(todo.id), true);
  assert.equal(stacks.get(todo.id), null);
  assert.equal(stacks.remove("stk_000000000000"), false);
});

test("refuses bad titles, empty or invalid units, and unknown ids", () => {
  const stacks = store();
  assert.throws(() => stacks.create({ title: "", units: [{ project: "a", unit: "dev" }] }), /Name the stack/);
  assert.throws(() => stacks.create({ title: "<script>", units: [{ project: "a", unit: "dev" }] }), /Name the stack/);
  assert.throws(() => stacks.create({ title: "Ok", units: [] }), /1-30/);
  assert.throws(() => stacks.create({ title: "Ok", units: [{ project: "a", unit: "x::y" }] }), /Invalid unit/);
  assert.throws(() => stacks.update("stk_000000000000", { title: "Ok", units: [{ project: "a", unit: "dev" }] }), /Unknown stack/);
  assert.equal(stacks.get("../etc"), null);
});
