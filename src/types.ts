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
  // provenance so the UI can show what's auto vs overridden
  overridden: (keyof Override)[];
}

export interface Config {
  workspaceRoot: string;
  ignore: string[];
  activeDays: number;
  archivePatterns: string[];
}
