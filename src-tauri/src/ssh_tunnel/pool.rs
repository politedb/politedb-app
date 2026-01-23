use futures_util::lock::Mutex;

use crate::{
    ssh_tunnel::types::{SshAuth, SshTunnelInput},
    state::{
        app_state::{SharedTunnel, TunnelKey},
        AppState,
    },
};

use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::ssh_tunnel;

/* -------------------------------------------------- */
/* helpers */

fn norm(s: &str) -> String {
    s.trim().to_string()
}

fn strict_str(input: &SshTunnelInput) -> String {
    input
        .strict_host_key_checking
        .as_deref()
        .unwrap_or("accept-new")
        .trim()
        .to_string()
}

// NO plaintext
fn auth_fingerprint(auth: &SshAuth) -> String {
    match auth {
        SshAuth::PrivateKey {
            identity_file,
            passphrase,
        } => {
            let p = identity_file.trim();
            let has_pp = passphrase
                .as_deref()
                .map(|x| !x.trim().is_empty())
                .unwrap_or(false);
            format!("pk:{}|pp:{}", p, if has_pp { "1" } else { "0" })
        }
        SshAuth::Password { .. } => "pw".to_string(),
    }
}

pub fn tunnel_key_from_input(ssh: &SshTunnelInput) -> TunnelKey {
    let ssh_user = ssh
        .ssh_user
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "root".to_string());

    TunnelKey {
        ssh_host: norm(&ssh.ssh_host),
        ssh_port: ssh.ssh_port,
        ssh_user,
        strict: strict_str(ssh),
        auth_fp: auth_fingerprint(&ssh.auth),
        remote_host: norm(&ssh.remote_host),
        remote_port: ssh.remote_port,
    }
}

/* -------------------------------------------------- */
/* acquire */

pub async fn acquire_shared_tunnel(
    state: &AppState,
    ssh: &SshTunnelInput,
) -> anyhow::Result<(TunnelKey, Arc<SharedTunnel>)> {
    let key = tunnel_key_from_input(ssh);

    // fast path
    if let Some(existing) = state.ssh_tunnel_pool.get(&key) {
        // Optimistic increment.
        // Even if ref count was 0 (zombie race), we increment to 1.
        // But with remove_if below, zombie race is practically eliminated.
        let prev = existing.refs.fetch_add(1, Ordering::SeqCst);

        let shared = existing.clone();
        drop(existing);

        tracing::info!(ssh_key=?key, refs=prev+1, "ssh_tunnel: reuse");
        return Ok((key, shared));
    }

    tracing::info!(ssh_key=?key, "ssh_tunnel: create");

    // slow path: create new tunnel
    let handle = ssh_tunnel::open_tunnel(ssh).await?;
    let local_addr = handle.local_addr();

    let shared = Arc::new(SharedTunnel {
        local_addr,
        handle: Mutex::new(Some(handle)),
        refs: std::sync::atomic::AtomicUsize::new(1),
    });

    // race: two tasks may create concurrently
    match state.ssh_tunnel_pool.entry(key.clone()) {
        dashmap::mapref::entry::Entry::Occupied(e) => {
            // someone inserted first -> use theirs, close ours
            let theirs = e.get().clone();
            theirs.refs.fetch_add(1, Ordering::SeqCst);

            tracing::info!(ssh_key=?key, "ssh_tunnel: race lost, closing ours");

            let ours = shared.clone();
            tokio::spawn(async move {
                // take handle and close
                let mut g = ours.handle.lock().await;
                if let Some(h) = g.take() {
                    let _ = h.close().await;
                }
            });

            Ok((key, theirs))
        }
        dashmap::mapref::entry::Entry::Vacant(v) => {
            v.insert(shared.clone());
            tracing::info!(ssh_key=?key, local_bind=%shared.local_addr, "ssh_tunnel: inserted");
            Ok((key, shared))
        }
    }
}

/* -------------------------------------------------- */
/* release */

pub async fn release_shared_tunnel_by_key(state: &AppState, key: &TunnelKey) {
    // Attempt to atomically remove IF refs == 1.
    // This prevents acquiring a zombie connection while we are closing.
    let remove_result = state.ssh_tunnel_pool.remove_if(key, |_, shared| {
        // Condition: Only remove if we are the last user (refs == 1)
        shared.refs.load(Ordering::SeqCst) == 1
    });

    match remove_result {
        Some((_, shared)) => {
            // We successfully removed the entry because refs was 1.
            // Now refs is effectively 0 (from the perspective of the pool),
            // and we own the responsibility to close it.

            tracing::info!(ssh_key=?key, local_bind=%shared.local_addr, "ssh_tunnel: closing (refs reached 0)");

            let mut g = shared.handle.lock().await;
            if let Some(h) = g.take() {
                let _ = h.close().await;
            }
        }
        None => {
            // Either key not found OR refs > 1.
            // Just decrement ref count.
            if let Some(entry) = state.ssh_tunnel_pool.get(key) {
                let prev = entry.refs.fetch_sub(1, Ordering::SeqCst);
                tracing::info!(ssh_key=?key, refs=prev-1, "ssh_tunnel: release (decrement)");
            }
        }
    }
}

pub async fn release_shared_tunnel_by_conn(state: &AppState, conn_id: uuid::Uuid) {
    let Some((_, key)) = state.conn_to_tunnel.remove(&conn_id) else {
        return;
    };
    release_shared_tunnel_by_key(state, &key).await;
}
