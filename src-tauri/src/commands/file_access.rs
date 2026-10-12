//! Thin commands for sandboxed file access; logic lives in `crate::file_access`.

use tauri::AppHandle;

use crate::file_access::pick::{self, DatabaseMode, Panels};
use crate::file_access::{self, AccessRequest, Role};
use crate::ssh_tunnel::types::SshAuth;
use crate::types::ConnectionCreateInput;

/// Picks a SQLite/DuckDB file. Sandboxed builds also ask for (and remember) its folder.
/// With `expected_path`, only access for that saved path is requested.
#[tauri::command]
pub async fn file_access_pick_database(
    app: AppHandle,
    mode: DatabaseMode,
    expected_path: Option<String>,
) -> Result<Option<String>, String> {
    run_blocking(move || {
        pick::database(
            panels(app).as_ref(),
            &file_access::service(),
            mode,
            expected_path.as_deref(),
        )
    })
    .await
}

/// Picks an SSH private key (read-only grant in sandboxed builds).
#[tauri::command]
pub async fn file_access_pick_ssh_key(
    app: AppHandle,
    expected_path: Option<String>,
) -> Result<Option<String>, String> {
    run_blocking(move || {
        pick::ssh_key(
            panels(app).as_ref(),
            &file_access::service(),
            expected_path.as_deref(),
        )
    })
    .await
}

/// Which of `requests` have no stored grant (always none in direct builds).
#[tauri::command]
pub fn file_access_missing(requests: Vec<AccessRequest>) -> Result<Vec<AccessRequest>, String> {
    file_access::service().missing(&requests)
}

async fn run_blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| "FILE_ACCESS_PANEL_FAILED".to_string())?
}

/// Sandboxed builds need the native panels (bookmarks from the panel's own URL); every
/// other build keeps the plugin-dialog panels it used before (plan P2-7).
fn panels(app: AppHandle) -> Box<dyn Panels> {
    #[cfg(target_os = "macos")]
    if crate::distribution::Distribution::current().requires_file_grants() {
        return Box::new(crate::file_access::macos_panels(app));
    }
    Box::new(crate::file_access::DialogPanels { app })
}

/// Files `input` will open (database folder, SSH key).
pub fn requests_for(input: &ConnectionCreateInput) -> Vec<AccessRequest> {
    let mut requests = Vec::new();
    let db_path = input
        .sqlite
        .as_ref()
        .map(|db| db.path.as_str())
        .or_else(|| input.duckdb.as_ref().map(|db| db.path.as_str()));
    if let Some(path) = db_path {
        requests.push(AccessRequest {
            role: Role::DatabaseFolder,
            path: path.to_string(),
        });
    }
    if let Some(SshAuth::PrivateKey { identity_file, .. }) = input.ssh.as_ref().map(|s| &s.auth) {
        requests.push(AccessRequest {
            role: Role::SshKey,
            path: identity_file.clone(),
        });
    }
    requests
}

/// Acquires every file `input` needs, failing with `FILE_ACCESS_REQUIRED` (or
/// `_UNAVAILABLE`) before anything is persisted, so the frontend can ask for access and
/// safely repeat the whole operation (plan P1-3). Keep the returned leases until the
/// runtime connection is open: access then cannot lapse between the check and use.
pub fn ensure_usable(input: &ConnectionCreateInput) -> Result<Vec<file_access::Lease>, String> {
    let service = file_access::service();
    let mut leases = Vec::new();
    for request in requests_for(input) {
        if request.role == Role::DatabaseFolder && file_access::is_in_memory(&request.path) {
            continue;
        }
        if let Some(lease) = service.acquire(request.role, &request.path)? {
            leases.push(lease);
        }
    }
    Ok(leases)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_database_and_key_files() {
        let input: ConnectionCreateInput = serde_json::from_value(serde_json::json!({
            "engine": "sqlite",
            "label": "x",
            "sqlite": { "path": "/d/app.db" },
            "ssh": {
                "ssh_host": "h", "ssh_port": 22, "remote_host": "r", "remote_port": 1,
                "auth": { "kind": "private_key", "identity_file": "/k/id" }
            }
        }))
        .unwrap();
        let requests = requests_for(&input);
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].role, Role::DatabaseFolder);
        assert_eq!(requests[1].path, "/k/id");
        // Direct builds (disabled service) never block.
        assert!(ensure_usable(&input).is_ok());
    }
}
