use uuid::Uuid;

#[derive(Clone)]
pub struct PgConn {
    #[allow(dead_code)]
    pub id: Uuid,
    pub label: String,
    pub pool: deadpool_postgres::Pool,
    /// Same settings as the pool (endpoint, credentials, application name).
    /// Explain Analyze opens its own quiet session from it.
    pub config: tokio_postgres::Config,
}
