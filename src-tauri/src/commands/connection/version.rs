use mysql_async::prelude::Queryable as _;
use tauri::State;
use tokio_util::compat::TokioAsyncWriteCompatExt as _;
use uuid::Uuid;

use crate::engines::EngineConnection;
use crate::state::AppState;

use super::helpers::parse_redis_version;

pub(crate) async fn fetch_connection_version(conn: &EngineConnection) -> Result<String, String> {
    match conn {
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
        crate::engines::EngineConnection::Turso(turso) => {
            let db = turso.db.clone();
            let version = async {
                let conn = db
                    .connect()
                    .map_err(|e| format!("TURSO_VERSION_CONNECT_FAILED: {e}"))?;
                let mut rows = conn
                    .query("SELECT sqlite_version()", ())
                    .await
                    .map_err(|e| format!("TURSO_VERSION_QUERY_FAILED: {e}"))?;
                let row = rows
                    .next()
                    .await
                    .map_err(|e| format!("TURSO_VERSION_ROW_FAILED: {e}"))?
                    .ok_or("TURSO_VERSION_EMPTY")?;
                row.get::<String>(0)
                    .map_err(|e| format!("TURSO_VERSION_DECODE_FAILED: {e}"))
            }
            .await?;
            Ok(format!("Turso (SQLite {version})"))
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
            use crate::engines::clickhouse::connection::ClickhouseClient;

            match &ch.client {
                ClickhouseClient::Native(client) => {
                    use klickhouse::Row;

                    #[derive(Row, Debug)]
                    struct VersionRow {
                        version: String,
                    }

                    let row = client
                        .query_one::<VersionRow>("SELECT version() AS version")
                        .await
                        .map_err(|e| format!("CLICKHOUSE_VERSION_QUERY_FAILED: {e}"))?;
                    Ok(row.version)
                }
                ClickhouseClient::Http(client) => {
                    use clickhouse::Row;
                    use serde::Deserialize;

                    #[derive(Row, Deserialize)]
                    struct VersionRow {
                        version: String,
                    }

                    let row = client
                        .query("SELECT version() AS version")
                        .fetch_one::<VersionRow>()
                        .await
                        .map_err(|e| format!("CLICKHOUSE_VERSION_QUERY_FAILED: {e}"))?;
                    Ok(row.version)
                }
            }
        }
    }
}

#[tauri::command]
pub async fn connection_version(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> Result<String, String> {
    let conn = state
        .connections
        .get(&connection_id)
        .ok_or("CONNECTION_NOT_FOUND")?;
    fetch_connection_version(conn.value()).await
}
