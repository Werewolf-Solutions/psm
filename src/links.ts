/**
 * Linked sources — where psm looks for projects.
 *
 * The original tool had exactly one source: `workspaceRoot` in psm.config.json,
 * a folder whose children are the projects. That is right for a workspace you
 * own end to end, and wrong the moment psm is driven from somewhere else: a
 * deployed psm has to be *told* what to look at, and the answer is rarely one
 * tidy parent folder.
 *
 * So a source is now a link, of one of two kinds:
 *
 *   workspace   a directory of projects — every child folder is a project.
 *               (This is what workspaceRoot always was.)
 *   project     a single project folder, linked on its own.
 *
 * Dev mode keeps the configured workspaceRoot as an implicit link so existing
 * installs see no change. Agent and hosted modes start empty: nothing is scanned
 * until it is linked.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { scansImplicitly } from "./mode.ts";
import { statePath } from "./store.ts";
import type { Config } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PSM_ROOT = path.resolve(__dirname, "..");

// Per-account in hosted mode, one file beside the repo locally — see src/store.ts.
const linksFile = () => process.env.PSM_LINKS_FILE || statePath(".psm-links.json");

export type LinkKind = "workspace" | "project";

export interface ProjectLink {
  id: string;
  kind: LinkKind;
  /** Absolute, resolved, symlink-free path on the machine running this process. */
  path: string;
  /** What to call it in the UI; defaults to the folder's own name. */
  label: string;
  addedAt: number;
}

export class LinkError extends Error {}

/** Stable per-path id, so re-linking the same folder does not duplicate it. */
function linkId(kind: LinkKind, target: string): string {
  return "lnk_" + createHash("sha256").update(`${kind}\0${target}`).digest("hex").slice(0, 16);
}

function readLinks(): ProjectLink[] {
  try {
    const raw = JSON.parse(fs.readFileSync(linksFile(), "utf8"));
    if (!Array.isArray(raw?.links)) return [];
    return raw.links.filter(
      (link: any): link is ProjectLink =>
        link && typeof link.path === "string" && (link.kind === "workspace" || link.kind === "project"),
    );
  } catch {
    return [];
  }
}

function writeLinks(links: ProjectLink[]) {
  const file = linksFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ links }, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Resolve and vet a path the user asked to link. Rejecting here rather than at
 * scan time means a bad link never enters the store and the UI gets a reason.
 */
export function resolveLinkTarget(input: string): string {
  const raw = String(input || "").trim();
  if (!raw) throw new LinkError("Enter a folder path");
  const expanded = raw.startsWith("~")
    ? path.join(process.env.HOME || "", raw.slice(1))
    : raw;
  if (!path.isAbsolute(expanded)) throw new LinkError("Use an absolute path");

  let resolved: string;
  try {
    // realpath collapses symlinks so two links to one folder cannot both exist
    resolved = fs.realpathSync(expanded);
  } catch {
    throw new LinkError(`No such folder: ${expanded}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new LinkError(`Cannot read ${resolved}`);
  }
  if (!stat.isDirectory()) throw new LinkError(`Not a folder: ${resolved}`);
  try {
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new LinkError(`No permission to read ${resolved}`);
  }
  return resolved;
}

export function listLinks(): ProjectLink[] {
  return readLinks();
}

export function addLink(kind: LinkKind, input: string, label?: string): ProjectLink {
  if (kind !== "workspace" && kind !== "project") throw new LinkError("Unknown link kind");
  const target = resolveLinkTarget(input);
  const links = readLinks();

  const existing = links.find((link) => link.path === target);
  if (existing) {
    throw new LinkError(
      existing.kind === kind
        ? `${target} is already linked`
        : `${target} is already linked as a ${existing.kind === "workspace" ? "directory of projects" : "single project"}`,
    );
  }
  // Linking a project that a linked workspace already covers is a no-op with a
  // confusing outcome (one project, two sources), so say so instead.
  if (kind === "project") {
    const parent = links.find((link) => link.kind === "workspace" && path.dirname(target) === link.path);
    if (parent) throw new LinkError(`${path.basename(target)} already comes from the linked folder ${parent.path}`);
  }

  const link: ProjectLink = {
    id: linkId(kind, target),
    kind,
    path: target,
    label: String(label || "").trim() || path.basename(target),
    addedAt: Date.now(),
  };
  links.push(link);
  writeLinks(links);
  return link;
}

export function removeLink(id: string): boolean {
  const links = readLinks();
  const next = links.filter((link) => link.id !== id);
  if (next.length === links.length) return false;
  writeLinks(next);
  return true;
}

/**
 * Every source this process should scan, implicit config first.
 *
 * Dev mode's implicit workspace link is not stored in the links file: it comes
 * from psm.config.json and cannot be removed from the UI, which keeps the
 * original single-workspace install working exactly as before.
 */
export function activeLinks(cfg?: Config): ProjectLink[] {
  const links = readLinks();
  if (!scansImplicitly() || !cfg) return links;

  let root: string;
  try {
    root = fs.realpathSync(path.resolve(PSM_ROOT, cfg.workspaceRoot));
  } catch {
    return links;
  }
  if (links.some((link) => link.path === root)) return links;
  return [
    {
      id: linkId("workspace", root),
      kind: "workspace",
      path: root,
      label: path.basename(root) || root,
      addedAt: 0,
    },
    ...links,
  ];
}

/** A link plus whether it came from config (and so cannot be unlinked). */
export function describeLinks(cfg?: Config) {
  const stored = new Set(readLinks().map((link) => link.id));
  return activeLinks(cfg).map((link) => ({
    ...link,
    implicit: !stored.has(link.id),
    exists: fs.existsSync(link.path),
  }));
}
