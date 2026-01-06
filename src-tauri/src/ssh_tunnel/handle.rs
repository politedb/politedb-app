use std::net::SocketAddr;
use std::sync::{atomic::AtomicBool, Arc};
use std::thread::JoinHandle;

pub struct SshTunnelHandle {
    local_addr: SocketAddr,
    shutdown: Arc<AtomicBool>,
    accept_thread: Option<JoinHandle<()>>,
    session_thread: Option<JoinHandle<()>>,
}

impl SshTunnelHandle {
    pub fn new(
        local_addr: SocketAddr,
        shutdown: Arc<AtomicBool>,
        accept_thread: JoinHandle<()>,
        session_thread: JoinHandle<()>,
    ) -> Self {
        Self {
            local_addr,
            shutdown,
            accept_thread: Some(accept_thread),
            session_thread: Some(session_thread),
        }
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub async fn close(self) {
        self.shutdown
            .store(true, std::sync::atomic::Ordering::SeqCst);

        // Join threads (best-effort)
        if let Some(t) = self.accept_thread {
            let _ = t.join();
        }
        if let Some(t) = self.session_thread {
            let _ = t.join();
        }
    }
}
