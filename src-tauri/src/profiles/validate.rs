use crate::types::{
    CassandraConnectInput, ClickhouseConnectInput, ConnectionCreateInput, D1ConnectInput,
    DuckdbConnectInput, EngineKind, MongoConnectInput, MySqlConnectInput, OracleConnectInput,
    PgConnectInput, RedisConnectInput, SnowflakeConnectInput, SqlServerConnectInput,
    SqliteConnectInput, TursoConnectInput,
};

fn validate_pg_input(pg: &PgConnectInput) -> Result<(), String> {
    if pg.host.trim().is_empty() {
        return Err("PG_HOST_REQUIRED".into());
    }
    if pg.user.trim().is_empty() {
        return Err("PG_USER_REQUIRED".into());
    }
    if pg.port == 0 {
        return Err("PG_PORT_INVALID".into());
    }

    // allow no password => do not require a non-empty password
    Ok(())
}

fn validate_mysql_input(my: &MySqlConnectInput) -> Result<(), String> {
    if my.host.trim().is_empty() {
        return Err("MYSQL_HOST_REQUIRED".into());
    }
    if my.user.trim().is_empty() {
        return Err("MYSQL_USER_REQUIRED".into());
    }
    if my.port == 0 {
        return Err("MYSQL_PORT_INVALID".into());
    }

    // allow no password
    Ok(())
}

fn validate_redis_input(r: &RedisConnectInput) -> Result<(), String> {
    if r.host.trim().is_empty() {
        return Err("REDIS_HOST_REQUIRED".into());
    }
    if r.port == 0 {
        return Err("REDIS_PORT_INVALID".into());
    }
    // allow no password
    Ok(())
}

fn validate_mongo_input(m: &MongoConnectInput) -> Result<(), String> {
    if m.host.trim().is_empty() {
        return Err("MONGO_HOST_REQUIRED".into());
    }
    if m.port == 0 {
        return Err("MONGO_PORT_INVALID".into());
    }
    Ok(())
}

fn validate_cassandra_input(c: &CassandraConnectInput) -> Result<(), String> {
    if c.host.trim().is_empty() {
        return Err("CASSANDRA_HOST_REQUIRED".into());
    }
    if c.port == 0 {
        return Err("CASSANDRA_PORT_INVALID".into());
    }
    Ok(())
}

fn validate_duckdb_input(s: &DuckdbConnectInput) -> Result<(), String> {
    if s.path.trim().is_empty() {
        return Err("DUCKDB_PATH_REQUIRED".into());
    }
    Ok(())
}

fn validate_sqlite_input(s: &SqliteConnectInput) -> Result<(), String> {
    if s.path.trim().is_empty() {
        return Err("SQLITE_PATH_REQUIRED".into());
    }
    Ok(())
}

fn validate_d1_input(d1: &D1ConnectInput) -> Result<(), String> {
    if d1.account_id.trim().is_empty() {
        return Err("D1_ACCOUNT_ID_REQUIRED".into());
    }
    if d1.database_id.trim().is_empty() {
        return Err("D1_DATABASE_ID_REQUIRED".into());
    }
    Ok(())
}

fn validate_turso_input(turso: &TursoConnectInput) -> Result<(), String> {
    if turso.url.trim().is_empty() {
        return Err("TURSO_URL_REQUIRED".into());
    }
    Ok(())
}

fn validate_snowflake_input(sf: &SnowflakeConnectInput) -> Result<(), String> {
    if sf.account.trim().is_empty() {
        return Err("SNOWFLAKE_ACCOUNT_REQUIRED".into());
    }
    if sf.warehouse.trim().is_empty() {
        return Err("SNOWFLAKE_WAREHOUSE_REQUIRED".into());
    }
    if sf.database.trim().is_empty() {
        return Err("SNOWFLAKE_DATABASE_REQUIRED".into());
    }
    if sf.user.trim().is_empty() {
        return Err("SNOWFLAKE_USER_REQUIRED".into());
    }
    Ok(())
}

fn validate_sqlserver_input(ss: &SqlServerConnectInput) -> Result<(), String> {
    if ss.host.trim().is_empty() {
        return Err("SQLSERVER_HOST_REQUIRED".into());
    }
    if ss.user.trim().is_empty() {
        return Err("SQLSERVER_USER_REQUIRED".into());
    }
    if ss.port == 0 {
        return Err("SQLSERVER_PORT_INVALID".into());
    }
    Ok(())
}

fn validate_oracle_input(oc: &OracleConnectInput) -> Result<(), String> {
    if oc.host.trim().is_empty() {
        return Err("ORACLE_HOST_REQUIRED".into());
    }
    if oc.user.trim().is_empty() {
        return Err("ORACLE_USER_REQUIRED".into());
    }
    if oc.port == 0 {
        return Err("ORACLE_PORT_INVALID".into());
    }
    Ok(())
}

fn validate_clickhouse_input(ch: &ClickhouseConnectInput) -> Result<(), String> {
    if ch.host.trim().is_empty() {
        return Err("CLICKHOUSE_HOST_REQUIRED".into());
    }
    if ch.user.trim().is_empty() {
        return Err("CLICKHOUSE_USER_REQUIRED".into());
    }
    if ch.port == 0 {
        return Err("CLICKHOUSE_PORT_INVALID".into());
    }
    Ok(())
}

pub fn validate_input(input: &ConnectionCreateInput) -> Result<(), String> {
    if input.label.trim().is_empty() {
        return Err("LABEL_REQUIRED".into());
    }

    match input.engine {
        EngineKind::Postgres => {
            let pg = input.postgres.as_ref().ok_or("POSTGRES_CONFIG_MISSING")?;
            validate_pg_input(pg)
        }
        EngineKind::Mysql => {
            let my = input.mysql.as_ref().ok_or("MYSQL_CONFIG_MISSING")?;
            validate_mysql_input(my)
        }
        EngineKind::Mariadb => {
            let my = input.mysql.as_ref().ok_or("MYSQL_CONFIG_MISSING")?;
            validate_mysql_input(my)
        }
        EngineKind::Sqlserver => {
            let ss = input.sqlserver.as_ref().ok_or("SQLSERVER_CONFIG_MISSING")?;
            validate_sqlserver_input(ss)
        }
        EngineKind::Sqlite => {
            let s = input.sqlite.as_ref().ok_or("SQLITE_CONFIG_MISSING")?;
            validate_sqlite_input(s)
        }
        EngineKind::Duckdb => {
            let d = input.duckdb.as_ref().ok_or("DUCKDB_CONFIG_MISSING")?;
            validate_duckdb_input(d)
        }
        EngineKind::D1 => {
            let d1 = input.d1.as_ref().ok_or("D1_CONFIG_MISSING")?;
            validate_d1_input(d1)
        }
        EngineKind::Turso => {
            let turso = input.turso.as_ref().ok_or("TURSO_CONFIG_MISSING")?;
            validate_turso_input(turso)
        }
        EngineKind::Oracle => {
            let oc = input.oracle.as_ref().ok_or("ORACLE_CONFIG_MISSING")?;
            validate_oracle_input(oc)
        }
        EngineKind::Mongo => {
            let mongo = input.mongo.as_ref().ok_or("MONGO_CONFIG_MISSING")?;
            validate_mongo_input(mongo)
        }
        EngineKind::Cassandra => {
            let cassandra = input.cassandra.as_ref().ok_or("CASSANDRA_CONFIG_MISSING")?;
            validate_cassandra_input(cassandra)
        }
        EngineKind::Redis => {
            let r = input.redis.as_ref().ok_or("REDIS_CONFIG_MISSING")?;
            validate_redis_input(r)
        }
        EngineKind::Snowflake => {
            let sf = input.snowflake.as_ref().ok_or("SNOWFLAKE_CONFIG_MISSING")?;
            validate_snowflake_input(sf)
        }
        EngineKind::Clickhouse => {
            let ch = input
                .clickhouse
                .as_ref()
                .ok_or("CLICKHOUSE_CONFIG_MISSING")?;
            validate_clickhouse_input(ch)
        }
        EngineKind::GoogleSheets => {
            let sheets = input
                .google_sheets
                .as_ref()
                .ok_or("GOOGLE_SHEETS_CONFIG_MISSING")?;
            crate::engines::google_sheets::api::normalize_spreadsheet_id(&sheets.spreadsheet_id)
                .map(|_| ())
        }
    }
}
