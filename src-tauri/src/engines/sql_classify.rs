#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SqlStatementKind {
    Ddl,
    Dml,
    TransactionControl,
    Other,
}

fn first_sql_token(sql: &str) -> String {
    sql.split_whitespace()
        .next()
        .unwrap_or("")
        .trim_matches(|c: char| !c.is_ascii_alphabetic())
        .to_ascii_uppercase()
}

/// ClickHouse row mutations use `ALTER TABLE ... UPDATE` / `DELETE WHERE`, not standard DML.
fn is_clickhouse_data_mutation(sql: &str) -> bool {
    let normalized = sql.trim().trim_end_matches(';').to_ascii_uppercase();
    if !normalized.starts_with("ALTER TABLE") {
        return false;
    }
    normalized.contains(" UPDATE ") || normalized.contains(" DELETE WHERE")
}

#[cfg(test)]
fn classify_sql_statement(sql: &str) -> SqlStatementKind {
    classify_sql_statement_for_engine(sql, None)
}

pub(crate) fn classify_sql_statement_for_engine(
    sql: &str,
    engine: Option<&str>,
) -> SqlStatementKind {
    let token = first_sql_token(sql);
    if engine == Some("CLICKHOUSE") && token == "ALTER" && is_clickhouse_data_mutation(sql) {
        return SqlStatementKind::Dml;
    }

    match token.as_str() {
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "RENAME" | "COMMENT" => SqlStatementKind::Ddl,
        "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "REPLACE" => SqlStatementKind::Dml,
        "BEGIN" | "START" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" => {
            SqlStatementKind::TransactionControl
        }
        _ => SqlStatementKind::Other,
    }
}

pub(crate) fn reject_non_transactional_ddl(
    engine: &str,
    statements: &[String],
) -> Result<(), String> {
    if statements
        .iter()
        .any(|stmt| classify_sql_statement_for_engine(stmt, Some(engine)) == SqlStatementKind::Ddl)
    {
        return Err(format!(
            "{engine}_DDL_TRANSACTION_UNSUPPORTED: {engine} implicitly commits DDL, so schema edits cannot be safely rolled back in this batch. Run schema and data changes separately."
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        classify_sql_statement, classify_sql_statement_for_engine, reject_non_transactional_ddl,
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
    fn clickhouse_alter_update_is_dml_not_ddl() {
        assert_eq!(
            classify_sql_statement_for_engine(
                "ALTER TABLE `demo_db`.`order_items` UPDATE `unit_price` = 4991 WHERE `id` = 1",
                Some("CLICKHOUSE")
            ),
            SqlStatementKind::Dml
        );
        assert!(reject_non_transactional_ddl(
            "CLICKHOUSE",
            &[
                "ALTER TABLE `demo_db`.`order_items` UPDATE `unit_price` = 4991 WHERE `id` = 1"
                    .to_string()
            ]
        )
        .is_ok());
    }

    #[test]
    fn clickhouse_alter_add_column_stays_ddl() {
        assert_eq!(
            classify_sql_statement_for_engine(
                "ALTER TABLE demo_db.order_items ADD COLUMN note String",
                Some("CLICKHOUSE")
            ),
            SqlStatementKind::Ddl
        );
    }
}
