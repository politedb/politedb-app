#!/usr/bin/env bash
# Run `tauri dev|build` for the Mac App Store flavor.
#
# Tauri CLI rewrites the `tauri` crate features in src-tauri/Cargo.toml to match
# `macOSPrivateApi: false` from tauri.appstore.conf.json. Restore the manifest on
# exit so the direct (DMG) flavor keeps `macos-private-api`.
set -euo pipefail

cmd="${1:?usage: scripts/tauri-appstore.sh <dev|build> [tauri args...]}"
shift

root="$(cd "$(dirname "$0")/.." && pwd)"
manifest="$root/src-tauri/Cargo.toml"
backup="$(mktemp)"
cp "$manifest" "$backup"
trap 'cp "$backup" "$manifest"; rm -f "$backup"' EXIT

cd "$root"
npx tauri "$cmd" \
  --config src-tauri/tauri.appstore.conf.json \
  --features app-store \
  "$@"
