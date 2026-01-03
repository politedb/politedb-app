use std::sync::Arc;

use dashmap::DashMap;
use uuid::Uuid;

use crate::engines::{cancel::CancelHandle, registry::EngineRegistry, EngineConnection};

pub struct AppState {
    /// Engine registry (drivers)
    pub engines: EngineRegistry,

    /// Runtime connections (in-memory)
    pub connections: Arc<DashMap<Uuid, EngineConnection>>,

    /// Running operations (engine-agnostic cancel handles)
    pub running_ops: Arc<DashMap<Uuid, CancelHandle>>,

    /// Cancellation requests (op_id -> ())
    pub cancel_requested: Arc<DashMap<Uuid, ()>>,

    /// Active operations marker (op_id -> ())
    pub active_ops: Arc<DashMap<Uuid, ()>>,
}

impl AppState {
    pub fn new(engines: EngineRegistry) -> Self {
        Self {
            engines,
            connections: Arc::new(DashMap::new()),
            running_ops: Arc::new(DashMap::new()),
            cancel_requested: Arc::new(DashMap::new()),
            active_ops: Arc::new(DashMap::new()),
        }
    }
}
