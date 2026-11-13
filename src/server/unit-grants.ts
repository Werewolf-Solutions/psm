/**
 * Which runbook units MCP clients may start (P18 R6).
 *
 * The operator switches a unit on in the Scripts tab. Only the cockpit can do
 * that (a local write, behind the P02a.2 operator token); no MCP tool, model or
 * `.psm/runbook.json` from a pull can. Each grant is bound to a digest of what
 * the unit runs, so a changed script, folder or kind is no longer allowed until
 * the operator looks at it again.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { RunbookUnit } from "../runbook.ts";
import { db } from "./db.ts";

export function unitDigest(unit: Pick<RunbookUnit, "folder" | "script" | "scriptText" | "kind">): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify([unit.folder, unit.script, unit.scriptText, unit.kind])).digest("hex");
}

export type GrantState = "allowed" | "not-allowed" | "changed";

export class UnitGrantStore {
  constructor(private readonly database: () => DatabaseSync = db) {}

  state(projectId: string, unit: RunbookUnit): GrantState {
    const row = this.database().prepare("SELECT digest FROM unit_mcp_grants WHERE project_id = ? AND unit_id = ?").get(projectId, unit.id) as { digest: string } | undefined;
    if (!row) return "not-allowed";
    return row.digest === unitDigest(unit) ? "allowed" : "changed";
  }

  grant(projectId: string, unit: RunbookUnit, now = Date.now()): void {
    this.database().prepare("INSERT INTO unit_mcp_grants(project_id, unit_id, digest, granted_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, unit_id) DO UPDATE SET digest = excluded.digest, granted_at = excluded.granted_at")
      .run(projectId, unit.id, unitDigest(unit), now);
  }

  revoke(projectId: string, unitId: string): boolean {
    return Number(this.database().prepare("DELETE FROM unit_mcp_grants WHERE project_id = ? AND unit_id = ?").run(projectId, unitId).changes) > 0;
  }
}
