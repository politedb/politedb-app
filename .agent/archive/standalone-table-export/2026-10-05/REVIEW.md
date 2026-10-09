# Standalone Table Export Review

## Status

VERIFIED WITH LIMITATIONS

## Task

- ID: standalone-table-export
- Reviewed: 2026-09-30.
- Scope: two previous P2 fixes and added regression/lifecycle tests in the current working tree.

## Findings

No new actionable findings identified in the reviewed fix paths.

## Resolved

- Exact identifiers: asColumnMeta retains leading/trailing whitespace in nonblank column names. Cache and uncached loader tests cover distinct names such as " email " and "email", including exact cache writes.
- Context-menu target: the menu retains the clicked row instead of looking up a changing row index. Projection changes close the menu. Regression coverage verifies exporting B after live rows reorder still targets B.
- Hook lifecycle tests now cover late A-to-B metadata, cancel, disconnect during loading/ready and unmount.

## Verification

Fresh Codex runs during this re-review:

- npm run test:run: 102 files, 547 tests passed.
- npm run build: passed with existing bundler warnings (large chunks, mixed static/dynamic imports, node:zlib externalization).
- git diff HEAD --check: passed.
- Inspected actual menu snapshot wiring, metadata mapping/cache tests and hook lifecycle tests.

## Limitations

- No native GUI or live-database context-menu export smoke test performed.
- Hook lifecycle tests mock the metadata loader. Their disconnected selectTable spy does not prove the full ConnectionScreen/sidebar path preserves tabs; routing was reviewed in source, not exercised end-to-end.
- Metadata cancellation invalidates results; these tests do not prove that an already executing database metadata query is physically cancelled.
- Visual light/dark and cross-platform native save-dialog behavior remain unverified.
- Current working tree includes staged implementation files and an untracked hook test; include all task-owned files in any later requested commit. No staging or commit performed by this review.

## Next Step

Native/live-DB smoke testing remains recommended before release. Commit only when requested.
