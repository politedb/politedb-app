use std::sync::{atomic::AtomicUsize, Arc};

use dashmap::DashMap;
use futures_util::lock::Mutex;
use uuid::Uuid;

use crate::engines::{cancel::CancelHandle, registry::EngineRegistry, EngineConnection};
use crate::operations::ctx::{FlowCtrl, SqlBusyRegistry};
use crate::ssh_tunnel::handle::SshTunnelHandle;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
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
    /// Active agent runs (plan ai-agent R1).
    pub ai_agent_runs: Arc<crate::ai::agent::run::RunRegistry>,
    /// Models known to lack tool support (plan ai-agent R2).
    pub ai_agent_capabilities: Arc<crate::ai::agent::model::CapabilityCache>,
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
            ai_agent_runs: Arc::new(crate::ai::agent::run::RunRegistry::default()),
            ai_agent_capabilities: Arc::new(crate::ai::agent::model::CapabilityCache::default()),
        }
    }
}
