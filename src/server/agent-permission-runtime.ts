import { createSdkMcpServer, query, tool, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { ManagedMcpTools } from "./agent-mcp-tools.ts";
import { ManagedTaskRunner } from "./agent-task-runner.ts";
import { runCodexManaged } from "./agent-codex-runtime.ts";
import { z } from "zod";
import { childEnv } from "./procs.ts";
import { RepositoryTools } from "./agent-repository-tools.ts";
import { JobSandboxShell } from "./executor/sandbox-shell.ts";
import { GrantRequiredError, PermissionError, ReviewRequiredError, type AgentPermissionStore, type PermissionChecker, type PermissionSnapshot } from "./agent-permissions.ts";
import type { OperationReviews } from "./agent-reviews.ts";
import type { MachineCommands } from "./machines/commands.ts";

export interface ManagedAgentPolicy {
  store: AgentPermissionStore;
  snapshots: PermissionSnapshot[];
  protectedRoots: string[];
  projectBoundaries?: string[];
  mcp?: ManagedMcpTools;
  /** Where Ask decisions become operator reviews. */
  reviews?: OperationReviews;
  /** Commands on servers connected to the scoped projects. */
  machines?: MachineCommands;
  /** What the agent can do per project, and why not; the same answer the operator sees. */
  explain?: (snapshot: PermissionSnapshot) => Promise<unknown>;
  /** The operator's decisions for this task, carried into every turn. */
  taskNotes?: string;
  /** Checks each operation instead of `store`: an implement job's own grant. */
  checker?: PermissionChecker;
  /** Files changed by an implement job, used to select package checks. */
  affectedFiles?: () => string[];
  /**
   * Projects a preview may start as backend services, beside the scoped ones.
   * Never tool targets: the agent gets no files or shell in them, and only
   * repo.read and script.run are honoured on them.
   */
  previewServices?: PermissionSnapshot[];
  /**
   * `implement`: an unattended job in its own clone. No push, fetch, merge,
   * branch switching, server commands or attached integrations — the tools are
   * not offered at all, on top of the checker refusing them.
   */
  profile?: "implement";
}

/** What a preview may do in a project it only starts as a backend service. */
const PREVIEW_SERVICE_PERMISSIONS: ReadonlySet<string> = new Set(["repo.read", "script.run"]);
export function previewServiceChecker(checker: PermissionChecker): PermissionChecker {
  return {
    check(snapshot, permission, ...rest) {
      if (!PREVIEW_SERVICE_PERMISSIONS.has(permission)) throw new PermissionError(`${snapshot.project.name} is only a preview service here: it can be read and started, not changed.`);
      return checker.check(snapshot, permission, ...rest);
    },
  };
}

/** Tools an implement job never sees. */
export const IMPLEMENT_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  "git_push", "git_fetch", "git_merge", "git_switch", "git_branch_delete",
  "git_commit", "git_stage", "git_branch",
  "server_environments", "server_command",
  "attached_tools", "request_attached_call", "attached_call_result",
  "access_status",
]);
export function managedAgentOptions(server: ReturnType<typeof createSdkMcpServer>, signal: AbortController, resume: string | null = null): Options {
  return {
    env: childEnv(),
    tools: [],
    allowedTools: ["mcp__psm__*"],
    permissionMode: "dontAsk",
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: { psm: server },
    plugins: [],
    // Kept so the next turn can resume it while its authority is unchanged.
    persistSession: true,
    ...(resume ? { resume } : {}),
    abortController: signal,
    // A policy guard is independent of automatic approval and inherited settings.
    hooks: { PreToolUse: [{ hooks: [async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: input.tool_name.startsWith("mcp__psm__") ? "allow" : "deny", permissionDecisionReason: "Only PSM repository tools are available in this managed session." } };
    }] }] },
  };
}
export function createManagedRepositoryServer(policy: ManagedAgentPolicy, signal: AbortController) {
  const input = { policy, signal };
  const checker = policy.checker ?? policy.store;
  const repositories = new Map(input.policy.snapshots.map((snapshot) => [snapshot.project.id, new RepositoryTools(snapshot, checker, [...input.policy.protectedRoots, ...(input.policy.projectBoundaries ?? []).filter((root) => root.startsWith(snapshot.project.path + "/"))], input.policy.affectedFiles)]));
  // A preview's backend services come from projects in this session's scope, or
  // from the read-only preview services the policy names.
  const serviceChecker = previewServiceChecker(checker);
  const services = (input.policy.previewServices ?? []).map((snapshot) => new RepositoryTools(snapshot, serviceChecker, input.policy.protectedRoots));
  const byName = (name: string) => [...repositories.values()].find((repo) => repo.snapshot.project.name === name)
    ?? services.find((repo) => repo.snapshot.project.name === name);
  const tasks = new Map([...repositories].map(([id, repo]) => [id, new ManagedTaskRunner(repo, checker, signal.signal, undefined, undefined, byName, { checkoutDeps: policy.profile === "implement" })]));
  signal.signal.addEventListener("abort", () => { for (const task of tasks.values()) task.close(); }, { once: true });
  const directory = z.string().default(".").describe("Repository-relative package directory, e.g. client; defaults to project root");
  const project = z.string().describe("Registered project ID from the session scope");
  const invoke = async (id: string, action: (repository: RepositoryTools) => unknown) => {
    try {
      if (input.signal.signal.aborted) throw new Error("This turn was stopped.");
      const repository = repositories.get(id);
      if (!repository) throw new Error("This project is outside the workroom scope.");
      const result = await action(repository);
      return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) }] };
    } catch (error) {
      if (error instanceof ReviewRequiredError) {
        const snapshot = repositories.get(id)?.snapshot;
        if (snapshot && input.policy.reviews) {
          const review = input.policy.reviews.request(snapshot, error.permission, error.context, error.summary, error.message);
          const kind = error instanceof GrantRequiredError ? "Access request" : "Operator review";
          return { isError: true, content: [{ type: "text" as const, text: `${kind} needed (${review.id}): ${error.summary}\n${error.message}\nTell the operator what you want to do and why, ask them to answer it in Capabilities → Agent permissions (once, for this task, or always), then call this tool again with the same arguments.` }] };
        }
      }
      // Never relay raw subprocess stderr, which may contain credential/config values.
      const message = error instanceof Error && error.name !== "Error" ? error.message : "The repository operation failed. Check the file path, Git state and local Git author configuration.";
      return { isError: true, content: [{ type: "text" as const, text: error instanceof Error && !("stderr" in error) ? error.message : message }] };
    }
  };
  const tools = [
    ...(policy.profile === "implement" ? [tool("sandbox_shell", "Run any shell command in the job's isolated Docker clone. The shell can read and edit that clone and commit locally. It has no host filesystem, provider credentials, Docker socket or network, so it cannot download packages: the clone's node_modules already holds the project's packages (install_packages refreshes them after a lockfile change). Use PSM checks for verification.", { project, command: z.string().min(1).max(20_000), timeoutSeconds: z.number().int().min(1).max(600).optional() }, ({ project, command, timeoutSeconds }) => invoke(project, async (repo) => {
      // An unrestricted shell cannot honor a partial workspace deny. Require
      // every capability it can exercise before handing it the clone.
      for (const permission of ["repo.read", "repo.edit", "repo.delete", "test.run", "script.run", "pkg.install", "git.commit"] as const) checker.check(repo.snapshot, permission);
      return new JobSandboxShell(repo.snapshot.project.path).run(command, signal.signal, (timeoutSeconds ?? 600) * 1000);
    }))] : []),
    ...(policy.mcp ? [
      tool("attached_tools", "List reviewed project attachments and their MCP tools.", { project }, ({ project }) => invoke(project, (repo) => policy.mcp!.list(repo.snapshot))),
      tool("request_attached_call", "Request an exact attached MCP call for operator approval in Capabilities. Ask the operator to review, then use attached_call_result.", { project, capability: z.string(), tool: z.string(), arguments: z.record(z.string(), z.unknown()) }, (args) => invoke(args.project, (repo) => policy.mcp!.request(repo.snapshot, args.capability, args.tool, args.arguments))),
      tool("attached_call_result", "Read the outcome of an operator-reviewed attached MCP call.", { project, request: z.string() }, ({ project, request }) => invoke(project, (repo) => policy.mcp!.result(repo.snapshot, request))),
    ] : []),
    ...(policy.machines ? [
      tool("server_environments", "List servers connected to a project, by environment, with the unprivileged account and directory commands run as.", { project }, ({ project }) => invoke(project, () => policy.machines!.environments(project))),
      tool("server_command", "Run one shell command on a project's connected server for an environment, as that environment's own command account (no sudo, its own working directory). May need operator review.", { project, environment: z.string(), command: z.string(), timeoutSeconds: z.number().int().min(5).max(600).optional() }, ({ project, environment, command, timeoutSeconds }) => invoke(project, (repo) => policy.machines!.run({ snapshot: repo.snapshot, permissions: input.policy.store, environmentId: environment, command, timeoutSeconds, signal: input.signal.signal }))),
    ] : []),
    ...(policy.explain ? [
      tool("access_status", "Explain what you can and cannot do in a project right now, and for each gap whether it needs a grant, a review, a connection or a runner, or is unsupported. Check this before telling the operator something is impossible.", { project }, ({ project }) => invoke(project, (repo) => policy.explain!(repo.snapshot))),
    ] : []),
    tool("verification_status", "List package directories requiring a build or browser check before a code commit. If verification is blocked, report the task as unverified and incomplete.", { project }, ({ project }) => invoke(project, repo => repo.verificationStatus())),
    tool("run_tests", "Run node --test or a test/test:… npm script offline in the disposable sandbox. Install dependencies first if needed.", { project, script: z.string().default("test") }, ({ project, script }) => invoke(project, () => tasks.get(project)!.tests(script))),
    tool("run_script", "Run a package.json script (build, typecheck, lint, …) offline in the disposable sandbox and return its output. Install dependencies first if it needs them.", { project, script: z.string(), directory }, ({ project, script, directory }) => invoke(project, () => tasks.get(project)!.script(script, directory))),
    tool("preview_check", "Load each app route in Chromium inside the offline sandbox. Fails on JavaScript errors, failed local requests, Vite error overlays or blank app content. Requires the preloaded PSM browser image. Install dependencies first. An app whose own API is absent offline can declare canned fetch responses in psm-preview.json beside its package.json, or (schema v2) declare its real backend as a service from another in-scope project, started on an internal network with empty databases; the result lists each fixture and expected answer used. A listening dev server alone is not verification.", { project, script: z.string(), port: z.number().int(), paths: z.array(z.string()).max(10).default(["/"]), directory, signedIn: z.boolean().default(false).describe("Load the routes signed in, using the session psm-preview.json declares; the cookie carries across routes") }, ({ project, script, port, paths, directory, signedIn }) => invoke(project, () => tasks.get(project)!.preview(script, port, paths, directory, signedIn))),
    tool("install_packages", "Install the public npm lockfile for the selected package directory into the disposable turn sandbox. Requires pkg.install; no lifecycle scripts or checkout changes.", { project, directory }, ({ project, directory }) => invoke(project, () => tasks.get(project)!.install(directory))),
    tool("files", "List ordinary project files.", { project }, ({ project }) => invoke(project, (repo) => repo.list())),
    tool("read", "Read one project text file.", { project, file: z.string() }, ({ project, file }) => invoke(project, (repo) => repo.read(file))),
    tool("search", "Search project files for literal text.", { project, text: z.string() }, ({ project, text }) => invoke(project, (repo) => repo.search(text))),
    tool("write", "Create or replace a project text file. Read existing files first.", { project, file: z.string(), content: z.string() }, ({ project, file, content }) => invoke(project, (repo) => repo.write(file, content))),
    tool("mkdir", "Create one project directory inside an existing directory.", { project, directory: z.string() }, ({ project, directory }) => invoke(project, (repo) => repo.mkdir(directory))),
    tool("delete", "Delete one ordinary file or empty directory.", { project, file: z.string() }, ({ project, file }) => invoke(project, (repo) => repo.delete(file))),
    tool("git_read", "Inspect Git status, recent commit summaries, or the diff of a named file.", { project, operation: z.enum(["status", "log", "diff"]), file: z.string().optional() }, ({ project, operation, file }) => invoke(project, (repo) => repo.gitRead(operation, file))),
    tool("git_stage", "Stage explicit file paths. Preserves unrelated staged work by refusing if the index belongs to another turn. Does not execute filters.", { project, files: z.array(z.string()).min(1).max(100) }, ({ project, files }) => invoke(project, (repo) => repo.stage(files))),
    tool("git_commit", "Commit this turn's staged changes locally. Code commits require successful build scripts and frontend browser checks against current source; blocked checks mean the task remains unverified. Use verification_status to discover required checks. Choose releaseBump from the change: major for breaking changes, minor for compatible features, patch for fixes. Defaults to patch. PSM computes the root X.Y.Z version and synchronizes root lockfiles; an already staged higher version is preserved. Docs-only commits need no increment. Hooks and signing are disabled. Does not publish.", { project, message: z.string(), releaseBump: z.enum(["major", "minor", "patch"]).optional() }, ({ project, message, releaseBump }) => invoke(project, (repo) => repo.commit(message, releaseBump))),
    tool("git_branch", "Create a local branch at HEAD without switching.", { project, name: z.string() }, ({ project, name }) => invoke(project, (repo) => repo.branch(name))),
    tool("git_branch_delete", "Delete a fully merged local branch.", { project, name: z.string() }, ({ project, name }) => invoke(project, (repo) => repo.deleteBranch(name))),
    tool("git_switch", "Switch to an existing local branch.", { project, name: z.string() }, ({ project, name }) => invoke(project, (repo) => repo.switchBranch(name))),
    tool("git_merge", "Merge a local or remote-tracking branch into the current branch.", { project, ref: z.string() }, ({ project, ref }) => invoke(project, (repo) => repo.merge(ref))),
    tool("git_fetch", "Fetch from an operator-configured Git remote.", { project, remote: z.string().default("origin") }, ({ project, remote }) => invoke(project, (repo) => repo.fetch(remote))),
    tool("git_push", "Push HEAD without force to a named branch on an operator-configured Git remote.", { project, remote: z.string().default("origin"), branch: z.string().optional() }, ({ project, remote, branch }) => invoke(project, (repo) => repo.push(remote, branch))),
  ];
  const offered = policy.profile === "implement" ? tools.filter((entry) => !IMPLEMENT_EXCLUDED_TOOLS.has(entry.name)) : tools;
  const server = createSdkMcpServer({ name: "psm", version: "1.0.0", tools: offered });
  const close = server.instance.close.bind(server.instance);
  server.instance.close = async () => { for (const task of tasks.values()) task.close(); await close(); };
  return server;
}

export async function runManagedAgent(input: {
  policy: ManagedAgentPolicy; engine?: string; cwd: string; model: string | null; effort?: string | null;
  message: string; context: string; signal: AbortController;
  event: (event: unknown) => void;
  /** A managed provider session to resume; its authority was checked by the caller. */
  resume?: string | null;
  resumeToolsDigest?: string | null;
}): Promise<void> {
  const server = createManagedRepositoryServer(input.policy, input.signal);
  const scope = input.policy.snapshots.map(({ project, grants }) => `${project.name}: ${project.id}; grants: ${Object.entries(grants).filter(([, value]) => value?.granted).map(([name]) => name).join(", ") || "none"}`).join("\n");
  const unavailable = input.policy.profile === "implement"
    ? "If a tool is unavailable, explain the blocker in your final summary; this job cannot request more permissions."
    : "When an operation is unavailable, call access_status for its concrete cause, then tell the operator exactly that (a grant, a review, a connection, a runner, or unsupported) with the PSM question marker.";
  const commitGuidance = input.policy.profile === "implement"
    ? "Use sandbox_shell for edits and local Git commits. Final review requires passing checks against the current source; use the PSM tools for those checks."
    : "Code commits enforce these checks. Use the PSM tools.";
  const context = `${input.context}\n\nPSM managed project scope:\n${scope}\nFor code changes, call verification_status, install each required package directory and its dependencies (including server packages used by root scripts), run required builds and use preview_check for frontend routes you changed. Successful dev-server startup does not prove the app works. Recheck after edits. If a check fails or cannot run, keep the work unverified and incomplete; report the concrete blocker, and do not claim completion. ${commitGuidance} Grants are enforced outside the conversation. ${unavailable}`;
  if (input.engine === "codex") return runCodexManaged({ ...input, server, context });
  const stream = query({
    // SDK MCP servers require streaming input, including for a single user turn.
    prompt: (async function* () { yield { type: "user" as const, session_id: "", parent_tool_use_id: null, message: { role: "user" as const, content: input.message } }; })(),
    options: {
      ...managedAgentOptions(server, input.signal, input.resume ?? null), cwd: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      ...(["low", "medium", "high", "xhigh", "max"].includes(input.effort ?? "") ? { effort: input.effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
      systemPrompt: context,
    },
  });
  try { for await (const event of stream) input.event(event); }
  finally { stream.close(); await server.instance.close(); }
}
