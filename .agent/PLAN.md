# Export Dialog UX Redesign

## Status

IMPLEMENTED

## Task

- ID: export-dialog-ux
- User requested redesign from screenshot on 2026-09-30.
- Codex owns design/plan/review; Grok implements after approval.
- Implementation branch: feat/export-dialog-ux, created from ea23e47.
- User approved continuation after committing previous work on 2026-09-30.
- Masked Export committed as ea23e47. Preserve its behavior and regression tests.
- Prior plan/review: .agent/archive/masked-export/2026-09-30/.
- No implementation or webhook dispatch while DRAFT.

## Goal

Make column selection and masking readable in one place, with file format and export actions visible without scrolling through duplicated lists. Preserve export safety and current pipeline.

## Design

- Desktop modal width approximately 760px, capped at viewport minus 32px; height capped at viewport minus 32px.
- Stable header, compact configuration section, one flexible scrolling columns region, stable footer. Do not wrap this whole layout in another competing scroll container.
- Header: Export data; secondary table identity and current-page/filtered scope. Truncate long identifiers with accessible full name.
- First configuration row: filename input with extension suffix; compact format select beside it. CSV/JSON/SQL semantics unchanged.
- Next row: Mask sensitive values toggle. Enabling defaults selected columns to Redact; SQL unavailable in masked mode. Preserve deliberate mode-switch behavior.
- Search toolbar: Search columns; selected/output count; select-all checkbox with mixed state.
- One columns table replaces the separate checklist and MaskedColumnRules list:
  checkbox | Column | Treatment | Example
- Unmasked mode: treatment/preview absent, not a second selection component.
- Masked mode: Redact / Set null / Keep original using existing Select. User explicitly requested removing the Omit option on 2026-09-30. Example is synthetic via existing helpers, never live data.
- Unchecked columns stay visible in the table, with rule control disabled. Deselecting must not silently turn a column into Keep; reselecting defaults to Redact.
- Uncheck a column to exclude it; do not offer Omit in the treatment menu or explanatory copy. Keep internal omit compatibility/validation unchanged unless required; never reinterpret an existing omitted column as Keep. Disable export when output count is zero.
- Select-all applies to ALL columns, independent of search; label/count must make scope clear. Filtering never changes rules or selection.
- Neutral backgrounds and dividers from shared theme tokens. No amber background for the table or Redact rows.
- Keep original rows receive a small amber indicator. Footer shows count of kept output columns and a compact warning, not a long unbounded list.
- Brief synthetic label on Example column; retain masking limitations and CSV NULL semantics in accessible supplementary help, not repeated paragraphs.
- Footer: output-column count / kept-original count, Cancel and primary Export CSV/JSON button.
- Progress replaces the editable body; retains Cancel during export and completion/error/truncation feedback. Preserve actual completed-write progress and non-cancellable publication behavior.
- For narrow windows: filename/format stack; hide inline Example column and expose synthetic preview per row through an accessible disclosure. Keep checkbox/name/treatment usable without horizontal page overflow.
- At 1280x800, 6-column case must show all rows and footer. At 800x600 and 390x700, actions remain visible and every row/control reachable.
- Light/dark parity, keyboard focus, labelled row controls, Escape/close behavior compatible with active-export lifecycle.

## Engineering Boundaries

- Primary files: src/components/modal/ExportTableDialog.tsx and src/components/modal/export/MaskedColumnRules.tsx.
- Extract a focused shared export-column editor if needed; use one authoritative selection/rule state from existing hook/policy helpers.
- Do not duplicate policy transformation or create a second selected-columns store.
- No new packages, backend/file changes, real data sampling, or pipeline refactor.
- Fix empty-selection rendering locally: masked empty selection must not fall back to all selected.
- Reuse OverlayScrollArea with min-height:0 flex containment; avoid two vertically nested scrollbar regions.
- Keep existing native Select behavior and shared controls. Use existing icon library.
- Preserve filename rules, filters/sort/page scope, ordinary export formats, owned cancellation, temp-file safety, and fail-closed validation.

## Verification

- Component tests: single column list; mode defaults; checkbox/omit/zero-output behavior; search and select-all; explicit Keep warning; format restrictions; cancel/progress.
- Regression: existing masking/pipeline/hook lifecycle/operationBus tests.
- npm run build; npm run test:run; focused ESLint.
- Visually inspect light/dark at 1280x800, 800x600, 390x700 with 6 and 100 columns, long identifiers, zero search matches, progress/error.
- Verify keyboard navigation and footer visibility; report native GUI limitations honestly.

## Progress / Verification

- Mode: fix (REVIEW Status CHANGES REQUIRED + approved Omit removal).
- Branch: feat/export-dialog-ux @ ea23e47 (+ working tree; not committed).
- Fix pass 2026-09-30 ~11:37 Asia/Saigon:
  - P2 row height: ExportColumnEditor rows use `h-10` (+ py-1) so narrow Preview disclosure can grow.
  - P2 dialog width: Dialog `size="default"` outer max-width is `max-w-xl` (only this size token); removed ineffective inner max-w override.
  - P2 tests: updated count/help-copy assertions; added coverage for outer width, Omit absent, unchecked exclusion, zero-selected export block, preview min-height growth.
  - Approved Omit removal: treatment options are Redact / Set null / Keep original; checkbox excludes columns; mask toggle copy updated; ZERO_OUTPUT_COLUMNS message no longer mentions Omit; internal omit rule/validation retained (fail-closed, not mapped to Keep).
- Files touched this fix: Dialog.tsx, ExportTableDialog.tsx, ExportColumnEditor.tsx (+tests), exportMasking/policy.ts.
- Verification (2026-09-30 ~11:37 Asia/Saigon):
  - `npm run test:run -- src/components/modal/ExportTableDialog.test.tsx src/components/modal/export/ExportColumnEditor.test.tsx src/lib/exportMasking`: 3 files / 33 passed
  - `npm run build`: passed (existing bundler warnings)
  - focused ESLint on touched files: clean
- Visual/native GUI at 1280x800 / 800x600 / 390x700: not exercised (no interactive Tauri session this pass).
- Unrelated working-tree changes (Checkbox/Tooltip/SSLSection) preserved.
- No commit/push/PR.

## Next Step

Codex re-reviews the task-owned fix diff and updates `.agent/REVIEW.md`. No commit/push unless requested.
