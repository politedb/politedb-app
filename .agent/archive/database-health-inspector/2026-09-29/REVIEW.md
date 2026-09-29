# Database Health Inspector Review

## Status

VERIFIED WITH LIMITATIONS

## Task

- ID: database-health-inspector
- Branch: feat/database-health-inspector
- Reviewed current working tree, including staged implementation and unstaged fixes.
- Procedure: AGENTS.md and .agent/WORKFLOW.md.

## Resolved

R1-R4 from the prior review are addressed: startup/deadline cancellation,
restricted activity detection, latest maintenance timestamps and physical partitions.
The original age-format test now passes. PLAN now acknowledges native changes.

## Findings

Post-commit verification (2026-09-29): the working-tree dialog mock now matches
@root/src/hooks/useDbHealthInspector and its renamed export. The fix was already
present when this verification began. Independently reran the focused suite:
60 passed / 9 files, including all 9 previously failing dialog tests. Build passes.
Mock correction remains uncommitted; no production changes made in this pass.

No unresolved actionable findings in the R5/R6 fix scope as of 2026-09-29.
The following descriptions are historical reproductions; both are now resolved.

### R5 [P2] Timeout telemetry emitted twice

`src/lib/tauri/query.ts:337,394-405`: finalizeErr emits sql_query_timeout and
rejects; the outer catch receives the same rejection and emits it again. Ordinary
query timeouts after subscription therefore double-count failures, while startup
timeouts emit once. Keep telemetry emission in one terminal path; retain silence
for internal queries. Confirmed by query.review.test.ts: expected 1, actual 2.

### R6 [P2] Late subscription is not disposed

`src/lib/tauri/query.ts:376-389`: cancel/timeout can finalize before await subscribe
returns its unsubscribe callback. cleanup sees null, then the callback is assigned
after completion and never called. A late registered handler can retain query
buffers after Inspector close, and the bus cleanup skips active subscribers.
After subscribe resolves, immediately dispose if already finished; otherwise retain
the callback. Cover abort, timeout and terminal replay before subscribe resolves.
Confirmed by query.review.test.ts: expected unsubscribe once, actual zero.
The missing cleanup pattern also existed before this fix pass; the new cancellation
path remains affected, so the resource-lifecycle acceptance criterion is not met.

## Verification

- Existing focused suite: PASS, 56 tests / 8 files.
- Added src/lib/tauri/query.review.test.ts: 2 failing regression tests reproduce R5/R6.
  Retained for the implementation agent; no production code changed by this review.
- npm run build: PASS. Warnings: browser node:zlib externalization, chunk sizes and
  ineffective dynamic imports.
- cargo test annotate_sql_error_position --offline (src-tauri): PASS, 2 tests.
- Full suite, native PostgreSQL role/extension smoke and visual inspection not run.
- Passing mocked tests do not establish production PostgreSQL compatibility.

## Next Step

No further R5/R6 fix handoff required. Native PostgreSQL role/extension smoke and
visual verification remain release checks; this verdict does not claim they passed.

## Fix pass (Grok, 2026-09-29 ~09:46 Asia/Saigon)

Applied R5/R6 in working-tree `src/lib/tauri/query.ts` (not committed):

- R5: timeout telemetry only in the outer catch; `finalizeErr` rejects without emitting.
- R6: after `subscribe` resolves, dispose immediately if already finished.
  `query.review.test.ts` covers ordinary timeout once, plus late unsub after abort,
  timeout, and terminal error replay. Verification this pass:
- `npm run test:run -- …query.review.test.ts`: PASS (4/4)
- Focused Inspector/query suite (9 files incl. review tests): PASS (60/60)
- `npm run build`: PASS (pre-existing chunk/externalization warnings only)
  Status left CHANGES REQUIRED for Codex re-review. No commit/push.

## Codex Re-review (2026-09-29)

- R5 resolved: timeout telemetry has one emission path in the outer catch.
- R6 resolved: late unsubscribe disposed after abort, timeout or terminal replay.
- Independently reran focused Inspector/query suite: PASS, 60 tests / 9 files.
- Independently reran npm run build: PASS, same externalization/chunk warnings.
- No new actionable findings in this fix scope. No production edits or commit.
- Full suite, Rust tests and native/UI checks not rerun this pass; prior Rust
  result above is from the preceding review, not a new verification.

## Fix pass (Grok, 2026-09-29 ~10:33 Asia/Saigon)

Dialog test mock aligned with renamed hook (commit-time finding):

- `DbHealthInspectorDialog.test.tsx`: `vi.mock` path/export
  `src/hooks/useDatabaseHealthInspector` / `useDatabaseHealthInspector`
  → `@root/src/hooks/useDbHealthInspector` / `useDbHealthInspector`
  (matches dialog import module id).
- No other leftover `useDatabaseHealthInspector` refs under `src/`.
- Verification: focused Inspector/query suite (9 files): PASS (60/60).
- `npm run build`: PASS (pre-existing chunk/externalization warnings only).
- Touched only the dialog test + this note. Status left CHANGES REQUIRED
  for Codex re-verify. No commit/push.
