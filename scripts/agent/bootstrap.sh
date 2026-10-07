#!/usr/bin/env bash
set -Eeuo pipefail

# Bootstrap local development for AI agents and humans.
# Customize this file per project.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

log() { printf '
[bootstrap] %s
' "$*"; }
warn() { printf '
[bootstrap][warn] %s
' "$*" >&2; }

log "Repository: $ROOT_DIR"

if [[ -f package.json ]]; then
  log "Detected Node.js project"
  if command -v npm >/dev/null 2>&1; then
    npm install
  else
    warn "npm not found"
  fi
fi

if [[ -f pubspec.yaml ]]; then
  log "Detected Flutter/Dart project"
  if command -v fvm >/dev/null 2>&1; then
    fvm flutter pub get
  elif command -v flutter >/dev/null 2>&1; then
    flutter pub get
  else
    warn "flutter not found"
  fi
fi

if [[ -f requirements.txt ]]; then
  log "Detected Python requirements.txt"
  if command -v python3 >/dev/null 2>&1; then
    python3 -m pip install -r requirements.txt
  else
    warn "python3 not found"
  fi
fi

if [[ -f pyproject.toml ]] && command -v uv >/dev/null 2>&1; then
  log "Detected Python uv project"
  uv sync
fi

if [[ -f ios/Podfile ]] && command -v pod >/dev/null 2>&1; then
  log "Detected iOS CocoaPods project"
  (cd ios && pod install)
fi

log "Bootstrap completed"
