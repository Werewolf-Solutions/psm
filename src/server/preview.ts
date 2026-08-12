/**
 * Dev-mode preview proxy.
 *
 * The Web tab normally points an iframe straight at the project's dev server.
 * That iframe is a foreign origin, so psm cannot see what the user clicks on —
 * which is exactly what dev mode needs ("click this button, it's the wrong
 * colour"). So dev mode routes the preview through a tiny per-project proxy
 * that injects an inspector script into HTML responses. The injected script
 * runs *inside* the previewed page, so it can name the element that was
 * clicked, and reports it to psm over postMessage.
 *
 * The proxy gets its own loopback port and forwards paths unchanged, so
 * root-relative URLs ("/assets/app.js"), redirects, and HMR websockets all keep
 * working — which a path-prefix proxy mounted on the psm server could not do.
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSPECTOR_FILE = path.resolve(__dirname, "..", "..", "web", "preview-inspector.js");

/** Served by the proxy itself so the script is same-origin with the page it inspects. */
export const INSPECTOR_PATH = "/__psm-preview-inspector.js";
const INJECT_TAG = `<script src="${INSPECTOR_PATH}" data-psm-preview="1"></script>`;

/** Proxies are cheap but not free — drop the ones nobody has previewed in a while. */
const IDLE_MS = 30 * 60 * 1000;

type Preview = { target: number; port: number; server: http.Server; lastUsed: number };

const previews = new Map<number, Preview>();

/** Headers that would stop the previewed page from being framed or instrumented. */
const STRIPPED = [
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
];

function injectInspector(html: string): string {
  const lower = html.toLowerCase();
  for (const marker of ["</body>", "</html>"]) {
    const at = lower.lastIndexOf(marker);
    if (at >= 0) return html.slice(0, at) + INJECT_TAG + html.slice(at);
  }
  return html + INJECT_TAG;
}

function unreachablePage(target: number, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>preview unavailable</title>
<style>body{font:14px/1.6 system-ui,sans-serif;background:#0e1116;color:#e6edf3;margin:0;
display:flex;align-items:center;justify-content:center;height:100vh;text-align:center}
code{background:#1a212c;padding:2px 6px;border-radius:5px}p{color:#8b98a9;margin:6px 0 0}</style>
<div><h3>Nothing is serving port ${target}</h3>
<p>Start the project (the Logs tab's <code>Run</code> button) and reload.</p>
<p>${message.replace(/[<&]/g, "")}</p></div>`;
}

function proxyRequest(target: number, req: http.IncomingMessage, res: http.ServerResponse) {
  if ((req.url || "").split("?")[0] === INSPECTOR_PATH) {
    fs.readFile(INSPECTOR_FILE, (err, body) => {
      if (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        return res.end("inspector script missing");
      }
      // no-store: psm has no build step, so an edited inspector must take effect
      // on the next reload rather than on the next browser cache eviction
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    });
    return;
  }

  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  headers.host = `127.0.0.1:${target}`;
  // ask for plain bytes so HTML can be rewritten without a decompression step,
  // and defeat conditional requests that would return a 304 with no body to inject
  headers["accept-encoding"] = "identity";
  delete headers["if-none-match"];
  delete headers["if-modified-since"];

  const upstream = http.request(
    { host: "127.0.0.1", port: target, method: req.method, path: req.url, headers },
    (up) => {
      const out: http.OutgoingHttpHeaders = { ...up.headers };
      for (const header of STRIPPED) delete out[header];
      // keep redirects inside the proxy instead of bouncing the iframe to the
      // dev server's own origin, which would lose the inspector
      const location = String(up.headers.location || "");
      for (const host of [`http://localhost:${target}`, `http://127.0.0.1:${target}`]) {
        if (location.startsWith(host)) out.location = location.slice(host.length) || "/";
      }

      const type = String(up.headers["content-type"] || "");
      const encoding = String(up.headers["content-encoding"] || "").toLowerCase();
      const rewritable = type.includes("text/html") && (!encoding || encoding === "identity");
      if (!rewritable) {
        res.writeHead(up.statusCode || 502, out);
        up.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      up.on("data", (chunk: Buffer) => chunks.push(chunk));
      up.on("end", () => {
        const body = Buffer.from(injectInspector(Buffer.concat(chunks).toString("utf8")), "utf8");
        out["content-length"] = String(body.length);
        delete out["transfer-encoding"];
        res.writeHead(up.statusCode || 200, out);
        res.end(body);
      });
      up.on("error", () => res.destroy());
    },
  );

  upstream.on("error", (err: Error) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
    res.end(unreachablePage(target, err.message));
  });
  req.pipe(upstream);
}

/** Raw-forward websocket upgrades so HMR / live reload survives dev mode. */
function proxyUpgrade(target: number, req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
  const upstream = net.connect(target, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      const value = /^host$/i.test(key) ? `127.0.0.1:${target}` : req.rawHeaders[i + 1];
      lines.push(`${key}: ${value}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

/**
 * Start (or reuse) the proxy in front of `target`, resolving to the loopback
 * port the preview iframe should point at.
 */
export function ensurePreviewProxy(target: number): Promise<number> {
  const existing = previews.get(target);
  if (existing) {
    existing.lastUsed = Date.now();
    return Promise.resolve(existing.port);
  }
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const entry = previews.get(target);
      if (entry) entry.lastUsed = Date.now();
      proxyRequest(target, req, res);
    });
    server.on("upgrade", (req, socket, head) => {
      const entry = previews.get(target);
      if (entry) entry.lastUsed = Date.now();
      proxyUpgrade(target, req, socket as net.Socket, head);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        return reject(new Error("could not bind a preview port"));
      }
      previews.set(target, { target, port: address.port, server, lastUsed: Date.now(), });
      resolve(address.port);
    });
  });
}

export function stopPreviewProxy(target: number) {
  const preview = previews.get(target);
  if (!preview) return;
  previews.delete(target);
  preview.server.close();
}

export function sweepPreviewProxies(now = Date.now()) {
  for (const preview of [...previews.values()]) {
    if (now - preview.lastUsed > IDLE_MS) stopPreviewProxy(preview.target);
  }
}

setInterval(() => sweepPreviewProxies(), 5 * 60 * 1000).unref();
