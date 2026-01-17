#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

# forward all args to real script, but force bash execution
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL="${SCRIPT_DIR}/../target/release/bundle/dmg/bundle_dmg.sh"

exec /usr/bin/env bash "$REAL" "$@"