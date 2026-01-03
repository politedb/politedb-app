use dashmap::DashMap;
use uuid::Uuid;

use crate::engines::EngineConnection;

pub struct AppState {
    pub connections: DashMap<Uuid, EngineConnection>,
    pub running_ops: DashMap<Uuid, tokio_postgres::CancelToken>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            connections: DashMap::new(),
            running_ops: DashMap::new(),
        }
    }
}
