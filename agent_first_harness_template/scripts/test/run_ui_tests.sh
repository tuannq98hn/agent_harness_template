#!/usr/bin/env bash
set -Eeuo pipefail

# UI/E2E test entrypoint. Customize per stack.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[ui-tests] Add project-specific UI/E2E test commands here."

# Examples:
# npm run test:e2e
# npx playwright test
# fvm flutter test integration_test
# xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 15'
