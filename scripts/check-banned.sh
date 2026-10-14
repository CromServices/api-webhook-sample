#!/usr/bin/env bash
# Scan customer-facing files for scripts/banned-patterns.txt.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/check-banned.mjs
