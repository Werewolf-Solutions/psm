export type Status =
  | "active"
  | "paused"
  | "library"
  | "utility"
  | "experiment"
  | "planning"
  | "archived";

export type Priority = "high" | "medium" | "low";

/** Raw signals gathered by the scanner — nothing human here. */
export interface Signals {
  name: string;
  path: string;
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
  archived?: boolean;
  note?: string; // short archive/context note
  // cockpit fields
  runCommand?: string; // overrides the auto-detected run command
  deployCommand?: string; // how to deploy this project
  port?: number; // dev-server port, for the web-preview pane
  aiEngine?: "claude" | "codex"; // which CLI the AI pane shells out to
}

/** The merged view served to the UI and used to render markdown. */
export interface Project {
  name: string;
  path: string;
  status: Status;
  category: string;
  description: string;
  stack: string;
  next: string | null;
  priority: Priority | null;
  pinned: boolean;
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
  deployCommand: string | null;
  port: number | null;
  aiEngine: "claude" | "codex";
  // provenance so the UI can show what's auto vs overridden
  overridden: (keyof Override)[];
}

export interface Config {
  workspaceRoot: string;
  ignore: string[];
  activeDays: number;
  archivePatterns: string[];
}
