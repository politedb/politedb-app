use crate::types::ConnectionCreateInput;

pub fn rewrite_tunnel_endpoint(
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
        crate::types::EngineKind::Turso => {}
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
        crate::types::EngineKind::GoogleSheets => {}
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
