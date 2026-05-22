pub fn normalize_clickhouse_statement(sql: &str) -> String {
    sql.trim()
        .trim_end_matches(|c: char| c == ';' || c.is_whitespace())
        .to_string()
}

pub fn split_clickhouse_statements(sql: &str) -> Vec<String> {
    sql.split(';')
        .map(normalize_clickhouse_statement)
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn looks_like_query(sql: &str) -> bool {
    let s = sql.trim_start();
    if s.is_empty() {
        return false;
    }
    let up = s.chars().take(24).collect::<String>().to_uppercase();
    up.starts_with("SELECT")
        || up.starts_with("WITH")
        || up.starts_with("SHOW")
        || up.starts_with("DESCRIBE")
        || up.starts_with("DESC")
        || up.starts_with("EXPLAIN")
}
