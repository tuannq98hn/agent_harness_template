#!/usr/bin/env bash
set -Eeuo pipefail

# Unit test entrypoint. Customize per stack.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[unit-tests] Add project-specific unit test commands here."

# Examples:
# fvm flutter test test/unit
# npm run test:unit
# pytest tests/unit
# ./gradlew testDebugUnitTest
