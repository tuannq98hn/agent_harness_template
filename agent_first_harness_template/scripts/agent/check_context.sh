#!/usr/bin/env bash
set -Eeuo pipefail

# Validate that required agent context files exist.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

required_files=(
  "AGENTS.md"
  "ARCHITECTURE.md"
  "docs/QUALITY_SCORE.md"
  "docs/RELIABILITY.md"
  "docs/SECURITY.md"
  "docs/validation/quality-gates.md"
  "docs/agent-workflows/feature-implementation-loop.md"
  "docs/agent-workflows/bug-fix-loop.md"
  "docs/agent-workflows/multi-agent-loop.md"
  "harness.config.json"
  "agents/orchestrator.md"
  "agents/implementer.md"
  "agents/reviewer.md"
)

missing=0
for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "[context][missing] $file" >&2
    missing=1
  else
    echo "[context][ok] $file"
  fi
done

if [[ "$missing" -ne 0 ]]; then
  echo "[context] Required context files are missing" >&2
  exit 1
fi

echo "[context] Required context files are present"
