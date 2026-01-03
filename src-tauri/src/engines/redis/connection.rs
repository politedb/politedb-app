use uuid::Uuid;

#[derive(Clone)]
pub struct RedisConn {
    pub id: Uuid,
    pub label: String,

    // pool type (deadpool_redis)
    pub pool: deadpool_redis::Pool,

    // default per-connection timeout (used if Operation input doesn't override)
    pub default_command_timeout_ms: Option<u64>,
}
