# Export Dialog UX Review

## Status

VERIFIED WITH LIMITATIONS

## Task

- ID: export-dialog-ux
- Reviewed: 2026-09-30.
- Scope: previous three P2 findings and approved removal of the Omit UI option, current working tree.

## Findings

No new actionable findings identified in the reviewed fix diff.

## Resolved

- Preview rows use h-10 with vertical padding, allowing the disclosure to grow instead of overflowing a fixed-height row.
- The 760px/viewport width cap now applies to the outer Dialog wrapper. Only ExportTableDialog currently uses size="default"; existing dialog sizes remain unchanged.
- Stale label/help assertions are updated; new tests cover the intended outer width classes, preview growth classes, zero selection and output counts.
- Omit is removed from selectable treatment options and mask-toggle copy. Choices are Redact, Set null, Keep original. Unchecking a column excludes it.
- Internal omit validation/transformation remains for compatibility and is not converted to Keep. It is not exposed as a menu option.

## Verification

Fresh Codex checks:

- npm run test:run: 99 files, 528 tests passed.
- npm run build: passed; existing bundler warnings remain for large chunks, mixed imports and node:zlib browser externalization.
- git diff --check: passed for the unstaged fix diff.
- Inspected changed source and regression assertions; no production code edited by this review.

## Limitations

- CSS-class assertions are not rendered-layout verification. Browser/native screenshots at 1280x800, 800x600 and 390x700 remain outstanding, including expanded previews, footer wrapping, long names and light/dark themes.
- Live database export and native save-dialog interaction were not re-run in this pass.
- Existing unrelated staged changes were preserved. No staging, commit, push or webhook dispatch performed.

## Next Step

Run visual smoke checks before release. Commit only when requested by the user.
