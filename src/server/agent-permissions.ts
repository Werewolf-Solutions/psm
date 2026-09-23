import type { ManagedMcpTools } from "./agent-mcp-tools.ts";
import fs from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";
import express from "express";
import type { DatabaseSync } from "node:sqlite";
import { db } from "./db.ts";

export const AGENT_PERMISSION_CATEGORIES = [
  { id: "repository", title: "Repository files", description: "Read and change ordinary files inside this project checkout." },
  { id: "git-local", title: "Local Git", description: "Manage commits, branches, and merges in the local checkout." },
  { id: "git-remote", title: "Remote Git", description: "Fetch from and push to remotes already configured by the operator." },
  { id: "execution", title: "Execution", description: "Run bounded project tasks and prepare dependencies." },
  { id: "integrations", title: "Integrations", description: "Use explicitly attached external tools through their review flow." },
] as const;

export const AGENT_PERMISSIONS = [
  { id: "repo.read", category: "repository", title: "Read repository", description: "Read and search ordinary project files and inspect Git changes.", supported: true },
  { id: "repo.edit", category: "repository", title: "Edit repository", description: "Create and update ordinary project files. Permission config, credentials and Git internals are protected.", supported: true },
  { id: "repo.delete", category: "repository", title: "Delete repository files", description: "Delete ordinary files and empty directories inside the project checkout.", supported: true },
  { id: "git.commit", category: "git-local", title: "Stage and commit", description: "Stage named files and commit those changes locally. Hooks and signing are disabled; existing staged work is preserved.", supported: true },
  { id: "git.branch", category: "git-local", title: "Manage branches", description: "Create and delete local branches using validated branch names.", supported: true },
  { id: "git.switch", category: "git-local", title: "Switch branches", description: "Switch the checkout to an existing local branch.", supported: true },
  { id: "git.merge", category: "git-local", title: "Merge branches", description: "Merge a validated local or remote-tracking ref into the current branch with hooks disabled.", supported: true },
  { id: "git.fetch", category: "git-remote", title: "Fetch remotes", description: "Fetch from a named Git remote already configured in this checkout using the operator's Git credentials.", supported: true },
  { id: "git.push", category: "git-remote", title: "Push branches", description: "Push HEAD to a named branch on an operator-configured Git remote. Force push and model-supplied URLs are not allowed.", supported: true },
  { id: "test.run", category: "execution", title: "Run tests", description: "Run project tests in an isolated, offline container. Requires Docker and a preloaded Node image.", supported: true },
  { id: "pkg.install", category: "execution", title: "Install packages", description: "Download integrity-verified public npm packages and install offline in the turn sandbox. Does not change the checkout.", supported: true },
  { id: "mcp.use", category: "integrations", title: "Use attached tools", description: "Discover explicitly attached MCP tools and request individual calls. Each invocation requires operator review in Capabilities.", supported: true },
] as const;
export type AgentPermission = typeof AGENT_PERMISSIONS[number]["id"];
export interface PermissionProject { id: string; path: string; name: string }
export interface PermissionSnapshot { project: PermissionProject; revision: number; grants: Partial<Record<AgentPermission, { granted: boolean; actor: string; at: number }>> }
export class PermissionError extends Error {}

export class AgentPermissionStore {
  constructor(private readonly database: () => DatabaseSync = db) {}
  snapshot(project: PermissionProject): PermissionSnapshot {
    const canonical = { ...project, path: fs.realpathSync(project.path) };
    const row = this.database().prepare("SELECT revision, grants FROM agent_permissions WHERE project_id = ? AND checkout = ?")
      .get(project.id, canonical.path) as { revision: number; grants: string } | undefined;
    return { project: canonical, revision: row?.revision ?? 0, grants: row ? JSON.parse(row.grants) : {} };
  }
  check(snapshot: PermissionSnapshot, permission: AgentPermission): void {
    const current = this.snapshot(snapshot.project);
    if (current.project.path !== snapshot.project.path || current.revision !== snapshot.revision) throw new PermissionError("Project permissions changed. Start a fresh turn.");
    if (!AGENT_PERMISSIONS.some((entry) => entry.id === permission && entry.supported) || current.grants[permission]?.granted !== true) {
      throw new PermissionError(`Project ${snapshot.project.name} has not granted ${permission}. Review Agent permissions in Capabilities.`);
    }
  }
  change(project: PermissionProject, permission: string, granted: unknown, revision: unknown, actor: string): PermissionSnapshot {
    return this.changeMany(project, [permission], granted, revision, actor);
  }
  changeMany(project: PermissionProject, permissions: unknown, granted: unknown, revision: unknown, actor: string): PermissionSnapshot {
    const requested = Array.isArray(permissions) ? [...new Set(permissions)] : [];
    const definitions = requested.map((permission) => AGENT_PERMISSIONS.find((entry) => entry.id === permission));
    if (!requested.length || definitions.some((definition) => !definition) || typeof granted !== "boolean" || !Number.isSafeInteger(revision)) {
      throw new PermissionError("Invalid permission change.");
    }
    if (granted) {
      const unsupported = definitions.find((definition) => !definition!.supported);
      if (unsupported) throw new PermissionError(unsupported.description);
    }
    const database = this.database();
    database.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.snapshot(project);
      if (revision !== previous.revision) throw new PermissionError("Permissions changed since this view was loaded. Refresh and review again.");
      const changed = requested.filter((permission) => previous.grants[permission as AgentPermission]?.granted !== granted) as AgentPermission[];
      if (!changed.length) { database.exec("COMMIT"); return previous; }
      const at = Date.now();
      const nextRevision = previous.revision + 1;
      const grants = { ...previous.grants };
      for (const permission of changed) grants[permission] = { granted, actor, at };
      database.prepare("INSERT INTO agent_permissions VALUES (?, ?, ?, ?) ON CONFLICT(project_id, checkout) DO UPDATE SET revision = excluded.revision, grants = excluded.grants")
        .run(project.id, previous.project.path, nextRevision, JSON.stringify(grants));
      const event = database.prepare("INSERT INTO agent_permission_events(project_id, checkout, revision, permission, granted, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const permission of changed) event.run(project.id, previous.project.path, nextRevision, permission, Number(granted), actor, at);
      database.exec("COMMIT");
      return this.snapshot(project);
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }
  history(project: PermissionProject): unknown[] {
    return this.database().prepare("SELECT revision, permission, granted, actor, at FROM agent_permission_events WHERE project_id = ? AND checkout = ? ORDER BY revision DESC LIMIT 100")
      .all(project.id, fs.realpathSync(project.path));
  }
}

/** The definition supplies both the permission requirement and its instruction. */
export const PREPARATION_OPERATIONS: ReadonlyArray<{ permission: AgentPermission; instruction: string }> = [
  { permission: "repo.read", instruction: "Inspect the failing checks and read the repository using the PSM repository tools." },
  { permission: "repo.edit", instruction: "Fix the cause in this repository using the PSM write tool." },
  { permission: "git.commit", instruction: "Fix the cause in this repository, and commit what you change. psm deploys committed source, so an uncommitted fix leaves the check failing. Use the PSM Git tools to stage explicit file paths and commit; do not include unrelated work. Additional granted Git operations, including merge and push, are available when the operator has enabled them." },
];
export function reviewAgentPermissions(snapshots: PermissionSnapshot[], engine: string, required: readonly AgentPermission[]): string | null {
  if (!["claude", "codex"].includes(engine)) return `Review capabilities — ${engine} does not yet support PSM's managed permission tools. Select Claude or Codex to prepare this project.`;
  if (!snapshots.length) return "Review capabilities — register this project's identity before starting a managed agent.";
  for (const snapshot of snapshots) {
    const missing = required.filter((permission) => snapshot.grants[permission]?.granted !== true);
    if (missing.length) return `Review capabilities — ${snapshot.project.name} requires ${missing.join(", ")}; project grants: ${Object.entries(snapshot.grants).filter(([, value]) => value?.granted).map(([key]) => key).join(", ") || "none"}. Open Capabilities → Agent permissions.`;
  }
  return null;
}

/** Browser CSRF boundary. Managed agents have no HTTP/shell tools to impersonate it. */
export function isPermissionOperatorRequest(req: express.Request): boolean {
  return req.headers.origin === `${req.protocol}://${req.get("host")}`
    && req.headers["sec-fetch-site"] === "same-origin"
    && req.headers["sec-fetch-mode"] === "cors";
}
export function agentPermissionRouter(options: {
  store: AgentPermissionStore;
  project: (id: string) => PermissionProject;
  /** Runs after a grant change; an object it returns is merged into the response. */
  changed: (project: PermissionProject) => unknown;
  mcp?: ManagedMcpTools;
}): express.Router {
  const router = express.Router();
  const view = (project: PermissionProject) => ({ ...options.store.snapshot(project), categories: AGENT_PERMISSION_CATEGORIES, permissions: AGENT_PERMISSIONS, history: options.store.history(project), supportedEngines: ["claude", "codex"] });
  router.get("/api/projects/:id/agent-permissions", (req, res) => {
    try { res.json(view(options.project(req.params.id))); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  router.post("/api/projects/:id/agent-permissions", (req, res) => {
    if (!isPermissionOperatorRequest(req)) { res.status(403).json({ error: "Change agent permissions from the local, same-origin cockpit." }); return; }
    try {
      const project = options.project(req.params.id);
      const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : [req.body?.permission];
      options.store.changeMany(project, permissions, req.body?.granted, req.body?.revision, `local:${userInfo().username}`);
      const notice = options.changed(project);
      res.json({ ...view(project), ...(notice && typeof notice === "object" ? notice : {}) });
    } catch (error) { res.status(error instanceof PermissionError ? 409 : 400).json({ error: (error as Error).message }); }
  });
  router.get("/api/projects/:id/agent-tool-requests", (req, res) => {
    try { res.json({ requests: options.mcp?.history(options.project(req.params.id).id) ?? [] }); }
    catch { res.status(400).json({ error: "Project is not available." }); }
  });
  router.post("/api/projects/:id/agent-tool-requests/:request/decision", async (req, res) => {
    if (!isPermissionOperatorRequest(req)) { res.status(403).json({ error: "Review attached tool calls from the local cockpit." }); return; }
    try {
      if (!options.mcp || typeof req.body?.approve !== "boolean") throw new Error("Invalid MCP review.");
      res.json(await options.mcp.decide(options.project(req.params.id).id, req.params.request, req.body.digest, req.body.approve, `local:${userInfo().username}`));
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
  return router;
}
