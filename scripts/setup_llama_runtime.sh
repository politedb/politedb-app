#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 /path/to/llama-server [/path/to/model.gguf]"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_DIR="$ROOT_DIR/src-tauri"
BIN_SRC="$1"
MODEL_SRC="${2:-}"

case "$(uname -s)" in
  Darwin) PLATFORM_DIR="macos" ;;
  Linux) PLATFORM_DIR="linux" ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM_DIR="windows" ;;
  *)
    echo "Unsupported OS: $(uname -s)"
    exit 1
    ;;
esac

BIN_NAME="llama-server"
if [[ "$PLATFORM_DIR" == "windows" ]]; then
  BIN_NAME="llama-server.exe"
fi

DEST_BIN_DIR="$TAURI_DIR/resources/ai/bin/$PLATFORM_DIR"
DEST_MODEL_DIR="$TAURI_DIR/resources/ai/models"

mkdir -p "$DEST_BIN_DIR" "$DEST_MODEL_DIR"

cp "$BIN_SRC" "$DEST_BIN_DIR/$BIN_NAME"
chmod +x "$DEST_BIN_DIR/$BIN_NAME" || true
if [[ -n "$MODEL_SRC" ]]; then
  cp "$MODEL_SRC" "$DEST_MODEL_DIR/default.gguf"
fi

echo "Bundled AI runtime assets copied:"
echo "  Binary: $DEST_BIN_DIR/$BIN_NAME"
if [[ -n "$MODEL_SRC" ]]; then
  echo "  Model : $DEST_MODEL_DIR/default.gguf"
else
  echo "  Model : skipped"
fi
