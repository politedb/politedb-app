pub mod cancel;
pub mod driver;
pub mod merge;
pub mod mongo;
pub mod mysql;
pub mod oracle;
pub mod postgres;
pub mod redis;
pub mod registry;
pub mod secrets_util;
pub mod sqlite;
pub mod sqlserver;

use std::sync::Arc;
use uuid::Uuid;

use crate::engines::cancel::CancelHandle;
use crate::operations::ctx::{OperationCtx, SqlBusyRegistry};
use crate::types::{EngineKind, SqlQueryInput};
use crate::types::{OperationKind, RedisCommandInput};
use futures_util::TryStreamExt;
use mysql_async::prelude::Queryable;

#[derive(Clone)]
pub enum EngineConnection {
    Postgres(postgres::connection::PgConn),
    MySql(mysql::connection::MySqlConn),
    SqlServer(sqlserver::connection::SqlServerConn),
    Sqlite(sqlite::connection::SqliteConn),
    Oracle(oracle::connection::OracleConn),
    Mongo(mongo::connection::MongoConn),
    Redis(redis::connection::RedisConn),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SqlStatementKind {
    Ddl,
    Dml,
    TransactionControl,
    Other,
}

fn first_sql_token(sql: &str) -> String {
    sql.trim_start()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_matches(|c: char| !c.is_ascii_alphabetic())
        .to_ascii_uppercase()
}

fn classify_sql_statement(sql: &str) -> SqlStatementKind {
    match first_sql_token(sql).as_str() {
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "RENAME" | "COMMENT" => SqlStatementKind::Ddl,
        "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "REPLACE" => SqlStatementKind::Dml,
        "BEGIN" | "START" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" => {
            SqlStatementKind::TransactionControl
        }
        _ => SqlStatementKind::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_sql_statement, reject_non_transactional_ddl, SqlStatementKind,
    };

    #[test]
    fn classifies_transaction_batch_statements() {
        assert_eq!(
            classify_sql_statement("ALTER TABLE users ADD COLUMN age int"),
            SqlStatementKind::Ddl
        );
        assert_eq!(
            classify_sql_statement("insert into users(id) values (1)"),
            SqlStatementKind::Dml
        );
        assert_eq!(
            classify_sql_statement("ROLLBACK"),
            SqlStatementKind::TransactionControl
        );
    }

    #[test]
    fn rejects_non_transactional_ddl_batches() {
        let statements = vec![
            "ALTER TABLE users ADD COLUMN age int".to_string(),
            "UPDATE users SET age = 1".to_string(),
        ];

        let err = reject_non_transactional_ddl("MYSQL_MARIADB", &statements)
            .expect_err("DDL should be rejected");

        assert!(err.contains("MYSQL_MARIADB_DDL_TRANSACTION_UNSUPPORTED"));
    }
}

fn reject_non_transactional_ddl(engine: &str, statements: &[String]) -> Result<(), String> {
    if statements
        .iter()
        .any(|stmt| classify_sql_statement(stmt) == SqlStatementKind::Ddl)
    {
        return Err(format!(
            "{engine}_DDL_TRANSACTION_UNSUPPORTED: {engine} implicitly commits DDL, so schema edits cannot be safely rolled back in this batch. Run schema and data changes separately."
        ));
    }

    Ok(())
}

async fn drain_sqlserver_query(
    client: &mut tiberius::Client<tokio_util::compat::Compat<tokio::net::TcpStream>>,
    sql: &str,
) -> Result<(), String> {
    let mut stream = client
        .simple_query(sql)
        .await
        .map_err(|e| format!("SQLSERVER_QUERY_FAILED: {e}"))?;

    while stream
        .try_next()
        .await
        .map_err(|e| format!("SQLSERVER_ROW_STREAM_FAILED: {e}"))?
        .is_some()
    {}

    Ok(())
}

pub struct OpCleanup {
    op_id: Uuid,
    kind: OperationKind,
    connection_id: Uuid,
    sql_busy: SqlBusyRegistry,
    running_ops: Arc<dashmap::DashMap<Uuid, CancelHandle>>,
    cancel_requested: Arc<dashmap::DashMap<Uuid, ()>>,
    active_ops: Arc<dashmap::DashMap<Uuid, ()>>,
    op_to_conn: Arc<dashmap::DashMap<Uuid, Uuid>>,
    op_tasks: Arc<dashmap::DashMap<Uuid, tokio::task::JoinHandle<()>>>,
    is_stream_sql: bool,
}

impl Drop for OpCleanup {
    fn drop(&mut self) {
        self.running_ops.remove(&self.op_id);
        self.cancel_requested.remove(&self.op_id);
        self.active_ops.remove(&self.op_id);
        self.op_to_conn.remove(&self.op_id);
        self.op_tasks.remove(&self.op_id);

        // ✅ async release (Drop can't await)
        if self.kind == OperationKind::SqlQuery && self.is_stream_sql {
            self.sql_busy
                .release_if_owner(self.connection_id, self.op_id);
        }
    }
}

impl EngineConnection {
    #[allow(dead_code)]
    pub fn id(&self) -> Uuid {
        match self {
            EngineConnection::Postgres(c) => c.id,
            EngineConnection::MySql(c) => c.id,
            EngineConnection::SqlServer(c) => c.id,
            EngineConnection::Sqlite(c) => c.id,
            EngineConnection::Oracle(c) => c.id,
            EngineConnection::Mongo(c) => c.id,
            EngineConnection::Redis(c) => c.id,
        }
    }

    pub fn label(&self) -> String {
        match self {
            EngineConnection::Postgres(c) => c.label.clone(),
            EngineConnection::MySql(c) => c.label.clone(),
            EngineConnection::SqlServer(c) => c.label.clone(),
            EngineConnection::Sqlite(c) => c.label.clone(),
            EngineConnection::Oracle(c) => c.label.clone(),
            EngineConnection::Mongo(c) => c.label.clone(),
            EngineConnection::Redis(c) => c.label.clone(),
        }
    }

    pub fn engine_kind(&self) -> EngineKind {
        match self {
            EngineConnection::Postgres(_) => EngineKind::Postgres,
            EngineConnection::MySql(c) => c.engine,
            EngineConnection::SqlServer(_) => EngineKind::Sqlserver,
            EngineConnection::Sqlite(_) => EngineKind::Sqlite,
            EngineConnection::Oracle(_) => EngineKind::Oracle,
            EngineConnection::Mongo(_) => EngineKind::Mongo,
            EngineConnection::Redis(_) => EngineKind::Redis,
        }
    }

    #[allow(dead_code)]
    pub fn engine_name(&self) -> &'static str {
        match self {
            EngineConnection::Postgres(_) => "postgres",
            EngineConnection::MySql(c) => match c.engine {
                EngineKind::Mariadb => "mariadb",
                _ => "mysql",
            },
            EngineConnection::SqlServer(_) => "sqlserver",
            EngineConnection::Sqlite(_) => "sqlite",
            EngineConnection::Oracle(_) => "oracle",
            EngineConnection::Mongo(_) => "mongo",
            EngineConnection::Redis(_) => "redis",
        }
    }

    pub async fn close(self) {
        match self {
            EngineConnection::Postgres(pg) => drop(pg.pool),
            EngineConnection::MySql(my) => {
                let _ = my.pool.clone().disconnect().await;
            }
            EngineConnection::SqlServer(_) => {}
            EngineConnection::Sqlite(_) => {}
            EngineConnection::Oracle(_) => {}
            EngineConnection::Mongo(mongo) => drop(mongo.client),
            EngineConnection::Redis(r) => drop(r.pool),
        }
    }

    pub async fn execute_sql_transaction(&self, statements: Vec<String>) -> Result<(), String> {
        let statements = statements
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();

        if statements.is_empty() {
            return Ok(());
        }

        match self {
            EngineConnection::Postgres(pg) => {
                let mut client = pg
                    .pool
                    .get()
                    .await
                    .map_err(|e| format!("POSTGRES_TX_GET_CONN_FAILED: {e}"))?;
                let tx = client
                    .transaction()
                    .await
                    .map_err(|e| format!("POSTGRES_TX_BEGIN_FAILED: {e}"))?;

                for (idx, stmt) in statements.iter().enumerate() {
                    if let Err(e) = tx.batch_execute(stmt).await {
                        let _ = tx.rollback().await;
                        return Err(format!("SQL_TX_STATEMENT_{}_FAILED: {e}", idx + 1));
                    }
                }

                tx.commit()
                    .await
                    .map_err(|e| format!("POSTGRES_TX_COMMIT_FAILED: {e}"))
            }
            EngineConnection::MySql(my) => {
                reject_non_transactional_ddl("MYSQL_MARIADB", &statements)?;

                let mut conn = my
                    .pool
                    .get_conn()
                    .await
                    .map_err(|e| format!("MYSQL_TX_GET_CONN_FAILED: {e}"))?;

                conn.query_drop("START TRANSACTION")
                    .await
                    .map_err(|e| format!("MYSQL_TX_BEGIN_FAILED: {e}"))?;

                for (idx, stmt) in statements.iter().enumerate() {
                    if let Err(e) = conn.query_drop(stmt).await {
                        let _ = conn.query_drop("ROLLBACK").await;
                        return Err(format!("SQL_TX_STATEMENT_{}_FAILED: {e}", idx + 1));
                    }
                }

                conn.query_drop("COMMIT")
                    .await
                    .map_err(|e| format!("MYSQL_TX_COMMIT_FAILED: {e}"))
            }
            EngineConnection::Sqlite(sqlite) => {
                let shared = sqlite.conn.clone();
                tokio::task::spawn_blocking(move || -> Result<(), String> {
                    let conn = shared
                        .lock()
                        .map_err(|_| "SQLITE_CONN_MUTEX_POISONED".to_string())?;

                    conn.execute_batch("BEGIN")
                        .map_err(|e| format!("SQLITE_TX_BEGIN_FAILED: {e}"))?;

                    for (idx, stmt) in statements.iter().enumerate() {
                        if let Err(e) = conn.execute_batch(stmt) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(format!("SQL_TX_STATEMENT_{}_FAILED: {e}", idx + 1));
                        }
                    }

                    conn.execute_batch("COMMIT")
                        .map_err(|e| format!("SQLITE_TX_COMMIT_FAILED: {e}"))
                })
                .await
                .map_err(|e| format!("SQLITE_TX_JOIN_FAILED: {e}"))?
            }
            EngineConnection::SqlServer(ss) => {
                let mut client = sqlserver::operation::make_client(
                    &ss.host,
                    ss.port,
                    &ss.database,
                    &ss.user,
                    &ss.password,
                    ss.encrypt,
                    ss.connect_timeout_ms,
                )
                .await?;

                drain_sqlserver_query(&mut client, "BEGIN TRANSACTION").await?;

                for (idx, stmt) in statements.iter().enumerate() {
                    if let Err(e) = drain_sqlserver_query(&mut client, stmt).await {
                        let _ = drain_sqlserver_query(&mut client, "ROLLBACK TRANSACTION").await;
                        return Err(format!("SQL_TX_STATEMENT_{}_FAILED: {e}", idx + 1));
                    }
                }

                drain_sqlserver_query(&mut client, "COMMIT TRANSACTION")
                    .await
                    .map_err(|e| format!("SQLSERVER_TX_COMMIT_FAILED: {e}"))
            }
            EngineConnection::Oracle(oracle) => {
                reject_non_transactional_ddl("ORACLE", &statements)?;

                let connect_string = oracle.connect_string.clone();
                let user = oracle.user.clone();
                let password = oracle.password.clone();

                tokio::task::spawn_blocking(move || -> Result<(), String> {
                    crate::engines::oracle::ensure_oracle_client_initialized()
                        .map_err(|e| format!("ORACLE_CLIENT_INIT_FAILED: {e}"))?;
                    let conn = ::oracle::Connection::connect(&user, &password, &connect_string)
                        .map_err(|e| format!("ORACLE_TX_CONNECT_FAILED: {e}"))?;

                    for (idx, stmt) in statements.iter().enumerate() {
                        if let Err(e) = conn.execute(stmt, &[]) {
                            let _ = conn.rollback();
                            return Err(format!("SQL_TX_STATEMENT_{}_FAILED: {e}", idx + 1));
                        }
                    }

                    conn.commit()
                        .map_err(|e| format!("ORACLE_TX_COMMIT_FAILED: {e}"))
                })
                .await
                .map_err(|e| format!("ORACLE_TX_JOIN_FAILED: {e}"))?
            }
            EngineConnection::Mongo(_) | EngineConnection::Redis(_) => {
                Err("ENGINE_TRANSACTION_NOT_SUPPORTED".into())
            }
        }
    }

    pub fn spawn_sql_query(&self, ctx: OperationCtx, input: SqlQueryInput) -> Result<(), String> {
        let op_id = ctx.op_id;
        let op_tasks = Arc::clone(&ctx.op_tasks);

        let connection_id = ctx
            .op_to_conn
            .get(&op_id)
            .map(|r| *r.value())
            .ok_or("CONNECTION_NOT_FOUND_FOR_OP")?;

        let sql_busy = ctx.sql_busy.clone();
        let is_stream_sql = input.is_stream();

        match self {
            EngineConnection::Postgres(pg) => {
                let pool = pg.pool.clone();

                // ✅ spawn first, return handle
                let handle = tokio::spawn(async move {
                    let _cleanup = OpCleanup {
                        op_id,
                        kind: OperationKind::SqlQuery,
                        connection_id,
                        sql_busy,
                        is_stream_sql,
                        running_ops: Arc::clone(&ctx.running_ops),
                        cancel_requested: Arc::clone(&ctx.cancel_requested),
                        active_ops: Arc::clone(&ctx.active_ops),
                        op_to_conn: Arc::clone(&ctx.op_to_conn),
                        op_tasks: Arc::clone(&ctx.op_tasks),
                    };

                    crate::engines::postgres::operation::run_pg_sql_query(ctx, pool, input).await;
                });

                // ✅ insert handle using the cloned Arc (NOT ctx)
                op_tasks.insert(op_id, handle);

                Ok(())
            }

            EngineConnection::MySql(my) => {
                let pool = my.pool.clone();
                let default_timeout = my.default_statement_timeout_ms;

                let handle = tokio::spawn(async move {
                    let _cleanup = OpCleanup {
                        op_id,
                        connection_id,
                        kind: OperationKind::SqlQuery,
                        sql_busy,
                        is_stream_sql,
                        running_ops: Arc::clone(&ctx.running_ops),
                        cancel_requested: Arc::clone(&ctx.cancel_requested),
                        active_ops: Arc::clone(&ctx.active_ops),
                        op_to_conn: Arc::clone(&ctx.op_to_conn),
                        op_tasks: Arc::clone(&ctx.op_tasks),
                    };

                    crate::engines::mysql::operation::run_mysql_sql_query(
                        ctx,
                        pool,
                        input,
                        default_timeout,
                    )
                    .await;
                });

                op_tasks.insert(op_id, handle);
                Ok(())
            }
            EngineConnection::SqlServer(ss) => {
                let host = ss.host.clone();
                let port = ss.port;
                let database = ss.database.clone();
                let user = ss.user.clone();
                let password = ss.password.clone();
                let encrypt = ss.encrypt;
                let connect_timeout_ms = ss.connect_timeout_ms;
                let default_timeout = ss.default_statement_timeout_ms;

                let handle = tokio::spawn(async move {
                    let _cleanup = OpCleanup {
                        op_id,
                        connection_id,
                        kind: OperationKind::SqlQuery,
                        sql_busy,
                        is_stream_sql,
                        running_ops: Arc::clone(&ctx.running_ops),
                        cancel_requested: Arc::clone(&ctx.cancel_requested),
                        active_ops: Arc::clone(&ctx.active_ops),
                        op_to_conn: Arc::clone(&ctx.op_to_conn),
                        op_tasks: Arc::clone(&ctx.op_tasks),
                    };

                    crate::engines::sqlserver::operation::run_sqlserver_sql_query(
                        ctx,
                        host,
                        port,
                        database,
                        user,
                        password,
                        encrypt,
                        connect_timeout_ms,
                        input,
                        default_timeout,
                    )
                    .await;
                });

                op_tasks.insert(op_id, handle);
                Ok(())
            }
            EngineConnection::Sqlite(sqlite) => {
                let shared = sqlite.conn.clone();
                let default_timeout = sqlite.default_statement_timeout_ms;

                let handle = tokio::spawn(async move {
                    let _cleanup = OpCleanup {
                        op_id,
                        connection_id,
                        kind: OperationKind::SqlQuery,
                        sql_busy,
                        is_stream_sql,
                        running_ops: Arc::clone(&ctx.running_ops),
                        cancel_requested: Arc::clone(&ctx.cancel_requested),
                        active_ops: Arc::clone(&ctx.active_ops),
                        op_to_conn: Arc::clone(&ctx.op_to_conn),
                        op_tasks: Arc::clone(&ctx.op_tasks),
                    };

                    crate::engines::sqlite::operation::run_sqlite_sql_query(
                        ctx,
                        shared,
                        input,
                        default_timeout,
                    )
                    .await;
                });

                op_tasks.insert(op_id, handle);
                Ok(())
            }
            EngineConnection::Oracle(oracle) => {
                let connect_string = oracle.connect_string.clone();
                let user = oracle.user.clone();
                let password = oracle.password.clone();
                let default_timeout = oracle.default_statement_timeout_ms;

                let handle = tokio::spawn(async move {
                    let _cleanup = OpCleanup {
                        op_id,
                        connection_id,
                        kind: OperationKind::SqlQuery,
                        sql_busy,
                        is_stream_sql,
                        running_ops: Arc::clone(&ctx.running_ops),
                        cancel_requested: Arc::clone(&ctx.cancel_requested),
                        active_ops: Arc::clone(&ctx.active_ops),
                        op_to_conn: Arc::clone(&ctx.op_to_conn),
                        op_tasks: Arc::clone(&ctx.op_tasks),
                    };

                    crate::engines::oracle::operation::run_oracle_sql_query(
                        ctx,
                        connect_string,
                        user,
                        password,
                        input,
                        default_timeout,
                    )
                    .await;
                });

                op_tasks.insert(op_id, handle);
                Ok(())
            }

            EngineConnection::Mongo(_) => Err("ENGINE_OPERATION_NOT_SUPPORTED".into()),
            EngineConnection::Redis(_) => Err("ENGINE_OPERATION_NOT_SUPPORTED".into()),
        }
    }

    pub fn spawn_redis_command(
        &self,
        ctx: OperationCtx,
        input: RedisCommandInput,
    ) -> Result<(), String> {
        match self {
            EngineConnection::Redis(r) => {
                let pool = r.pool.clone();
                let default_timeout_ms = r.default_command_timeout_ms;

                let op_id = ctx.op_id;
                let conn_id = self.id();
                let sql_busy = ctx.sql_busy.clone();

                let op_tasks = Arc::clone(&ctx.op_tasks);
                let op_to_conn = Arc::clone(&ctx.op_to_conn);
                let active_ops = Arc::clone(&ctx.active_ops);

                // register mapping before spawn
                op_to_conn.insert(op_id, conn_id);
                active_ops.insert(op_id, ());

                let handle = tokio::spawn(async move {
                    let _cleanup = OpCleanup {
                        op_id,
                        kind: OperationKind::RedisCommand,
                        connection_id: conn_id,
                        sql_busy,
                        is_stream_sql: false,
                        running_ops: Arc::clone(&ctx.running_ops),
                        cancel_requested: Arc::clone(&ctx.cancel_requested),
                        active_ops: Arc::clone(&ctx.active_ops),
                        op_to_conn: Arc::clone(&ctx.op_to_conn),
                        op_tasks: Arc::clone(&ctx.op_tasks),
                    };

                    crate::engines::redis::operation::run_redis_command(
                        ctx,
                        pool,
                        default_timeout_ms,
                        input,
                    )
                    .await;
                });

                op_tasks.insert(op_id, handle);
                Ok(())
            }

            _ => Err("ENGINE_OPERATION_NOT_SUPPORTED".into()),
        }
    }
}
