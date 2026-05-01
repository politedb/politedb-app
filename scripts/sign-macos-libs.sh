#!/bin/bash
set -euo pipefail

IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
BIN_DIR="src-tauri/resources/ai/bin/macos"

if [ -z "$IDENTITY" ]; then
  echo "Missing APPLE_SIGNING_IDENTITY"
  exit 1
fi

if [ ! -d "$BIN_DIR" ]; then
  echo "AI runtime directory not found: $BIN_DIR"
  exit 1
fi

sign_file() {
  local file="$1"
  echo "Signing native runtime file: $file"
  codesign --force \
    --options runtime \
    --timestamp \
    --sign "$IDENTITY" \
    "$file"
}

find "$BIN_DIR" -name "*.dylib" -type f -print0 | while IFS= read -r -d '' file; do
  sign_file "$file"
done

find "$BIN_DIR" -type f ! -name "*.dylib" -print0 | while IFS= read -r -d '' file; do
  if [ -x "$file" ]; then
    sign_file "$file"
  fi
done

echo "Done signing native binaries"
