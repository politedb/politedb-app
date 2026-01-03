pub mod cancel;
pub mod driver;
pub mod mysql;
pub mod postgres;
pub mod registry;

use uuid::Uuid;

use crate::operations::ctx::OperationCtx;
use crate::types::{EngineKind, SqlQueryInput};

#[derive(Clone)]
pub enum EngineConnection {
    Postgres(postgres::connection::PgConn),
    MySql(mysql::connection::MySqlConn),
}

impl EngineConnection {
    #[allow(dead_code)]
    pub fn id(&self) -> Uuid {
        match self {
            EngineConnection::Postgres(c) => c.id,
            EngineConnection::MySql(c) => c.id,
        }
    }

    pub fn label(&self) -> String {
        match self {
            EngineConnection::Postgres(c) => c.label.clone(),
            EngineConnection::MySql(c) => c.label.clone(),
        }
    }

    pub fn engine_kind(&self) -> EngineKind {
        match self {
            EngineConnection::Postgres(_) => EngineKind::Postgres,
            EngineConnection::MySql(_) => EngineKind::Mysql,
        }
    }

    pub fn engine_name(&self) -> &'static str {
        match self {
            EngineConnection::Postgres(_) => "postgres",
            EngineConnection::MySql(_) => "mysql",
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
        }
    }
}
