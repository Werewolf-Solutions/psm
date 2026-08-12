#!/usr/bin/env bash
#
# psm in dev mode — the original local tool.
#
# Scans the workspace root from psm.config.json automatically, runs commands,
# streams logs, drives the AI panes. No accounts, no auth: the loopback socket
# is the trust boundary.
#
#   ./scripts/dev.sh              → http://localhost:4317
#   PORT=4000 ./scripts/dev.sh    → somewhere else
#
set -euo pipefail

# Run this, do not source it. Sourcing would leak PORT into your shell, and any
# tool you then start in that terminal would inherit it — dotenv, for one, will
# not overwrite a variable that is already set, so a sourced PORT silently wins
# over another project's .env.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "psm: run this script rather than sourcing it:  ./scripts/dev.sh" >&2
  return 1 2>/dev/null || exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -d node_modules ]; then
  echo "psm: installing dependencies first…"
  npm install
fi

# Deliberately not exported: these are handed to the server process below rather
# than pushed into this shell's environment, so nothing can inherit them by
# accident. See the sourcing guard above.
PSM_MODE=dev
PORT="${PORT:-4317}"

# Node's own failure here is an unhandled 'error' event and a stack trace, which
# buries the one fact that matters.
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  exec 3>&-
  echo "psm: port $PORT is already in use — another psm, probably." >&2
  echo "psm: stop it, or pick another port:  PORT=4000 npm run dev" >&2
  exit 1
fi

echo
echo "psm dev test — port $PORT"
echo "  workspace root: $(node -p "require('path').resolve(require('./psm.config.json').workspaceRoot)")"
echo

exec env PSM_MODE="$PSM_MODE" PORT="$PORT" npx tsx src/server/index.ts
