import { createSdkMcpServer, query, tool, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { ManagedMcpTools } from "./agent-mcp-tools.ts";
import { ManagedTaskRunner } from "./agent-task-runner.ts";
import { runCodexManaged } from "./agent-codex-runtime.ts";
import { z } from "zod";
import { childEnv } from "./procs.ts";
import { RepositoryTools } from "./agent-repository-tools.ts";
import { GrantRequiredError, ReviewRequiredError, type AgentPermissionStore, type PermissionSnapshot } from "./agent-permissions.ts";
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
}
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
  const repositories = new Map(input.policy.snapshots.map((snapshot) => [snapshot.project.id, new RepositoryTools(snapshot, input.policy.store, [...input.policy.protectedRoots, ...(input.policy.projectBoundaries ?? []).filter((root) => root.startsWith(snapshot.project.path + "/"))])]));
  const tasks = new Map([...repositories].map(([id, repo]) => [id, new ManagedTaskRunner(repo, policy.store, signal.signal)]));
  signal.signal.addEventListener("abort", () => { for (const task of tasks.values()) task.close(); }, { once: true });
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
  const server = createSdkMcpServer({ name: "psm", version: "1.0.0", tools: [
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
    tool("run_tests", "Run node --test or a test/test:… npm script offline in the disposable sandbox. Install dependencies first if needed.", { project, script: z.string().default("test") }, ({ project, script }) => invoke(project, () => tasks.get(project)!.tests(script))),
    tool("run_script", "Run a package.json script (build, typecheck, lint, …) offline in the disposable sandbox and return its output. Install dependencies first if it needs them.", { project, script: z.string() }, ({ project, script }) => invoke(project, () => tasks.get(project)!.script(script))),
    tool("preview_check", "Start a package.json script that serves the app (dev or preview) in the offline sandbox, wait for its port, fetch the given paths from inside the sandbox and return status, content type and the start of each body. Install dependencies first.", { project, script: z.string(), port: z.number().int(), paths: z.array(z.string()).max(10).default(["/"]) }, ({ project, script, port, paths }) => invoke(project, () => tasks.get(project)!.preview(script, port, paths))),
    tool("install_packages", "Install the public npm lockfile into the disposable turn sandbox. Requires pkg.install; no lifecycle scripts or checkout changes.", { project }, ({ project }) => invoke(project, () => tasks.get(project)!.install())),
    tool("files", "List ordinary project files.", { project }, ({ project }) => invoke(project, (repo) => repo.list())),
    tool("read", "Read one project text file.", { project, file: z.string() }, ({ project, file }) => invoke(project, (repo) => repo.read(file))),
    tool("search", "Search project files for literal text.", { project, text: z.string() }, ({ project, text }) => invoke(project, (repo) => repo.search(text))),
    tool("write", "Create or replace a project text file. Read existing files first.", { project, file: z.string(), content: z.string() }, ({ project, file, content }) => invoke(project, (repo) => repo.write(file, content))),
    tool("mkdir", "Create one project directory inside an existing directory.", { project, directory: z.string() }, ({ project, directory }) => invoke(project, (repo) => repo.mkdir(directory))),
    tool("delete", "Delete one ordinary file or empty directory.", { project, file: z.string() }, ({ project, file }) => invoke(project, (repo) => repo.delete(file))),
    tool("git_read", "Inspect Git status, recent commit summaries, or the diff of a named file.", { project, operation: z.enum(["status", "log", "diff"]), file: z.string().optional() }, ({ project, operation, file }) => invoke(project, (repo) => repo.gitRead(operation, file))),
    tool("git_stage", "Stage explicit file paths. Preserves unrelated staged work by refusing if the index belongs to another turn. Does not execute filters.", { project, files: z.array(z.string()).min(1).max(100) }, ({ project, files }) => invoke(project, (repo) => repo.stage(files))),
    tool("git_commit", "Commit this turn's staged changes locally. PSM increments root X.Y.Z's final component for code changes unless a newer version is already staged, and synchronizes root lockfiles. Docs-only commits need no increment. Hooks and signing are disabled. Does not publish.", { project, message: z.string() }, ({ project, message }) => invoke(project, (repo) => repo.commit(message))),
    tool("git_branch", "Create a local branch at HEAD without switching.", { project, name: z.string() }, ({ project, name }) => invoke(project, (repo) => repo.branch(name))),
    tool("git_branch_delete", "Delete a fully merged local branch.", { project, name: z.string() }, ({ project, name }) => invoke(project, (repo) => repo.deleteBranch(name))),
    tool("git_switch", "Switch to an existing local branch.", { project, name: z.string() }, ({ project, name }) => invoke(project, (repo) => repo.switchBranch(name))),
    tool("git_merge", "Merge a local or remote-tracking branch into the current branch.", { project, ref: z.string() }, ({ project, ref }) => invoke(project, (repo) => repo.merge(ref))),
    tool("git_fetch", "Fetch from an operator-configured Git remote.", { project, remote: z.string().default("origin") }, ({ project, remote }) => invoke(project, (repo) => repo.fetch(remote))),
    tool("git_push", "Push HEAD without force to a named branch on an operator-configured Git remote.", { project, remote: z.string().default("origin"), branch: z.string().optional() }, ({ project, remote, branch }) => invoke(project, (repo) => repo.push(remote, branch))),
  ] });
  const close = server.instance.close.bind(server.instance);
  server.instance.close = async () => { for (const task of tasks.values()) task.close(); await close(); };
  return server;
}

export async function runManagedAgent(input: {
  policy: ManagedAgentPolicy; engine?: string; cwd: string; model: string | null; effort?: string | null;
  message: string; context: string; signal: AbortController;
  event: (event: unknown) => void;
  /** A managed Claude session to resume; the caller checked its authority is unchanged. */
  resume?: string | null;
}): Promise<void> {
  const server = createManagedRepositoryServer(input.policy, input.signal);
  const scope = input.policy.snapshots.map(({ project, grants }) => `${project.name}: ${project.id}; grants: ${Object.entries(grants).filter(([, value]) => value?.granted).map(([name]) => name).join(", ") || "none"}`).join("\n");
  const context = `${input.context}\n\nPSM managed project scope:\n${scope}\nUse the PSM tools. Grants are enforced outside the conversation. When an operation is unavailable, call access_status for its concrete cause, then tell the operator exactly that (a grant, a review, a connection, a runner, or unsupported) with the PSM question marker.`;
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
