use uuid::Uuid;

#[derive(Clone)]
pub struct PgConn {
    #[allow(dead_code)]
    pub id: Uuid,
    pub label: String,
    pub pool: deadpool_postgres::Pool,
}
