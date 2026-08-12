#!/usr/bin/env bash
#
# Serve web/ the way nginx will at psm.werewolf.solutions — static files, SPA
# fallback, no psm process behind it.
#
# This is how you exercise the *hosted* code path locally: the page signs in
# against werewolf-dapp in the browser and talks to an agent on 127.0.0.1, so
# nothing here serves an API. Run `npm run agent` alongside it.
#
#   ./scripts/static.sh            → http://localhost:8080
#   PORT=9000 ./scripts/static.sh  → somewhere else
#
# Port 8080 is not arbitrary: it is the redirect URI registered for the local
# `psm-web` application, so sign-in only works on that port unless you register
# another. See docs/deploy/PUBLISHING-A-NEW-APP.md.
#
set -euo pipefail

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "psm: run this script rather than sourcing it:  ./scripts/static.sh" >&2
  return 1 2>/dev/null || exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."
PORT="${PORT:-8080}"

if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  exec 3>&-
  echo "psm: port $PORT is already in use." >&2
  echo "psm: stop what is on it, or pick another:  PORT=9000 npm run web" >&2
  exit 1
fi

echo
echo "psm static — serving web/ on port $PORT, the way nginx will"
echo "  this is the hosted page: it needs an agent (npm run agent) for projects"
echo

exec node -e '
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve("web");
const PORT = Number(process.env.PORT || 8080);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    // Refuse anything that climbs out of web/, the way a static server must.
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    // The API lives on the agent, not here. 404 loudly rather than serving
    // index.html with a 200, which would die later in JSON.parse.
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no API here — this is the static host; talk to the agent" }));
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(ROOT, "index.html"); // SPA fallback, needed for /auth/callback
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`  → http://localhost:${PORT}`));
'
