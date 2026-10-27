# PostgreSQL backup fidelity review

## Status

CHANGES REQUIRED

Fresh review of `main..HEAD` on `fix/postgres-backup-fidelity`, base `663844e8898980a965ae1d7cb988c57c00955b08`, HEAD `adfcce35200124f34a4c1b739b62ffbca5972291` (2026-10-27). Reviewed both commits, `0d3e358` and `adfcce3`, all five changed files, and affected backup, restore, grid, filter, catalog, preview and history paths. This report replaces the prior branch's review. No application source or repository tests changed.

## Findings

### P1 — Normalize the session before converting backup values to text

**Location:** `src/screens/connection/hooks/useDatabaseBackup.ts:424`, `:440` (backup header at `:1077`; PostgreSQL execution transaction in `src-tauri/src/engines/postgres/operation.rs:168`).

Every PostgreSQL value now passes through server text conversion, but neither that transaction nor the dump establishes a formatting contract. The native operation only scopes timeouts/read-only mode. Restoring quoted unknown literals against destination columns recovers the type, not formatting information or digits already discarded by the source.

- With source `DateStyle = 'SQL, DMY'`, a date representing 2026-02-01 is exported as `01/02/2026`; a normal MDY restore interprets it as January 2. Other dates fail outright. Timestamp columns and temporal elements inside arrays/composites inherit the same risk. Before this change, supported scalar dates/timestamps were decoded from binary into ISO/chrono strings.
- With source `extra_float_digits = -1`, a float8 such as `1.2345678901234567` is rounded to 14 significant digits before reaching the writer. A quoted literal cannot restore the discarded bits. This newly affects previously binary-decoded floats, including array/geometric text output where applicable. The default setting is precise; a valid nondefault setting is enough to break the claimed fidelity.
- `IntervalStyle` changes both interval output and interpretation of signs. For example, a negative day/time output in SQL-standard form can acquire different component signs under the traditional parser. `money` output depends on `lc_monetary`, including punctuation and fractional precision; another target locale can reject or reinterpret it. These types were not reliably supported by the old binary fallback either, but the new text path still needs an explicit compatibility contract.

Establish canonical `DateStyle`, `IntervalStyle`, and precise `extra_float_digits` **inside the same transaction/session that reads each stream**, with compatible parsing on restore. Prefer ISO timestamps with numeric offsets; changing target TimeZone alone then preserves the instant. Handle money by an explicit matching locale contract or a demonstrably lossless representation, and refuse incompatible restores rather than silently guessing. A separate pooled `SET` call or restore-only settings cannot repair source-side rounding. Add disposable-server regressions with differing source/target settings and equality checks, including nested values. These are static/code-and-documentation findings; the SQL examples were not executed locally.

References: [PostgreSQL formatting settings](https://www.postgresql.org/docs/17/runtime-config-client.html#RUNTIME-CONFIG-CLIENT-FORMAT), [interval signs and input](https://www.postgresql.org/docs/17/datatype-datetime.html#DATATYPE-INTERVAL-INPUT), [money dump portability](https://www.postgresql.org/docs/17/datatype-money.html).

### P2 — Use the type's output representation, not an arbitrary cast to text

**Location:** `src/screens/connection/hooks/useDatabaseBackup.ts:424`.

`column::text` can invoke a user-defined cast whose result differs from the type's output function. Consequently it is not universally equivalent to pg_dump's data serialization. A supported enum with a custom cast is a concrete regression: the old `EnumLabel` reader returned the stored label; the new projection can return a different label or text that the enum input rejects.

Disposable-only reproduction to add (not executed here): create enum `review_mood AS ENUM ('happy')`; define `review_mood_text(review_mood) RETURNS text` as an immutable SQL function returning constant `'HAPPY'`; register `CREATE CAST (review_mood AS text) WITH FUNCTION review_mood_text(review_mood)`; insert `'happy'` into an enum column and back it up. The new projection exports `'HAPPY'`, which cannot restore to that enum. No destination cast or string escaping can recover the original label.

Read values through PostgreSQL's actual type-output path (for example, a suitable native text-protocol/export adapter), or detect unsupported custom conversion semantics and refuse the backup. Add an enum/custom-cast regression. PostgreSQL explicitly allows custom casts to replace automatic string conversions and behave differently from I/O: [CREATE CAST notes](https://www.postgresql.org/docs/17/sql-createcast.html#SQL-CREATECAST-NOTES).

## Compatibility and scope assessment

- **Destination typing:** the stream now reports `text` columns and `Str` cells, so `formatSqlInsertChunk` quotes them without JS number/JSON conversion. Direct `INSERT INTO target (columns) VALUES (...)` gives unknown literals the destination type, including multi-row INSERTs. Ordinary domains retain their input checks; arrays, enums, ranges, composites and extension types use their input functions, subject to the findings and availability of their DDL/extensions. This fixes the binary decoder's NULL/base64 fallbacks for many values. It does not establish universal type or schema support.
- **Exact and special values:** large integers and numeric values bypass JS Number and rust_decimal limits; numeric scale/text, NaN, Infinity, -Infinity, temporal infinity and SQL NULL can reach the target input unchanged. Native text output for arrays preserves dimensions, lower bounds, type delimiters, NULL elements and nested element escaping that the grid's JSON representation cannot universally preserve. Floating-point finite precision still requires P1's session fix. A 1 MB string and a 10,000-digit string passed helper/splitter probes, not a server/IPC round trip or maximum-size stress test.
- **Generated/identity columns — pre-existing limitations:** the column list includes generated and identity columns. `buildPostgresTableStructure` reads neither `attgenerated` nor `attidentity`: a generated expression is emitted as DEFAULT, and identity metadata/sequence ownership is not recreated. INSERTs do not omit generated values or emit `OVERRIDING SYSTEM VALUE`. Thus restoring to an existing generated/GENERATED ALWAYS identity column fails; new-table DDL also loses or rejects their semantics. BY DEFAULT identity accepts explicit values but sequence advancement is not supplied. These defects also exist on main and are not new findings against these two commits. Do not claim generated/identity end-to-end fidelity.
- **Names:** the new SELECT quotes schema, table, every column and alias independently, doubles embedded double quotes, and avoids the old `tableExportQuery` whitespace normalizer. Spaces, equals signs, backslashes and SQL-looking name content remain identifier data in this new query. Existing catalog queries still have the limitations below; query-level quoting does not certify all backup name paths.
- **Restore/splitter:** restore selects `splitDialectFor(rt.engine)`. Backup strings containing backslashes already use E strings with doubled backslashes and doubled apostrophes; the PostgreSQL splitter recognizes that form. New grid literals use the same rule. Probes included quote/backslash combinations, SQL-looking suffixes, dollar tags, comments, CR/LF, Unicode and large values; the following `SELECT 2` always remained a separate second statement. Finite helper probes do not certify arbitrary external dumps.
- **bytea output:** PostgreSQL accepts both hex and escape representations on input regardless of `bytea_output`; correctly preserved text plus the existing backup E-string quoting handles either. Changing this setting alone does not justify another finding. See [binary input/output formats](https://www.postgresql.org/docs/17/datatype-binary.html).
- **bytea[] grid path:** `Vec<Option<Vec<u8>>>` now produces JSON strings containing PostgreSQL hex text, rather than base64. `formatSqlValue` passes that JSON through `pgArrayValueSql`; array-layer backslashes are escaped, then E-string SQL escaping preserves them until the bytea input function. Independent decoding recovered empty bytes, SQL NULL, a sample with an apostrophe byte and every byte 00–ff. INSERT/SET/typed column-equality contexts supply the array type. Existing multidimensional/nondefault-bound codec limitations remain; persisted old base64 array snapshots are not migrated by this change. Live decode/write/readback was not exercised.
- **Shared literal caller audit:** `sqlQuotedStringLiteral` has no separate production consumers beyond `sqlStringLiteral`; `qLiteral` delegates there. `formatSqlValue` covers grid INSERT/UPDATE/DELETE, array/JSON values and clipboard SQL; patch generation and SQL DDL defaults pass engine. Database-object trigger/routine lookups also pass engine. These PostgreSQL calls now preserve literal backslashes under both standard-conforming-string modes; plain strings without backslashes retain apostrophe doubling. No additional regression found.
- **Filters/LIKE:** comparison, range and LIKE-family branches pass engine and acquire E-string protection. SQL escaping preserves the pattern's original backslashes; LIKE still interprets its own escape syntax and `%`/`_` wildcards. The change does not make literal wildcard searches automatic. IN/NOT IN and fallback equality omit engine; those remain plain strings, including under `standard_conforming_strings=off`. This omission predates the branch.
- **Catalog callers:** inspected `catalog`, `columns`, `diagram`, `mysqlStructure`, `tableData`, `tableSize`, `tableStructure`, backup catalog lookups, `databaseObjects`, and DDL builders. Many shared/catalog/backup calls omit engine, so this patch leaves their PostgreSQL backslash behavior unchanged. Existing `regexEscape` whitespace normalization also remains. The new helper's setting independence must not be attributed to those callers.
- **Preview/history:** `sqlForDisplay` leaves the newly emitted PostgreSQL E strings intact. Save Changes previews, filter previews, transaction history and clipboard SQL retain executable E syntax and doubled backslashes. QueryHistory rendering/normalization does not rewrite their content; editor lexer already supports escape strings. Generated helpers double every backslash, so these outputs do not depend on a lone backslash escaping a quote. Relevant preview/history/lexer tests passed.
- **Other engines:** the backup query branch changes only `engine === 'postgres'`; MySQL/MariaDB and other engines retain `tableExportQuery`. Shared string changes are also PostgreSQL-only, after SQL Server's existing N-string branch; MySQL-family hex/CONVERT literals and other engines' prior quoting remain. Relevant dialect, query and patch suites passed.

## Verification

- `npm run test:run -- --exclude '**/.claude/**' src/lib/sql src/lib/queries src/lib/patches src/lib/dump src/screens/connection/hooks/sqlInsertLiteral.test.ts src/screens/connection/hooks/useDatabaseBackup.types.test.ts src/screens/connection/hooks/useDatabaseBackup.restore.test.ts src/screens/connection/hooks/useDatabaseBackup.free.test.ts src/components/editor/splitSqlStatements.test.ts src/screens/connection/hooks/useSqlRunner.safety.test.ts`: **32 files / 555 tests passed**.
- Additional preview/history/lexer run with the same exclude: `src/screens/connection/sql/QueryHistory.test.tsx src/screens/connection/hooks/useSqlHistoryRunner.test.ts src/components/modal/saveReviewSql.test.ts src/components/table/TableFilterBar.test.tsx src/lib/editor/sqlLexer.test.ts`: **5 files / 48 tests passed**. Combined: **603 tests**.
- `npm run build`: **passed**, TypeScript and Vite. Warnings: node:zlib browser externalization, ineffective dynamic imports and large chunks.
- From `src-tauri`, `cargo test row_codec`: **10 passed / 1 ignored** (2 PostgreSQL unit tests and 8 MySQL codec tests passed; `row_codec_enum_live` ignored).
- Independent actual-module probe `/tmp/politedb-fidelity-review.cjs`: **1,524 literal/splitter cases passed**, bytea array-layer decode checks passed, six filter operator paths passed. Uses TypeScript transpilation and an independent decoder for the emitted restricted literal form; no mocked server results or SQL execution. Script remains outside the repository.
- **Live limitation:** Docker daemon socket access was denied by the environment; no PostgreSQL server executable was found in the checked Homebrew/Postgres.app locations. The ignored test was not run. No saved profile, customer database, live database writes, desktop UI or native round trip accessed. Before verification, run disposable PostgreSQL equality tests for session settings, custom casts, generated/identity behavior and bytea[] grid writes.
- Only `.agent/REVIEW.md` changed. Existing untracked `.claude/launch.json` preserved. No source edits, commit, push or merge.

## Round 2 — commit `20dde29` (2026-10-27)

### Status

CHANGES REQUIRED

Re-reviewed `20dde29a1a325cfd219f0e46c2267f260126a89e` on `fix/postgres-backup-fidelity` using `git show 20dde29`, all six changed files and the affected stream/INSERT paths. Round 1's custom-cast finding is resolved. Its formatting finding is resolved for dates, intervals and floats, but remains open for money portability.

### Findings

#### P1 — Money numeric text still restores through the locale-sensitive money parser

**Location:** `src/screens/connection/hooks/useDatabaseBackup.ts:435-437`; downstream `src/screens/connection/hooks/sqlInsertLiteral.ts:106-107`.

`money::numeric::text` removes source currency punctuation, but the writer emits the result as an untyped quoted literal, e.g. `'1234.56'`. Assignment into a money column invokes `cash_in`, not `numeric_cash`. With a target locale using comma decimals and dot thousands separators (e.g. an installed German locale), `cash_in` skips the dot as a thousands separator: the exported amount 1234.56 becomes 123456.00. A negative amount likewise changes magnitude. Domains over money take the same input path. This is silent data corruption, even when source and target use the same comma-decimal locale, because the new numeric text always uses a dot.

This conclusion is based on PostgreSQL 17 source inspection, not a live reproduction: `cash_in` obtains decimal/thousands symbols from `lc_monetary`, skips thousands separators while scanning digits, then pads fractional digits. See [cash.c](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/utils/adt/cash.c#L203-L215), [digit parsing](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/utils/adt/cash.c#L274-L322) and [money portability documentation](https://www.postgresql.org/docs/17/datatype-money.html).

Preserve the numeric type through restore, e.g. an explicitly numeric SQL expression whose assignment uses numeric-to-money conversion, including destination domains, or establish and enforce a compatible locale contract on every restore statement. Also handle/refuse incompatible target fractional precision and range rather than silently rounding. Add disposable-server equality regressions for positive/negative values, NULL, domains, precision/range boundaries, and comma-decimal targets. A source-only numeric cast is insufficient.

#### P1 — Money nested in arrays/composites bypasses the portability handling

**Location:** `src/screens/connection/hooks/useDatabaseBackup.ts:435-438`, `:462`.

`postgresMoneyColumns` recognizes scalar money and domains directly based on money. A `money[]`, domain over that array, array of money domains, or composite containing money takes `format('%s', col)`. Those output functions recursively invoke money output, retaining the source currency symbol, separators and sign conventions. The dump records no monetary locale contract; the canonical stream settings do not include one. Restoring into a different locale can reject those values or reinterpret them. Fixing only scalar INSERT expressions leaves this part of round 1's locale finding unresolved.

Provide a recursively safe serialization/restore contract, or detect money-containing types and refuse incompatible restores with a clear explanation. Cover array dimensions/lower bounds, NULL elements, negative elements, domains and composite fields in disposable-server tests. PostgreSQL's [money documentation](https://www.postgresql.org/docs/17/datatype-money.html) explicitly requires matching/equivalent monetary settings for locale-formatted dumps. This is a remaining limitation of the proposed fix, not a claim that nested money worked on main.

### Compatibility and scope assessment

- **Same statement/session:** `canonicalTextOutput` is forwarded as `canonical_text_output` in the stream payload. The PostgreSQL runner begins `tx`, executes all three `SET LOCAL` statements on `tx`, then prepares and executes `tx.query_raw` on that same transaction. No separate pooled SET call. The normal path commits after consuming rows; early returns drop the transaction and trigger rollback. These local settings end at commit/rollback and do not become persistent pool session defaults. Supported by [SET LOCAL semantics](https://www.postgresql.org/docs/17/sql-set.html). Live pool-reuse/error/cancel assertions remain unexecuted.
- **Actual output functions:** PostgreSQL 17's `format` implementation calls `getTypeOutputInfo` and passes that function to its string conversion; it does not use a user-defined cast to text. Thus enum/custom-cast round 1 P2 is resolved. Arrays use array output, composites record output, and ordinary domains their base output; their nested elements/fields use the corresponding type output functions. This fixes conversion selection, not all type-specific environmental dependencies. See [format implementation](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/utils/adt/varlena.c#L5557-L5598), [array output](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/utils/adt/arrayfuncs.c), and [record output](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/utils/adt/rowtypes.c).
- **NULL versus all-NULL composite:** the non-VARIADIC `num_nulls(col)` call counts the argument's SQL NULL flag, without inspecting composite fields. SQL NULL remains SQL NULL; a present all-NULL two-field composite reaches record output `(,)`, not NULL or empty text. Arrays are one argument too, not expanded elements. See [count_nulls](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/utils/adt/misc.c#L132-L143). This is static verification; repository tests currently assert SQL construction rather than server behavior.
- **Temporal restore:** canonical ISO year-first dates/timestamps are unambiguous under target MDY/DMY/YMD. ISO 8601 interval designators preserve signed components without relying on target IntervalStyle. ISO timestamptz output carries its numeric offset, preserving the instant under another target TimeZone; timestamp without time zone retains wall-clock fields. Nested temporal output inherits source transaction settings. No restore-side SET is necessary for those canonical forms. See [date/time input and output](https://www.postgresql.org/docs/17/datatype-datetime.html). Extensions with additional environment-dependent I/O are not universally certified.
- **Float precision:** `extra_float_digits = 3` applies before all output evaluation, including nested built-in float output. It prevents source-session negative settings from discarding significant digits. Ordinary numeric and special-value output remains text through the writer.
- **Money domains/signs:** detected scalar domains use the precision-preserving money-to-numeric conversion and retain negative signs at export. Target domain input/constraints still run. Their locale-sensitive unknown-literal restore remains the first finding; scalar conversion does not repair arrays or composite fields.
- **Other engines/logging:** only PostgreSQL performs the added catalog query/projection and consumes the optional flag. MySQL/MariaDB and other engines keep their prior export query and execution behavior. No new logging or telemetry call in this commit; existing operation error/event and opt-in analytics paths remain in place.
- **Scope limits:** round 1's pre-existing DDL/generated/identity/catalog limitations remain. The commit message's claimed disposable 28-column equality run was not independently reproduced here and does not establish cross-locale money coverage.

### Verification

- `npm run test:run -- --exclude '**/.claude/**' src/lib/sql src/lib/queries src/lib/patches src/lib/dump src/screens/connection/hooks/sqlInsertLiteral.test.ts src/screens/connection/hooks/useDatabaseBackup.types.test.ts src/screens/connection/hooks/useDatabaseBackup.restore.test.ts src/screens/connection/hooks/useDatabaseBackup.free.test.ts src/components/editor/splitSqlStatements.test.ts src/screens/connection/hooks/useSqlRunner.safety.test.ts`: **32 files / 556 tests passed**.
- `npm run build`: **passed** (TypeScript + Vite); existing node:zlib externalization, ineffective dynamic imports and large-chunk warnings.
- From `src-tauri`, `cargo test`: compiled successfully; **430 passed / 47 failed / 21 ignored**, exit 101. Failures are outside changed backup code, in AI HTTP/model/prepare/transport and license tests; sandbox denies local listener operations (`Operation not permitted`). Full suite is not green in this environment.
- Focused `cargo test engines::postgres`: **24 passed / 5 ignored**, including operation and codec tests. No ignored/live tests enabled; no new Rust test exercises the canonical-settings branch.
- **Live limitation:** `docker info` fails with permission denied on the OrbStack Docker socket. No server binary found in checked Homebrew/Postgres.app locations (libpq provides `initdb`, but no `postgres`). No disposable server could be started; no existing/saved/customer database accessed. SQL equality, locale, pool reuse and native stream round trips therefore remain unverified live. Context7 documentation plus PostgreSQL 17 upstream documentation/source informed the semantic checks above.
- Only this round 2 section appended to `.agent/REVIEW.md`; no source/test edits, commits, pushes or merges. Existing untracked `.claude/launch.json` preserved.

**Verdict: CHANGES REQUIRED.** Fix scalar money restore typing and cover or explicitly reject incompatible nested-money restores; then re-run disposable PostgreSQL regressions. The source-format scoping and type-output fixes are otherwise sound by static inspection and the available checks.

## Round 3 — commit `8afdcf5` (2026-10-27)

### Status

CHANGES REQUIRED

Re-reviewed `8afdcf5c42b84d2f84f99d7558ccec031c468b10` with `git show 8afdcf5` on `fix/postgres-backup-fidelity` (also current HEAD), all three changed files and affected callers/error paths. Numeric assignment fixes round 2's punctuation/parser corruption when monetary fractional precision is compatible. Nested-money rejection is incomplete at the walk's depth limit.

### Findings

#### P1 — Typed numeric still silently rounds under a lower-precision money locale

**Location:** `src/screens/connection/hooks/sqlInsertLiteral.ts:102-105`; `src/screens/connection/hooks/useDatabaseBackup.ts:569-575`.

`numeric -> money` is an assignment cast, but `numeric_cash` scales by the destination session's `lc_monetary.frac_digits` and rounds to an int64. A source with two fractional digits exporting 1234.56 restores as 1235 under a zero-fraction monetary locale (for example, an installed Japanese locale). This affects scalar money, array elements and domains. Domain CHECKs evaluate the converted value; a permissive CHECK does not detect lost cents. Greater target precision can instead exceed the int64 range and fail. The dump/restore path neither records nor validates monetary precision/representability. Round 2 explicitly requested refusal of incompatible fractional precision/range, so that part remains open.

Establish and enforce a compatible monetary precision contract, or validate exact representability and reject before applying data; do not rely on numeric assignment alone. Add positive/negative rounding, precision-transition and range-boundary equality/refusal regressions, including arrays and domains. This is upstream-source verification, not a local SQL reproduction: [numeric_cash](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/utils/adt/cash.c#L1057-L1087), [assignment cast](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/include/catalog/pg_cast.dat#L80-L81).

#### P2 — Depth cutoff silently treats unexplored nested money as safe

**Location:** `src/screens/connection/hooks/useDatabaseBackup.ts:497-499`.

`length(w.steps) < 16` stops expanding a type after sixteen array/composite/range edges, then returns only money already reached. For a valid chain of seventeen composite wrappers ending in money, no money row is returned: the column takes locale-dependent `format('%s', col)` instead of throwing. Restoring into an existing matching schema can therefore retain round 2's corruption/failure. A domain encountered at depth sixteen is not even unwrapped. This gap is independent of the pre-existing omission of composite DDL.

Track visited type OIDs with a finite classification state (scalar / one array / unsupported nesting), or explicitly fail if unexplored edges remain at a resource limit. Do not interpret truncation as absence of money. Add tests beyond sixteen edges and for cyclic type graphs. `UNION` includes the growing steps string, so it alone does not deduplicate cycles across depths; the current cutoff bounds structural cycles but sacrifices completeness.

#### P2 — Unconditional multirange catalog access breaks PostgreSQL 13 backups

**Location:** `src/screens/connection/hooks/useDatabaseBackup.ts:495`.

PostgreSQL 13's `pg_range` has no `rngmultitypid`. The new query references it on every PostgreSQL table, so even an ordinary integer-only table fails during query analysis on 13 (and older versions). This introduces a server-version requirement without an explicit minimum-version gate; nearby backup code documents PostgreSQL 13+ compatibility. See [PostgreSQL 13 catalog](https://www.postgresql.org/docs/13/catalog-pg-range.html).

Build the multirange edge only for servers exposing that catalog column (or explicitly establish a supported minimum version and gate it). A CASE/WHERE condition around a missing column is insufficient because parsing still resolves it. Add a pre-14 catalog regression.

### Compatibility and scope assessment

- **Arrays/domains:** static inspection of PostgreSQL's coercion implementation supports numeric[] assignment to money[], arrays of money domains, and domains over either array, with destination domain constraints applied. Domains add no structural step; a single array edge is classified as supported. Multiple dimensions still use one array type edge. Arrays of domains over arrays produce multiple edges and are conservatively rejected. On PostgreSQL 14+, multiranges traverse to their range and then subtype; money there is rejected. Both root and composite-field dropped attributes are excluded.
- **Bounds and NULL:** built-in array coercion copies dimensions/lower bounds and maps elements, including NULLs; numeric[] text carries bounds and dimensions through the INSERT. Empty arrays and SQL NULL remain distinct. Domain NOT NULL/CHECK constraints can reject NULLs or converted amounts as intended. These are static conclusions from [array_map](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/utils/adt/arrayfuncs.c#L3008-L3167) and [coercion/domain handling](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/parser/parse_coerce.c); no independent live array/domain equality run was possible.
- **Other callers:** repository-wide search finds `exportTableToSqlParts` as the sole production `formatSqlInsertChunk` caller, and that function is the sole production `formatSqlInsertValue` caller. Clipboard INSERT generation in `CanvasTable.tsx` uses the separate `formatSqlValue` helper. Thus the new Str branch does not change clipboard literals. Genuine numeric/numeric[] Str inputs retain their numeric meaning through the explicit casts; Json arrays, NULL, I64/F64 and other engines retain their existing branches. Backup stream columns are text except for the deliberate money override.
- **Error/privacy and clean stop:** the nested-money message includes column/schema/table identifiers and guidance, but no values, SQL, credentials or paths. It is sent to the local Backup error dialog, with no added logging/telemetry call. The catalog check is awaited before starting that table's stream; rejection exits the table loop, skips packing/writeFile and success toast, and clears `dbBackupRunning` in finally. Earlier table data exists only in local memory; no partial backup file is written and an existing destination file is untouched by this error path. The message's “nothing was backed up” is accurate for file output. Failure-path integration assertions were not added or executed; this conclusion is from control-flow inspection.
- **Scope:** round 1's pre-existing DDL/generated/identity limitations remain. Numeric casting fixes differing separators at equal fractional precision, not arbitrary locale portability. The implementer's disposable de_DE evidence was not independently reproduced.

### Verification

- Relevant Vitest command with required exclusion: `npm run test:run -- --exclude '**/.claude/**' src/lib/sql src/lib/queries src/lib/patches src/lib/dump src/screens/connection/hooks/sqlInsertLiteral.test.ts src/screens/connection/hooks/useDatabaseBackup.types.test.ts src/screens/connection/hooks/useDatabaseBackup.restore.test.ts src/screens/connection/hooks/useDatabaseBackup.free.test.ts src/components/editor/splitSqlStatements.test.ts src/screens/connection/hooks/useSqlRunner.safety.test.ts`: **32 files / 558 tests passed**.
- `npm run build`: **passed** (TypeScript + Vite). Warnings: node:zlib browser externalization, ineffective dynamic imports, large chunks and plugin timings.
- Context7 PostgreSQL 17 documentation and upstream source informed semantic checks. `docker info` again fails with permission denied on the OrbStack socket; no disposable SQL server, saved/customer connection, desktop UI or native round trip accessed. Live precision/range, domain, multidimensional, depth/cycle and pre-14 SQL regressions remain unexecuted. Existing mocked tests do not execute the catalog SQL.
- Only round 3 appended to `.agent/REVIEW.md`. No source/test edits, commits, pushes or merges; existing untracked `.claude/launch.json` preserved.

**Verdict: CHANGES REQUIRED.** Enforce exact money representability, make recursive detection complete or fail closed, and preserve pre-14 catalog compatibility before claiming portable backup fidelity.
