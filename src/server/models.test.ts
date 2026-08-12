import assert from "node:assert/strict";
import test from "node:test";
import { effortArgs } from "./ai.ts";
import { normalizeClaudeModels, normalizeCodexModels } from "./models.ts";

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
