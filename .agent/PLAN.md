# Inspector Overview Metrics

## Status

IMPLEMENTED

## Task

- ID: inspector-overview-metrics
- Branch: feat/inspector-overview-metrics, based on the current clean checkout.
- User requested a plan and Grok implementation of the proposed overview additions.
- User explicitly approved this concrete plan on 2026-09-29 ("ok duyet").
- Codex owns plan/review; Grok owns implementation. No commit/push unless asked.
- Prior task archived at .agent/archive/database-health-inspector/2026-09-29/.
  Archive is reference only, not a polling target or authorization to restart work.

## Goal

Extend the existing PostgreSQL Inspector overview with actionable, accurately scoped
metrics. Preserve read-only manual snapshots, existing tabs, theme and layout patterns.

## Scope

1. Idle in transaction: count including aborted idle transactions, oldest transaction
   age, and longest idle-state duration. Distinguish transaction age from idle duration.
   Exclude Inspector's own backend from workload indicators. Incomplete visibility
   yields unknown or explicitly partial values, never an apparently complete zero.
2. Blocking: retain blocked-session count and show up to five blocker PIDs ranked by
   distinct blocked sessions, deterministic ties. Include an action to open Sessions.
   Summaries must use the whole current-database activity set, not its 100-row UI cap.
   Blocker details hidden by privileges or outside this database remain unresolved
   PIDs with an explicit limitation; do not fetch unrelated database query text.
   Preserve prepared-transaction blocker PID 0 as a special case, not a live session.
   Do not label query age or transaction age as lock-wait duration. Exact wait duration
   is out of scope unless a verified supported source is available; show unavailable.
3. Connections: show client-backend count for current database and separately for
   the server, plus max_connections if readable. Include this application's client
   connection in capacity counts and explain scope via tooltip. Do not divide the
   database count by a server-wide limit or include background workers as clients.
   Describe server usage as approximate relative to configured maximum, not available
   slots: reserved slots, role/database limits and poolers prevent that inference.
   Failure to read optional settings must not make the entire overview unavailable.
4. Temporary files: current database temp_files and temp_bytes with stats-reset time.
   These are cumulative statistics, not current disk occupancy or current spill rate.
5. Deadlocks: current database cumulative deadlocks with stats-reset time. Historical
   events must not be presented as ongoing blocking.
6. Attention section: compact unframed list below the overview, no new modal.
   Show actionable current conditions (blocked sessions; idle-in-transaction sessions)
   with evidence and a Sessions navigation action. Historical deadlocks may appear
   as informational history explicitly labelled since reset, never a current incident.
   Temp bytes alone does not justify a critical alert or tuning recommendation.
   If data is incomplete, show that rather than 'healthy' or 'no issues'.
   Switching to Sessions must not execute SQL again; reuse the collected snapshot.
   If a target is outside the capped session list, do not claim it is shown or selected.

## Exclusions

No rates/deltas, cache-hit ratio, growth history, persisted samples, auto-refresh,
threshold settings, external monitoring, health score, billing or other engines.
No kill-session, grants, extension installs, maintenance commands or automatic SQL.
No broad redesign or unrelated toolbar/component style changes.

## Integration And Design

- Extend src/lib/queries/sql/healthInspector.ts overview SQL and bounded blocker query
  if needed; consolidate repeated activity scans where practical.
- Extend src/lib/healthInspector/types.ts, decode.ts, signals.ts and format.ts.
- Extend src/lib/tauri/healthInspector.ts only if an extra bounded query is needed.
- Extend src/components/healthInspector/DbHealthInspectorDialog.tsx; extract a focused
  Overview component into the same feature directory instead of growing the dialog.
- Keep useDbHealthInspector snapshot lifecycle and query execution guarantees.
- Prefer pure testable metric/signal helpers; no new dependencies or Rust scope planned.
- Verify exact catalog fields/permissions/version behavior using official PostgreSQL
  docs before implementation; feature-detect optional capabilities.
- Keep optional metrics independently nullable with limitations. Missing/reset-unknown
  data is unknown; bigint counters must not silently become precise-looking rounded
  integers. Reuse safe formatting and document estimates where appropriate.

## Invariants

- Read-only metadata/statistics only; no user-table scans or N+1 backend requests.
- At most 10 statements per snapshot; 10-second query / 30-second overall deadline.
- Keep 100-row UI caps and 2,000-character query-text caps.
- No SQL/identifiers/raw errors/customer data sent to telemetry or logs.
- Preserve R1-R6 fixes: deadline includes startup, late operations cancelled, late
  subscriptions disposed, exactly-once timeout telemetry, internal-query silence.
- Close/context switch/cancel invalidates results; no cross-profile stale data.
- Reset timestamp displayed with cumulative counters; unavailable timestamp means
  observation window unknown. A manual refresh is not a statistics reset.
- All metric counts show consistent database/server scope and collection freshness.

## Acceptance Tests

- SQL builders: database scope, client-backend filtering, own-backend exclusion for
  workload metrics, no exclusion from capacity counts, bounded/stable blockers.
- Restricted/ordinary roles, missing optional setting, null counters/reset timestamp.
- Counters zero and large values, safe formatting and reset caveats.
- Idle-in-transaction and aborted state; query/transaction/state age distinctions.
- Multiple blockers, duplicate blocker PIDs, PID 0 and hidden/out-of-scope blockers.
- More than 100 sessions: summary not incorrectly computed from truncated UI data.
- Attention navigation opens Sessions without requery; no invented missing-row focus.
- No attention warning based solely on historical temp files; historical deadlocks
  explicitly distinguished from current blocked sessions.
- Preserve cancellation/privacy tests and latest maintenance/partition regressions.
- Light/dark, small viewport, keyboard navigation, no overflow or overlapping text.
- Native ordinary/restricted-role smoke when available; never use production writes
  to create test fixtures. Record unavailability, do not substitute mocks as proof.

## Verification And Handoff

Run focused Vitest for healthInspector SQL/domain/service, useDbHealthInspector,
DbHealthInspectorDialog, query.test.ts and query.review.test.ts. Then npm run build,
full npm run test:run and ESLint on changed TS/TSX files. Record commands/results and
separate unrelated failures using evidence. Codex reviews implementation afterward.
Grok may update completion evidence, not approved scope. No auto-commit/push.

## Completion Evidence

Implemented on branch `feat/inspector-overview-metrics` (working tree only; no commit).

### Delivered (scope 1–6)

1. Idle in transaction: overview SQL counts `idle in transaction%` (includes aborted),
   oldest `xact_start` age and longest `state_change` idle duration; excludes
   `pg_backend_pid()` from workload indicators; restricted visibility nulls these out.
2. Blocking: full-database blocked count + top 5 blocker PIDs (distinct blocked sessions,
   deterministic ties); PID 0 prepared-xact special case; unresolved/out-of-DB limits;
   lock-wait duration explicitly unavailable; Open Sessions action (no re-query).
3. Connections: client-backend counts for current DB and server (includes this app;
   excludes background workers); safe `max_connections` read; tooltip explains scope;
   server usage described as approximate vs configured maximum.
4. Temporary files: `temp_files` / `temp_bytes` with stats-reset caveat (cumulative).
5. Deadlocks: cumulative `deadlocks` with stats-reset; Attention labels as history only.
6. Attention: compact unframed list under overview; actionable blocked / idle-in-xact;
   incomplete visibility instead of “healthy”; Open Sessions reuses snapshot tab switch.

### Files

- Extended: `src/lib/queries/sql/healthInspector.ts`, `src/lib/healthInspector/{types,decode,signals,format}.ts`,
  `src/components/healthInspector/DbHealthInspectorDialog.tsx`, related tests,
  `src/lib/tauri/healthInspector.test.ts` fixtures.
- Created: `src/components/healthInspector/DbHealthInspectorOverview.tsx`.
- Snapshot service statement budget unchanged (still ≤7 / ≤10); no new Tauri/Rust scope.

### Verification (Asia/Saigon, 2026-09-29 ~11:07 +07)

1. Focused Vitest (healthInspector SQL/domain/service, useDbHealthInspector,
   DbHealthInspectorDialog, query.test.ts, query.review.test.ts): **PASS** (68 tests / 9 files).
2. `npm run build` (`tsc && vite build`): **PASS** (pre-existing chunk/externalization warnings only).
3. Full `npm run test:run`: **462 passed / 10 failed / 90 files**.
   Unrelated failures (not in this change set): `styles.theme.test.ts`,
   `AppStatusBar.test.tsx`, `statusBarModel.test.ts`, `tableSidebarNameClass.test.ts`.
4. ESLint on changed TS/TSX health-inspector files: **PASS**.
5. Native PostgreSQL smoke / visual light-dark inspection: **NOT RUN** — no isolated
   live PG fixture / interactive app session in this executor environment.

### O1 fix (restricted client undercount) — 2026-09-29 ~12:26 +07

Tracked `hidden_backend_type_count_{db,server}` separately from visible
`client_backend_count_*`. Incomplete classification surfaces as labelled
visible-only lower bounds (cards + capacity formatting + Attention), not as
complete totals. Mocked fixtures cover other-role hidden backend_type and
hidden sessions only in another database.
Verification: focused PLAN Vitest **PASS** (74 tests / 9 files);
`npm run build` **PASS**. Live restricted-role smoke still not run —
gap noted for Codex re-review. REVIEW.md left at CHANGES REQUIRED.

Re-verified after Fix REVIEW handoff (2026-09-29 ~12:31 +07): same focused
Vitest **PASS** 74/9; `npm run build` **PASS**. No further code edits needed
for O1; awaiting Codex re-review.

Re-verified again on Fix REVIEW poll handoff (2026-09-29 ~12:46 +07 Asia/Saigon):
O1 already present in working tree (no further code edits). Focused PLAN Vitest
**PASS** 74/9; `npm run build` **PASS**. Live restricted-role smoke still not run
(mocked fixtures cover other-DB-only hidden backend_type + cards/capacity).
REVIEW.md left at CHANGES REQUIRED for Codex re-review.

Re-verified on Fix REVIEW handoff (2026-09-29 ~12:53 +07 Asia/Saigon):
O1 already present in working tree (no further code edits). Focused PLAN Vitest
**PASS** 74/9; `npm run build` **PASS**; ESLint on O1-touched TS/TSX **PASS**.
Live restricted-role smoke still not run (mocked fixtures cover other-DB-only
hidden backend_type + cards/capacity formatting + Attention). REVIEW.md left
at CHANGES REQUIRED for Codex re-review.

Re-verified on Fix REVIEW handoff (2026-09-29 ~12:57 +07 Asia/Saigon):
O1 already present in working tree (no further code edits). Focused PLAN Vitest
**PASS** 74/9; `npm run build` **PASS**; ESLint on O1-touched TS/TSX **PASS**.
Live restricted-role smoke still not run (mocked fixtures cover other-DB-only
hidden backend_type + cards/capacity formatting + Attention). REVIEW.md left
at CHANGES REQUIRED for Codex re-review.

Re-verified on Fix REVIEW handoff (2026-09-29 ~13:19 +07 Asia/Saigon):
O1 already present in working tree (no further code edits). Focused PLAN Vitest
**PASS** 74/9; `npm run build` **PASS**; ESLint on O1-touched TS/TSX **PASS**.
Live restricted-role smoke still not run (mocked fixtures cover other-DB-only
hidden backend_type + cards/capacity formatting + Attention). REVIEW.md left
at CHANGES REQUIRED for Codex re-review.

Re-verified on Fix REVIEW handoff (2026-09-29 ~13:23 +07 Asia/Saigon):
O1 already present in working tree (no further code edits). Focused PLAN Vitest
**PASS** 74/9; `npm run build` **PASS**; ESLint on O1-touched TS/TSX **PASS**.
Live restricted-role smoke still not run (mocked fixtures cover other-DB-only
hidden backend_type + cards/capacity formatting + Attention). REVIEW.md left
at CHANGES REQUIRED for Codex re-review.

Re-verified on Fix REVIEW handoff (2026-09-29 ~13:29 +07 Asia/Saigon):
O1 already present in working tree (no further code edits). Focused PLAN Vitest
**PASS** 74/9; `npm run build` **PASS**; ESLint on O1-touched TS/TSX **PASS**.
Live restricted-role smoke still not run (mocked fixtures cover other-DB-only
hidden backend_type + cards/capacity formatting + Attention). REVIEW.md left
at CHANGES REQUIRED for Codex re-review.

Re-verified on Fix REVIEW handoff (2026-09-29 ~13:33 +07 Asia/Saigon):
O1 already present in working tree (no further code edits). Focused PLAN Vitest
**PASS** 74/9; `npm run build` **PASS**; ESLint on O1-touched TS/TSX **PASS**.
Live restricted-role smoke still not run (mocked fixtures cover other-DB-only
hidden backend_type + cards/capacity formatting + Attention). REVIEW.md left
at CHANGES REQUIRED for Codex re-review.

Re-verified on Fix REVIEW handoff (2026-09-29 ~13:43 +07 Asia/Saigon):
O1 already present in working tree (no further code edits). Focused PLAN Vitest
**PASS** 74/9; `npm run build` **PASS**; ESLint on O1-touched TS/TSX **PASS**.
Live restricted-role smoke still not run (mocked fixtures cover other-DB-only
hidden backend_type + cards/capacity formatting + Attention). REVIEW.md left
at CHANGES REQUIRED for Codex re-review.

Re-verified on Fix REVIEW handoff (2026-09-29 ~13:49 +07 Asia/Saigon):
O1 already present in working tree (no further code edits). Focused PLAN Vitest
**PASS** 74/9; `npm run build` **PASS**; ESLint on O1-touched TS/TSX **PASS**.
Live restricted-role smoke still not run — no PG fixture/smoke harness in repo
(mocked fixtures cover other-DB-only hidden backend_type + cards/capacity
formatting + Attention). REVIEW.md left at CHANGES REQUIRED for Codex re-review.

Re-verified on Fix REVIEW handoff (2026-09-29 ~13:59 +07 Asia/Saigon):
Confirmed O1 fix already in working tree on `feat/inspector-overview-metrics`
(no further application-code edits this cycle). Behavior: separate
`hidden_backend_type_count_{db,server}`; cards/capacity use `≥N visible` /
visible-only wording when classification incomplete; Attention + visibility
note fire for other-DB-only hidden sessions even when `restrictedVisibility`
is false. Focused PLAN Vitest **PASS** 74/9; `npm run build` **PASS**;
ESLint on O1-touched TS/TSX **PASS**. Live restricted-role smoke **NOT RUN**:
localhost:5432 connection refused, no docker Postgres container, no repo
smoke harness — mocked fixtures remain the regression coverage. REVIEW.md
left at CHANGES REQUIRED for Codex re-review. No commit/push.
