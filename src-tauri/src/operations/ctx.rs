use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use dashmap::DashMap;
use tauri::AppHandle;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::engines::cancel::CancelHandle;

/* =============================================================================
 * Operation Context
 * ============================================================================= */

pub struct OperationCtx {
    pub op_id: Uuid,
    pub app: AppHandle,

    pub running_ops: Arc<DashMap<Uuid, CancelHandle>>,
    pub cancel_requested: Arc<DashMap<Uuid, ()>>,
    pub active_ops: Arc<DashMap<Uuid, ()>>,
    pub op_to_conn: Arc<DashMap<Uuid, Uuid>>,

    // ✅ busy guard (sync mutex; safe in Drop)
    pub sql_busy: SqlBusyRegistry,

    // per-op flow control for chunk streaming
    pub flow_by_op: Arc<DashMap<Uuid, FlowCtrl>>,
    pub op_tasks: Arc<DashMap<Uuid, tokio::task::JoinHandle<()>>>,
}

/* =============================================================================
 * ActiveGuard
 * ============================================================================= */

/// Always clean active marker + pending cancel request,
/// even if runner fails early (before registering cancel handle).
pub struct ActiveGuard {
    op_id: Uuid,
    active_ops: Arc<DashMap<Uuid, ()>>,
    cancel_requested: Arc<DashMap<Uuid, ()>>,
}

impl ActiveGuard {
    pub fn new(
        op_id: Uuid,
        active_ops: Arc<DashMap<Uuid, ()>>,
        cancel_requested: Arc<DashMap<Uuid, ()>>,
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

/* =============================================================================
 * RunningGuard
 * ============================================================================= */

/// Clean running_ops once cancel handle exists.
pub struct RunningGuard {
    op_id: Uuid,
    running_ops: Arc<DashMap<Uuid, CancelHandle>>,
}

impl RunningGuard {
    pub fn new(op_id: Uuid, running_ops: Arc<DashMap<Uuid, CancelHandle>>) -> Self {
        Self { op_id, running_ops }
    }
}

impl Drop for RunningGuard {
    fn drop(&mut self) {
        self.running_ops.remove(&self.op_id);
    }
}

/* =============================================================================
 * Flow Control
 * ============================================================================= */

#[derive(Clone)]
pub struct FlowCtrl {
    pub sem: Arc<Semaphore>,
    pub next_seq: Arc<tokio::sync::Mutex<u64>>,
}

impl FlowCtrl {
    pub fn new(window: usize) -> Self {
        Self {
            sem: Arc::new(Semaphore::new(window)),
            next_seq: Arc::new(tokio::sync::Mutex::new(0)),
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

/* =============================================================================
 * SQL Busy Registry (sync)
 * ============================================================================= */

#[derive(Clone)]
pub struct SqlBusyRegistry {
    pub busy_by_conn: Arc<Mutex<HashMap<Uuid, Uuid>>>,
}

impl SqlBusyRegistry {
    pub fn new() -> Self {
        Self {
            busy_by_conn: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn try_acquire(&self, connection_id: Uuid, op_id: Uuid) -> Result<(), String> {
        let mut map = self.busy_by_conn.lock().unwrap();

        if let Some(existing) = map.get(&connection_id) {
            return Err(format!("ERR_SQL_BUSY:{}", existing));
        }

        map.insert(connection_id, op_id);
        Ok(())
    }

    pub fn release_if_owner(&self, connection_id: Uuid, op_id: Uuid) {
        let mut map = self.busy_by_conn.lock().unwrap();
        match map.get(&connection_id) {
            Some(cur) if *cur == op_id => {
                map.remove(&connection_id);
            }
            _ => {}
        }
    }

    pub fn clear(&self) {
        self.busy_by_conn.lock().unwrap().clear();
    }
}
