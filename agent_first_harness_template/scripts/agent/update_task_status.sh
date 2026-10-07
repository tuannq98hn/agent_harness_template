#!/usr/bin/env bash
set -Eeuo pipefail

# Compatibility wrapper. Board state now lives in .harness/ and is managed by the harness CLI.
# Usage: bash scripts/agent/update_task_status.sh <TASK_ID> <todo|in-progress|done|pending> [note]

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <TASK_ID> <todo|in-progress|done|pending> [note]" >&2
  exit 1
fi
args=(task update "$1" --status "$2")
[[ $# -ge 3 ]] && args+=(--note "$3")
node harness/cli.mjs "${args[@]}"
