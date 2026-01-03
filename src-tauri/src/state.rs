use std::sync::Arc;

use dashmap::DashMap;
use uuid::Uuid;

use crate::engines::EngineConnection;
use tokio_postgres::CancelToken;

pub struct AppState {
    /// Runtime connections (in-memory)
    pub connections: Arc<DashMap<Uuid, EngineConnection>>,

    /// Running operations (cancel tokens)
    pub running_ops: Arc<DashMap<Uuid, CancelToken>>,

    /// Cancellation requests
    pub cancel_requested: Arc<dashmap::DashMap<Uuid, ()>>,

    pub active_ops: Arc<dashmap::DashMap<Uuid, ()>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(DashMap::new()),
            running_ops: Arc::new(DashMap::new()),
            cancel_requested: Arc::new(dashmap::DashMap::new()),
            active_ops: Arc::new(dashmap::DashMap::new()),
        }
    }
}
