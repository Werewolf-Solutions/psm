import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { createManagedRepositoryServer } from "./agent-permission-runtime.ts";
import { childEnv } from "./procs.ts";
import { ManagedResumeUnavailableError } from "./agent-session-errors.ts";

// Managed continuity reviewed against installed app-server 0.160. No inherited MCP,
// plugins, executable skills, shell or network tools enter a managed turn.
const DISABLED = ["shell_tool", "unified_exec", "apply_patch_freeform", "apps", "connectors", "plugins", "plugin_hooks", "hooks", "codex_hooks", "code_mode", "js_repl", "multi_agent", "multi_agent_v2", "collab", "browser_use", "computer_use", "view_image", "image_generation", "memory_tool", "memories", "skill_search", "skill_mcp_dependency_install", "tool_suggest", "tool_search", "search_tool", "request_permissions", "request_permissions_tool", "shell_snapshot", "worktrees"];
export function codexManagedConfig(inherited: Record<string, unknown>, directory: string): Record<string, unknown> {
  const servers = inherited.mcp_servers && typeof inherited.mcp_servers === "object" ? inherited.mcp_servers : {};
  return {
    ...Object.fromEntries(DISABLED.map((name) => [`features.${name}`, false])),
    // Dynamic PSM tools need the host dispatcher even while native code mode is off.
    "features.code_mode_host": true,
    "features.skip_host_skill_discovery": true,
    mcp_servers: Object.fromEntries(Object.entries(servers).map(([name, value]) => [name, { ...(value && typeof value === "object" ? value : {}), enabled: false }])),
    web_search: "disabled", project_doc_max_bytes: 0, notify: [],
    // Even a model-native file tool has no write authority. The only readable
    // workspace is an empty disposable directory; repository access is brokered.
    "permissions.psm.filesystem": { "/": "deny", [directory]: "read" },
    "permissions.psm.network.enabled": false,
    // app-server 0.156 refuses a config that defines permission profiles without naming the default.
    default_permissions: "psm",
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
    // Only the first "Error:" line is kept, so a startup failure (an unsupported
    // config after a Codex update, say) names its cause; nothing else is retained.
    let reason = "";
    createInterface({ input: child.stderr }).on("line", (line) => {
      const plain = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
      if (!reason && /^Error:/.test(plain)) reason = plain.slice(0, 300);
    });
    let failed = false;
    const fail = (detail = "") => {
      if (failed) return;
      failed = true;
      if (!reason) reason = detail;
      const error = new Error(`Codex app-server stopped before the managed turn completed.${reason ? ` ${reason}` : ""}`);
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear(); this.onFailure(error);
    };
    child.on("error", (error: NodeJS.ErrnoException) => fail(`Could not start Codex (${error.code ?? "spawn error"}). Check the PSM process PATH.`));
    child.on("close", (code, signal) => fail(code !== null ? `Exit code ${code}.` : signal ? `Signal ${signal}.` : ""));
    child.stdin.on("error", () => {});
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
  /** Only an authority-matched PSM managed thread, never a CLI thread. */
  resume?: string | null;
  resumeToolsDigest?: string | null;
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
    const dynamicTools = tools.map((tool) => ({ type: "function", name: `psm_${tool.name}`, description: tool.description ?? tool.name, inputSchema: tool.inputSchema }));
    const toolsDigest = createHash("sha256").update(JSON.stringify(dynamicTools.sort((a, b) => a.name.localeCompare(b.name)))).digest("hex");
    if (input.resume && input.resumeToolsDigest !== toolsDigest) throw new ManagedResumeUnavailableError("The managed Codex tool catalog changed. Start a fresh thread.");
    let threadId: string | null = null;
    let turnReady: Promise<string> | null = null;
    let turnFinished = false;
    rpc.onRequest = async (method, params) => {
      if (method !== "item/tool/call" || !names.has(params.tool) || params.namespace != null || params.threadId !== threadId || !turnReady || turnFinished || input.signal.signal.aborted) throw new Error("Tool denied");
      const turnId = await turnReady;
      if (params.turnId !== turnId || turnFinished || input.signal.signal.aborted) throw new Error("Tool denied");
      input.event({ type: "assistant", message: { content: [{ type: "tool_use", id: params.callId, name: params.tool, input: params.arguments }] } });
      if (input.signal.signal.aborted) throw new Error("The managed turn was stopped.");
      const result = await client.callTool({ name: params.tool.slice(4), arguments: params.arguments });
      input.event({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: params.callId, is_error: !!result.isError, content: result.content }] } });
      return { success: !result.isError, contentItems: [{ type: "inputText", text: JSON.stringify(result.content) }] };
    };
    await rpc.request("initialize", { clientInfo: { name: "psm", version: "1" }, capabilities: { experimentalApi: true } });
    rpc.notify("initialized");
    const inherited = await rpc.request("config/read", { includeLayers: false, cwd: directory });
    const threadOptions = {
      cwd: directory, runtimeWorkspaceRoots: [directory], approvalPolicy: "never", permissions: "psm",
      config: codexManagedConfig(inherited.config ?? {}, directory), environments: [], selectedCapabilityRoots: [],
      ...(input.model ? { model: input.model } : {}), developerInstructions: input.context,
    };
    let started: any;
    if (input.resume) {
      // Resume has no dynamicTools/environments/capability-root fields in 0.160.
      // Its stored tools match the digest above; every call uses this turn's broker.
      const { environments: _environments, selectedCapabilityRoots: _roots, ...resumeOptions } = threadOptions;
      try { started = await rpc.request("thread/resume", { ...resumeOptions, threadId: input.resume }); }
      catch (error) {
        if (error instanceof Error && /(?:no rollout found|(?:thread|session|rollout).*not found|(?:thread|session|rollout).*does not exist)/i.test(error.message)) {
          throw new ManagedResumeUnavailableError("The stored managed Codex thread is unavailable.", { cause: error });
        }
        throw error;
      }
    } else started = await rpc.request("thread/start", { ...threadOptions, ephemeral: false, dynamicTools });
    threadId = started.thread?.id;
    if (typeof threadId !== "string" || !threadId || (input.resume && threadId !== input.resume)) throw new Error("Codex returned an unexpected managed thread identity.");
    input.event({ type: "system", subtype: "init", session_id: threadId, psm_tools_digest: toolsDigest, model: started.model ?? input.model });
    const completed = new Promise<void>((resolve, reject) => {
      rpc.onFailure = reject;
      rpc.onNotification = (method, params) => {
        if (params.threadId !== threadId || !turnReady || turnFinished) return;
        void turnReady.then((turnId) => {
          if (turnFinished || (params.turnId ?? params.turn?.id) !== turnId) return;
          if (method === "item/completed" && params.item?.type === "agentMessage") input.event({ type: "assistant", message: { content: [{ type: "text", text: params.item.text }] } });
          if (method === "turn/completed") {
            turnFinished = true;
            if (params.turn?.status === "completed") resolve();
            else reject(new Error(params.turn?.error?.message ?? `Codex turn ${params.turn?.status ?? "failed"}.`));
          }
          if (method === "error" && params.willRetry === false) { turnFinished = true; reject(new Error(params.error?.message ?? "Codex turn failed.")); }
        }).catch(() => {});
      };
    });
    // Observe immediately so a startup failure cannot create an unhandled rejection.
    void completed.catch(() => {});
    turnReady = rpc.request("turn/start", { threadId, input: [{ type: "text", text: input.message, text_elements: [] }], environments: [], ...(input.effort ? { effort: input.effort } : {}) }).then((result) => {
      if (typeof result.turn?.id !== "string" || !result.turn.id) throw new Error("Codex returned no managed turn identity.");
      return result.turn.id;
    });
    await turnReady;
    await completed;
  } finally {
    input.signal.signal.removeEventListener("abort", aborted); rpc.close();
    await client.close(); await input.server.instance.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}
