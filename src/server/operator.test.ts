import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { OPERATOR_HEADER, OperatorCredential, injectOperatorToken, operatorGate } from "./operator.ts";

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "psm-operator-")), "operator.json");

test("the secret is created once, kept 0600, survives a restart, and rotates", () => {
  const file = tempFile();
  const first = new OperatorCredential(file, () => 1);
  const token = first.current().token;
  assert.match(token, /^psm_op_[A-Za-z0-9_-]{43}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const restarted = new OperatorCredential(file);
  assert.equal(restarted.current().token, token, "a restart keeps open pages working");
  assert.ok(restarted.matches(token));
  const rotated = restarted.rotate().token;
  assert.notEqual(rotated, token);
  assert.ok(!restarted.matches(token), "the old token stops working");
  assert.ok(restarted.matches(rotated));
  assert.ok(!restarted.matches(undefined) && !restarted.matches(`${rotated}x`) && !restarted.matches(["a"]));
});

test("the page carries the token in a meta tag", () => {
  const html = injectOperatorToken("<!doctype html><html><head><title>x</title></head></html>", "psm_op_abc");
  assert.match(html, /<head>\n {4}<meta name="psm-operator" content="psm_op_abc">/);
});

async function serve(credential: OperatorCredential) {
  const app = express();
  app.use(operatorGate({
    credential,
    pairedOrigin: (req) => req.headers.origin === "https://psm.example",
    ownAuth: ["/mcp"],
    sensitiveReads: ["/api/agent/token"],
  }));
  app.all(/.*/, (req, res) => res.json({ ok: true, method: req.method }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("curl without the token can read but not act; the cockpit's token and paired origins can act", async () => {
  const credential = new OperatorCredential(tempFile());
  const { base, close } = await serve(credential);
  try {
    const call = (pathName: string, method = "POST", headers: Record<string, string> = {}) => fetch(base + pathName, { method, headers });
    assert.equal((await call("/api/projects", "GET")).status, 200, "plain reads stay open");
    for (const [pathName, method] of [["/api/switches", "PUT"], ["/api/reviews/1/approve", "POST"], ["/api/stacks/x", "DELETE"], ["/api/projects/a/plans/p/confirm", "POST"]]) {
      const response = await call(pathName, method);
      assert.equal(response.status, 401, `${method} ${pathName}`);
      assert.equal((await response.json()).code, "operator_required");
    }
    assert.equal((await call("/api/agent/token", "GET")).status, 401, "the pairing token is a sensitive read");
    assert.equal((await call("/api/switches", "PUT", { [OPERATOR_HEADER]: "psm_op_wrong" })).status, 401);
    assert.equal((await call("/api/switches", "PUT", { [OPERATOR_HEADER]: credential.current().token })).status, 200);
    assert.equal((await call("/api/agent/token", "GET", { [OPERATOR_HEADER]: credential.current().token })).status, 200);
    assert.equal((await call("/api/switches", "PUT", { origin: "https://psm.example" })).status, 200, "a paired origin was checked by agentGuard");
    assert.equal((await call("/mcp", "POST")).status, 200, "MCP has its own credentials");
    const old = credential.current().token;
    credential.rotate();
    assert.equal((await call("/api/switches", "PUT", { [OPERATOR_HEADER]: old })).status, 401, "revocation by rotation");
  } finally {
    await close();
  }
});
