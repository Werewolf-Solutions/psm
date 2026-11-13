/**
 * One folder per project id, for MCP.
 *
 * A project's id is committed (`.psm/identity.json`), so every linked git
 * worktree and every second clone of it carries the same id. MCP clients address
 * projects by id; "the first folder with that id" would start, read or request
 * work in whichever checkout happens to be listed first.
 *
 * So MCP sees the main checkout only. Linked worktrees stay cockpit-only. If two
 * folders that are both main checkouts share an id (two clones), neither is
 * addressable over MCP: psm does not guess between them.
 */
import fs from "node:fs";
import path from "node:path";

/** A linked worktree has a `.git` file pointing at the main checkout; the main checkout has a `.git` directory. */
export function isLinkedWorktree(projectPath: string): boolean {
  try {
    return fs.statSync(path.join(projectPath, ".git")).isFile();
  } catch {
    return false;
  }
}

export function primaryCheckouts<T extends { id?: string | null; path: string }>(projects: T[], linked: (projectPath: string) => boolean = isLinkedWorktree): T[] {
  const byId = new Map<string, T[]>();
  for (const project of projects) if (project.id) byId.set(project.id, [...(byId.get(project.id) ?? []), project]);
  const keep = new Set<T>();
  for (const group of byId.values()) {
    if (group.length === 1) {
      keep.add(group[0]);
      continue;
    }
    const mains = group.filter((project) => !linked(project.path));
    if (mains.length === 1) keep.add(mains[0]);
  }
  // Projects without an id pass through; MCP cannot address them anyway.
  return projects.filter((project) => !project.id || keep.has(project));
}
