use std::sync::Arc;
use tokio::sync::Notify;

#[derive(Clone)]
pub enum CancelHandle {
    Postgres(tokio_postgres::CancelToken),
    MySql { notify: Arc<Notify> },
    Redis { notify: Arc<Notify> },
}

impl CancelHandle {
    pub fn cancel(&self) {
        match self {
            CancelHandle::Postgres(t) => {
                let t = t.clone();
                tokio::spawn(async move {
                    let _ = t.cancel_query(tokio_postgres::NoTls).await;
                });
            }
            CancelHandle::MySql { notify } => {
                notify.notify_waiters();
            }
            CancelHandle::Redis { notify } => {
                notify.notify_waiters();
            }
        }
    }
}
