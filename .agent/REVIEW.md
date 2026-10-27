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
