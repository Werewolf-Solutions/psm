import type { ManagedMcpTools } from "./agent-mcp-tools.ts";
import type { OperationReviews } from "./agent-reviews.ts";
import fs from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";
import express from "express";
import type { DatabaseSync } from "node:sqlite";
import { db } from "./db.ts";
import { decide, makeRule, PRESETS, presetRules, type Decision, type DecisionContext, type PolicyRule } from "./agent-policy.ts";

export const AGENT_PERMISSION_CATEGORIES = [
  { id: "repository", title: "Repository files", description: "Read and change ordinary files inside this project checkout." },
  { id: "git-local", title: "Local Git", description: "Manage commits, branches, and merges in the local checkout." },
  { id: "git-remote", title: "Remote Git", description: "Fetch from and push to remotes already configured by the operator." },
  { id: "execution", title: "Execution", description: "Run bounded project tasks and prepare dependencies." },
  { id: "integrations", title: "Integrations", description: "Use explicitly attached external tools, reviewed per call unless a rule allows them." },
  { id: "machines", title: "Servers", description: "Run commands on servers connected to this project, as its own unprivileged account." },
  { id: "deployment", title: "Deployment", description: "Let PSM apply infrastructure plans under a standing rule instead of asking for each one." },
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
  { id: "mcp.use", category: "integrations", title: "Discover attached tools", description: "List explicitly attached MCP tools and request calls. Calls follow the attached-call rule below.", supported: true },
  { id: "mcp.call", category: "integrations", title: "Call attached tools without review", description: "Run attached MCP tool calls directly. Without this, or with an Ask rule, each call waits for operator review.", supported: true },
  { id: "deploy.approve", category: "deployment", title: "Apply plans by policy", description: "Preparation applies an infrastructure plan without a separate review. Plans that need an acknowledgement (every production plan does) are covered only by a rule scoped explicitly to that environment.", supported: true },
  { id: "machine.command", category: "machines", title: "Run server commands", description: "Run commands on a connected server as this project's command account: no sudo, no deployment helper, only its own working directory.", supported: true },
] as const;
export type AgentPermission = typeof AGENT_PERMISSIONS[number]["id"];
export interface PermissionProject { id: string; path: string; name: string; workspaceId?: string }
export interface PermissionSnapshot {
  project: PermissionProject;
  revision: number;
  /** The last revision that reduced authority. */
  restrictedRevision?: number;
  grants: Partial<Record<AgentPermission, { granted: boolean; actor: string; at: number }>>;
  /** Scoped Allow/Ask/Deny rules beside the grants. */
  rules?: PolicyRule[];
  /** The managed task this snapshot was taken for, for task-scoped rules. */
  task?: string;
}
export class PermissionError extends Error {}
/** The operation is allowed only after an operator reviews it. */
export class ReviewRequiredError extends PermissionError {
  constructor(readonly decision: Decision, readonly permission: string, readonly context: DecisionContext, readonly summary: string) { super(decision.reason); this.name = "ReviewRequiredError"; }
}

/** Standing grants are unscoped, permanent Allow rules. */
function grantRules(snapshot: PermissionSnapshot): PolicyRule[] {
  return Object.entries(snapshot.grants).filter(([, grant]) => grant?.granted).map(([permission, grant]) => ({
    id: `grant:${permission}`, permission, effect: "allow" as const, scope: {}, expiresAt: null, remainingUses: null, source: "grant", actor: grant!.actor, at: grant!.at,
  }));
}
const workspaceKey = (ref: string) => `ws:${ref.toLowerCase()}`;

export class AgentPermissionStore {
  constructor(private readonly database: () => DatabaseSync = db) {}
  snapshot(project: PermissionProject): PermissionSnapshot {
    const canonical = { ...project, path: fs.realpathSync(project.path) };
    const row = this.database().prepare("SELECT revision, grants, rules, restricted_revision FROM agent_permissions WHERE project_id = ? AND checkout = ?")
      .get(project.id, canonical.path) as { revision: number; grants: string; rules: string; restricted_revision: number } | undefined;
    return { project: canonical, revision: row?.revision ?? 0, restrictedRevision: row?.restricted_revision ?? 0, grants: row ? JSON.parse(row.grants) : {}, rules: row ? JSON.parse(row.rules) : [] };
  }
  /** Workspace-level rules; only their Deny rules take part in decisions. */
  workspaceRules(workspaceId = "personal"): PolicyRule[] {
    const row = this.database().prepare("SELECT rules FROM agent_permissions WHERE project_id = ? AND checkout = ''").get(workspaceKey(workspaceId)) as { rules: string } | undefined;
    return row ? JSON.parse(row.rules) : [];
  }
  /**
   * Decide one operation against the *current* policy. A snapshot taken before
   * a change is refused outright, so a running turn never keeps authority that
   * was withdrawn under it.
   */
  decide(snapshot: PermissionSnapshot, permission: string, context: DecisionContext = {}): Decision {
    const current = this.snapshot(snapshot.project);
    // Decisions always use the current rules. A snapshot older than the last
    // reduction of authority is refused as a whole; additions do not stop a task.
    if (current.project.path !== snapshot.project.path || snapshot.revision < (current.restrictedRevision ?? 0)) throw new PermissionError("Project permissions changed. Start a fresh turn.");
    if (!AGENT_PERMISSIONS.some((entry) => entry.id === permission && entry.supported)) {
      return { effect: "deny", rule: null, workspace: false, reason: `${permission} is not an operation PSM supports.` };
    }
    return decide({
      permission, context: { ...context, ...(snapshot.task ? { task: snapshot.task } : {}) },
      rules: [...grantRules(current), ...(current.rules ?? [])], workspaceRules: this.workspaceRules(snapshot.project.workspaceId),
    });
  }
  /** `summary` describes the exact operation for a review, in the operator's terms. */
  check(snapshot: PermissionSnapshot, permission: AgentPermission, context: DecisionContext = {}, summary: string = permission): Decision {
    const decision = this.decide(snapshot, permission, context);
    if (decision.effect === "ask") throw new ReviewRequiredError(decision, permission, context, summary);
    if (decision.effect === "deny") {
      throw new PermissionError(decision.rule || decision.workspace
        ? `${decision.reason} Review Agent permissions in Capabilities.`
        : `Project ${snapshot.project.name} has not granted ${permission}. Review Agent permissions in Capabilities.`);
    }
    if (decision.rule && decision.rule.remainingUses !== null) this.#consume(snapshot.project, decision.rule.id);
    return decision;
  }
  /** Use up one use of a limited rule. Not a policy change, so no revision bump. */
  #consume(project: PermissionProject, ruleId: string): void {
    const database = this.database();
    const path = fs.realpathSync(project.path);
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = database.prepare("SELECT rules FROM agent_permissions WHERE project_id = ? AND checkout = ?").get(project.id, path) as { rules: string } | undefined;
      const rules: PolicyRule[] = row ? JSON.parse(row.rules) : [];
      const rule = rules.find((entry) => entry.id === ruleId);
      if (!rule || rule.remainingUses === null || rule.remainingUses <= 0) throw new PermissionError("That one-time approval was already used.");
      rule.remainingUses -= 1;
      database.prepare("UPDATE agent_permissions SET rules = ? WHERE project_id = ? AND checkout = ?").run(JSON.stringify(rules.filter((entry) => entry.remainingUses !== 0)), project.id, path);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }
  /**
   * Replace grants and/or rules atomically at one new revision, auditing each
   * change. Every policy edit goes through here.
   */
  #write(project: PermissionProject, revision: unknown, actor: string, change: (current: PermissionSnapshot) => { grants: PermissionSnapshot["grants"]; rules: PolicyRule[]; events: Array<[string, boolean]>; restrictive: boolean }): PermissionSnapshot {
    if (!Number.isSafeInteger(revision)) throw new PermissionError("Invalid permission change.");
    const database = this.database();
    database.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.snapshot(project);
      if (revision !== previous.revision) throw new PermissionError("Permissions changed since this view was loaded. Refresh and review again.");
      const next = change(previous);
      if (!next.events.length) { database.exec("COMMIT"); return previous; }
      const at = Date.now();
      const nextRevision = previous.revision + 1;
      const restricted = next.restrictive ? nextRevision : previous.restrictedRevision ?? 0;
      database.prepare("INSERT INTO agent_permissions (project_id, checkout, revision, grants, rules, restricted_revision) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, checkout) DO UPDATE SET revision = excluded.revision, grants = excluded.grants, rules = excluded.rules, restricted_revision = excluded.restricted_revision")
        .run(project.id, previous.project.path, nextRevision, JSON.stringify(next.grants), JSON.stringify(next.rules), restricted);
      const event = database.prepare("INSERT INTO agent_permission_events(project_id, checkout, revision, permission, granted, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const [permission, granted] of next.events) event.run(project.id, previous.project.path, nextRevision, permission, Number(granted), actor, at);
      database.exec("COMMIT");
      return this.snapshot(project);
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }
  addRule(project: PermissionProject, input: Parameters<typeof makeRule>[0], revision: unknown): PermissionSnapshot {
    if (!AGENT_PERMISSIONS.some((entry) => entry.id === input.permission)) throw new PermissionError("Invalid permission change.");
    const rule = makeRule(input);
    return this.#write(project, revision, input.actor, (current) => ({ grants: current.grants, rules: [...(current.rules ?? []), rule], events: [[`rule:${rule.effect}:${rule.permission}`, rule.effect !== "deny"]], restrictive: rule.effect !== "allow" }));
  }
  removeRule(project: PermissionProject, ruleId: string, revision: unknown, actor: string): PermissionSnapshot {
    return this.#write(project, revision, actor, (current) => {
      const rule = (current.rules ?? []).find((entry) => entry.id === ruleId);
      if (!rule) throw new PermissionError("That rule no longer exists. Refresh and review again.");
      return { grants: current.grants, rules: (current.rules ?? []).filter((entry) => entry.id !== ruleId), events: [[`rule-removed:${rule.effect}:${rule.permission}`, false]], restrictive: rule.effect === "allow" };
    });
  }
  /**
   * Apply a preset in one action: its grants and rules replace the project's,
   * so the result is exactly what the preset card showed.
   */
  applyPreset(project: PermissionProject, presetId: unknown, revision: unknown, actor: string): PermissionSnapshot {
    const preset = PRESETS.find((entry) => entry.id === presetId);
    if (!preset) throw new PermissionError("Unknown preset.");
    return this.#write(project, revision, actor, (current) => {
      const at = Date.now();
      const grants: PermissionSnapshot["grants"] = {};
      for (const permission of preset.grants) grants[permission as AgentPermission] = { granted: true, actor, at };
      const events: Array<[string, boolean]> = [];
      for (const entry of AGENT_PERMISSIONS) {
        const before = current.grants[entry.id]?.granted === true;
        const after = grants[entry.id]?.granted === true;
        if (before !== after) events.push([entry.id, after]);
      }
      events.push([`preset:${preset.id}@${preset.version}`, true]);
      return { grants, rules: presetRules(preset, actor, at), events, restrictive: true };
    });
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
    return this.#write(project, revision, actor, (previous) => {
      const changed = requested.filter((permission) => previous.grants[permission as AgentPermission]?.granted !== granted) as AgentPermission[];
      const at = Date.now();
      const grants = { ...previous.grants };
      for (const permission of changed) grants[permission] = { granted, actor, at };
      return { grants, rules: previous.rules ?? [], events: changed.map((permission) => [permission, granted] as [string, boolean]), restrictive: !granted };
    });
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
  /**
   * Runs after a policy change; an object it returns is merged into the
   * response. `restrictive` is true when authority was reduced, which is when
   * running turns must stop; additions let them continue.
   */
  changed: (project: PermissionProject, change: { restrictive: boolean }) => unknown;
  mcp?: ManagedMcpTools;
  reviews?: OperationReviews;
}): express.Router {
  const router = express.Router();
  const view = (project: PermissionProject) => ({
    ...options.store.snapshot(project), categories: AGENT_PERMISSION_CATEGORIES, permissions: AGENT_PERMISSIONS, presets: PRESETS,
    workspaceRules: options.store.workspaceRules(project.workspaceId), history: options.store.history(project), supportedEngines: ["claude", "codex"],
  });
  const mutate = (req: express.Request, res: express.Response, apply: (project: PermissionProject, actor: string) => PermissionSnapshot) => {
    if (!isPermissionOperatorRequest(req)) { res.status(403).json({ error: "Change agent permissions from the local, same-origin cockpit." }); return; }
    try {
      const project = options.project(req.params.id);
      const before = options.store.snapshot(project);
      const after = apply(project, `local:${userInfo().username}`);
      const notice = after.revision === before.revision ? undefined : options.changed(project, { restrictive: (after.restrictedRevision ?? 0) > (before.restrictedRevision ?? 0) });
      res.json({ ...view(project), ...(notice && typeof notice === "object" ? notice : {}) });
    } catch (error) { res.status(error instanceof PermissionError ? 409 : 400).json({ error: (error as Error).message }); }
  };
  router.get("/api/projects/:id/agent-permissions", (req, res) => {
    try { res.json(view(options.project(req.params.id))); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  router.post("/api/projects/:id/agent-permissions", (req, res) => mutate(req, res, (project, actor) => {
    const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : [req.body?.permission];
    return options.store.changeMany(project, permissions, req.body?.granted, req.body?.revision, actor);
  }));
  router.post("/api/projects/:id/agent-permissions/preset", (req, res) => mutate(req, res, (project, actor) => options.store.applyPreset(project, req.body?.preset, req.body?.revision, actor)));
  router.post("/api/projects/:id/agent-permissions/rules", (req, res) => mutate(req, res, (project, actor) => options.store.addRule(project, {
    permission: String(req.body?.permission ?? ""), effect: req.body?.effect, scope: req.body?.scope ?? {}, duration: req.body?.duration, source: "custom", actor,
  }, req.body?.revision)));
  router.delete("/api/projects/:id/agent-permissions/rules/:rule", (req, res) => mutate(req, res, (project, actor) => options.store.removeRule(project, req.params.rule, req.body?.revision, actor)));
  router.get("/api/projects/:id/agent-tool-requests", (req, res) => {
    try { res.json({ requests: options.mcp?.history(options.project(req.params.id).id) ?? [] }); }
    catch { res.status(400).json({ error: "Project is not available." }); }
  });
  router.post("/api/projects/:id/agent-tool-requests/:request/decision", async (req, res) => {
    if (!isPermissionOperatorRequest(req)) { res.status(403).json({ error: "Review attached tool calls from the local cockpit." }); return; }
    try {
      if (!options.mcp || typeof req.body?.approve !== "boolean") throw new Error("Invalid MCP review.");
      const project = options.project(req.params.id);
      res.json(await options.mcp.decide(project.id, req.params.request, req.body.digest, req.body.approve, `local:${userInfo().username}`, req.body?.always === true, project));
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
  router.get("/api/projects/:id/agent-reviews", (req, res) => {
    try { res.json({ reviews: options.reviews?.list(options.project(req.params.id).id) ?? [] }); }
    catch { res.status(400).json({ error: "Project is not available." }); }
  });
  router.post("/api/projects/:id/agent-reviews/:review/decision", (req, res) => {
    if (!isPermissionOperatorRequest(req)) { res.status(403).json({ error: "Answer reviews from the local cockpit." }); return; }
    try {
      if (!options.reviews) throw new Error("Reviews are not available.");
      const project = options.project(req.params.id);
      const review = options.reviews.decide(project, req.params.review, req.body?.answer, `local:${userInfo().username}`);
      // Approving only adds authority, so running turns continue and can retry.
      res.json({ review, permissions: view(project) });
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
  return router;
}
