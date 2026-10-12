use std::sync::{atomic::AtomicUsize, Arc};

use dashmap::DashMap;
use futures_util::lock::Mutex;
use uuid::Uuid;

use crate::engines::{cancel::CancelHandle, registry::EngineRegistry, EngineConnection};
use crate::operations::ctx::{FlowCtrl, SqlBusyRegistry};
use crate::ssh_tunnel::handle::SshTunnelHandle;

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct TunnelKey {
    pub ssh_host: String,
    pub ssh_port: u16,
    pub ssh_user: String,
    pub strict: String,

    // auth fingerprint (NO plaintext secret)
    pub auth_fp: String,

    pub remote_host: String,
    pub remote_port: u16,
}

#[derive(Debug)]
pub struct SharedTunnel {
    pub local_addr: std::net::SocketAddr,
    pub handle: Mutex<Option<SshTunnelHandle>>,
    pub refs: AtomicUsize,
}

pub struct AppState {
    pub engines: EngineRegistry,

    pub connections: Arc<DashMap<Uuid, EngineConnection>>,

    // ✅ shared tunnel pool
    pub ssh_tunnel_pool: Arc<DashMap<TunnelKey, Arc<SharedTunnel>>>,

    // ✅ conn_id -> tunnel key (for releasing on remove),
    pub conn_to_tunnel: Arc<DashMap<Uuid, TunnelKey>>,
    pub op_to_conn: Arc<DashMap<Uuid, Uuid>>,

    pub running_ops: Arc<DashMap<Uuid, CancelHandle>>,
    pub cancel_requested: Arc<DashMap<Uuid, ()>>,
    pub active_ops: Arc<DashMap<Uuid, ()>>,

    pub flow_by_op: Arc<DashMap<Uuid, FlowCtrl>>,
    pub op_tasks: Arc<DashMap<Uuid, tokio::task::JoinHandle<()>>>,

    pub sql_busy: SqlBusyRegistry,
    pub ai_chat_cancel: Arc<tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    /// Serializes AI provider file + key reads and mutations. Never held across network I/O.
    pub ai_providers_lock: Arc<std::sync::Mutex<()>>,
    pub ai_discovery_cancel: Arc<crate::ai::cancel::CancelRegistry>,
}

impl AppState {
    pub fn new(engines: EngineRegistry) -> Self {
        Self {
            engines,
            connections: Arc::new(DashMap::new()),
            ssh_tunnel_pool: Arc::new(DashMap::new()),
            op_to_conn: Arc::new(DashMap::new()),
            conn_to_tunnel: Arc::new(DashMap::new()),
            running_ops: Arc::new(DashMap::new()),
            cancel_requested: Arc::new(DashMap::new()),
            active_ops: Arc::new(DashMap::new()),
            flow_by_op: Arc::new(DashMap::new()),
            op_tasks: Arc::new(DashMap::new()),
            sql_busy: SqlBusyRegistry::new(),
            ai_chat_cancel: Arc::new(tokio::sync::Mutex::new(None)),
            ai_providers_lock: Arc::new(std::sync::Mutex::new(())),
            ai_discovery_cancel: Arc::new(crate::ai::cancel::CancelRegistry::default()),
        }
    }
}

/// Logs show an opaque id only: `auth_fp` contains the SSH key path, which must not
/// reach logs (AGENTS.md). Equality/hashing for pooling are unchanged.
impl std::fmt::Debug for TunnelKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.hash(&mut hasher);
        write!(f, "TunnelKey({:016x})", hasher.finish())
    }
}

#[cfg(test)]
mod tunnel_key_tests {
    use super::*;

    #[test]
    fn debug_output_hides_the_key_path() {
        let key = TunnelKey {
            ssh_host: "bastion".into(),
            ssh_port: 22,
            ssh_user: "me".into(),
            strict: "accept-new".into(),
            auth_fp: "pk:/Users/me/secret-dir/id_ed25519|pp:0".into(),
            remote_host: "db".into(),
            remote_port: 5432,
        };
        let text = format!("{key:?}");
        assert!(!text.contains("secret-dir"), "{text}");
        assert!(text.starts_with("TunnelKey("));
    }
}
