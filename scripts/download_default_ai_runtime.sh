#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_DIR="$ROOT_DIR/src-tauri"
WORK_DIR="$ROOT_DIR/.tmp/ai-runtime"
LLAMA_DIR="$WORK_DIR/llama.cpp"
MODEL_DIR="$WORK_DIR/model"

MODEL_REPO="${MODEL_REPO:-Qwen/Qwen2.5-Coder-7B-Instruct-GGUF}"
MODEL_PATTERN="${MODEL_PATTERN:-qwen2.5-coder-7b-instruct-q4_k_m*.gguf}"
LLAMA_REF="${LLAMA_REF:-master}"
DOWNLOAD_MODEL="${DOWNLOAD_MODEL:-false}"
TARGET_TRIPLE="${TARGET_TRIPLE:-}"
MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-13.3}"

print_help() {
  cat <<'EOF'
Usage:
  ./scripts/download_default_ai_runtime.sh

Optional env vars:
  MODEL_REPO     Hugging Face repo for the GGUF model
  MODEL_PATTERN  File glob to download from the repo
  LLAMA_REF      Git ref/branch/tag for llama.cpp
  DOWNLOAD_MODEL true to also download/copy a GGUF model into resources

Requirements:
  - git
  - cmake
  - xcode command line tools on macOS
  - huggingface-cli (and already logged in if model requires auth)

What it does:
  1. Clone/update llama.cpp into .tmp/ai-runtime/llama.cpp
  2. Build llama-server
  3. Optionally download the default GGUF model
  4. Copy assets into src-tauri/resources/ai
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  print_help
  exit 0
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1"
    exit 1
  fi
}

require_cmd git
require_cmd cmake
if [[ "$DOWNLOAD_MODEL" == "true" ]]; then
  require_cmd huggingface-cli
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  if ! command -v xcodebuild >/dev/null 2>&1; then
    echo "Missing Xcode command line tools. Run: xcode-select --install"
    exit 1
  fi
fi

mkdir -p "$WORK_DIR" "$MODEL_DIR"

if [[ ! -d "$LLAMA_DIR/.git" ]]; then
  echo "Cloning llama.cpp..."
  git clone https://github.com/ggml-org/llama.cpp.git "$LLAMA_DIR"
fi

echo "Updating llama.cpp..."
git -C "$LLAMA_DIR" fetch --all --tags
git -C "$LLAMA_DIR" checkout "$LLAMA_REF"
git -C "$LLAMA_DIR" pull --ff-only || true

echo "Building llama-server with CMake..."
BUILD_DIR="$LLAMA_DIR/build"
rm -rf "$BUILD_DIR"

if [[ "$(uname -s)" == "Darwin" ]]; then
  CMAKE_ARCH_ARGS=()
  case "$TARGET_TRIPLE" in
    x86_64-apple-darwin)
      CMAKE_ARCH_ARGS+=("-DCMAKE_OSX_ARCHITECTURES=x86_64")
      ;;
    aarch64-apple-darwin)
      CMAKE_ARCH_ARGS+=("-DCMAKE_OSX_ARCHITECTURES=arm64")
      ;;
  esac

  CMAKE_ARGS=(
    -S "$LLAMA_DIR"
    -B "$BUILD_DIR"
    -DGGML_METAL=ON
    -DGGML_NATIVE=OFF
    -DLLAMA_OPENSSL=OFF
    -DLLAMA_BUILD_TESTS=OFF
    -DCMAKE_BUILD_TYPE=Release
    "-DCMAKE_OSX_DEPLOYMENT_TARGET=${MACOSX_DEPLOYMENT_TARGET}"
  )
  if (( ${#CMAKE_ARCH_ARGS[@]} > 0 )); then
    CMAKE_ARGS+=("${CMAKE_ARCH_ARGS[@]}")
  fi

  cmake "${CMAKE_ARGS[@]}"
  cmake --build "$BUILD_DIR" --config Release --target llama-server -j"$(sysctl -n hw.ncpu)"
else
  cmake -S "$LLAMA_DIR" -B "$BUILD_DIR" -DGGML_NATIVE=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release
  cmake --build "$BUILD_DIR" --config Release --target llama-server -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
fi

BIN_CANDIDATES=(
  "$LLAMA_DIR/llama-server"
  "$LLAMA_DIR/bin/llama-server"
  "$LLAMA_DIR/build/bin/llama-server"
  "$LLAMA_DIR/build/bin/Release/llama-server"
  "$LLAMA_DIR/build/bin/Release/llama-server.exe"
)

LLAMA_BIN=""
for candidate in "${BIN_CANDIDATES[@]}"; do
  if [[ -f "$candidate" ]]; then
    LLAMA_BIN="$candidate"
    break
  fi
done

if [[ -z "$LLAMA_BIN" ]]; then
  echo "Could not find built llama-server binary."
  exit 1
fi

MODEL_FILE=""
if [[ "$DOWNLOAD_MODEL" == "true" ]]; then
  echo "Downloading GGUF model from $MODEL_REPO ..."
  rm -rf "$MODEL_DIR"/*
  huggingface-cli download "$MODEL_REPO" \
    --include "$MODEL_PATTERN" \
    --local-dir "$MODEL_DIR"

  MODEL_FILE="$(find "$MODEL_DIR" -type f -name '*.gguf' | head -n 1)"
  if [[ -z "$MODEL_FILE" ]]; then
    echo "No GGUF model was downloaded."
    exit 1
  fi
fi

echo "Copying runtime assets into src-tauri/resources/ai ..."
if [[ -n "$MODEL_FILE" ]]; then
  "$ROOT_DIR/scripts/setup_llama_runtime.sh" "$LLAMA_BIN" "$MODEL_FILE"
else
  "$ROOT_DIR/scripts/setup_llama_runtime.sh" "$LLAMA_BIN"
fi

cat <<EOF

Done.

Bundled binary:
  $LLAMA_BIN

Bundled model:
  ${MODEL_FILE:-<not bundled>}

Next:
  1. Run: npm run tauri dev
  2. Open SQL editor
  3. Click AI
  4. Point POLITEDB_LLM_MODEL_PATH to a GGUF model or place one in app data
EOF
