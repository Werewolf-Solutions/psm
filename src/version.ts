import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The running app's version, read from the repo-root package.json — the single
 * source of truth for the whole repo, per the versioning rule in house-rules.md
 * (X released/stable · Y pre-release line · Z each feature or fix; not semver).
 *
 * The sibling projects bake this in at build time with Vite's `__APP_VERSION__`
 * define. psm has no build step, so the server reads the field and serves it to
 * the dashboard instead. Same guarantee either way: the number in the footer is
 * the field, so the two cannot drift. Never hardcode a copy of it.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
    return typeof pkg?.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const APP_VERSION: string = readVersion();

/** Footer-facing form: "v0.1.1". */
export const DISPLAY_VERSION = `v${APP_VERSION}`;
