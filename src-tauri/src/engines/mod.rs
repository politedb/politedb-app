pub mod cancel;
pub mod cassandra;
pub mod clickhouse;
pub mod csv_import;
pub mod d1;
pub mod driver;
pub mod duckdb;
pub mod google_sheets;
pub mod merge;
pub mod mongo;
pub mod mysql;
pub mod op_cleanup;
pub mod oracle;
pub mod postgres;
pub mod profile_secrets;
pub mod redis;
pub mod registry;
pub mod runtime;
pub mod secrets_util;
pub mod snowflake;
pub mod sql_classify;
pub mod sqlite;
pub mod sqlserver;
pub mod tunnel_endpoint;
pub mod turso;

/// Live connection handle for a single profile session.
#[derive(Clone)]
pub enum EngineConnection {
    Postgres(postgres::connection::PgConn),
    MySql(mysql::connection::MySqlConn),
    SqlServer(sqlserver::connection::SqlServerConn),
    Sqlite(sqlite::connection::SqliteConn),
    D1(d1::connection::D1Conn),
    Turso(turso::connection::TursoConn),
    Oracle(oracle::connection::OracleConn),
    Mongo(mongo::connection::MongoConn),
    Cassandra(cassandra::connection::CassandraConn),
    Redis(redis::connection::RedisConn),
    Snowflake(snowflake::connection::SnowflakeConn),
    Duckdb(duckdb::connection::DuckdbConn),
    Clickhouse(Box<clickhouse::connection::ClickhouseConn>),
    GoogleSheets(google_sheets::connection::GoogleSheetsConn),
}
