import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { Project } from "../../types.ts";
import { openDatabase } from "../db.ts";
import { McpClientStore } from "./clients.ts";
import { connectCommand, connectionFile, connectionName, installInto, isDescendantOf, isProviderId, listProviders, parentPid, removeConnection, snippets, uninstallFrom, writeConnection, type Run } from "./connect.ts";
import { McpOperations } from "./operations.ts";
import { MCP_PATH, mcpHandler } from "./server.ts";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "psm-connect-"));
const CLIENT_ID = "mcpc_123e4567-e89b-42d3-a456-426614174000";

test("a connection file is private, and only psm's own client ids name one", () => {
  const dir = path.join(temp(), "mcp");
  const file = connectionFile(CLIENT_ID, dir);
  writeConnection(file, { url: "http://127.0.0.1:4317/mcp", token: "psm_mcp_secret" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { url: "http://127.0.0.1:4317/mcp", token: "psm_mcp_secret" });
  removeConnection(file);
  assert.equal(fs.existsSync(file), false);
  removeConnection(file); // already gone is fine
  assert.throws(() => connectionFile("../../etc/passwd", dir));
  assert.throws(() => connectionFile("mcpc_short", dir));
});

test("the host's config gets a command and a file path, never the credential", () => {
  const command = connectCommand("/home/me/.config/psm/mcp/x.json", "/usr/bin/node", "/opt/psm/scripts/psm-mcp-stdio.mjs");
  assert.deepEqual(command, { command: "/usr/bin/node", args: ["/opt/psm/scripts/psm-mcp-stdio.mjs", "--connection", "/home/me/.config/psm/mcp/x.json"] });
  const made = snippets(command);
  assert.deepEqual(JSON.parse(made.json), { mcpServers: { psm: { command: "/usr/bin/node", args: command.args } } });
  assert.equal(made.shell, "/usr/bin/node /opt/psm/scripts/psm-mcp-stdio.mjs --connection /home/me/.config/psm/mcp/x.json");
  assert.match(made.toml, /^\[mcp_servers\.psm\]\ncommand = "\/usr\/bin\/node"\nargs = \[/);
  assert.equal(snippets({ command: "/my node/node", args: ["it's"] }).shell, `'/my node/node' 'it'\\''s'`);
  assert.ok(!JSON.stringify(made).includes("psm_mcp_"));
});

test("providers: Claude Code and Codex need their CLI; another harness is always offered", () => {
  const none = listProviders(() => null);
  assert.deepEqual(none.map((provider) => [provider.id, provider.installed]), [["claude", false], ["codex", false], ["other", true]]);
  assert.ok(listProviders((name) => (name === "codex" ? "/bin/codex" : null)).find((provider) => provider.id === "codex")!.installed);
  assert.ok(isProviderId("claude") && isProviderId("other") && !isProviderId("gpt") && !isProviderId(undefined));
  assert.equal(connectionName("claude", "my laptop!"), "Claude Code on my-laptop-");
  assert.equal(connectionName("other", "box"), "MCP host on box");
  assert.ok(connectionName("codex", "x".repeat(200)).length <= 60);
});

test("installing replaces an earlier psm entry through the host's own CLI", async () => {
  const calls: string[][] = [];
  const run: Run = async (program, args) => {
    calls.push([program, ...args]);
    return { ok: true, output: "" };
  };
  const command = { command: "/usr/bin/node", args: ["/opt/psm/adapter.mjs", "--connection", "/c/x.json"] };

  const claude = await installInto("claude", command, { find: () => "/bin/claude", run });
  assert.deepEqual(claude, { ok: true, configured: true, message: claude.message });
  assert.deepEqual(calls[0], ["/bin/claude", "mcp", "remove", "--scope", "user", "psm"]);
  assert.deepEqual(calls[1].slice(0, 6), ["/bin/claude", "mcp", "add-json", "--scope", "user", "psm"]);
  assert.deepEqual(JSON.parse(calls[1][6]), { type: "stdio", command: "/usr/bin/node", args: command.args });

  calls.length = 0;
  await installInto("codex", command, { find: () => "/bin/codex", run });
  assert.deepEqual(calls, [["/bin/codex", "mcp", "remove", "psm"], ["/bin/codex", "mcp", "add", "psm", "--", "/usr/bin/node", ...command.args]]);

  calls.length = 0;
  const other = await installInto("other", command, { find: () => null, run });
  assert.equal(other.ok && other.configured, false);
  assert.equal(calls.length, 0, "nothing is run for a host psm cannot configure");

  await uninstallFrom("codex", { find: () => "/bin/codex", run });
  assert.deepEqual(calls, [["/bin/codex", "mcp", "remove", "psm"]]);
  await uninstallFrom("claude", { find: () => null, run }); // CLI gone: nothing to do
  assert.equal(calls.length, 1);
});

test("installing says why when the CLI is missing or refuses", async () => {
  const command = { command: "node", args: [] };
  const missing = await installInto("claude", command, { find: () => null });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /was not found/);
  const refused = await installInto("codex", command, { find: () => "/bin/codex", run: async (_program, args) => (args[1] === "add" ? { ok: false, output: "warming up\nerror: config is read-only" } : { ok: true, output: "" }) });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /config is read-only/);
});

test("a process is recognised as started by another through its parents", () => {
  const parents = new Map([[40, 30], [30, 20], [20, 1], [99, 1]]);
  const parent = (pid: number) => parents.get(pid) ?? null;
  assert.equal(isDescendantOf(40, 20, parent), true);
  assert.equal(isDescendantOf(40, 30, parent), true);
  assert.equal(isDescendantOf(99, 20, parent), false);
  assert.equal(isDescendantOf(20, 20, parent), false, "a process is not its own descendant");
  assert.equal(isDescendantOf(12345, 20, () => null), false);
  if (process.platform === "linux") assert.equal(parentPid(process.pid), process.ppid);
});

/* ---------- the stdio relay, with a real MCP client on one side and the real handler on the other ---------- */

const project = (id: string, name: string): Project => ({
  name, path: `/tmp/${name}`, id, status: "active" as Project["status"], category: "app", description: "", stack: "node", next: "", priority: null, pinned: false,
  workingOn: false, workingOnAt: null, archived: false, note: null, lastActivity: null, lastActivitySource: null, gitBranch: "dev", gitVersion: "1.0.0",
  gitLastSubject: "", hasGit: true, runCommand: "", customCommands: [], deployStaging: null, deployProduction: null, port: null, aiEngine: "claude",
  aiModel: null, aiEffort: null, aiFullAccess: false, aiExtraProjects: [], attachments: [], overridden: [],
});

async function relayHarness(startedByPsm?: (pid: number) => boolean) {
  const handle = openDatabase(":memory:");
  const store = new McpClientStore(() => handle);
  const operations = new McpOperations({ projects: () => [project("prj_alpha", "alpha"), project("prj_beta", "beta")], plans: { list: () => [], get: () => null } });
  const app = express();
  app.use(express.json());
  app.all(MCP_PATH, mcpHandler({ store, operations, startedByPsm }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${MCP_PATH}`;
  const { client, token } = store.mint({ name: "Claude Code on test", projects: ["prj_alpha"] }, "me");
  const file = connectionFile(client.id, temp());
  writeConnection(file, { url, token });
  const command = connectCommand(file);
  const connect = async () => {
    const mcp = new Client({ name: "relay-test", version: "1.0.0" });
    await mcp.connect(new StdioClientTransport({ command: command.command, args: command.args, stderr: "pipe" }));
    return mcp;
  };
  return { store, client, file, url, connect, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("through the relay: a host with only the command lists tools and reads within the client's scope", async () => {
  const h = await relayHarness();
  try {
    const mcp = await h.connect();
    const tools = (await mcp.listTools()).tools.map((tool) => tool.name);
    assert.ok(tools.includes("list_projects") && tools.includes("submit_request"));
    const listed = await mcp.callTool({ name: "list_projects", arguments: {} }) as any;
    assert.deepEqual(listed.structuredContent.data.projects.map((entry: any) => entry.id), ["prj_alpha"]);
    const status = await mcp.callTool({ name: "get_access_status", arguments: {} }) as any;
    assert.equal(status.structuredContent.data.client.name, "Claude Code on test");
    await mcp.close();
    assert.ok(h.store.recent(h.client.id).some((entry) => entry.tool === "list_projects"));
  } finally {
    await h.close();
  }
});

test("through the relay: a revoked client gets psm's refusal as an error on its own request", async () => {
  const h = await relayHarness();
  try {
    h.store.revoke(h.client.id);
    const mcp = new Client({ name: "relay-test", version: "1.0.0" });
    const command = connectCommand(h.file);
    await assert.rejects(() => mcp.connect(new StdioClientTransport({ command: command.command, args: command.args, stderr: "pipe" })), /revoked psm MCP credential/);
    await mcp.close().catch(() => {});
  } finally {
    await h.close();
  }
});

test("through the relay: a host that psm itself started is refused", async () => {
  // In this test the relay is a child of the test process, which stands in for psm.
  const h = await relayHarness((pid) => isDescendantOf(pid, process.pid));
  try {
    await assert.rejects(() => h.connect(), /does not serve its own MCP tools to a session it started/);
  } finally {
    await h.close();
  }
});

test("the relay says what to do when its connection file is gone or psm is not running", async () => {
  const command = connectCommand(path.join(temp(), "missing.json"));
  const gone = new Client({ name: "relay-test", version: "1.0.0" });
  await assert.rejects(() => gone.connect(new StdioClientTransport({ command: command.command, args: command.args, stderr: "pipe" })));

  const file = connectionFile(CLIENT_ID, temp());
  writeConnection(file, { url: "http://127.0.0.1:9/mcp", token: "psm_mcp_x" });
  const down = new Client({ name: "relay-test", version: "1.0.0" });
  const offline = connectCommand(file);
  await assert.rejects(() => down.connect(new StdioClientTransport({ command: offline.command, args: offline.args, stderr: "pipe" })), /psm is not answering/);
  await down.close().catch(() => {});
});
