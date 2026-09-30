# Export Table Without Opening A Tab

## Status

IMPLEMENTED

## Task

- ID: standalone-table-export
- User approved implementation on 2026-09-30 with "ok hay lam di".
- Codex plans/reviews; Grok implements under WORKFLOW.md.
- Create feat/standalone-table-export from the current verified checkout after checking git status. Do not switch to another old branch or discard changes.
- No commit/push unless requested.
- Prior design task archived under .agent/archive/export-dialog-ux/2026-09-30/.

## Goal

Export directly from a table context menu without opening/selecting a data tab, loading grid rows or disturbing the user's current tab.

## Current Path

- ConnectionScreen.tsx actions.exportTableData calls selectTable(table) then sets pendingTableAction("export").
- LeftNavItemsPane.tsx already exposes this action in its table menu.
- MainTableDataPane.tsx consumes the pending action and owns the current tab export dialog.
- Reuse ExportTableDialog and the existing export pipeline/masking helpers.
- Existing metadata loaders and per-engine query builders must be inspected before selecting the minimal metadata API.

## Implementation

- Replace the sidebar export action with a connection-owned standalone export target containing runtime connection ID, engine, schema and table identity.
- Mount a focused standalone export host outside MainTableDataPane; do not render hidden data panes or call selectTable.
- Add/reuse Export data in the Tables-list row context menu, routing to the SAME action. Resolve the actual clicked row, not the active data tab or global selected table.
- Load only selected-table column metadata and sorting metadata genuinely required by existing export. Reuse valid connection/schema/table-scoped cache where available.
- No grid SELECT, preview sampling, whole-schema metadata hydration or mandatory COUNT(\*) before the dialog opens.
- Show cancellable metadata loading and sanitized error/retry states. Do not open a save dialog on metadata failure.
- Direct export is always whole-table: no active-tab filters, pagination or sort accidentally inherited. Existing in-tab filtered/current-page export stays unchanged.
- Support the same engines as the existing exporter. For engines without compatible standalone metadata, hide/disable with a reason rather than invent SQL or silently open a tab.
- Preserve existing profile-lock/license/export capability checks; recheck connection validity at action time.
- Capture immutable target identity for each request. Cancel/invalidate stale metadata when target changes, disconnects, host unmounts or user cancels. Late completion must not configure/export another table.
- Only one owned standalone export dialog/session per connection host. Repeated clicks must not create concurrent sessions.
- Reuse native save dialog, masking defaults, filename suggestion, three UI treatments (no Omit option), zero-column guard, temp-file safety and cancellation.
- Do not clear or mutate active-tab patches, rows, filters, selection, tab ordering or query history with customer SQL.
- Remove the old pending export dispatch path only if no callers remain; preserve unrelated pending actions.

## Unknown Row Totals

- Do not use a fake total to imply completion or show 0/0 or invalid percentages.
- Extend the shared progress contract minimally if needed: unknown total shows exported rows with indeterminate progress; success is determined by pipeline settlement, not row-count comparison.
- Preserve known-total progress for in-tab exports and capped-output warnings.

## Boundaries

- Expected areas: ConnectionScreen.tsx, LeftNavItemsPane.tsx, actual Tables-list/context-menu owner, focused standalone host/hook, ExportTableDialog progress integration, existing typed metadata wrappers.
- Keep UI, metadata I/O and orchestration separate. No new dependency or parallel masking/export pipeline.
- Tauri invocation remains in lib wrappers; SQL in existing dialect query builders.
- Never send raw rows, SQL, database identifiers or sensitive paths to telemetry.

## Acceptance And Verification

- Sidebar and Tables-list export for a never-opened table: dialog opens; selectTable/tab creation/grid load not called.
- Export table B while tab A has unsaved edits and filters: B exported fully; A unchanged.
- Correct identity when schemas have same table name and when connections change.
- Metadata error, empty metadata, cancel, disconnect, slow A response after selecting B, repeated click and unmount.
- Unknown-total progress, success, failure, truncation and cancellation; no division by zero or false completion.
- Ordinary CSV/JSON/SQL and masked CSV/JSON reuse existing serialization and lifecycle tests.
- Tests prove unchecked columns excluded and Omit absent in UI.
- npm run build, focused tests, full npm run test:run, changed-file ESLint.
- Visually smoke-test direct context-menu flow in light/dark; report native/live-DB limitations.
- Record exact results below; Codex reviews before a separately requested commit.

## Progress / Verification

- Mode: implement (PLAN Status was APPROVED).
- Branch: `feat/standalone-table-export` from base `488bcd1350449abb9745c32963826af5b2126832` (`feat/masked-export`).
- Implemented 2026-09-30 ~13:35 Asia/Saigon:
  - Connection-owned `StandaloneExportTarget` + `StandaloneTableExportHost` / `useStandaloneTableExport` outside `MainTableDataPane` (no `selectTable`, no hidden data panes).
  - Sidebar + Tables-list (`DatabaseCatalogPane`) Export data route to the same `actions.exportTableData`; clicked row identity; unsupported engines disabled with reason.
  - Metadata via cache reuse (`tableDataMap` / `columnsCache`) or silent `loadColumns` only; no grid SELECT / COUNT(\*) / query-history writes; cancellable loading + ErrorDialog retry; save dialog only after ready.
  - Whole-table export (empty filters, no pagination); in-tab filtered/page export unchanged.
  - Removed pending `"export"` action path; other pending actions preserved.
  - `ExportTableDialog` `totalRows: number | null` — unknown total shows `N rows` + indeterminate bar; completion by pipeline settlement.
- Files (task-owned): ConnectionScreen/Actions/Runtime, LeftNavItemsPane, DatabaseCatalogPane, MainTableDataPane, useConnectionScreenState, StandaloneTableExportHost, useStandaloneTableExport, standaloneExport/\*, ExportTableDialog(+test), CanvasTable (`onRowContextMenu`), useExportTableData.
- Verification (2026-09-30 ~13:35 Asia/Saigon):
  - `npm run build`: passed (existing bundler chunk warnings)
  - focused: `npm run test:run -- src/components/modal/ExportTableDialog.test.tsx src/components/modal/export/ExportColumnEditor.test.tsx src/lib/exportMasking src/lib/exportPipeline src/hooks/useExportTableData.lifecycle.test.ts src/screens/connection/standaloneExport` → 10 files / 56 passed
  - `npm run test:run`: 101 files / 536 passed
  - changed-file ESLint: clean
- Visual/native/live-DB context-menu smoke (light/dark): not exercised (no interactive Tauri + live DB session this pass).
- Unrelated working-tree preserved: `.agent/REVIEW.md` (NOT REVIEWED stub), `.agent/archive/export-dialog-ux/` (untracked archive).
- No commit/push/PR.

## Fix pass (REVIEW CHANGES REQUIRED)

- Mode: fix (2026-09-30 ~13:53 Asia/Saigon). Addressed both P2 findings; left `.agent/REVIEW.md` for Codex re-review.
- P2 exact column identifiers: `asColumnMeta` keeps nonempty names verbatim (still drops whitespace-only); cache write preserves them. Tests for columnsCache, tableDataMap, and loader paths.
- P2 frozen context-menu target: `CatalogCanvasTable` stores clicked row snapshot (`CatalogRowMenuState`); menu items built from frozen row; menu closed on projection change. Helpers `openCatalogRowMenu` / `catalogRowMenuItems` + reorder regression test.
- Lifecycle coverage (2026-09-30 ~13:56 Asia/Saigon): added `src/screens/connection/hooks/useStandaloneTableExport.test.tsx` (6 tests) for late metadata A→B / cancel, disconnect while loading/ready, unmount cancel, and active-tab preservation (mocked loader; hook never touches `useConnectionStore` / `selectTable` / query history).
- Verification (2026-09-30 ~13:56 Asia/Saigon):
  - focused: `useStandaloneTableExport.test.tsx` + `standaloneExport` + `DatabaseCatalogPane.test.ts` + `ExportTableDialog.test.tsx` → 5 files / 34 passed
  - `npm run test:run`: 102 files / 547 passed
  - `npm run build`: passed (existing bundler warnings)
  - ESLint on new hook test + hook: clean
- No commit/push/PR. Unrelated working-tree preserved. `.agent/REVIEW.md` left for Codex.
- Re-verification (2026-09-30 ~14:03 Asia/Saigon): confirmed both P2 fixes still present; focused 5 files / 34 passed; `npm run test:run` 102 / 547; `npm run build` passed; ESLint clean on fix/test files. LeftNav already freezes `tableMenu.table` (no index retarget). REVIEW status left for Codex.
- Re-verification (2026-09-30 ~14:18 Asia/Saigon): delegated fix task confirmed both P2 fixes + lifecycle tests already present; focused 5/34; `npm run test:run` 102/547; `npm run build` passed; ESLint clean. No further code changes this pass. REVIEW left CHANGES REQUIRED for Codex.

## Next Step

Codex re-reviews the P2 fixes + new lifecycle tests and updates `.agent/REVIEW.md`. No commit/push unless requested.
