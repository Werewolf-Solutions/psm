import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, scanWorkspace } from "./scan.ts";
import { loadOverrides, merge } from "./classify.ts";
import { renderMarkdown } from "./render.ts";
import type { Project } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_MD = path.resolve(__dirname, "..", "PROJECTS.md");

/** Full pipeline: scan → merge with overrides → sorted Project[]. */
export function getProjects(): Project[] {
  const cfg = loadConfig();
  const signals = scanWorkspace(cfg);
  const overrides = loadOverrides();
  return merge(signals, overrides, cfg);
}

export function writeMarkdown(projects = getProjects()): string {
  const md = renderMarkdown(projects);
  fs.writeFileSync(PROJECTS_MD, md);
  return PROJECTS_MD;
}

export { PROJECTS_MD };
