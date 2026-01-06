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
    mut input: ConnectionCreateInput,
) -> Result<(), String> {
    let engine = input.engine.clone();
    let label = input.label.clone();

    // Basic safe context (NO secrets)
    tracing::info!(
        engine = ?engine,
        label = %label,
        ssh = %input.ssh.is_some(),
        "connection_test: start"
    );

    // Resolve driver
    let driver = state
        .engines
        .get(engine.clone())
        .ok_or("ENGINE_NOT_SUPPORTED")?;

    tracing::debug!(
        engine = ?engine,
        driver_kind = ?driver.kind(),
        "connection_test: driver resolved"
    );

    let mut tunnel_opt: Option<crate::ssh_tunnel::handle::SshTunnelHandle> = None;

    // Optional SSH tunnel
    if let Some(ssh_in) = input.ssh.clone() {
        tracing::info!(
            engine = ?engine,
            label = %label,
            ssh_host = %ssh_in.ssh_host,
            ssh_port = ssh_in.ssh_port,
            ssh_user = ?ssh_in.ssh_user.as_deref().map(str::trim),
            strict = ?ssh_in.strict_host_key_checking.as_deref(),
            remote_host = %ssh_in.remote_host,
            remote_port = ssh_in.remote_port,
            "connection_test: opening ssh tunnel"
        );

        let t0 = std::time::Instant::now();
        let tunnel = match ssh_tunnel::open_tunnel(&ssh_in).await {
            Ok(t) => t,
            Err(e) => {
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
                return Err(format!("SSH_TUNNEL_OPEN_FAILED: {e:#}"));
            }
        };

        let local = tunnel.local_addr();
        tracing::info!(
            engine = ?engine,
            label = %label,
            local_bind = %local,
            elapsed_ms = t0.elapsed().as_millis(),
            "connection_test: ssh tunnel opened"
        );

        // Rewrite input to localhost:local_port
        let before = (
            // Only log host/port - never log password
            input.postgres.as_ref().map(|p| (p.host.clone(), p.port)),
            input.mysql.as_ref().map(|m| (m.host.clone(), m.port)),
            input.redis.as_ref().map(|r| (r.host.clone(), r.port)),
        );

        input = rewrite_input_host_port(input, "127.0.0.1", local.port())?;

        let after = (
            input.postgres.as_ref().map(|p| (p.host.clone(), p.port)),
            input.mysql.as_ref().map(|m| (m.host.clone(), m.port)),
            input.redis.as_ref().map(|r| (r.host.clone(), r.port)),
        );

        tracing::debug!(
            engine = ?engine,
            before = ?before,
            after = ?after,
            "connection_test: input host/port rewritten for tunnel"
        );

        tunnel_opt = Some(tunnel);
    } else {
        // No SSH: log direct target (safe)
        let target = (
            input.postgres.as_ref().map(|p| (p.host.clone(), p.port)),
            input.mysql.as_ref().map(|m| (m.host.clone(), m.port)),
            input.redis.as_ref().map(|r| (r.host.clone(), r.port)),
        );
        tracing::debug!(
            engine = ?engine,
            target = ?target,
            "connection_test: no ssh, direct connect target"
        );
    }

    // Run test
    tracing::info!(
        engine = ?engine,
        label = %label,
        "connection_test: driver.test begin"
    );

    let t1 = std::time::Instant::now();
    let res = driver.test(&app, input).await;

    match &res {
        Ok(_) => {
            tracing::info!(
                engine = ?engine,
                label = %label,
                elapsed_ms = t1.elapsed().as_millis(),
                "connection_test: driver.test ok"
            );
        }
        Err(e) => {
            tracing::error!(
                engine = ?engine,
                label = %label,
                elapsed_ms = t1.elapsed().as_millis(),
                error = %e,
                "connection_test: driver.test failed"
            );
        }
    }

    // Always close tunnel
    if let Some(tunnel) = tunnel_opt.take() {
        let local = tunnel.local_addr();
        tracing::debug!(
            engine = ?engine,
            label = %label,
            local_bind = %local,
            "connection_test: closing ssh tunnel"
        );
        close_tunnel_quietly(tunnel).await;
        tracing::debug!(
            engine = ?engine,
            label = %label,
            local_bind = %local,
            "connection_test: ssh tunnel closed"
        );
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
