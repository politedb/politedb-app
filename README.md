# PoliteDB

PoliteDB is a desktop app built with Tauri + Preact + TypeScript.

## Stack

- Tauri v2 (Rust backend + native app packaging)
- Preact + Vite (frontend)
- TypeScript
- Vitest + Testing Library

## Prerequisites

- Node.js (LTS recommended)
- Rust toolchain (`rustup`, `cargo`)
- Tauri system dependencies for your OS

For Tauri setup details, see [Tauri prerequisites](https://tauri.app/start/prerequisites/).

## Getting started

Install dependencies:

```bash
npm install
```

Run the frontend only:

```bash
npm run dev
```

Run the full Tauri app in development mode:

```bash
npm run tauri:dev
```

## Available scripts

- `npm run dev` - Start Vite dev server
- `npm run build` - Type-check and build frontend bundle
- `npm run preview` - Preview built frontend
- `npm run test` - Run tests in watch mode
- `npm run test:run` - Run tests once
- `npm run test:ui` - Open Vitest UI
- `npm run tauri` - Run Tauri CLI directly
- `npm run tauri:dev` - Start desktop app in dev mode
- `npm run format` - Format codebase with Prettier

## Building release artifacts

Local Tauri build:

```bash
npm run tauri build
```

The CI release workflow is defined in `.github/workflows/release.yml` and runs on tags matching `v*`.

## Releasing

1. Ensure app versions are updated where needed (for example `package.json` and `src-tauri/tauri.conf.json`).
2. Create and push a version tag (for example `v1.0.0`).
3. GitHub Actions builds and uploads signed artifacts and updater metadata (`latest.json`).

## Notes

- Current updater endpoint is configured in `src-tauri/tauri.conf.json`.
- Current release workflow is set up for macOS targets.
- Official macOS support starts at `macOS 13.3+`.
- Builds are blocked at startup on macOS versions below `13.3`.

## Analytics (PostHog)

The app can send product telemetry to PostHog so you can measure installs and usage.
Telemetry is privacy-first:

- essential telemetry is always on for installs, app opens, daily active usage, and app update events
- detailed product analytics are off by default until the user explicitly allows them
- users can disable detailed analytics later from the in-app Privacy dialog
- no raw SQL or query text is sent
- file paths and sensitive database identifiers are masked before capture

Setup:

```bash
cp .env.example .env
```

Then configure:

```bash
VITE_ANALYTICS_ENABLED=true
VITE_POSTHOG_KEY=phc_your_project_api_key
VITE_POSTHOG_HOST=https://us.i.posthog.com
VITE_ANALYTICS_DEBUG=true
```

Common hosts:
- US Cloud: `https://us.i.posthog.com`
- EU Cloud: `https://eu.i.posthog.com`
- Self-host: your PostHog domain

Tracked lifecycle events:
- `app_installed`: fired once per machine/browser profile
- `app_opened`: fired on each launch
- `app_active_daily`: fired once per day per machine/browser profile

Tracked usage events:
- `runtime_connection_opened`, `runtime_connection_open_error`
- `connection_test_success`, `connection_test_error`
- `connection_save_success`, `connection_save_error`
- `connection_connect_success`, `connection_connect_error`
- `sql_query_success`, `sql_query_error`, `sql_query_timeout`
- `sql_query_stream_start`, `sql_query_stream_error`
- `app_update_available`, `app_update_install_started`

Consent model:
- always tracked: `app_installed`, `app_opened`, `app_active_daily`, `app_update_available`, `app_update_install_started`
- allow-only: connection and SQL usage events

## Local AI environment variables

The AI assistant can use bundled assets, app data, or explicit environment overrides.

Useful local overrides:

```bash
export POLITEDB_LLM_SERVER_BIN=/absolute/path/to/llama-server
export POLITEDB_LLM_MODEL_PATH=/absolute/path/to/model.gguf
npm run tauri:dev
```

Resolution order:
- `POLITEDB_LLM_SERVER_BIN`
- bundled `llama-server`
- `POLITEDB_LLM_MODEL_PATH`
- downloaded app-data model at `ai/models/default.gguf`
- local dev fallback in `src-tauri/resources/ai/models/default.gguf`

## Release workflow environment variables

The GitHub release workflow reads these repository variables / secrets:

Repository variables:
- `VITE_ANALYTICS_ENABLED`
- `VITE_POSTHOG_HOST`
- `BUNDLE_AI_ASSISTANT`
- `BUNDLE_AI_MODEL`
- `AI_MODEL_REPO`
- `AI_MODEL_PATTERN`
- `AI_LLAMA_REF`

Repository secrets:
- `VITE_POSTHOG_KEY`
- `HF_TOKEN`

Recommended defaults:

```bash
BUNDLE_AI_ASSISTANT=true
BUNDLE_AI_MODEL=false
AI_MODEL_REPO=Qwen/Qwen2.5-Coder-7B-Instruct-GGUF
AI_MODEL_PATTERN=qwen2.5-coder-7b-instruct-q4_k_m*.gguf
AI_LLAMA_REF=master
```
