use std::sync::Arc;

use dashmap::DashMap;
use futures_util::lock::Mutex;
use tauri::AppHandle;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::engines::cancel::CancelHandle;

pub struct OperationCtx {
    pub op_id: Uuid,
    pub app: AppHandle,

    pub running_ops: Arc<dashmap::DashMap<Uuid, CancelHandle>>,
    pub cancel_requested: Arc<dashmap::DashMap<Uuid, ()>>,
    pub active_ops: Arc<dashmap::DashMap<Uuid, ()>>,
    pub op_to_conn: Arc<dashmap::DashMap<Uuid, Uuid>>,

    // per-op flow control for chunk streaming
    pub flow_by_op: Arc<DashMap<Uuid, FlowCtrl>>,
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

#[derive(Clone)]
pub struct FlowCtrl {
    pub sem: Arc<Semaphore>,
    pub next_seq: Arc<Mutex<u64>>,
}

impl FlowCtrl {
    pub fn new(window: usize) -> Self {
        Self {
            sem: Arc::new(Semaphore::new(window)),
            next_seq: Arc::new(Mutex::new(0)),
        }
    }

    pub async fn acquire_credit(&self) -> tokio::sync::OwnedSemaphorePermit {
        self.sem.clone().acquire_owned().await.unwrap()
    }

    pub async fn alloc_seq(&self) -> u64 {
        let mut g = self.next_seq.lock().await;
        let s = *g;
        *g += 1;
        s
    }

    pub fn ack(&self, permits: usize) {
        self.sem.add_permits(permits);
    }
}

// Auto-remove FlowCtrl when op finishes to avoid leaks.
pub struct FlowGuard {
    op_id: Uuid,
    flow_by_op: Arc<DashMap<Uuid, FlowCtrl>>,
}

impl FlowGuard {
    pub fn new(op_id: Uuid, flow_by_op: Arc<DashMap<Uuid, FlowCtrl>>) -> Self {
        Self { op_id, flow_by_op }
    }
}

impl Drop for FlowGuard {
    fn drop(&mut self) {
        self.flow_by_op.remove(&self.op_id);
    }
}
