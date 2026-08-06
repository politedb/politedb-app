# PoliteDB Feature Map

Use this map to find the owning area before changing a feature. Prefer extending the listed modules over creating parallel implementations.

## Connection Workspace

| Feature                          | Primary paths                                                                                         | Notes                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Main connection screen           | `src/screens/connection/ConnectionScreen.tsx`, `src/screens/connection/ConnectionWorkspaceLayout.tsx` | Overall layout, active windows, sidebars, toolbar wiring.          |
| Open/close table and SQL windows | `src/screens/connection/hooks/useConnectionWindows.ts`, `src/stores/screen.ts`                        | Window identity, active window state, close behavior.              |
| Connection actions               | `src/screens/connection/hooks/useConnectionActions.ts`                                                | Refresh, pagination, save/discard, tab close, Redis rename/delete. |
| Left navigation                  | `src/screens/connection/LeftNav.tsx`                                                                  | Schemas, tables, search, table selection.                          |
| Right panel / Data Info          | `src/screens/connection/RightNav.tsx`                                                                 | Selected-row details, table info, AI assistant tab.                |

## Table Browser And Editing

| Feature              | Primary paths                                                                                                 | Notes                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Table data pane      | `src/screens/connection/MainTableDataPane.tsx`                                                                | Top-level data/structure/constraints pane and table UI wiring.      |
| Table loading        | `src/screens/connection/hooks/useMainTableDataLoading.ts`, `src/lib/table-data/`                              | Load planning, row streaming, metadata, row count, size info.       |
| SQL table queries    | `src/lib/queries/sql/`                                                                                        | Engine-specific SQL for rows, columns, constraints, indexes, sizes. |
| Row storage          | `src/stores/connection/rowsSlice.ts`, `src/stores/connection/store.ts`                                        | Row windows, streaming state, row updates.                          |
| Filters and sorting  | `src/components/table/TableFilterBar.tsx`, `src/stores/connection/store.ts`, `src/lib/table-data/loadPlan.ts` | Applied filters/sort must be passed to reloads.                     |
| Cell editing         | `src/components/table/`, `src/screens/connection/MainTableDataPane.tsx`                                       | Inline edits, selected-row edits, null/default handling.            |
| Add/delete rows      | `src/screens/connection/hooks/useTableDataOperations.ts`                                                      | Creates patch entries rather than immediately writing to DB.        |
| Structure editing    | `src/screens/connection/hooks/useTableStructureOperations.ts`                                                 | Column and FK structure edits.                                      |
| Constraint editing   | `src/screens/connection/hooks/useTableConstraintOperations.ts`                                                | Constraints patch flow.                                             |
| Patch helpers        | `src/screens/connection/hooks/useTablePatches.ts`, `src/lib/patches/`                                         | Overlay pending changes and generate SQL.                           |
| Save/discard changes | `src/screens/connection/hooks/useConnectionActions.ts`                                                        | Applies patches, clears state, reloads affected tables.             |

## SQL Editor

| Feature         | Primary paths                                                                           | Notes                                                                   |
| --------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| SQL editor UI   | `src/components/editor/`, `src/screens/connection/ActiveWindowContent.tsx`              | Monaco editor, editor window content.                                   |
| SQL runner      | `src/screens/connection/hooks/useSqlRunner.ts`                                          | Run/explain flow, result run tabs, cancellation, result state.          |
| Query history   | `src/screens/connection/hooks/useSqlHistoryRunner.ts`, `src/stores/connection/store.ts` | History should not receive internal explain helper SQL unless intended. |
| Safety modes    | `src/lib/queries/sql/`, `src/screens/connection/`                                       | Lock/safe/production behavior and SQL classification.                   |
| SQL draft/cache | `src-tauri/src/commands/sql_draft.rs`, frontend SQL window state                        | Scope by profile/connection/database context.                           |

## Database Engines

| Feature                  | Primary paths                                                                                               | Notes                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Engine registry/dispatch | `src-tauri/src/engines/registry.rs`, `src-tauri/src/engines/driver.rs`                                      | Add engine behavior through adapters/traits.                |
| SQL classification       | `src-tauri/src/engines/sql_classify.rs`                                                                     | Used by safety and validation flows.                        |
| Query execution/cancel   | `src-tauri/src/commands/operation.rs`, `src-tauri/src/engines/cancel.rs`, `src-tauri/src/operations/`       | Long-running queries and table streams must be cancellable. |
| SQL engines              | `src-tauri/src/engines/*/`                                                                                  | Per-engine connection and driver modules.                   |
| Non-SQL engines          | `src-tauri/src/commands/mongo.rs`, `src-tauri/src/commands/cassandra.rs`, `src-tauri/src/commands/redis.rs` | Keep non-SQL patch/query behavior separate from SQL paths.  |

## Profiles, Secrets, And Imports

| Feature                | Primary paths                                                             | Notes                                               |
| ---------------------- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| Profile store          | `src/stores/profile.ts`, `src-tauri/src/profiles/`                        | Profile persistence, validation, migration.         |
| Profile forms          | `src/components/connection/ConnectionFormDialog.tsx`, `src/screens/main/` | Create/edit/test connection UX.                     |
| Keychain/secrets       | `src-tauri/src/security/`, `src-tauri/src/engines/profile_secrets.rs`     | Never log or expose raw secrets.                    |
| Import/export profiles | `src-tauri/src/commands/profile/`, `src-tauri/src/profiles/`              | DBeaver/TablePlus/PoliteDB encrypted import-export. |
| SSH tunnels            | `src-tauri/src/ssh_tunnel/`, `src-tauri/src/engines/tunnel_endpoint.rs`   | Tunnel lifecycle and connection rewrite behavior.   |

## Import, Export, And Table Actions

| Feature            | Primary paths                                                                    | Notes                                                   |
| ------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| CSV import         | `src-tauri/src/engines/csv_import.rs`, `src/screens/connection/hooks/`           | Mapping, null/default behavior, transaction handling.   |
| Export data        | `src-tauri/src/commands/export.rs`, `src/screens/connection/`                    | Keep large export paths cancellable and memory-aware.   |
| Table context menu | `src/screens/connection/LeftNav.tsx`, connection actions/hooks                   | Open, copy name, export, import, clone, truncate, drop. |
| New table drafts   | `src/screens/connection/hooks/useConnectionActions.ts`, `src/stores/connection/` | Draft tables allow limited actions until created.       |

## AI Assistant

| Feature                | Primary paths                                                         | Notes                                            |
| ---------------------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| Assistant UI           | `src/components/ai-assistant/`, `src/screens/connection/RightNav.tsx` | Local assistant surface.                         |
| Assistant frontend lib | `src/lib/ai-assistant/`                                               | Request orchestration and local runtime helpers. |
| Native AI runtime      | `src-tauri/src/ai_runtime.rs`, `src-tauri/src/commands/ai.rs`         | Model/runtime setup, download, cancellation.     |

## App Shell, Updater, License

| Feature       | Primary paths                                                                        | Notes                                     |
| ------------- | ------------------------------------------------------------------------------------ | ----------------------------------------- |
| App shell     | `src/main.tsx`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`                      | App startup and Tauri plugin setup.       |
| Window chrome | `src-tauri/src/window_chrome.rs`, frontend layout components                         | macOS window behavior and custom chrome.  |
| Updater       | `src/lib/updater/`, `src-tauri/src/commands/updater.rs`                              | Release update checks and install flow.   |
| License       | `src-tauri/src/license.rs`, `src-tauri/src/commands/license.rs`, frontend license UI | Activation, validation, and trial gating. |

## Tests And Verification

| Area           | Primary paths                                     | Notes                                                           |
| -------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| Frontend tests | `src/test/`, `*.test.ts`, `*.test.tsx`            | Vitest unit/component tests.                                    |
| Rust tests     | `src-tauri/src/**`                                | Prefer focused tests around parsers, safety, profiles, engines. |
| Build          | `package.json`, `vite.config.ts`, `tsconfig.json` | `npm run build` runs TypeScript and Vite build.                 |

## Ownership Rules

- UI changes start in `src/screens/` or `src/components/`.
- State changes start in `src/stores/connection/`, `src/stores/screen.ts`, or `src/stores/profile.ts`.
- SQL generation changes start in `src/lib/queries/sql/` or `src/lib/patches/`.
- Tauri command changes start in `src-tauri/src/commands/` and delegate to focused backend modules.
- Engine-specific behavior belongs in engine adapters, not scattered conditionals in UI components.
- Security-sensitive flows need explicit review for logs, secrets, destructive SQL, and rollback behavior.
