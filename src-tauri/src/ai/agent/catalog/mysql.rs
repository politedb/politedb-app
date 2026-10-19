//! MySQL / MariaDB catalog: fixed `information_schema` queries with bound parameters,
//! each call on its own pooled connection inside `START TRANSACTION READ ONLY`
//! (failing closed if that cannot be established), always rolled back. Every statement
//! carries a server-side time limit. The connection stays owned by a tracker task until
//! any stop has sent `KILL QUERY <id>` from a separate, unpooled connection; an
//! interrupted connection is closed, never pooled again.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use async_trait::async_trait;
use mysql_async::prelude::*;
use mysql_async::{Conn, Pool, Row};

use super::{
    acquire, cap, clip, group_by, interruptible, owned, views_are_plain, CatalogExecutor, Column,
    ForeignKey, Index, TableDescription, TableRef, CATALOG_TIMEOUT, DISCONNECT_GRACE,
    MAX_CHECKED_VIEWS, MAX_COLUMNS, MAX_FOREIGN_KEYS, MAX_INDEXES, MAX_SCHEMAS, MAX_TABLES,
    TABLE_NOT_FOUND,
};
use crate::ai::agent::run::ToolContext;
use crate::types::EngineKind;

const SYSTEM_SCHEMAS: &str = "('mysql', 'performance_schema', 'sys', 'information_schema')";

type ConnFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

pub struct MySqlCatalog {
    pool: Pool,
    engine: EngineKind,
    timeout: Duration,
}

/// A catalog `SELECT` with a server-side time limit for the server actually reached:
/// MariaDB (10.x and later) takes `SET STATEMENT max_statement_time`, MySQL the
/// `MAX_EXECUTION_TIME` optimizer hint.
fn bounded(server_major: u16, timeout: Duration, select: &str) -> String {
    let body = select
        .strip_prefix("SELECT ")
        .expect("catalog statements start with SELECT");
    if server_major >= 10 {
        format!(
            "SET STATEMENT max_statement_time = {} FOR SELECT {body}",
            timeout.as_secs().max(1)
        )
    } else {
        format!(
            "SELECT /*+ MAX_EXECUTION_TIME({}) */ {body}",
            timeout.as_millis()
        )
    }
}

impl MySqlCatalog {
    pub fn new(pool: Pool, engine: EngineKind) -> Self {
        Self {
            pool,
            engine,
            timeout: CATALOG_TIMEOUT,
        }
    }

    /// Runs `work` in a read-only transaction on a dedicated connection, always
    /// rolled back. `work` gets the statement wrapper for this server.
    async fn read_only<T, F>(&self, ctx: &ToolContext, work: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: for<'a> FnOnce(&'a mut Conn, Bound) -> ConnFuture<'a, T> + Send + 'static,
    {
        if ctx.cancel.is_cancelled() {
            return Err("canceled".to_string());
        }
        let pool = self.pool.clone();
        let timeout = self.timeout;
        let cancel = ctx.cancel.clone();
        owned(ctx, async move {
            let mut conn = acquire(pool.get_conn(), &cancel, timeout).await?;
            let thread_id = conn.id();
            let opts = conn.opts().clone();
            let bound = Bound {
                server_major: conn.server_version().0,
                timeout,
            };
            let (outcome, interrupted) = interruptible(
                async {
                    conn.query_drop("START TRANSACTION READ ONLY")
                        .await
                        .map_err(|_| "could not start a read-only transaction".to_string())?;
                    let result = work(&mut conn, bound).await;
                    let _ = conn.query_drop("ROLLBACK").await;
                    result
                },
                &cancel,
                timeout,
                async move {
                    // A separate connection, so a full pool cannot block the kill.
                    if let Ok(mut killer) = Conn::new(opts).await {
                        // `thread_id` is a server-assigned number, not user text.
                        let _ = killer.query_drop(format!("KILL QUERY {thread_id}")).await;
                        let _ = killer.disconnect().await;
                    }
                },
            )
            .await;
            if interrupted {
                // Never hand a session that may still be busy back to the editor.
                let _ = tokio::time::timeout(DISCONNECT_GRACE, conn.disconnect()).await;
            }
            outcome
        })
        .await
    }
}

/// Excludes the schemas nobody can create objects in.
fn not_server_owned(schema_column: &str) -> String {
    format!("{schema_column} NOT IN ('information_schema', 'performance_schema')")
}

/// Wraps catalog statements with the server-side time limit.
#[derive(Clone, Copy)]
struct Bound {
    server_major: u16,
    timeout: Duration,
}

impl Bound {
    fn sql(&self, select: &str) -> String {
        bounded(self.server_major, self.timeout, select)
    }
}

fn failed(_: mysql_async::Error) -> String {
    "catalog query failed".to_string()
}

/// Text from a column that may be NULL, bytes or a number in information_schema.
fn text(row: &Row, index: usize) -> Option<String> {
    match row.as_ref(index)? {
        mysql_async::Value::NULL => None,
        mysql_async::Value::Bytes(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        other => Some(other.as_sql(true).trim_matches('\'').to_string()),
    }
}

fn flag(row: &Row, index: usize) -> bool {
    matches!(text(row, index).as_deref(), Some("1"))
}

#[async_trait]
impl CatalogExecutor for MySqlCatalog {
    fn dialect(&self) -> &'static str {
        match self.engine {
            EngineKind::Mariadb => "MariaDB",
            _ => "MySQL",
        }
    }

    fn sql_engine(&self) -> &'static str {
        match self.engine {
            EngineKind::Mariadb => "mariadb",
            _ => "mysql",
        }
    }

    /// Every view the user can see is a plain read-only query, in every schema
    /// (`mysql` and `sys` included, whoever the definer); a view the user has no
    /// privilege on cannot be reached by their query, and an administrator who can see
    /// the stock `sys` views gets "unsure". Stored and loadable functions need no
    /// check: an unqualified call always resolves to the built-in of that name (a
    /// stored function must be called schema-qualified, which the syntax check
    /// rejects), so only views can lead a plain query to them.
    async fn only_builtin_code(&self, ctx: &ToolContext) -> Result<bool, String> {
        self.read_only(ctx, move |conn, bound| {
            Box::pin(async move {
                let rows: Vec<Row> = conn
                    .query(bound.sql(&format!(
                        "SELECT view_definition FROM information_schema.views \
                         WHERE {NOT_SERVER_OWNED} LIMIT {}",
                        MAX_CHECKED_VIEWS + 1,
                        NOT_SERVER_OWNED = not_server_owned("table_schema")
                    )))
                    .await
                    .map_err(failed)?;
                // An empty definition means no SHOW VIEW privilege: unsure.
                let views: Vec<Option<String>> = rows
                    .iter()
                    .map(|row| text(row, 0).filter(|sql| !sql.trim().is_empty()))
                    .collect();
                Ok(views_are_plain(&views, "mysql"))
            })
        })
        .await
    }

    async fn list_schemas(&self, ctx: &ToolContext) -> Result<Vec<String>, String> {
        self.read_only(ctx, move |conn, bound| {
            Box::pin(async move {
                let rows: Vec<Row> = conn
                    .query(bound.sql(&format!(
                        "SELECT schema_name FROM information_schema.schemata \
                     WHERE schema_name NOT IN {SYSTEM_SCHEMAS} ORDER BY 1 LIMIT {}",
                        MAX_SCHEMAS + 1
                    )))
                    .await
                    .map_err(failed)?;
                Ok(rows.iter().filter_map(|row| text(row, 0)).collect())
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
        self.read_only(ctx, move |conn, bound| Box::pin(async move {
            let rows: Vec<Row> = conn
                .exec(
                    bound.sql(&format!(
                        "SELECT table_schema, table_name, table_type FROM information_schema.tables \
                         WHERE table_schema NOT IN {SYSTEM_SCHEMAS} \
                           AND (? IS NULL OR table_schema = ?) \
                           AND (? IS NULL OR LOCATE(LOWER(?), LOWER(table_name)) > 0) \
                         ORDER BY 1, 2 LIMIT {}",
                        MAX_TABLES + 1
                    )),
                    (&schema, &schema, &name_contains, &name_contains),
                )
                .await
                .map_err(failed)?;
            Ok(rows
                .iter()
                .map(|row| TableRef {
                    schema: text(row, 0).unwrap_or_default(),
                    name: text(row, 1).unwrap_or_default(),
                    kind: match text(row, 2).as_deref() {
                        Some("VIEW") | Some("SYSTEM VIEW") => "view".into(),
                        _ => "table".into(),
                    },
                })
                .collect())
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
        self.read_only(ctx, move |conn, bound| Box::pin(async move {
            let exists: Option<Row> = conn
                .exec_first(
                    bound.sql(
                        "SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?",
                    ),
                    (&schema, &table),
                )
                .await
                .map_err(failed)?;
            if exists.is_none() {
                return Err(TABLE_NOT_FOUND.to_string());
            }

            let column_rows: Vec<Row> = conn
                .exec(
                    bound.sql(&format!(
                        "SELECT column_name, column_type, is_nullable = 'YES', column_default, \
                           column_key = 'PRI', column_comment \
                         FROM information_schema.columns WHERE table_schema = ? AND table_name = ? \
                         ORDER BY ordinal_position LIMIT {}",
                        MAX_COLUMNS + 1
                    )),
                    (&schema, &table),
                )
                .await
                .map_err(failed)?;
            let columns = column_rows
                .iter()
                .map(|row| Column {
                    name: text(row, 0).unwrap_or_default(),
                    data_type: text(row, 1).unwrap_or_default(),
                    nullable: flag(row, 2),
                    default: clip(text(row, 3)),
                    primary_key: flag(row, 4),
                    comment: clip(text(row, 5).filter(|c| !c.is_empty())),
                })
                .collect::<Vec<_>>();

            let fk_rows: Vec<Row> = conn
                .exec(
                    bound.sql(
                        "SELECT constraint_name, column_name, referenced_table_schema, \
                           referenced_table_name, referenced_column_name \
                         FROM information_schema.key_column_usage \
                         WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL \
                         ORDER BY constraint_name, ordinal_position",
                    ),
                    (&schema, &table),
                )
                .await
                .map_err(failed)?;
            let foreign_keys = group_by(
                fk_rows
                    .iter()
                    .map(|row| (text(row, 0).unwrap_or_default(), row.clone()))
                    .collect(),
                |name, row| ForeignKey {
                    name: Some(name.clone()),
                    columns: Vec::new(),
                    references_schema: text(row, 2),
                    references_table: text(row, 3).unwrap_or_default(),
                    references_columns: Vec::new(),
                },
                |fk, row| {
                    fk.columns.push(text(&row, 1).unwrap_or_default());
                    fk.references_columns
                        .push(text(&row, 4).unwrap_or_default());
                },
            );

            let index_rows: Vec<Row> = conn
                .exec(
                    bound.sql(
                        "SELECT index_name, non_unique = 0, column_name \
                         FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? \
                         ORDER BY index_name, seq_in_index",
                    ),
                    (&schema, &table),
                )
                .await
                .map_err(failed)?;
            let indexes = group_by(
                index_rows
                    .iter()
                    .map(|row| (text(row, 0).unwrap_or_default(), row.clone()))
                    .collect(),
                |name, row| Index {
                    name: name.clone(),
                    unique: flag(row, 1),
                    columns: Vec::new(),
                },
                |index, row| {
                    index
                        .columns
                        .push(text(&row, 2).unwrap_or_else(|| "<expression>".into()))
                },
            );

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

    #[test]
    fn statements_get_a_server_side_limit_for_the_server_reached() {
        let limit = Duration::from_secs(10);
        assert_eq!(
            bounded(8, limit, "SELECT 1 FROM t"),
            "SELECT /*+ MAX_EXECUTION_TIME(10000) */ 1 FROM t"
        );
        assert_eq!(
            bounded(11, limit, "SELECT 1 FROM t"),
            "SET STATEMENT max_statement_time = 10 FOR SELECT 1 FROM t"
        );
    }
    use tokio_util::task::TaskTracker;

    /// Live check against a real MySQL/MariaDB. Ignored by default; run with
    /// `AGENT_MYSQL_URL=mysql://root:pass@127.0.0.1:3306/agent_t cargo test agent_mysql_live -- --ignored --test-threads=1`
    /// (the live tests share one database).
    #[tokio::test]
    #[ignore]
    async fn agent_mysql_live() {
        let url = std::env::var("AGENT_MYSQL_URL").expect("set AGENT_MYSQL_URL");
        let pool = Pool::new(url.as_str());
        {
            let mut conn = pool.get_conn().await.unwrap();
            conn.query_drop(
                "DROP TABLE IF EXISTS orders, customers;
                 CREATE TABLE customers (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(200) NOT NULL UNIQUE);
                 CREATE TABLE orders (id INT AUTO_INCREMENT PRIMARY KEY,
                   customer_id INT NOT NULL, total DECIMAL(10,2) DEFAULT 0 COMMENT 'Order total in EUR',
                   note TEXT, FOREIGN KEY (customer_id) REFERENCES customers(id));
                 CREATE INDEX orders_customer ON orders (customer_id, total);",
            )
            .await
            .unwrap();
        }
        let catalog = MySqlCatalog::new(pool.clone(), EngineKind::Mysql);
        let ctx = ToolContext {
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
        };
        let schema: String = {
            let mut conn = pool.get_conn().await.unwrap();
            conn.query_first("SELECT DATABASE()")
                .await
                .unwrap()
                .unwrap()
        };
        assert!(catalog.list_schemas(&ctx).await.unwrap().contains(&schema));
        let tables = catalog
            .list_tables(Some(&schema), None, &ctx)
            .await
            .unwrap();
        assert!(tables.iter().any(|t| t.name == "orders"));
        assert!(catalog
            .list_tables(Some(&schema), Some("%"), &ctx)
            .await
            .unwrap()
            .is_empty());
        let orders = catalog
            .describe_table(&schema, "orders", &ctx)
            .await
            .unwrap();
        assert!(orders.columns[0].primary_key);
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
        assert_eq!(index.columns, vec!["customer_id", "total"]);
        assert_eq!(
            catalog
                .describe_table(&schema, "orders'; DROP TABLE orders; --", &ctx)
                .await
                .unwrap_err(),
            TABLE_NOT_FOUND
        );
        let mut conn = pool.get_conn().await.unwrap();
        conn.query_drop("DROP TABLE orders, customers")
            .await
            .unwrap();
    }

    async fn active_sleeps(pool: &Pool) -> i64 {
        let mut conn = pool.get_conn().await.unwrap();
        conn.query_first(
            "SELECT COUNT(*) FROM information_schema.processlist \
             WHERE command = 'Query' AND info LIKE 'SELECT SLEEP(30)%'",
        )
        .await
        .unwrap()
        .unwrap()
    }

    /// Live cancel/timeout check with a one-connection pool: the kill uses its own
    /// connection, the interrupted session is closed, and the catalog keeps working.
    #[tokio::test]
    #[ignore]
    async fn agent_mysql_live_cancel() {
        let url = std::env::var("AGENT_MYSQL_URL").expect("set AGENT_MYSQL_URL");
        let opts = mysql_async::Opts::from_url(&url).unwrap();
        let pool = Pool::new(
            mysql_async::OptsBuilder::from_opts(opts.clone()).pool_opts(
                mysql_async::PoolOpts::default()
                    .with_constraints(mysql_async::PoolConstraints::new(0, 1).unwrap()),
            ),
        );
        let observer = Pool::new(opts);
        let catalog = MySqlCatalog {
            pool: pool.clone(),
            engine: EngineKind::Mysql,
            timeout: Duration::from_secs(2),
        };
        fn slow(conn: &mut Conn, _: Bound) -> ConnFuture<'_, ()> {
            Box::pin(async move { conn.query_drop("SELECT SLEEP(30)").await.map_err(failed) })
        }

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
        assert_eq!(active_sleeps(&observer).await, 0);

        let ctx = ToolContext {
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
        };
        let started = std::time::Instant::now();
        assert_eq!(
            catalog.read_only(&ctx, slow).await.unwrap_err(),
            "catalog query timed out"
        );
        ctx.tracker.close();
        ctx.tracker.wait().await;
        assert!(started.elapsed() < Duration::from_secs(8));
        assert_eq!(active_sleeps(&observer).await, 0);

        // Exhausted pool: checkout is bounded, then the catalog works again.
        let held = pool.get_conn().await.unwrap();
        let ctx = ToolContext {
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
        };
        assert_eq!(
            catalog.list_schemas(&ctx).await.unwrap_err(),
            "could not get a database connection"
        );
        drop(held);
        assert!(!catalog.list_schemas(&ctx).await.unwrap().is_empty());
    }

    /// Live check that user code reachable from a plain-looking query blocks Run.
    #[tokio::test]
    #[ignore]
    async fn agent_mysql_live_identity() {
        let url = std::env::var("AGENT_MYSQL_URL").expect("set AGENT_MYSQL_URL");
        let admin_opts = mysql_async::Opts::from_url(&url).unwrap();
        let admin = Pool::new(admin_opts.clone());
        let mut conn = admin.get_conn().await.unwrap();
        let mariadb: bool = conn
            .query_first("SELECT VERSION() LIKE '%MariaDB%'")
            .await
            .unwrap()
            .unwrap();
        let reserved = if mariadb { "mariadb.sys" } else { "mysql.sys" };
        let reset = "DROP VIEW IF EXISTS id_plain, id_locking, mysql.id_locking, sys.id_locking; \
                     DROP FUNCTION IF EXISTS lower; DROP USER IF EXISTS 'agent_ro'@'%'; \
                     DROP TABLE IF EXISTS id_t; \
                     CREATE TABLE id_t (id INT); \
                     CREATE VIEW id_plain AS SELECT id, COUNT(*) AS n FROM id_t GROUP BY id; \
                     CREATE USER 'agent_ro'@'%' IDENTIFIED BY 'agent_ro_pass'; \
                     GRANT SELECT, SHOW VIEW, EXECUTE ON agent_t.* TO 'agent_ro'@'%';";
        conn.query_drop(reset).await.unwrap();
        // An ordinary account: sees only agent_t.
        let user = MySqlCatalog::new(
            Pool::new(
                mysql_async::OptsBuilder::from_opts(admin_opts.clone())
                    .user(Some("agent_ro"))
                    .pass(Some("agent_ro_pass")),
            ),
            EngineKind::Mysql,
        );
        let ctx = ToolContext {
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
        };
        assert!(
            user.only_builtin_code(&ctx).await.unwrap(),
            "plain views only"
        );
        // An administrator sees the stock `sys` views: unsure, Insert only.
        let root = MySqlCatalog::new(admin.clone(), EngineKind::Mysql);
        assert!(!root.only_builtin_code(&ctx).await.unwrap());
        let locking_in = |schema: &str| {
            format!(
                "CREATE DEFINER='{reserved}'@'localhost' SQL SECURITY INVOKER \
                 VIEW {schema}.id_locking AS SELECT GET_LOCK('agent', 0) AS l; \
                 GRANT SELECT, SHOW VIEW ON {schema}.id_locking TO 'agent_ro'@'%';"
            )
        };
        // Every name the syntax check accepts for MySQL is native on this server:
        // creating a stored function with it is refused or noted as shadowing a
        // native function (1585), never silently created.
        for name in crate::ai::agent::sql_safety::MYSQL_FUNCTIONS {
            let created = conn
                .query_drop(format!(
                    "CREATE FUNCTION `{name}`() RETURNS INT DETERMINISTIC RETURN 1"
                ))
                .await;
            if created.is_ok() {
                let notes: Vec<(String, u32, String)> = conn.query("SHOW WARNINGS").await.unwrap();
                conn.query_drop(format!("DROP FUNCTION `{name}`"))
                    .await
                    .unwrap();
                assert!(
                    notes.iter().any(|(_, code, _)| *code == 1585),
                    "{name} is not native here"
                );
            }
        }
        // Every keyword allowed before `(` is reserved here: it cannot name a function
        // unquoted, so an unqualified `keyword(` is never a stored function call.
        for keyword in crate::ai::agent::sql_safety::MYSQL_PAREN_KEYWORDS {
            assert!(
                conn.query_drop(format!(
                    "CREATE FUNCTION {keyword}() RETURNS INT DETERMINISTIC RETURN 1"
                ))
                .await
                .is_err(),
                "{keyword} is not reserved here"
            );
        }
        // Codex round 8: a digit-leading routine name really is callable unqualified and
        // takes the lock, and the syntax check refuses that call.
        conn.query_drop(
            "CREATE FUNCTION `1agent`(x INT) RETURNS INT DETERMINISTIC RETURN GET_LOCK('agent1', 0)",
        )
        .await
        .unwrap();
        for sql in ["SELECT 1agent(1)", "SELECT agent_t.1agent(1)"] {
            assert_eq!(
                crate::ai::agent::sql_safety::classify(sql, "mysql"),
                crate::ai::agent::sql_safety::SqlSafety::Unknown,
                "{sql}"
            );
        }
        {
            let mut other = admin.get_conn().await.unwrap();
            other.query_drop("SELECT 1agent(1)").await.unwrap();
            let held: Option<u64> = other
                .query_first("SELECT IS_USED_LOCK('agent1')")
                .await
                .unwrap()
                .unwrap();
            assert!(held.is_some(), "the fixture should take the lock");
            other.query_drop("DO RELEASE_LOCK('agent1')").await.unwrap();
        }
        conn.query_drop("DROP FUNCTION `1agent`").await.unwrap();
        // A stored function named like a built-in is not what an unqualified call
        // reaches: the built-in wins, so no lock is taken.
        conn.query_drop(
            "CREATE FUNCTION lower(x INT) RETURNS INT DETERMINISTIC RETURN GET_LOCK('agent', 0)",
        )
        .await
        .unwrap();
        assert!(user.only_builtin_code(&ctx).await.unwrap());
        {
            let mut as_user = user.pool.get_conn().await.unwrap();
            as_user.query_drop("SELECT lower(1)").await.unwrap();
            let held: Option<u64> = as_user
                .query_first("SELECT IS_USED_LOCK('agent')")
                .await
                .unwrap()
                .unwrap();
            assert_eq!(held, None, "stored lower() was called");
        }
        conn.query_drop("DROP FUNCTION lower").await.unwrap();
        for setup in [
            "CREATE VIEW id_locking AS SELECT GET_LOCK('agent', 0) AS l".to_string(),
            // Codex rounds 4-5: system schemas, even with the server's reserved definer.
            locking_in("mysql"),
            locking_in("sys"),
        ] {
            conn.query_drop(&setup).await.unwrap();
            assert!(!user.only_builtin_code(&ctx).await.unwrap(), "{setup}");
            conn.query_drop(reset).await.unwrap();
        }
        conn.query_drop("DROP VIEW id_plain; DROP TABLE id_t; DROP USER 'agent_ro'@'%'")
            .await
            .unwrap();
    }
}
