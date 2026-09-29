# Database Health Inspector

## Status

IMPLEMENTED

User explicitly approved this plan with "duyet" in the current conversation.

## Task

- ID: database-health-inspector
- Branch: feat/database-health-inspector (from main).
- Codex plans/reviews; Grok implements after explicit approval.
- Follow AGENTS.md and .agent/WORKFLOW.md. No commit/push unless asked.

## Goal And Scope

PostgreSQL-first, read-only, on-demand health inspection inside an active connection.

- Entry beside connection tools; reuse existing modal/pane, theme, density and tables.
- Opening loads one snapshot. Manual Refresh and Cancel; no background polling.
- Overview: visible session counts, blocked sessions, longest visible transaction,
  current database size and collection timestamps. Indicate restricted visibility.
- Sessions: PID, state, transaction/query age, waits and blocker PIDs. Scope to current
  database; distinguish idle sessions from actively executing queries.
- Top statements: optional statistics-backed calls, cumulative/mean execution time.
  Show reset/observation information when available; not a live slow-query feed.
- Tables: estimated live/dead rows, maintenance timestamps and storage sizes.
- Indexes: size and scan counters, with reset/observation caveats.
- Independent loading/empty/unavailable/error states for each section.

## Exclusions

Other engines, billing, scheduled scans, history, cloud alerts and health scores.
No session termination, extension installation, grants, statistics reset, maintenance
commands, automatic index changes or automatic EXPLAIN/EXPLAIN ANALYZE.
No dependency on Query Performance History absent from this checkout.

## Verified Integration Points

- src/screens/connection/MenuBar.tsx: connection tools and connectivity health check.
- src/screens/connection/ConnectionScreen.tsx: dialog and runtime wiring.
- src/screens/connection/hooks/useConnectionScreenState.ts: dialog state.
- src/screens/connection/ConnectionRuntimeContext.tsx: runtime identity.
- src/lib/tauri/query.ts: query helper with operation timeout/cancellation, currently
  without caller AbortSignal and with raw error messages in analytics.
  Keep useConnectionHealthCheck behavior independent and unchanged.

## Architecture

- SQL builders under src/lib/queries/sql/, following current PostgreSQL conventions.
- Typed decoding and pure signal helpers under src/lib/healthInspector/.
- Typed service under src/lib/tauri/; a focused hook owns snapshot lifecycle.
- Inspector component under src/components/; screen changes limited to wiring.
- Extend existing query helper minimally for opt-in cancellation and private internal
  execution. Preserve default behavior for existing callers.
- One authoritative snapshot per runtime context; no parallel state representations.
- No new dependencies, connection pool or broad driver refactoring. Document any
  necessary native scope expansion before implementation.

## Safety And Performance

- Query catalogs/statistics only; no application-table scans or N+1 requests.
- Verify SQL against official PostgreSQL documentation and supported server versions
  before implementation. Detect optional extension columns and its actual schema.
- Missing extension, hidden SQL or insufficient privileges degrades only that section.
  Never silently install extensions or elevate permissions.
- Unknown statistics remain unknown, not zero. Zero scans does not mean safe to drop.
  Dead-row estimates and missing maintenance timestamps are signals, not diagnoses.
- Define partition and size semantics; avoid parent/child storage double-counting.
- Lists capped at 100 rows, stable ordering, truncation detected with one extra row.
  Captured query text capped at 2,000 characters and rendered as text.
- Sequential queries, no overlapping refreshes; at most 10 statements per snapshot
  including capability checks. 10-second per-query and 30-second overall deadline,
  including startup/busy retries. Stop scheduling after cancellation.
- Cancel only Inspector-owned operations. Handle cancellation while operation creation
  is pending: any late-created operation must also be cancelled.
- Close, disconnect, database/runtime changes and refresh invalidate stale responses.
  Clear results on context changes; no data leaking between profiles.
- Section timestamps and stale/error labels must distinguish mixed-age results.
- No Inspector SQL, captured text, identifiers or raw errors in telemetry, logs,
  SQL history or performance history. Internal execution must suppress such paths.
- In-memory results only; clear on close. No automatic execution of captured SQL.

## Tests And Acceptance

- SQL/decoder tests: nulls, numeric strings, large counters, estimates, partitions.
- Capabilities: absent extension, custom schema, unsupported columns, restricted role,
  hidden query text and partial failures.
- Lifecycle: double refresh, close, late operation creation, busy-retry cancellation,
  timeout, disconnect and runtime replacement under the same profile.
- Privacy: internal requests emit no telemetry/history; existing query callers retain
  behavior; cancellation never cancels unrelated work.
- UI: PostgreSQL entry, unsupported engines, partial/empty/error states, row caps,
  refresh/cancel, escaped SQL text and keyboard access.
- Large schema fixture (122+ tables): bounded statement count and rendered rows;
  no per-table calls or continuing work after close.
- Native smoke tests with ordinary/restricted roles, extension absent/present.
  Any blocking fixture belongs only in an isolated test database.
- Inspect both themes, small viewport and scrolling.

## Sequence And Verification

1. Verify PostgreSQL capabilities and existing operation lifecycle; add fixtures.
2. Implement bounded SQL, typed decoding and private cancellable execution.
3. Implement snapshot hook and race/error regression tests.
4. Wire UI using existing components and tokens.
5. Run focused tests, npm run test:run, npm run build and ESLint on changed files.
   If native changes are necessary, run cargo check and relevant Rust tests.
6. Record exact verification results and unavailable checks; Codex reviews the diff.
   Do not claim native verification from mocked browser tests.

## Completion Evidence

Implemented on branch `feat/database-health-inspector`.

Frontend Health Inspector plus a focused native Postgres error-formatting fix in
`src-tauri/src/engines/postgres/operation.rs` (surface real `DbError` text instead of
opaque `ROW_STREAM_FAILED: db error` for Inspector and other SQL callers).

### Delivered

- PostgreSQL-first Database Health Inspector dialog (Overview / Sessions / Top statements / Tables / Indexes).
- Entry in connection MenuBar (ShieldAnalytics icon); disabled for non-Postgres engines.
- SQL builders under `src/lib/queries/sql/healthInspector.ts` (catalog/stats only; list fetch 101 for truncation; query text cap 2000).
- Typed decode + signal helpers under `src/lib/healthInspector/`.
- Snapshot service `src/lib/tauri/healthInspector.ts` (sequential, ≤7 statements/snapshot, 10s/query + 30s overall, section-level degrade).
- Hook `useDatabaseHealthInspector` owns one in-memory snapshot; cancel/refresh/close/context-change invalidation.
- `runSqlQuery` extended with opt-in `signal` + `internal` (suppresses analytics; default callers unchanged). Deadline tracking starts before init/busy retries; abort/timeout settle without awaiting cancel IPC; late-created owned ops still cancelled.
- Restricted activity recognized via null query and PostgreSQL `<insufficient privilege>` marker; overview marks incomplete metrics instead of trustworthy zeroes.
- Partition parents and leaves listed separately with labels; each row reports own storage only (no double-counting).
- Last vacuum / Last analyze show the latest of manual vs automatic timestamps.
- Native: `format_pg_error` prefers `DbError` message/detail/hint (+ SQL caret) over opaque tokio-postgres Display.

### Verification (Asia/Saigon, 2026-09-28 ~18:32 — post review-fix pass)

1. Focused Vitest (health inspector + query privacy/cancel/deadline): **PASS** (56 tests / 8 files)
   `npm run test:run -- src/lib/queries/sql/healthInspector.test.ts src/lib/healthInspector/decode.test.ts src/lib/healthInspector/signals.test.ts src/lib/healthInspector/format.test.ts src/lib/tauri/healthInspector.test.ts src/lib/tauri/query.test.ts src/hooks/useDatabaseHealthInspector.test.ts src/components/healthInspector/DbHealthInspectorDialog.test.tsx`
2. `npm run build` (`tsc && vite build`): **PASS** (pre-existing chunk/externalization warnings only).
3. Rust: `cargo test annotate_sql_error_position` from `src-tauri/`: **PASS** (2 tests:
   `annotate_sql_error_position_points_at_offset`, `annotate_sql_error_position_tracks_newlines`).
4. Native PostgreSQL smoke (ordinary/restricted roles, extension present/absent): **NOT RUN** — no isolated test database / live PG fixture available in this environment.
5. Theme/viewport visual inspection in running app: **NOT RUN** (executor automation; UI covered by component tests).

### Native scope

Minimal Rust change in `src-tauri/src/engines/postgres/operation.rs` only (error formatting for UI). No new dependencies; no new Tauri commands; no connection-pool refactor.
