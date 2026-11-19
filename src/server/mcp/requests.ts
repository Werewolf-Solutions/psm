/**
 * Requests MCP clients send for a project (`submit_request`).
 *
 * A source agent — feedback-hub's, the website agent, any MCP client the
 * operator allowed — says "this project needs this bug fixed / this feature".
 * psm turns that into a hub intake, exactly like a task written on the Agents
 * page, so it is triaged by the executor and waits for the operator's Go. An MCP
 * client can ask; it can never start the work.
 *
 * The intake lives in the hub. This table only records which client made which
 * intake: attribution in the cockpit, the client's daily count, and the set of
 * requests a client may read back or withdraw.
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { db } from "../db.ts";

export const REQUEST_KINDS = ["bug", "feature", "request"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** Triage spends model credit, so each client gets a daily number of new requests. */
export const REQUESTS_PER_DAY = 20;

/**
 * New requests per client in 24 hours, or null for no limit.
 * PSM_MCP_REQUESTS_PER_DAY sets it: a whole number, or "off" for no limit.
 * Unset, the local cockpit (dev mode) has no limit, since the operator is the
 * one sending and pays for it; an agent paired with a hosted page keeps REQUESTS_PER_DAY.
 */
export function requestsPerDay(mode: string, setting: string | undefined = process.env.PSM_MCP_REQUESTS_PER_DAY): number | null {
  const value = (setting ?? "").trim().toLowerCase();
  if (["off", "none", "unlimited", "0"].includes(value)) return null;
  const number = Number(value);
  if (value && Number.isInteger(number) && number > 0) return number;
  return mode === "dev" ? null : REQUESTS_PER_DAY;
}
export const REQUEST_TEXT_MAX = 8_000;
const DAY_MS = 24 * 60 * 60_000;

export interface McpRequestRow {
  intakeId: string;
  clientId: string;
  projectId: string;
  kind: RequestKind;
  key: string;
  createdAt: number;
}

/**
 * The hub's idempotency key for one request. The same client sending the same
 * idempotency key is the same intake, so a retried tool call is not a second
 * request. Same shape as the Agents page's key (`pst_` + 24 hex).
 */
export function requestKey(clientId: string, idempotencyKey: string): string {
  return `pst_${crypto.createHash("sha256").update(`mcp\n${clientId}\n${idempotencyKey}`).digest("hex").slice(0, 24)}`;
}

/** What the operator reads at the top of the intake: who asked, and for what kind of change. */
export function requestText(kind: RequestKind, clientName: string, text: string): string {
  const label = kind === "bug" ? "Bug fix" : kind === "feature" ? "New feature" : "Request";
  return `[${label} requested by ${clientName} over psm MCP]\n\n${text.trim()}`;
}

const toRow = (row: any): McpRequestRow => ({ intakeId: row.intake_id, clientId: row.client_id, projectId: row.project_id, kind: row.kind, key: row.key, createdAt: row.created_at });

export class McpRequestStore {
  constructor(private readonly database: () => DatabaseSync = db) {}

  record(row: McpRequestRow): void {
    this.database().prepare("INSERT INTO mcp_requests(intake_id, client_id, project_id, kind, key, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
      .run(row.intakeId, row.clientId, row.projectId, row.kind, row.key, row.createdAt);
  }

  byKey(clientId: string, key: string): McpRequestRow | null {
    const row = this.database().prepare("SELECT * FROM mcp_requests WHERE client_id = ? AND key = ?").get(clientId, key);
    return row ? toRow(row) : null;
  }

  get(intakeId: string): McpRequestRow | null {
    const row = this.database().prepare("SELECT * FROM mcp_requests WHERE intake_id = ?").get(intakeId);
    return row ? toRow(row) : null;
  }

  /** Newest first. With a client id, only that client's requests. */
  list(clientId: string | null, limit = 50): McpRequestRow[] {
    const capped = Math.min(Math.max(1, limit), 200);
    const rows = clientId
      ? this.database().prepare("SELECT * FROM mcp_requests WHERE client_id = ? ORDER BY created_at DESC LIMIT ?").all(clientId, capped)
      : this.database().prepare("SELECT * FROM mcp_requests ORDER BY created_at DESC LIMIT ?").all(capped);
    return rows.map(toRow);
  }

  /** New requests this client made in the last day. */
  recentCount(clientId: string, now = Date.now()): number {
    const row = this.database().prepare("SELECT COUNT(*) AS n FROM mcp_requests WHERE client_id = ? AND created_at > ?").get(clientId, now - DAY_MS) as { n: number };
    return Number(row.n);
  }

  /** Which client asked for each of these intakes, for the cockpit's queue. */
  clientsFor(intakeIds: string[]): Map<string, { clientId: string; kind: RequestKind }> {
    const found = new Map<string, { clientId: string; kind: RequestKind }>();
    if (!intakeIds.length) return found;
    const wanted = new Set(intakeIds);
    for (const row of this.list(null, 200)) if (wanted.has(row.intakeId)) found.set(row.intakeId, { clientId: row.clientId, kind: row.kind });
    return found;
  }
}
