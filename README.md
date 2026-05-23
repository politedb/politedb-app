# PoliteDB - Modern database client for massive datasets

<p align="center">
  <img src="public/logo.png" alt="PoliteDB app icon" width="280" />
</p>

**PoliteDB** is a fast, privacy-conscious database client for developers who want a clean desktop SQL editor, reliable table editing, secure connection management, and local AI assistance in one native macOS app.

PoliteDB is built with **Tauri**, **Rust**, **Preact**, and **TypeScript**. It is designed for daily database work across PostgreSQL, MySQL, MariaDB, SQLite, SQL Server, Oracle, MongoDB, Redis, DuckDB, Turso, Cassandra, Snowflake, ClickHouse, and Cloudflare D1.

## Database Client Keywords

PoliteDB is a database GUI, SQL client, PostgreSQL client, MySQL client, SQLite browser, Redis GUI, MongoDB client, database table editor, SQL query editor, TablePlus alternative, DBeaver alternative, and native macOS database management app.

## Supported Databases

| PostgreSQL | MySQL     | SQLite        | SQL Server    | MongoDB        | Redis             | MariaDB    |
| ---------- | --------- | ------------- | ------------- | -------------- | ----------------- | ---------- |
| **DuckDB** | **Turso** | **Cassandra** | **Snowflake** | **ClickHouse** | **Cloudflare D1** | **Oracle** |

## Why PoliteDB?

- **Native desktop performance** - a lightweight Tauri app with a Rust backend and a responsive Preact interface.
- **Reliable SQL editing** - Monaco-powered SQL editing, query execution, query history, and safer statement handling.
- **Hardened table editing** - row edits, inserts, deletes, schema edits, change review, and engine-specific SQL generation.
- **Transactional save flow** - relational table edits can execute through backend transaction commands with rollback on failure.
- **Safe editing without primary keys** - virtual-key safety blocks risky updates and deletes when rows cannot be identified safely.
- **CSV import and export workflows** - import data with column mapping, null handling, validation, and transactional execution.
- **Secure connection profiles** - store secrets in the system keychain and share encrypted profile exports.
- **TablePlus and DBeaver migration** - import connections from TablePlus and DBeaver to move your workspace into PoliteDB faster.
- **Local AI assistant** - optional bundled local AI runtime for database workflows without sending raw SQL to third-party services.
- **Privacy-first analytics** - detailed analytics are opt-in, and raw SQL/query text is not sent.

## Table Editing Built for Safety

PoliteDB focuses heavily on reliable table editing across different SQL engines:

- dialect-aware table actions for create, clone, copy, truncate, drop, and rename flows
- phase-based patch generation so structure changes run before data changes and constraints run afterward
- engine-specific DDL for PostgreSQL, MySQL, MariaDB, SQLite, SQL Server, and Oracle where supported
- clear unsupported-operation errors instead of silently generating unsafe SQL
- backend transaction execution for relational edit batches
- guarded DDL transaction behavior for engines with implicit commits
- row-diff review before saving changes
- paginated row identity handling so edits target the correct original row

## Import Connections from TablePlus and DBeaver

PoliteDB can import external connection profiles from popular database tools.

| TablePlus import                                                             | DBeaver import                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| ![Import TablePlus database connections into PoliteDB](public/tableplus.png) | ![Import DBeaver database connections into PoliteDB](public/dbeaver.png) |

Supported migration workflows include:

- DBeaver `data-sources.json` import
- TablePlus `.tableplusconnection` and connection plist import
- encrypted PoliteDB connection export/import
- password prompts for encrypted imported data
- keychain-aware secret handling

## Features

### SQL Query Editor

- Monaco SQL editor
- query execution history
- SQL formatting support
- safer multi-statement splitting
- query safety modes for destructive SQL
- Touch ID authentication for protected query workflows on macOS

### Table Browser and Data Editor

- browse schemas, tables, columns, indexes, and constraints
- edit cells with improved table cell editors
- insert, update, and delete rows
- selected-row detail panel
- filter and sort table data
- loading progress indicator for large table reads
- review pending row diffs before saving

### Import, Export, and Sharing

- CSV import with mapping, null handling, and validation
- transactional CSV imports for SQL engines
- encrypted connection profile export/import
- DBeaver connection import
- TablePlus connection import
- local profile storage with secure keychain integration

### AI Assistant

- optional local AI runtime
- configurable GGUF model path
- bundled-runtime support for release builds
- model download management and cancellation
- local-first design for sensitive database workflows

### Security and Privacy

- native keychain integration for secrets
- SSH tunnel support
- encrypted profile exports
- opt-in product analytics
- no raw SQL or query text in telemetry
- masked file paths and sensitive database identifiers

## Built With

- [Tauri v2](https://tauri.app/) - Rust backend and native desktop packaging
- [Preact](https://preactjs.com/) - fast frontend UI
- [Vite](https://vite.dev/) - development and build tooling
- [TypeScript](https://www.typescriptlang.org/) - typed frontend code
- [Rust](https://www.rust-lang.org/) - database drivers, native commands, and desktop integration
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) - SQL editor experience

## Requirements

- macOS 13.3 or later for official macOS builds
- Node.js LTS for local development
- Rust toolchain for Tauri development
- Tauri system dependencies for your operating system

For Tauri setup details, see the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

## Getting Started

Install dependencies:

```bash
npm install
```

Run the frontend only:

```bash
npm run dev
```

Run the full Tauri desktop app in development mode:

```bash
npm run tauri:dev
```

Build the frontend:

```bash
npm run build
```

Build the desktop app:

```bash
npm run tauri build
```

## Available Scripts

- `npm run dev` - start the Vite dev server
- `npm run build` - type-check and build the frontend bundle
- `npm run preview` - preview the built frontend
- `npm run test` - run tests in watch mode
- `npm run test:run` - run tests once
- `npm run test:ui` - open the Vitest UI
- `npm run tauri` - run the Tauri CLI directly
- `npm run tauri:dev` - start the desktop app in development mode
- `npm run tauri:dev:trace` - start the desktop app with trace logging
- `npm run format` - format the codebase with Prettier

## Analytics Configuration

PoliteDB can send privacy-first product telemetry to PostHog.

Detailed product analytics are off by default until the user explicitly allows them. Raw SQL and query text are not sent.

```bash
cp .env.example .env
```

Configure:

```bash
VITE_ANALYTICS_ENABLED=true
VITE_POSTHOG_KEY=phc_your_project_api_key
VITE_POSTHOG_HOST=https://us.i.posthog.com
VITE_ANALYTICS_DEBUG=true
```

Common hosts:

- US Cloud: `https://us.i.posthog.com`
- EU Cloud: `https://eu.i.posthog.com`
- self-hosted: your PostHog domain

## License Activation

The desktop app includes an app-side license flow for per-device activation.

```bash
VITE_LICENSE_API_BASE=https://your-license-api.example.com
VITE_LICENSE_PRODUCT=politedb
```

Expected endpoints:

- `POST /v1/licenses/activate`
- `POST /v1/licenses/validate`
- `POST /v1/licenses/deactivate`

## Local AI Environment Variables

The AI assistant can use bundled assets, app data, or explicit environment overrides.

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

## Release Workflow

The GitHub release workflow is defined in `.github/workflows/release.yml` and runs on tags matching `v*`.

1. Update app versions in `package.json`, `src-tauri/tauri.conf.json`, Cargo files, and lockfiles.
2. Create and push a version tag, for example `v1.0.0`.
3. GitHub Actions builds signed artifacts and updater metadata.

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

Recommended AI release defaults:

```bash
BUNDLE_AI_ASSISTANT=true
BUNDLE_AI_MODEL=false
AI_MODEL_REPO=Qwen/Qwen2.5-Coder-7B-Instruct-GGUF
AI_MODEL_PATTERN=qwen2.5-coder-7b-instruct-q4_k_m*.gguf
AI_LLAMA_REF=master
```

## FAQ

### Is PoliteDB a TablePlus alternative?

Yes. PoliteDB is a modern database client for developers who want a native SQL client, table editor, secure connection manager, and local AI assistant. It also includes TablePlus connection import support.

### Is PoliteDB a DBeaver alternative?

Yes. PoliteDB supports many popular SQL and NoSQL engines, provides a desktop database GUI, and can import DBeaver connection profiles.

### Does PoliteDB support PostgreSQL, MySQL, and SQLite?

Yes. PoliteDB supports PostgreSQL, MySQL, MariaDB, SQLite, and several other engines including SQL Server, Oracle, MongoDB, Redis, DuckDB, Turso, Cassandra, Snowflake, ClickHouse, and Cloudflare D1.

### Does PoliteDB send SQL queries to analytics?

No. PoliteDB does not send raw SQL or query text in telemetry.

## License

PoliteDB is currently distributed as a private desktop application. Check the project license and release policy before redistributing builds.
