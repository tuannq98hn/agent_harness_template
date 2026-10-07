#!/usr/bin/env bash
set -Eeuo pipefail

# Default cross-stack quality gate. The loop runs this after every submitted task.
# Exit code 0 = pass. Any failing check fails the gate (no silent warnings for real failures).
# Customize per repository; keep it as the single command agents and CI call.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

log() { printf '\n[quality-gate] %s\n' "$*"; }
warn() { printf '\n[quality-gate][warn] %s\n' "$*" >&2; }
failures=()
check() {
  local name="$1"; shift
  log "$name"
  if "$@"; then
    printf '[quality-gate][ok] %s\n' "$name"
  else
    printf '[quality-gate][FAIL] %s\n' "$name" >&2
    failures+=("$name")
  fi
}

check "agent context" bash scripts/agent/check_context.sh
check "architecture rules" bash scripts/ci/verify_architecture.sh

# ---- static analysis (tests run once, in run_all_tests.sh) ----
if [[ -f package.json ]] && command -v npm >/dev/null 2>&1; then
  check "npm lint" npm run lint --if-present
  check "npm typecheck" npm run typecheck --if-present
fi

if [[ -f pubspec.yaml ]]; then
  if command -v fvm >/dev/null 2>&1; then FLUTTER=(fvm flutter); elif command -v flutter >/dev/null 2>&1; then FLUTTER=(flutter); else FLUTTER=(); fi
  if [[ ${#FLUTTER[@]} -gt 0 ]]; then
    fmt_dirs=(lib); [[ -d test ]] && fmt_dirs+=(test)
    check "dart format" "${FLUTTER[@]:0:${#FLUTTER[@]}-1}" dart format --output=none --set-exit-if-changed "${fmt_dirs[@]}"
    check "flutter analyze" "${FLUTTER[@]}" analyze
  else
    warn "flutter not found — static analysis skipped"
  fi
fi

if [[ -f pyproject.toml ]] && command -v uv >/dev/null 2>&1; then
  if uv run --quiet ruff --version >/dev/null 2>&1; then check "ruff" uv run ruff check .; fi
fi

if [[ -x ./gradlew ]]; then
  check "gradle lint" ./gradlew lint --quiet
fi

# ---- tests ----
check "tests" bash scripts/test/run_all_tests.sh

if [[ ${#failures[@]} -gt 0 ]]; then
  printf '\n[quality-gate] FAILED: %s\n' "${failures[*]}" >&2
  exit 1
fi
log "PASSED"
