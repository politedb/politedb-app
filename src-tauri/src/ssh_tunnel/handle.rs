use std::net::SocketAddr;
use std::sync::Arc;

use tokio::process::Child;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct SshTunnelHandle {
    local_addr: SocketAddr,
    child: Arc<Mutex<Option<Child>>>,
}

impl SshTunnelHandle {
    pub fn new(local_addr: SocketAddr, child: Child) -> Self {
        Self {
            local_addr,
            child: Arc::new(Mutex::new(Some(child))),
        }
    }

    pub fn local_port(&self) -> u16 {
        self.local_addr.port()
    }

    // pub fn local_addr(&self) -> SocketAddr {
    //     self.local_addr
    // }

    pub async fn close(&self) {
        let mut guard = self.child.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
}
