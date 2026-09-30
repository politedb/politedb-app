# Masked Export

## Status

IMPLEMENTED

## Task

- ID: masked-export
- User explicitly approved this plan with "apply di" on 2026-09-29.
- Branch: feat/masked-export, based on current checkout.
- Codex plans/reviews; Grok implements after user approval of this concrete plan.
- Follow AGENTS.md and .agent/WORKFLOW.md. No commit/push unless asked.
- Prior task archived under .agent/archive/inspector-overview-metrics/2026-09-29/.
  Archive is reference only; retain prior verification limitations.

## Goal

Export shareable table data with explicit per-column masking, without modifying
database rows. Masking reduces disclosure; do not claim anonymization or compliance.

## MVP Scope

- Extend ExportTableDialog for current-page and filtered/full-table CSV/JSON exports.
- Ordinary export remains default and backward-compatible. Explicit Masked Export
  mode is visibly distinguished in the dialog and suggested filename.
- Per selected column: Keep original, Redact, Set null, or Omit.
- Entering masked mode defaults all selected columns to Redact. Keeping raw values
  must be an explicit column-level choice; show the count/list before exporting.
- Redact: replace every non-null cell with fixed text [REDACTED], preserving no length,
  prefix, suffix or nested fields. Preserve source nulls.
- Set null: JSON null; CSV follows a documented null representation. Masked JSON must
  not allow null-to-empty formatting to silently turn the rule into empty strings.
- Omit: remove column from headers and every row; exclude it from SQL projection.
- Reject export with zero output columns. No fallback from empty selection to all
  columns in masked mode. Unknown/stale rule mappings block export, never Keep.
- Rules apply to whole cells, including JSON/binary values, without parsing nested PII.
  Explicit Keep retains existing CSV/JSON serialization semantics, not new type promises.
- Provide synthetic previews (not live customer values) using the same rule helpers.
  No additional DB query needed for preview. Preview is illustrative, not actual rows.
- SQL format is disabled while masked mode is active. Switching to ordinary mode
  explicitly clears masked-mode expectations; do not silently remove rules on format
  changes. Normal SQL export remains unchanged.
- Rules exist only in dialog memory; clear on close and connection/table change.
  Freeze configuration for a running export, including identity/filter/sort/scope.

## Exclusions

No query-result exports, SQL dumps, connection exports, backup masking or other export
entry points. No automatic PII detection, partial email/phone masks, hashes, stable
tokens, faker data, cross-file joins, saved presets, cloud transfer or billing changes.
No database UPDATEs. No guarantees that kept columns are free of sensitive data.

## Existing Integration

- src/components/modal/ExportTableDialog.tsx: selection, format and scope controls.
- src/hooks/useExportTableData.ts: streaming query and chunk serialization.
- src/utils/csv.ts and src/utils/exportFormats.ts: existing serializers.
- src/lib/tauri/export.ts: typed file writer wrapper.
- src-tauri/src/commands/export.rs: thin file append command.
- operationBus invokes onChunk without awaiting its promise. Current async writes
  can overlap, including onDone finalization. Fix this lifecycle in the shared export
  orchestration, preserving ordinary export behavior with regression tests.

## Architecture

- Pure typed masking policy/validation/chunk transformation in src/lib/exportMasking/.
- Focused UI component for column rules; do not inflate ExportTableDialog.
- Hook handles lifecycle only; extract serial export pipeline into a testable service.
- Transform copied rows before any serializer/file call. Never mutate query result
  cells, table cache or source rows. Avoid converting raw values to strings for Redact.
- Validate stable column name/index mapping for every chunk; fail closed on schema
  mismatch, unsupported rule or transformation failure. Never write original fallback.
- No new dependency by default. Confirm tagged CellValue/null conventions from code.
- Keep Tauri calls behind typed wrappers; any new file lifecycle command remains thin.

## File Safety And Streaming

- One active export; serialize writes and await all accepted chunks before finalization.
  Completion/progress means completed writes, not submitted rows.
- Bounded buffering: do not queue the entire export. Integrate explicit consumption/
  backpressure through a narrow opt-in path, preserving other operationBus consumers.
- Cancellation, disconnect, close/unmount and late operation creation must stop only
  the owned export, clean up listeners and prevent success after failure.
- Write to an exclusive temporary sibling file; publish only after successful flush/
  close. Preserve an existing destination on failure/cancel. Use native scoped export
  sessions for temp ownership if necessary; never delete a caller-supplied arbitrary
  path as cleanup. No final file until complete; clean temporary artifacts on failure.
- Confirm platform-safe final replacement and existing overwrite confirmation. Do not
  remove an old destination before a potentially failing rename.
- For masked export, neither temp nor final file receives untransformed rows.
- Never put row contents, rules containing values, raw SQL or sensitive file paths
  in logs/telemetry/errors. UI errors should be useful but sanitized.
- Existing CSV quoting/escaping still applies after transformation. Kept spreadsheet
  formula cells remain a risk; do not advertise masking as formula-injection protection.
- Empty results: valid JSON [] or CSV headers; correct omitted-column headers.
- Preserve filters, sorting and current-page boundaries; no extra rows fetched to
  create previews. Existing row limit must not silently imply a complete export when
  truncation occurs; report incomplete/capped output clearly.

## Acceptance Tests

- Every rule across null, empty, Unicode, multiline, quotes, typed cells, JSON/binary.
- Sentinel sensitive strings absent from masked CSV/JSON, temp writes and error/log
  payloads; raw input objects unchanged. Keep is explicit and omission affects headers.
- Invalid/missing rules, reordered/missing chunk metadata and zero output columns.
- Slow writes, rapid chunks and early onDone: exact row order, one header, valid JSON,
  no duplicate/truncated content; bounded pending work.
- Write/transform/query failure, abort before operation creation, disconnect, repeated
  click, late completion and finalization failure; original destination survives.
- Cross-profile/table reopening clears rules; running config cannot drift.
- Normal CSV/JSON/SQL regression coverage, filtered export and current-page export.
- Synthetic preview uses the production transformation helper.
- Native file tests for new session/temp/publish behavior; no production DB writes.
- UI light/dark, small viewport, keyboard access and scroll behavior.

## Sequence And Verification

1. Trace export serialization, CellValue handling and operation ACK behavior.
2. Implement pure policy + tests, then bounded serial writer/file lifecycle.
3. Wire opt-in dialog controls and synthetic previews.
4. Run focused export/masking/query tests, npm run build, full npm run test:run and
   ESLint on changed files. If Rust changes: cargo check and relevant cargo tests.
5. Native smoke export to a disposable directory; verify file contents and no original
   overwrite after forced failure. Report any unavailable platform checks.
6. Record exact evidence and hand off for Codex review. No automatic commit/push.

## Completion Evidence

Implemented on branch `feat/masked-export` (base `3f06426` / main) by Grok Bot on 2026-09-29 (Asia/Saigon).

### Delivered

- Pure masking policy/transform/preview in `src/lib/exportMasking/` (Keep / Redact / Set null / Omit; fail-closed validation; synthetic previews via production transform).
- Serial export pipeline in `src/lib/exportPipeline/` (temp session writes, awaitChunkHandlers backpressure, transform-before-serialize, cancel/fail without publishing).
- Opt-in `operationBus.awaitChunkHandlers` serial ACK path (other consumers unchanged).
- ExportTableDialog Masked Export mode + `MaskedColumnRules` UI; SQL disabled while masked; `.masked` filename suggestion; rules cleared on close/reload.
- Rust scoped export sessions (`export_session_begin/append/publish/abort`) + file_storage temp sibling helpers; never deletes caller final path on abort.

### Review fixes (2026-09-29, Asia/Saigon)

Applied CHANGES REQUIRED findings from `.agent/REVIEW.md` (P1 + both listed P2s). Requirements unchanged.

- P1: `export_publish_temp` uses platform atomic replace (Unix `rename`, Windows `ReplaceFileW`); no park-then-rename. Added replace-failure + successful-replace coverage in `file_storage` tests.
- P2 cancel/lifecycle: Cancel button → `requestCancel`; hook unmount/context/`loadExportOptions` cancel owned export; run-id guards late save-dialog; non-cancellable commit phase around publish in `runStreamingExport`.
- P2 write failure: serialize/append errors call `failTerminal` (cancel op, unsub, discard temp, settle once); no publication.
- New tests: `runStreamingExport.lifecycle.test.ts`, `useExportTableData.lifecycle.test.ts`.

### Verification (exact commands)

Initial implementation:

1. `npm run test:run -- src/lib/exportMasking src/lib/exportPipeline src/lib/tauri/operationBus.exportBackpressure.test.ts` → **PASS** (5 files / 22 tests)
2. `npm run build` → **PASS** (`tsc && vite build`)
3. `npm run test:run` → **PASS** (95 files / 500 tests)
4. `npx eslint` on changed TS/TSX paths → **PASS** (no findings)
5. `cargo check` (from `src-tauri/`) → **PASS**
6. `cargo test --bin PoliteDB session_` → **PASS** (5 tests)

After review fixes (re-audited + re-verified 2026-09-29 ~17:32 Asia/Saigon by Grok Bot scheduled fix-mode poll):
Code audit confirmed WIP already closed all three REVIEW findings; no further code gaps this run.

1. `npm run test:run -- src/lib/exportMasking src/lib/exportPipeline src/lib/tauri/operationBus.exportBackpressure.test.ts src/hooks/useExportTableData.lifecycle.test.ts` → **PASS** (7 files / 29 tests)
2. `npm run build` → **PASS** (`tsc && vite build`; same pre-existing chunk/externalization warnings)
3. `npx eslint` on changed TS/TSX (`useExportTableData*`, `ExportTableDialog`, `runStreamingExport*`) → **PASS** (no findings)
4. `cargo test --locked --bin PoliteDB session_` → **PASS** (7 tests, including `publish_preserves_destination_on_replace_failure` and atomic replace success)

### Native smoke

Full GUI export (save dialog + live DB) not run in this headless agent session. Covered by Vitest pipeline/lifecycle mocks + Rust session file tests on disposable temp dirs. Risk: low for I/O lifecycle; residual risk is dialog UX only until manual smoke.

### Deviations

- Concurrent dual-agent edits briefly produced parallel `tableExport` / alternate masking APIs; final tree consolidates on `exportMasking` + `exportPipeline` + modal `MaskedColumnRules` matching the approved architecture.
- Windows atomic replace adds `Win32_Storage_FileSystem` feature to the existing `windows` crate dependency (no new package).
- No commit/push/PR (per instructions).

### Handoff

Codex should re-review `.agent/REVIEW.md`. No automatic commit. REVIEW Status left unchanged for Codex.
