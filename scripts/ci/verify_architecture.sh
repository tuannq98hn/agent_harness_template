#!/usr/bin/env bash
set -Eeuo pipefail

# Architecture verification entrypoint.
# Add project-specific checks here: import boundaries, forbidden dependencies,
# file size limits, naming rules, generated docs freshness, etc.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

failures=0
fail() {
  echo "[architecture][fail] $*" >&2
  failures=$((failures + 1))
}
pass() {
  echo "[architecture][ok] $*"
}

[[ -f AGENTS.md ]] && pass "AGENTS.md exists" || fail "AGENTS.md is missing"
[[ -f ARCHITECTURE.md ]] && pass "ARCHITECTURE.md exists" || fail "ARCHITECTURE.md is missing"
[[ -f docs/validation/architecture-rules.md ]] && pass "architecture rules exist" || fail "docs/validation/architecture-rules.md is missing"

# Prevent committed secrets by filename. In a git repo only tracked/staged files count,
# so a local, git-ignored .env does not fail the gate.
secret_re='(\.pem|\.p12|\.keystore|\.jks|\.mobileprovision|(^|/)\.env(\..+)?|AuthKey_.*\.p8)$'
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  hits="$(git ls-files --cached | grep -E "$secret_re" | grep -v -E '\.env\.example$' || true)"
else
  hits="$(find . -path ./.git -prune -o -path ./node_modules -prune -o -type f -print | sed 's#^\./##' | grep -E "$secret_re" | grep -v -E '\.env\.example$' || true)"
fi
if [[ -n "$hits" ]]; then
  fail "Potential secret/config file tracked: $(echo "$hits" | tr '\n' ' ')"
else
  pass "No secret files tracked"
fi

# Board state must stay valid JSON (agents must use the harness CLI, not hand edits).
for f in .harness/tasks.json .harness/issues.json; do
  if [[ -f "$f" ]]; then
    node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && pass "$f is valid JSON" || fail "$f is corrupted"
  fi
done

# Add stack-specific checks below.
# Flutter example:
# grep -R "package:http/http.dart" lib/presentation && fail "UI imports low-level HTTP directly"

if [[ "$failures" -ne 0 ]]; then
  echo "[architecture] $failures failure(s)"
  exit 1
fi

echo "[architecture] Verification completed"
