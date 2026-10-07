#!/usr/bin/env bash
set -Eeuo pipefail

# Documentation gardening helper.
# Use this to detect obvious stale placeholders and missing required docs.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

printf '
[doc-gardening] Checking required context...
'
bash scripts/agent/check_context.sh

printf '
[doc-gardening] Searching for TODO/TBD placeholders...
'
if command -v grep >/dev/null 2>&1; then
  grep -RIn --exclude-dir=.git --exclude="*.zip" -E "TODO|TBD|PLACEHOLDER|Replace this" AGENTS.md ARCHITECTURE.md docs scripts || true
fi

printf '
[doc-gardening] Review placeholders above and convert important items into exec plans or tech debt.
'
