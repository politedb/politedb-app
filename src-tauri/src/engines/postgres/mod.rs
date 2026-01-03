pub mod config;
pub mod driver;
pub mod row_codec;

use uuid::Uuid;

#[derive(Clone)]
pub struct PgConn {
    pub id: Uuid,
    pub label: String,
    pub pool: deadpool_postgres::Pool,
}
