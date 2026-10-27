//! A PostgreSQL session held on one pooled connection across calls, for
//! work that must see or change the database as a whole: a restore that
//! runs in one transaction (all or nothing), and a backup whose queries all
//! read one exported snapshot.

use std::sync::Arc;

use dashmap::DashMap;
use deadpool_postgres::{Object, Pool};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::operation::format_pg_error;

/// What a session is opened for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SqlSessionMode {
    /// A read-write transaction, committed or rolled back at the end.
    Transaction,
    /// A read-only REPEATABLE READ transaction whose snapshot is exported,
    /// so other connections can read the same database state.
    Snapshot,
}

struct PgSqlSession {
    connection_id: Uuid,
    /// None once the session has ended.
    client: Mutex<Option<Object>>,
}

#[derive(Default)]
pub struct SqlSessionRegistry {
    sessions: DashMap<Uuid, Arc<PgSqlSession>>,
}

/// Puts a connection whose transaction state is unknown out of the pool:
/// it closes, and the server rolls back whatever it held.
fn discard(client: Object) {
    drop(Object::take(client));
}

impl SqlSessionRegistry {
    /// Opens a session: its transaction, and for a snapshot session the
    /// exported snapshot id.
    pub async fn begin(
        &self,
        connection_id: Uuid,
        pool: &Pool,
        mode: SqlSessionMode,
    ) -> Result<(Uuid, Option<String>), String> {
        let client = pool
            .get()
            .await
            .map_err(|e| format!("SQL_SESSION_GET_CONN_FAILED: {e}"))?;
        let begin = match mode {
            SqlSessionMode::Transaction => "BEGIN",
            SqlSessionMode::Snapshot => "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
        };
        if let Err(e) = client.batch_execute(begin).await {
            discard(client);
            return Err(format_pg_error(&e, begin));
        }
        let snapshot = match mode {
            SqlSessionMode::Transaction => None,
            SqlSessionMode::Snapshot => {
                match client.query_one("SELECT pg_export_snapshot()", &[]).await {
                    Ok(row) => Some(row.get::<usize, String>(0)),
                    Err(e) => {
                        discard(client);
                        return Err(format_pg_error(&e, "SELECT pg_export_snapshot()"));
                    }
                }
            }
        };
        let id = Uuid::new_v4();
        self.sessions.insert(
            id,
            Arc::new(PgSqlSession {
                connection_id,
                client: Mutex::new(Some(client)),
            }),
        );
        Ok((id, snapshot))
    }

    /// Runs SQL in the session's transaction.
    pub async fn execute(&self, session_id: Uuid, sql: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get(&session_id)
            .map(|s| Arc::clone(&s))
            .ok_or("SQL_SESSION_NOT_FOUND")?;
        let guard = session.client.lock().await;
        let client = guard.as_ref().ok_or("SQL_SESSION_ENDED")?;
        client
            .batch_execute(sql)
            .await
            .map_err(|e| format_pg_error(&e, sql))
    }

    /// Ends a session: commits or rolls back. The connection goes back to
    /// the pool only when that succeeded.
    pub async fn end(&self, session_id: Uuid, commit: bool) -> Result<(), String> {
        let Some((_, session)) = self.sessions.remove(&session_id) else {
            return Err("SQL_SESSION_NOT_FOUND".into());
        };
        let Some(client) = session.client.lock().await.take() else {
            return Ok(());
        };
        let end = if commit { "COMMIT" } else { "ROLLBACK" };
        match client.batch_execute(end).await {
            Ok(()) => Ok(()),
            Err(e) => {
                discard(client);
                Err(format_pg_error(&e, end))
            }
        }
    }

    /// Rolls back every session of a connection that is going away.
    pub async fn end_for_connection(&self, connection_id: Uuid) {
        let ids: Vec<Uuid> = self
            .sessions
            .iter()
            .filter(|s| s.value().connection_id == connection_id)
            .map(|s| *s.key())
            .collect();
        for id in ids {
            let _ = self.end(id, false).await;
        }
    }
}

/// A snapshot id as pg_export_snapshot writes it (hex digits and dashes),
/// safe to put in SET TRANSACTION SNAPSHOT '…'.
pub fn is_snapshot_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_ids_are_hex_and_dashes_only() {
        assert!(is_snapshot_id("00000003-0000001B-1"));
        assert!(!is_snapshot_id(""));
        assert!(!is_snapshot_id("1'; DROP TABLE t; --"));
        assert!(!is_snapshot_id(&"a".repeat(65)));
    }

    async fn count_rows(c: &Object) -> i64 {
        c.query_one("SELECT count(*) FROM zz_session_t", &[])
            .await
            .unwrap()
            .get(0)
    }

    /// Live checks against a disposable PostgreSQL (never a customer database):
    /// `HEALTH_PG_URL=postgres://user:pass@127.0.0.1:55432/postgres \
    ///  cargo test sql_session_live -- --ignored`
    /// Creates and drops the table `zz_session_t`.
    #[tokio::test]
    #[ignore]
    async fn sql_session_live() {
        use deadpool_postgres::{Manager, ManagerConfig};
        use tokio_postgres::NoTls;

        let cfg: tokio_postgres::Config = std::env::var("HEALTH_PG_URL")
            .expect("set HEALTH_PG_URL")
            .parse()
            .expect("valid HEALTH_PG_URL");
        let pool = Pool::builder(Manager::from_config(cfg, NoTls, ManagerConfig::default()))
            .max_size(4)
            .build()
            .unwrap();
        let other = pool.get().await.unwrap();
        other
            .batch_execute("DROP TABLE IF EXISTS zz_session_t; CREATE TABLE zz_session_t (v int)")
            .await
            .unwrap();
        let conn = Uuid::new_v4();
        let reg = SqlSessionRegistry::default();

        // A transaction rolled back leaves nothing; savepoints undo alone.
        let (id, snap) = reg
            .begin(conn, &pool, SqlSessionMode::Transaction)
            .await
            .unwrap();
        assert!(snap.is_none());
        reg.execute(id, "INSERT INTO zz_session_t VALUES (1)")
            .await
            .unwrap();
        reg.execute(id, "SAVEPOINT s").await.unwrap();
        assert!(reg
            .execute(id, "INSERT INTO zz_session_t VALUES ('x')")
            .await
            .is_err());
        reg.execute(id, "ROLLBACK TO SAVEPOINT s; RELEASE SAVEPOINT s")
            .await
            .unwrap();
        reg.execute(id, "INSERT INTO zz_session_t VALUES (2)")
            .await
            .unwrap();
        assert_eq!(count_rows(&other).await, 0, "not visible before commit");
        reg.end(id, false).await.unwrap();
        assert_eq!(count_rows(&other).await, 0, "rolled back");

        // Committed: both rows stay.
        let (id, _) = reg
            .begin(conn, &pool, SqlSessionMode::Transaction)
            .await
            .unwrap();
        reg.execute(id, "INSERT INTO zz_session_t VALUES (1), (2)")
            .await
            .unwrap();
        reg.end(id, true).await.unwrap();
        assert_eq!(count_rows(&other).await, 2);

        // A snapshot read elsewhere does not see later writes.
        let (sid, snap) = reg
            .begin(conn, &pool, SqlSessionMode::Snapshot)
            .await
            .unwrap();
        let snap = snap.expect("snapshot id");
        assert!(is_snapshot_id(&snap));
        other
            .batch_execute("INSERT INTO zz_session_t VALUES (3)")
            .await
            .unwrap();
        let mut reader = pool.get().await.unwrap();
        let tx = reader.transaction().await.unwrap();
        tx.batch_execute(&format!(
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY; SET TRANSACTION SNAPSHOT '{snap}'"
        ))
        .await
        .unwrap();
        let seen: i64 = tx
            .query_one("SELECT count(*) FROM zz_session_t", &[])
            .await
            .unwrap()
            .get(0);
        tx.rollback().await.unwrap();
        assert_eq!(seen, 2, "the snapshot's state, not the later insert");
        // A connection going away ends its sessions.
        reg.end_for_connection(conn).await;
        assert!(reg.execute(sid, "SELECT 1").await.is_err());

        other
            .batch_execute("DROP TABLE zz_session_t")
            .await
            .unwrap();
    }
}
