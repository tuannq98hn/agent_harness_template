#!/usr/bin/env bash
set -Eeuo pipefail

# Integration test entrypoint. Customize per stack.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[integration-tests] Add project-specific integration test commands here."

# Examples:
# fvm flutter test integration_test
# npm run test:integration
# pytest tests/integration
# ./gradlew connectedAndroidTest
