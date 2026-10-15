import type { AiEngine } from "../ai.ts";
import { modelCatalog, type AiModelOption } from "../models.ts";
import type { VerdictSize } from "../triage/verdict.ts";

export type JobSelection =
  | { mode: "auto" }
  | { mode: "manual"; engine: AiEngine; model: string | null; effort: string | null };

export interface ResolvedJobModel {
  engine: AiEngine;
  model: string | null;
  effort: string | null;
  reason: string;
}

/** Auto follows the project's provider and maps triage size to a model tier. */
export function chooseAutoModel(models: AiModelOption[], size: VerdictSize | undefined): AiModelOption | null {
  const tier = size === "S" ? /haiku|mini|flash/i : size === "L" || size === "XL" ? /opus|pro|maximum/i : /sonnet|standard/i;
  return models.find((entry) => !entry.isDefault && tier.test(`${entry.id} ${entry.label}`))
    ?? models.find((entry) => entry.isDefault)
    ?? models[0]
    ?? null;
}

export async function resolveJobModel(input: {
  selection: JobSelection;
  projectEngine: AiEngine;
  size?: VerdictSize;
  cwd: string;
  discover?: typeof modelCatalog;
}): Promise<ResolvedJobModel> {
  const engine = input.selection.mode === "manual" ? input.selection.engine : input.projectEngine;
  const catalog = await (input.discover ?? modelCatalog)(engine, input.cwd);
  if (catalog.source !== "live" || !catalog.models.length) {
    throw new Error(`${engine} models are unavailable: ${catalog.message || "model discovery returned no models"}`);
  }
  if (input.selection.mode === "manual") {
    const model = input.selection.model;
    const found = model ? catalog.models.find((entry) => entry.id === model) : catalog.models.find((entry) => entry.isDefault);
    if (model && !found) throw new Error(`${engine} model ${model} is unavailable on this executor`);
    if (input.selection.effort && !found?.effortLevels.includes(input.selection.effort)) {
      throw new Error(`${engine} model ${model || "default"} does not support ${input.selection.effort} effort`);
    }
    return { engine, model, effort: input.selection.effort, reason: "Chosen when Go was clicked" };
  }
  const chosen = chooseAutoModel(catalog.models, input.size);
  return { engine, model: chosen?.isDefault ? null : chosen?.id ?? null, effort: chosen?.defaultEffort ?? null,
    reason: `Auto: project provider, ${input.size || "unknown"} size tier` };
}
