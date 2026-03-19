pub mod cancel;
pub mod driver;
pub mod merge;
pub mod mongo;
pub mod mysql;
pub mod postgres;
pub mod redis;
pub mod registry;
pub mod secrets_util;

use std::sync::Arc;
use uuid::Uuid;

use crate::engines::cancel::CancelHandle;
use crate::operations::ctx::{OperationCtx, SqlBusyRegistry};
use crate::types::{EngineKind, SqlQueryInput};
use crate::types::{OperationKind, RedisCommandInput};

#[derive(Clone)]
pub enum EngineConnection {
    Postgres(postgres::connection::PgConn),
    MySql(mysql::connection::MySqlConn),
    Mongo(mongo::connection::MongoConn),
    Redis(redis::connection::RedisConn),
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
            EngineConnection::Mongo(c) => c.id,
            EngineConnection::Redis(c) => c.id,
        }
    }

    pub fn label(&self) -> String {
        match self {
            EngineConnection::Postgres(c) => c.label.clone(),
            EngineConnection::MySql(c) => c.label.clone(),
            EngineConnection::Mongo(c) => c.label.clone(),
            EngineConnection::Redis(c) => c.label.clone(),
        }
    }

    pub fn engine_kind(&self) -> EngineKind {
        match self {
            EngineConnection::Postgres(_) => EngineKind::Postgres,
            EngineConnection::MySql(c) => c.engine,
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
            EngineConnection::Mongo(mongo) => drop(mongo.client),
            EngineConnection::Redis(r) => drop(r.pool),
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
