#!/usr/bin/env bash
# Start the local agent dashboard and open it in the browser.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
PORT="$(node -e "try{console.log(require('./harness.config.json').dashboard.port||4317)}catch{console.log(4317)}")"
URL="http://127.0.0.1:${PORT}"
node harness/cli.mjs init >/dev/null
( sleep 1
  if [[ "$(uname)" == "Darwin" ]]; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  else echo "Open $URL in your browser"; fi ) &
exec node harness/server.mjs
