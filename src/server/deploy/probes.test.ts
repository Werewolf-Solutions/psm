import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { httpProbe, isPublicAddress, jsonPath } from "./probes.ts";

test("private, loopback, reserved and documentation addresses are not public", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.2", "169.254.1.1", "192.0.2.1", "::1", "fc00::1", "2001:db8::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("a server-owned private scope can probe one exact local origin", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: true, data: { ready: true } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const result = await httpProbe({ url: `${origin}/ready`, privateAllowedOrigins: [origin] });
    assert.equal(result.status, 200);
    assert.equal(jsonPath(result.json, "$.data.ready"), true);
  } finally {
    server.close();
  }
});

test("public probes refuse loopback and state-changing methods", async () => {
  await assert.rejects(() => httpProbe({ url: "http://127.0.0.1/" }), /require HTTPS/);
  await assert.rejects(() => httpProbe({ url: "https://127.0.0.1/" }), /non-public/);
  await assert.rejects(() => httpProbe({ url: "https://example.com/", method: "POST" as never }), /state-changing/);
});

test("JSON path intentionally has no expression language", () => {
  assert.equal(jsonPath({ a: { b: 3 } }, "$.a.b"), 3);
  assert.throws(() => jsonPath({ a: [1] }, "$.a[0]"));
});
