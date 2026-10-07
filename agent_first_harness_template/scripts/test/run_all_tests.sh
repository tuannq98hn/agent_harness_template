#!/usr/bin/env bash
set -Eeuo pipefail

# Project-level test entrypoint. Keep this stable so agents, the loop and CI call one command.
# A missing toolchain is a warning; a failing test is a failure.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

log() { printf '\n[tests] %s\n' "$*"; }
warn() { printf '\n[tests][warn] %s\n' "$*" >&2; }

if [[ -f pubspec.yaml ]]; then
  log "Flutter/Dart tests"
  if [[ ! -d test ]]; then warn "no test/ directory"
  elif command -v fvm >/dev/null 2>&1; then fvm flutter test
  elif command -v flutter >/dev/null 2>&1; then flutter test
  elif command -v dart >/dev/null 2>&1; then dart test
  else warn "No Flutter/Dart command found"; fi
fi

if [[ -f package.json ]]; then
  log "Node.js tests"
  if command -v npm >/dev/null 2>&1; then npm test --if-present; else warn "npm not found"; fi
fi

if [[ -f pyproject.toml || -f requirements.txt ]]; then
  log "Python tests"
  if [[ ! -d tests && ! -d test ]]; then warn "no tests/ directory"
  elif command -v uv >/dev/null 2>&1; then uv run pytest
  elif command -v pytest >/dev/null 2>&1; then pytest
  else warn "pytest not found"; fi
fi

if [[ -x ./gradlew ]]; then
  log "Gradle unit tests"
  ./gradlew test
fi

log "Test script completed"
