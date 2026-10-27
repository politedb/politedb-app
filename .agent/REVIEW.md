# Backup / restore safety review

## Status

VERIFIED WITH LIMITATIONS

Latest review: **round 14**, `9e57536..6f95c52`; round 13 P1 resolved. No regression or remaining PostgreSQL 17 continuation-whitespace mismatch found in this scoped review. Build and 481 relevant tests passed. No live PostgreSQL or desktop/native verification; earlier documented limitations remain. See appended review.

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


## Re-review (round 3)

**Status: CHANGES REQUIRED.** Reviewed `b21d19f..95674cf` on `fix/backup-restore-safety` (2026-10-27). HEAD `8fc2606` differs from `95674cf` only in review documentation; application source matches the requested fix. No application source modified.

### Round 2 findings and test fixes

- **P1 named reproductions resolved:** WITH-prefixed SELECT INTO, commented SET GLOBAL, commented @@global, and GLOBAL later in a SET list now classify as writes. Reviewer runner tests confirm all four are blocked in both Lock and Production.
- **P2 named reproductions resolved:** `SELECT $$into$$`, `SELECT 1 /* INTO */`, and a read-only WITH containing a DELETE comment now classify as reads and reach dispatch in both modes. Executable MySQL/MariaDB comments remain writes. However, additional false negatives and false positives below prevent closing either classifier finding as fully resolved.
- **Partial authorization-stop refresh regression covered:** `src/screens/connection/hooks/useDatabaseBackup.restore.test.ts:179` now asserts one query dispatched, schema refresh once, callback once, and partial-progress wording. The new test at `:243` asserts no refresh/callback if authorization stops before any dispatch. Both pass. Deferred constraint-lookup and table-import callback regression coverage remain absent; no new defect in those unchanged implementations was identified in this round.

### P1 — Dialect-specific line comments hide executable writes

**Locations:** `src/lib/sql/detect.ts:89`, `:174`; consumers `src/screens/connection/hooks/useSqlRunner.ts:651`, `:671`.

Every lexer reading treats `#` and every `--` as a line comment. PostgreSQL uses `#` for XOR and JSON operators; MySQL requires whitespace/control after the second dash for a comment. Consequently these executable writes return `false`:

```sql
-- PostgreSQL: each creates a table, or deletes rows.
SELECT 1 # 2 INTO backup_x;
SELECT '{"a":1}'::jsonb #>> '{a}' INTO backup_json;
WITH t AS (SELECT 1 # 2) DELETE FROM a;
-- MySQL: subtracting negative one, then writing a file.
SELECT 1--1 INTO OUTFILE '/tmp/reviewer-probe';
```

Reviewer hook probes confirm all four pass client validation and reach `onRunSql` in **both Lock and Production**, with Production authentication mocked successful. Backend syntax validation is mocked in these probes; its real request (`src/lib/tauri/queryValidate.ts:160`) supplies no safety/read-only enforcement. The unconditional dump refusal remains unaffected.

The PostgreSQL `#` cases regress from `b21d19f`, whose keyword scan retained inline operators; the MySQL dash case is a remaining earlier gap. Extend dialect readings to line-comment rules too, preserving operator tokens in the PostgreSQL/MySQL arithmetic reading. Add classifier and runner regressions for operators before INTO and before writable CTE/final DML. Syntax basis: [PostgreSQL math operators](https://www.postgresql.org/docs/current/functions-math.html), [JSON operators](https://www.postgresql.org/docs/current/functions-json.html), [MySQL comments](https://dev.mysql.com/doc/refman/8.4/en/comments.html).

### P2 — The no-escape reading exposes keywords inside explicit escape strings

**Locations:** `src/lib/sql/detect.ts:112`, `:115`, `:175`.

```sql
SELECT E'it\'s INTO text';
```

This valid PostgreSQL read returns `true` and is blocked before dispatch in both Lock and Production. The no-backslash reading closes the string at the escaped quote and sees INTO as executable text; the valid escape-aware reading cannot override that result. Recognize explicit `E'…'` strings and always apply their escape rules rather than considering an invalid alternate interpretation. Add escaped-quote/keyword read regressions. [PostgreSQL escape-string rules](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-STRINGS-ESCAPE) explicitly require backslash handling for E strings. This false positive remains despite the quoted-text rewrite; do not treat all dialect unions as valid readings for every token.

### P2 — JavaScript word boundaries split valid SQL identifiers at dollar signs

**Locations:** `src/lib/sql/detect.ts:67`, `:68`, `:161`, `:164`.

```sql
SELECT cost$into FROM a;
WITH t AS (SELECT cost$delete FROM a) SELECT * FROM t;
```

Both return `true` and are blocked in both restricted modes. These are valid unquoted PostgreSQL identifiers, not INTO/DELETE tokens. The dollar-quote guard at `:133` avoids stripping an identifier as a string, but the subsequent `\b` regexes still split it at `$`. Match complete SQL identifier/keyword tokens (including dollar signs and supported non-ASCII identifier characters), then compare keyword tokens. Add these reads alongside actual INTO/DELETE write cases. [PostgreSQL identifier rules](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS) permit dollar signs after the first character. This is a remaining classifier gap, not a newly introduced dollar-quote bypass.

### Additional preexisting P1 limitation — typed EXPLAIN ANALYZE writes bypass the editor gate

**Locations:** `src/lib/sql/detect.ts:148`, `:165`; `src/screens/connection/hooks/useSqlRunner.ts:651`, `:671`.

`EXPLAIN ANALYZE DELETE FROM a;` returns `false` and reaches `onRunSql` in both restricted modes in reviewer probes. `codeIsWrite` has no EXPLAIN handling and defaults to read. PostgreSQL [executes the underlying statement when ANALYZE is enabled](https://www.postgresql.org/docs/current/sql-explain.html); this can delete rows. This predates the reviewed fix and is separate from the dedicated Explain Analyze UI's guards: typing SQL and pressing Run uses `startRun`. Track/fix explicit ANALYZE options and classify the underlying statement, retaining ordinary EXPLAIN and `ANALYZE FALSE` as non-executing plans. Not attributed as a regression of `95674cf`; included because this review explicitly probes remaining SQL editor false negatives.

### Verification and limits

- `npm run build`: **passed**, TypeScript plus production Vite build. Existing warnings: `node:zlib` browser externalization, ineffective dynamic imports, large chunks, plugin timings.
- Focused committed Vitest suites: **13 files / 232 tests passed** across two runs. Includes classifier, both dump suites, both backup hook suites, sequential SQL runner, Explain Analyze runner, SQL splitter, analyze classifier, query safety, SQL history runner, agent and assistant-submit agent coverage.
- Temporary reviewer suite: **60 tests passed**. Includes all seven round 2 reproductions directly and through both restricted runner modes; executable comments; four comment/operator write bypasses; three read false positives; typed EXPLAIN ANALYZE; ordinary XOR/JSON reads, dollar quotes/identifiers, and unterminated single/double/dollar strings plus block/line comments. Reproduction assertions intentionally expect the observed defects; passing does **not** validate their authorization behavior. Temporary suite removed after execution.
- Ordinary tested XOR/JSON reads return false; the operator problem is hidden writes later on the same line. Unterminated quoted/comment tails containing write keywords return false without crashing; malformed SQL remains the backend validator's responsibility. No claim that malformed SQL is valid or that heuristic classification is a complete database write boundary (e.g. side effects in called functions).
- Committed classifier tests cover the previous named failures but lack E escape strings, dollar-sign keyword substrings, PostgreSQL operator-before-write cases, MySQL non-comment dashes, and typed EXPLAIN ANALYZE. Restore refresh assertions address the requested partial-stop gap.
- No live database execution, native Touch ID/dialog session, or desktop UI exercised. Dispatch tested with mocks; SQL semantics checked against official documentation. No Rust changes/checks. SQL editor's previously documented live-mode/authentication race remains outside this fix. Only `.agent/REVIEW.md` retained as a change; unrelated `.claude/launch.json` preserved. No source edits, commit, push or merge.


## Re-review (round 4)

**Status: CHANGES REQUIRED.** Reviewed `95674cf..daa4912` on `fix/backup-restore-safety` (2026-10-27). HEAD `fbbca6c` differs from `daa4912` only in this review document; tested application code matches the requested fix. Scope follows the human agreement: preexisting heuristic gaps belong to the separate SQL-editor server-side read-only enforcement task, not new blockers here.

### Round 3 disposition

- **P1 dialect-specific line comments — resolved for all four reported writes.** PostgreSQL XOR/JSON operators before INTO, XOR in a CTE before final DELETE, and MySQL non-comment `--1` before INTO OUTFILE now return true (`src/lib/sql/detect.ts:109`, `:113`, `:225`). Committed cases: `src/lib/sql/detect.test.ts:34`–`:38`.
- **P2 explicit escape strings — resolved.** `SELECT E'it\'s INTO text';` now returns false, with PostgreSQL E-string escape handling at `src/lib/sql/detect.ts:137`; regression at `src/lib/sql/detect.test.ts:82`.
- **P2 dollar-sign identifiers — resolved for reported cases.** `cost$into` and `cost$delete` remain whole tokens (`src/lib/sql/detect.ts:67`); both return false. A reviewer probe also checks a non-ASCII identifier prefix. Committed cases: `src/lib/sql/detect.test.ts:84`–`:85`.
- **Additional preexisting EXPLAIN ANALYZE limitation — improved.** Keyword and parenthesized ANALYZE writes now return true (`src/lib/sql/detect.ts:178`, `:211`). Reviewer probes confirm OFF/0/FALSE remain non-executing, ON/1/TRUE execute classification, writable CTE and SELECT INTO explanations count as writes, and an analyzed ordinary SELECT remains a read. This does not establish a complete SQL write boundary.

### P2 — MySQL reading exposes PostgreSQL dollar-string contents

**Locations:** `src/lib/sql/detect.ts:162`, `:225`–`:228`; consumers `src/screens/connection/hooks/useSqlRunner.ts:651`, `:671`.

These ordinary PostgreSQL reads returned false at `95674cf`, but return true at `daa4912`:

```sql
SELECT $$ put into box $$;
SELECT $tag$ put INTO box $tag$;
WITH t AS (SELECT $$ delete from a $$ AS txt) SELECT * FROM t;
SELECT $$ /*! text */ $$;
```

Dollar quoting is now stripped only by the PostgreSQL reading. The MySQL reading sees standalone INTO/DELETE or an executable-comment opener inside the string; its true result overrides the correct PostgreSQL result. Lock/Production consequently reject these reads through the unchanged classifier gates. Preserve valid PostgreSQL dollar-string reads when combining readings, preferably by using the connection's dialect rather than letting an incompatible reading override it. Add classifier regressions for all examples and restricted-runner coverage.

### P2 — Alternate line-comment readings block ordinary commented reads

**Locations:** `src/lib/sql/detect.ts:109`, `:113`, `:225`–`:228`; consumers `src/screens/connection/hooks/useSqlRunner.ts:651`, `:671`.

Both returned false at `95674cf`, but return true at `daa4912`:

```sql
-- Valid PostgreSQL read: no space is required after the dashes.
SELECT 1 --note INTO backup
;
-- Valid MySQL read: hash starts a comment.
SELECT 1 # note INTO backup
;
```

The MySQL reading exposes INTO in the PostgreSQL comment; the PostgreSQL reading exposes INTO in the MySQL comment. Both valid reads are now blocked in restricted modes. Retain the round 3 operator/write fixes while applying the actual engine's line-comment rules (or otherwise excluding incompatible readings); add these commented-read cases beside operator-before-write regressions. These are new usability regressions, not requests to close preexisting heuristic safety gaps.

### Test quality

- New table-driven cases assert correct outcomes for every named round 3 reproduction, plus positive/negative EXPLAIN cases. Existing round 2 CTE, global SET, comment, transaction and DO cases remain passing.
- Dollar-string coverage at `src/lib/sql/detect.test.ts:74`–`:75` misses the new defect: `$$into$$` has no keyword boundary in the MySQL reading, while the tagged DELETE example starts with SELECT, which scans only for INTO. Add spaced INTO inside a dollar string and DELETE inside a WITH string.
- Comment read coverage at `src/lib/sql/detect.test.ts:90` uses a space after `--`, so both readings agree. Add PostgreSQL no-space comments and MySQL hash comments containing write keywords.
- OFF/0 and ON/1 EXPLAIN options pass reviewer probes but lack committed coverage. Changed tests are classifier-only; no new Lock/Production runner assertions accompany the fix. Consumer effects above were traced statically, not newly reproduced through hook probes in this round.

### Verification and limitations

- `npm run build`: **passed** (TypeScript and production build). Warnings remain for browser externalization of `node:zlib`, ineffective dynamic imports and large chunks.
- `npm run test:run -- --exclude '**/.claude/**' src/lib/sql src/lib/dump src/screens/connection/hooks/useDatabaseBackup.restore.test.ts src/screens/connection/hooks/useDatabaseBackup.free.test.ts src/screens/connection/hooks/useSqlRunner.sequential.test.ts src/screens/connection/hooks/useSqlRunner.explainAnalyze.test.ts src/screens/connection/hooks/useSqlHistoryRunner.test.ts src/lib/ai-assistant/agent.test.ts`: **16 files / 257 tests passed**.
- Initial unexcluded run also discovered `.claude/worktrees/bold-wilbur-9b667c` and failed its 51 runner tests with a Preact hook-instance error (`__H`). Excluding that unrelated nested checkout produced the clean target-checkout result above; no configuration/source changed to do so.
- Reviewer differential probes: **31 cases / 62 assertions passed**, loading the actual TypeScript classifier at `95674cf` and in the working tree through the installed TypeScript transpiler. Includes six newly regressed reads, all named round 3 cases, retained round 2 cases, and EXPLAIN option combinations. Assertions encode the observed before/after behavior; passing regression probes is evidence of the defects, not correctness. No probe files retained.
- No new executable-write false negative found in the reviewed cases. Preexisting incompleteness remains a limitation for the separately tracked server-side SQL-editor read-only enforcement task; for example, `SELECT side_effect_function()` still returns false in both versions. Existing editor live-mode/authentication races remain outside this fix. Dump Lock/Production refusal remains independent of this heuristic.
- No live database queries, native dialogs/Touch ID, desktop UI, or Rust checks performed; no Rust/source changes. Only this review document changed; unrelated `.claude/launch.json` preserved. No commit, push or merge.


## Re-review (round 5)

**Status: CHANGES REQUIRED.** Reviewed `daa4912..93f14f3` on `fix/backup-restore-safety` (2026-10-27). HEAD `343410b` differs from `93f14f3` only in review documentation; tested application code matches the requested fix. Same agreed scope as round 4: preexisting heuristic gaps remain limitations for the separate server-side read-only enforcement task. No application source changed.

### Round 4 disposition

- **P2 PostgreSQL dollar-string reads — resolved for PostgreSQL.** `src/lib/sql/detect.ts:223` selects only the PostgreSQL reading for `postgres`. All four named dollar-string reads now return false; committed regressions at `src/lib/sql/detect.test.ts:105` cover spaced INTO, tagged strings, DELETE inside WITH, and executable-comment text inside a string. The real-hook test at `src/screens/connection/hooks/useSqlRunner.safety.test.ts:64` verifies dispatch of a representative dollar-string read in Lock.
- **P2 incompatible line-comment readings — resolved for named engines.** PostgreSQL no-space `--note` and MySQL/MariaDB hash-comment reads use their own rules (`src/lib/sql/detect.ts:224`, `:225`). Classifier tests cover PostgreSQL and both MySQL engines; real-hook tests cover PostgreSQL/MySQL reads. Previously reported operator-before-write cases remain classified as writes in the supplied dialect. Unknown/other engines intentionally retain the conservative union and its existing read false positives.

### P1 — Selecting one dialect drops protection for supported session string modes

**Locations:** `src/lib/sql/detect.ts:223`–`:225` (new routing), `:137`–`:145` (fixed escape assumptions); consumers `src/screens/connection/hooks/useSqlRunner.ts:651`, `:671`.

These statements returned **true** at `daa4912`, but return **false** at `93f14f3` with the indicated engine:

```sql
-- MySQL or MariaDB, with session sql_mode including NO_BACKSLASH_ESCAPES:
SELECT 'a\' INTO OUTFILE '/tmp/reviewer-probe'

-- PostgreSQL, with session standard_conforming_strings = off:
SELECT 'a\'b' INTO backup_x
```

Each example contains one literal backslash. In the MySQL/MariaDB mode, the backslash is ordinary text and the following quote closes the string; INTO OUTFILE writes a file. The selected MySQL reading instead escapes that quote and hides INTO inside a string. In PostgreSQL's alternate mode, the escaped quote belongs inside the string; INTO creates a table. The selected PostgreSQL reading instead closes the string too soon and subsequently hides INTO. The removed alternate reading caught each write in the previous commit. These are newly reopened writes, not preexisting unrecognized statement forms.

Official semantics: [MySQL string literals](https://dev.mysql.com/doc/refman/8.4/en/string-literals.html), [MariaDB NO_BACKSLASH_ESCAPES](https://mariadb.com/docs/server/server-management/variables-and-modes/sql_mode#no_backslash_escapes), and [PostgreSQL lexical structure](https://www.postgresql.org/docs/15/sql-syntax-lexical.html). No general SQL-editor connection setup was found that forces these settings to the classifier's assumptions; the PostgreSQL Explain Analyze path's local setting is specific to that operation (`src-tauri/src/engines/postgres/explain_analyze.rs:611`).

Temporary real-hook probes reproduced all three statements reaching `onRunSql` unchanged in **both Lock and Production** (Production authentication successful; backend validation mocked). Backend syntax validation is not read-only authorization. No live database effects were executed or claimed.

Keep engine-specific comment/dollar-quote rules, but conservatively consider the supported string-escape modes within that dialect unless the actual execution session's mode is authoritatively known/enforced. Explicit PostgreSQL E strings must retain their unconditional escape semantics. Add classifier and Lock/Production hook regressions for these writes alongside the round 4 reads. Do not restore the incompatible whole-dialect union that caused the P2 findings.

### Engine flow and adjacent regressions

- `src/screens/connection/ConnectionScreen.tsx:129` derives the engine from the active profile tab; its runtime context at `:908` supplies that engine (PostgreSQL fallback). `src/screens/connection/workspace/ActiveWindowContent.tsx:225` passes `rt.engine` into `SqlWindowPane`; `src/screens/connection/sql/SqlWindowPane.tsx:103` passes it unchanged into `useSqlRunner`. The runner destructures the argument and uses it at both restricted-mode gates; `src/screens/connection/hooks/useSqlRunner.ts:727` includes it in `startRun` dependencies. No missing engine forwarding found in this path.
- `src/types.ts:149`–`:165` has no distinct CockroachDB/Redshift engine value. PostgreSQL-compatible servers configured as `postgres` receive that reading; any other/unknown engine keeps both readings (`src/lib/sql/detect.ts:226`). Consequently restricting the known-engine routes does not remove the former union for SQLite, SQL Server, DuckDB, ClickHouse, or other engine keys. Their preexisting dialect mismatches remain limitations, not newly attributed blockers.
- MariaDB `/*M!100100 DELETE FROM a */` and MySQL-style `/*!50000 DROP TABLE a */` remain writes with engine `mariadb`; both executable-comment checks precede ordinary comment removal (`src/lib/sql/detect.ts:118`). No separate MariaDB executable-comment regression found.
- AI `sqlSafety` remains unchanged: `src/lib/ai-assistant/agent.ts:239` requires its separate frontend/backend checks for `read_only`; its classifier call without an engine at `:245` labels other previews. It retains the former union behavior and does not acquire the new engine-specific false negatives.
- Dump restore/import Lock/Production refusal remains independent of this classifier. Preexisting side-effect-function gaps and SQL-editor live-mode/authentication races remain outside this fix.

### Test quality, verification and limits

- `npm run build`: **passed**, TypeScript plus production Vite build. Existing warnings: `node:zlib` externalization, ineffective dynamic imports, large chunks.
- `npm run test:run -- --exclude '**/.claude/**' src/lib/sql src/lib/dump src/screens/connection/hooks/useDatabaseBackup.restore.test.ts src/screens/connection/hooks/useDatabaseBackup.free.test.ts src/screens/connection/hooks/useSqlRunner.sequential.test.ts src/screens/connection/hooks/useSqlRunner.explainAnalyze.test.ts src/screens/connection/hooks/useSqlRunner.safety.test.ts src/screens/connection/hooks/useSqlHistoryRunner.test.ts src/lib/ai-assistant/agent.test.ts`: **17 files / 276 tests passed**. Unrelated nested worktree excluded as requested.
- Differential classifier probes loaded actual old/current TypeScript: all three session-mode write examples changed true → false; MariaDB executable comments stayed true; representative round 4 reads changed true → false as intended. Other/unknown routing remains both ways by inspection.
- Temporary reviewer hook suite: **12 tests passed**: six original safety cases plus six reproductions (three newly missed writes × Lock/Production), asserting dispatch once with unchanged SQL. Passing reproduction assertions demonstrate the defect, not correct authorization. Temporary file removed.
- New committed tests exercise the real hook, actual client validation/splitter and actual classifier, while mocking native execution/validation/authentication. Paired reads demonstrate that dispatch is reachable, improving on classifier-only coverage. Unique window IDs avoid throttle/inflight collisions. Blocked cases at `src/screens/connection/hooks/useSqlRunner.safety.test.ts:59` assert only no dispatch, not the expected block reason; future tests should also inspect the run error so unrelated early exits cannot satisfy them. Missing committed coverage: Production, MariaDB hook behavior, session string modes, and engine-change rerenders. The mode regression above requires coverage; the other gaps are nonblocking test improvements.
- No live DB queries, native dialogs/Touch ID, desktop UI or Rust checks performed. Native validation is mocked in hook probes, so successful database execution is inferred from documented SQL semantics, not verified end to end. Only `.agent/REVIEW.md` retained as a change; unrelated `.claude/launch.json` preserved. No source edits, commit, push or merge.


## Re-review (round 6)

**Status: VERIFIED WITH LIMITATIONS.** Reviewed `93f14f3..db1fb7b` on `fix/backup-restore-safety` (2026-10-27). Checkout HEAD `384d57c` differs from `db1fb7b` only in review documentation; tested application code matches the requested fix. Scope remains the rounds 4–5 agreement: confirm the round 5 P1 fix and check newly reopened writes or reblocked round 4 reads. No new in-scope findings requiring changes.

### Round 5 disposition and regression assessment

- **P1 session string modes — resolved.** `src/lib/sql/detect.ts:248` evaluates both backslash settings within each selected dialect and returns true if either sees a write. The old PostgreSQL reading is retained with `false`; the old MySQL reading is retained with `true`. Their existing positive classifications therefore remain positive; this change adds readings rather than removing protection. All three reported session-mode examples (MySQL, MariaDB, PostgreSQL) now classify as writes. Classifier regressions: `src/lib/sql/detect.test.ts:141`.
- **Explicit PostgreSQL E strings retain unconditional escapes.** `src/lib/sql/detect.ts:146` combines the session setting with explicit E-prefix detection. `src/lib/sql/detect.test.ts:112` verifies the named E-string read remains false in the PostgreSQL dialect. Its removal from the engine-unspecified read table is appropriate: other/unknown engines intentionally consider MySQL as well, where E is not PostgreSQL escape syntax.
- **Round 4 reads remain allowed.** Engine routing at `src/lib/sql/detect.ts:233` is unchanged; additional readings use the same comment and dollar-quote rules. Differential probes confirm all four named PostgreSQL dollar-string reads, PostgreSQL no-space line-comment read, and both MySQL/MariaDB hash-comment reads stay false. Committed coverage remains at `src/lib/sql/detect.test.ts:103` and `:117`. No incompatible whole-dialect union was reintroduced for known engines.
- **Restricted-mode integration remains intact.** Production and Lock use the same classifier with the supplied engine at `src/screens/connection/hooks/useSqlRunner.ts:651` and `:671`. Neither gate nor engine forwarding changed. Dump Lock/Production refusal remains independent of this heuristic; no dump source changed in this fix.

### Test assessment

- `src/screens/connection/hooks/useSqlRunner.safety.test.ts:58` adds real-hook Lock regressions for MariaDB and PostgreSQL session-mode writes. `:65` now checks the actual Lock error as well as no dispatch, closing the round 5 false-success concern. Existing paired reads at `:69` still demonstrate reachable dispatch.
- Classifier tests cover all three named session-mode writes; the real-hook suite covers two directly. MySQL's equivalent session-mode hook case and Production-mode hook coverage remain absent, nonblocking coverage limitations: MySQL/MariaDB share the same dialect route, and Production uses the same classifier. No new Production hook execution was claimed in this round.

### Verification and limitations

- `npm run build`: **passed**, TypeScript and production Vite build. Existing warnings: `node:zlib` browser externalization, ineffective dynamic imports, large chunks and plugin timings.
- `npm run test:run -- --exclude '**/.claude/**' src/lib/sql src/lib/dump src/screens/connection/hooks/useDatabaseBackup.restore.test.ts src/screens/connection/hooks/useDatabaseBackup.free.test.ts src/screens/connection/hooks/useSqlRunner.sequential.test.ts src/screens/connection/hooks/useSqlRunner.explainAnalyze.test.ts src/screens/connection/hooks/useSqlRunner.safety.test.ts src/screens/connection/hooks/useSqlHistoryRunner.test.ts src/lib/ai-assistant/agent.test.ts`: **17 files / 281 tests passed**. Unrelated nested worktree excluded as requested.
- Reviewer differential probes transpiled the actual classifier at `93f14f3` and `db1fb7b`: **11 cases / 22 assertions passed**. Three reported writes changed false → true; seven round 4 engine-specific reads and one explicit E-string read stayed false. No probe files retained.
- Classification remains a heuristic, not server-side read-only authorization. Preexisting side-effect-function gaps, other/unknown dialect mismatches, and editor live-mode/authentication races remain limitations for the separate task, not new blockers. Considering both unknown session settings can conservatively flag ambiguous ordinary strings; this follows the agreed fix and does not reblock the named round 4 reads.
- No live database execution, native dialogs/Touch ID, desktop UI or Rust checks performed. Hook tests mock native validation, execution and authentication. No Rust files changed. Only `.agent/REVIEW.md` changed; unrelated `.claude/launch.json` preserved. No source edits, commit, push or merge.


## Re-review (round 7)

**Status: VERIFIED WITH LIMITATIONS.** Reviewed `db1fb7b..d52a06d` on `fix/backup-restore-safety` (2026-10-27), including the comparison against main requested for rounds 4–6. Checkout HEAD `1ab1043` differs from `d52a06d` only in review documentation; application code tested matches the requested commit. Main reference: `aa4d22d`. No new in-scope findings requiring changes. No source code modified.

### Regression disposition and refactor assessment

- **Reported standard-comment regression — resolved.** `src/lib/sql/detect.ts:122` defines flat block comments, unconditional dash comments and no hash comments; `:289` adds this reading for every engine other than PostgreSQL/MySQL/MariaDB, including unknown or omitted engines. For `--x\n/* /* */ DELETE FROM t`, main returns true, `db1fb7b` returns false on these routes, and `d52a06d` returns true. Reviewer checked every declared engine key plus an unknown key and undefined. SQLite execution was independently confirmed using a disposable Python SQLite `:memory:` database: one inserted row, statement executed, zero remaining rows. No customer or disk database accessed.
- **PostgreSQL/MySQL rules — unchanged.** Table entries at `src/lib/sql/detect.ts:104` and `:111` preserve each former boolean predicate: nested comments, dash/hash comments, dollar quotes, E-string escapes and double-quote escapes. The quote rewrite at `:192` is equivalent for single, double and backtick quotes under both escape settings. Known-engine routing at `:287`–`:288` and both session readings at `:301` are retained. Other/unknown engines retain both former readings and add a third; no former positive can become negative through this addition.
- **Round 4 reads and round 5 writes — preserved.** Classifier tests at `src/lib/sql/detect.test.ts:103`, `:117` and `:141` pass, including dollar-string reads, PostgreSQL no-space dash comments, MySQL/MariaDB hash-comment reads and session string-mode writes. No incompatible reading was added to known PostgreSQL/MySQL routes.
- **Comparison with main — no additional executable-write regression found.** Main skips only leading whitespace, unconditional dash comments and flat block comments, then checks the same DDL/DML/transaction head regexes retained here. For other/unknown engines, the added standard reading preserves that leading-comment interpretation and those initial write keywords. For PostgreSQL/MySQL, reviewed main-positive/current-negative cases against their actual comment rules rather than treating every classifier difference as an executable write. In the generated corpus, all 292 such engine/case differences were confined to PostgreSQL nested comments hiding the apparent write, or MySQL/MariaDB inputs beginning with an incompatible no-whitespace dash prefix (`--x`). They do not establish executable writes on those selected engines. No such differences occurred for other/unknown engines.
- **Both restricted gates consume the fix.** `src/screens/connection/hooks/useSqlRunner.ts:651` (Production) and `:671` (Lock) call the same classifier with the connection engine; neither changed. Dump restrictions remain independent of this classifier.

### Tests and verification

- `src/lib/sql/detect.test.ts:156` adds DELETE and DROP reproductions for SQLite, Oracle, D1, Turso, SQL Server and omitted engine. The committed array omits a literal unknown engine and other declared engine keys; reviewer differential probes cover their shared fallback route. Nonblocking coverage improvement.
- `src/screens/connection/hooks/useSqlRunner.safety.test.ts:63` adds the real-hook SQLite Lock reproduction. Assertions at `:66`–`:68` require both no execution and the actual Lock error, preventing unrelated early exits from passing. Paired allowed-read cases remain at `:71`. Production is still covered by static shared-classifier tracing rather than a committed Production hook regression; nonblocking coverage limitation.
- `npm run build`: **passed**, TypeScript and production Vite build. Existing warnings: browser externalization of `node:zlib`, ineffective dynamic imports and large chunks.
- `npm run test:run -- --exclude '**/.claude/**' src/lib/sql src/lib/dump src/screens/connection/hooks/useDatabaseBackup.restore.test.ts src/screens/connection/hooks/useDatabaseBackup.free.test.ts src/screens/connection/hooks/useSqlRunner.sequential.test.ts src/screens/connection/hooks/useSqlRunner.explainAnalyze.test.ts src/screens/connection/hooks/useSqlRunner.safety.test.ts src/screens/connection/hooks/useSqlHistoryRunner.test.ts src/lib/ai-assistant/agent.test.ts`: **17 files / 288 tests passed**.
- Reviewer differential probes transpiled actual classifiers from main, `db1fb7b` and `d52a06d`: **17,586 distinct inputs**, generated from comment/quote/write combinations plus deterministic token fuzzing; **70,344 exact executable-text comparisons** across PostgreSQL/MySQL and both escape settings; **298,962 engine/case comparisons** across all 15 declared engines, an unknown engine and undefined. All known-engine results equal `db1fb7b`; every old positive remains positive for fallback engines. Main differences inspected as described above. This corpus is evidence, not an exhaustive proof over all SQL grammars. Probe artifacts stayed under `/tmp`.

### Limitations

Classifier remains heuristic. Preexisting gaps also missed by main, including side-effect functions, remain for the separate server-side read-only enforcement task. No new requirement to close those gaps in this round. Conservative fallback readings may still reject valid reads. Existing editor live-mode/authentication races remain outside scope.

No external/live database, native dialogs/Touch ID, desktop UI or Rust checks performed; only isolated in-memory SQLite execution. Hook tests mock native execution, validation and authentication. Only `.agent/REVIEW.md` changed; unrelated `.claude/launch.json` preserved. No source edits, commit, push or merge.


## Re-review (round 8): PostgreSQL types in backups

**Status: CHANGES REQUIRED.** Reviewed `1b7c6bc..cfebef7` on `fix/backup-restore-safety` (2026-10-27). Checkout HEAD is `cfebef7ee5cae79af4d0af1226beb28ad57f1bed`; tested application code matches the requested commit. Only this review document changed; unrelated untracked `.claude/launch.json` preserved.

### Findings

1. **P2 — Discover the full type dependency graph and emit bases before derived domains.** `src/screens/connection/hooks/useDatabaseBackup.ts:436`, `:441`, `:476`, `:493`. `all_types` expands only the original `used` set once. For a column of outer domain `public.outer_d`, based on `public.inner_d`, based on `other_schema.role_enum`, the enum is omitted entirely; its schema can also be omitted if no other selected object uses it. The same loss occurs for an array of the outer domain or a domain over an array of domains. Independently, two discovered domains are emitted in schema/name order: `CREATE DOMAIN public.z_parent AS integer; CREATE DOMAIN public.a_child AS public.z_parent; CREATE TABLE public.users (x public.a_child);` produces child-before-parent DDL in the backup. Restore into an empty database therefore still stops with a missing type. Reviewer executed the actual CTE against an isolated in-memory catalog model: the outer/inner/enum chain returned only the two domains. Actual builder probes with catalog-row fixtures confirmed child-before-parent output. These are query/SQL-generation reproductions, not PostgreSQL server execution. Recursively walk array/domain dependencies to closure, retain dependency edges, and topologically order domain creation across schemas. Add nested and reverse-alphabetical domain regressions. PostgreSQL explicitly supports domains over other domains: [domain types](https://www.postgresql.org/docs/17/domains.html).

2. **P2 — Preserve domain collation instead of silently changing its behavior.** `src/screens/connection/hooks/useDatabaseBackup.ts:462`, `:503`. The query never reads `typcollation`, and generated domain DDL has no `COLLATE`. A source `CREATE DOMAIN public.case_text AS text COLLATE "C"` becomes a plain text domain, inheriting the target base type's collation. On a database with a different default, ordering, comparisons and collation-dependent CHECK behavior change even when restore completes. Retrieve and emit the qualified domain collation when it differs from the base, and handle its dependency or explicitly reject unsupported custom collations. Test that restored domain metadata/behavior matches source. This is a newly generated domain-definition fidelity problem; preexisting table-column collation omissions are separate. See [CREATE DOMAIN](https://www.postgresql.org/docs/17/sql-createdomain.html).

3. **P2 — Do not swallow genuine commented DDL failures based on words inside object names.** `src/screens/connection/hooks/useDatabaseBackup.ts:94`, `:98`, `:106`, `:109`. Removing leading comments now exposes generated CREATE TABLE/INDEX and ALTER TABLE statements to the existing broad substring policy; CREATE TYPE/DOMAIN are also newly eligible. The actual helper returns true for `-- Structure\nCREATE TABLE public.t (x "already exists")` with PostgreSQL error `type "already exists" does not exist`. It also returns true for a domain validation error containing `violates check constraint "already_positive"`. Neither is an existing-object error. A commented post-data index referring to a missing column named `already exists` can similarly be skipped, leaving a restore without its intended index while reporting only existing objects/FKs as the reason. Prefer native SQLSTATE plus the expected object/operation; if structured errors are unavailable, use narrowly matched duplicate diagnostics rather than arbitrary message substrings. Add negative restore-hook tests for missing dependency, CHECK violation and missing column with these names, alongside genuine duplicates. Ordinary permission-denied, missing-type messages without these substrings, unique-index data failures and INSERT duplicate errors remain fatal in reviewer helper probes. The comment stripper itself does not remove SQL inside literals; its interaction with error classification is the regression.

4. **P2 — Account for domain default dependencies before emitting the types phase.** `src/screens/connection/hooks/useDatabaseBackup.ts:464`, `:504`, `:834`. Domains are emitted before every table structure, including the sequences emitted at `:626`. A valid source can have `public.users.id serial` and a domain `public.ticket AS integer DEFAULT nextval('public.users_id_seq'::regclass)` used by another column/table. The sequence is included in the backup, but after CREATE DOMAIN; the regclass constant cannot resolve during domain creation on an empty target. Standalone sequences and user functions used by domain defaults/CHECKs are not discovered at all. Also export the current parsed default with `pg_get_expr(typdefaultbin, 0)` instead of relying on creation-time `typdefault` text, which can retain old object names after renames. Schedule required sequences before domains and defer ownership until tables exist; discover/support other expression dependencies or refuse backup with an actionable unsupported-dependency message. Test serial-sequence defaults and renamed dependencies. The dependency failure follows from actual output-phase tracing; live PostgreSQL reproduction was unavailable. PostgreSQL's own [domain dumper](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/bin/pg_dump/pg_dump.c#L10820) deparses binary defaults and preserves domain collation.

5. **P2 — Keep extension-owned enums/domains under extension ownership.** `src/screens/connection/hooks/useDatabaseBackup.ts:452`, `:474`. Filtering only `typtype IN ('e','d')` avoids recreating base types such as citext and PostGIS geometry, but is not an extension-membership check. An extension-provided enum/domain is exported as an ordinary application type; for example, earthdistance's `earth` domain is eligible, although its base/functions require extension installation. Recreating such members individually can fail on an empty target or create an unowned object that later collides with CREATE EXTENSION. Exclude extension members via `pg_depend` with the correct catalog IDs and `deptype = 'e'`; record/check required extensions, or recreate them through CREATE EXTENSION when supported. Keep user-created domains over extension types distinct from extension-owned domains. Add catalog coverage for both. See PostgreSQL's [extension dependency contract](https://www.postgresql.org/docs/17/catalog-pg-depend.html).

6. **P2 — Retain enums with zero labels.** `src/screens/connection/hooks/useDatabaseBackup.ts:454`. The inner join to `pg_enum` drops a valid `CREATE TYPE public.pending AS ENUM ();` entirely. A table with a nullable `pending` column can exist and contain NULL rows, yet its backup fails at CREATE TABLE on an empty target. Use an outer join and an empty-label aggregate fallback so `AS ENUM ()` is emitted. Test this separately from a database with only built-in types. Empty enums are explicitly supported by [CREATE TYPE](https://www.postgresql.org/docs/17/sql-createtype.html).

All six findings concern paths added or widened by this commit. Each is P2 because it needs the stated database definition or diagnostic; no P0/P1 finding established. Changes are requested for the reviewed type-support scope, rather than treating these generated backups as verified restorations.

### Correctness, quoting and compatibility assessment

- The reported nonempty `public.user_role` enum is covered by the new lookup and precedes table creation. Direct enum arrays, a domain directly over an enum, and a domain over an enum array are represented by the one-level walk. All enums precede domains; ordinary built-in-base domains therefore avoid the original missing-enum problem. Non-public schemas returned for tables/types are created before their DDL. PostgreSQL-generated `format_type` handles mixed-case/base-type syntax; names explicitly emitted by the frontend use double-quote escaping.
- Catalog enum labels use `quote_literal` and enum sort order; constraint names use `quote_ident`; constraint expressions use `pg_get_constraintdef`. Those expressions are already SQL and should not be wrapped in identifier or string quoting. Reviewer builder probes confirmed doubled quotes for a mixed-case type containing a double quote and table-filter literals containing apostrophes. No direct interpolation injection found under normal PostgreSQL `standard_conforming_strings = on`. Defaults/CHECKs can intentionally execute source-defined functions: restoring SQL remains code execution, not a sanitization boundary.
- `qLiteral` uses the existing SQL literal helper, which does not encode backslashes for sessions with `standard_conforming_strings = off`. The existing splitter also treats backslashes as escapes in double-quoted identifiers, unlike PostgreSQL; identifiers ending in a backslash can therefore merge statements. These shared preexisting limitations also affect unusual names in the new type statements; no claim of exhaustive special-character round-trip support. No new source-level injection exploit established in this review.
- `format_type`/expression deparsing depends on source visibility/search_path; the dump does not establish a matching search_path on restore. Types/functions in a non-public source search_path may be emitted unqualified and fail or resolve differently on a default target. This is also present in the existing table builder. A robust dependency fix should establish a controlled deparse/restore path rather than assuming identical session settings.
- Standalone composite, range and multirange types are still omitted (`typtype` filters only e/d). Their enum/domain dependencies are not traversed either. This was already unsupported and is outside the explicitly described enum/domain implementation; document the boundary or fail backup early for these types instead of promising an arbitrary database can round-trip. Extension base types still require extensions on the target. No broad custom-type support verified.
- CHECK-only filtering avoids duplicating PostgreSQL 17 domain NOT NULL constraints; `typnotnull` preserves nullability, but the original named NOT NULL constraint is not preserved. Ordinary table-owned sequences still precede their own table; findings above concern their newly introduced ordering relative to domains. MySQL/MariaDB backup generation is unchanged, although the shared comment-aware restore classification affects their imports too.
- Leading `--` lines, including blank whitespace between lines and CRLF, are stripped for DDL recognition. Block comments are not stripped. Existing duplicate type/domain definitions are skipped without checking semantic equivalence, as existing table/constraint skip behavior already does. Existing safety gates, partial-progress reporting and refresh logic are unchanged. No new transaction or rollback guarantee is introduced.

### Test quality and verification

- `npm run build`: **passed** (TypeScript and production Vite build). Warnings: existing browser externalization of `node:zlib`, ineffective dynamic imports and large chunks.
- `npm run test:run -- --exclude '**/.claude/**' src/screens/connection/hooks/useDatabaseBackup.types.test.ts src/screens/connection/hooks/useDatabaseBackup.restore.test.ts src/screens/connection/hooks/useDatabaseBackup.free.test.ts src/lib/dump src/components/editor/splitSqlStatements.test.ts`: **6 files / 50 tests passed**.
- New type tests at `src/screens/connection/hooks/useDatabaseBackup.types.test.ts:19` and `:62` verify output assembly and the table filter, but mock already formatted catalog rows. They never execute the discovery SQL, test domain dependency order, or restore the generated output. Consequently their success does not validate array discovery, nested domains, extension ownership, collation/default dependencies, empty enums or server quoting. Add disposable PostgreSQL catalog/round-trip coverage for these cases; avoid asserting only query substrings.
- The new real-hook test at `src/screens/connection/hooks/useDatabaseBackup.restore.test.ts:149` exercises the actual splitter and commented duplicate-enum skip path, including continuation and informational skip reporting. It does not cover CREATE DOMAIN, commented TABLE/INDEX/ALTER, multiple comment lines, or fatal errors whose object names contain duplicate-related words. Those regressions need focused tests.
- Reviewer probes transpiled the actual committed builder/error helper (mock catalog rows; no application edits), confirmed the generated ordering/collation/default issues and negative/positive error classifications. The actual dependency CTE was also executed on SQLite `:memory:` with a minimal catalog model for three nested domain/array cases; this validates traversal logic, not PostgreSQL catalog fidelity or execution. Temporary query artifact under `/tmp` removed.
- Live PostgreSQL verification **blocked**: `docker image ls` could not access `unix:///Users/lamtung/.orbstack/run/docker.sock` (`permission denied`). Approval is unavailable in this session. No container started, so none needed cleanup; the running container named `postgres` and all customer databases were untouched. Only the libpq client was found locally, not a PostgreSQL server. Claude's reported disposable-PG17 run is acknowledged as implementer evidence, not independently repeated here.
- No desktop UI, native dialogs/Touch ID or Rust checks run; no UI/native/Rust changes in the reviewed diff. No source/test edits retained, commit, push or merge.


## Re-review (round 9)

**Status: CHANGES REQUIRED.** Reviewed `cfebef7..62f779e` on `fix/backup-restore-safety` (2026-10-27). Checkout HEAD `f70322a6677736840cc5eb52a02908f1c83442cf` differs from the requested fix only in `.agent/REVIEW.md`; tested application code matches `62f779e`. No source changes.

### Round 8 disposition

1. **Recursive dependencies/order — resolved for supported enum/domain/array paths.** `src/screens/connection/hooks/useDatabaseBackup.ts:458` uses recursive UNION to reach closure without repeated OIDs. `:483` maps an array base to its element; `:588` places each base domain before its derived domain across schemas. Enums precede domains, schemas precede both. Nested arrays/domains no longer depend on one expansion or alphabetical order. Composite/range traversal remains outside supported scope.
2. **Domain collation — partially resolved.** `:498` compares domain/base collation and `:611` emits its qualified name. Built-in COLLATE "C" is preserved. Custom collations still have no dependency handling or rejection; see finding 3.
3. **Misclassified genuine errors — resolved for reported cases.** `:92` restricts classification to the first diagnostic line and blanks quoted names before matching. Missing types/columns named "already exists", CHECK names containing "already", and duplicate wording in DETAIL stay fatal. Hook tests exercise stop behavior and prevent the next INSERT. Existing broad matching on unquoted diagnostic text remains heuristic, not SQLSTATE validation.
4. **Domain defaults — partially resolved.** `:485` uses pg_get_expr on the binary default, so renamed dependencies are deparsed from current catalog identities. Sequence dependencies are scheduled before domains at `:638`; later table sequence creation uses IF NOT EXISTS and ownership follows table creation. Sequence schemas and delimiter encoding remain broken (findings 1–2). User functions in defaults/CHECKs remain unsupported and are neither recreated nor rejected; this is an explicitly disclosed remaining part of round 8, not verified dependency completeness.
5. **Extension ownership — resolved for directly discovered type owners.** `:523` checks both catalog identities and deptype='e'; extension members are excluded from independent enum/domain creation. User domains over extension types remain ordinary domains. Required extension schemas precede CREATE EXTENSION; extensions precede user types. Privileges, installed extension files and compatible versions remain target prerequisites. General extension-to-extension dependencies are not walked or ordered: alphabetical sorting at `:627` is not a dependency order and there is no CASCADE. The earthdistance domain's cube base is reached by this type walk, so that specific prerequisite is discovered; this does not prove all extension prerequisites are. [CREATE EXTENSION dependency behavior](https://www.postgresql.org/docs/17/sql-createextension.html).
6. **Empty enums — resolved.** `:495` aggregates labels in a scalar subquery with an empty fallback, retaining the type when pg_enum has no rows. `:578` emits AS ENUM ().

### Findings requiring changes

1. **P2 — Create sequence-only schemas before domain-default sequences.** `src/screens/connection/hooks/useDatabaseBackup.ts:504`, `:605`, `:619`. For a public table using a public integer domain with DEFAULT nextval('archive.ids'::regclass), where archive contains only the sequence, the query returns archive.ids but the schema set includes only table/type/extension schemas. Actual builder probe emits `CREATE SEQUENCE IF NOT EXISTS archive.ids;` without CREATE SCHEMA archive. Restore into an empty database stops before creating the domain. Return sequence schema/name as structured fields, add its schema to the preamble, and test a sequence in an otherwise unused schema.

2. **P2 — Preserve commas inside quoted sequence identifiers.** `src/screens/connection/hooks/useDatabaseBackup.ts:505`, `:606`. string_agg(..., ',') followed by split(',') is not a reversible identifier encoding. For catalog value `public."ids,old"`, actual builder probe emits two malformed statements: `CREATE SEQUENCE IF NOT EXISTS old";` and `CREATE SEQUENCE IF NOT EXISTS public."ids;`. This newly added sequence path breaks valid quoted names even though quote_ident was used upstream. Return JSON/array records or separate rows and keep each qualified identifier intact. Add comma-bearing sequence and schema regressions, alongside embedded double quotes and multiple dependencies.

3. **P2 — Handle or explicitly reject custom domain collations.** `src/screens/connection/hooks/useDatabaseBackup.ts:498`, `:611`. A public text domain using `custom.ordering` emits `CREATE DOMAIN "public"."code" AS text COLLATE custom.ordering;` without recreating that collation or its otherwise unused schema. Even when its schema exists, the collation is absent on an empty target. This leaves round 8 finding 2 open for custom collations; the known-limit list does not cover them. Discover/recreate supported collation dependencies (including extension ownership), or fail backup with an actionable unsupported-collation error. Test the empty-target case; emitting the clause alone is insufficient.

### Compatibility, diagnostics and test quality

- Static PG 13–17 assessment: recursive CTE/LATERAL VALUES, enum aggregation, typbasetype/typelem/typcollation/typdefaultbin, pg_get_expr, and catalog dependency checks use interfaces available in PG13; no PG14+ multirange or PG17-only column is required. CHECK-only filtering continues to avoid duplicating domain NOT NULL metadata. No server-version execution matrix was run. [PG13 pg_type catalog](https://www.postgresql.org/docs/13/catalog-pg-type.html).
- Deparsed base/default/CHECK expressions still depend on source search_path. No controlled deparse/restore search_path was added; this preexisting cross-schema limitation remains. Custom base/composite/range types and user functions remain unsupported. Newly created standalone sequences also use default settings/state rather than source sequence metadata; no general sequence-fidelity claim is warranted.
- Reviewer ran 9 diagnostic probes against the actual transpiled helper: PostgreSQL duplicate type and multiple-primary-key diagnostics, MySQL/MariaDB table-exists and duplicate-key-name diagnostics remain ignorable; missing-type/CHECK/missing-column-DETAIL errors and duplicate-entry data failures remain fatal. MySQL/MariaDB `Multiple primary key defined` (singular) returns false: preexisting mismatch, since the previous helper also matched only plural `multiple primary keys`. No regression from quoted-name blanking established for these ordinary messages. No MySQL/MariaDB server execution performed.
- Type tests now assert separate output cases for base ordering, collation/default/CHECK/nullability, early sequences, extension ownership/user domains, and empty enums. They still supply hand-built catalog rows: they do not execute the recursive SQL, validate its joins, test deep array/domain discovery or rename deparsing, or perform restoration. No committed empty-table fast-path, sequence-only-schema, comma-name, custom-collation or extension-prerequisite coverage. Restore tests add useful real-hook negative failures; positive MySQL/MariaDB/domain diagnostics remain reviewer probes rather than committed coverage.
- `npm run build`: **passed** (tsc and Vite). Existing node:zlib externalization, ineffective dynamic-import and large-chunk warnings remain.
- `npm run test:run -- --exclude '**/.claude/**' src/screens/connection/hooks/useDatabaseBackup.types.test.ts src/screens/connection/hooks/useDatabaseBackup.restore.test.ts src/screens/connection/hooks/useDatabaseBackup.free.test.ts src/lib/dump src/components/editor/splitSqlStatements.test.ts`: **6 files / 57 tests passed**.
- Actual builder probes reproduced all three findings using catalog-row fixtures; these validate generated output, not live catalog behavior. A first diagnostic probe intentionally expecting MySQL's singular PK message to be skipped failed, exposing the preexisting mismatch; the corrected nine-case probe passed with that limitation recorded.
- Independent PostgreSQL execution blocked: Docker socket access denied at `unix:///Users/lamtung/.orbstack/run/docker.sock`; approval unavailable. No container started or removed; running `postgres` and customer databases untouched. Claude's disposable PostgreSQL 17 catalog/restore evidence is acknowledged as implementer evidence, not independently repeated. No desktop/native UI or Rust checks needed for this source-only frontend review.

Only `.agent/REVIEW.md` changed. Unrelated `.claude/launch.json` preserved. No source/test edits retained, commit, push or merge.


## Re-review (round 10)

**Status: CHANGES REQUIRED.** Reviewed `62f779e..494c78c` on `fix/backup-restore-safety` (2026-10-27). Checkout HEAD `9c2d1532381624d419f31453ee0784ce951ed0d8` differs from `494c78c` only in this review document; tested application code matches the requested fix. No application source or tests modified.

### Round 9 disposition

1. **Sequence-only schemas — resolved.** `src/screens/connection/hooks/useDatabaseBackup.ts:550` returns JSON records, `:647` adds each sequence schema, and `:677` emits schemas before sequences and domains. Committed test `src/screens/connection/hooks/useDatabaseBackup.types.test.ts:152` covers an otherwise unused archive schema.
2. **Comma-bearing sequence names — resolved.** `src/screens/connection/hooks/useDatabaseBackup.ts:642` parses JSON without delimiter splitting; `:649` uses qIdent on both schema and name. Actual-builder reviewer probes additionally confirmed commas and embedded double quotes in both fields, two dependencies shared by two domains, exactly one CREATE per qualified sequence, and all sequences before domains. The map key is the fully quoted qualified identifier, avoiding schema/name ambiguity.
3. **Custom domain collations — partially resolved.** `src/screens/connection/hooks/useDatabaseBackup.ts:544` obtains the catalog row through to_jsonb, avoiding references to version-specific catalog columns. `:657` adds the collation schema; `:710` emits schemas, extensions, collations, sequences, enums, then domains. ICU locale fallback, ICU rules, nondeterministic comparisons and libc LC_COLLATE/LC_CTYPE are emitted. Remaining supported-domain cases below prevent closing this finding completely.

### Findings requiring changes

1. **P2 — Preserve PostgreSQL 17 builtin collation provider and locale.** `src/screens/connection/hooks/useDatabaseBackup.ts:464`: every non-ICU provider becomes libc. A valid source definition `CREATE COLLATION custom.ordering (provider = builtin, locale = 'C.UTF-8')`, used by a text domain, has provider `b`, colllocale `C.UTF-8`, and NULL collcollate/collctype. Actual-builder probe emits `CREATE COLLATION IF NOT EXISTS "custom"."ordering" (provider = libc, lc_collate = '', lc_ctype = '');`. This discards the explicit locale and provider; empty libc locale names can select the target environment's locale, yielding different comparison/case behavior, or fail depending on target locale availability/encoding. Handle `b` explicitly with `provider = builtin, locale = ...`, and reject unsupported providers instead of coercing them to libc. Add a builtin-domain regression and a real PG17 restore/catalog comparison. This is incomplete handling in the new recreation path, rather than a previously successful builtin restore becoming broken. PostgreSQL documents [provider/catalog values](https://www.postgresql.org/docs/17/catalog-pg-collation.html) and [builtin CREATE COLLATION syntax](https://www.postgresql.org/docs/17/sql-createcollation.html).

2. **P2 — Discover extension ownership of collation dependencies.** `src/screens/connection/hooks/useDatabaseBackup.ts:570`, `:606`, `:657`: the only extension-membership join uses `xd.classid = 'pg_type'::regclass` and the type OID. A user text domain using an extension-owned ICU/libc collation does not thereby discover its owning extension. If no traversed type independently belongs to that extension, output recreates the member as an ordinary standalone collation, with no CREATE EXTENSION or extension membership. Restore can appear successful while losing extension-managed ownership/update/drop behavior; subsequently installing an extension whose script creates that member can collide with the loose object. Discover the collation's `pg_depend` membership using `classid = 'pg_collation'::regclass`, the collation OID, `refclassid = 'pg_extension'::regclass` and `deptype = 'e'`; include its extension/schema in the preamble and omit independent member creation, or explicitly reject this dependency. Test an extension reached only through a user domain's collation. When an extension is already discovered through a type, current extensions-before-collations ordering avoids the missing-extension case, but does not cover this path. This was expressly part of round 9 finding 3. PostgreSQL's [extension dump contract](https://www.postgresql.org/docs/17/extend-extensions.html) preserves members through CREATE EXTENSION; see also [pg_depend membership semantics](https://www.postgresql.org/docs/17/catalog-pg-depend.html).

### Compatibility and regression assessment

- **Quoting:** locale/rules values pass through qLiteral, which doubles SQL apostrophes; schema/name pass through qIdent, which doubles identifier quotes. Reviewer probes using actual helpers confirmed apostrophes in locale/rules, an ICU backslash rule escape, quoted collation identifiers, and deterministic=false survive output assembly under PostgreSQL's usual standard_conforming_strings=on. Probe locale text with an apostrophe tests encoding only, not ICU acceptance. No new literal interpolation defect established. Existing lack of backslash encoding for standard_conforming_strings=off and splitter behavior with backslashes remain shared limitations; no new session-setting guarantee.
- **Provider d:** normal default collation is in pg_catalog and excluded from recreation by `:543`; its qualified COLLATE reference remains available. PostgreSQL explicitly prohibits copying the default collation, so a supported user-created alias with provider d is not an ordinary reachable case. No additional d-specific finding. The helper should still reject unexpected providers rather than silently reinterpret them. Confirmed against [PG17 DefineCollation source](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/commands/collationcmds.c).
- **Versions:** omitting collversion is appropriate for ordinary logical dump/restore, matching [PG17 pg_dump](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/bin/pg_dump/pg_dump.c#L13138). Target computes its actual version; ICU/libc version drift can change semantics, but copying the old recorded version would not reproduce the old library. No version-preservation fix requested.
- **Ordering/deduplication:** every collected schema precedes extensions and collations; extensions precede user collation DDL; collations and sequences precede domains. Qualified maps deduplicate shared sequences/collations. No new dependency-order regression found for independent user collations. Existing alphabetical extension ordering does not implement general extension prerequisite discovery. Missing installed extension files, compatible locales/ICU, privileges and database encoding remain target prerequisites.
- Enum/domain/array traversal, empty enums, domain ordering/default deparsing, restore authorization and diagnostic classification are unchanged by this fix. Composite/range types and user functions remain documented limits, outside this re-review's requested support scope. Existing sequence settings/state and search_path limits from round 9 remain; no broader fidelity claim.

### Test quality and verification

- `npm run build`: **passed** (tsc and Vite). Existing node:zlib browser externalization, ineffective dynamic imports and large-chunk warnings remain.
- `npm run test:run -- --exclude '**/.claude/**' src/screens/connection/hooks/useDatabaseBackup.types.test.ts src/screens/connection/hooks/useDatabaseBackup.restore.test.ts src/screens/connection/hooks/useDatabaseBackup.free.test.ts src/lib/dump src/components/editor/splitSqlStatements.test.ts`: **6 files / 61 tests passed**.
- New committed tests at `src/screens/connection/hooks/useDatabaseBackup.types.test.ts:152` and `:173` verify sequence-only schema/comma name plus PG17 ICU, PG15–16 ICU and libc statement assembly. Useful exact-output assertions cover ordering and nondeterminism. Missing committed cases: builtin provider, collation extension ownership, ICU rules/quote/backslash escaping, PG13–14 ICU fallback, comma/quote in schema, multiple/shared dependencies and empty-table fast path. Tests still mock positional catalog rows; they cannot validate discovery SQL, actual catalog JSON or restore semantics.
- Reviewer executed **12 assertions** against the actual TypeScript builder/helpers extracted and transpiled in memory, with mocked scalar catalog rows: builtin misgeneration, absent collation-membership query, collation identifier/value escaping, ICU rules/nondeterminism, shared-sequence deduplication/special identifiers, and schema/extension/collation/domain ordering. Assertions confirming defects are reproductions, not correct-behavior tests. No temporary source/test files created.
- **Independent live PostgreSQL verification blocked:** `docker image ls` returned permission denied for `unix:///Users/lamtung/.orbstack/run/docker.sock`. Session cannot escalate approval. No image pulled or container started; no cleanup required. Running container named `postgres` and customer databases untouched. Claude's disposable postgres:17 sequence/ICU/libc catalog round trips are acknowledged as implementer evidence, not independently repeated here; they do not cover builtin provider or collation-only extension ownership.
- No desktop/native UI or Rust checks: no affected UI/native/Rust code in this diff. Only `.agent/REVIEW.md` changed; unrelated untracked `.claude/launch.json` preserved. No commit, push or merge.


## Re-review (round 11)

**Status: VERIFIED WITH LIMITATIONS.** Reviewed `494c78c..b36a6a9` on `fix/backup-restore-safety` (2026-10-27). Checkout HEAD `723a998` differs from `b36a6a9` only in this review document; tested application code matches the requested fix. No application source or tests modified.

### Round 10 disposition

1. **P2 builtin provider/locale fidelity — resolved.** `src/screens/connection/hooks/useDatabaseBackup.ts:458` emits `provider = builtin` with the PG17 `colllocale` value. ICU (`:464`) and libc (`:473`) retain their separate paths. Unknown providers throw at `:481` instead of silently selecting libc. `src/screens/connection/hooks/useDatabaseBackup.types.test.ts:192` checks exact builtin SQL, including C.UTF-8, collation-before-domain ordering and qualified COLLATE reference; `:230` checks rejection of an unsupported provider. The reported disposable postgres:17 catalog → generated SQL → restore → provider/locale comparison supplies implementer live evidence; it was not independently repeated in this review.
2. **P2 extension-owned collation discovery — resolved.** `src/screens/connection/hooks/useDatabaseBackup.ts:572` and `:579` discover extension name/schema through the collation OID with `classid = pg_collation`, `refclassid = pg_extension`, and `deptype = e`. Result indices 17/18 match the appended SELECT fields (`:622`). The builder registers the extension and its schema at `:689`, skipping independent CREATE COLLATION. `src/screens/connection/hooks/useDatabaseBackup.types.test.ts:247` reaches the extension solely through a user domain's collation and asserts the full schema → extension → domain output with no standalone collation.

### Regression assessment

- **Catalog query / NULL rows:** `src/screens/connection/hooks/useDatabaseBackup.ts:592` retains LEFT JOINs for the base type, collation and collation namespace. The new ownership predicates are inside scalar subqueries, not the outer WHERE. When `co.oid` is NULL, `cd.objid = co.oid` matches nothing and each subquery yields NULL; enum and noncollatable-domain rows remain present. Extension membership has one owning extension per object; ordinary catalog membership therefore does not multiply rows or produce multiple-row scalar results. No version-specific collation columns were added to SQL; existing to_jsonb extraction remains intact.
- **Error surface:** `src/screens/connection/hooks/useDatabaseBackup.ts:1059` awaits the builder inside onBackupDatabase's try. An unsupported-provider Error reaches `:1112`, which shows its message in the existing Backup error dialog. The message identifies the collation and unsupported provider. `:1117` clears dbBackupRunning in finally. The error occurs before data export, packSqlToDumb and writeFile (`:1105`–`:1109`), so no partial dump is written or success toast shown by this path. The save picker and structural catalog reads already occurred; those reads do not restore or mutate database objects. Hook error behavior was traced statically, not exercised through native dialogs.
- **Ordering / deduplication:** `src/screens/connection/hooks/useDatabaseBackup.ts:716` assembles schemas after all domain dependencies are collected; `:726` builds extensions from the shared name-keyed map. Final assembly at `:754` remains schemas → extensions → standalone collations → sequences → enums → base-ordered domains. An extension found through multiple types/collations emits once. Extension-owned members bypass createCollationSql, so even a provider unsupported for standalone recreation can be supplied by its extension. General extension prerequisite discovery and installed extension/locale/privilege requirements remain existing limits.
- No new actionable regression found in this diff. Enum/domain/array support remains the agreed scope. Composite/range types, user functions, sequence settings/state and search_path remain documented limits; this review does not expand the fidelity claim. Restore/import authorization paths are unchanged.

### Test quality and verification

- `npm run build`: **passed** (TypeScript and Vite). Existing node:zlib browser externalization, ineffective dynamic imports and large-chunk warnings remain.
- `npm run test:run -- --exclude '**/.claude/**' src/screens/connection/hooks/useDatabaseBackup.types.test.ts src/screens/connection/hooks/useDatabaseBackup.restore.test.ts src/screens/connection/hooks/useDatabaseBackup.free.test.ts src/lib/dump src/components/editor/splitSqlStatements.test.ts`: **6 files / 64 tests passed**.
- New tests provide useful exact-output assertions rather than only substring checks. Builtin fidelity, unsupported-provider refusal and extension-only discovery through a domain are covered at the builder boundary; existing ICU/libc and adjacent backup/restore cases still pass.
- **Nonblocking coverage gaps:** positional mocked catalog rows do not execute the discovery SQL or validate real LEFT JOIN NULL behavior. Unknown-provider coverage checks builder rejection, not the hook's dialog/no-write/finally behavior. Shared extension deduplication across type and collation dependencies is not directly asserted. These paths were inspected statically; no defect established. Extension-owned collation restore remains unit-tested only, as reported; no supplied live extension fixture was available.
- **Independent live verification unavailable:** `docker image ls` failed with permission denied on `unix:///Users/lamtung/.orbstack/run/docker.sock`; this session cannot escalate. No container started or database touched. The reported builtin PG17 round trip is acknowledged as implementer evidence, not reviewer execution. No desktop/native UI or Rust checks: no affected UI/native/Rust source in this diff.
- Only `.agent/REVIEW.md` changed. Unrelated untracked `.claude/launch.json` preserved. No commit, push or merge.

## Re-review (round 12): PostgreSQL statement splitting

**Status: CHANGES REQUIRED.** Reviewed exactly `ea047ed..19fc1f7` on `fix/backup-restore-safety` (2026-10-27); checkout HEAD is `19fc1f75b18b0a5be7154505d80a540145c90d84`. Read all 10 changed files and traced their affected dump, query-runner, classifier, cursor, error-position and Explain paths. No application source or committed tests modified.

### P1 — Preserve escape mode across PostgreSQL string continuations

**Location:** `src/components/editor/splitSqlStatements.ts:178`–`:181`; callers `src/lib/tauri/queryValidate.ts:118`, `src/screens/connection/hooks/useSqlRunner.ts:628`.

This valid PostgreSQL statement is one SELECT whose value contains the DELETE text:

```sql
SELECT E'a'
'\'; DELETE FROM victim; --';
```

PostgreSQL resumes the original E-string escape mode when a string continues across newline-separated quotes. The new splitter instead recomputes `singleEscapes` from the character immediately before each opening quote. The continuation has no E prefix, so its backslash becomes literal and its escaped quote incorrectly closes the string. Reproduced three client fragments: `SELECT E'a'` plus newline plus `'\'`, `DELETE FROM victim`, and the trailing comment. The previous default splitter returns one fragment for this input.

**Execution reproduced:** a temporary copy of the existing sequential-runner test used the real `validateSqlClient`, mocked backend validation to reject the malformed first fragment, and observed `onRunSql` dispatch `DELETE FROM victim`. `stopOnError` defaults to false (`useSqlRunner.ts:285`), and the loop continues after that validation error (`:566`–`:584`). Server rejection of the first fragment therefore does not contain the editor regression. Lock/Production classify and block the exposed DELETE; Default remains affected. The new row writer does not emit continued literals, and restore stops on the first invalid fragment; this reproduction establishes the editor path, not a second generated-row restore exploit.

Preserve the string kind across PostgreSQL quote continuation, including permitted intervening whitespace/line comments. Add splitter and real-runner regression coverage asserting that literal contents never reach a second dispatch, including when the first backend validation fails. PostgreSQL's [scanner source](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/parser/scan.l) explicitly restores `state_before_str_stop` in its `quotecontinue` rule.

### P1 — Escape object names used in dump comments

**Locations:** `src/screens/connection/hooks/useDatabaseBackup.ts:1044`, `:1080`, `:1090`; execution sink `:1283`.

**Preexisting adjacent security defect, explicitly included in this review's generated-comment scope.** A source table named `x` + LF + `DROP TABLE victim;--` is legal PostgreSQL and fits its identifier length limit. It is quoted correctly in CREATE/INSERT identifiers, but is copied raw into section comments. For example, the generated structure header becomes:

```sql
-- Structure public.x
DROP TABLE victim;--
CREATE TABLE IF NOT EXISTS "public"."x
DROP TABLE victim;--" (v text);
```

The first split statement is the header comment followed by executable `DROP TABLE victim`. A reviewer restore-hook fixture matching the actual Structure/Data templates dispatched that statement in Default mode. A source schema owner can therefore cause unrelated target objects to be dropped when the user restores an otherwise application-generated dump with sufficient target privileges. This is a separate capability from the reported row-only attacker: it requires control of a source schema/table name. Generic restore confirmation and correct `qIdent` escaping do not protect comment interpolation. Post-data uses the same unsafe pattern. This also needs addressing for existing dumps; merely sanitizing newly generated headers leaves old malicious headers executable.

Omit untrusted names from SQL comments or encode CR/LF so each generated comment stays on one physical line. Cover schema and table names at all three emission sites, and test backup output through restore dispatch. Define handling for old affected dumps rather than claiming all old dumps safe. PostgreSQL permits newlines in [quoted identifiers](https://www.postgresql.org/docs/17/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS).

### P2 — Use the execution dialect for error-position mapping

**Location:** `src/components/editor/SqlEditorPane.tsx:359`–`:362`.

The runner now splits PostgreSQL SQL by its dialect, but `runStatementStarts(errorMarker.runSql, splitSqlStatements)` still supplies the default splitter. Reproduced with `SELECT '\'; SELECT missing_column;`: execution has two statements; error mapping has one. A second-statement error indexes an absent entry, so the editor clears its highlight instead of marking the failing statement. Pass an engine-aware splitter here too and cover second-statement offsets after backslash-containing PostgreSQL literals. This is a regression from changing execution splitting without updating the shared position path.

### Reported injection and remaining dialect assessment

- **Original row payload:** closed under PostgreSQL `standard_conforming_strings=on`. The legacy `('\', ';DROP TABLE victim;--')` row now stays one INSERT. New values containing backslashes use E-strings with doubled backslashes and doubled quotes (`sqlInsertLiteral.ts:16`); ordinary values double quotes. This applies to Str, JSON/JSONB, string elements of supported arrays, array fallback strings, BytesB64 and plain-string fallback paths. Reviewer probes exercised 432 combinations of quotes, backslashes, semicolons, comment markers, dollar tags, Unicode and CR/LF in values/identifiers; every generated INSERT stayed one statement plus a sentinel SELECT. These are lexical checks, not database round trips. Existing bytea/base64 and custom-array fidelity are not validated or repaired by this patch.
- **Identifiers / preamble:** `qIdent` delegates to double-quote doubling (`src/lib/sql/sqlDialect.ts:48`); PostgreSQL splitting now correctly treats backslash as literal inside those identifiers. Schema/type/extension/sequence/collation names use that boundary. Enum labels come from server `quote_literal`; domain/table types, defaults, CHECKs, constraints and indexes come from PostgreSQL deparsers. Collation locale/rules now use the same E-string writer. No additional backslash boundary break established on these emission paths. Server-derived expressions remain executable schema content, not a promise that arbitrary source schema code is harmless. The comment finding above prevents an all-generated-content safety verdict.
- **Older dumps / session settings:** old plain backslash literals are interpreted correctly by the new splitter for standard-conforming strings. It does not inspect or enforce `standard_conforming_strings`, and plain literals in old/external dumps can disagree with a server running with it off. The new E-string writer resolves that ambiguity only for newly quoted values. Do not generalize Claude's new-literal on/off round trips to old dump compatibility or to every catalog expression. No additional old-dump server-side injection was established here; native PostgreSQL normally prepares one statement (`src-tauri/src/engines/postgres/operation.rs:236`), which rejects an accidentally bundled multi-command string.
- **E-prefix boundaries:** ASCII identifier suffixes, digits, `_` and `$` are excluded. The guard at `splitSqlStatements.ts:181` omits PostgreSQL's non-ASCII identifier characters: for a legal custom type named `ée`, `SELECT ée'a\'; SELECT 2;` is incorrectly treated as an E-string and merged. This is an additional lexer disagreement, not a demonstrated generated-dump injection. Use PostgreSQL identifier-token rules rather than an ASCII-only preceding-character check.
- **U& / B / X / N:** U& string/identifier backslash Unicode escapes do not lexically escape quote delimiters; B/X do not enable backslash quote escaping; N follows ordinary string handling and thus the session-setting caveat above. Basic U&, B, X, N probes preserve statement boundaries under standard-conforming strings. Comments and semicolons inside ordinary/E strings, quoted identifiers and recognized dollar bodies stay data; nested PostgreSQL block comments now work.
- **Other retained splitter gaps:** `scanDollarTag` (`:3`–`:18`, `:197`) rejects valid Unicode tags such as `$é$`, accepts invalid digit-leading `$1$`, and recognizes `$tag$` inside unquoted identifiers. `SELECT $é$one;DROP TABLE victim;--$é$;` is over-split; an identifier such as `foo$tag$` can merge later commands. The line-comment scanner (`:72`) recognizes LF only although PostgreSQL also ends comments at CR. Backticks still enter a quote state even in PostgreSQL. These behaviors predate the patch; no new generated-dump exploit was established from them. They remain reasons not to describe this splitter as a complete PostgreSQL lexer. Unterminated quotes/comments are returned as a tail without a diagnostic; server rejection is required, and editor continue-on-error makes incorrect earlier splits consequential as demonstrated above.
- **MySQL/MariaDB and other engines:** the default branch preserves previous quote/comment/tag behavior; no intentional behavior change found. Doubled backslashes plus doubled single quotes in newly written MySQL/MariaDB row strings keep quote boundaries under both backslash modes, but `NO_BACKSLASH_ESCAPES` restores doubled backslashes as doubled data. External/older dump literals and SHOW CREATE output can still disagree with the fixed default splitter. No live MySQL/MariaDB fidelity claim; unchanged is not proof of safety. Other engines retain the old default behavior. Application engine values are canonical `postgres`; the helper does not normalize aliases/case, but no affected application caller supplies those aliases.
- **Cursor, gates and Explain:** current-statement Run/Explain picks now receive `engine`, and the Run callback dependency includes it. Selection/Run All then use the runner's dialect. Existing Lock/Production checks classify each split fragment with the engine and both backslash readings; they block the exposed DELETE but cannot reverse a bad split in Default. PostgreSQL Explain uses `pgStatements`/`pgLexer`, not this splitter; Explain Analyze retains its own classification/native checks. Cursor picking still feeds both paths, so inconsistent lexers can select/refuse the wrong fragment. No new execution through Explain established; lexer unification must preserve its unterminated-input refusal and estimated-versus-measured behavior.

### Test quality and verification

- `npm run build`: **passed** (TypeScript and Vite). Existing `node:zlib` externalization, ineffective dynamic imports and large-chunk warnings remain.
- `npm run test:run -- --exclude '**/.claude/**' src/components/editor/splitSqlStatements.test.ts src/lib/tauri/queryValidate.client.test.ts src/screens/connection/hooks/sqlInsertLiteral.test.ts src/screens/connection/hooks/useDatabaseBackup.restore.test.ts src/screens/connection/hooks/useDatabaseBackup.types.test.ts src/screens/connection/hooks/useDatabaseBackup.free.test.ts src/screens/connection/hooks/useSqlRunner.test.ts src/lib/dump src/lib/sql`: **16 files / 262 tests passed**. The `useSqlRunner.test.ts` argument has no matching file; actual runner suites were run separately below.
- `npm run test:run -- --exclude '**/.claude/**' src/lib/queries/sql/explain.test.ts src/lib/query-analyzer src/lib/tauri/explainAnalyze.test.ts src/screens/connection/hooks/useSqlRunner.safety.test.ts src/screens/connection/hooks/useSqlRunner.sequential.test.ts src/screens/connection/hooks/useSqlRunner.explainAnalyze.test.ts src/components/editor/SqlEditorPane.persist.test.tsx src/components/editor/sqlErrorRange.test.ts`: **11 files / 163 tests passed**. The final `sqlErrorRange.test.ts` argument has no matching file; actual `src/lib/sql/errorPosition.test.ts` coverage was included by the first run's `src/lib/sql` directory.
- Temporary reviewer fixtures outside the repository copied the existing sequential-runner and restore suites and added one dispatch reproduction each: **2 files / 37 tests passed**, including the two assertions of unsafe behavior. Passing reproduction tests demonstrate defects, not safe behavior. Separate Node probes confirmed old/new continuation splitting, error-marker mismatch and the 432 writer combinations. No committed source/test files changed.
- New committed tests use exact statement lists and a useful restore dispatch assertion for the original payload. Missing: continued E-strings, Unicode E boundaries/tags, CR comments, unclosed-input diagnostics, generated comment-name injection, and matching editor error offsets. The JSON writer's manual escape reversal checks an implementation-shaped property rather than PostgreSQL parsing; retain real-server coverage and add exact-output adversarial fixtures. The restore regression uses a handcrafted old-style dump and does not verify the new writer-to-restore chain. No new integrated cursor-selection test was added.
- **Live verification unavailable:** `docker image ls` failed with permission denied on `unix:///Users/lamtung/.orbstack/run/docker.sock`. Local libpq has client tools but no `postgres` server binary. No container or database touched. Claude's disposable postgres:17 on/off literal round trips are implementer evidence, not independently repeated here. No desktop/native UI exercised; no Rust source changed, so Rust checks were not run.
- Only `.agent/REVIEW.md` changed; unrelated untracked `.claude/launch.json` preserved. No commit, push or merge.


## Re-review (round 13)

**Status: CHANGES REQUIRED.** Reviewed exactly `19fc1f7..9e57536` on `fix/backup-restore-safety` (2026-10-27), HEAD `9e57536ab868bb0f7f29b15030c831d4bae44320`. Read all six changed files and traced splitter, runner, comment emission and error mapping. No application source or committed tests changed.

### P1 — Vertical tab before the first newline still exposes E-string data as executable SQL

**Location:** `src/components/editor/splitSqlStatements.ts:44`, used at `:230`; dispatch/error continuation: `src/screens/connection/hooks/useSqlRunner.ts:485`, `:573`.

`PG_STRING_CONTINUATION` omits `\v` from its initial `[ \t\f]` class, although it includes it after the first newline. PostgreSQL's [REL_17_STABLE scanner](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/parser/scan.l#L205-L226) includes vertical tab in `non_newline_space`, which participates before that newline. Thus this valid single PostgreSQL SELECT still reproduces round 12's editor injection (JavaScript notation makes the control character explicit):

```js
"SELECT E'a'\v\n'\\'; DELETE FROM victim; --';"
```

The splitter returns `SELECT E'a'` + VT + LF + `'\'`, then `DELETE FROM victim`, then `--';`. The server keeps the continuation in E-string mode, so DELETE is literal data. A temporary real `useSqlRunner` fixture in Default mode, using real client validation, rejected the first fragment through mocked backend validation and confirmed `onRunSql` receives exactly `DELETE FROM victim`. Direct-result mocks complete each dispatch; default `stopOnError=false` permits progression after the first error. This is an editor execution defect, not a demonstrated newly generated row-dump exploit: the writer does not emit continued literals.

Include vertical tab in the initial continuation whitespace class. Add exact splitter and real-runner regressions for VT before the first newline, including after spaces/line comments, with first-fragment backend rejection. Prefer a table of PostgreSQL whitespace characters in both pre/post-newline positions so the claimed scanner equivalence is actually tested.

### Round 12 findings and other requested edge cases

- **E-string continuation — partially resolved, still blocking.** Ordinary LF/CR continuation, multi-part continuation and intervening `--` comments retain escape mode. The VT counterexample above prevents closure of this finding. A plain string followed by newline then `E'…'` starts a new E token: the intervening E prevents continuation matching and its own prefix enables escapes. A block comment between parts prevents lexical continuation, matching PostgreSQL; the next plain string therefore does not inherit E mode. `U&'…'` continuation remains plain lexical quote handling; Unicode escapes do not make backslash escape the quote delimiter. Targeted Node probes confirmed these boundaries. Invalid SQL adjacency remains for the server to reject.
- **Comment-name injection — resolved for newly generated dumps, historical limitation retained.** `src/screens/connection/hooks/useDatabaseBackup.ts:41` replaces CR/LF and other controls; Structure (`:1093`), Data (`:1103`) and Post-data (`:1057`) all call the helper for both schema and table names. Quoted SQL identifiers retain their existing escaping. No other untrusted name interpolation into generated section comments found. Previously produced dumps retain raw dangerous comments; no migration/detection was added. This is explicitly acknowledged, not an all-old-dumps safety verdict.
- **Error-position dialect — resolved by inspection.** `src/components/editor/SqlEditorPane.tsx:360` passes the engine-aware splitter and `:393` includes engine in effect dependencies. Execution/error mapping now use the same splitter contract. No dedicated second-statement error-marker regression was added.
- **Dollar tags / closing match:** PostgreSQL opener rules now accept non-ASCII tags and reject digit-leading tags and tags inside identifiers (`splitSqlStatements.ts:17`). Default dialect still uses the original opener at `:254`; `$1$` compatibility remains. The exact closing-tag check (`:140`) correctly ignores opener-boundary rules inside bodies and handles overlapping candidate tags (probe: `SELECT $a$x$b$a$; SELECT 2;` yields two statements). No regression established from that change in either dialect.
- **CR / backticks / Unicode E boundaries:** PostgreSQL line comments now end on CR and backticks remain ordinary characters; non-ASCII identifier suffixes no longer falsely activate E escapes. These fixes match the requested scanner rules. CR termination also changes default mode; no concrete regression established.
- No additional app-generated PostgreSQL name/value-to-statement escape established in this diff. Prior limits remain: `standard_conforming_strings` is not tracked for old/external plain literals, malformed tails rely on backend rejection, and schema expressions are executable source content. This review does not certify a complete PostgreSQL parser or arbitrary external dump safety.

### Test quality and verification

- `npm run build`: **passed**, TypeScript and Vite. Existing browser externalization of `node:zlib`, ineffective dynamic imports and large-chunk warnings remain.
- `npm run test:run -- --exclude '**/.claude/**' src/components/editor/splitSqlStatements.test.ts src/lib/tauri/queryValidate.client.test.ts src/screens/connection/hooks/sqlInsertLiteral.test.ts src/screens/connection/hooks/useDatabaseBackup.restore.test.ts src/screens/connection/hooks/useDatabaseBackup.types.test.ts src/screens/connection/hooks/useDatabaseBackup.free.test.ts src/screens/connection/hooks/useSqlRunner.safety.test.ts src/screens/connection/hooks/useSqlRunner.sequential.test.ts src/screens/connection/hooks/useSqlRunner.explainAnalyze.test.ts src/lib/dump src/lib/sql src/components/editor/SqlEditorPane.persist.test.tsx`: **20 files / 333 tests passed**.
- Temporary reviewer real-runner suite: **1 file / 11 tests passed**, including the assertion of unintended DELETE dispatch above. Passing reproduction demonstrates the defect, not safety. Initial outside-root fixture attempts failed module loading; initial stream-result mocks timed out awaiting completion. Final fixture used direct-result responses and completed successfully. Temporary fixture/config removed.
- New exact splitter assertions and the Default-mode real-runner test are useful and catch the original LF payload. Coverage misses VT before the first newline and the first-backend-validation-error path. The dump-name test checks helper-to-splitter output for a table name in Structure only; schema-name coverage, all three emitted sections and actual backup-to-restore dispatch remain untested. Static call-site inspection supports the fix, but the test is not an end-to-end backup regression. Error-position mapping has no new dedicated assertion.
- Independent Node probes transpiled the actual splitter and exercised VT, plain-to-E, block-comment separation, U& continuation, Unicode/default tags and overlapping closing tags. PostgreSQL behavior checked against upstream scanner source; no live PostgreSQL server, database writes, native dialogs or desktop UI exercised. No Rust changes, so no Rust checks run.
- Only `.agent/REVIEW.md` changed. Unrelated untracked `.claude/launch.json` preserved. No commit, push or merge.


## Re-review (round 14)

**Status: VERIFIED WITH LIMITATIONS.** Reviewed exactly `9e57536..6f95c52` on `fix/backup-restore-safety` (2026-10-27), HEAD `6f95c527003032214c05937b80ec60a674b0bc9f`. Scope: round 13 P1, regressions introduced by this commit, continuation equivalence with PostgreSQL 17, and the new tests. Read all three changed application/test files; the fourth changed file is the preceding review report. No source or committed tests modified.

### Findings and resolution

- **Round 13 P1 — resolved.** `src/components/editor/splitSqlStatements.ts:47` now includes VT in the pre-newline class as well as post-newline whitespace. The continuation branch at `:233` preserves the original E-string escape mode for the reported payload, keeping `DELETE FROM victim` inside the SELECT literal. The only runtime change is this PostgreSQL-only regex expansion; default-dialect splitting is unaffected. No new blocking finding.
- **Continuation grammar — matches the requested scanner rules.** Compared directly with upstream [REL_17_STABLE scan.l](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/parser/scan.l#L205-L226): initial alternatives represent `non_newline_whitespace`, followed by a mandatory LF/CR, then repetitions of `special_whitespace`. All six whitespace characters match; line comments exclude CR/LF and post-newline comments require their terminating newline. CRLF works as two newlines. Block comments, Unicode spaces, bare horizontal whitespace without a newline, and executable tokens between string parts do not qualify. The scanner's quote-continuation action restores its preceding string state (`scan.l:559–565`), matching retained `lastSingleEscapes`. No remaining disagreement found within this continuation rule. This does not certify the entire splitter or remove earlier session-setting/external-dump limitations.

### New tests

- `src/components/editor/splitSqlStatements.test.ts:258–270`: 147 table-driven cases (7 before × 3 newline × 7 after) exercise VT, space, tab, form feed, empty sides, mixed horizontal whitespace, LF/CR/CRLF, and line comments. Assertions require two statements, retained DELETE text in the first, and a separately executable `SELECT 2`. These catch the original pre-newline VT defect. The matrix does not enumerate every combination of multiple comments/control characters, so independent probes below supplement it.
- `src/screens/connection/hooks/useSqlRunner.safety.test.ts:94–104`: uses the real hook and client validation in Default mode, with the first backend validation mocked to reject. Confirms no dispatched statement starts with DELETE. Traced `useSqlRunner.ts:473–485` and `:561–573`: rejection is caught before dispatch and default continue-on-error can proceed to later fragments, so the test addresses the consequential path. The assertion loops over calls and does not separately assert the validation call/full SQL, error state, or zero total dispatches; this is a non-blocking test-strength limitation, supported by explicit splitter coverage. The shared stream mock would leave an incorrectly split intermediate DELETE waiting for stream completion; a regression can therefore fail by timeout instead of the DELETE assertion. A direct-result mock plus explicit validation/dispatch counts would improve failure diagnostics.

### Verification

- `npm run build`: **passed**, TypeScript and Vite. Existing `node:zlib` browser externalization, ineffective dynamic-import and large-chunk warnings remain.
- `npm run test:run -- --exclude '**/.claude/**' src/components/editor/splitSqlStatements.test.ts src/lib/tauri/queryValidate.client.test.ts src/screens/connection/hooks/sqlInsertLiteral.test.ts src/screens/connection/hooks/useDatabaseBackup.restore.test.ts src/screens/connection/hooks/useDatabaseBackup.types.test.ts src/screens/connection/hooks/useDatabaseBackup.free.test.ts src/screens/connection/hooks/useSqlRunner.safety.test.ts src/screens/connection/hooks/useSqlRunner.sequential.test.ts src/screens/connection/hooks/useSqlRunner.explainAnalyze.test.ts src/lib/dump src/lib/sql src/components/editor/SqlEditorPane.persist.test.tsx`: **20 files / 481 tests passed**.
- Independent in-memory Node probe transpiled the actual splitter and compared its actual regex with a procedural whitespace/comment scanner. Enumerated token sequences through length four plus targeted mixed-comment, block-comment, unterminated-comment and Unicode-space cases: **16,110 separators, zero grammar mismatches**. All **2,508 accepted continuations** also retained the injected-looking DELETE in the first literal and split the final `SELECT 2` correctly. No temporary source/test files created.
- **Limits:** scanner-source comparison and mocked backend dispatch only; no live PostgreSQL server execution, database writes, native dialogs or desktop UI exercised. Older-version VT behavior was not independently executed. No Rust change, so no Rust checks run. Earlier documented external-dump/session-setting limits remain outside this narrow closure.
- Only `.agent/REVIEW.md` modified. Unrelated untracked `.claude/launch.json` preserved. No commit, push or merge.
