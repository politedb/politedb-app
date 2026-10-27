# Backup / restore safety review

## Status

VERIFIED WITH LIMITATIONS

Latest review: **round 7**, `db1fb7b..d52a06d`; standard-comment regression resolved, PostgreSQL/MySQL behavior and round 4 reads preserved. No additional executable-write regression against main found. Preexisting heuristic gaps remain assigned to the separate server-side read-only task. See appended review.

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
