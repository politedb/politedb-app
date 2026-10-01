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

    /// Release whatever connection slot is owned by `op_id`, if any.
    ///
    /// Prefer this on cancel: it does not require `op_to_conn` to still map the
    /// op. `release_if_owner` alone silently no-ops when that mapping was already
    /// cleared (OpCleanup removes it before releasing; `connection_remove` clears
    /// it without touching busy) while the busy slot can remain held.
    pub fn release_op(&self, op_id: Uuid) {
        let mut map = self.busy_by_conn.lock().unwrap();
        map.retain(|_, owner| *owner != op_id);
    }

    /// Drop any busy entry for a connection (e.g. connection teardown).
    pub fn force_release_conn(&self, connection_id: Uuid) {
        let mut map = self.busy_by_conn.lock().unwrap();
        map.remove(&connection_id);
    }

    pub fn clear(&self) {
        self.busy_by_conn.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_acquire_rejects_second_stream_on_same_connection() {
        let reg = SqlBusyRegistry::new();
        let conn = Uuid::new_v4();
        let op1 = Uuid::new_v4();
        let op2 = Uuid::new_v4();

        reg.try_acquire(conn, op1).unwrap();
        let err = reg.try_acquire(conn, op2).unwrap_err();
        assert!(err.contains("ERR_SQL_BUSY"));
        assert!(err.contains(&op1.to_string()));
    }

    #[test]
    fn busy_release_on_cancel_allows_immediate_reacquire() {
        let reg = SqlBusyRegistry::new();
        let conn = Uuid::new_v4();
        let op1 = Uuid::new_v4();
        let op2 = Uuid::new_v4();

        reg.try_acquire(conn, op1).unwrap();
        // Simulates cancel_operation's early release while op1 may still be unwinding.
        reg.release_if_owner(conn, op1);
        reg.try_acquire(conn, op2).unwrap();
        // Late OpCleanup for op1 must not clear op2's ownership.
        reg.release_if_owner(conn, op1);
        let err = reg.try_acquire(conn, Uuid::new_v4()).unwrap_err();
        assert!(err.contains(&op2.to_string()));
    }

    #[test]
    fn busy_release_op_frees_without_connection_id() {
        let reg = SqlBusyRegistry::new();
        let conn = Uuid::new_v4();
        let op1 = Uuid::new_v4();
        let op2 = Uuid::new_v4();

        reg.try_acquire(conn, op1).unwrap();
        // Simulates cancel after op_to_conn was already cleared (mapping miss).
        reg.release_op(op1);
        reg.try_acquire(conn, op2).unwrap();
        // release_op for the old owner must not clear the new owner.
        reg.release_op(op1);
        let err = reg.try_acquire(conn, Uuid::new_v4()).unwrap_err();
        assert!(err.contains(&op2.to_string()));
    }

    /// Mirrors cancel mid-stream + immediate re-export on the same connection:
    /// cancel releases by op id while the "aborted" op may still be logically
    /// alive; a new stream must acquire immediately; late cleanup of the old
    /// op must not clear the new owner.
    #[test]
    fn busy_cancel_midstream_allows_immediate_reexport_on_same_conn() {
        let reg = SqlBusyRegistry::new();
        let conn = Uuid::new_v4();
        let export1 = Uuid::new_v4();
        let export2 = Uuid::new_v4();

        reg.try_acquire(conn, export1).unwrap();
        // FE operation_cancel → release_op (teardown still in flight).
        reg.release_op(export1);
        // Immediate re-export on the same connection.
        reg.try_acquire(conn, export2).unwrap();
        // Late OpCleanup for export1 (Drop after abort unwind).
        reg.release_op(export1);
        reg.release_if_owner(conn, export1);
        // export2 still owns the slot.
        let err = reg.try_acquire(conn, Uuid::new_v4()).unwrap_err();
        assert!(err.contains(&export2.to_string()));
        // Competing grid cancelled via busy-retry also frees for export.
        let grid = Uuid::new_v4();
        let export3 = Uuid::new_v4();
        reg.release_op(export2);
        reg.try_acquire(conn, grid).unwrap();
        reg.release_op(grid); // busy-retry cancel of holder
        reg.try_acquire(conn, export3).unwrap();
    }

    /// Live-log regression: same ERR_SQL_BUSY holder uuid across many
    /// try_acquire retries must clear after cancel(release_op), so the next
    /// acquire succeeds. Matches:
    /// `[sql_busy] try_acquire BUSY ... err=ERR_SQL_BUSY:<same-uuid>` x N.
    #[test]
    fn busy_same_holder_across_retries_clears_after_cancel() {
        let reg = SqlBusyRegistry::new();
        let conn = Uuid::parse_str("42a60203-4400-4704-a4f5-bfb7e8556338").unwrap();
        let holder = Uuid::parse_str("37f37825-99c5-4742-af61-62e8fc3a6417").unwrap();

        reg.try_acquire(conn, holder).unwrap();

        // Simulate FE busy-retry: new op ids each attempt, same holder error.
        for _ in 0..10 {
            let new_op = Uuid::new_v4();
            let err = reg.try_acquire(conn, new_op).unwrap_err();
            assert!(
                err.contains(&holder.to_string()),
                "expected same holder in ERR_SQL_BUSY, got {err}"
            );
            // Without cancel/release_op the slot stays held — that is the bug.
        }

        // FE operationCancel(holder) → release_op must free before next acquire.
        reg.release_op(holder);
        let next = Uuid::new_v4();
        reg.try_acquire(conn, next).unwrap();
    }

    #[test]
    fn busy_force_release_conn_clears_orphan_slot() {
        let reg = SqlBusyRegistry::new();
        let conn = Uuid::new_v4();
        let op1 = Uuid::new_v4();

        reg.try_acquire(conn, op1).unwrap();
        reg.force_release_conn(conn);
        reg.try_acquire(conn, Uuid::new_v4()).unwrap();
    }
}
