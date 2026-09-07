import path from "node:path";
import { MODEL_PROVIDERS } from "../src/server/models.ts";
import { checkProvider } from "../src/server/provider-health.ts";
import type { AiEngine } from "../src/server/ai.ts";

const args = process.argv.slice(2);
const online = !args.includes("--offline");
const positional = args.filter((arg) => arg !== "--offline");
if (positional.length > 1 || positional.some((arg) => arg.startsWith("--"))) {
  console.error("Usage: npm run providers:check -- [--offline] [project-directory]");
  process.exitCode = 1;
} else {
  const cwd = path.resolve(positional[0] || process.cwd());
  const checks = await Promise.all((Object.keys(MODEL_PROVIDERS) as AiEngine[])
    .map((engine) => checkProvider(engine, cwd, online)));
  console.log(JSON.stringify({ cwd, checks }, null, 2));
  // Available upgrades are advisory; unavailable CLIs, registries and broken
  // discovery fail the check so a scheduled maintenance job can flag them.
  if (checks.some((check) => check.problems.length)) process.exitCode = 1;
}
