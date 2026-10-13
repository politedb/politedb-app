//! PostgreSQL catalog: fixed `pg_catalog` queries with bound parameters, each call on
//! its own pooled client inside `BEGIN READ ONLY` with a local statement timeout,
//! always rolled back. The client stays owned by a tracker task until any stop has
//! cancelled its server query; an interrupted client is discarded, never pooled again.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use async_trait::async_trait;
use deadpool_postgres::{Pool, Transaction};
use tokio_postgres::NoTls;

use super::{
    acquire, cap, clip, interruptible, owned, views_are_plain, CatalogExecutor, Column, ForeignKey,
    Index, TableDescription, TableRef, CATALOG_TIMEOUT, MAX_CHECKED_VIEWS, MAX_COLUMNS,
    MAX_FOREIGN_KEYS, MAX_INDEXES, MAX_SCHEMAS, MAX_TABLES, TABLE_NOT_FOUND,
};
use crate::ai::agent::run::ToolContext;

const USER_SCHEMAS: &str =
    "n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'";
const RELKINDS: &str = "c.relkind IN ('r', 'p', 'v', 'm', 'f')";

type TxFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

pub struct PgCatalog {
    pool: Pool,
    timeout: Duration,
}

impl PgCatalog {
    pub fn new(pool: Pool) -> Self {
        Self {
            pool,
            timeout: CATALOG_TIMEOUT,
        }
    }

    /// Runs `work` in a read-only transaction on a dedicated client, always rolled
    /// back. On cancel or timeout the server query is cancelled while the client is
    /// still held, and the client is then dropped from the pool.
    async fn read_only<T, F>(&self, ctx: &ToolContext, work: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: for<'a> FnOnce(&'a Transaction<'a>) -> TxFuture<'a, T> + Send + 'static,
    {
        if ctx.cancel.is_cancelled() {
            return Err("canceled".to_string());
        }
        let pool = self.pool.clone();
        let timeout = self.timeout;
        let cancel = ctx.cancel.clone();
        owned(ctx, async move {
            let mut client = acquire(pool.get(), &cancel, timeout).await?;
            let token = client.cancel_token();
            let (outcome, interrupted) = interruptible(
                async {
                    let tx = client
                        .build_transaction()
                        .read_only(true)
                        .start()
                        .await
                        .map_err(|_| "could not start a read-only transaction".to_string())?;
                    tx.batch_execute(&format!(
                        "SET LOCAL statement_timeout = {}",
                        timeout.as_millis()
                    ))
                    .await
                    .map_err(|_| "could not set the statement timeout".to_string())?;
                    let result = work(&tx).await;
                    let _ = tx.rollback().await;
                    result
                },
                &cancel,
                timeout,
                async move {
                    let _ = token.cancel_query(NoTls).await;
                },
            )
            .await;
            if interrupted {
                // Never hand a session that may still be busy back to the editor.
                drop(deadpool_postgres::Object::take(client));
            }
            outcome
        })
        .await
    }
}

fn failed(_: tokio_postgres::Error) -> String {
    // Database errors can carry identifiers or values; keep them out of the transcript.
    "catalog query failed".to_string()
}

#[async_trait]
impl CatalogExecutor for PgCatalog {
    fn dialect(&self) -> &'static str {
        "PostgreSQL"
    }

    fn sql_engine(&self) -> &'static str {
        "postgres"
    }

    /// Nothing created after `initdb` (OID ≥ 16384, so also objects a superuser put in
    /// `pg_catalog`) that a query could dispatch to: no functions other than trigger
    /// functions (which a query cannot call), no casts, operators or conversions (these
    /// can bind even built-in functions with side effects), no domain constraints and
    /// no row-level security policies. Views must each be a plain read-only query.
    async fn only_builtin_code(&self, ctx: &ToolContext) -> Result<bool, String> {
        self.read_only(ctx, move |tx| {
            Box::pin(async move {
                let dispatch = tx
                    .query_one(
                        "SELECT \
                           EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid >= 16384 \
                                     AND p.prorettype NOT IN ('pg_catalog.trigger'::pg_catalog.regtype, \
                                                              'pg_catalog.event_trigger'::pg_catalog.regtype)) \
                           OR EXISTS (SELECT 1 FROM pg_catalog.pg_cast WHERE oid >= 16384) \
                           OR EXISTS (SELECT 1 FROM pg_catalog.pg_operator WHERE oid >= 16384) \
                           OR EXISTS (SELECT 1 FROM pg_catalog.pg_conversion WHERE oid >= 16384) \
                           OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint \
                                      WHERE contypid <> 0 AND oid >= 16384) \
                           OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy)",
                        &[],
                    )
                    .await
                    .map_err(failed)?;
                if dispatch.get::<_, bool>(0) {
                    return Ok(false);
                }
                let views: Vec<Option<String>> = tx
                    .query(
                        &format!(
                            "SELECT pg_catalog.pg_get_viewdef(c.oid) FROM pg_catalog.pg_class c \
                             WHERE c.relkind = 'v' AND c.oid >= 16384 LIMIT {}",
                            MAX_CHECKED_VIEWS + 1
                        ),
                        &[],
                    )
                    .await
                    .map_err(failed)?
                    .iter()
                    .map(|row| row.get(0))
                    .collect();
                Ok(views_are_plain(&views, "postgres"))
            })
        })
        .await
    }

    async fn list_schemas(&self, ctx: &ToolContext) -> Result<Vec<String>, String> {
        self.read_only(ctx, move |tx| {
            Box::pin(async move {
                let sql = format!(
                    "SELECT n.nspname::text FROM pg_catalog.pg_namespace n WHERE {USER_SCHEMAS} \
                 ORDER BY 1 LIMIT {}",
                    MAX_SCHEMAS + 1
                );
                tx.query(&sql, &[])
                    .await
                    .map(|rows| rows.iter().map(|row| row.get::<_, String>(0)).collect())
                    .map_err(failed)
            })
        })
        .await
    }

    async fn list_tables(
        &self,
        schema: Option<&str>,
        name_contains: Option<&str>,
        ctx: &ToolContext,
    ) -> Result<Vec<TableRef>, String> {
        let schema = schema.map(str::to_string);
        let name_contains = name_contains.map(str::to_string);
        self.read_only(ctx, move |tx| Box::pin(async move {
            let sql = format!(
                "SELECT n.nspname::text, c.relname::text, \
                   CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view' \
                     WHEN 'f' THEN 'foreign_table' ELSE 'table' END \
                 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE {RELKINDS} AND {USER_SCHEMAS} \
                   AND ($1::text IS NULL OR n.nspname = $1) \
                   AND ($2::text IS NULL OR position(lower($2) in lower(c.relname)) > 0) \
                 ORDER BY 1, 2 LIMIT {}",
                MAX_TABLES + 1
            );
            tx.query(&sql, &[&schema, &name_contains])
                .await
                .map(|rows| {
                    rows.iter()
                        .map(|row| TableRef {
                            schema: row.get(0),
                            name: row.get(1),
                            kind: row.get(2),
                        })
                        .collect()
                })
                .map_err(failed)
        }))
        .await
    }

    async fn describe_table(
        &self,
        schema: &str,
        table: &str,
        ctx: &ToolContext,
    ) -> Result<TableDescription, String> {
        let schema = schema.to_string();
        let table = table.to_string();
        self.read_only(ctx, move |tx| Box::pin(async move {
            let found = tx
                .query_opt(
                    &format!(
                        "SELECT c.oid FROM pg_catalog.pg_class c \
                         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                         WHERE {RELKINDS} AND n.nspname = $1 AND c.relname = $2"
                    ),
                    &[&schema, &table],
                )
                .await
                .map_err(failed)?;
            let Some(found) = found else {
                return Err(TABLE_NOT_FOUND.to_string());
            };
            let oid: u32 = found.get(0);

            let columns = tx
                .query(
                    &format!(
                        "SELECT a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod), \
                           NOT a.attnotnull, pg_catalog.pg_get_expr(d.adbin, d.adrelid), \
                           EXISTS (SELECT 1 FROM pg_catalog.pg_index i \
                                   WHERE i.indrelid = a.attrelid AND i.indisprimary \
                                     AND a.attnum = ANY (i.indkey)), \
                           pg_catalog.col_description(a.attrelid, a.attnum) \
                         FROM pg_catalog.pg_attribute a \
                         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                         WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped \
                         ORDER BY a.attnum LIMIT {}",
                        MAX_COLUMNS + 1
                    ),
                    &[&oid],
                )
                .await
                .map_err(failed)?
                .iter()
                .map(|row| Column {
                    name: row.get(0),
                    data_type: row.get(1),
                    nullable: row.get(2),
                    default: clip(row.get(3)),
                    primary_key: row.get(4),
                    comment: clip(row.get(5)),
                })
                .collect::<Vec<_>>();

            let foreign_keys = tx
                .query(
                    &format!(
                        "SELECT con.conname::text, \
                           ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, o) \
                                 JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n \
                                 ORDER BY k.o), \
                           fn.nspname::text, fc.relname::text, \
                           ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, o) \
                                 JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n \
                                 ORDER BY k.o) \
                         FROM pg_catalog.pg_constraint con \
                         JOIN pg_catalog.pg_class fc ON fc.oid = con.confrelid \
                         JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace \
                         WHERE con.conrelid = $1 AND con.contype = 'f' ORDER BY 1 LIMIT {}",
                        MAX_FOREIGN_KEYS + 1
                    ),
                    &[&oid],
                )
                .await
                .map_err(failed)?
                .iter()
                .map(|row| ForeignKey {
                    name: Some(row.get(0)),
                    columns: row.get(1),
                    references_schema: Some(row.get(2)),
                    references_table: row.get(3),
                    references_columns: row.get(4),
                })
                .collect::<Vec<_>>();

            let indexes = tx
                .query(
                    &format!(
                        "SELECT ic.relname::text, i.indisunique, \
                           ARRAY(SELECT COALESCE(a.attname::text, '<expression>') \
                                 FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(n, o) \
                                 LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n \
                                 ORDER BY k.o) \
                         FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid \
                         WHERE i.indrelid = $1 ORDER BY 1 LIMIT {}",
                        MAX_INDEXES + 1
                    ),
                    &[&oid],
                )
                .await
                .map_err(failed)?
                .iter()
                .map(|row| Index {
                    name: row.get(0),
                    unique: row.get(1),
                    columns: row.get(2),
                })
                .collect::<Vec<_>>();

            let (columns, c) = cap(columns, MAX_COLUMNS);
            let (foreign_keys, f) = cap(foreign_keys, MAX_FOREIGN_KEYS);
            let (indexes, i) = cap(indexes, MAX_INDEXES);
            Ok(TableDescription {
                schema,
                name: table,
                columns,
                foreign_keys,
                indexes,
                truncated: c || f || i,
            })
        }))
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;
    use tokio_util::task::TaskTracker;

    /// Live check against a real PostgreSQL. Ignored by default; run with
    /// `AGENT_PG_URL=postgres://user:pass@127.0.0.1:5432/db cargo test agent_pg_live -- --ignored --test-threads=1`
    /// (the live tests share one database).
    #[tokio::test]
    #[ignore]
    async fn agent_pg_live() {
        let url = std::env::var("AGENT_PG_URL").expect("set AGENT_PG_URL");
        let cfg: tokio_postgres::Config = url.parse().unwrap();
        let manager = deadpool_postgres::Manager::from_config(
            cfg,
            NoTls,
            deadpool_postgres::ManagerConfig::default(),
        );
        let pool = Pool::builder(manager).max_size(4).build().unwrap();
        {
            let client = pool.get().await.unwrap();
            client
                .batch_execute(
                    "DROP SCHEMA IF EXISTS agent_t CASCADE; CREATE SCHEMA agent_t;
                     CREATE TABLE agent_t.customers (id serial PRIMARY KEY, email text NOT NULL UNIQUE);
                     CREATE TABLE agent_t.orders (id serial PRIMARY KEY,
                       customer_id int NOT NULL REFERENCES agent_t.customers(id),
                       total numeric(10,2) DEFAULT 0, note text);
                     COMMENT ON COLUMN agent_t.orders.total IS 'Order total in EUR';
                     CREATE INDEX orders_customer ON agent_t.orders (customer_id, lower(note));
                     CREATE VIEW agent_t.big_orders AS SELECT * FROM agent_t.orders WHERE total > 100;",
                )
                .await
                .unwrap();
        }
        let catalog = PgCatalog::new(pool.clone());
        let ctx = ToolContext {
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
        };
        assert!(catalog
            .list_schemas(&ctx)
            .await
            .unwrap()
            .contains(&"agent_t".to_string()));
        let tables = catalog
            .list_tables(Some("agent_t"), None, &ctx)
            .await
            .unwrap();
        assert_eq!(tables.len(), 3);
        assert_eq!(
            catalog
                .list_tables(Some("agent_t"), Some("%"), &ctx)
                .await
                .unwrap()
                .len(),
            0
        );
        let orders = catalog
            .describe_table("agent_t", "orders", &ctx)
            .await
            .unwrap();
        assert!(orders.columns[0].primary_key);
        assert_eq!(orders.columns[2].data_type, "numeric(10,2)");
        assert_eq!(
            orders.columns[2].comment.as_deref(),
            Some("Order total in EUR")
        );
        assert_eq!(orders.foreign_keys[0].references_table, "customers");
        let index = orders
            .indexes
            .iter()
            .find(|i| i.name == "orders_customer")
            .unwrap();
        assert_eq!(index.columns, vec!["customer_id", "<expression>"]);
        assert_eq!(
            catalog
                .describe_table("agent_t", "orders'; DROP TABLE agent_t.orders; --", &ctx)
                .await
                .unwrap_err(),
            TABLE_NOT_FOUND
        );
        // The session is read-only: the catalog transaction cannot write.
        let client = pool.get().await.unwrap();
        client
            .batch_execute("DROP SCHEMA agent_t CASCADE")
            .await
            .unwrap();
    }

    async fn active_sleeps(pool: &Pool) -> i64 {
        let client = pool.get().await.unwrap();
        client
            .query_one(
                "SELECT count(*) FROM pg_stat_activity \
                 WHERE state = 'active' AND query LIKE 'SELECT pg_sleep(30)%'",
                &[],
            )
            .await
            .unwrap()
            .get(0)
    }

    /// Live cancel/timeout check: a slow statement on the catalog's session is stopped
    /// on the server, its client is discarded, and the catalog keeps working.
    #[tokio::test]
    #[ignore]
    async fn agent_pg_live_cancel() {
        let url = std::env::var("AGENT_PG_URL").expect("set AGENT_PG_URL");
        let cfg: tokio_postgres::Config = url.parse().unwrap();
        let manager = deadpool_postgres::Manager::from_config(
            cfg,
            NoTls,
            deadpool_postgres::ManagerConfig::default(),
        );
        let pool = Pool::builder(manager).max_size(2).build().unwrap();
        let catalog = PgCatalog {
            pool: pool.clone(),
            timeout: Duration::from_secs(2),
        };
        fn slow<'a>(tx: &'a Transaction<'a>) -> TxFuture<'a, ()> {
            Box::pin(async move {
                tx.query("SELECT pg_sleep(30)", &[])
                    .await
                    .map(|_| ())
                    .map_err(failed)
            })
        }

        // Run cancel.
        let ctx = ToolContext {
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
        };
        let stopper = ctx.cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            stopper.cancel();
        });
        let started = std::time::Instant::now();
        assert_eq!(catalog.read_only(&ctx, slow).await.unwrap_err(), "canceled");
        ctx.tracker.close();
        ctx.tracker.wait().await;
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(active_sleeps(&pool).await, 0);

        // Timeout (client timer and server statement_timeout race; both stop it).
        let ctx = ToolContext {
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
        };
        let started = std::time::Instant::now();
        assert!(catalog.read_only(&ctx, slow).await.is_err());
        ctx.tracker.close();
        ctx.tracker.wait().await;
        assert!(started.elapsed() < Duration::from_secs(8));
        assert_eq!(active_sleeps(&pool).await, 0);

        // Exhausted pool: checkout is bounded, then the catalog works again.
        let a = pool.get().await.unwrap();
        let b = pool.get().await.unwrap();
        let ctx = ToolContext {
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
        };
        assert_eq!(
            catalog.list_schemas(&ctx).await.unwrap_err(),
            "could not get a database connection"
        );
        drop((a, b));
        assert!(!catalog.list_schemas(&ctx).await.unwrap().is_empty());
    }

    /// Live check that user code reachable from a plain-looking query blocks Run.
    #[tokio::test]
    #[ignore]
    async fn agent_pg_live_identity() {
        let url = std::env::var("AGENT_PG_URL").expect("set AGENT_PG_URL");
        let cfg: tokio_postgres::Config = url.parse().unwrap();
        let manager = deadpool_postgres::Manager::from_config(
            cfg,
            NoTls,
            deadpool_postgres::ManagerConfig::default(),
        );
        let pool = Pool::builder(manager).max_size(2).build().unwrap();
        let catalog = PgCatalog::new(pool.clone());
        let ctx = ToolContext {
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
        };
        let client = pool.get().await.unwrap();
        let reset = "DROP CAST IF EXISTS (bigint AS boolean); \
                     DROP SCHEMA IF EXISTS agent_id CASCADE; CREATE SCHEMA agent_id; \
                     CREATE TABLE agent_id.t (id int); \
                     CREATE VIEW agent_id.plain AS SELECT id, count(*) OVER () FROM agent_id.t;";
        client.batch_execute(reset).await.unwrap();
        assert!(
            catalog.only_builtin_code(&ctx).await.unwrap(),
            "plain views only"
        );
        // Trigger functions cannot be called by a query.
        client
            .batch_execute(
                "CREATE FUNCTION agent_id.trg() RETURNS trigger LANGUAGE plpgsql \
                 AS 'BEGIN RETURN NEW; END';",
            )
            .await
            .unwrap();
        assert!(catalog.only_builtin_code(&ctx).await.unwrap());
        for setup in [
            // Codex round 2: an exact-type overload of a built-in name.
            "CREATE FUNCTION agent_id.lower(integer) RETURNS text LANGUAGE plpgsql \
             AS 'BEGIN PERFORM pg_advisory_lock($1::bigint); RETURN $1::text; END';",
            "CREATE VIEW agent_id.locking AS SELECT pg_try_advisory_lock(1);",
            "ALTER TABLE agent_id.t ENABLE ROW LEVEL SECURITY; \
             CREATE POLICY p ON agent_id.t USING (pg_advisory_lock(1) IS NOT NULL);",
            "CREATE DOMAIN agent_id.d AS int CHECK (pg_advisory_lock(1) IS NOT NULL);",
            // Codex round 3: dispatch objects that bind a built-in with side effects.
            "CREATE CAST (bigint AS boolean) WITH FUNCTION pg_catalog.pg_try_advisory_lock(bigint);",
            "CREATE OPERATOR agent_id.! (RIGHTARG = bigint, FUNCTION = pg_catalog.pg_try_advisory_lock);",
        ] {
            client.batch_execute(setup).await.unwrap();
            assert!(!catalog.only_builtin_code(&ctx).await.unwrap(), "{setup}");
            client.batch_execute(reset).await.unwrap();
        }
        client
            .batch_execute("DROP SCHEMA agent_id CASCADE")
            .await
            .unwrap();
    }
}
