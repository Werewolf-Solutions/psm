#!/usr/bin/env node
/**
 * psm's MCP endpoint over stdio, for any MCP host: Claude Code, Codex, an IDE
 * extension, a local-model harness.
 *
 *   node psm-mcp-stdio.mjs --connection <file>
 *
 * The connection file is written by psm's "Connect" button (0600, outside any
 * project): `{ "url": "http://127.0.0.1:4317/mcp", "token": "psm_mcp_…" }`. The
 * host's own config holds only this command, never the credential.
 *
 * This is a relay, not a second psm: every JSON-RPC message read from stdin is
 * POSTed to the running psm and its answer written to stdout. It keeps no state
 * and has no dependencies, so it starts with nothing but Node.
 *
 * It sends its own process id along. psm uses that to refuse a host that psm
 * itself started (a managed session must not call psm under another identity).
 */
import fs from "node:fs";
import readline from "node:readline";

const argument = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

function fail(message) {
  process.stderr.write(`psm-mcp: ${message}\n`);
  process.exit(1);
}

const file = argument("--connection");
if (!file) fail("usage: psm-mcp-stdio.mjs --connection <file>. Use the Connect button in psm (Linked folders → AI clients).");

let connection;
try {
  connection = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  fail(`cannot read ${file}. The client may have been revoked; connect again in psm (Linked folders → AI clients).`);
}
if (typeof connection?.url !== "string" || typeof connection?.token !== "string") fail(`${file} is not a psm connection file.`);

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const errorFor = (request, code, message) => {
  // Only requests (which carry an id) get an answer; a notification has nowhere to send one.
  for (const entry of Array.isArray(request) ? request : [request]) {
    if (entry && entry.id !== undefined && entry.id !== null) send({ jsonrpc: "2.0", id: entry.id, error: { code, message } });
  }
};

async function relay(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "psm-mcp: that line is not JSON." } });
  }
  let response;
  try {
    response = await fetch(connection.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-PSM-Adapter-Pid": String(process.pid),
      },
      body: line,
    });
  } catch {
    return errorFor(request, -32001, `psm is not answering at ${connection.url}. Start psm, then try again.`);
  }
  const text = await response.text().catch(() => "");
  if (!text.trim()) return; // 202: a notification was accepted
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return errorFor(request, -32603, `psm answered with HTTP ${response.status} and no JSON.`);
  }
  // psm's own refusals (401, 403, 429) carry no request id; give them the caller's.
  if (!response.ok && body?.error && body.id == null) return errorFor(request, body.error.code ?? -32001, String(body.error.message ?? `psm refused the request (HTTP ${response.status}).`));
  send(body);
}

const pending = new Set();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  const task = relay(line).finally(() => pending.delete(task));
  pending.add(task);
});
input.on("close", async () => {
  await Promise.allSettled([...pending]);
  process.exit(0);
});
