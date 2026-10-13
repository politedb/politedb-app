//! PostgreSQL data executor. Everything happens in one `BEGIN READ ONLY` transaction
//! on a pooled client taken out of the pool for good (dropped afterwards), with a local
//! statement timeout:
//!
//! 1. every relation the query names is resolved to `schema.name` and locked
//!    `ACCESS SHARE`, so it cannot be dropped, replaced or given a policy meanwhile;
//! 2. the search path is pinned to `pg_catalog`, so functions, operators and types can
//!    only resolve to built-ins (user objects are reachable only by qualified names,
//!    which the guard rejects);
//! 3. the catalog check (`builtin_only`) runs again in this same transaction;
//! 4. the rewritten query runs, its cells cut to size on the server.

use std::collections::{BTreeMap, HashSet};
use std::ops::ControlFlow;

use async_trait::async_trait;
use deadpool_postgres::{Pool, Transaction};
use sqlparser::ast::{
    Ident, ObjectName, ObjectNamePart, Query, Statement, TableFactor, Visit, VisitMut, Visitor,
    VisitorMut,
};
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;

use super::{
    clip_value, short_error, DataExecutor, Rows, DATA_TIMEOUT, MAX_CELL_CHARS, MAX_COLUMNS,
    MAX_PLAN_CHARS,
};
use crate::ai::agent::catalog::postgres::{builtin_only, read_only_session};
use crate::ai::agent::query_guard::{GuardDialect, NOT_ALLOWED};
use crate::ai::agent::run::ToolContext;
use crate::ai::agent::sql_safety::{self, SqlSafety};

pub struct PgData {
    pool: Pool,
}

impl PgData {
    pub fn new(pool: Pool) -> Self {
        Self { pool }
    }
}

fn db_error(e: tokio_postgres::Error) -> String {
    match e.as_db_error() {
        Some(db) => short_error(db.message()),
        None => "query failed".to_string(),
    }
}

/// Names introduced by `WITH` anywhere in the statement: compared keys, and the names
/// as written.
struct CteNames(HashSet<String>, Vec<String>);

impl Visitor for CteNames {
    type Break = ();
    fn pre_visit_query(&mut self, query: &Query) -> ControlFlow<()> {
        if let Some(with) = &query.with {
            for cte in &with.cte_tables {
                self.0.insert(key(&cte.alias.name));
                self.1.push(cte.alias.name.to_string());
            }
        }
        ControlFlow::Continue(())
    }
}

/// A prepared query, and the relation identities it must still have when it runs.
struct Prepared {
    sql: String,
    /// `"schema"."relation"` → OID, as resolved and locked.
    pins: Vec<(String, u32)>,
}

impl Prepared {
    /// A condition with no column references, so PostgreSQL evaluates it once before
    /// running anything below it: every name still denotes the relation that was
    /// locked and checked (a schema renamed meanwhile would point it elsewhere).
    fn gate(&self) -> String {
        if self.pins.is_empty() {
            return "true".into();
        }
        self.pins
            .iter()
            .map(|(name, oid)| {
                format!(
                    "pg_catalog.to_regclass('{}') = {oid}::pg_catalog.oid",
                    name.replace('\'', "''")
                )
            })
            .collect::<Vec<_>>()
            .join(" AND ")
    }
}

/// How PostgreSQL compares an identifier: unquoted names fold to lower case.
fn key(ident: &Ident) -> String {
    if ident.quote_style.is_some() {
        ident.value.clone()
    } else {
        ident.value.to_lowercase()
    }
}

/// Plain table references (not CTEs, not table functions), as written.
struct Relations<'a> {
    ctes: &'a HashSet<String>,
    /// Written name → resolved `(schema, relation)`; filled in by the caller.
    resolved: &'a BTreeMap<String, (String, String)>,
    found: Vec<String>,
    rewrite: bool,
}

impl Relations<'_> {
    fn written(name: &ObjectName) -> Option<(String, bool)> {
        let parts: Vec<&Ident> = name
            .0
            .iter()
            .map(|part| match part {
                ObjectNamePart::Identifier(ident) => Some(ident),
                _ => None,
            })
            .collect::<Option<_>>()?;
        Some((name.to_string(), parts.len() == 1))
    }
}

impl VisitorMut for Relations<'_> {
    type Break = ();
    fn pre_visit_table_factor(&mut self, factor: &mut TableFactor) -> ControlFlow<()> {
        let TableFactor::Table {
            name, args: None, ..
        } = factor
        else {
            return ControlFlow::Continue(());
        };
        let Some((written, single)) = Self::written(name) else {
            return ControlFlow::Continue(());
        };
        if single {
            if let Some(ObjectNamePart::Identifier(ident)) = name.0.first() {
                if self.ctes.contains(&key(ident)) {
                    return ControlFlow::Continue(());
                }
            }
        }
        if self.rewrite {
            if let Some((schema, relation)) = self.resolved.get(&written) {
                *name = ObjectName(vec![
                    ObjectNamePart::Identifier(Ident::with_quote('"', schema.clone())),
                    ObjectNamePart::Identifier(Ident::with_quote('"', relation.clone())),
                ]);
            }
        } else {
            self.found.push(written);
        }
        ControlFlow::Continue(())
    }
}

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Steps 1-3 of the module doc; returns the SQL to run under the pinned search path.
async fn prepare(tx: &Transaction<'_>, validated: &str) -> Result<Prepared, String> {
    let not_allowed = || format!("{NOT_ALLOWED}: the query could not be prepared safely");
    let mut statement: Statement = Parser::parse_sql(&PostgreSqlDialect {}, validated)
        .ok()
        .and_then(|mut statements| (statements.len() == 1).then(|| statements.remove(0)))
        .ok_or_else(not_allowed)?;
    let mut ctes = CteNames(HashSet::new(), Vec::new());
    let _ = Visit::visit(&statement, &mut ctes);
    // CTE scoping is not modelled: a WITH name must not also name a real relation,
    // so every unqualified name is unambiguous.
    for written in &ctes.1 {
        let shadows: bool = tx
            .query_one("SELECT pg_catalog.to_regclass($1) IS NOT NULL", &[written])
            .await
            .map_err(db_error)?
            .get(0);
        if shadows {
            let shown: String = written.chars().take(128).collect();
            return Err(format!(
                "{NOT_ALLOWED}: the WITH name {shown} is also a table name; rename it"
            ));
        }
    }

    let empty = BTreeMap::new();
    let mut collect = Relations {
        ctes: &ctes.0,
        resolved: &empty,
        found: Vec::new(),
        rewrite: false,
    };
    let _ = VisitMut::visit(&mut statement, &mut collect);

    // Resolve under the session's own search path, as the user would.
    let mut resolved = BTreeMap::new();
    let mut oids = Vec::new();
    for written in collect.found {
        if resolved.contains_key(&written) {
            continue;
        }
        let row = tx
            .query_opt(
                "SELECT n.nspname::text, c.relname::text, c.oid FROM pg_catalog.pg_class c \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE c.oid = pg_catalog.to_regclass($1)",
                &[&written],
            )
            .await
            .map_err(db_error)?
            .ok_or_else(|| {
                let shown: String = written.chars().take(128).collect();
                format!("query failed: relation not found: {shown}")
            })?;
        resolved.insert(written, (row.get::<_, String>(0), row.get::<_, String>(1)));
        oids.push((
            format!(
                "{}.{}",
                quoted(&row.get::<_, String>(0)),
                quoted(&row.get::<_, String>(1))
            ),
            row.get::<_, u32>(2),
        ));
    }

    if !resolved.is_empty() {
        let list: Vec<String> = resolved
            .values()
            .map(|(schema, relation)| format!("{}.{}", quoted(schema), quoted(relation)))
            .collect();
        tx.batch_execute(&format!(
            "LOCK TABLE {} IN ACCESS SHARE MODE",
            list.join(", ")
        ))
        .await
        .map_err(db_error)?;
    }
    tx.batch_execute("SET LOCAL search_path = pg_catalog, pg_temp")
        .await
        .map_err(db_error)?;
    if !builtin_only(tx).await? {
        return Err(format!(
            "{NOT_ALLOWED}: this database has user-defined functions, operators or views \
             that automatic queries cannot run against; suggest the SQL instead"
        ));
    }

    let mut rewrite = Relations {
        ctes: &ctes.0,
        resolved: &resolved,
        found: Vec::new(),
        rewrite: true,
    };
    let _ = VisitMut::visit(&mut statement, &mut rewrite);
    let prepared = statement.to_string();
    if sql_safety::classify(&prepared, "postgres") != SqlSafety::ReadOnly {
        return Err(not_allowed());
    }
    Ok(Prepared {
        sql: prepared,
        pins: oids,
    })
}

/// Test-only pause between preparing and running a query (race regressions).
#[cfg(test)]
static PAUSE: std::sync::Mutex<
    Option<(
        std::sync::Arc<tokio::sync::Notify>,
        std::sync::Arc<tokio::sync::Notify>,
    )>,
> = std::sync::Mutex::new(None);

async fn pause_for_tests() {
    #[cfg(test)]
    {
        let hook = PAUSE.lock().unwrap().clone();
        if let Some((reached, resume)) = hook {
            reached.notify_one();
            resume.notified().await;
        }
    }
}

#[async_trait]
impl DataExecutor for PgData {
    fn dialect(&self) -> GuardDialect {
        GuardDialect::Postgres
    }

    async fn query(&self, sql: &str, limit: usize, ctx: &ToolContext) -> Result<Rows, String> {
        let validated = sql.to_string();
        read_only_session(&self.pool, DATA_TIMEOUT, ctx, true, move |tx| {
            Box::pin(async move {
                let prepared = prepare(tx, &validated).await?;
                // One JSON object per row, at most MAX_COLUMNS columns, each value cut
                // to MAX_CELL_CHARS on the server; the outer LIMIT stops early.
                let wrapped = format!(
                    "SELECT (SELECT json_object_agg(e.key, CASE \
                       WHEN json_typeof(e.value) = 'string' \
                         THEN to_json(\"left\"(e.value #>> '{{}}', {MAX_CELL_CHARS})) \
                       WHEN length(e.value::text) > {MAX_CELL_CHARS} \
                         THEN to_json(\"left\"(e.value::text, {MAX_CELL_CHARS})) \
                       ELSE e.value END)::text \
                     FROM (SELECT * FROM json_each(row_to_json(q)) LIMIT {MAX_COLUMNS}) AS e) \
                     FROM (\n{sql}\n) AS q WHERE {gate} LIMIT {}",
                    limit + 1,
                    sql = prepared.sql,
                    gate = prepared.gate(),
                );
                pause_for_tests().await;
                let rows = tx.query(&wrapped, &[]).await.map_err(db_error)?;
                let truncated = rows.len() > limit;
                let rows = rows
                    .iter()
                    .take(limit)
                    .map(|row| {
                        row.get::<_, Option<String>>(0)
                            .and_then(|text| serde_json::from_str(&text).ok())
                            .map(clip_value)
                            .unwrap_or(serde_json::Value::Null)
                    })
                    .collect();
                Ok(Rows { rows, truncated })
            })
        })
        .await
    }

    async fn explain(&self, sql: &str, ctx: &ToolContext) -> Result<String, String> {
        let validated = sql.to_string();
        read_only_session(&self.pool, DATA_TIMEOUT, ctx, true, move |tx| {
            Box::pin(async move {
                let prepared = prepare(tx, &validated).await?;
                // No ANALYZE: the query is planned, never executed.
                let row = tx
                    .query_one(&format!("EXPLAIN (FORMAT JSON) {}", prepared.sql), &[])
                    .await
                    .map_err(db_error)?;
                let plan: serde_json::Value = row.get(0);
                Ok(plan.to_string().chars().take(MAX_PLAN_CHARS).collect())
            })
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::agent::query_guard::validate;
    use tokio_util::sync::CancellationToken;
    use tokio_util::task::TaskTracker;

    fn ctx() -> ToolContext {
        ToolContext {
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
        }
    }

    /// Live R4/R7 check on a throwaway PostgreSQL. Ignored by default; run with
    /// `AGENT_PG_URL=postgres://user:pass@127.0.0.1:5432/db cargo test agent_pg_live_data
    /// -- --ignored --test-threads=1`.
    #[tokio::test]
    #[ignore]
    async fn agent_pg_live_data() {
        let url = std::env::var("AGENT_PG_URL").expect("set AGENT_PG_URL");
        let cfg: tokio_postgres::Config = url.parse().unwrap();
        let manager = deadpool_postgres::Manager::from_config(
            cfg,
            tokio_postgres::NoTls,
            deadpool_postgres::ManagerConfig::default(),
        );
        let pool = Pool::builder(manager).max_size(4).build().unwrap();
        let admin = pool.get().await.unwrap();
        admin
            .batch_execute(
                "DROP SCHEMA IF EXISTS agent_d CASCADE; CREATE SCHEMA agent_d;
                 CREATE TABLE agent_d.t (id int PRIMARY KEY, note text);
                 INSERT INTO agent_d.t SELECT g, 'n' || g FROM generate_series(1, 50) g;
                 CREATE SEQUENCE agent_d.s;",
            )
            .await
            .unwrap();
        let data = PgData::new(pool.clone());

        // Reads, with the row cap.
        let sql = validate(
            "SELECT id, note FROM agent_d.t ORDER BY id",
            GuardDialect::Postgres,
        )
        .unwrap();
        let rows = data.query(&sql, 10, &ctx()).await.unwrap();
        assert!(rows.truncated);
        assert_eq!(rows.rows.len(), 10);
        assert_eq!(rows.rows[0]["note"], "n1");
        let plan = data.explain(&sql, &ctx()).await.unwrap();
        assert!(plan.contains("Plan"));

        // The bypass corpus: the guard rejects every one...
        let corpus = [
            "INSERT INTO agent_d.t VALUES (999, 'x')",
            "UPDATE agent_d.t SET note = 'x'",
            "WITH d AS (DELETE FROM agent_d.t RETURNING *) SELECT count(*) FROM d",
            "SELECT * FROM agent_d.t FOR UPDATE",
            "SELECT 1; DELETE FROM agent_d.t",
            "SELECT nextval('agent_d.s')",
            "SELECT pg_advisory_lock(424242)",
            "SELECT pg_read_file('postgresql.conf')",
            "SELECT * FROM pg_ls_dir('.')",
            "SELECT set_config('search_path', 'x', false)",
            "SELECT 1 /* */; DROP TABLE agent_d.t",
            "SELECT $$x$$",
            // Standard strings: the backslash is literal, so the DELETE is live SQL.
            "SELECT 'a\\'; DELETE FROM agent_d.t; --'",
        ];
        for sql in corpus {
            assert!(validate(sql, GuardDialect::Postgres).is_err(), "{sql}");
        }
        // ...and even run past the guard, the executor's read-only session refuses to
        // write, and session effects die with the discarded session.
        for sql in [
            "SELECT nextval('agent_d.s')",
            "SELECT * FROM agent_d.t FOR UPDATE",
            "SELECT count(*) FROM (SELECT set_config('default_transaction_read_only', 'off', false)) x",
        ] {
            let _ = data.query(sql, 5, &ctx()).await;
        }
        // The executor re-checks what it runs, so even this never reaches the server.
        assert!(data
            .query("SELECT pg_advisory_lock(424242)", 1, &ctx())
            .await
            .is_err());
        let ctx_wait = ctx();
        ctx_wait.tracker.close();
        ctx_wait.tracker.wait().await;
        let locks: i64 = admin
            .query_one(
                "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = 424242",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(locks, 0, "no advisory lock was taken or kept");
        let count: i64 = admin
            .query_one("SELECT count(*) FROM agent_d.t", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(count, 50);
        let seq: i64 = admin
            .query_one("SELECT last_value FROM agent_d.s", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(seq, 1, "nextval never ran");
        let _: () = admin
            .query_one("SELECT is_called FROM agent_d.s", &[])
            .await
            .map(|row| assert!(!row.get::<_, bool>(0)))
            .unwrap();

        // Unqualified names resolve through the session's search path and are pinned;
        // CTE names stay CTEs; unknown relations fail.
        admin
            .batch_execute(
                "DROP TABLE IF EXISTS public.agent_pub; \
                 CREATE TABLE public.agent_pub (id int, big text); \
                 INSERT INTO public.agent_pub VALUES (1, repeat('x', 100000));",
            )
            .await
            .unwrap();
        let sql = validate(
            "WITH p AS (SELECT id, big FROM agent_pub) SELECT id, big FROM p",
            GuardDialect::Postgres,
        )
        .unwrap();
        let rows = data.query(&sql, 5, &ctx()).await.unwrap();
        assert_eq!(rows.rows[0]["id"], 1);
        // Cut on the server, before transfer.
        assert_eq!(
            rows.rows[0]["big"].as_str().unwrap().chars().count(),
            crate::ai::agent::data::MAX_CELL_CHARS
        );
        let wide: Vec<String> = (0..60).map(|i| format!("{i} AS c{i}")).collect();
        let sql = validate(
            &format!("SELECT {}", wide.join(", ")),
            GuardDialect::Postgres,
        )
        .unwrap();
        let rows = data.query(&sql, 1, &ctx()).await.unwrap();
        assert_eq!(rows.rows[0].as_object().unwrap().len(), MAX_COLUMNS);
        let sql = validate("SELECT * FROM no_such_table", GuardDialect::Postgres).unwrap();
        assert!(data
            .query(&sql, 1, &ctx())
            .await
            .unwrap_err()
            .contains("relation not found"));

        // A user overload created after validation (e.g. while approval was pending)
        // is caught inside the executing transaction, and nothing runs.
        let sql = validate("SELECT lower(7)", GuardDialect::Postgres).unwrap();
        admin
            .batch_execute(
                "CREATE FUNCTION public.lower(integer) RETURNS text LANGUAGE plpgsql \
                 AS 'BEGIN PERFORM pg_advisory_lock(777); RETURN $1::text; END';",
            )
            .await
            .unwrap();
        let err = data.query(&sql, 1, &ctx()).await.unwrap_err();
        assert!(err.starts_with(NOT_ALLOWED), "{err}");
        let locks: i64 = admin
            .query_one(
                "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = 777",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(locks, 0);
        admin
            .batch_execute("DROP FUNCTION public.lower(integer); DROP TABLE public.agent_pub")
            .await
            .unwrap();

        // The relation gate is evaluated once, before anything under it runs: when a
        // name no longer denotes the locked relation, the subquery never executes.
        let gated = Prepared {
            sql: "SELECT pg_try_advisory_lock(888) AS l".into(),
            pins: vec![("\"agent_d\".\"t\"".into(), 1)],
        };
        let rows = admin
            .query(
                &format!("SELECT * FROM ({}) AS q WHERE {}", gated.sql, gated.gate()),
                &[],
            )
            .await
            .unwrap();
        assert!(rows.is_empty());
        let locks: i64 = admin
            .query_one(
                "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = 888",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(locks, 0, "the gated subquery must not run");

        // Codex Phase 3 round 2: between the checks and the run, another session
        // renames the schema and puts a view with a side effect under the old name.
        admin
            .batch_execute(
                "DROP SCHEMA IF EXISTS s CASCADE; DROP SCHEMA IF EXISTS s_old CASCADE; \
                 CREATE SCHEMA s; CREATE TABLE s.t (id int); INSERT INTO s.t VALUES (1);",
            )
            .await
            .unwrap();
        let reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let resume = std::sync::Arc::new(tokio::sync::Notify::new());
        *PAUSE.lock().unwrap() = Some((reached.clone(), resume.clone()));
        let sql = validate("SELECT id FROM s.t", GuardDialect::Postgres).unwrap();
        let racing = {
            let data = PgData::new(pool.clone());
            tokio::spawn(async move { data.query(&sql, 5, &ctx()).await })
        };
        reached.notified().await;
        *PAUSE.lock().unwrap() = None;
        let attacker = pool.get().await.unwrap();
        attacker
            .batch_execute(
                "ALTER SCHEMA s RENAME TO s_old; CREATE SCHEMA s; \
                 CREATE VIEW s.t AS SELECT 1 AS id WHERE pg_catalog.pg_try_advisory_lock(999);",
            )
            .await
            .unwrap();
        resume.notify_one();
        let outcome = racing.await.unwrap();
        let locks: i64 = admin
            .query_one(
                "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = 999",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(locks, 0, "the replacement view must not run: {outcome:?}");
        assert!(outcome.map(|rows| rows.rows.is_empty()).unwrap_or(true));
        admin
            .batch_execute("DROP SCHEMA s CASCADE; DROP SCHEMA s_old CASCADE")
            .await
            .unwrap();

        // A WITH name that is also a table name is refused (CTE scoping not modelled).
        let sql = validate(
            "WITH t AS (SELECT 1 AS id) SELECT id FROM t",
            GuardDialect::Postgres,
        )
        .unwrap();
        admin
            .batch_execute("CREATE TABLE public.t (id int)")
            .await
            .unwrap();
        let err = data.query(&sql, 1, &ctx()).await.unwrap_err();
        assert!(err.contains("also a table name"), "{err}");
        admin.batch_execute("DROP TABLE public.t").await.unwrap();
        assert!(data.query(&sql, 1, &ctx()).await.is_ok());

        // Cancel stops a slow query on the server.
        let ctx = ctx();
        let stopper = ctx.cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            stopper.cancel();
        });
        let started = std::time::Instant::now();
        assert!(data
            .query(
                "SELECT count(*) FROM generate_series(1, 1000000000)",
                1,
                &ctx
            )
            .await
            .is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        admin
            .batch_execute("DROP SCHEMA agent_d CASCADE")
            .await
            .unwrap();
    }
}
