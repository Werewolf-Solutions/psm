/**
 * P18 R6 end to end: an MCP client starts a unit in one project, psm starts
 * the server it needs in another project first, both answer on their ports,
 * and stop_units stops them. Real runbook detection, real processes, the real
 * MCP SDK client over HTTP; only the project list and the grant store are local.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

process.env.PSM_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "psm-units-logs-"));

const { projectRunbook, writeCurated } = await import("../runbook.ts");
const procs = await import("./procs.ts");
const { mcpUnitControl, portOpen, unitKind } = await import("./units.ts");
const { migrate, openDatabase } = await import("./db.ts");
const { UnitGrantStore } = await import("./unit-grants.ts");
const { McpClientStore } = await import("./mcp/clients.ts");
const { McpOperations } = await import("./mcp/operations.ts");
const { MCP_PATH, mcpHandler } = await import("./mcp/server.ts");

const freePort = () => new Promise<number>((resolve) => {
  const server = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    server.close(() => resolve(port));
  });
});

function fixture(name: string, port: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `psm-${name}-`));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, scripts: { dev: `node server.js --port ${port}` } }));
  fs.writeFileSync(path.join(dir, "server.js"), `const port = Number(process.argv[process.argv.indexOf("--port") + 1]);\nrequire("http").createServer((_q, r) => r.end("${name}")).listen(port, "127.0.0.1");\n`);
  return dir;
}

test("an MCP client starts todo's client; psm starts the API it needs first; stop_units stops them", { timeout: 30_000 }, async () => {
  const [apiPort, appPort] = [await freePort(), await freePort()];
  const dirs: Record<string, string> = { api: fixture("api", apiPort), app: fixture("app", appPort) };
  writeCurated(dirs.app, { version: 1, units: { dev: { dependsOn: [{ project: "api", unit: "dev" }] } } });
  const ids: Record<string, string> = { api: "prj_api", app: "prj_app" };
  const projects = Object.keys(dirs).map((name) => ({
    name, path: dirs[name], id: ids[name], status: "active", category: "app", description: "", stack: "", next: null, priority: null, pinned: false, workingOn: false,
    workingOnAt: null, archived: false, note: null, lastActivity: null, lastActivitySource: null, gitBranch: null, gitVersion: null, gitLastSubject: null, hasGit: false,
    runCommand: null, customCommands: [], deployStaging: null, deployProduction: null, port: null, aiEngine: "claude", aiModel: null, aiEffort: null, aiFullAccess: false,
    aiExtraProjects: [], attachments: [], overridden: [],
  })) as any[];

  const grantsDb = new DatabaseSync(":memory:");
  migrate(grantsDb);
  const grants = new UnitGrantStore(() => grantsDb);
  const runbook = (name: string) => (dirs[name] ? projectRunbook(dirs[name]) : null);
  const running = () => procs.processRoster().filter((proc) => proc.status === "running" && proc.kind.startsWith("unit:")).map((proc) => ({ project: proc.name, unit: proc.kind.slice(5) }));
  const deps = () => ({
    project: (name: string) => (dirs[name] ? { name, path: dirs[name] } : null),
    projects: () => Object.keys(dirs),
    runbook,
    status: (name: string, kind: any) => {
      const state = procs.procState(name, kind);
      return state.status === "idle" ? null : { status: state.status, port: null };
    },
    start: (name: string, kind: any, command: string, cwd: string, options: any) => { procs.start(name, kind, command, cwd, options); },
    stop: procs.stop,
    portOpen,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    readyTimeoutMs: 15_000,
  });
  const operations = new McpOperations({
    projects: () => projects,
    plans: { list: () => [], get: () => null },
    runbook,
    units: mcpUnitControl({
      deps,
      projectId: (name) => ids[name] ?? null,
      grant: (projectId, unit) => grants.state(projectId, unit),
      resources: () => [],
      stack: () => null,
      running,
    }),
  });
  const handle = openDatabase(":memory:");
  const store = new McpClientStore(() => handle);
  const { token } = store.mint({ name: "e2e", projects: "all" }, "me");
  const app = express();
  app.use(express.json());
  app.all(MCP_PATH, mcpHandler({ store, operations }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}${MCP_PATH}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })) as any).structuredContent;
  try {
    const refused = await call("start_units", { units: [{ projectId: "prj_app", unit: "dev" }] });
    assert.equal(refused.state, "denied");
    assert.match(refused.reason, /api dev is not allowed for MCP.*app dev is not allowed for MCP/);
    assert.equal(await portOpen(apiPort), false, "nothing started");

    grants.grant("prj_app", runbook("app")!.units[0]);
    const halfway = await call("start_units", { units: [{ projectId: "prj_app", unit: "dev" }] });
    assert.equal(halfway.state, "denied", "the dependency needs its own grant");
    assert.match(halfway.reason, /api dev is not allowed/);

    grants.grant("prj_api", runbook("api")!.units[0]);
    const started = await call("start_units", { units: [{ projectId: "prj_app", unit: "dev" }] });
    assert.equal(started.state, "succeeded", JSON.stringify(started));
    assert.deepEqual(started.data.results.map((result: any) => [result.project, result.outcome, result.ready, result.reason]), [["api", "started", true, "needed by app dev"], ["app", "started", true, "requested"]]);
    assert.equal(await portOpen(apiPort), true);
    assert.equal(await portOpen(appPort), true);

    const again = await call("start_units", { units: [{ projectId: "prj_app", unit: "dev" }] });
    assert.deepEqual(again.data.results.map((result: any) => result.outcome), ["reused", "reused"]);

    const keep = await call("stop_units", { units: [{ projectId: "prj_api", unit: "dev" }] });
    assert.deepEqual(keep.data.results, [{ projectId: "prj_api", unit: "dev", stopped: false, keptFor: ["app dev"] }], "the API stays while app needs it");

    const stopped = await call("stop_units", { units: [{ projectId: "prj_app", unit: "dev" }, { projectId: "prj_api", unit: "dev" }] });
    assert.equal(stopped.state, "succeeded");
    for (let i = 0; i < 40 && ((await portOpen(apiPort)) || (await portOpen(appPort))); i++) await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(await portOpen(apiPort), false);
    assert.equal(await portOpen(appPort), false);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
    for (const name of Object.keys(dirs)) procs.stop(name, unitKind("dev"));
  }
});
