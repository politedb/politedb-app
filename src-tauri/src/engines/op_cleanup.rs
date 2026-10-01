use std::sync::Arc;
use uuid::Uuid;

use crate::engines::cancel::CancelHandle;
use crate::operations::ctx::SqlBusyRegistry;
use crate::types::OperationKind;

pub(crate) struct OpCleanup {
    pub(crate) op_id: Uuid,
    pub(crate) kind: OperationKind,
    pub(crate) connection_id: Uuid,
    pub(crate) sql_busy: SqlBusyRegistry,
    pub(crate) running_ops: Arc<dashmap::DashMap<Uuid, CancelHandle>>,
    pub(crate) cancel_requested: Arc<dashmap::DashMap<Uuid, ()>>,
    pub(crate) active_ops: Arc<dashmap::DashMap<Uuid, ()>>,
    pub(crate) op_to_conn: Arc<dashmap::DashMap<Uuid, Uuid>>,
    pub(crate) op_tasks: Arc<dashmap::DashMap<Uuid, tokio::task::JoinHandle<()>>>,
    pub(crate) is_stream_sql: bool,
}

impl Drop for OpCleanup {
    fn drop(&mut self) {
        // Release busy BEFORE clearing op_to_conn so a concurrent cancel that
        // still keys off the mapping cannot observe "mapping gone, busy held".
        if self.kind == OperationKind::SqlQuery && self.is_stream_sql {
            self.sql_busy.release_op(self.op_id);
            // Keep conn-scoped release too (uses connection_id; idempotent).
            self.sql_busy
                .release_if_owner(self.connection_id, self.op_id);
        }

        self.running_ops.remove(&self.op_id);
        self.cancel_requested.remove(&self.op_id);
        self.active_ops.remove(&self.op_id);
        self.op_to_conn.remove(&self.op_id);
        self.op_tasks.remove(&self.op_id);
    }
}
