# Masked Export Review

## Status

VERIFIED WITH LIMITATIONS

## Task

- ID: masked-export
- Branch: feat/masked-export
- Scope: current working tree, re-review of the three previous findings and related fixes.
- Reviewed: 2026-09-29.

## Findings

No additional actionable findings identified in the reviewed fixes.

## Previous Findings

- P1 destination replacement: resolved in the reviewed Unix path. The park-then-rename sequence is removed; replacement uses rename on Unix and ReplaceFileW on Windows. Native session tests pass on the current macOS host. Windows behavior is not runtime-verified.
- P2 cancellation/lifecycle: Cancel is wired to requestCancel; unmount and option reload cancel the owned export; run identity guards late save-dialog completion. MainTableDialogs conditionally mounts the export dialog, so closing it triggers teardown. Publication has an explicit non-cancellable phase to avoid reporting cancellation while replacement proceeds.
- P2 append failure: serialization/write rejections now enter terminal failure, cancel the operation, detach the subscription, abort the temporary session, and settle without requiring backend onDone.

## Verification

Fresh commands run by Codex:

- npm run test:run -- src/lib/exportMasking src/lib/exportPipeline src/lib/tauri/operationBus.exportBackpressure.test.ts src/hooks/useExportTableData.lifecycle.test.ts: 7 files, 29 tests passed.
- npm run test:run: 97 files, 507 tests passed.
- npm run build: passed. Warnings remain for chunk sizes, mixed dynamic/static imports, and node:zlib browser externalization.
- cargo test --locked --bin PoliteDB session\_: 7 tests passed on macOS.
- Inspected lifecycle tests covering cancellation, unmount, late save responses, publication-in-flight, and first-append rejection without onDone.

## Limitations

- Native GUI export with a live database was not exercised.
- Windows ReplaceFileW branch was not compiled or executed on this macOS host; Linux was not runtime-tested.
- Mocked lifecycle tests and local filesystem tests do not prove all IPC scheduling, disconnect, or filesystem failure combinations.
- This review does not claim the entire application is issue-free.
- Working tree includes staged and unstaged implementation changes plus untracked lifecycle tests. All must be accounted for in any later requested commit; staging was left unchanged.

## Next Step

Native smoke testing on supported platforms remains recommended before release. No implementation edits, commit, push, or webhook dispatch performed by this review.
