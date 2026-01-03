use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::ssh_tunnel;
use crate::state::AppState;
use crate::types::{ConnectionCreateInput, ConnectionInfo};

fn rewrite_input_host_port(
    mut input: ConnectionCreateInput,
    host: &str,
    port: u16,
) -> Result<ConnectionCreateInput, String> {
    match input.engine {
        crate::types::EngineKind::Postgres => {
            let pg = input.postgres.as_mut().ok_or("POSTGRES_CONFIG_MISSING")?;
            pg.host = host.to_string();
            pg.port = port as u16;
        }
        crate::types::EngineKind::Mysql => {
            let my = input.mysql.as_mut().ok_or("MYSQL_CONFIG_MISSING")?;
            my.host = host.to_string();
            my.port = port;
        }
        crate::types::EngineKind::Redis => {
            let r = input.redis.as_mut().ok_or("REDIS_CONFIG_MISSING")?;
            r.host = host.to_string();
            r.port = port;
        }
        _ => return Err("ENGINE_NOT_SUPPORTED_YET".into()),
    }
    Ok(input)
}

#[tauri::command]
pub async fn connection_create(
    app: AppHandle,
    state: State<'_, AppState>,
    mut input: ConnectionCreateInput,
) -> Result<ConnectionInfo, String> {
    let id = Uuid::new_v4();

    // ✅ safe debug context (NO password)
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

        let local_port = tunnel.local_port();
        tracing::info!(conn_id = %id, local_port = %local_port, "connection_create: ssh tunnel opened");

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
            if let Some(tunnel) = tunnel_opt {
                tunnel.close().await;
            }
            return Err(e);
        }
    };

    // 3) Insert runtime connection
    state.connections.insert(id, conn);

    // 3.1) Store tunnel only after success
    if let Some(tunnel) = tunnel_opt {
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
    mut input: ConnectionCreateInput,
) -> Result<(), String> {
    let driver = state
        .engines
        .get(input.engine.clone())
        .ok_or("ENGINE_NOT_SUPPORTED")?;

    let mut tunnel_opt: Option<crate::ssh_tunnel::handle::SshTunnelHandle> = None;

    if let Some(ssh_in) = input.ssh.clone() {
        let tunnel = ssh_tunnel::open_tunnel(&ssh_in)
            .await
            .map_err(|e| format!("SSH_TUNNEL_OPEN_FAILED: {e:#}"))?;

        let local_port = tunnel.local_port();
        input = rewrite_input_host_port(input, "127.0.0.1", local_port)?;
        tunnel_opt = Some(tunnel);
    }

    let res = driver.test(&app, input).await;

    if let Some(tunnel) = tunnel_opt {
        tunnel.close().await;
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
        // nếu sau này có mapping op -> connection_id thì check ở đây
        entry.value().cancel();
        state.active_ops.remove(&op_id);
        state.cancel_requested.insert(op_id, ());
    }

    // 2) Remove runtime connection
    state.connections.remove(&connection_id);

    // 3) Close SSH tunnel if exists
    if let Some((_, tunnel)) = state.ssh_tunnels.remove(&connection_id) {
        tunnel.close().await;
    }

    Ok(())
}
