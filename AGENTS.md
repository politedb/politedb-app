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

## SOLID Principles

Apply SOLID when designing or refactoring code. Prefer extending existing boundaries over inventing parallel structures.

### Single Responsibility (SRP)

- Each module, function, or type should have one reason to change.
- Keep UI rendering, state orchestration, and I/O separate in `src/` (components vs hooks vs `lib/` / API wrappers).
- SQL query builders live in `src/lib/queries/sql/` (not hooks). Tauri `invoke` belongs in `src/lib/tauri/`.
- In `src-tauri/`, keep Tauri command handlers thin: validate input, delegate to a focused service or adapter, return DTOs.
- Split files when they mix unrelated concerns (e.g. connection UI + export crypto + query execution).

### Open/Closed (OCP)

- Extend behavior through new implementations or small hooks, not by editing many call sites.
- Add database- or dialect-specific logic via adapters/traits (Rust) or strategy modules (TypeScript), not `if (engine === …)` scattered across the app.
- Prefer composition and configuration over modifying shared core types for one feature.

### Liskov Substitution (LSP)

- Subtypes and implementations must honor the contracts of what they replace.
- Rust: trait implementations must satisfy all documented invariants; do not weaken error handling or skip steps the trait implies.
- TypeScript: if a function accepts a union or interface, every variant must behave consistently for callers (same shape, errors, and side-effect expectations).
- Do not “special-case” a subtype in callers; fix the implementation or narrow the abstraction.

### Interface Segregation (ISP)

- Expose small, purpose-specific APIs instead of large “god” interfaces or command surfaces.
- Split Tauri commands and frontend service types by use case (connect, query, edit row, export) rather than one mega-struct or mega-module.
- Consumers should depend only on the methods or fields they need; avoid forcing unrelated callers to implement or pass unused options.

### Dependency Inversion (DIP)

- High-level modules depend on abstractions, not concrete drivers or UI details.
- Frontend: call Tauri commands and typed wrappers in `lib/`, not ad hoc `invoke` scattered in components.
- Backend: depend on traits or narrow ports for DB access, filesystem, keychain, and SSH; wire concrete adapters at the edges (`commands/`, `adapters/`).
- Inject or pass dependencies in tests via the same abstractions; avoid hard-coding globals when a port already exists.

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
