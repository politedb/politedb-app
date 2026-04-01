Bundled local AI runtime assets live here.

Expected layout:

- `bin/macos/llama-server`
- `bin/linux/llama-server`
- `bin/windows/llama-server.exe`

Optional local-dev layout:

- `models/default.gguf`

Notes:

- The server binary should be built from `llama.cpp` server mode.
- Production builds should bundle only the binary to keep the app size small.
- The model should be a GGUF file that the bundled `llama-server` can load.
- Preferred model locations:
  - `POLITEDB_LLM_MODEL_PATH`
  - app data folder at `ai/models/default.gguf`
- `models/default.gguf` under resources is kept only as a local-development fallback.
- These assets are intentionally not committed here because they are large and platform-specific.
- For local development, you can also point the app to custom paths with:
  - `POLITEDB_LLM_SERVER_BIN`
  - `POLITEDB_LLM_MODEL_PATH`
