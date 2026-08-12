#!/usr/bin/env bash
#
# psm in hosted mode — the deployed posture, run locally so you can test it.
#
# This is the same process the Dockerfile starts: authenticated, multi-tenant,
# and unable to run anything on this machine (the routes that shell out are not
# registered in this mode at all). It deliberately has no filesystem of its own,
# so the board is empty until an agent is paired — that is the real behaviour,
# not a fault of the script.
#
#   ./scripts/prod.sh             → http://localhost:4318
#   PORT=9000 ./scripts/prod.sh   → somewhere else
#
# Runs on 4318 by default so it can sit alongside dev on 4317.
#
set -euo pipefail

# Run this, do not source it. Sourcing would leak PORT and the session secret
# into your shell, and anything started in that terminal afterwards would
# inherit them — dotenv will not overwrite an already-set variable, so a leaked
# PORT silently beats another project's .env.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "psm: run this script rather than sourcing it:  ./scripts/prod.sh" >&2
  return 1 2>/dev/null || exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -d node_modules ]; then
  echo "psm: installing dependencies first…"
  npm install
fi

# A real deployment injects these. Locally, .env is the convenient place.
if [ -f .env ]; then
  echo "psm: loading .env"
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# Not exported: handed to the server process at the bottom instead, so this
# shell (and anything else started from it) stays clean.
PSM_MODE=hosted
PORT="${PORT:-4318}"

# Node's own failure here is an unhandled 'error' event and a stack trace, which
# buries the one fact that matters.
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  exec 3>&-
  echo "psm: port $PORT is already in use." >&2
  echo "psm: stop what is on it, or pick another:  PORT=9000 npm run prod" >&2
  exit 1
fi
PSM_DATA_DIR="${PSM_DATA_DIR:-$PWD/.psm-data}"
PSM_BIND="${PSM_BIND:-127.0.0.1}"   # a local test has no business on 0.0.0.0

# The cookie signing key. In production this comes from the environment and is
# never written down here; for a local test, persist one so restarting the
# server does not sign you out on every code change.
SECRET_FILE=".psm-prod.env"
if [ -z "${PSM_SESSION_SECRET:-}" ]; then
  if [ -f "$SECRET_FILE" ]; then
    # shellcheck disable=SC1090
    . "./$SECRET_FILE"
  else
    PSM_SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
    printf 'PSM_SESSION_SECRET=%s\n' "$PSM_SESSION_SECRET" > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
    echo "psm: generated a local session secret → $SECRET_FILE (gitignored)"
    echo "psm: production should inject PSM_SESSION_SECRET from its own secret store"
  fi
fi

mkdir -p "$PSM_DATA_DIR"

# Which Werewolf API sign-in will go to. Getting this wrong is the likeliest
# reason a login fails, so say it out loud before anyone tries.
#
# The probe mirrors the server's own discovery (src/server/runtime.ts): a live
# dapp answers /auth/me with 401, so any reply at all means one is there.
API_URL="${WEREWOLF_API_URL:-}"
if [ -n "$API_URL" ]; then
  API_URL="$API_URL (WEREWOLF_API_URL)"
elif curl -fsS -m 2 -o /dev/null "http://127.0.0.1:3000/api/v1/auth/me" 2>/dev/null \
  || [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000/api/v1/auth/me" 2>/dev/null)" = "401" ]; then
  API_URL="http://127.0.0.1:3000/api/v1 (local dapp, auto-detected)"
else
  API_URL="https://werewolf.solutions/api/v1 (production default)"
fi

echo
echo "psm prod test — hosted mode on port $PORT"
echo "  accounts: $API_URL"
echo "  state:    $PSM_DATA_DIR"
echo "  note:     the board stays empty until an agent is paired — hosted psm has"
echo "            no filesystem. Run 'npm run agent' in another terminal for that."
echo

exec env \
  PSM_MODE="$PSM_MODE" \
  PORT="$PORT" \
  PSM_DATA_DIR="$PSM_DATA_DIR" \
  PSM_BIND="$PSM_BIND" \
  PSM_SESSION_SECRET="$PSM_SESSION_SECRET" \
  npx tsx src/server/index.ts
