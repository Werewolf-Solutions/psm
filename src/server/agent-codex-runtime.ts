import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { createManagedRepositoryServer } from "./agent-permission-runtime.ts";
import { childEnv } from "./procs.ts";

// Reviewed against the installed app-server 0.154 protocol. No inherited MCP,
// plugins, executable skills, shell or network tools enter a managed turn.
const DISABLED = ["shell_tool", "unified_exec", "apply_patch_freeform", "apps", "connectors", "plugins", "plugin_hooks", "hooks", "codex_hooks", "code_mode", "code_mode_host", "js_repl", "multi_agent", "multi_agent_v2", "collab", "browser_use", "computer_use", "view_image", "image_generation", "memory_tool", "memories", "skill_search", "skill_mcp_dependency_install", "tool_suggest", "tool_search", "search_tool", "request_permissions", "request_permissions_tool", "shell_snapshot", "worktrees"];
export function codexManagedConfig(inherited: Record<string, unknown>, directory: string): Record<string, unknown> {
  const servers = inherited.mcp_servers && typeof inherited.mcp_servers === "object" ? inherited.mcp_servers : {};
  return {
    ...Object.fromEntries(DISABLED.map((name) => [`features.${name}`, false])),
    "features.skip_host_skill_discovery": true,
    mcp_servers: Object.fromEntries(Object.entries(servers).map(([name, value]) => [name, { ...(value && typeof value === "object" ? value : {}), enabled: false }])),
    web_search: "disabled", project_doc_max_bytes: 0, notify: [],
    // Even a model-native file tool has no write authority. The only readable
    // workspace is an empty disposable directory; repository access is brokered.
    "permissions.psm.filesystem": { "/": "deny", [directory]: "read" },
    "permissions.psm.network.enabled": false,
  };
}

/** Small stdio JSON-RPC client. Server requests never imply operator approval. */
export class CodexRpc {
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  onNotification: (method: string, params: any) => void = () => {};
  onRequest: (method: string, params: any) => Promise<unknown> = async () => { throw new Error("Request not permitted in a managed session"); };
  onFailure: (error: Error) => void = () => {};
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id != null) {
        void this.onRequest(message.method, message.params).then(
          (result) => this.write({ id: message.id, result }),
          () => this.write({ id: message.id, error: { code: -32601, message: "Operation denied by PSM managed permissions" } }),
        );
      } else if (message.method) this.onNotification(message.method, message.params);
      else {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`Codex app-server: ${message.error.message}`));
        else pending.resolve(message.result);
      }
    });
    const fail = () => {
      const error = new Error("Codex app-server stopped before the managed turn completed.");
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear(); this.onFailure(error);
    };
    child.on("error", fail); child.on("exit", fail);
    child.stdin.on("error", () => {});
    // Drain diagnostic output without leaking authentication/configuration data.
    child.stderr.resume();
  }
  private write(value: unknown): void { if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(value) + "\n"); }
  notify(method: string, params?: unknown): void { this.write({ method, ...(params ? { params } : {}) }); }
  request(method: string, params: unknown): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex app-server timed out during ${method}.`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer }); this.write({ id, method, params });
    });
  }
  close(): void {
    this.onFailure = () => {}; this.child.kill("SIGTERM");
    const timer = setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL"); }, 1000);
    timer.unref(); this.child.once("exit", () => clearTimeout(timer));
  }
}

export async function runCodexManaged(input: {
  server: ReturnType<typeof createManagedRepositoryServer>; model: string | null; effort?: string | null;
  message: string; context: string; signal: AbortController; event: (event: unknown) => void;
  launch?: (args: string[], cwd: string) => ChildProcessWithoutNullStreams;
}): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-codex-"));
  const client = new Client({ name: "psm-codex-broker", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const scalarArgs = Object.entries(codexManagedConfig({}, directory)).filter(([, value]) => typeof value !== "object").flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
  const rpc = new CodexRpc(input.launch ? input.launch(["app-server", ...scalarArgs], directory) : spawn("codex", ["app-server", ...scalarArgs], { cwd: directory, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] }));
  const aborted = () => rpc.child.kill("SIGTERM");
  input.signal.signal.addEventListener("abort", aborted, { once: true });
  try {
    if (input.signal.signal.aborted) throw new Error("This turn was stopped.");
    await input.server.instance.connect(serverTransport); await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => `psm_${tool.name}`));
    rpc.onRequest = async (method, params) => {
      if (method !== "item/tool/call" || !names.has(params.tool) || params.namespace != null || input.signal.signal.aborted) throw new Error("Tool denied");
      const result = await client.callTool({ name: params.tool.slice(4), arguments: params.arguments });
      input.event({ type: "assistant", message: { content: [{ type: "tool_use", id: params.callId, name: params.tool, input: params.arguments }] } });
      return { success: !result.isError, contentItems: [{ type: "inputText", text: JSON.stringify(result.content) }] };
    };
    await rpc.request("initialize", { clientInfo: { name: "psm", version: "1" }, capabilities: { experimentalApi: true } });
    rpc.notify("initialized");
    const inherited = await rpc.request("config/read", { includeLayers: false, cwd: directory });
    const started = await rpc.request("thread/start", {
      cwd: directory, ephemeral: true, approvalPolicy: "never", permissions: "psm",
      config: codexManagedConfig(inherited.config ?? {}, directory), environments: [], selectedCapabilityRoots: [],
      ...(input.model ? { model: input.model } : {}), developerInstructions: input.context,
      dynamicTools: tools.map((tool) => ({ type: "function", name: `psm_${tool.name}`, description: tool.description ?? tool.name, inputSchema: tool.inputSchema })),
    });
    const completed = new Promise<void>((resolve, reject) => {
      rpc.onFailure = reject;
      rpc.onNotification = (method, params) => {
        if (method === "item/completed" && params.item?.type === "agentMessage") input.event({ type: "assistant", message: { content: [{ type: "text", text: params.item.text }] } });
        if (method === "turn/completed") {
          if (params.turn?.status === "failed") reject(new Error(params.turn.error?.message ?? "Codex turn failed."));
          else resolve();
        }
        if (method === "error" && params.willRetry === false) reject(new Error(params.error?.message ?? "Codex turn failed."));
      };
    });
    // Observe immediately so a startup failure cannot create an unhandled rejection.
    void completed.catch(() => {});
    await rpc.request("turn/start", { threadId: started.thread.id, input: [{ type: "text", text: input.message, text_elements: [] }], environments: [], ...(input.effort ? { effort: input.effort } : {}) });
    await completed;
  } finally {
    input.signal.signal.removeEventListener("abort", aborted); rpc.close();
    await client.close(); await input.server.instance.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}
