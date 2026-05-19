use std::sync::Arc;
use tokio::sync::Notify;

#[derive(Clone)]
pub enum CancelHandle {
    Postgres {
        token: tokio_postgres::CancelToken,
        backend_pid: i32,
    },
    MySql {
        notify: Arc<Notify>,
    },
    SqlServer {
        notify: Arc<Notify>,
    },
    Sqlite {
        notify: Arc<Notify>,
    },
    D1 {
        notify: Arc<Notify>,
    },
    Oracle {
        notify: Arc<Notify>,
    },
    Redis {
        notify: Arc<Notify>,
    },
}

impl CancelHandle {
    // Fire-and-forget cancel request.
    // For Postgres: send a cancel request to the backend using the cancel token.
    // For MySQL/Redis: notify waiters (your runners must select! on this Notify).
    pub fn cancel(&self) {
        match self {
            CancelHandle::Postgres { token, .. } => {
                let token = token.clone();

                tokio::spawn(async move {
                    // Best-effort: ignore errors (connection might already be gone).
                    // This is the standard Postgres "cancel query" mechanism.
                    let _ = token.cancel_query(tokio_postgres::NoTls).await;
                });
            }

            CancelHandle::MySql { notify } => {
                notify.notify_waiters();
            }
            CancelHandle::SqlServer { notify } => {
                notify.notify_waiters();
            }

            CancelHandle::Sqlite { notify } => {
                notify.notify_waiters();
            }
            CancelHandle::D1 { notify } => {
                notify.notify_waiters();
            }
            CancelHandle::Oracle { notify } => {
                notify.notify_waiters();
            }

            CancelHandle::Redis { notify } => {
                notify.notify_waiters();
            }
        }
    }

    #[allow(dead_code)]
    pub fn backend_pid(&self) -> Option<i32> {
        match self {
            CancelHandle::Postgres { backend_pid, .. } => Some(*backend_pid),
            _ => None,
        }
    }
}
