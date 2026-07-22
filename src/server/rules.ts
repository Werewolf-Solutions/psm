import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Practice, PracticeId, ProjectProfile } from "../types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The workspace-wide baseline rules, edited in the UI. */
export const HOUSE_RULES = path.resolve(__dirname, "..", "..", "house-rules.md");

/** Managed region markers (distinct from the capability `psm:attachments` block). */
const RULES_START = "<!-- psm:rules:start -->";
const RULES_END = "<!-- psm:rules:end -->";
const AGENT_FILES = ["CLAUDE.md", "AGENTS.md"];

/* ---------- global rules ---------- */

export function readGlobalRules(): string {
  try {
    return fs.readFileSync(HOUSE_RULES, "utf8");
  } catch {
    return "";
  }
}

export function writeGlobalRules(content: string): void {
  fs.writeFileSync(HOUSE_RULES, content);
}

/* ---------- per-project .psm/ files ---------- */

function psmDir(projectDir: string): string {
  return path.join(projectDir, ".psm");
}

export function readProjectRules(projectDir: string): string {
  try {
    return fs.readFileSync(path.join(psmDir(projectDir), "rules.md"), "utf8");
  } catch {
    return "";
  }
}

export function writeProjectRules(projectDir: string, content: string): void {
  const dir = psmDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "rules.md"), content);
  applyManagedRegion(projectDir);
}

const EMPTY_PROFILE: ProjectProfile = { version: 1, practices: [], updatedAt: 0 };

export function readProfile(projectDir: string): ProjectProfile {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(psmDir(projectDir), "profile.json"), "utf8"));
    const practices = Array.isArray(raw?.practices)
      ? raw.practices.filter((id: unknown): id is PracticeId => PRACTICES.some((p) => p.id === id))
      : [];
    return { version: 1, practices, updatedAt: Number(raw?.updatedAt) || 0 };
  } catch {
    return { ...EMPTY_PROFILE };
  }
}

export function writeProfile(projectDir: string, practices: string[]): ProjectProfile {
  const dir = psmDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const clean = PRACTICES.filter((p) => practices.includes(p.id)).map((p) => p.id);
  const profile: ProjectProfile = { version: 1, practices: clean, updatedAt: Date.now() };
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(profile, null, 2) + "\n");
  for (const id of clean) scaffoldPractice(projectDir, id);
  applyManagedRegion(projectDir);
  return profile;
}

/* ---------- practices catalog ---------- */

export const PRACTICES: Practice[] = [
  {
    id: "versioning",
    title: "Versioning & changelog",
    summary: "Semantic versioning with a Keep-a-Changelog CHANGELOG.md and a VERSION file.",
    scaffolds: true,
    rule:
      "Versioning: follow SemVer. Keep a VERSION file and a Keep-a-Changelog CHANGELOG.md up to " +
      "date. Add an entry under [Unreleased] for every user-visible change; never let the changelog " +
      "drift behind the code.",
  },
  {
    id: "docs",
    title: "Docs & ADRs",
    summary: "A docs/ tree with Architecture Decision Records under docs/adr/.",
    scaffolds: true,
    rule:
      "Documentation: keep project docs under docs/. Record any decision a future maintainer might " +
      "question as a dated ADR in docs/adr/ (decisions are dated, not silently rewritten).",
  },
  {
    id: "ci-cd",
    title: "CI/CD",
    summary: "A starter GitHub Actions workflow that lints, tests, and builds.",
    scaffolds: true,
    rule:
      "CI/CD: every change must keep the pipeline green (lint, test, build). Do not merge on a red " +
      "gate. Prefer least-privilege, pinned CI actions.",
  },
  {
    id: "conventional-commits",
    title: "Conventional Commits",
    summary: "Structured commit messages (feat/fix/docs/refactor/test/chore).",
    scaffolds: false,
    rule:
      "Commits: use Conventional Commits (feat/fix/docs/refactor/test/ci/chore). One logical change " +
      "per commit; the subject explains the why, not just the what.",
  },
  {
    id: "security-review",
    title: "Security review",
    summary: "A SECURITY.md and the discipline of a machine-checkable findings ledger.",
    scaffolds: true,
    rule:
      "Security: secrets, credentials, and session exports never enter the repo — a leaked secret is " +
      "rotated, not merely deleted. Track hardening decisions in SECURITY.md; every 'done' claim " +
      "points to a verifiable coordinate in the repo.",
  },
  {
    id: "human-gated-ai",
    title: "Human-gated AI",
    summary: "AI proposes; deterministic systems execute; nothing ships without a human.",
    scaffolds: false,
    rule:
      "Human-gated AI: the AI proposes and drafts; deterministic systems execute. Nothing ships to " +
      "production without an explicit human approval. Prefer reversible, small steps and declare the " +
      "blast radius of risky actions.",
  },
];

export function practiceById(id: string): Practice | undefined {
  return PRACTICES.find((p) => p.id === id);
}

/** Suggest a default practice set from the detected stack (user confirms). */
export function suggestPractices(stack: string[]): PracticeId[] {
  const s = stack.map((x) => x.toLowerCase());
  const tech = s.some((x) =>
    /node|npm|typescript|javascript|react|vite|next|go|rust|python|java|c#|dotnet|express|hardhat|solidity/.test(x),
  );
  if (!tech) return ["human-gated-ai"];
  return ["versioning", "docs", "conventional-commits", "human-gated-ai"];
}

/* ---------- composed system prompt (global + overlay + practices) ---------- */

/** The rules text injected into a project's AI system prompt. */
export function composeSystemRules(projectDir: string): string {
  const parts: string[] = [];
  const global = readGlobalRules().trim();
  if (global) parts.push(global);
  const overlay = readProjectRules(projectDir).trim();
  if (overlay) parts.push("## Project house rules\n\n" + overlay);
  const snippets = enabledPracticeRules(projectDir);
  if (snippets) parts.push("## Engineering practices\n\n" + snippets);
  return parts.join("\n\n");
}

function enabledPracticeRules(projectDir: string): string {
  const profile = readProfile(projectDir);
  return PRACTICES.filter((p) => profile.practices.includes(p.id))
    .map((p) => `- ${p.rule}`)
    .join("\n");
}

/* ---------- managed region in CLAUDE.md / AGENTS.md ---------- */

function renderManagedSection(projectDir: string): string {
  const body = composeSystemRules(projectDir).trim();
  return [
    RULES_START,
    "<!-- Generated by psm from workspace house rules + this project's .psm/rules.md and profile.",
    "Edit house rules in the psm cockpit, not here. -->",
    "",
    body || "_No house rules configured._",
    "",
    RULES_END,
  ].join("\n");
}

/** Idempotently write the psm-managed rules region into the project's agent files. */
export function applyManagedRegion(projectDir: string): void {
  const section = renderManagedSection(projectDir);
  for (const file of AGENT_FILES) {
    const abs = path.join(projectDir, file);
    let existing = "";
    try {
      existing = fs.readFileSync(abs, "utf8");
    } catch {
      /* file does not exist yet */
    }
    const next = replaceRegion(existing, section);
    if (next !== existing) fs.writeFileSync(abs, next);
  }
}

function replaceRegion(content: string, section: string): string {
  const from = content.indexOf(RULES_START);
  if (from < 0) {
    if (!content) return section + "\n";
    const sep = content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
    return content + sep + section + "\n";
  }
  const endAt = content.indexOf(RULES_END, from + RULES_START.length);
  if (endAt < 0) return content; // malformed — leave it alone
  const to = endAt + RULES_END.length;
  return content.slice(0, from) + section + content.slice(to);
}

/* ---------- practice scaffolding (never overwrites existing files) ---------- */

function writeIfMissing(file: string, content: string): void {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function scaffoldPractice(projectDir: string, id: PracticeId): void {
  const name = path.basename(projectDir);
  const today = new Date().toISOString().slice(0, 10);
  switch (id) {
    case "versioning":
      writeIfMissing(path.join(projectDir, "VERSION"), "0.0.1\n");
      writeIfMissing(
        path.join(projectDir, "CHANGELOG.md"),
        [
          "# Changelog",
          "",
          "All notable changes are recorded here. Format follows",
          "[Keep a Changelog](https://keepachangelog.com/); this project uses SemVer.",
          "",
          "## [Unreleased]",
          "",
        ].join("\n"),
      );
      break;
    case "docs":
      writeIfMissing(
        path.join(projectDir, "docs", "adr", "0000-template.md"),
        [
          "# ADR 0000 — Template",
          "",
          "- **Status:** proposed",
          `- **Date:** ${today}`,
          "",
          "## Context",
          "",
          "What is the situation that forces a decision?",
          "",
          "## Decision",
          "",
          "What did we decide, and why?",
          "",
          "## Consequences",
          "",
          "What becomes easier or harder as a result?",
          "",
        ].join("\n"),
      );
      break;
    case "ci-cd":
      writeIfMissing(
        path.join(projectDir, ".github", "workflows", "ci.yml"),
        [
          "name: CI",
          "",
          "on:",
          "  push:",
          "  pull_request:",
          "",
          "permissions:",
          "  contents: read",
          "",
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "      # TODO: replace with this project's real lint / test / build steps.",
          `      - run: echo "Set up CI for ${name}"`,
          "",
        ].join("\n"),
      );
      break;
    case "security-review":
      writeIfMissing(
        path.join(projectDir, "SECURITY.md"),
        [
          "# Security",
          "",
          "## What never enters the repo",
          "",
          "Secrets, credentials, `.env` files, and session exports are never committed. A leaked",
          "secret is rotated, not merely deleted — git history does not forget.",
          "",
          "## Hardening register",
          "",
          "| ID | Invariant | Status | Evidence |",
          "|----|-----------|--------|----------|",
          "| H1 | _first invariant_ | open | _path#anchor_ |",
          "",
        ].join("\n"),
      );
      break;
    default:
      break; // rule-only practices scaffold nothing
  }
}
