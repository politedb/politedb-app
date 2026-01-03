use std::sync::Arc;

use tauri::AppHandle;
use uuid::Uuid;

use crate::engines::cancel::CancelHandle;

pub struct OperationCtx {
    pub op_id: Uuid,
    pub app: AppHandle,

    pub running_ops: Arc<dashmap::DashMap<Uuid, CancelHandle>>,
    pub cancel_requested: Arc<dashmap::DashMap<Uuid, ()>>,
    pub active_ops: Arc<dashmap::DashMap<Uuid, ()>>,
}

/// Always clean active marker + pending cancel request,
/// even if runner fails early (before registering cancel handle).
pub struct ActiveGuard {
    op_id: Uuid,
    active_ops: Arc<dashmap::DashMap<Uuid, ()>>,
    cancel_requested: Arc<dashmap::DashMap<Uuid, ()>>,
}

impl ActiveGuard {
    pub fn new(
        op_id: Uuid,
        active_ops: Arc<dashmap::DashMap<Uuid, ()>>,
        cancel_requested: Arc<dashmap::DashMap<Uuid, ()>>,
    ) -> Self {
        Self {
            op_id,
            active_ops,
            cancel_requested,
        }
    }
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.active_ops.remove(&self.op_id);
        self.cancel_requested.remove(&self.op_id);
    }
}

/// Clean running_ops once cancel handle exists.
pub struct RunningGuard {
    op_id: Uuid,
    running_ops: Arc<dashmap::DashMap<Uuid, CancelHandle>>,
}

impl RunningGuard {
    pub fn new(op_id: Uuid, running_ops: Arc<dashmap::DashMap<Uuid, CancelHandle>>) -> Self {
        Self { op_id, running_ops }
    }
}

impl Drop for RunningGuard {
    fn drop(&mut self) {
        self.running_ops.remove(&self.op_id);
    }
}
