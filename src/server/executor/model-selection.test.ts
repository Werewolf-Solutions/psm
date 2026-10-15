import assert from "node:assert/strict";
import test from "node:test";
import { chooseAutoModel, resolveJobModel } from "./model-selection.ts";
import type { AiModelCatalog, AiModelOption } from "../models.ts";

const option = (id: string, effortLevels: string[] = []): AiModelOption => ({
  id, resolvedModel: null, label: id, description: "", effortLevels,
  defaultEffort: null, isDefault: false,
});
const models = [option("claude-haiku"), option("claude-sonnet"), option("claude-opus")];
const discover = async (): Promise<AiModelCatalog> => ({ engine: "claude", models, effortLevels: [], source: "live", updatedAt: 0, message: null });

test("Auto chooses the task-size tier within the project's provider", async () => {
  assert.equal(chooseAutoModel(models, "S")?.id, "claude-haiku");
  assert.equal(chooseAutoModel(models, "M")?.id, "claude-sonnet");
  assert.equal(chooseAutoModel(models, "XL")?.id, "claude-opus");
  const chosen = await resolveJobModel({ selection: { mode: "auto" }, projectEngine: "claude", size: "S", cwd: ".", discover });
  assert.equal(chosen.model, "claude-haiku");
});

test("Manual model and effort must be offered by the installed provider", async () => {
  const withEffort = async (): Promise<AiModelCatalog> => ({ ...(await discover()), models: [option("claude-sonnet", ["low", "high"])] });
  const chosen = await resolveJobModel({ selection: { mode: "manual", engine: "claude", model: "claude-sonnet", effort: "high" }, projectEngine: "codex", cwd: ".", discover: withEffort });
  assert.equal(chosen.engine, "claude");
  await assert.rejects(resolveJobModel({ selection: { mode: "manual", engine: "claude", model: "missing", effort: null }, projectEngine: "codex", cwd: ".", discover: withEffort }), /unavailable/);
  await assert.rejects(resolveJobModel({ selection: { mode: "manual", engine: "claude", model: "claude-sonnet", effort: "max" }, projectEngine: "codex", cwd: ".", discover: withEffort }), /does not support/);
});
