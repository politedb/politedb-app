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
BIN_SRC_DIR="$(cd "$(dirname "$BIN_SRC")" && pwd)"

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

find "$DEST_BIN_DIR" -maxdepth 1 -type f \
  \( -name 'llama-server' -o -name 'llama-server.exe' -o -name '*.dylib' -o -name '*.so' -o -name '*.dll' \) \
  -delete

cp "$BIN_SRC" "$DEST_BIN_DIR/$BIN_NAME"
chmod +x "$DEST_BIN_DIR/$BIN_NAME" || true

copy_runtime_libs() {
  local pattern
  local copied=1

  for pattern in '*.dylib' '*.so' '*.dll'; do
    while IFS= read -r lib; do
      cp "$lib" "$DEST_BIN_DIR/"
      copied=0
    done < <(find "$BIN_SRC_DIR" -maxdepth 1 -type f -name "$pattern" | sort)
  done

  return "$copied"
}

ensure_macos_runtime_aliases() {
  local dep
  local dep_name
  local dep_stem
  local alias_path
  local candidate

  while IFS= read -r dep; do
    dep_name="$(basename "$dep")"
    alias_path="$DEST_BIN_DIR/$dep_name"
    if [[ -f "$alias_path" ]]; then
      continue
    fi

    dep_stem="${dep_name%.dylib}"
    candidate="$(find "$DEST_BIN_DIR" -maxdepth 1 -type f -name "${dep_stem}*.dylib" | sort | head -n 1)"
    if [[ -n "$candidate" ]]; then
      cp "$candidate" "$alias_path"
      echo "  Alias : $alias_path -> $(basename "$candidate")"
    fi
  done < <(otool -L "$DEST_BIN_DIR/$BIN_NAME" | awk '/@rpath\/.*\.dylib/ {print $1}')
}

if copy_runtime_libs; then
  echo "  Runtime libs: copied from $BIN_SRC_DIR"
else
  echo "  Runtime libs: none found next to binary"
fi

if [[ "$PLATFORM_DIR" == "macos" ]]; then
  if command -v install_name_tool >/dev/null 2>&1; then
    OLD_RPATH="/Users/runner/work/politedb-universal/politedb-universal/.tmp/ai-runtime/llama.cpp/build/bin"
    install_name_tool -delete_rpath "$OLD_RPATH" "$DEST_BIN_DIR/$BIN_NAME" 2>/dev/null || true
    install_name_tool -add_rpath "@executable_path" "$DEST_BIN_DIR/$BIN_NAME" 2>/dev/null || true
  fi
  ensure_macos_runtime_aliases
fi

if [[ -n "$MODEL_SRC" ]]; then
  cp "$MODEL_SRC" "$DEST_MODEL_DIR/default.gguf"
fi

echo "Bundled AI runtime assets copied:"
echo "  Binary: $DEST_BIN_DIR/$BIN_NAME"
find "$DEST_BIN_DIR" -maxdepth 1 -type f \
  \( -name '*.dylib' -o -name '*.so' -o -name '*.dll' \) \
  -print | sed 's/^/  Lib   : /' || true
if [[ -n "$MODEL_SRC" ]]; then
  echo "  Model : $DEST_MODEL_DIR/default.gguf"
else
  echo "  Model : skipped"
fi
