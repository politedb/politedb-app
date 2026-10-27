# Backup / restore safety review

## Status

CHANGES REQUIRED

Reviewed `main..6f853c31b22f76672db0dace4a6d10adf8152533` on `fix/backup-restore-safety`, against the human-approved batch 1 requirements. No application source changed.

## Findings

### P1 — Revalidate authorization after authentication and before each execution

**Location:** `src/screens/connection/hooks/useDatabaseBackup.ts:858`, `:868`, `:880`, `:900`.

The live-mode check precedes an asynchronous Touch ID dialog. Once authentication resolves, execution proceeds without checking whether the originating tab still exists or has changed to Lock/Production. Reproduced all three cases: start in Safe, change the originating tab to Lock, Production, or remove it while authentication is pending, then resolve authentication successfully. All three dump statements are still dispatched. The same stale authorization persists throughout the loop: locking the tab during the first query still dispatches the remaining writes. A Default-to-Safe transition during execution likewise never triggers authentication. The awaited PostgreSQL constraint lookup adds another gap before a write.

Re-read the originating tab's live mode after authentication and immediately before dispatching each statement, including after any constraint lookup. Stop further dispatches when the tab closes or the mode blocks the remaining work; require authentication if the live mode newly requires it. Preserve partial-progress reporting when stopping after earlier statements. Add deferred-promise regression tests for these transitions on both restore and import. An already dispatched query need not be described as rolled back.

### P1 — The new dump gate treats executable writes as reads

**Location:** `src/lib/dump/dumpRestoreSafety.ts:46` (shared classifier: `src/lib/sql/detect.ts:59`).

`statements.some(isMutatingStatement)` is not a reliable write boundary. The classifier only checks a small set of first keywords, skips executable MySQL comments as ordinary comments, and does not handle nested PostgreSQL block comments. Reproduced dispatch after starting in Default and switching to Lock during confirmation for each of these statements:

```sql
WITH gone AS (DELETE FROM a RETURNING *) SELECT * FROM gone;
/* outer /* inner */ still outer */ DELETE FROM a;
/*!50000 DROP TABLE a */;
SET GLOBAL read_only = OFF;
```

The first two are PostgreSQL writes; the latter two are MySQL/MariaDB operations with database/server effects. They classify as reads, so Lock returns `run`; Production would allow them after read authentication rather than block them. `runSqlQuery` is invoked without a server-side read-only option, so no safety enforcement is added by this path. The early gate only protects tabs already in Lock/Production before the file picker; it does not protect a mode change during confirmation, precisely the scenario the second gate is intended to cover.

These classifier defects predate this branch and also affect the SQL editor; this branch newly relies on that classifier as the restore authorization boundary. Fix the shared classification contract or conservatively reject unproven read statements for restricted-mode dumps. Cover writable CTEs, nested comments, executable comments, and persistent/session `SET` effects without classifying every `SET` identically. Keep ordinary comment, transaction, and dollar-quoted `DO` regression cases.

## Verification

- `npm run build`: **passed**. Warnings: browser externalization of `node:zlib`, ineffective dynamic imports, large chunks, and plugin timings; no build/type-check failure.
- Focused Vitest run covering `src/lib/dump`, both backup hook suites, connection import suites, menu safety picker, and `useSqlRunner`: **10 files, 93 tests passed**.
- Adjacent statement-splitting and query-safety suites: **2 files, 20 tests passed**.
- Temporary reviewer probes: **21 tests passed**, comprising the existing 9 restore/backup cases plus 12 probes that assert the observed bypasses and the correctly blocked ordinary-comment/transaction/DO cases. These passing probes reproduce defects; they are not evidence of correct authorization. Temporary test/config files removed after execution.
- Read all 9 changed files and traced execution through the SQL splitter/classifier, SQL runner, runtime context, native dialog/auth wrappers, query dispatch, table import callbacks, sidebar routing, and cache helper.
- Confirmed backup capability is restricted to PostgreSQL/MySQL/MariaDB in both the hook and menu. Confirmation uses `confirmDialog`, includes filename, connection/database for menu restore, statement count, and non-transactional/irreversible wording. Skipped statements use an informational count; statement execution failures include the number of earlier successful calls.
- Originating tab ID and connection are captured by the running callback; merely switching the active tab does not retarget that invocation. Closing the tab before confirmation resolves is blocked. Closing it during authentication is covered by finding 1.
- Table-tab imports retain `confirmRowsChange()` before file selection and reload on successful completion. Sidebar routing still sends open/dirty tables through their table tab; successful standalone imports invalidate only the originating table cache and preserve newly opened/dirty tables. Existing behavior remains: partial execution failure skips schema/table refresh and the import callback, leaving caches stale until refreshed; this was already present on `main`.
- Test gaps: committed tests do not exercise changes during Touch ID or between queries, hook-level tab closure/switching, the classifier cases above, or an integrated dirty-table/sidebar import. The menu test mocks `canBackupDatabase` as always true, so it does not verify unsupported-engine disabling/tooltip behavior.
- Limitations: no live database writes, native dialog/Touch ID interaction, or desktop UI session exercised. Query dispatch and dialog races were reproduced with mocks; backend SQL effects were assessed statically. No Rust files changed, so Rust checks were not run. No commit created; unrelated `.claude/launch.json` left untouched.


## Re-review (round 2)

**Status: CHANGES REQUIRED.** Reviewed `6f853c3..b21d19f` on `fix/backup-restore-safety` (2026-10-27). Checkout HEAD is `e7dbc32`; its only change after `b21d19f` is this review document, so the tested application code matches the requested commit. Both original dump findings are resolved. Shared classifier hardening still has consequential false negatives and introduces false positives in the SQL editor.

### Original findings

- **P1 authorization race — resolved for dump restore/import.** `src/screens/connection/hooks/useDatabaseBackup.ts:860` loops back to the originating tab's live safety mode after Touch ID, checks blocked modes before using the run-scoped authentication flag, and checks again at `:913` after the awaited PostgreSQL constraint lookup. Default-to-Safe transitions request authentication once per run. A tab switch does not retarget the captured tab/connection. Deferred reviewer tests confirmed closure/Lock/Production during authentication dispatch no dump statements, and Lock during a pending constraint lookup prevents the following ALTER. Mid-run restriction changes stop further writes; `:947` reports earlier progress and refreshes schema plus the supplied callback when statements already ran. Already dispatched queries are not canceled or rolled back, as required. No remaining user-interaction race found in this dump write dispatch path.
- **P1 classifier-dependent dump gate — resolved.** `src/lib/dump/dumpRestoreSafety.ts:46` rejects Lock and `:52` rejects Production for the entire dump, independently of statement text. This protects both restore and table SQL imports even for SQL that the shared classifier misses. Safe still requires Touch ID, Default still runs after confirmation.

### Findings requiring changes

#### P1 — Shared classifier still permits write forms covered by the hardening scope

**Locations:** `src/lib/sql/detect.ts:64`, `:121`; callers `src/screens/connection/hooks/useSqlRunner.ts:651`, `:671`.

These all return `false` from `isMutatingStatement`:

```sql
WITH t AS (SELECT 1 AS id) SELECT * INTO backup_a FROM t;
SET /* comment */ GLOBAL read_only = OFF;
SET @@global /* comment */ .read_only = OFF;
```

The WITH branch returns based only on DML keywords, so it never checks the outer SELECT INTO that creates a PostgreSQL table. The SET expression requires adjacent whitespace/dot spelling and does not account for comments between tokens. The editor's Lock/Production checks therefore accept these as reads; Production requests read authentication instead of refusing the write. Reviewer hook probes confirmed the first query reaches `onRunSql` in both modes (with authentication mocked successful for Production). Backend validation is invoked, but its request at `src/lib/tauri/queryValidate.ts:160` has no safety-mode/read-only enforcement; syntax validation is not authorization.

These false negatives existed before this commit; they are remaining gaps in the explicitly requested shared-classifier hardening, not newly introduced dump bypasses. Normalize SQL tokens/comments before recognizing server settings, and inspect the final statement following a WITH prefix for SELECT INTO as well as writable CTE bodies. Add classifier and Lock/Production runner regression cases. The dump gate itself remains protected by its unconditional refusal.

#### P2 — New keyword scans block valid read-only SQL inside comments and dollar quotes

**Locations:** `src/lib/sql/detect.ts:68`, `:119`, `:121`, `:123`.

All three now return `true`, although they were reads before this commit:

```sql
SELECT $$into$$;
SELECT 1 /* INTO */;
WITH t AS (SELECT 1 /* DELETE */) SELECT * FROM t;
```

`withoutQuoted` excludes neither PostgreSQL dollar-quoted strings nor inline comments. The new whole-text keyword scans interpret their contents as executable syntax. Reviewer hook probes confirmed all three are rejected in Lock before dispatch; Production uses the same classifier. This regresses ordinary read workflows and contradicts the intended preservation of quoted-keyword reads. Scan executable tokens with dollar-quote and inline/nested-comment handling, while preserving executable MySQL/MariaDB comments as code. Add these read cases alongside the write cases above.

### SQL editor / AI agent assessment

- SQL editor intentionally becomes stricter in Lock/Production for recognized writable CTEs, executable leading comments, global settings, permissions, maintenance and bulk/file operations. Default/Safe classification does not block execution; Safe authentication remains unchanged. Plain session SET and ordinary quoted identifiers/string keywords in committed tests remain reads. The P2 cases above are unintended additional blocking.
- `src/lib/ai-assistant/agent.ts:239` returns `read_only` only when its separate frontend heuristic and backend check agree, **before** consulting this classifier at `:245`. Consequently this change primarily relabels previously `unknown` previews as `mutating`; both offer Insert rather than Run. It does not add a new agent execution gate or automatically block backend-approved reads. Agent tool execution retains its separate backend SQL guard and read-only sessions (`src-tauri/src/ai/agent/query_guard.rs:66`, `data/mod.rs:3`). No new AI execution bypass found from this diff. Do not infer the SQL editor's classifier failures bypass those independent agent guards.
- Existing adjacent limitation, unchanged by this diff: `src/screens/connection/hooks/useSqlRunner.ts:644` snapshots safety before Touch ID, and `:710` dispatches the script without live safety revalidation between statements. The new dump checks do not fix this SQL editor race. Likewise ordinary dump execution errors still bypass partial schema refresh (`useDatabaseBackup.ts:941`, `:970`); this round adds refresh specifically for authorization stops.

### Verification and test quality

- `npm run build`: **passed**, including TypeScript. Existing warnings: browser externalization of `node:zlib`, ineffective dynamic imports, large chunks and plugin timings.
- Focused Vitest: **11 files, 202 tests passed**. Covered `detect`, both dump suites, both backup hook suites, SQL runner sequential/Explain Analyze, agent and assistant-submit agent suites, SQL lexer, and analyze classification.
- Temporary reviewer suites: **2 files, 40 tests passed**, comprising 29 copied baseline cases plus 11 additional cases. Six verify deferred authentication/constraint races and partial restore/import refresh callbacks; five assert the observed SQL runner false negative/false positives above. Passing reproduction assertions demonstrate defects, not correct authorization. Initial Production probe lacked a native-auth mock; corrected the harness and reran successfully. Direct classifier probes also reproduced both commented SET forms. All temporary fixtures/config removed.
- Committed tests now cover the original authentication transitions, a mid-run lock, Safe authentication once per run, and import refusal. However, `src/screens/connection/hooks/useDatabaseBackup.restore.test.ts:175` checks partial-stop messages without asserting schema refresh/callback behavior; no committed deferred constraint-lookup case exists. Preserve the reviewer-proven behavior with these focused regressions. Classifier tests need WITH-prefixed SELECT INTO, inter-token comments, dollar quotes and keyword-bearing inline comments.
- No live database writes, native Touch ID/dialog interaction, or desktop UI session exercised. Dispatch behavior verified with mocks; database effects assessed from SQL/source. No Rust changes/checks. Only this review document retained as a change; unrelated `.claude/launch.json` preserved. No source edits or commit.
