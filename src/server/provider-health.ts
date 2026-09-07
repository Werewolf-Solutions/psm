import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AiEngine } from "./ai.ts";
import { MODEL_PROVIDERS, modelCatalog } from "./models.ts";

const exec = promisify(execFile);

export function newerStableVersion(installed: string, latest: string): boolean | null {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
  const a = parse(installed);
  const b = parse(latest);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return b[i] > a[i];
  }
  return false;
}

/** Read-only diagnostics: no update commands and no inference prompts. */
export async function checkProvider(engine: AiEngine, cwd: string, online = true) {
  const problems: string[] = [];
  const [installed, latest, catalog] = await Promise.all([
    exec(engine, ["--version"], { cwd, timeout: 5_000, maxBuffer: 16_384 })
      .then(({ stdout }) => stdout.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0] || null)
      .catch(() => { problems.push("CLI unavailable or version check failed."); return null; }),
    online ? fetch(`https://registry.npmjs.org/${MODEL_PROVIDERS[engine].package}/latest`, {
      signal: AbortSignal.timeout(5_000),
    }).then(async (response) => {
      if (!response.ok) throw new Error("Registry check failed");
      const data = await response.json() as { version?: unknown };
      if (typeof data.version !== "string") throw new Error("Registry version missing");
      return data.version;
    }).catch(() => { problems.push("Could not check the latest published version."); return null; }) : null,
    modelCatalog(engine, cwd),
  ]);
  if (!installed && !problems.includes("CLI unavailable or version check failed.")) {
    problems.push("CLI returned an unrecognized version.");
  }
  if (catalog.source !== "live") problems.push(catalog.message || "Model discovery failed.");
  return {
    engine, installed, latest,
    updateAvailable: installed && latest ? newerStableVersion(installed, latest) : null,
    checkedAt: Date.now(),
    catalog,
    problems,
  };
}
