pub mod cancel;
pub mod driver;
pub mod merge;
pub mod mysql;
pub mod postgres;
pub mod redis;
pub mod registry;
pub mod secrets_util;

use uuid::Uuid;

use crate::operations::ctx::OperationCtx;
use crate::types::RedisCommandInput;
use crate::types::{EngineKind, SqlQueryInput};

#[derive(Clone)]
pub enum EngineConnection {
    Postgres(postgres::connection::PgConn),
    MySql(mysql::connection::MySqlConn),
    Redis(redis::connection::RedisConn),
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
                    crate::engines::postgres::operation::run_pg_sql_query(ctx, pool, input).await;
                });
                Ok(())
            }
            EngineConnection::MySql(my) => {
                let pool = my.pool.clone();
                let default_timeout = my.default_statement_timeout_ms;

                tokio::spawn(async move {
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
