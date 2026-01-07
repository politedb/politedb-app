use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::ssh_tunnel;
use crate::state::AppState;
use crate::types::{ConnectionCreateInput, ConnectionInfo, ConnectionTestInput};

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
    let _ = tunnel.close();
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

    // 0) Optional SSH tunnel
    let mut tunnel_opt: Option<crate::ssh_tunnel::handle::SshTunnelHandle> = None;

    if let Some(ssh_in) = input.ssh.clone() {
        tracing::info!(conn_id = %id, "connection_create: opening ssh tunnel");

        let tunnel = ssh_tunnel::open_tunnel(&ssh_in)
            .await
            .map_err(|e| format!("SSH_TUNNEL_OPEN_FAILED: {e:#}"))?;

        let local_port = tunnel.local_addr().port();

        tracing::info!(
            conn_id = %id,
            local_port = %local_port,
            "connection_create: ssh tunnel opened"
        );

        input = rewrite_input_host_port(input, "127.0.0.1", local_port)?;
        tunnel_opt = Some(tunnel);
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
        Ok(c) => {
            tracing::info!(conn_id = %id, engine = ?engine, "connection_create: connect ok");
            c
        }
        Err(e) => {
            // log error string (still should not include password if driver is clean)
            tracing::error!(
                conn_id = %id,
                engine = ?engine,
                error = %e,
                "connection_create: connect failed"
            );

            if let Some(tunnel) = tunnel_opt.take() {
                close_tunnel_quietly(tunnel).await;
            }
            return Err(e);
        }
    };

    // 3) Insert runtime connection
    state.connections.insert(id, conn);

    if let Some(tunnel) = tunnel_opt.take() {
        state.ssh_tunnels.insert(id, tunnel);
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
pub async fn connection_remove(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> Result<(), String> {
    // 1) Cancel all running ops of this connection (if any)
    for entry in state.running_ops.iter() {
        let op_id = *entry.key();
        entry.value().cancel();
        state.active_ops.remove(&op_id);
        state.cancel_requested.insert(op_id, ());
    }

    // 2) Remove runtime connection
    state.connections.remove(&connection_id);

    // 3) Close SSH tunnel if exists
    if let Some((_, tunnel)) = state.ssh_tunnels.remove(&connection_id) {
        close_tunnel_quietly(tunnel).await;
    }

    Ok(())
}
