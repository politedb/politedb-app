# PoliteDB Agent Guide

PoliteDB is a Tauri v2 desktop database client with a Rust backend and a Preact/Vite/TypeScript frontend.

## Project Stack

- Frontend: Preact, TypeScript, Vite, Tailwind CSS, Monaco Editor.
- Desktop/backend: Tauri v2 and Rust under `src-tauri/`.
- Tests: Vitest for frontend/unit tests.
- Package manager: npm. Keep `package-lock.json` in sync with dependency changes.

## Common Commands

- Install dependencies: `npm install`
- Frontend dev server: `npm run dev`
- Full desktop app: `npm run tauri:dev`
- Full desktop app with trace logging: `npm run tauri:dev:trace`
- Frontend build/type-check: `npm run build`
- Desktop build: `npm run tauri build`
- Tests once: `npm run test:run`
- Tests in watch mode: `npm run test`
- Format codebase: `npm run format`

## Development Guidelines

- Prefer small, focused changes that match the existing module boundaries in `src/` and `src-tauri/src/`.
- Put frontend UI and state changes in `src/`; put native/database/Tauri command work in `src-tauri/src/`.
- Do not introduce a new package manager or commit generated dependency files other than the existing npm lockfile.
- Keep TypeScript strictness and Rust compiler warnings meaningful; do not silence errors broadly.
- When changing shared query, table editing, profile import/export, keychain, SSH, updater, or AI runtime flows, add or update focused tests where practical.
- Use existing helpers and patterns before adding new abstractions.

## Security And Privacy

- Never log raw SQL, query text, passwords, tokens, connection strings, database names, file paths, or customer data unless the surrounding code already masks them.
- Preserve opt-in analytics behavior. Do not add telemetry that sends raw SQL or sensitive database identifiers.
- Treat connection profiles, encrypted exports, keychain access, SSH tunnels, and database edit operations as security-sensitive code.
- For destructive database actions, keep existing confirmation, safety, transaction, and rollback behavior intact unless the change explicitly targets that behavior.

## Verification Expectations

- For frontend-only changes, run `npm run build` and the relevant Vitest tests.
- For Rust/Tauri command changes, run the relevant Rust checks/tests from `src-tauri/` and verify the affected frontend integration when possible.
- For UI changes, run the app or dev server and inspect the affected screen when feasible.
- If a verification step cannot be run locally, document the reason and the risk in the handoff.
