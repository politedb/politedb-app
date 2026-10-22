# Health Inspector: Cancel query / Terminate session

## Status

DRAFT

## Task

- ID: health-inspector-session-actions
- Requested 2026-10-22 as part of Health Inspector batch 3 (review item 14): let users stop a runaway query or a stuck session from the Sessions tab.
- The rest of batch 3 (sorting, search, tab badges, copy-only VACUUM/DROP INDEX, auto-refresh) and batch 4 (new metrics) are read-only and implemented separately; this plan covers only the two actions that act on other backends.
- Branch: `feat/connection-form-polish` (current Health Inspector work), unless the human picks another.
- Concurrent plan file (PLAN.md holds the approved Mac App Store plan), per WORKFLOW "Parallel work".

## Goal And Visible Result

- Each row in Health Inspector → Sessions gets a row action menu with **Cancel query** and **Terminate session**.
- Both ask for confirmation that names the session (PID, user, application, state, query age, start of the query text) and say what happens:
  - Cancel: the current statement stops; the session stays connected; an open transaction is rolled back only if the client does so.
  - Terminate: the connection is closed; any open transaction is rolled back.
- After the action the Sessions tab refreshes and a short result line says whether PostgreSQL accepted the signal ("Cancel sent to PID 4242" / "PID 4242 is no longer running" / the permission error).

## Current Behavior And Invariants

- The Inspector is read-only: every query runs through `runSqlQuery` with `readOnly: true`, a 1 s `lock_timeout` and a per-query `statement_timeout` (`src/lib/tauri/health-inspector.ts`). This must stay true for collection.
- Sessions come from `pg_stat_activity` limited to `current_database()`; the Inspector's own backend is part of the list (`pg_backend_pid()` differs per pooled connection).
- Pro-only: the whole dialog is gated (`useProGate`, `useDbHealthInspector` rechecks access).
- `pg_cancel_backend` / `pg_terminate_backend` are allowed inside a read-only transaction (verified on PG16: `SET TRANSACTION READ ONLY; SELECT pg_cancel_backend(...)` returns normally), so the existing read-only query path can carry them.
- Required privileges (PostgreSQL docs): the caller must be superuser, have the same role as the target backend, or be a member of `pg_signal_backend`; superuser backends can only be signalled by superusers. Otherwise the function raises an error (SQLSTATE 42501). Returns false (with a warning) when the PID is not a backend.

## Proposed Design

1. **SQL builders** (`src/lib/queries/sql/health-inspector.ts`): `healthInspectorSignalBackendSql(kind: "cancel" | "terminate")` with the PID and `backend_start` passed as validated numbers/ISO text, never interpolated from free text:
   ```sql
   SELECT pg_catalog.pg_cancel_backend(a.pid) AS signalled
   FROM pg_catalog.pg_stat_activity a
   WHERE a.pid = <int>
     AND a.backend_start = '<timestamptz>'::timestamptz
     AND a.datname = current_database()
     AND a.pid <> pg_catalog.pg_backend_pid()
   ```
   - `backend_start` match guards against PID reuse between snapshot and click. Zero rows = "no longer running".
   - Sessions SQL gains `backend_start` (and decode/type field `backendStart`).
   - PID must be a positive safe integer; `backend_start` must parse as a date and is re-serialized with `toISOString()` before use. Builders reject anything else.
2. **Runner** (`src/lib/tauri/health-inspector.ts`): `signalHealthInspectorBackend({ runtimeConnectionId, pid, backendStart, kind })` uses `runSqlQuery` with the same read-only/lock/statement timeouts (5 s), returns `"signalled" | "not_running" | "refused"` plus a sanitized error. No retries.
3. **UI** (`DbHealthInspectorDialog.tsx` Sessions tab): an actions column with a small menu button per row (existing `MenuPopover`). Hidden for: PID 0 / prepared-transaction rows, rows without `backendStart`, non-client backends (`backend_type <> 'client backend'`: autovacuum, walsender, background workers), and the Inspector's own connection if detectable.
   - Confirmation: `confirmDialog` (native) with `kind: "warning"`; Terminate uses a destructive-styled title "Terminate session 4242?". Confirmation text never includes the full query (first 120 chars, single line).
   - While a signal is in flight the row's menu is disabled; the dialog's Cancel button does not abort a sent signal.
   - After completion: re-collect only Sessions + Overview (or the full snapshot if simpler; TBD D4).
4. **Gating and privacy**: Pro-only like the rest of the dialog; re-check `hasProAccessNow()` at click time. No analytics events carry PID, user, application or query text; at most `health_inspector_session_action` with `{ kind, outcome }` (TBD D5).

## Decisions (TBD — human)

- **D1** Scope: both Cancel query and Terminate session, or Cancel only for the first release? (Recommendation: both; Terminate is what clears an idle-in-transaction blocker.)
- **D2** Confirmation: native `confirmDialog` for both (recommended), or in-app dialog with a typed confirmation for Terminate?
- **D3** Connection profiles marked as production/read-only, if such a flag exists or is planned: disable the actions there? (No such flag exists in the app today.)
- **D4** After the action: refresh the whole snapshot (simple, ~7 queries) or only Sessions + Overview?
- **D5** Analytics: no event at all, or `{ kind, outcome }` only?
- **D6** Bulk actions ("Terminate all idle in transaction > 10 min"): out of scope for this plan? (Recommendation: out of scope.)

## Files

- `src/lib/queries/sql/health-inspector.ts` (+ test): sessions `backend_start`, signal builder and input validation.
- `src/lib/health-inspector/types.ts`, `decode.ts` (+ test): `backendStart`, `backendType` already present.
- `src/lib/tauri/health-inspector.ts` (+ test): `signalHealthInspectorBackend`.
- `src/components/health-inspector/DbHealthInspectorDialog.tsx`, new `SessionActions.tsx` (+ tests).
- No Rust changes expected (existing read-only query path).

## Verification

- Unit: builder rejects bad PID/backend_start; SQL contains the `backend_start`, `current_database()` and `pg_backend_pid()` guards; runner maps true/false/zero rows/42501 to outcomes; UI hides actions for non-client and PID 0 rows, asks for confirmation, does nothing on cancel, shows the outcome, refreshes after.
- Live (smoke Postgres container only, never customer DBs): cancel a `pg_sleep(30)` session from another role-less connection; terminate an idle-in-transaction session; reused PID with different `backend_start` is not signalled; non-privileged role gets the permission message.
- `npm run build`, focused Vitest, Codex review, then `/security-review` (destructive DB action per WORKFLOW step 8).

## Risks

- Signalling the wrong backend after PID reuse — mitigated by `backend_start` match.
- Terminating replication/background processes — limited to `client backend` rows.
- Users without privileges see an error after confirming — consider hiding actions when the row's `usename` differs from the current role and the role lacks `pg_signal_backend` (needs one extra capability query; TBD in review).
- Accidental clicks — native confirmation, no keyboard shortcut, no bulk action.


## Plan Review

Reviewed by Codex, 2026-10-22. **Revise before approval.** Planning review only; no signals sent, application changes made, or live database tests run. P1 = safety/correctness blocker; P2 = required contract or verification clarification. Status remains DRAFT.

1. **[P1] Preserve microseconds in the backend identity token.** Proposed Design 1 converts `backend_start` through JavaScript `Date.toISOString()`, which retains milliseconds only. PostgreSQL timestamps have microsecond resolution; e.g. `.123456+00:00` becomes `.123Z`, so a live target fails equality and is incorrectly reported gone. `src-tauri/src/engines/postgres/row_codec.rs:131` already returns RFC3339 text with fractional precision. Preserve that exact string through `HealthSessionRow`/decode/action; validate an explicitly timezone-qualified, finite RFC3339 timestamp with up to six fractional digits without normalizing through `Date`. Alternatively return a server-generated UTC microsecond text token. Never truncate the database side to milliseconds to make equality pass. Test zero/three/six fractional digits, `Z`, nonzero offsets, missing timezone, invalid dates and non-UTC server TimeZone/DateStyle. See [PostgreSQL timestamp resolution](https://www.postgresql.org/docs/16/datatype-datetime.html).

2. **[P1] Move backend-type eligibility into the action SQL; UI hiding is insufficient.** Proposed SQL checks current database and executing backend PID, but omits `a.backend_type = 'client backend'` despite claiming background/replication protection. Enforce it in the final server query, fail closed on missing identity/type, and retain same-database and self predicates. Validate PID as an integer in PostgreSQL int4 range `1..2147483647`, not merely a JS safe integer. Use a closed runtime allowlist for `kind`, hardcoded catalog-qualified functions, and strict timestamp token validation/quoting (or bound parameters through a narrow native command). Current `runSqlQuery` carries SQL text, not bind values; preserving raw timestamp precision must not reintroduce arbitrary string interpolation. Test quote/comment/semicolon/backslash payloads, unknown action kinds, out-of-range PIDs, other-database and non-client targets by calling the runner directly, not only through UI.

3. **[P1] Define pool ownership policy; `pg_backend_pid()` excludes only the sender.** `src-tauri/src/engines/postgres/operation.rs:93-107` obtains a pooled client for each operation. A PID marked “own” during collection need not be the client later sending the action. Other idle or busy clients belonging to this app/runtime remain valid targets; terminating one can break editor work, exports or concurrent Inspector collection. “If detectable” leaves the safety contract unresolved. Decide explicitly whether app-owned sessions may be targeted. If excluded, identify all relevant pool sessions authoritatively at the backend boundary (not by mutable/spoofable application name); if allowed, give an explicit warning and verify failure/recovery of affected operations and pool recycling. Do not imply the single self predicate protects the whole runtime. Add this decision before asserting no Rust changes are needed. Include pool exhaustion and target-is-an-app-client cases in verification.

4. **[P1] PID/start matching mitigates stale snapshots but is not atomic signalling.** PostgreSQL functions take only PID. The row can disappear after activity evaluation and before the function resolves/signals that PID; a new session could have different database/type/owner. Even PostgreSQL's own implementation documents a residual PID reuse race. Keep same-statement identity predicates, no precheck-then-unconditional-signal sequence, no retries after uncertain execution, and state this limitation in Risks. Decide whether this residual risk is acceptable; if strict identity guarantees are required, the stock PID-only API cannot promise them. A stale-start test proves rejection of an already changed identity, not freedom from this race. See [PostgreSQL signalling implementation](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/storage/ipc/signalfuncs.c).

5. **[P1] Cancel can affect a different statement on the same backend.** `backend_start` identifies a session, not its current query. During native confirmation, the displayed query can finish and the backend can start unrelated work; Cancel then targets that work. Decide whether Cancel means “whatever is running now” (confirmation must say so) or the displayed statement (carry exact `query_start`, require active state and matching timestamp in action SQL, and return target-changed on mismatch). Disable Cancel for known idle sessions; Terminate is the separate remedy for idle-in-transaction sessions. Explain that cancellation can abort the current transaction until rollback/savepoint recovery; it does not reliably release all transaction locks or disconnect the client. Query-start matching still has a check-to-signal race; do not promise exact-statement cancellation.

6. **[P1] Revalidate authorization and context after confirmation; lock before confirmation.** A click-time `hasProAccessNow()` check can become stale while awaiting the native dialog. Capture immutable profile/runtime/engine/database context and PID/start identity, acquire a pending lock before opening confirmation (rapid clicks otherwise open multiple dialogs), then re-check current context, open state, PostgreSQL support and Pro immediately before dispatch. Abort unsent work on close/disconnect/context switch/downgrade; never redirect an old target to a new runtime. Define serialization across rows, not only a per-row in-flight flag. Once dispatch begins, close/Cancel/timeout cannot undo the external signal. Put orchestration behind a focused hook/service and test downgrade/context changes while confirmation is open. Pro is a product gate; PostgreSQL remains the privilege authority.

7. **[P2] Specify error transport and distinct outcomes; existing Rust formatting loses SQLSTATE.** `format_pg_error` (`operation.rs:501`) emits severity/message/detail/hint and optional SQL position, but not a structured `42501`; `runSqlQuery` then creates a plain `Error`. The proposed reliable SQLSTATE mapping therefore has no current transport contract. Either add a narrow typed error path and corresponding Rust files/checks, or document and test a conservative generic permission message without pretending localized text gives reliable SQLSTATE classification. Role membership matters, not just username equality; `pg_monitor`/`pg_read_all_stats` visibility is not signal authority, and `pg_signal_backend` does not authorize superuser targets. Server permission checks must remain authoritative, including EXECUTE revocation and privilege changes after collection. If capability UI is added, use role membership/superuser status and fail closed on unknown capability without granting privileges automatically.

   Define `true` as **signal sent**, not query stopped/session gone; one-argument Terminate does not wait for exit. `false` means signal failed, not necessarily permission denied or no longer running. Zero rows means **target no longer matches or is ineligible**, not proof the PID disappeared (self/type/database/start guards also cause zero rows). Null/malformed/multiple rows are errors, never success. Timeout, transport loss, abort or commit failure after dispatch can mean **outcome unknown**: the signal is not undone by transaction rollback. No automatic retry; refresh for reconciliation. Use fixed, privacy-safe messages for these categories. See [PostgreSQL signalling privileges and return values](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADMIN-SIGNAL).

8. **[P2] Make query-path reuse constraints explicit and regression-tested.** Existing PostgreSQL runner applies transaction read-only, `SET LOCAL statement_timeout`, `SET LOCAL lock_timeout`, then prepares/executes/commits; collection must retain its existing limits. Read-only does not make signalling reversible or harmless. Action calls must set `internal: true`, `readOnly: true`, explicit client/server deadlines and small result limits, and use direct mode. `runSqlQuery` always calls `operationExecuteWithBusyRetry`, which can cancel another busy operation and retry. Current `operations/dispatcher.rs:65-93` takes the busy slot only for streams, so direct mode currently avoids that path; lock this invariant down with tests or introduce an explicit no-retry/no-holder-cancel policy for actions. Do not claim “No retries” without accounting for the shared helper. Test server timeout/57014, client timeout before/after execute, late IPC, pool wait, commit failure and transaction-local settings not leaking onto the next pool borrower. Retain external-cancel errors on the target operation rather than reporting a successful completed result.

9. **[P2] Complete confirmation and accessibility contracts.** `MenuPopover.tsx` supplies outside-click/Escape handling but no initial focus, focus return, menu semantics or arrow navigation. Use an accessible button/popover pattern with named trigger, expanded/control attributes, keyboard access, safe Escape behavior inside the parent modal, and focus restoration when the row disappears. If ARIA menu roles are used, implement their full keyboard contract. Announce pending/result/error through an appropriate live region. `confirmDialog` is a native wrapper (`src/lib/system-dialog/index.ts:84`); a title string cannot guarantee destructive styling or a safe default button. Specify action-labelled confirm/cancel buttons, cancellation on dismissal/error, OS verification of default focus/Enter/Escape, and browser fallback coverage (object title options are not rendered by that fallback). Include database context and immutable target details; normalize control characters and cap user/application fields as well as query preview. Respect `queryHidden`; never reveal hidden text. Treat Cancel-query wording separately from dialog Cancel. Typed confirmation is a product choice, not a substitute for identity checks.

10. **[P2] Integrate refresh/action races with the authoritative snapshot owner.** `useDbHealthInspector.ts` owns context clearing, collection cancellation and generation-based progress suppression. It is missing from Files despite new action orchestration/partial-refresh requirements. Resolve D4: full refresh through that hook is the smallest existing path; partial refresh needs one authoritative merge with section timestamps and generation control. Invalidate pre-action collection so late progress cannot overwrite newer results; coordinate manual/auto refresh and actions. Key pending state by runtime + PID + backend start, not row index/PID alone. After success or unknown outcome refresh only the original still-current context; do not let refresh failure overwrite signal outcome or label a still-visible asynchronously terminating session as a failed signal. Test row reorder/filter/removal, rapid actions, stale progress after action, close/reopen and profile/runtime changes. Define whether subsequent attempts require a fresh snapshot.

11. **[P2] Privacy and verification need end-to-end evidence.** Keep D5 explicit; recommendation: no new event initially. If enabled, restrict `kind`/`outcome` to fixed enums and preserve existing opt-in `trackEvent` behavior. Always use `internal: true`: `query.ts` otherwise sends SQL length and raw error excerpts to telemetry. `sanitizeHealthError` is a display filter, not a privacy allowlist: it preserves severity/DETAIL/HINT and can retain short quoted identifiers. Do not log/track raw errors, generated SQL, PID/start/query/user/application/database/runtime identifiers or confirmation bodies. Test telemetry spies on success, permission failures, malformed results and timeouts, including consent off, and inspect backend logging/error emission paths.

    Expand verification beyond SQL substring assertions: disposable PG16 plus the minimum supported PostgreSQL version; exact microsecond timestamp round-trip; same-role and member-role success; unrelated role denial; `pg_signal_backend` success against ordinary targets and denial against superuser targets; visibility-only role; hidden/null identity fields; revoked function EXECUTE; real client/backend-type/database/self guards; false/zero/null results; successful signal followed by uncertain result; concurrent collection/editor/export operations; pool reconnection and settings cleanup. Clarify “another role-less connection” (every PostgreSQL session has a role): name same-role and distinct unprivileged-role cases. Verify the cancelled client receives cancellation, terminated client disconnects and its transaction rolls back, with only fixture data. Add focused hook/runner/component tests, `npm run build`, native UI keyboard/screen-reader smoke checks, and relevant Rust checks/tests if transport or ownership work changes Rust. Record tests unavailable locally as limitations. Resolve D1–D6 and the ownership/query-target semantics above before approval; retain independent Codex implementation review followed by the workflow's security-review pass.
