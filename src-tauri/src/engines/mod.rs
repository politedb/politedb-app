pub mod cancel;
pub mod d1;
pub mod driver;
pub mod merge;
pub mod mongo;
pub mod mysql;
pub mod oracle;
pub mod postgres;
pub mod redis;
pub mod registry;
pub mod secrets_util;
pub mod snowflake;
pub mod sqlite;
pub mod sqlserver;

use std::sync::Arc;
use uuid::Uuid;

use crate::engines::cancel::CancelHandle;
use crate::operations::ctx::{OperationCtx, SqlBusyRegistry};
use crate::types::{
    EngineKind, ImportNullMode, SqlImportCsvInput, SqlImportCsvResult, SqlQueryInput,
};
use crate::types::{OperationKind, RedisCommandInput};
use futures_util::TryStreamExt;
use mysql_async::prelude::Queryable;

#[derive(Clone)]
pub enum EngineConnection {
    Postgres(postgres::connection::PgConn),
    MySql(mysql::connection::MySqlConn),
    SqlServer(sqlserver::connection::SqlServerConn),
    Sqlite(sqlite::connection::SqliteConn),
    D1(d1::connection::D1Conn),
    Oracle(oracle::connection::OracleConn),
    Mongo(mongo::connection::MongoConn),
    Redis(redis::connection::RedisConn),
    Snowflake(snowflake::connection::SnowflakeConn),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SqlStatementKind {
    Ddl,
    Dml,
    TransactionControl,
    Other,
}

fn first_sql_token(sql: &str) -> String {
    sql.trim_start()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_matches(|c: char| !c.is_ascii_alphabetic())
        .to_ascii_uppercase()
}

fn classify_sql_statement(sql: &str) -> SqlStatementKind {
    match first_sql_token(sql).as_str() {
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "RENAME" | "COMMENT" => SqlStatementKind::Ddl,
        "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "REPLACE" => SqlStatementKind::Dml,
        "BEGIN" | "START" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" => {
            SqlStatementKind::TransactionControl
        }
        _ => SqlStatementKind::Other,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::types::{EngineKind, ImportNullMode, SqlImportColumnInput, SqlImportCsvInput};
    use uuid::Uuid;

    use super::{
        build_csv_import_statements, classify_sql_statement, reject_non_transactional_ddl,
        SqlStatementKind,
    };

    #[test]
    fn classifies_transaction_batch_statements() {
        assert_eq!(
            classify_sql_statement("ALTER TABLE users ADD COLUMN age int"),
            SqlStatementKind::Ddl
        );
        assert_eq!(
            classify_sql_statement("insert into users(id) values (1)"),
            SqlStatementKind::Dml
        );
        assert_eq!(
            classify_sql_statement("ROLLBACK"),
            SqlStatementKind::TransactionControl
        );
    }

    #[test]
    fn rejects_non_transactional_ddl_batches() {
        let statements = vec![
            "ALTER TABLE users ADD COLUMN age int".to_string(),
            "UPDATE users SET age = 1".to_string(),
        ];

        let err = reject_non_transactional_ddl("MYSQL_MARIADB", &statements)
            .expect_err("DDL should be rejected");

        assert!(err.contains("MYSQL_MARIADB_DDL_TRANSACTION_UNSUPPORTED"));
    }

    #[test]
    fn validates_full_csv_import_rows() {
        let mut mapping = HashMap::new();
        mapping.insert("id".to_string(), Some(0));

        let csv_text = std::iter::once("id".to_string())
            .chain((0..101).map(|i| {
                if i == 100 {
                    "bad".to_string()
                } else {
                    i.to_string()
                }
            }))
            .collect::<Vec<_>>()
            .join("\n");

        let input = SqlImportCsvInput {
            connection_id: Uuid::nil(),
            engine: EngineKind::Postgres,
            schema: "public".into(),
            table_name: "users".into(),
            columns: vec![SqlImportColumnInput {
                name: "id".into(),
                db_type: "int".into(),
            }],
            column_mapping: mapping,
            null_mode: ImportNullMode::EmptyString,
            first_is_headers: true,
            full_validation: true,
            csv_text,
        };

        let err = build_csv_import_statements(&input).expect_err("row 101 should fail");
        assert!(err.contains("row 101"));
        assert!(err.contains("Invalid number"));
    }
}

fn reject_non_transactional_ddl(engine: &str, statements: &[String]) -> Result<(), String> {
    if statements
        .iter()
        .any(|stmt| classify_sql_statement(stmt) == SqlStatementKind::Ddl)
    {
        return Err(format!(
            "{engine}_DDL_TRANSACTION_UNSUPPORTED: {engine} implicitly commits DDL, so schema edits cannot be safely rolled back in this batch. Run schema and data changes separately."
        ));
    }

    Ok(())
}

fn quote_import_identifier(ident: &str, engine: EngineKind) -> String {
    match engine {
        EngineKind::Mysql | EngineKind::Mariadb => format!("`{}`", ident.replace('`', "``")),
        EngineKind::Sqlserver => format!("[{}]", ident.replace(']', "]]")),
        _ => format!("\"{}\"", ident.replace('"', "\"\"")),
    }
}

fn quote_import_table(schema: &str, table_name: &str, engine: EngineKind) -> String {
    if schema.trim().is_empty() || matches!(engine, EngineKind::Sqlite | EngineKind::D1) {
        return quote_import_identifier(table_name, engine);
    }
    format!(
        "{}.{}",
        quote_import_identifier(schema, engine),
        quote_import_identifier(table_name, engine)
    )
}

fn sql_string_literal(value: &str, engine: EngineKind) -> String {
    match engine {
        EngineKind::Mysql | EngineKind::Mariadb => {
            let hex = value
                .as_bytes()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            format!("CONVERT(UNHEX('{hex}') USING utf8mb4)")
        }
        EngineKind::Sqlserver => format!("N'{}'", value.replace('\'', "''")),
        _ => format!("'{}'", value.replace('\'', "''")),
    }
}

fn import_type_issue(value: &str, db_type: &str) -> Option<&'static str> {
    if value.is_empty() {
        return None;
    }
    let typ = db_type.to_ascii_lowercase();
    if typ.contains("json") || typ.contains("array") {
        if serde_json::from_str::<serde_json::Value>(value).is_err() {
            return Some("Invalid JSON");
        }
        return None;
    }
    if [
        "tinyint",
        "smallint",
        "mediumint",
        "int",
        "integer",
        "bigint",
        "float",
        "double",
        "real",
        "numeric",
        "decimal",
    ]
    .iter()
    .any(|prefix| typ.starts_with(prefix))
    {
        if value.parse::<f64>().map(|v| v.is_finite()).unwrap_or(false) {
            return None;
        }
        return Some("Invalid number");
    }
    if typ.contains("bool") || typ.contains("boolean") || typ.contains("bit") {
        if matches!(
            value.to_ascii_lowercase().as_str(),
            "true" | "false" | "1" | "0"
        ) {
            return None;
        }
        return Some("Invalid boolean");
    }
    None
}

fn format_import_value(value: Option<&str>, db_type: &str, engine: EngineKind) -> String {
    let Some(raw) = value else {
        return "NULL".into();
    };

    let typ = db_type.to_ascii_lowercase();
    if typ.contains("json") && raw.trim().eq_ignore_ascii_case("null") {
        return "NULL".into();
    }
    if [
        "tinyint",
        "smallint",
        "mediumint",
        "int",
        "integer",
        "bigint",
        "float",
        "double",
        "real",
        "numeric",
        "decimal",
    ]
    .iter()
    .any(|prefix| typ.starts_with(prefix))
    {
        if raw.trim().eq_ignore_ascii_case("null") {
            return "NULL".into();
        }
        if let Ok(number) = raw.trim().parse::<f64>() {
            if number.is_finite() {
                return raw.trim().to_string();
            }
        }
    }

    sql_string_literal(raw, engine)
}

fn parse_csv_text(csv_text: &str) -> Result<Vec<Vec<String>>, String> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut chars = csv_text.chars().peekable();
    let mut in_quotes = false;

    while let Some(ch) = chars.next() {
        match ch {
            '"' if in_quotes && matches!(chars.peek(), Some('"')) => {
                chars.next();
                cell.push('"');
            }
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => {
                row.push(std::mem::take(&mut cell));
            }
            '\n' if !in_quotes => {
                row.push(std::mem::take(&mut cell));
                if !(row.len() == 1 && row[0].is_empty() && rows.is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
            }
            '\r' if !in_quotes => {
                if !matches!(chars.peek(), Some('\n')) {
                    row.push(std::mem::take(&mut cell));
                    rows.push(std::mem::take(&mut row));
                }
            }
            _ => cell.push(ch),
        }
    }

    if in_quotes {
        return Err("CSV_PARSE_FAILED: unterminated quoted field".into());
    }

    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }

    Ok(rows)
}

fn build_csv_import_statements(input: &SqlImportCsvInput) -> Result<Vec<String>, String> {
    let rows = parse_csv_text(&input.csv_text)?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let data_rows: Vec<&Vec<String>> = if input.first_is_headers {
        rows.iter().skip(1).collect()
    } else {
        rows.iter().collect()
    };

    let import_columns = input
        .columns
        .iter()
        .filter(|col| {
            input
                .column_mapping
                .get(&col.name)
                .and_then(|v| *v)
                .is_some()
        })
        .collect::<Vec<_>>();

    if import_columns.is_empty() {
        return Err("CSV_IMPORT_NO_MAPPED_COLUMNS".into());
    }

    let validation_limit = if input.full_validation {
        data_rows.len()
    } else {
        data_rows.len().min(100)
    };

    for (row_idx, row) in data_rows.iter().take(validation_limit).enumerate() {
        for column in &import_columns {
            let Some(Some(csv_idx)) = input.column_mapping.get(&column.name) else {
                continue;
            };
            let raw = row.get(*csv_idx).map(|s| s.as_str()).unwrap_or("");
            if raw.is_empty() && matches!(input.null_mode, ImportNullMode::EmptyAsNull) {
                continue;
            }
            if let Some(reason) = import_type_issue(raw, &column.db_type) {
                let preview = raw.chars().take(32).collect::<String>();
                return Err(format!(
                    "CSV_IMPORT_VALIDATION_FAILED: row {}, column {}, value {:?}: {}",
                    row_idx + 1,
                    column.name,
                    preview,
                    reason
                ));
            }
        }
    }

    let table = quote_import_table(&input.schema, &input.table_name, input.engine);
    let quoted_columns = import_columns
        .iter()
        .map(|col| quote_import_identifier(&col.name, input.engine))
        .collect::<Vec<_>>()
        .join(", ");

    let mut statements = Vec::with_capacity(data_rows.len());
    for row in data_rows {
        let values = import_columns
            .iter()
            .map(|col| {
                let csv_idx = input
                    .column_mapping
                    .get(&col.name)
                    .and_then(|v| *v)
                    .expect("mapped import column");
                let raw = row.get(csv_idx).map(|s| s.as_str()).unwrap_or("");
                let value =
                    if raw.is_empty() && matches!(input.null_mode, ImportNullMode::EmptyAsNull) {
                        None
                    } else {
                        Some(raw)
                    };
                format_import_value(value, &col.db_type, input.engine)
            })
            .collect::<Vec<_>>()
            .join(", ");
        statements.push(format!(
            "INSERT INTO {table} ({quoted_columns}) VALUES ({values})"
        ));
    }

    Ok(statements)
}

async fn drain_sqlserver_query(
    client: &mut tiberius::Client<tokio_util::compat::Compat<tokio::net::TcpStream>>,
    sql: &str,
) -> Result<(), String> {
    let mut stream = client
        .simple_query(sql)
        .await
        .map_err(|e| format!("SQLSERVER_QUERY_FAILED: {e}"))?;

    while stream
        .try_next()
        .await
        .map_err(|e| format!("SQLSERVER_ROW_STREAM_FAILED: {e}"))?
        .is_some()
    {}

    Ok(())
}

pub struct OpCleanup {
    op_id: Uuid,
    kind: OperationKind,
    connection_id: Uuid,
    sql_busy: SqlBusyRegistry,
    running_ops: Arc<dashmap::DashMap<Uuid, CancelHandle>>,
    cancel_requested: Arc<dashmap::DashMap<Uuid, ()>>,
    active_ops: Arc<dashmap::DashMap<Uuid, ()>>,
    op_to_conn: Arc<dashmap::DashMap<Uuid, Uuid>>,
    op_tasks: Arc<dashmap::DashMap<Uuid, tokio::task::JoinHandle<()>>>,
    is_stream_sql: bool,
}

impl Drop for OpCleanup {
    fn drop(&mut self) {
        self.running_ops.remove(&self.op_id);
        self.cancel_requested.remove(&self.op_id);
        self.active_ops.remove(&self.op_id);
        self.op_to_conn.remove(&self.op_id);
        self.op_tasks.remove(&self.op_id);

        // ✅ async release (Drop can't await)
        if self.kind == OperationKind::SqlQuery && self.is_stream_sql {
            self.sql_busy
                .release_if_owner(self.connection_id, self.op_id);
        }
    }
}

impl EngineConnection {
    #[allow(dead_code)]
    pub fn id(&self) -> Uuid {
        match self {
            EngineConnection::Postgres(c) => c.id,
            EngineConnection::MySql(c) => c.id,
            EngineConnection::SqlServer(c) => c.id,
            EngineConnection::Sqlite(c) => c.id,
            EngineConnection::D1(c) => c.id,
            EngineConnection::Oracle(c) => c.id,
            EngineConnection::Mongo(c) => c.id,
            EngineConnection::Redis(c) => c.id,
            EngineConnection::Snowflake(c) => c.id,
        }
    }

    pub fn label(&self) -> String {
        match self {
            EngineConnection::Postgres(c) => c.label.clone(),
            EngineConnection::MySql(c) => c.label.clone(),
            EngineConnection::SqlServer(c) => c.label.clone(),
            EngineConnection::Sqlite(c) => c.label.clone(),
            EngineConnection::D1(c) => c.label.clone(),
            EngineConnection::Oracle(c) => c.label.clone(),
            EngineConnection::Mongo(c) => c.label.clone(),
            EngineConnection::Redis(c) => c.label.clone(),
            EngineConnection::Snowflake(c) => c.label.clone(),
        }
    }

    pub fn engine_kind(&self) -> EngineKind {
        match self {
            EngineConnection::Postgres(_) => EngineKind::Postgres,
            EngineConnection::MySql(c) => c.engine,
            EngineConnection::SqlServer(_) => EngineKind::Sqlserver,
            EngineConnection::Sqlite(_) => EngineKind::Sqlite,
            EngineConnection::D1(_) => EngineKind::D1,
            EngineConnection::Oracle(_) => EngineKind::Oracle,
            EngineConnection::Mongo(_) => EngineKind::Mongo,
            EngineConnection::Redis(_) => EngineKind::Redis,
            EngineConnection::Snowflake(_) => EngineKind::Snowflake,
        }
    }

    #[allow(dead_code)]
    pub fn engine_name(&self) -> &'static str {
        match self {
            EngineConnection::Postgres(_) => "postgres",
            EngineConnection::MySql(c) => match c.engine {
                EngineKind::Mariadb => "mariadb",
                _ => "mysql",
            },
            EngineConnection::SqlServer(_) => "sqlserver",
            EngineConnection::Sqlite(_) => "sqlite",
            EngineConnection::D1(_) => "d1",
            EngineConnection::Oracle(_) => "oracle",
            EngineConnection::Mongo(_) => "mongo",
            EngineConnection::Redis(_) => "redis",
            EngineConnection::Snowflake(_) => "snowflake",
        }
    }

    pub async fn close(self) {
        match self {
            EngineConnection::Postgres(pg) => drop(pg.pool),
            EngineConnection::MySql(my) => {
                let _ = my.pool.clone().disconnect().await;
            }
            EngineConnection::SqlServer(_) => {}
            EngineConnection::Sqlite(_) => {}
            EngineConnection::D1(_) => {}
            EngineConnection::Oracle(_) => {}
            EngineConnection::Mongo(mongo) => drop(mongo.client),
            EngineConnection::Redis(r) => drop(r.pool),
            EngineConnection::Snowflake(_) => {}
        }
    }

    pub async fn execute_sql_transaction(&self, statements: Vec<String>) -> Result<(), String> {
        let statements = statements
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();

        if statements.is_empty() {
            return Ok(());
        }

        match self {
            EngineConnection::Postgres(pg) => {
                let mut client = pg
                    .pool
                    .get()
                    .await
                    .map_err(|e| format!("POSTGRES_TX_GET_CONN_FAILED: {e}"))?;
                let tx = client
                    .transaction()
                    .await
                    .map_err(|e| format!("POSTGRES_TX_BEGIN_FAILED: {e}"))?;

                for (idx, stmt) in statements.iter().enumerate() {
                    if let Err(e) = tx.batch_execute(stmt).await {
                        let _ = tx.rollback().await;
                        return Err(format!("SQL_TX_STATEMENT_{}_FAILED: {e}", idx + 1));
                    }
                }

                tx.commit()
                    .await
                    .map_err(|e| format!("POSTGRES_TX_COMMIT_FAILED: {e}"))
            }
            EngineConnection::MySql(my) => {
                reject_non_transactional_ddl("MYSQL_MARIADB", &statements)?;

                let mut conn = my
                    .pool
                    .get_conn()
                    .await
                    .map_err(|e| format!("MYSQL_TX_GET_CONN_FAILED: {e}"))?;

                conn.query_drop("START TRANSACTION")
                    .await
                    .map_err(|e| format!("MYSQL_TX_BEGIN_FAILED: {e}"))?;

                for (idx, stmt) in statements.iter().enumerate() {
                    if let Err(e) = conn.query_drop(stmt).await {
                        let _ = conn.query_drop("ROLLBACK").await;
                        return Err(format!("SQL_TX_STATEMENT_{}_FAILED: {e}", idx + 1));
                    }
                }

                conn.query_drop("COMMIT")
                    .await
                    .map_err(|e| format!("MYSQL_TX_COMMIT_FAILED: {e}"))
            }
            EngineConnection::Sqlite(sqlite) => {
                let shared = sqlite.conn.clone();
                tokio::task::spawn_blocking(move || -> Result<(), String> {
                    let conn = shared
                        .lock()
                        .map_err(|_| "SQLITE_CONN_MUTEX_POISONED".to_string())?;

                    conn.execute_batch("BEGIN")
                        .map_err(|e| format!("SQLITE_TX_BEGIN_FAILED: {e}"))?;

                    for (idx, stmt) in statements.iter().enumerate() {
                        if let Err(e) = conn.execute_batch(stmt) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(format!("SQL_TX_STATEMENT_{}_FAILED: {e}", idx + 1));
                        }
                    }

                    conn.execute_batch("COMMIT")
                        .map_err(|e| format!("SQLITE_TX_COMMIT_FAILED: {e}"))
                })
                .await
                .map_err(|e| format!("SQLITE_TX_JOIN_FAILED: {e}"))?
            }
            EngineConnection::D1(d1) => {
                let http = d1.http.clone();
                let api_base = d1.api_base.clone();
                let account_id = d1.account_id.clone();
                let database_id = d1.database_id.clone();
                let api_token = d1.api_token.clone();
                for (idx, stmt) in statements.iter().enumerate() {
                    d1::api::execute_d1_query(
                        &http,
                        &api_base,
                        &account_id,
                        &database_id,
                        &api_token,
                        stmt,
                    )
                    .await
                    .map_err(|e| format!("SQL_TX_STATEMENT_{}_FAILED: {e}", idx + 1))?;
                }
                Ok(())
            }
            EngineConnection::SqlServer(ss) => {
                let mut client = sqlserver::operation::make_client(
                    &ss.host,
                    ss.port,
                    &ss.database,
                    &ss.user,
                    &ss.password,
                    ss.encrypt,
                    ss.connect_timeout_ms,
                )
                .await?;

                drain_sqlserver_query(&mut client, "BEGIN TRANSACTION").await?;

                for (idx, stmt) in statements.iter().enumerate() {
                    if let Err(e) = drain_sqlserver_query(&mut client, stmt).await {
                        let _ = drain_sqlserver_query(&mut client, "ROLLBACK TRANSACTION").await;
                        return Err(format!("SQL_TX_STATEMENT_{}_FAILED: {e}", idx + 1));
                    }
                }

                drain_sqlserver_query(&mut client, "COMMIT TRANSACTION")
                    .await
                    .map_err(|e| format!("SQLSERVER_TX_COMMIT_FAILED: {e}"))
            }
            EngineConnection::Oracle(oracle) => {
                reject_non_transactional_ddl("ORACLE", &statements)?;

                let connect_string = oracle.connect_string.clone();
                let user = oracle.user.clone();
                let password = oracle.password.clone();

                tokio::task::spawn_blocking(move || -> Result<(), String> {
                    crate::engines::oracle::ensure_oracle_client_initialized()
                        .map_err(|e| format!("ORACLE_CLIENT_INIT_FAILED: {e}"))?;
                    let conn = ::oracle::Connection::connect(&user, &password, &connect_string)
                        .map_err(|e| format!("ORACLE_TX_CONNECT_FAILED: {e}"))?;

                    for (idx, stmt) in statements.iter().enumerate() {
                        if let Err(e) = conn.execute(stmt, &[]) {
                            let _ = conn.rollback();
                            return Err(format!("SQL_TX_STATEMENT_{}_FAILED: {e}", idx + 1));
                        }
                    }

                    conn.commit()
                        .map_err(|e| format!("ORACLE_TX_COMMIT_FAILED: {e}"))
                })
                .await
                .map_err(|e| format!("ORACLE_TX_JOIN_FAILED: {e}"))?
            }
            EngineConnection::Snowflake(sf) => {
                reject_non_transactional_ddl("SNOWFLAKE", &statements)?;

                let input = {
                    use crate::types::secret::{SecretRef, SecretRefKind};
                    crate::types::SnowflakeConnectInput {
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
                    }
                };

                let session = snowflake::create_session(&input, &sf.password).await?;
                for (idx, stmt) in statements.iter().enumerate() {
                    session
                        .query(stmt.as_str())
                        .await
                        .map_err(|e| format!("SQL_TX_STATEMENT_{}_FAILED: {e}", idx + 1))?;
                }
                Ok(())
            }
            EngineConnection::Mongo(_) | EngineConnection::Redis(_) => {
                Err("ENGINE_TRANSACTION_NOT_SUPPORTED".into())
            }
        }
    }

    pub async fn import_csv_transaction(
        &self,
        input: SqlImportCsvInput,
    ) -> Result<SqlImportCsvResult, String> {
        let statements = build_csv_import_statements(&input)?;
        let imported = statements.len();
        self.execute_sql_transaction(statements).await?;
        Ok(SqlImportCsvResult { imported })
    }

    pub fn spawn_sql_query(&self, ctx: OperationCtx, input: SqlQueryInput) -> Result<(), String> {
        let op_id = ctx.op_id;
        let op_tasks = Arc::clone(&ctx.op_tasks);

        let connection_id = ctx
            .op_to_conn
            .get(&op_id)
            .map(|r| *r.value())
            .ok_or("CONNECTION_NOT_FOUND_FOR_OP")?;

        let sql_busy = ctx.sql_busy.clone();
        let is_stream_sql = input.is_stream();

        match self {
            EngineConnection::Postgres(pg) => {
                let pool = pg.pool.clone();

                // ✅ spawn first, return handle
                let handle = tokio::spawn(async move {
                    let _cleanup = OpCleanup {
                        op_id,
                        kind: OperationKind::SqlQuery,
                        connection_id,
                        sql_busy,
                        is_stream_sql,
                        running_ops: Arc::clone(&ctx.running_ops),
                        cancel_requested: Arc::clone(&ctx.cancel_requested),
                        active_ops: Arc::clone(&ctx.active_ops),
                        op_to_conn: Arc::clone(&ctx.op_to_conn),
                        op_tasks: Arc::clone(&ctx.op_tasks),
                    };

                    crate::engines::postgres::operation::run_pg_sql_query(ctx, pool, input).await;
                });

                // ✅ insert handle using the cloned Arc (NOT ctx)
                op_tasks.insert(op_id, handle);

                Ok(())
            }

            EngineConnection::MySql(my) => {
                let pool = my.pool.clone();
                let default_timeout = my.default_statement_timeout_ms;

                let handle = tokio::spawn(async move {
                    let _cleanup = OpCleanup {
                        op_id,
                        connection_id,
                        kind: OperationKind::SqlQuery,
                        sql_busy,
                        is_stream_sql,
                        running_ops: Arc::clone(&ctx.running_ops),
                        cancel_requested: Arc::clone(&ctx.cancel_requested),
                        active_ops: Arc::clone(&ctx.active_ops),
                        op_to_conn: Arc::clone(&ctx.op_to_conn),
                        op_tasks: Arc::clone(&ctx.op_tasks),
                    };

                    crate::engines::mysql::operation::run_mysql_sql_query(
                        ctx,
                        pool,
                        input,
                        default_timeout,
                    )
                    .await;
                });

                op_tasks.insert(op_id, handle);
                Ok(())
            }
            EngineConnection::SqlServer(ss) => {
                let host = ss.host.clone();
                let port = ss.port;
                let database = ss.database.clone();
                let user = ss.user.clone();
                let password = ss.password.clone();
                let encrypt = ss.encrypt;
                let connect_timeout_ms = ss.connect_timeout_ms;
                let default_timeout = ss.default_statement_timeout_ms;

                let handle = tokio::spawn(async move {
                    let _cleanup = OpCleanup {
                        op_id,
                        connection_id,
                        kind: OperationKind::SqlQuery,
                        sql_busy,
                        is_stream_sql,
                        running_ops: Arc::clone(&ctx.running_ops),
                        cancel_requested: Arc::clone(&ctx.cancel_requested),
                        active_ops: Arc::clone(&ctx.active_ops),
                        op_to_conn: Arc::clone(&ctx.op_to_conn),
                        op_tasks: Arc::clone(&ctx.op_tasks),
                    };

                    crate::engines::sqlserver::operation::run_sqlserver_sql_query(
                        ctx,
                        host,
                        port,
                        database,
                        user,
                        password,
                        encrypt,
                        connect_timeout_ms,
                        input,
                        default_timeout,
                    )
                    .await;
                });

                op_tasks.insert(op_id, handle);
                Ok(())
            }
            EngineConnection::Sqlite(sqlite) => {
                let shared = sqlite.conn.clone();
                let default_timeout = sqlite.default_statement_timeout_ms;

                let handle = tokio::spawn(async move {
                    let _cleanup = OpCleanup {
                        op_id,
                        connection_id,
                        kind: OperationKind::SqlQuery,
                        sql_busy,
                        is_stream_sql,
                        running_ops: Arc::clone(&ctx.running_ops),
                        cancel_requested: Arc::clone(&ctx.cancel_requested),
                        active_ops: Arc::clone(&ctx.active_ops),
                        op_to_conn: Arc::clone(&ctx.op_to_conn),
                        op_tasks: Arc::clone(&ctx.op_tasks),
                    };

                    crate::engines::sqlite::operation::run_sqlite_sql_query(
                        ctx,
                        shared,
                        input,
                        default_timeout,
                    )
                    .await;
                });

                op_tasks.insert(op_id, handle);
                Ok(())
            }
            EngineConnection::D1(d1) => {
                let d1 = d1.clone();

                let handle = tokio::spawn(async move {
                    let _cleanup = OpCleanup {
                        op_id,
                        connection_id,
                        kind: OperationKind::SqlQuery,
                        sql_busy,
                        is_stream_sql,
                        running_ops: Arc::clone(&ctx.running_ops),
                        cancel_requested: Arc::clone(&ctx.cancel_requested),
                        active_ops: Arc::clone(&ctx.active_ops),
                        op_to_conn: Arc::clone(&ctx.op_to_conn),
                        op_tasks: Arc::clone(&ctx.op_tasks),
                    };

                    crate::engines::d1::operation::run_d1_sql_query(ctx, d1, input).await;
                });

                op_tasks.insert(op_id, handle);
                Ok(())
            }
            EngineConnection::Oracle(oracle) => {
                let connect_string = oracle.connect_string.clone();
                let user = oracle.user.clone();
                let password = oracle.password.clone();
                let default_timeout = oracle.default_statement_timeout_ms;

                let handle = tokio::spawn(async move {
                    let _cleanup = OpCleanup {
                        op_id,
                        connection_id,
                        kind: OperationKind::SqlQuery,
                        sql_busy,
                        is_stream_sql,
                        running_ops: Arc::clone(&ctx.running_ops),
                        cancel_requested: Arc::clone(&ctx.cancel_requested),
                        active_ops: Arc::clone(&ctx.active_ops),
                        op_to_conn: Arc::clone(&ctx.op_to_conn),
                        op_tasks: Arc::clone(&ctx.op_tasks),
                    };

                    crate::engines::oracle::operation::run_oracle_sql_query(
                        ctx,
                        connect_string,
                        user,
                        password,
                        input,
                        default_timeout,
                    )
                    .await;
                });

                op_tasks.insert(op_id, handle);
                Ok(())
            }

            EngineConnection::Snowflake(sf) => {
                let conn = sf.clone();
                let default_timeout = sf.default_statement_timeout_ms;

                let handle = tokio::spawn(async move {
                    let _cleanup = OpCleanup {
                        op_id,
                        connection_id,
                        kind: OperationKind::SqlQuery,
                        sql_busy,
                        is_stream_sql,
                        running_ops: Arc::clone(&ctx.running_ops),
                        cancel_requested: Arc::clone(&ctx.cancel_requested),
                        active_ops: Arc::clone(&ctx.active_ops),
                        op_to_conn: Arc::clone(&ctx.op_to_conn),
                        op_tasks: Arc::clone(&ctx.op_tasks),
                    };

                    crate::engines::snowflake::operation::run_snowflake_sql_query(
                        ctx,
                        conn,
                        input,
                        default_timeout,
                    )
                    .await;
                });

                op_tasks.insert(op_id, handle);
                Ok(())
            }

            EngineConnection::Mongo(_) => Err("ENGINE_OPERATION_NOT_SUPPORTED".into()),
            EngineConnection::Redis(_) => Err("ENGINE_OPERATION_NOT_SUPPORTED".into()),
        }
    }

    pub fn spawn_redis_command(
        &self,
        ctx: OperationCtx,
        input: RedisCommandInput,
    ) -> Result<(), String> {
        match self {
            EngineConnection::Redis(r) => {
                let pool = r.pool.clone();
                let default_timeout_ms = r.default_command_timeout_ms;

                let op_id = ctx.op_id;
                let conn_id = self.id();
                let sql_busy = ctx.sql_busy.clone();

                let op_tasks = Arc::clone(&ctx.op_tasks);
                let op_to_conn = Arc::clone(&ctx.op_to_conn);
                let active_ops = Arc::clone(&ctx.active_ops);

                // register mapping before spawn
                op_to_conn.insert(op_id, conn_id);
                active_ops.insert(op_id, ());

                let handle = tokio::spawn(async move {
                    let _cleanup = OpCleanup {
                        op_id,
                        kind: OperationKind::RedisCommand,
                        connection_id: conn_id,
                        sql_busy,
                        is_stream_sql: false,
                        running_ops: Arc::clone(&ctx.running_ops),
                        cancel_requested: Arc::clone(&ctx.cancel_requested),
                        active_ops: Arc::clone(&ctx.active_ops),
                        op_to_conn: Arc::clone(&ctx.op_to_conn),
                        op_tasks: Arc::clone(&ctx.op_tasks),
                    };

                    crate::engines::redis::operation::run_redis_command(
                        ctx,
                        pool,
                        default_timeout_ms,
                        input,
                    )
                    .await;
                });

                op_tasks.insert(op_id, handle);
                Ok(())
            }

            _ => Err("ENGINE_OPERATION_NOT_SUPPORTED".into()),
        }
    }
}
