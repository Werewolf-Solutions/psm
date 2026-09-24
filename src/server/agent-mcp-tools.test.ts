import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import test from "node:test";
import { ManagedMcpTools, type McpConnection } from "./agent-mcp-tools.ts";
import { AgentPermissionStore } from "./agent-permissions.ts";
import { openDatabase } from "./db.ts";
import type { McpCapability } from "../types.ts";

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(`${os.tmpdir()}/psm-mcp-test-`); const database = openDatabase(":memory:");
  const store = new AgentPermissionStore(() => database); const project = { id: "prj_test", name: "test", path: directory };
  const snapshot = store.change(project, "mcp.use", true, 0, "operator");
  let attached = true, calls = 0;
  const capability = { ref: "workspace:test", title: "Test", ready: true, manifestDigest: "sha256:test", requiredEnv: [], mcp: { transport: "stdio", env: {}, launch: { type: "command", command: "never-executed", args: [], cwdIndependent: true } } } as unknown as McpCapability;
  const tools = new ManagedMcpTools(store, () => attached ? [capability] : [], () => database, async () => ({ client: {
    listTools: async () => ({ tools: [{ name: "write_service", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] }),
    callTool: async (input: { arguments: unknown }) => { calls++; return { content: [{ type: "text", text: JSON.stringify(input.arguments) }] }; },
  }, close: async () => {} } as McpConnection));
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { tools, store, project, snapshot, calls: () => calls, detach: () => { attached = false; } };
}
test("attached tools require exact one-use review even when annotations claim read-only", async (t) => {
  const h = fixture(t); await h.tools.list(h.snapshot);
  const args = { value: "reviewed" }; const request = await h.tools.request(h.snapshot, "workspace:test", "write_service", args);
  args.value = "changed";
  assert.equal(h.calls(), 0);
  await assert.rejects(h.tools.decide(h.project.id, request.id, "forged", true, "operator"), /stale/);
  const result = await h.tools.decide(h.project.id, request.id, request.digest, true, "operator");
  assert.equal(result.state, "succeeded"); assert.match(String(result.result), /reviewed/); assert.equal(h.calls(), 1);
  await assert.rejects(h.tools.decide(h.project.id, request.id, request.digest, true, "operator"), /consumed/);
  assert.equal(h.tools.history(h.project.id)[0].actor, "operator");
});
test("detaching and revoking prevent pending external calls", async (t) => {
  const h = fixture(t); const request = await h.tools.request(h.snapshot, "workspace:test", "write_service", {});
  h.detach(); await assert.rejects(h.tools.decide(h.project.id, request.id, request.digest, true, "operator"), /attachment changed/);
  assert.equal(h.calls(), 0);
  const other = fixture(t); const pending = await other.tools.request(other.snapshot, "workspace:test", "write_service", {});
  other.store.change(other.project, "mcp.use", false, 1, "operator");
  await assert.rejects(other.tools.decide(other.project.id, pending.id, pending.digest, true, "operator"), /permissions changed/);
  assert.equal(other.calls(), 0);
});
test("rejection records the operator without invoking the service", async (t) => {
  const h = fixture(t); const request = await h.tools.request(h.snapshot, "workspace:test", "write_service", {});
  const result = await h.tools.decide(h.project.id, request.id, request.digest, false, "operator");
  assert.equal(result.state, "rejected"); assert.equal(h.calls(), 0);
});
test("an allow rule runs a tool directly, an explicit deny refuses it, and 'always' approves future calls", async (t) => {
  const h = fixture(t);
  // No rule: the long-standing review, nothing runs yet.
  const reviewed = await h.tools.request(h.snapshot, "workspace:test", "write_service", { n: 1 });
  assert.equal(reviewed.state, "pending"); assert.equal(h.calls(), 0);
  // "Always allow this tool" answers the review and adds a standing rule for it.
  const approved = await h.tools.decide(h.project.id, reviewed.id, reviewed.digest, true, "operator", true, h.project);
  assert.equal(approved.state, "succeeded"); assert.equal(h.calls(), 1);
  const direct = await h.tools.request(h.store.snapshot(h.project), "workspace:test", "write_service", { n: 2 });
  assert.equal(direct.state, "succeeded", "the rule lets the next call run at once"); assert.equal(h.calls(), 2);
  assert.match(String(direct.actor), /^rule:/);
  // A more specific Deny wins over that Allow.
  h.store.addRule(h.project, { permission: "mcp.call", effect: "deny", scope: { capability: "workspace:test", tool: "write_service", environmentId: "production" }, source: "custom", actor: "operator" }, h.store.snapshot(h.project).revision);
  h.store.addRule(h.project, { permission: "mcp.call", effect: "deny", scope: { capability: "workspace:test", tool: "write_service" }, source: "custom", actor: "operator" }, h.store.snapshot(h.project).revision);
  await assert.rejects(h.tools.request(h.store.snapshot(h.project), "workspace:test", "write_service", { n: 3 }), /Denied/);
  assert.equal(h.calls(), 2);
});
