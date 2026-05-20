use std::sync::Arc;

use scylla::client::session::Session;
use uuid::Uuid;

#[derive(Clone)]
pub struct CassandraConn {
    pub id: Uuid,
    pub label: String,
    pub session: Arc<Session>,
    pub default_keyspace: Option<String>,
}
