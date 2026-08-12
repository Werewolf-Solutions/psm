export type Status =
  | "active"
  | "paused"
  | "library"
  | "utility"
  | "experiment"
  | "planning"
  | "archived";

export type Priority = "high" | "medium" | "low";

export type PlanStatus =
  | "draft"
  | "edited"
  | "reviewing"
  | "ai-reviewed"
  | "confirmed"
  | "in-progress"
  | "done";

export interface PlanStep {
  id: string;
  text: string;
  done: boolean;
  blocked?: boolean;
  children: PlanStep[];
}

export interface PlanPhase {
  id: string;
  title: string;
  summary: string;
  steps: PlanStep[];
}

export interface PlanReviewIssue {
  severity: "info" | "warning" | "blocking";
  message: string;
  phaseId?: string;
  stepId?: string;
}

export interface PlanReview {
  revision: number;
  summary: string;
  issues: PlanReviewIssue[];
  reviewedAt: number;
}

export interface ImplementationPlan {
  id: string;
  project: string;
  title: string;
  status: PlanStatus;
  revision: number;
  confirmedRevision?: number;
  phases: PlanPhase[];
  notes: string;
  review?: PlanReview;
  createdAt: number;
  updatedAt: number;
}

/** Opt-in engineering practices a project can adopt (see src/server/rules.ts). */
export type PracticeId =
  | "versioning"
  | "docs"
  | "ci-cd"
  | "conventional-commits"
  | "security-review"
  | "human-gated-ai";

export interface Practice {
  id: PracticeId;
  title: string;
  summary: string;
  /** Rule snippet injected into the AI system prompt and the managed CLAUDE.md region. */
  rule: string;
  /** Whether enabling this practice scaffolds starter files (VERSION, CHANGELOG, …). */
  scaffolds: boolean;
}

/**
 * A project's stable identity, stored committed at `<project>/.psm/identity.json`.
 * Lives in the project folder so the id survives renames, moves, and clones — unlike the
 * folder name, which is only a human handle.
 */
export interface ProjectIdentity {
  version: 1;
  id: string; // prj_<20 hex>
  name: string; // folder name when the id was minted, for provenance only
  createdAt: number;
}

/** Per-project psm config, stored committed at `<project>/.psm/profile.json`. */
export interface ProjectProfile {
  version: 1;
  practices: PracticeId[];
  updatedAt: number;
}

export type CapabilityKind = "mcp" | "skill" | "doc" | "api" | "project";
export type CapabilitySource = "workspace" | "registry" | "custom";
export type CapabilityIntegrity =
  | "workspace-mutable"
  | "manifest-pinned"
  | "artifact-pinned"
  | "unknown";

export interface McpStdioWire {
  transport: "stdio";
  launch:
    | { type: "npm-script"; script: string; workingDirectory: string }
    | { type: "command"; command: string; args: string[]; cwdIndependent: true };
  env: Record<string, string>;
}

export interface McpHttpWire {
  transport: "http";
  url: string;
  bearerTokenEnvVar?: string;
  headers?: Record<string, string>;
}

export interface McpCapability {
  ref: string;
  id: string;
  kind: "mcp";
  source: CapabilitySource;
  integrity: CapabilityIntegrity;
  title: string;
  summary: string;
  usage: string;
  providerProject?: string;
  manifestDigest: string;
  ready: boolean;
  warnings: string[];
  requiredEnv: string[];
  missingEnv: string[];
  mcp: McpStdioWire | McpHttpWire;
}

export interface CopyCapability {
  ref: string;
  id: string;
  kind: "skill" | "doc" | "api";
  source: CapabilitySource;
  integrity: CapabilityIntegrity;
  title: string;
  summary: string;
  usage: string;
  providerProject?: string;
  manifestDigest: string;
  artifactDigest: string;
  ready: true;
  warnings: string[];
  requiredEnv: string[];
  missingEnv: string[];
  copy: {
    sourceRoot: string;
    files: string[];
    targetRoots: string[];
  };
}

export interface CandidateCapability {
  ref: string;
  id: string;
  kind: Exclude<CapabilityKind, "mcp"> | "mcp";
  source: CapabilitySource;
  integrity: CapabilityIntegrity;
  title: string;
  summary: string;
  usage: string;
  providerProject?: string;
  manifestDigest: string;
  ready: false;
  warnings: string[];
  requiredEnv: string[];
  missingEnv: string[];
}

export type Capability = McpCapability | CopyCapability | CandidateCapability;

export interface Attachment {
  capabilityRef: string;
  kind: CapabilityKind;
  source: CapabilitySource;
  mode: "reference" | "copy";
  manifestDigest: string;
  attachedAt: number;
}

/** Raw signals gathered by the scanner — nothing human here. */
export interface Signals {
  name: string;
  path: string;
  psmId: string | null; // stable id from .psm/identity.json, null until assigned
  hasGit: boolean;
  gitBranch: string | null;
  gitVersion: string | null; // nearest tag / describe
  gitLastSubject: string | null;
  lastActivity: string | null; // ISO date (yyyy-mm-dd)
  lastActivitySource: "git" | "files" | null;
  stack: string[];
  pkgName: string | null;
  pkgDescription: string | null;
  readmeSummary: string | null;
  notesNext: string | null; // first actionable line from notes/todo
  hasReadme: boolean;
  runCommand: string | null; // auto-detected way to run it (e.g. "npm run dev")
  port: number | null; // auto-detected dev-server port, if any
}

/** Human-curated layer, stored in overrides.json. All fields optional. */
export interface Override {
  status?: Status;
  category?: string;
  description?: string;
  stack?: string;
  next?: string;
  priority?: Priority;
  pinned?: boolean;
  workingOn?: boolean; // manually include the project in the Working on lane
  workingOnAt?: number; // when it was manually marked as being worked on
  archived?: boolean;
  note?: string; // short archive/context note
  // cockpit fields
  runCommand?: string; // overrides the auto-detected run command
  deployStaging?: string; // how to deploy this project to staging
  deployProduction?: string; // how to deploy this project to production
  port?: number; // dev-server port, for the web-preview pane
  aiEngine?: "claude" | "codex"; // which CLI the AI pane shells out to
  aiModel?: string; // optional model id/alias passed to the selected AI CLI
  aiEffort?: string; // optional reasoning/effort level passed to the selected AI CLI
  aiFullAccess?: boolean; // let the AI run commands, not just edit files
  attachments?: Attachment[]; // human-approved capability bindings
}

/** The merged view served to the UI and used to render markdown. */
export interface Project {
  name: string;
  path: string;
  id: string | null; // stable id, null until one is assigned for this project
  status: Status;
  category: string;
  description: string;
  stack: string;
  next: string | null;
  priority: Priority | null;
  pinned: boolean;
  workingOn: boolean;
  workingOnAt: number | null;
  archived: boolean;
  note: string | null;
  lastActivity: string | null;
  lastActivitySource: "git" | "files" | null;
  gitBranch: string | null;
  gitVersion: string | null;
  gitLastSubject: string | null;
  hasGit: boolean;
  // cockpit
  runCommand: string | null; // merged: override ?? auto-detected
  deployStaging: string | null;
  deployProduction: string | null;
  port: number | null;
  aiEngine: "claude" | "codex";
  aiModel: string | null;
  aiEffort: string | null;
  aiFullAccess: boolean;
  attachments: Attachment[];
  // provenance so the UI can show what's auto vs overridden
  overridden: (keyof Override)[];
}

export interface Config {
  workspaceRoot: string;
  ignore: string[];
  activeDays: number;
  archivePatterns: string[];
}
