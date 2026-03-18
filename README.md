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
