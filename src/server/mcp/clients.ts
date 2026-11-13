/**
 * Credentials for AI clients of psm's MCP server.
 *
 * Each client (a Codex install, Claude Code, an ai-mesh node) gets its own
 * revocable credential, scoped to a set of projects. Only a SHA-256 of the value
 * is stored; the value is returned once, when it is minted.
 *
 * What these credentials are for: identifying and scoping a cooperating client
 * (attribution, project limits, revocation). They are not a boundary against
 * another process running as the same OS user, which could read the value from
 * wherever the client keeps it. That boundary is P02a in
 * docs/roadmaps/local-operator-authority.md.
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { db } from "../db.ts";

export const MCP_TOKEN_PREFIX = "psm_mcp_";
/** The environment variable clients read the credential from. psm strips every PSM_* variable from its children. */
export const MCP_TOKEN_ENV = "PSM_MCP_TOKEN";

export interface McpClient {
  id: string;
  name: string;
  /** Stable `prj_` ids this client may see, or "all". */
  projects: string[] | "all";
  createdAt: number;
  createdBy: string;
  revokedAt: number | null;
  lastUsedAt: number | null;
  /**
   * May send requests (submit_request) for the projects in its scope. Off until
   * the operator switches it on in the cockpit; no MCP tool can set it.
   */
  mayRequest?: boolean;
  /**
   * Set when the client was made by the Connect button: which host it was
   * added to, and the private file that holds its credential (mcp/connect.ts).
   */
  connection?: { provider: string; file: string };
}

export interface McpAuditEntry {
  tool: string;
  projectId: string | null;
  outcome: string;
  at: number;
}

const NAME = /^[\p{L}\p{N} ._-]{1,60}$/u;
const PROJECT_ID = /^prj_[A-Za-z0-9_-]{1,80}$/;
const AUDIT_KEEP_MS = 30 * 24 * 60 * 60_000;

const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export class McpClientStore {
  #writes = 0;

  constructor(private readonly database: () => DatabaseSync = db) {}

  #save(client: McpClient, tokenHash?: string): void {
    if (tokenHash) {
      this.database().prepare("INSERT INTO mcp_clients(id, token_hash, document) VALUES (?, ?, ?)").run(client.id, tokenHash, JSON.stringify(client));
    } else {
      this.database().prepare("UPDATE mcp_clients SET document = ? WHERE id = ?").run(JSON.stringify(client), client.id);
    }
  }

  /** Mint a client. The returned token is the only copy psm ever hands out. */
  mint(input: { name: unknown; projects: unknown }, createdBy: string, now = Date.now()): { client: McpClient; token: string } {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!NAME.test(name)) throw new McpClientError("Name the client in 1-60 letters, digits, spaces, dots, dashes or underscores.");
    let projects: McpClient["projects"];
    if (input.projects === "all") projects = "all";
    else if (Array.isArray(input.projects) && input.projects.length > 0 && input.projects.length <= 500
      && input.projects.every((id) => typeof id === "string" && PROJECT_ID.test(id))) projects = [...new Set(input.projects as string[])];
    else throw new McpClientError("Choose \"all\" or at least one project by its prj_ id.");
    const token = MCP_TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
    const client: McpClient = { id: `mcpc_${crypto.randomUUID()}`, name, projects, createdAt: now, createdBy, revokedAt: null, lastUsedAt: null };
    this.#save(client, hash(token));
    return { client, token };
  }

  list(): McpClient[] {
    return (this.database().prepare("SELECT document FROM mcp_clients ORDER BY rowid DESC").all() as { document: string }[])
      .map((row) => JSON.parse(row.document));
  }

  get(id: string): McpClient | null {
    const row = this.database().prepare("SELECT document FROM mcp_clients WHERE id = ?").get(id) as { document: string } | undefined;
    return row ? JSON.parse(row.document) : null;
  }

  revoke(id: string, now = Date.now()): McpClient {
    const client = this.get(id);
    if (!client) throw new McpClientError("Unknown MCP client.", 404);
    if (client.revokedAt == null) {
      client.revokedAt = now;
      this.#save(client);
    }
    return client;
  }

  /** Record how a client was connected (the Connect button). */
  setConnection(id: string, connection: { provider: string; file: string }): McpClient {
    const client = this.get(id);
    if (!client) throw new McpClientError("Unknown MCP client.", 404);
    client.connection = connection;
    this.#save(client);
    return client;
  }

  /** The operator's switch: may this client send requests for its projects? */
  setMayRequest(id: string, allow: boolean): McpClient {
    const client = this.get(id);
    if (!client) throw new McpClientError("Unknown MCP client.", 404);
    if (client.revokedAt != null) throw new McpClientError("That client is revoked.", 409);
    client.mayRequest = allow;
    this.#save(client);
    return client;
  }

  /** The live client a presented credential belongs to, or null. Revoked clients never authenticate. */
  authenticate(token: string, now = Date.now()): McpClient | null {
    if (!token.startsWith(MCP_TOKEN_PREFIX) || token.length > 200) return null;
    // A hash lookup: the stored value is a digest, so equality on it leaks nothing useful.
    const row = this.database().prepare("SELECT document FROM mcp_clients WHERE token_hash = ?").get(hash(token)) as { document: string } | undefined;
    if (!row) return null;
    const client: McpClient = JSON.parse(row.document);
    if (client.revokedAt != null) return null;
    // Last use is coarse (a minute) so a busy client does not rewrite its row on every call.
    if (!client.lastUsedAt || now - client.lastUsedAt > 60_000) {
      client.lastUsedAt = now;
      this.#save(client);
    }
    return client;
  }

  audit(clientId: string, tool: string, projectId: string | null, outcome: string, now = Date.now()): void {
    this.database().prepare("INSERT INTO mcp_audit(client_id, tool, project_id, outcome, at) VALUES (?, ?, ?, ?, ?)")
      .run(clientId, tool.slice(0, 100), projectId, outcome.slice(0, 40), now);
    if (++this.#writes % 200 === 0) this.database().prepare("DELETE FROM mcp_audit WHERE at < ?").run(now - AUDIT_KEEP_MS);
  }

  recent(clientId: string, limit = 50): McpAuditEntry[] {
    return (this.database().prepare("SELECT tool, project_id, outcome, at FROM mcp_audit WHERE client_id = ? ORDER BY id DESC LIMIT ?")
      .all(clientId, Math.min(Math.max(1, limit), 200)) as { tool: string; project_id: string | null; outcome: string; at: number }[])
      .map((row) => ({ tool: row.tool, projectId: row.project_id, outcome: row.outcome, at: row.at }));
  }
}

export class McpClientError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function canSeeProject(client: McpClient, projectId: string): boolean {
  return client.projects === "all" || client.projects.includes(projectId);
}

/** psm's own HTTP port, where both its REST API and `/mcp` live. */
export const psmPort = (): number => Number(process.env.PORT || 4317);

function loopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" || host === "::"
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || /^::ffff:127\./.test(host) || /^::ffff:7f/.test(host);
}

/**
 * Why an attached MCP server must not be connected from a PSM-managed session,
 * or null when it may. A managed agent reaching psm's own endpoint, or carrying
 * a psm MCP credential, could start work or request reviews under a different
 * identity than the session it runs in.
 */
export function selfAttachmentReason(wire: { transport: string; url?: string; headers?: Record<string, string>; bearerTokenEnvVar?: string; env?: Record<string, string> }, requiredEnv: string[] = []): string | null {
  const names = [...requiredEnv, ...Object.keys(wire.env ?? {}), ...(wire.bearerTokenEnvVar ? [wire.bearerTokenEnvVar] : [])];
  if (names.includes(MCP_TOKEN_ENV)) return "An attached MCP server cannot receive psm's own MCP credential.";
  const values = [...Object.values(wire.headers ?? {}), ...Object.values(wire.env ?? {})];
  if (values.some((value) => String(value).includes(MCP_TOKEN_PREFIX))) return "An attached MCP server cannot carry a psm MCP credential.";
  if (wire.transport !== "stdio" && wire.url) {
    try {
      const url = new URL(wire.url);
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      if (loopbackHostname(url.hostname) && port === psmPort()) return "psm cannot attach its own endpoint to a session it manages.";
    } catch {
      return null; // the transport rejects an invalid URL on its own
    }
  }
  return null;
}
