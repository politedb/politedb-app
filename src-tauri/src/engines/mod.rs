pub mod cancel;
pub mod driver;
pub mod merge;
pub mod mysql;
pub mod postgres;
pub mod redis;
pub mod registry;
pub mod secrets_util;

use std::sync::Arc;
use uuid::Uuid;

use crate::engines::cancel::CancelHandle;
use crate::operations::ctx::OperationCtx;
use crate::types::RedisCommandInput;
use crate::types::{EngineKind, SqlQueryInput};

#[derive(Clone)]
pub enum EngineConnection {
    Postgres(postgres::connection::PgConn),
    MySql(mysql::connection::MySqlConn),
    Redis(redis::connection::RedisConn),
}

pub struct OpCleanup {
    op_id: Uuid,
    running_ops: Arc<dashmap::DashMap<Uuid, CancelHandle>>,
    cancel_requested: Arc<dashmap::DashMap<Uuid, ()>>,
    active_ops: Arc<dashmap::DashMap<Uuid, ()>>,
    op_to_conn: Arc<dashmap::DashMap<Uuid, Uuid>>,
}

impl Drop for OpCleanup {
    fn drop(&mut self) {
        self.running_ops.remove(&self.op_id);
        self.cancel_requested.remove(&self.op_id);
        self.active_ops.remove(&self.op_id);
        self.op_to_conn.remove(&self.op_id);
    }
}

impl EngineConnection {
    #[allow(dead_code)]
    pub fn id(&self) -> Uuid {
        match self {
            EngineConnection::Postgres(c) => c.id,
            EngineConnection::MySql(c) => c.id,
            EngineConnection::Redis(c) => c.id,
        }
    }

    pub fn label(&self) -> String {
        match self {
            EngineConnection::Postgres(c) => c.label.clone(),
            EngineConnection::MySql(c) => c.label.clone(),
            EngineConnection::Redis(c) => c.label.clone(),
        }
    }

    pub fn engine_kind(&self) -> EngineKind {
        match self {
            EngineConnection::Postgres(_) => EngineKind::Postgres,
            EngineConnection::MySql(_) => EngineKind::Mysql,
            EngineConnection::Redis(_) => EngineKind::Redis,
        }
    }

    #[allow(dead_code)]
    pub fn engine_name(&self) -> &'static str {
        match self {
            EngineConnection::Postgres(_) => "postgres",
            EngineConnection::MySql(_) => "mysql",
            EngineConnection::Redis(_) => "redis",
        }
    }

    pub fn spawn_sql_query(&self, ctx: OperationCtx, input: SqlQueryInput) -> Result<(), String> {
        match self {
            EngineConnection::Postgres(pg) => {
                let pool = pg.pool.clone();

                tokio::spawn(async move {
                    let _cleanup = OpCleanup {
                        op_id: ctx.op_id,
                        running_ops: Arc::clone(&ctx.running_ops),
                        cancel_requested: Arc::clone(&ctx.cancel_requested),
                        active_ops: Arc::clone(&ctx.active_ops),
                        op_to_conn: Arc::clone(&ctx.op_to_conn),
                    };

                    crate::engines::postgres::operation::run_pg_sql_query(ctx, pool, input).await;
                    // cleanup runs here
                });

                Ok(())
            }

            EngineConnection::MySql(my) => {
                let pool = my.pool.clone();
                let default_timeout = my.default_statement_timeout_ms;

                tokio::spawn(async move {
                    let _cleanup = OpCleanup {
                        op_id: ctx.op_id,
                        running_ops: Arc::clone(&ctx.running_ops),
                        cancel_requested: Arc::clone(&ctx.cancel_requested),
                        active_ops: Arc::clone(&ctx.active_ops),
                        op_to_conn: Arc::clone(&ctx.op_to_conn),
                    };

                    crate::engines::mysql::operation::run_mysql_sql_query(
                        ctx,
                        pool,
                        input,
                        default_timeout,
                    )
                    .await;
                });

                Ok(())
            }

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

                tokio::spawn(async move {
                    let _cleanup = OpCleanup {
                        op_id: ctx.op_id,
                        running_ops: Arc::clone(&ctx.running_ops),
                        cancel_requested: Arc::clone(&ctx.cancel_requested),
                        active_ops: Arc::clone(&ctx.active_ops),
                        op_to_conn: Arc::clone(&ctx.op_to_conn),
                    };

                    crate::engines::redis::operation::run_redis_command(
                        ctx,
                        pool,
                        default_timeout_ms,
                        input,
                    )
                    .await;
                });

                Ok(())
            }

            _ => Err("ENGINE_OPERATION_NOT_SUPPORTED".into()),
        }
    }
}
