# Architecture

PoliteDB is a local-first desktop database client built with Tauri v2, Rust, Preact, TypeScript, Vite, and Tailwind CSS.

## High-Level Shape

- `src/` contains the frontend application: screens, components, hooks, stores, query helpers, updater helpers, and Tauri bridge code.
- `src-tauri/` contains the native shell and backend: Tauri commands, database engine dispatch, profile storage, secrets, SSH tunnels, updater, license logic, and local runtime integration.
- `public/` contains static assets used by the Vite frontend.
- `scripts/` contains project scripts that do not belong in the app runtime.

Keep UI concerns in the frontend and native/database concerns in Rust. Cross the boundary through explicit Tauri commands and typed frontend wrappers.

## Frontend Layers

- `src/screens/` owns screen-level composition and workflow state.
- `src/components/` owns reusable UI components and feature components.
- `src/hooks/` owns reusable frontend behavior.
- `src/stores/` owns shared client-side state.
- `src/lib/` owns app services, Tauri adapters, query helpers, AI assistant helpers, and updater code.
- `src/test/` owns frontend test utilities and mocks.

Screen files should compose behavior rather than becoming the only place where logic lives. When a screen grows, move focused behavior into a hook, helper, or feature component that matches the existing folder structure.

## Rust/Tauri Layers

- `src-tauri/src/commands/` exposes Tauri command entry points.
- `src-tauri/src/engines/` owns database engine abstraction, dispatch, cancellation, and driver integration.
- `src-tauri/src/operations/` owns longer-running operation execution and event emission.
- `src-tauri/src/profiles/` owns connection profile import, export, migration, encryption, and storage behavior.
- `src-tauri/src/security/` owns secret storage and keychain integration.
- `src-tauri/src/ssh_tunnel/` owns SSH tunnel lifecycle and pooling.

Tauri commands should stay thin when possible: validate inputs, call a focused service/module, map errors into frontend-friendly results, and avoid leaking sensitive values into logs.

## Data Flow

1. The frontend captures user intent through screens, components, hooks, and stores.
2. Frontend Tauri adapters call Rust commands with explicit payloads.
3. Rust commands dispatch to engine/profile/security/operation modules.
4. Long-running work reports progress or results back through command responses or emitted events.
5. The frontend updates local state and renders the result.

Prefer explicit request/response shapes over loosely typed objects. When adding a command, update the frontend caller and tests together so the contract remains obvious.

## Database Safety

Database operations may touch user data, credentials, schema metadata, and destructive actions. Treat these paths as security-sensitive:

- Do not log raw SQL, passwords, tokens, connection strings, file paths, or customer data.
- Preserve confirmation and safety checks for destructive operations.
- Keep transaction and rollback behavior intact unless the change explicitly modifies it.
- Keep engine-specific SQL generation isolated and tested where practical.
- Return clear unsupported-operation errors instead of silently generating risky SQL.

## Testing Strategy

- Use Vitest for frontend helpers, hooks, and UI behavior that can be tested without launching the desktop shell.
- Use Rust tests for parser, profile, engine, crypto, transaction, and command-supporting logic.
- For Tauri integration changes, verify the affected app flow manually or with the narrowest available automated check.
- Add regression tests when changing table editing, query execution, profile import/export, keychain, SSH, updater, or AI runtime behavior.

## Change Guidelines

- Keep changes close to the feature area being modified.
- Prefer existing module patterns over new framework-level abstractions.
- Avoid mixing UI refactors with backend behavior changes in the same patch.
- Keep `package-lock.json` synchronized when dependencies change.
- Document any verification that could not be run and why.
