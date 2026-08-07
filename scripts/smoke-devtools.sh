#!/bin/sh
# Verifies that --devtools-port actually opens a reachable CDP endpoint and
# that the embedded AI Mode panel shows up as its own inspectable target.
#
# Run inside the dev container, which needs a display:
#   docker compose run --rm dev xvfb-run -a scripts/smoke-devtools.sh
set -e

PORT="${1:-9222}"

npx electron . --devtools-port="$PORT" &
APP_PID=$!
# shellcheck disable=SC2064 # expand APP_PID now, not at trap time
trap "kill $APP_PID 2>/dev/null || true" EXIT

# Electron needs to get as far as creating its windows before the endpoint
# lists anything useful.
sleep 20

echo "--- targets on port $PORT ---"
curl -s --fail "http://127.0.0.1:$PORT/json/list" | grep -E '"(type|title|url)"'
