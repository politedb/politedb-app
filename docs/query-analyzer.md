# Query Analyzer

Query Analyzer visualizes execution plans in the SQL results pane when **Explain**
runs. **Run** always shows the statement’s result grid, even if the SQL is
`EXPLAIN …`. PostgreSQL still needs JSON (`EXPLAIN (FORMAT JSON)`); malformed
JSON stays the raw table. Other SQL engines open the same Plan /
Recommendations / Compare / JSON UI from JSON, tabular, or text EXPLAIN output.
Unparseable Explain rows on those engines still open the analyzer as generic
steps instead of the result grid.

## Explain by engine

Click **Explain** on one statement. PoliteDB wraps it with the engine’s explain
form; it does not automatically run ANALYZE / STATISTICS.

| Engine                                   | Explain used                                           | Analyzer        |
| ---------------------------------------- | ------------------------------------------------------ | --------------- |
| PostgreSQL                               | `EXPLAIN (FORMAT JSON)`                                | Yes             |
| MySQL / MariaDB                          | `EXPLAIN FORMAT=JSON`                                  | Yes             |
| SQLite / Turso / D1                      | `EXPLAIN QUERY PLAN`                                   | Yes             |
| DuckDB                                   | `EXPLAIN`                                              | Yes (text/JSON) |
| ClickHouse                               | `EXPLAIN json=1`                                       | Yes             |
| Snowflake                                | `EXPLAIN USING JSON`                                   | Yes             |
| SQL Server                               | `SET SHOWPLAN_ALL` batch (estimated, does not execute) | Yes             |
| Oracle                                   | `EXPLAIN PLAN FOR` then `DBMS_XPLAN.DISPLAY()`         | Yes             |
| MongoDB, Redis, Cassandra, Google Sheets | No query-plan API in this editor                       | Error dialog    |

Estimated plans omit execution time, actual rows and I/O. Those metrics are
hidden when the database does not return them, never shown as zero. Planner
costs are not milliseconds.

## Measured plan

The analyzer never auto-runs ANALYZE. For engines that support it, **Run** a
measured form yourself. That **executes the statement** (writes and function
side effects may occur):

```sql
-- PostgreSQL
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT ...;

-- MySQL 8.0.18+
EXPLAIN ANALYZE FORMAT=JSON
SELECT ...;

-- DuckDB
EXPLAIN ANALYZE
SELECT ...;
```

Use an appropriate test environment. The analyzer does not execute
recommendations, change indexes, or change database settings.

## Views

- **Plan:** node hierarchy, filter, estimated costs, available runtime measurements
  and selected-node details. The node bar uses inclusive actual time on measured
  plans and estimated cost on estimated plans. Large trees are paged, not
  silently truncated.
- **Recommendations:** conservative heuristics for filtered sequential scans,
  row-estimate mismatch, disk sorts and multi-batch hashes. Findings are review
  prompts, not proof that a query is slow or a particular index is needed.
- **Compare:** import a JSON plan to compare available metrics.
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
  document complexity. Malformed PostgreSQL JSON stays the raw table. Other SQL
  Explain results still open the analyzer.
- Plans can include private identifiers, predicates and literal values. Review
  exported reports before sharing.

References: [PostgreSQL EXPLAIN](https://www.postgresql.org/docs/current/sql-explain.html),
[MySQL EXPLAIN](https://dev.mysql.com/doc/refman/8.4/en/explain.html),
[SQLite EXPLAIN QUERY PLAN](https://www.sqlite.org/eqp.html).
