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
        let shared = existing.clone();
        drop(existing);

        let prev = shared.refs.fetch_add(1, Ordering::SeqCst);
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
    // Get shared (clone Arc) then drop DashMap guard early.
    let Some(entry) = state.ssh_tunnel_pool.get(key) else {
        return;
    };
    let shared = entry.clone();
    drop(entry);

    // Decrement refs
    let prev = shared.refs.fetch_sub(1, Ordering::SeqCst);
    if prev > 1 {
        tracing::info!(ssh_key=?key, refs=prev-1, "ssh_tunnel: release (still in use)");
        return;
    }

    // prev == 1 => now 0, we are responsible for closing.
    // Remove from pool first to prevent new reusers during close.
    state.ssh_tunnel_pool.remove(key);

    tracing::info!(ssh_key=?key, local_bind=%shared.local_addr, "ssh_tunnel: closing (refs=0)");

    // take handle and close
    // take handle and close
    let mut g = shared.handle.lock().await;
    if let Some(h) = g.take() {
        let _ = h.close().await;
    }
}

pub async fn release_shared_tunnel_by_conn(state: &AppState, conn_id: uuid::Uuid) {
    let Some((_, key)) = state.conn_to_tunnel.remove(&conn_id) else {
        return;
    };
    release_shared_tunnel_by_key(state, &key).await;
}
