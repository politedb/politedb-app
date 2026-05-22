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
        crate::types::EngineKind::Sqlserver => {
            let ss = input.sqlserver.as_mut().ok_or("SQLSERVER_CONFIG_MISSING")?;
            ss.host = host.into();
            ss.port = port;
        }
        crate::types::EngineKind::Oracle => {
            let oracle = input.oracle.as_mut().ok_or("ORACLE_CONFIG_MISSING")?;
            oracle.host = host.into();
            oracle.port = port;
        }
        crate::types::EngineKind::Sqlite => {}
        crate::types::EngineKind::D1 => {}
        crate::types::EngineKind::Mongo => {
            let mongo = input.mongo.as_mut().ok_or("MONGO_CONFIG_MISSING")?;
            mongo.host = host.into();
            mongo.port = port;
        }
        crate::types::EngineKind::Cassandra => {
            let cassandra = input.cassandra.as_mut().ok_or("CASSANDRA_CONFIG_MISSING")?;
            cassandra.host = host.into();
            cassandra.port = port;
        }
        crate::types::EngineKind::Redis => {
            let r = input.redis.as_mut().ok_or("REDIS_CONFIG_MISSING")?;
            r.host = host.into();
            r.port = port;
        }
        crate::types::EngineKind::Snowflake => {}
        crate::types::EngineKind::Duckdb => {}
        crate::types::EngineKind::Clickhouse => {
            let ch = input
                .clickhouse
                .as_mut()
                .ok_or("CLICKHOUSE_CONFIG_MISSING")?;
            ch.host = host.into();
            ch.port = port;
        }
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
                crate::types::EngineKind::Sqlserver => {
                    if let Some(ss) = input.sqlserver.as_mut() {
                        if ss.password.kind == crate::types::SecretRefKind::Keychain
                            && ss.password.value.trim().is_empty()
                        {
                            ss.password.kind = crate::types::SecretRefKind::Inline;
                            ss.password.value = pw.to_string();
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
                crate::types::EngineKind::Duckdb => {}
                crate::types::EngineKind::D1 => {
                    if let Some(d1) = input.d1.as_mut() {
                        if d1.api_token.kind == crate::types::SecretRefKind::Keychain
                            && d1.api_token.value.trim().is_empty()
                        {
                            d1.api_token.kind = crate::types::SecretRefKind::Inline;
                            d1.api_token.value = pw.to_string();
                        }
                    }
                }
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
                crate::types::EngineKind::Cassandra => {
                    if let Some(cassandra) = input.cassandra.as_mut() {
                        if cassandra.password.kind == crate::types::SecretRefKind::Keychain
                            && cassandra.password.value.trim().is_empty()
                        {
                            cassandra.password.kind = crate::types::SecretRefKind::Inline;
                            cassandra.password.value = pw.to_string();
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
                crate::types::EngineKind::Snowflake => {
                    if let Some(sf) = input.snowflake.as_mut() {
                        if sf.password.kind == crate::types::SecretRefKind::Keychain
                            && sf.password.value.trim().is_empty()
                        {
                            sf.password.kind = crate::types::SecretRefKind::Inline;
                            sf.password.value = pw.to_string();
                        }
                    }
                }
                crate::types::EngineKind::Clickhouse => {
                    if let Some(ch) = input.clickhouse.as_mut() {
                        if ch.password.kind == crate::types::SecretRefKind::Keychain
                            && ch.password.value.trim().is_empty()
                        {
                            ch.password.kind = crate::types::SecretRefKind::Inline;
                            ch.password.value = pw.to_string();
                        }
                    }
                }
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
    use tokio_util::compat::TokioAsyncWriteCompatExt as _;

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
        crate::engines::EngineConnection::SqlServer(ss) => {
            let mut config = tiberius::Config::new();
            config.host(&ss.host);
            config.port(ss.port);
            config.database(&ss.database);
            config.authentication(tiberius::AuthMethod::sql_server(&ss.user, &ss.password));
            if ss.encrypt {
                config.encryption(tiberius::EncryptionLevel::Required);
                config.trust_cert();
            } else {
                config.encryption(tiberius::EncryptionLevel::NotSupported);
            }

            let addr = config.get_addr();
            let tcp = tokio::net::TcpStream::connect(addr)
                .await
                .map_err(|e| format!("SQLSERVER_TCP_CONNECT_FAILED: {e}"))?;
            tcp.set_nodelay(true)
                .map_err(|e| format!("SQLSERVER_TCP_NODELAY_FAILED: {e}"))?;
            let mut client = tiberius::Client::connect(config, tcp.compat_write())
                .await
                .map_err(|e| format!("SQLSERVER_CONNECT_FAILED: {e}"))?;
            let row = client
                .simple_query(
                    "SELECT CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(128)) AS version",
                )
                .await
                .map_err(|e| format!("SQLSERVER_VERSION_QUERY_FAILED: {e}"))?
                .into_row()
                .await
                .map_err(|e| format!("SQLSERVER_VERSION_ROW_FAILED: {e}"))?
                .ok_or("SQLSERVER_VERSION_NOT_FOUND")?;
            let version = row.get::<&str, _>(0).unwrap_or("").to_string();
            if version.is_empty() {
                Err("SQLSERVER_VERSION_NOT_FOUND".into())
            } else {
                Ok(version)
            }
        }
        crate::engines::EngineConnection::Sqlite(sqlite) => {
            let shared = sqlite.conn.clone();
            let version = tokio::task::spawn_blocking(move || -> Result<String, String> {
                let conn = shared
                    .lock()
                    .map_err(|_| "SQLITE_CONN_MUTEX_POISONED".to_string())?;
                let version: String = conn
                    .query_row("SELECT sqlite_version()", [], |row| row.get(0))
                    .map_err(|e| format!("SQLITE_VERSION_QUERY_FAILED: {e}"))?;
                Ok(version)
            })
            .await
            .map_err(|e| format!("SQLITE_VERSION_JOIN_FAILED: {e}"))??;
            Ok(version)
        }
        crate::engines::EngineConnection::Duckdb(duckdb) => {
            let shared = duckdb.conn.clone();
            let db_path = duckdb.db_path.clone();
            let version = tokio::task::spawn_blocking(move || -> Result<String, String> {
                crate::engines::duckdb::util::with_duckdb_connection(&shared, |conn| {
                    conn.query_row("SELECT version()", [], |row| row.get(0))
                        .map_err(|e| format!("DUCKDB_VERSION_QUERY_FAILED: {e}"))
                })
            })
            .await
            .map_err(|e| format!("DUCKDB_VERSION_JOIN_FAILED: {e}"))??;
            Ok(if db_path.is_empty() || db_path == ":memory:" {
                version
            } else {
                format!("{version} ({db_path})")
            })
        }
        crate::engines::EngineConnection::D1(_) => {
            // D1 HTTP API rejects sqlite_version(); version is display-only in the UI.
            Ok("Cloudflare D1".to_string())
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
                .run_command(mongodb::bson::doc! { "buildInfo": 1 })
                .await
                .map_err(|e| format!("MONGO_VERSION_QUERY_FAILED: {e}"))?;
            let version = res
                .get_str("version")
                .map_err(|e| format!("MONGO_VERSION_PARSE_FAILED: {e}"))?;
            Ok(version.to_string())
        }
        crate::engines::EngineConnection::Cassandra(cassandra) => {
            let default_keyspace = cassandra.default_keyspace.clone();
            let (version,): (String,) = cassandra
                .session
                .query_unpaged("SELECT release_version FROM system.local", &[])
                .await
                .map_err(|e| format!("CASSANDRA_VERSION_QUERY_FAILED: {e}"))?
                .into_rows_result()
                .map_err(|e| format!("CASSANDRA_VERSION_ROWS_FAILED: {e}"))?
                .single_row()
                .map_err(|e| format!("CASSANDRA_VERSION_ROW_FAILED: {e}"))?;
            Ok(match default_keyspace {
                Some(ks) if !ks.is_empty() => format!("{version} ({ks})"),
                _ => version,
            })
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
        crate::engines::EngineConnection::Snowflake(sf) => {
            use crate::types::secret::{SecretRef, SecretRefKind};
            let input = crate::types::SnowflakeConnectInput {
                account: sf.account.clone(),
                warehouse: sf.warehouse.clone(),
                database: sf.database.clone(),
                schema: Some(sf.schema.clone()),
                role: sf.role.clone(),
                user: sf.user.clone(),
                password: SecretRef {
                    kind: SecretRefKind::Inline,
                    value: sf.password.clone(),
                },
                connect_timeout_ms: sf.connect_timeout_ms,
                statement_timeout_ms: sf.default_statement_timeout_ms,
            };
            let session = crate::engines::snowflake::create_session(&input, &sf.password)
                .await
                .map_err(|e| format!("SNOWFLAKE_VERSION_SESSION_FAILED: {e}"))?;
            let rows = session
                .query("SELECT CURRENT_VERSION()")
                .await
                .map_err(|e| format!("SNOWFLAKE_VERSION_QUERY_FAILED: {e}"))?;
            let version = rows
                .first()
                .and_then(|r| r.get::<String>("CURRENT_VERSION()").ok())
                .filter(|v| !v.is_empty())
                .ok_or("SNOWFLAKE_VERSION_NOT_FOUND")?;
            Ok(version)
        }
        crate::engines::EngineConnection::Clickhouse(ch) => {
            use clickhouse::Row;
            use serde::Deserialize;

            #[derive(Row, Deserialize)]
            struct VersionRow {
                version: String,
            }

            let row = ch
                .client
                .query("SELECT version() AS version")
                .fetch_one::<VersionRow>()
                .await
                .map_err(|e| format!("CLICKHOUSE_VERSION_QUERY_FAILED: {e}"))?;
            Ok(row.version)
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
