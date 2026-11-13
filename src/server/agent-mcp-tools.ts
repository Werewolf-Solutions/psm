import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpCapability } from "../types.ts";
import { db } from "./db.ts";
import { selfAttachmentReason } from "./mcp/clients.ts";
import { AgentPermissionStore, PermissionError, type PermissionProject, type PermissionSnapshot } from "./agent-permissions.ts";

export interface AttachedCall {
  id: string; snapshot: PermissionSnapshot; capability: string; manifestDigest: string;
  tool: string; arguments: Record<string, unknown>; digest: string; expiresAt: number;
  state: "pending" | "running" | "succeeded" | "failed" | "rejected";
  actor?: string; result?: unknown;
}
/** `secrets` are values the server was given; they are redacted from anything it returns. */
export type McpConnection = { client: Pick<Client, "listTools" | "callTool">; close: () => Promise<void>; secrets?: string[] };
/**
 * Start or connect to an attached MCP server. Credentials come from the
 * secret broker when the operator stored them there (`credentials`), and only
 * otherwise from PSM's own environment.
 */
export async function connectAttachedMcp(capability: McpCapability, credentials: Record<string, string> | null = null): Promise<McpConnection> {
  const value = (name: string) => credentials?.[name] ?? process.env[name];
  const wire = capability.mcp;
  const selfAttachment = selfAttachmentReason(wire as Parameters<typeof selfAttachmentReason>[0], capability.requiredEnv);
  if (selfAttachment) throw new Error(selfAttachment);
  const client = new Client({ name: "psm-managed", version: "1" });
  if (wire.transport === "stdio") {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", ...wire.env };
    for (const name of capability.requiredEnv) { const found = value(name); if (found) env[name] = found; }
    const launch = wire.launch;
    const transport = new StdioClientTransport({
      command: launch.type === "npm-script" ? "npm" : launch.command,
      args: launch.type === "npm-script" ? ["--prefix", launch.workingDirectory, "run", launch.script] : launch.args,
      ...(launch.type === "npm-script" ? { cwd: launch.workingDirectory } : {}), env, stderr: "ignore",
    });
    try { await client.connect(transport); } catch { await transport.close(); throw new Error("Attached MCP server could not start. Check its configuration and required credentials."); }
  } else {
    const headers = { ...wire.headers };
    if (wire.bearerTokenEnvVar) {
      const token = value(wire.bearerTokenEnvVar);
      if (!token) throw new Error("The attached MCP credential is missing.");
      headers.Authorization = `Bearer ${token}`;
    }
    const transport = new StreamableHTTPClientTransport(new URL(wire.url), { requestInit: { headers, redirect: "error" } });
    try { await client.connect(transport); } catch { await transport.close(); throw new Error("Attached MCP server could not connect. Check its URL and required credentials."); }
  }
  return { client, close: () => client.close(), secrets: Object.values(credentials ?? {}) };
}

/**
 * Tool annotations are descriptive, not authority. A call runs directly only
 * when an `mcp.call` rule allows that capability (and tool); an explicit Deny
 * refuses it; otherwise it waits for an exact, expiring operator review,
 * including tools claiming to be read-only.
 */
export class ManagedMcpTools {
  constructor(private readonly permissions: AgentPermissionStore,
    private readonly resolve: (snapshot: PermissionSnapshot) => McpCapability[],
    private readonly database: () => DatabaseSync = db,
    private readonly connect: (capability: McpCapability) => Promise<McpConnection> = connectAttachedMcp) {}
  private check(snapshot: PermissionSnapshot, ref?: string, digest?: string): McpCapability[] {
    this.permissions.check(snapshot, "mcp.use");
    const capabilities = this.resolve(snapshot).filter((capability) => capability.ready);
    if (ref && !capabilities.some((capability) => capability.ref === ref && (!digest || capability.manifestDigest === digest))) throw new Error("The MCP attachment changed or is no longer ready. Review the attachment again.");
    return capabilities;
  }
  async list(snapshot: PermissionSnapshot): Promise<unknown> {
    const result = [];
    for (const capability of this.check(snapshot)) {
      const connection = await this.connect(capability);
      try {
        const tools = await connection.client.listTools();
        this.check(snapshot, capability.ref, capability.manifestDigest);
        const decision = this.permissions.decide(snapshot, "mcp.call", { capability: capability.ref });
        result.push({ capability: capability.ref, title: capability.title, tools: tools.tools, approval: decision.effect === "allow" ? "Calls run directly under the project's rules." : "Calls wait for operator review in Capabilities unless a rule allows the tool." });
      } finally { await connection.close(); }
    }
    return result;
  }
  private save(call: AttachedCall): void { this.database().prepare("INSERT INTO agent_tool_requests(id, project_id, document) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(call.id, call.snapshot.project.id, JSON.stringify(call)); }
  history(projectId: string): AttachedCall[] {
    // The table also holds operation reviews (agent-reviews.ts); they are not calls.
    return (this.database().prepare("SELECT document FROM agent_tool_requests WHERE project_id=? ORDER BY rowid DESC LIMIT 200").all(projectId) as { document: string }[])
      .map((row) => JSON.parse(row.document)).filter((entry) => entry.kind !== "operation").slice(0, 100);
  }
  private get(id: string): AttachedCall {
    const row = this.database().prepare("SELECT document FROM agent_tool_requests WHERE id=?").get(id) as { document: string } | undefined;
    if (!row) throw new Error("MCP review not found."); return JSON.parse(row.document);
  }
  async request(snapshot: PermissionSnapshot, ref: string, tool: string, args: Record<string, unknown>): Promise<AttachedCall> {
    const capability = this.check(snapshot, ref).find((capability) => capability.ref === ref)!;
    if (!/^[a-zA-Z0-9_.:/-]{1,200}$/.test(tool) || JSON.stringify(args).length > 32_000) throw new Error("Invalid MCP tool request.");
    const call: AttachedCall = JSON.parse(JSON.stringify({ id: `mcp_${randomUUID()}`, snapshot, capability: ref, manifestDigest: capability.manifestDigest, tool, arguments: args, expiresAt: Date.now() + 10 * 60_000, state: "pending" }));
    call.digest = createHash("sha256").update(JSON.stringify(call)).digest("hex");
    const context = { capability: ref, tool };
    const decision = this.permissions.decide(snapshot, "mcp.call", context);
    if (decision.effect === "deny" && decision.rule) throw new PermissionError(`${decision.reason} Review Agent permissions in Capabilities.`);
    if (decision.effect === "allow") {
      this.permissions.check(snapshot, "mcp.call", context); // consumes a one-time allow
      call.state = "running"; call.actor = `rule:${decision.rule?.id ?? "grant"}`; this.save(call);
      return this.#execute(call, capability);
    }
    // Ask, or no rule at all: the long-standing exact per-call review.
    this.save(call); return call;
  }
  result(snapshot: PermissionSnapshot, id: string): AttachedCall {
    const call = this.get(id); this.check(snapshot, call.capability, call.manifestDigest);
    if (call.snapshot.project.id !== snapshot.project.id || call.snapshot.project.path !== snapshot.project.path) throw new Error("MCP review is outside this project.");
    return call;
  }
  /**
   * Answer a pending call review. `always` also adds a standing Allow rule for
   * this capability's tool, so later calls to it run without review.
   */
  async decide(projectId: string, id: string, digest: string, approve: boolean, actor: string, always = false, project?: PermissionProject): Promise<AttachedCall> {
    const call = this.get(id);
    if (call.snapshot.project.id !== projectId || call.digest !== digest || call.state !== "pending" || call.expiresAt <= Date.now()) throw new Error("MCP review is stale or already consumed. Request a fresh review.");
    if (!approve) { call.state = "rejected"; call.actor = actor; this.save(call); return call; }
    const capability = this.check(call.snapshot, call.capability, call.manifestDigest).find((capability) => capability.ref === call.capability)!;
    call.state = "running"; call.actor = actor; this.save(call); // consume before awaiting transport
    if (always && project) {
      this.permissions.addRule(project, { permission: "mcp.call", effect: "allow", scope: { capability: call.capability, tool: call.tool }, source: `review:${call.id}`, actor }, this.permissions.snapshot(project).revision);
    }
    return this.#execute(call, capability);
  }

  async #execute(call: AttachedCall, capability: McpCapability): Promise<AttachedCall> {
    try {
      const connection = await this.connect(capability);
      try {
        this.check(call.snapshot, call.capability, call.manifestDigest);
        const listed = await connection.client.listTools();
        if (!listed.tools.some((tool) => tool.name === call.tool)) throw new Error("Reviewed tool is no longer available.");
        this.check(call.snapshot, call.capability, call.manifestDigest);
        const result = await connection.client.callTool({ name: call.tool, arguments: call.arguments });
        let text = JSON.stringify(result);
        // Credential values stay in the broker even if an integration echoes them.
        const values = [...(connection.secrets ?? []), ...capability.requiredEnv.map((name) => process.env[name]), ...(capability.mcp.transport === "http" ? Object.values(capability.mcp.headers ?? {}) : Object.values(capability.mcp.env))].filter((value): value is string => !!value && value.length > 3);
        for (const value of values) text = text.replaceAll(value, "[redacted]");
        call.result = text.slice(0, 64_000); call.state = result.isError ? "failed" : "succeeded";
      } finally { await connection.close(); }
    } catch { call.state = "failed"; call.result = "Attached MCP call failed. Check the integration connection and review a new call if needed."; }
    this.save(call); return call;
  }
}

/** The broker connection that holds an attached capability's credentials. */
export function mcpConnectionId(ref: string): string {
  return `mcp-${createHash("sha256").update(ref).digest("hex").slice(0, 16)}`;
}
