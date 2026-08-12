import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { ensurePreviewProxy, INSPECTOR_PATH, stopPreviewProxy } from "./preview.ts";

/** A stand-in dev server, so the proxy has something real to sit in front of. */
function fakeDevServer(handler: http.RequestListener): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve({ port: address.port, close: () => server.close() });
    });
  });
}

async function get(port: number, path = "/") {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual" });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

test("HTML responses come back with the inspector injected", async () => {
  const dev = await fakeDevServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><h1>hi</h1></body></html>");
  });
  const port = await ensurePreviewProxy(dev.port);
  try {
    const page = await get(port);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(INSPECTOR_PATH), "inspector script tag is present");
    // injected inside the document, not appended after it
    assert.ok(page.body.indexOf(INSPECTOR_PATH) < page.body.indexOf("</body>"));
    assert.ok(page.body.includes("<h1>hi</h1>"), "the page's own markup survives");
    assert.equal(page.headers.get("content-length"), String(Buffer.byteLength(page.body)));
  } finally {
    stopPreviewProxy(dev.port);
    dev.close();
  }
});

test("non-HTML responses are passed through untouched", async () => {
  const dev = await fakeDevServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end("export const a = 1;");
  });
  const port = await ensurePreviewProxy(dev.port);
  try {
    const asset = await get(port, "/app.js");
    assert.equal(asset.body, "export const a = 1;");
    assert.ok(!asset.body.includes(INSPECTOR_PATH));
  } finally {
    stopPreviewProxy(dev.port);
    dev.close();
  }
});

test("the inspector script is served by the proxy itself, so it is same-origin", async () => {
  const dev = await fakeDevServer((_req, res) => res.end("unused"));
  const port = await ensurePreviewProxy(dev.port);
  try {
    const script = await get(port, INSPECTOR_PATH);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") || "", /javascript/);
    assert.ok(script.body.includes("psm-preview"), "the real inspector source is served");
  } finally {
    stopPreviewProxy(dev.port);
    dev.close();
  }
});

test("framing and CSP headers are dropped so the preview can be embedded", async () => {
  const dev = await fakeDevServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html",
      "content-security-policy": "default-src 'self'",
      "x-frame-options": "DENY",
    });
    res.end("<body>x</body>");
  });
  const port = await ensurePreviewProxy(dev.port);
  try {
    const page = await get(port);
    assert.equal(page.headers.get("content-security-policy"), null);
    assert.equal(page.headers.get("x-frame-options"), null);
  } finally {
    stopPreviewProxy(dev.port);
    dev.close();
  }
});

test("redirects back to the dev server's own origin stay inside the proxy", async () => {
  const dev = await fakeDevServer(async (req, res) => {
    const devPort = Number(req.headers.host?.split(":")[1]);
    res.writeHead(302, { location: `http://localhost:${devPort}/login` });
    res.end();
  });
  const port = await ensurePreviewProxy(dev.port);
  try {
    const redirect = await get(port);
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "/login");
  } finally {
    stopPreviewProxy(dev.port);
    dev.close();
  }
});

test("a dead dev server explains itself instead of hanging the iframe", async () => {
  const dev = await fakeDevServer((_req, res) => res.end("ok"));
  const target = dev.port;
  const port = await ensurePreviewProxy(target);
  dev.close();
  await new Promise((r) => setTimeout(r, 50));
  try {
    const page = await get(port);
    assert.equal(page.status, 502);
    assert.match(page.body, /Nothing is serving port/);
  } finally {
    stopPreviewProxy(target);
  }
});

test("the same target reuses one proxy port", async () => {
  const dev = await fakeDevServer((_req, res) => res.end("ok"));
  try {
    const first = await ensurePreviewProxy(dev.port);
    const second = await ensurePreviewProxy(dev.port);
    assert.equal(first, second);
  } finally {
    stopPreviewProxy(dev.port);
    dev.close();
  }
});
