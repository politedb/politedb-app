# Query Analyzer

Query Analyzer visualizes PostgreSQL JSON execution plans in the SQL results pane.
Other database engines retain their existing result table.

## Estimated plan

Open a PostgreSQL SQL editor, select one statement and click **Explain**. PoliteDB
uses the existing `EXPLAIN (FORMAT JSON)` flow. The analyzer opens when that result
finishes, for both direct and streamed results.

Estimated plans do not contain query execution timing. Planner costs are not
milliseconds. Missing measurements are shown as unavailable, never as zero.

## Measured plan

For a query you have reviewed and explicitly want to execute, run this form through
the normal SQL editor **Run** action:

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT ...;
```

**ANALYZE executes the statement.** Writes and function side effects may occur;
even a SELECT may call side-effecting functions or consume substantial resources.
Use an appropriate test environment and permissions. The analyzer does not
automatically run ANALYZE, execute recommendations, change indexes, or change
database settings.

## Views

- **Plan:** node hierarchy, filter, estimated costs, available runtime measurements
  and selected-node details. Large trees are paged, not silently truncated.
- **Recommendations:** conservative heuristics for filtered sequential scans,
  row-estimate mismatch, disk sorts and multi-batch hashes. Findings are review
  prompts, not proof that a query is slow or a particular index is needed.
- **Compare:** import a baseline PostgreSQL JSON plan to compare available metrics.
  The app does not verify query identity, parameters or measurement conditions.
- **JSON:** original structured plan.
- **Report / JSON export:** native save dialog, with a privacy confirmation.
  JSON exports can be imported as comparison baselines.

Node timings and buffers include child work and must not be summed. Actual rows
and timings are averages per loop. Parallel timings can overlap. Compare repeated
measurements using representative data and comparable server/cache conditions.

## Limits and privacy

- No automatic slow-query collection or `pg_stat_statements` integration yet.
- No AI service or external request is made to analyze a plan.
- Imports are local JSON files, limited to 5 MB, 5,000 plan nodes and bounded
  document complexity. Unsupported/malformed query results retain the raw table.
- Plans can include private identifiers, predicates and literal values. Review
  exported reports before sharing.

Reference: [PostgreSQL EXPLAIN](https://www.postgresql.org/docs/current/sql-explain.html).
