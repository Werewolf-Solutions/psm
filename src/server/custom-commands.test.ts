import assert from "node:assert/strict";
import test from "node:test";
import type { Project } from "../types.ts";
import { customCommandId, validateCustomCommands } from "./custom-commands.ts";

const id = "12345678-1234-1234-1234-123456789abc";
const projects = [{ name: "todo-app" }, { name: "werewolf-dapp" }] as Project[];
const command = { id, name: "Werewolf API", directory: "werewolf-dapp", command: "npm run server" };

test("saved commands resolve only to linked project directories", () => {
  assert.deepEqual(validateCustomCommands([command], projects), [command]);
  assert.throws(() => validateCustomCommands([{ ...command, directory: "../private" }], projects), /linked project directory/);
  assert.throws(() => validateCustomCommands([command, command], projects), /duplicate/);
});

test("custom command kinds use validated IDs", () => {
  assert.equal(customCommandId(`custom:${id}`), id);
  assert.equal(customCommandId("custom:../../run"), null);
  assert.equal(customCommandId("run"), null);
});
