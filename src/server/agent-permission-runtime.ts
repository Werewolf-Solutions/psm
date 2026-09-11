import { createSdkMcpServer, query, tool, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { childEnv } from "./procs.ts";
import { RepositoryTools } from "./agent-repository-tools.ts";
import type { AgentPermissionStore, PermissionSnapshot } from "./agent-permissions.ts";

export interface ManagedAgentPolicy {
  store: AgentPermissionStore;
  snapshots: PermissionSnapshot[];
  protectedRoots: string[];
  projectBoundaries?: string[];
}
export function managedAgentOptions(server: ReturnType<typeof createSdkMcpServer>, signal: AbortController): Options {
  return {
    env: childEnv(),
    tools: [],
    allowedTools: ["mcp__psm__*"],
    permissionMode: "dontAsk",
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: { psm: server },
    plugins: [],
    persistSession: false,
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
  const project = z.string().describe("Registered project ID from the session scope");
  const invoke = async (id: string, action: (repository: RepositoryTools) => unknown) => {
    try {
      if (input.signal.signal.aborted) throw new Error("This turn was stopped.");
      const repository = repositories.get(id);
      if (!repository) throw new Error("This project is outside the workroom scope.");
      const result = action(repository);
      return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) }] };
    } catch (error) {
      // Never relay raw subprocess stderr, which may contain credential/config values.
      const message = error instanceof Error && error.name !== "Error" ? error.message : "The repository operation failed. Check the file path, Git state and local Git author configuration.";
      return { isError: true, content: [{ type: "text" as const, text: error instanceof Error && !("stderr" in error) ? error.message : message }] };
    }
  };
  const server = createSdkMcpServer({ name: "psm", version: "1.0.0", tools: [
    tool("files", "List ordinary project files.", { project }, ({ project }) => invoke(project, (repo) => repo.list())),
    tool("read", "Read one project text file.", { project, file: z.string() }, ({ project, file }) => invoke(project, (repo) => repo.read(file))),
    tool("search", "Search project files for literal text.", { project, text: z.string() }, ({ project, text }) => invoke(project, (repo) => repo.search(text))),
    tool("write", "Create or replace a project text file. Read existing files first.", { project, file: z.string(), content: z.string() }, ({ project, file, content }) => invoke(project, (repo) => repo.write(file, content))),
    tool("mkdir", "Create one project directory inside an existing directory.", { project, directory: z.string() }, ({ project, directory }) => invoke(project, (repo) => repo.mkdir(directory))),
    tool("git_read", "Inspect Git status, recent commit summaries, or the diff of a named file.", { project, operation: z.enum(["status", "log", "diff"]), file: z.string().optional() }, ({ project, operation, file }) => invoke(project, (repo) => repo.gitRead(operation, file))),
    tool("git_stage", "Stage explicit file paths. Preserves unrelated staged work by refusing if the index belongs to another turn. Does not execute filters.", { project, files: z.array(z.string()).min(1).max(100) }, ({ project, files }) => invoke(project, (repo) => repo.stage(files))),
    tool("git_commit", "Commit this turn's staged changes locally, with Git hooks and signing disabled. Does not publish.", { project, message: z.string() }, ({ project, message }) => invoke(project, (repo) => repo.commit(message))),
    tool("git_branch", "Create a local branch at HEAD; does not switch or delete branches.", { project, name: z.string() }, ({ project, name }) => invoke(project, (repo) => repo.branch(name))),
  ] });
  return server;
}

export async function runManagedAgent(input: {
  policy: ManagedAgentPolicy; cwd: string; model: string | null; effort?: string | null;
  message: string; context: string; signal: AbortController;
  event: (event: unknown) => void;
}): Promise<void> {
  const server = createManagedRepositoryServer(input.policy, input.signal);
  const scope = input.policy.snapshots.map(({ project, grants }) => `${project.name}: ${project.id}; grants: ${Object.entries(grants).filter(([, value]) => value?.granted).map(([name]) => name).join(", ") || "none"}`).join("\n");
  const stream = query({
    // SDK MCP servers require streaming input, including for a single user turn.
    prompt: (async function* () { yield { type: "user" as const, session_id: "", parent_tool_use_id: null, message: { role: "user" as const, content: input.message } }; })(),
    options: {
      ...managedAgentOptions(server, input.signal), cwd: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      ...(["low", "medium", "high", "xhigh", "max"].includes(input.effort ?? "") ? { effort: input.effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
      systemPrompt: `${input.context}\n\nPSM managed project scope:\n${scope}\nUse only the PSM tools. Grants are enforced outside the conversation. No shell, external integrations, tests, installs or publishing tools are available. If an unavailable operation is needed, ask the operator using the PSM question marker and stop.`,
    },
  });
  try { for await (const event of stream) input.event(event); }
  finally { stream.close(); }
}
