use std::sync::Arc;

use mysql_async::prelude::Queryable;

use crate::operations::ctx::OperationCtx;
use crate::types::{
    EngineKind, OperationKind, RedisCommandInput, SqlImportCsvInput, SqlImportCsvResult,
    SqlQueryInput,
};
use uuid::Uuid;

use super::super::csv_import::{build_csv_import_statements, drain_sqlserver_query};
use super::super::op_cleanup::OpCleanup;
use super::super::sql_classify::reject_non_transactional_ddl;
use super::super::EngineConnection;

/// Runtime operations for a live database connection (SQL, Redis, transactions).
#[async_trait::async_trait]
pub trait ConnectionOps: Send + Sync {
    fn connection_id(&self) -> Uuid;
    fn label(&self) -> String;
    fn engine_kind(&self) -> EngineKind;

    async fn close(self);

    async fn execute_sql_transaction(&self, statements: Vec<String>) -> Result<(), String>;

    async fn import_csv_transaction(
        &self,
        input: SqlImportCsvInput,
    ) -> Result<SqlImportCsvResult, String>;

    fn spawn_sql_query(&self, ctx: OperationCtx, input: SqlQueryInput) -> Result<(), String>;

    fn spawn_redis_command(
        &self,
        ctx: OperationCtx,
        input: RedisCommandInput,
    ) -> Result<(), String>;
}

#[async_trait::async_trait]
impl ConnectionOps for EngineConnection {
    fn connection_id(&self) -> Uuid {
        match self {
            EngineConnection::Postgres(c) => c.id,
            EngineConnection::MySql(c) => c.id,
            EngineConnection::SqlServer(c) => c.id,
            EngineConnection::Sqlite(c) => c.id,
            EngineConnection::D1(c) => c.id,
            EngineConnection::Turso(c) => c.id,
            EngineConnection::Oracle(c) => c.id,
            EngineConnection::Mongo(c) => c.id,
            EngineConnection::Cassandra(c) => c.id,
            EngineConnection::Redis(c) => c.id,
            EngineConnection::Snowflake(c) => c.id,
            EngineConnection::Duckdb(c) => c.id,
            EngineConnection::Clickhouse(c) => c.id,
        }
    }

    fn label(&self) -> String {
        match self {
            EngineConnection::Postgres(c) => c.label.clone(),
            EngineConnection::MySql(c) => c.label.clone(),
            EngineConnection::SqlServer(c) => c.label.clone(),
            EngineConnection::Sqlite(c) => c.label.clone(),
            EngineConnection::D1(c) => c.label.clone(),
            EngineConnection::Turso(c) => c.label.clone(),
            EngineConnection::Oracle(c) => c.label.clone(),
            EngineConnection::Mongo(c) => c.label.clone(),
            EngineConnection::Cassandra(c) => c.label.clone(),
            EngineConnection::Redis(c) => c.label.clone(),
            EngineConnection::Snowflake(c) => c.label.clone(),
            EngineConnection::Duckdb(c) => c.label.clone(),
            EngineConnection::Clickhouse(c) => c.label.clone(),
        }
    }

    fn engine_kind(&self) -> EngineKind {
        match self {
            EngineConnection::Postgres(_) => EngineKind::Postgres,
            EngineConnection::MySql(c) => c.engine,
            EngineConnection::SqlServer(_) => EngineKind::Sqlserver,
            EngineConnection::Sqlite(_) => EngineKind::Sqlite,
            EngineConnection::D1(_) => EngineKind::D1,
            EngineConnection::Turso(_) => EngineKind::Turso,
            EngineConnection::Oracle(_) => EngineKind::Oracle,
            EngineConnection::Mongo(_) => EngineKind::Mongo,
            EngineConnection::Cassandra(_) => EngineKind::Cassandra,
            EngineConnection::Redis(_) => EngineKind::Redis,
            EngineConnection::Snowflake(_) => EngineKind::Snowflake,
            EngineConnection::Duckdb(_) => EngineKind::Duckdb,
            EngineConnection::Clickhouse(_) => EngineKind::Clickhouse,
        }
    }

    #[allow(dead_code)]

    async fn close(self) {
        match self {
            EngineConnection::Postgres(pg) => drop(pg.pool),
            EngineConnection::MySql(my) => {
                let _ = my.pool.clone().disconnect().await;
            }
            EngineConnection::SqlServer(_) => {}
            EngineConnection::Sqlite(_) => {}
            EngineConnection::D1(_) => {}
            EngineConnection::Turso(_) => {}
            EngineConnection::Oracle(_) => {}
            EngineConnection::Mongo(mongo) => drop(mongo.client),
            EngineConnection::Cassandra(_) => {}
            EngineConnection::Redis(r) => drop(r.pool),
            EngineConnection::Snowflake(_) => {}
            EngineConnection::Duckdb(_) => {}
            EngineConnection::Clickhouse(_) => {}
        }
    }

    async fn execute_sql_transaction(&self, statements: Vec<String>) -> Result<(), String> {
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
            EngineConnection::Duckdb(duckdb) => {
                let shared = duckdb.conn.clone();
                tokio::task::spawn_blocking(move || -> Result<(), String> {
                    crate::engines::duckdb::util::with_duckdb_connection(&shared, |conn| {
                        conn.execute_batch("BEGIN")
                            .map_err(|e| format!("DUCKDB_TX_BEGIN_FAILED: {e}"))?;

                        for (idx, stmt) in statements.iter().enumerate() {
                            if let Err(e) = conn.execute_batch(stmt) {
                                let _ = conn.execute_batch("ROLLBACK");
                                return Err(format!("SQL_TX_STATEMENT_{}_FAILED: {e}", idx + 1));
                            }
                        }

                        conn.execute_batch("COMMIT")
                            .map_err(|e| format!("DUCKDB_TX_COMMIT_FAILED: {e}"))
                    })
                })
                .await
                .map_err(|e| format!("DUCKDB_TX_JOIN_FAILED: {e}"))?
            }
            EngineConnection::D1(d1) => {
                let http = d1.http.clone();
                let api_base = d1.api_base.clone();
                let account_id = d1.account_id.clone();
                let database_id = d1.database_id.clone();
                let api_token = d1.api_token.clone();
                for (idx, stmt) in statements.iter().enumerate() {
                    crate::engines::d1::api::execute_d1_query(
                        &http,
                        &api_base,
                        &account_id,
                        &database_id,
                        &api_token,
                        stmt,
                    )
                    .await
                    .map_err(|e| format!("SQL_TX_STATEMENT_{}_FAILED: {e}", idx + 1))?;
                }
                Ok(())
            }
            EngineConnection::Turso(turso) => {
                crate::engines::turso::operation::execute_turso_statements(&turso, &statements)
                    .await
            }
            EngineConnection::SqlServer(ss) => {
                let mut client = crate::engines::sqlserver::operation::make_client(
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
            EngineConnection::Snowflake(sf) => {
                reject_non_transactional_ddl("SNOWFLAKE", &statements)?;

                let input = {
                    use crate::types::secret::{SecretRef, SecretRefKind};
                    crate::types::SnowflakeConnectInput {
                        account: sf.account.clone(),
                        warehouse: sf.warehouse.clone(),
                        database: sf.database.clone(),
                        schema: Some(sf.schema.clone()),
                        role: sf.role.clone(),
                        user: sf.user.clone(),
                        password: SecretRef {
                            kind: SecretRefKind::Inline,
                            value: sf.password.clone(),
                        },
                        connect_timeout_ms: sf.connect_timeout_ms,
                        statement_timeout_ms: sf.default_statement_timeout_ms,
                    }
                };

                let session =
                    crate::engines::snowflake::create_session(&input, &sf.password).await?;
                for (idx, stmt) in statements.iter().enumerate() {
                    session
                        .query(stmt.as_str())
                        .await
                        .map_err(|e| format!("SQL_TX_STATEMENT_{}_FAILED: {e}", idx + 1))?;
                }
                Ok(())
            }
            EngineConnection::Clickhouse(ch) => {
                reject_non_transactional_ddl("CLICKHOUSE", &statements)?;

                for (idx, stmt) in statements.iter().enumerate() {
                    crate::engines::clickhouse::operation::execute_json_query(
                        ch,
                        stmt,
                        ch.default_statement_timeout_ms,
                    )
                    .await
                    .map_err(|e| format!("SQL_TX_STATEMENT_{}_FAILED: {e}", idx + 1))?;
                }
                Ok(())
            }
            EngineConnection::Mongo(_)
            | EngineConnection::Cassandra(_)
            | EngineConnection::Redis(_) => Err("ENGINE_TRANSACTION_NOT_SUPPORTED".into()),
        }
    }

    async fn import_csv_transaction(
        &self,
        input: SqlImportCsvInput,
    ) -> Result<SqlImportCsvResult, String> {
        let statements = build_csv_import_statements(&input)?;
        let imported = statements.len();
        <Self as ConnectionOps>::execute_sql_transaction(&self, statements).await?;
        Ok(SqlImportCsvResult { imported })
    }

    fn spawn_sql_query(&self, ctx: OperationCtx, input: SqlQueryInput) -> Result<(), String> {
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
            EngineConnection::Duckdb(duckdb) => {
                let shared = duckdb.conn.clone();
                let default_timeout = duckdb.default_statement_timeout_ms;

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

                    crate::engines::duckdb::operation::run_duckdb_sql_query(
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
            EngineConnection::D1(d1) => {
                let d1 = d1.clone();

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

                    crate::engines::d1::operation::run_d1_sql_query(ctx, d1, input).await;
                });

                op_tasks.insert(op_id, handle);
                Ok(())
            }
            EngineConnection::Turso(turso) => {
                let turso = turso.clone();

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

                    crate::engines::turso::operation::run_turso_sql_query(ctx, turso, input).await;
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

            EngineConnection::Snowflake(sf) => {
                let conn = sf.clone();
                let default_timeout = sf.default_statement_timeout_ms;

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

                    crate::engines::snowflake::operation::run_snowflake_sql_query(
                        ctx,
                        conn,
                        input,
                        default_timeout,
                    )
                    .await;
                });

                op_tasks.insert(op_id, handle);
                Ok(())
            }

            EngineConnection::Clickhouse(ch) => {
                let conn = ch.clone();
                let default_timeout = ch.default_statement_timeout_ms;

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

                    crate::engines::clickhouse::operation::run_clickhouse_sql_query(
                        ctx,
                        conn,
                        input,
                        default_timeout,
                    )
                    .await;
                });

                op_tasks.insert(op_id, handle);
                Ok(())
            }

            EngineConnection::Mongo(_) | EngineConnection::Cassandra(_) => {
                Err("ENGINE_OPERATION_NOT_SUPPORTED".into())
            }
            EngineConnection::Redis(_) => Err("ENGINE_OPERATION_NOT_SUPPORTED".into()),
        }
    }

    fn spawn_redis_command(
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

/// Backward-compatible inherent API on the connection enum.
impl EngineConnection {
    #[allow(dead_code)]
    pub fn id(&self) -> Uuid {
        ConnectionOps::connection_id(self)
    }

    pub fn label(&self) -> String {
        ConnectionOps::label(self)
    }

    pub fn engine_kind(&self) -> EngineKind {
        ConnectionOps::engine_kind(self)
    }

    pub async fn close(self) {
        ConnectionOps::close(self).await
    }

    pub async fn execute_sql_transaction(&self, statements: Vec<String>) -> Result<(), String> {
        ConnectionOps::execute_sql_transaction(self, statements).await
    }

    pub async fn import_csv_transaction(
        &self,
        input: SqlImportCsvInput,
    ) -> Result<SqlImportCsvResult, String> {
        ConnectionOps::import_csv_transaction(self, input).await
    }

    pub fn spawn_sql_query(&self, ctx: OperationCtx, input: SqlQueryInput) -> Result<(), String> {
        ConnectionOps::spawn_sql_query(self, ctx, input)
    }

    pub fn spawn_redis_command(
        &self,
        ctx: OperationCtx,
        input: RedisCommandInput,
    ) -> Result<(), String> {
        ConnectionOps::spawn_redis_command(self, ctx, input)
    }
}
