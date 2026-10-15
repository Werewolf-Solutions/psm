/**
 * The context pack a triage run reads — P14 phase D-1.
 *
 * psm assembles it, deterministically and size-capped, so the model does not go
 * looking: the same repository state and the same intake list always give the
 * same text, and therefore the same digest, which is what lets an identical
 * triage be served from cache instead of re-run.
 *
 * Reading is the whole job here. Nothing is written, nothing in the project is
 * executed, and git is only ever asked read-only questions.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Bump when the pack's shape changes, so old cache entries stop matching. */
export const CONTEXT_VERSION = 1;

export const PACK_MAX_BYTES = 60 * 1024;

/** Per-section caps, in bytes. Their sum is a little over the pack cap on purpose. */
export const SECTION_LIMITS = {
  readme: 8 * 1024,
  claude: 6 * 1024,
  roadmapFile: 6 * 1024,
  roadmaps: 24 * 1024,
  gitLog: 10 * 1024,
  branches: 3 * 1024,
  intake: 6 * 1024,
  recap: 3 * 1024,
};

const ROADMAP_FILE_LIMIT = 40;
const BRANCH_LIMIT = 30;
const GIT_TIMEOUT_MS = 10_000;

export interface OpenIntake {
  intakeId: string;
  text: string;
  status?: string;
  verdict?: { verdict?: string; size?: string } | null;
}

export interface PackSection {
  title: string;
  body: string;
}

export interface ContextPack {
  text: string;
  /** sha256 over the version and the text: the pack's identity for caching. */
  digest: string;
  bytes: number;
  truncated: boolean;
}

/* ---------- pure assembly ---------- */

const TRUNCATION_MARK = "\n…[truncated]";

/** Cut `text` to at most `maxBytes` of UTF-8, on a character boundary. */
export function truncateBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const room = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_MARK));
  let cut = Buffer.from(text).subarray(0, room).toString("utf8");
  // A multi-byte character split at the edge decodes to U+FFFD; drop it.
  cut = cut.replace(/�+$/, "");
  return { text: cut + TRUNCATION_MARK, truncated: true };
}

/**
 * Join sections in order under the overall cap. Earlier sections win: they are
 * ordered by how much a triage needs them, so the cap eats the least useful
 * material first. Empty sections are left out rather than shown as headings.
 */
export function assemblePack(sections: PackSection[], maxBytes = PACK_MAX_BYTES): ContextPack {
  let text = "";
  let truncated = false;
  for (const section of sections) {
    const body = section.body.trim();
    if (!body) continue;
    const block = `## ${section.title}\n\n${body}\n\n`;
    // One byte held back for the closing newline added below.
    const remaining = maxBytes - 1 - Buffer.byteLength(text);
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const fitted = truncateBytes(block, remaining);
    text += fitted.text;
    if (fitted.truncated) {
      truncated = true;
      break;
    }
  }
  text = text.trimEnd() + "\n";
  const digest = crypto.createHash("sha256").update(`psm-context-v${CONTEXT_VERSION}\0${text}`).digest("hex");
  return { text, digest, bytes: Buffer.byteLength(text), truncated };
}

/** Other open intake items, oldest id first so the order never depends on the hub. */
export function formatIntake(items: OpenIntake[], excludeId?: string): string {
  const lines = items
    .filter((item) => item.intakeId !== excludeId)
    .filter((item) => !["withdrawn", "failed"].includes(String(item.status || "")))
    .sort((a, b) => (a.intakeId < b.intakeId ? -1 : a.intakeId > b.intakeId ? 1 : 0))
    .map((item) => {
      const verdict = item.verdict?.verdict ? ` · ${item.verdict.verdict}${item.verdict.size ? ` ${item.verdict.size}` : ""}` : "";
      const text = item.text.replace(/\s+/g, " ").trim().slice(0, 400);
      return `- ${item.intakeId} [${item.status || "new"}${verdict}] ${text}`;
    });
  return truncateBytes(lines.join("\n"), SECTION_LIMITS.intake).text;
}

/* ---------- reading the project ---------- */

function readCapped(file: string, maxBytes: number): string | null {
  try {
    const stat = fs.lstatSync(file);
    // A symlink could point anywhere on the machine; the pack only reads the repo.
    if (!stat.isFile()) return null;
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, maxBytes + 1));
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, read).toString("utf8");
      return truncateBytes(text, maxBytes).text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** The first of `names` that exists in `dir`, matched case-insensitively. */
function findFile(dir: string, names: string[]): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    const hit = entries.find((entry) => entry.toLowerCase() === name.toLowerCase());
    if (hit) return path.join(dir, hit);
  }
  return null;
}

/** Every markdown file under docs/roadmaps, sorted by path, symlinks skipped. */
export function listRoadmapFiles(projectDir: string): string[] {
  const root = path.join(projectDir, "docs", "roadmaps");
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(md|markdown|txt)$/i.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out.slice(0, ROADMAP_FILE_LIMIT);
}

function roadmapsSection(projectDir: string): string {
  const parts: string[] = [];
  for (const file of listRoadmapFiles(projectDir)) {
    const body = readCapped(file, SECTION_LIMITS.roadmapFile);
    if (body === null) continue;
    parts.push(`### ${path.relative(projectDir, file)}\n\n${body.trim()}`);
  }
  return truncateBytes(parts.join("\n\n"), SECTION_LIMITS.roadmaps).text;
}

function git(projectDir: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", projectDir, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      // No pager, no colour, no prompts: this must never wait on anything.
      env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
  } catch {
    return null;
  }
}

/** Thirty days of history: one line per commit plus git's shortstat summary. */
function gitLogSection(projectDir: string): string {
  const out = git(projectDir, ["log", "--since=30.days.ago", "--no-color", "--format=%h %s", "--shortstat"]);
  if (!out) return "";
  const lines = out
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => (/^\s+\d+ files? changed/.test(line) ? `    ${line.trim()}` : line));
  return truncateBytes(lines.join("\n"), SECTION_LIMITS.gitLog).text;
}

/** The branch other branches are measured against: main, then master, then HEAD's. */
function baseBranch(projectDir: string, branches: string[]): string | null {
  for (const name of ["main", "master"]) if (branches.includes(name)) return name;
  const head = git(projectDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return head?.trim() || null;
}

function branchesSection(projectDir: string): string {
  const out = git(projectDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  if (!out) return "";
  const branches = out.split("\n").map((line) => line.trim()).filter(Boolean).sort();
  const base = baseBranch(projectDir, branches);
  const current = git(projectDir, ["symbolic-ref", "--quiet", "--short", "HEAD"])?.trim() || null;
  const lines: string[] = [];
  if (base) lines.push(`Base branch: ${base}`);
  for (const branch of branches.slice(0, BRANCH_LIMIT)) {
    const marker = branch === current ? " (checked out)" : "";
    if (!base || branch === base) {
      lines.push(`- ${branch}${marker}`);
      continue;
    }
    const counts = git(projectDir, ["rev-list", "--left-right", "--count", `${base}...${branch}`]);
    const [behind, ahead] = (counts || "").trim().split(/\s+/).map(Number);
    lines.push(
      Number.isFinite(ahead) && Number.isFinite(behind)
        ? `- ${branch}${marker}: ${ahead} ahead, ${behind} behind ${base}`
        : `- ${branch}${marker}`,
    );
  }
  if (branches.length > BRANCH_LIMIT) lines.push(`- …and ${branches.length - BRANCH_LIMIT} more`);
  return truncateBytes(lines.join("\n"), SECTION_LIMITS.branches).text;
}

export interface ContextInput {
  projectDir: string;
  projectName: string;
  /** The intake being triaged, left out of the open-intake list. */
  intakeId?: string;
  /** Other intake items for the project, from the hub. */
  openIntake?: OpenIntake[];
  /** The AI session's stored "where we left off" recap, if psm has one. */
  recap?: string | null;
  maxBytes?: number;
}

/**
 * Build the pack for one project. Order is priority: what the project says it is
 * and plans to do, then what has actually been happening, then what else is
 * waiting on it.
 */
export function buildContextPack(input: ContextInput): ContextPack {
  const { projectDir } = input;
  const readme = findFile(projectDir, ["README.md", "README.markdown", "README.txt", "README"]);
  const claude = findFile(projectDir, ["CLAUDE.md", "AGENTS.md"]);
  const sections: PackSection[] = [
    { title: `Project: ${input.projectName}`, body: `Directory name: ${path.basename(projectDir)}` },
    { title: readme ? path.basename(readme) : "README", body: readme ? readCapped(readme, SECTION_LIMITS.readme) || "" : "" },
    { title: claude ? path.basename(claude) : "CLAUDE.md", body: claude ? readCapped(claude, SECTION_LIMITS.claude) || "" : "" },
    { title: "Roadmaps (docs/roadmaps)", body: roadmapsSection(projectDir) },
    { title: "Git log, last 30 days", body: gitLogSection(projectDir) },
    { title: "Local branches", body: branchesSection(projectDir) },
    { title: "Other open intake for this project", body: formatIntake(input.openIntake || [], input.intakeId) },
    { title: "AI session recap", body: truncateBytes(String(input.recap || ""), SECTION_LIMITS.recap).text },
  ];
  return assemblePack(sections, input.maxBytes ?? PACK_MAX_BYTES);
}
