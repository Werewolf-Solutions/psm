import assert from "node:assert/strict";
import test from "node:test";
import { effortArgs } from "./ai.ts";
import { fallbackCatalog, normalizeClaudeModels, normalizeCodexModels } from "./models.ts";
import { newerStableVersion } from "./provider-health.ts";

test("discovery failures never invent available models or effort levels", () => {
  for (const engine of ["claude", "codex"] as const) {
    const catalog = fallbackCatalog(engine, new Error("offline"));
    assert.deepEqual(catalog.models, []);
    assert.deepEqual(catalog.effortLevels, []);
    assert.equal(catalog.source, "fallback");
    assert.equal(catalog.message, "offline");
  }
});

test("future model and effort names pass through in provider order", () => {
  const models = normalizeCodexModels([
    { model: "future-b", supportedReasoningEfforts: ["new-effort", { reasoningEffort: "ultradeep" }] },
    { model: "future-a" },
  ]);
  assert.deepEqual(models.map((model) => model.id), ["future-b", "future-a"]);
  assert.deepEqual(models[0].effortLevels, ["new-effort", "ultradeep"]);
  assert.deepEqual(models[1].effortLevels, []);
  const [claude] = normalizeClaudeModels([{
    value: "future-alias", supportsEffort: true, supportedEffortLevels: ["future-effort"],
  } as any]);
  assert.equal(claude.id, "future-alias");
  assert.deepEqual(claude.effortLevels, ["future-effort"]);
});

test("update checks compare numeric versions and leave prereleases unknown", () => {
  assert.equal(newerStableVersion("1.9.0", "1.10.0"), true);
  assert.equal(newerStableVersion("2.0.0", "1.99.0"), false);
  assert.equal(newerStableVersion("2.1.2", "2.1.2"), false);
  assert.equal(newerStableVersion("2.1.2-beta.1", "2.1.2"), null);
  assert.equal(newerStableVersion("unknown", "2.1.2"), null);
});

test("Claude model metadata exposes supported effort levels", () => {
  const [model] = normalizeClaudeModels([{
    value: "sonnet",
    displayName: "Sonnet",
    description: "Balanced model",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"],
    resolvedModel: "claude-sonnet-current",
  } as any]);

  assert.deepEqual(model, {
    id: "sonnet",
    resolvedModel: "claude-sonnet-current",
    label: "Sonnet",
    description: "Balanced model",
    effortLevels: ["low", "high"],
    defaultEffort: null,
    isDefault: false,
  });
});

test("Codex model metadata exposes its default reasoning effort", () => {
  const [model] = normalizeCodexModels([{
    model: "gpt-current",
    displayName: "GPT Current",
    supportedReasoningEfforts: [
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
    ],
    defaultReasoningEffort: "medium",
    isDefault: true,
  }]);

  assert.equal(model.id, "gpt-current");
  assert.deepEqual(model.effortLevels, ["medium", "high"]);
  assert.equal(model.defaultEffort, "medium");
  assert.equal(model.isDefault, true);
});

test("effort values become provider-specific CLI arguments", () => {
  assert.deepEqual(effortArgs("claude", "high"), ["--effort", "high"]);
  assert.deepEqual(effortArgs("codex", "xhigh"), [
    "-c",
    'model_reasoning_effort="xhigh"',
  ]);
  assert.deepEqual(effortArgs("codex", null), []);
  assert.deepEqual(effortArgs("claude", "not valid"), []);
});
