use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::ssh_tunnel;
use crate::ssh_tunnel::pool::{acquire_shared_tunnel, release_shared_tunnel_by_conn};
use crate::state::AppState;
use crate::types::{ConnectionCreateInput, ConnectionInfo, ConnectionTestInput};

fn parse_redis_version(info: &str) -> Option<String> {
    info.lines()
        .find_map(|line| line.strip_prefix("redis_version:"))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn rewrite_input_host_port(
    mut input: ConnectionCreateInput,
    host: &str,
    port: u16,
) -> Result<ConnectionCreateInput, String> {
    match input.engine {
        crate::types::EngineKind::Postgres => {
            let pg = input.postgres.as_mut().ok_or("POSTGRES_CONFIG_MISSING")?;
            pg.host = host.into();
            pg.port = port;
        }
        crate::types::EngineKind::Mysql => {
            let my = input.mysql.as_mut().ok_or("MYSQL_CONFIG_MISSING")?;
            my.host = host.into();
            my.port = port;
        }
        crate::types::EngineKind::Mariadb => {
            let my = input.mysql.as_mut().ok_or("MYSQL_CONFIG_MISSING")?;
            my.host = host.into();
            my.port = port;
        }
        crate::types::EngineKind::Oracle => {
            let oracle = input.oracle.as_mut().ok_or("ORACLE_CONFIG_MISSING")?;
            oracle.host = host.into();
            oracle.port = port;
        }
        crate::types::EngineKind::Sqlite => {}
        crate::types::EngineKind::Mongo => {
            let mongo = input.mongo.as_mut().ok_or("MONGO_CONFIG_MISSING")?;
            mongo.host = host.into();
            mongo.port = port;
        }
        crate::types::EngineKind::Redis => {
            let r = input.redis.as_mut().ok_or("REDIS_CONFIG_MISSING")?;
            r.host = host.into();
            r.port = port;
        }
        #[allow(unreachable_patterns)]
        _ => return Err("ENGINE_NOT_SUPPORTED_YET".into()),
    }
    Ok(input)
}

async fn close_tunnel_quietly(tunnel: crate::ssh_tunnel::handle::SshTunnelHandle) {
    let _ = tunnel.close().await;
}

#[tauri::command]
pub async fn connection_create(
    app: AppHandle,
    state: State<'_, AppState>,
    mut input: ConnectionCreateInput,
) -> Result<ConnectionInfo, String> {
    let id = Uuid::new_v4();

    let engine = input.engine.clone();
    let label = input.label.clone();

    tracing::info!(
        conn_id = %id,
        engine = ?engine,
        label = %label,
        "connection_create: start"
    );

    let mut acquired_key: Option<crate::state::app_state::TunnelKey> = None;

    // 0) Optional SSH tunnel
    if let Some(ssh_in) = input.ssh.clone() {
        tracing::info!(conn_id = %id, "connection_create: opening ssh tunnel");

        let (key, shared) = acquire_shared_tunnel(&state, &ssh_in)
            .await
            .map_err(|e| format!("SSH_TUNNEL_OPEN_FAILED: {e:#}"))?;

        tracing::info!(
            conn_id = %id,
            ssh_key = ?key,
            local_bind = %shared.local_addr,
            "connection_create: ssh tunnel acquired"
        );

        let local_port = shared.local_addr.port();
        input = rewrite_input_host_port(input, "127.0.0.1", local_port)?;
        // map conn -> tunnel (only if later DB connect succeeds; but we keep key for rollback)
        acquired_key = Some(key);
    }

    // 1) Resolve driver
    let driver = state
        .engines
        .get(engine.clone())
        .ok_or("ENGINE_NOT_SUPPORTED")?;

    tracing::info!(
        conn_id = %id,
        engine = ?engine,
        driver_kind = ?driver.kind(),
        "connection_create: driver resolved"
    );

    // 2) Connect (do NOT mutate state before connect succeeds)
    let conn = match driver.connect(&app, id, label.clone(), input).await {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(conn_id=%id, engine=?engine, error=%e, "connection_create: connect failed");

            // rollback tunnel ref if acquired
            if acquired_key.is_some() {
                // temporarily register mapping so release can find it
                // (or you can write a release_by_key() helper)
                state.conn_to_tunnel.insert(id, acquired_key.unwrap());
                release_shared_tunnel_by_conn(&state, id).await;
            }

            return Err(e);
        }
    };

    // 3) Insert runtime connection
    state.connections.insert(id, conn);

    if let Some(key) = acquired_key.take() {
        state.conn_to_tunnel.insert(id, key);
    }

    tracing::info!(
        conn_id = %id,
        engine = ?engine,
        "connection_create: inserted into runtime state"
    );

    Ok(ConnectionInfo { id, engine, label })
}

#[tauri::command]
pub async fn connection_test(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: ConnectionTestInput,
) -> Result<(), String> {
    // Unpack early (avoid repetitive payload.input.*)
    let mut input = payload.input;
    let secrets = payload.secrets;

    let engine = input.engine.clone();
    let label = input.label.clone();
    let has_ssh = input.ssh.is_some();

    tracing::info!(engine = ?engine, label = %label, ssh = %has_ssh, "connection_test: start");

    let driver = state
        .engines
        .get(engine.clone())
        .ok_or("ENGINE_NOT_SUPPORTED")?;

    // ---------------------------------------------------------------------
    // TEST-ONLY: inject plaintext secrets (NO persist, NO logging)
    // - DB: when UI is in keychain mode but profile not created yet,
    //       FE often sends SecretRefKind::Keychain with empty value.
    //       For test, we override to Inline using secrets.db_password.
    // - SSH: when ssh auth is Password and we got secrets.ssh_password,
    //        fill it in if the current password is empty.
    // ---------------------------------------------------------------------
    if let Some(sec) = secrets.as_ref() {
        // DB password
        if let Some(pw) = sec.db_password.as_deref() {
            match engine {
                crate::types::EngineKind::Postgres => {
                    if let Some(pg) = input.postgres.as_mut() {
                        if pg.password.kind == crate::types::SecretRefKind::Keychain
                            && pg.password.value.trim().is_empty()
                        {
                            pg.password.kind = crate::types::SecretRefKind::Inline;
                            pg.password.value = pw.to_string();
                        }
                    }
                }
                crate::types::EngineKind::Mysql => {
                    if let Some(my) = input.mysql.as_mut() {
                        if my.password.kind == crate::types::SecretRefKind::Keychain
                            && my.password.value.trim().is_empty()
                        {
                            my.password.kind = crate::types::SecretRefKind::Inline;
                            my.password.value = pw.to_string();
                        }
                    }
                }
                crate::types::EngineKind::Mariadb => {
                    if let Some(my) = input.mysql.as_mut() {
                        if my.password.kind == crate::types::SecretRefKind::Keychain
                            && my.password.value.trim().is_empty()
                        {
                            my.password.kind = crate::types::SecretRefKind::Inline;
                            my.password.value = pw.to_string();
                        }
                    }
                }
                crate::types::EngineKind::Oracle => {
                    if let Some(oracle) = input.oracle.as_mut() {
                        if oracle.password.kind == crate::types::SecretRefKind::Keychain
                            && oracle.password.value.trim().is_empty()
                        {
                            oracle.password.kind = crate::types::SecretRefKind::Inline;
                            oracle.password.value = pw.to_string();
                        }
                    }
                }
                crate::types::EngineKind::Sqlite => {}
                crate::types::EngineKind::Mongo => {
                    if let Some(mongo) = input.mongo.as_mut() {
                        if mongo.password.kind == crate::types::SecretRefKind::Keychain
                            && mongo.password.value.trim().is_empty()
                        {
                            mongo.password.kind = crate::types::SecretRefKind::Inline;
                            mongo.password.value = pw.to_string();
                        }
                    }
                }
                crate::types::EngineKind::Redis => {
                    if let Some(rd) = input.redis.as_mut() {
                        if rd.password.kind == crate::types::SecretRefKind::Keychain
                            && rd.password.value.trim().is_empty()
                        {
                            rd.password.kind = crate::types::SecretRefKind::Inline;
                            rd.password.value = pw.to_string();
                        }
                    }
                }
                #[allow(unreachable_patterns)]
                _ => {}
            }
        }

        // SSH password
        if let Some(pw) = sec.ssh_password.as_deref() {
            if let Some(ssh) = input.ssh.as_mut() {
                if let crate::ssh_tunnel::types::SshAuth::Password { password } = &mut ssh.auth {
                    if password.trim().is_empty() {
                        *password = pw.to_string();
                    }
                }
            }
        }
    }

    // Optional SSH tunnel
    let mut tunnel_opt: Option<crate::ssh_tunnel::handle::SshTunnelHandle> = None;

    if let Some(ssh_in) = input.ssh.clone() {
        tracing::info!(
            engine = ?engine,
            label = %label,
            ssh_host = %ssh_in.ssh_host,
            ssh_port = ssh_in.ssh_port,
            ssh_user = ?ssh_in.ssh_user.as_deref().map(str::trim),
            remote_host = %ssh_in.remote_host,
            remote_port = ssh_in.remote_port,
            "connection_test: opening ssh tunnel"
        );

        let t0 = std::time::Instant::now();
        let tunnel = ssh_tunnel::open_tunnel(&ssh_in).await.map_err(|e| {
            tracing::error!(
                engine = ?engine,
                label = %label,
                ssh_host = %ssh_in.ssh_host,
                ssh_port = ssh_in.ssh_port,
                remote_host = %ssh_in.remote_host,
                remote_port = ssh_in.remote_port,
                error = %format!("{e:#}"),
                "connection_test: ssh tunnel open failed"
            );
            format!("SSH_TUNNEL_OPEN_FAILED: {e:#}")
        })?;

        let local = tunnel.local_addr();
        tracing::info!(
            engine = ?engine,
            label = %label,
            local_bind = %local,
            elapsed_ms = t0.elapsed().as_millis(),
            "connection_test: ssh tunnel opened"
        );

        input = rewrite_input_host_port(input, "127.0.0.1", local.port())?;
        tunnel_opt = Some(tunnel);
    }

    tracing::info!(engine = ?engine, label = %label, "connection_test: driver.test begin");

    let t1 = std::time::Instant::now();
    let res = driver.test(&app, input, secrets).await;

    if let Err(e) = &res {
        tracing::error!(
            engine = ?engine,
            label = %label,
            elapsed_ms = t1.elapsed().as_millis(),
            error = %e,
            "connection_test: failed"
        );
    } else {
        tracing::info!(
            engine = ?engine,
            label = %label,
            elapsed_ms = t1.elapsed().as_millis(),
            "connection_test: ok"
        );
    }

    // Always close tunnel (best-effort)
    if let Some(tunnel) = tunnel_opt.take() {
        close_tunnel_quietly(tunnel).await;
    }

    res
}

#[tauri::command]
pub async fn connection_list(state: State<'_, AppState>) -> Result<Vec<ConnectionInfo>, String> {
    Ok(state
        .connections
        .iter()
        .map(|c| {
            let engine = c.value().engine_kind();

            ConnectionInfo {
                id: *c.key(),
                engine,
                label: c.value().label(),
            }
        })
        .collect())
}

#[tauri::command]
pub async fn connection_version(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> Result<String, String> {
    use mysql_async::prelude::Queryable as _;

    let conn = state
        .connections
        .get(&connection_id)
        .ok_or("CONNECTION_NOT_FOUND")?;

    match conn.value() {
        crate::engines::EngineConnection::Postgres(pg) => {
            let client = pg
                .pool
                .get()
                .await
                .map_err(|e| format!("PG_POOL_GET_FAILED: {e}"))?;
            let row = client
                .query_one("SHOW server_version", &[])
                .await
                .map_err(|e| format!("PG_VERSION_QUERY_FAILED: {e}"))?;
            let version: String = row.get(0);
            Ok(version)
        }
        crate::engines::EngineConnection::MySql(my) => {
            let mut conn = my
                .pool
                .get_conn()
                .await
                .map_err(|e| format!("MYSQL_POOL_GET_FAILED: {e}"))?;
            let version: Option<String> = conn
                .query_first("SELECT VERSION()")
                .await
                .map_err(|e| format!("MYSQL_VERSION_QUERY_FAILED: {e}"))?;
            version.ok_or("MYSQL_VERSION_NOT_FOUND".into())
        }
        crate::engines::EngineConnection::Sqlite(sqlite) => {
            let path = sqlite.db_path.clone();
            let version = tokio::task::spawn_blocking(move || -> Result<String, String> {
                let conn = rusqlite::Connection::open(&path)
                    .map_err(|e| format!("SQLITE_OPEN_FAILED: {e}"))?;
                let version: String = conn
                    .query_row("SELECT sqlite_version()", [], |row| row.get(0))
                    .map_err(|e| format!("SQLITE_VERSION_QUERY_FAILED: {e}"))?;
                Ok(version)
            })
            .await
            .map_err(|e| format!("SQLITE_VERSION_JOIN_FAILED: {e}"))??;
            Ok(version)
        }
        crate::engines::EngineConnection::Oracle(oracle_conn) => {
            crate::engines::oracle::ensure_oracle_client_initialized()
                .map_err(|e| format!("ORACLE_VERSION_INIT_FAILED: {e}"))?;
            let user = oracle_conn.user.clone();
            let password = oracle_conn.password.clone();
            let connect_string = oracle_conn.connect_string.clone();
            let version = tokio::task::spawn_blocking(move || -> Result<String, String> {
                let conn = oracle::Connection::connect(&user, &password, &connect_string)
                    .map_err(|e| format!("ORACLE_CONNECT_FAILED: {e}"))?;
                let version: String = conn
                    .query_row_as(
                        "SELECT version FROM product_component_version WHERE product LIKE 'Oracle%' AND ROWNUM = 1",
                        &[],
                    )
                    .map_err(|e| format!("ORACLE_VERSION_QUERY_FAILED: {e}"))?;
                Ok(version)
            })
            .await
            .map_err(|e| format!("ORACLE_VERSION_JOIN_FAILED: {e}"))??;
            Ok(version)
        }
        crate::engines::EngineConnection::Mongo(mongo) => {
            let db = mongo.client.database("admin");
            let res = db
                .run_command(mongodb::bson::doc! { "buildInfo": 1 }, None)
                .await
                .map_err(|e| format!("MONGO_VERSION_QUERY_FAILED: {e}"))?;
            let version = res
                .get_str("version")
                .map_err(|e| format!("MONGO_VERSION_PARSE_FAILED: {e}"))?;
            Ok(version.to_string())
        }
        crate::engines::EngineConnection::Redis(redis) => {
            let mut conn = redis
                .pool
                .get()
                .await
                .map_err(|e| format!("REDIS_POOL_GET_FAILED: {e}"))?;
            let info: String = redis::cmd("INFO")
                .arg("server")
                .query_async(&mut conn)
                .await
                .map_err(|e| format!("REDIS_INFO_QUERY_FAILED: {e}"))?;
            parse_redis_version(&info).ok_or("REDIS_VERSION_NOT_FOUND".into())
        }
    }
}

#[tauri::command]
pub async fn connection_remove(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> Result<(), String> {
    // 1) cancel + abort ops
    let op_ids: Vec<Uuid> = state
        .op_to_conn
        .iter()
        .filter(|e| *e.value() == connection_id)
        .map(|e| *e.key())
        .collect();

    for op_id in op_ids {
        if let Some(h) = state.running_ops.get(&op_id) {
            h.value().cancel(); // DB-level cancel
        }

        if let Some((_k, task)) = state.op_tasks.remove(&op_id) {
            task.abort(); // HARD STOP
        }

        state.active_ops.remove(&op_id);
        state.running_ops.remove(&op_id);
        state.cancel_requested.remove(&op_id);
        state.op_to_conn.remove(&op_id);
    }

    // 2) close DB connection resources
    if let Some((_id, conn)) = state.connections.remove(&connection_id) {
        conn.close().await;
    }

    // 3) release SSH tunnel
    crate::ssh_tunnel::pool::release_shared_tunnel_by_conn(&state, connection_id).await;

    Ok(())
}
