use std::sync::{Arc, Mutex, MutexGuard};

use duckdb::Connection;

/// Lock the shared handle, recovering from a prior poisoned lock when possible.
fn lock_shared(shared: &Arc<Mutex<Connection>>) -> Result<MutexGuard<'_, Connection>, String> {
    match shared.lock() {
        Ok(guard) => Ok(guard),
        Err(poisoned) => Ok(poisoned.into_inner()),
    }
}

/// Run `f` on a cloned connection so the global mutex is not held during long queries.
/// Panics inside `f` no longer poison the shared mutex for other operations.
pub fn with_duckdb_connection<R, F>(shared: &Arc<Mutex<Connection>>, f: F) -> Result<R, String>
where
    F: FnOnce(&Connection) -> Result<R, String>,
{
    let conn = {
        let guard = lock_shared(shared)?;
        guard
            .try_clone()
            .map_err(|e| format!("DUCKDB_CLONE_FAILED: {e}"))?
    };
    f(&conn)
}
