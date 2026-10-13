//! Read-only check for SQL the assistant suggests (plan ai-agent R7): decides whether
//! the preview may offer Run. This module is the syntax half: "read-only" only for a
//! single plain query it fully understands (`SELECT`/`WITH`, `EXPLAIN` without
//! `ANALYZE`, MySQL `SHOW` and `DESCRIBE`) whose function calls are spelled like pure
//! built-ins. A spelling is not an identity (a user overload, view or policy can run
//! other code), so the command also asks the connection's catalog executor
//! (`only_builtin_code`) before answering "read-only". Anything else, including syntax
//! it cannot tokenize with confidence, is "unknown" and the user inserts the SQL into
//! the editor instead, where the normal safety policy applies.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlSafety {
    ReadOnly,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dialect {
    Postgres,
    MySql,
    Sqlite,
}

impl Dialect {
    fn from_engine(engine: &str) -> Option<Self> {
        match engine {
            "postgres" => Some(Self::Postgres),
            "mysql" | "mariadb" => Some(Self::MySql),
            "sqlite" => Some(Self::Sqlite),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    /// Unquoted word, upper-cased.
    Word(String),
    /// Quoted identifier (`"x"`, `` `x` ``, `[x]`).
    Quoted,
    /// String or number literal.
    Literal,
    /// Any other character or operator.
    Punct(String),
}

/// Splits `sql` into tokens, dropping comments. `None` when the text uses syntax this
/// check does not model (dollar quotes, executable comments, unterminated quotes).
fn tokenize(sql: &str, dialect: Dialect) -> Option<Vec<Token>> {
    let chars: Vec<char> = sql.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    let n = chars.len();
    while i < n {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c.is_ascii_whitespace() {
            i += 1;
        } else if c == '-' && next == Some('-') || c == '#' && dialect == Dialect::MySql {
            // In MySQL `--` starts a comment only before whitespace; `1--1` is arithmetic.
            if c == '-'
                && dialect == Dialect::MySql
                && matches!(chars.get(i + 2), Some(c) if !(c.is_ascii_whitespace() || c.is_ascii_control()))
            {
                return None;
            }
            // A line comment ends at LF or CR (PostgreSQL ends it at either).
            while i < n && chars[i] != '\n' && chars[i] != '\r' {
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            // MySQL runs `/*! ... */` and `/*+ ... */` content, MariaDB `/*M! ... */`.
            let executable = match chars.get(i + 2) {
                Some('!') | Some('+') => true,
                Some('M') | Some('m') => chars.get(i + 3) == Some(&'!'),
                _ => false,
            };
            if executable {
                return None;
            }
            let mut depth = 0;
            loop {
                if i + 1 >= n {
                    return None;
                }
                if chars[i] == '/' && chars[i + 1] == '*' {
                    depth += 1;
                    i += 2;
                } else if chars[i] == '*' && chars[i + 1] == '/' {
                    depth -= 1;
                    i += 2;
                    // Only Postgres nests block comments.
                    if depth == 0 || dialect != Dialect::Postgres {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
        } else if c == '$' && dialect == Dialect::Postgres {
            // Dollar quoting or positional parameters: not modelled.
            return None;
        } else if c == '\'' || (c == '"' && dialect == Dialect::MySql) {
            // Whether a backslash escapes depends on server settings
            // (`standard_conforming_strings`, `NO_BACKSLASH_ESCAPES`), so strings with a
            // backslash are not modelled; Postgres E'' strings always take escapes.
            let e_string = dialect == Dialect::Postgres
                && i >= 1
                && matches!(chars[i - 1], 'E' | 'e')
                && !(i >= 2 && (chars[i - 2].is_alphanumeric() || chars[i - 2] == '_'));
            if e_string {
                tokens.pop();
            }
            let backslash = if e_string {
                Backslash::Escapes
            } else {
                Backslash::Unsupported
            };
            i = skip_quoted(&chars, i, c, backslash)?;
            tokens.push(Token::Literal);
        } else if c == '"' || c == '`' || (c == '[' && dialect == Dialect::Sqlite) {
            let close = if c == '[' { ']' } else { c };
            i = skip_quoted(&chars, i, close, Backslash::Literal)?;
            tokens.push(Token::Quoted);
        } else if !c.is_ascii() {
            // Outside strings and comments: MySQL takes most non-ASCII characters as
            // identifier characters (`lower<U+00A0>(` is a different function), and
            // look-alike letters are not worth modelling.
            return None;
        } else if c.is_ascii_alphanumeric() || c == '_' || (c == '$' && dialect == Dialect::MySql) {
            // One run of identifier characters: a number only if it is entirely one,
            // otherwise a word (MySQL identifiers may start with a digit or `$`).
            let start = i;
            while i < n && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '$')
            {
                i += 1;
            }
            let run: String = chars[start..i].iter().collect();
            if is_number(&run) {
                tokens.push(Token::Literal);
            } else {
                tokens.push(Token::Word(run.to_ascii_uppercase()));
            }
        } else {
            let pair: String = chars[i..(i + 2).min(n)].iter().collect();
            if pair == "::" || pair == ":=" {
                tokens.push(Token::Punct(pair));
                i += 2;
            } else {
                tokens.push(Token::Punct(c.to_string()));
                i += 1;
            }
        }
    }
    Some(tokens)
}

/// Digits, digits with an exponent (`1e5`), or a hex/binary literal (`0x1F`, `0b101`).
fn is_number(run: &str) -> bool {
    let digits = |s: &str, radix: u32| !s.is_empty() && s.chars().all(|c| c.is_digit(radix));
    if let Some(hex) = run.strip_prefix("0x").or_else(|| run.strip_prefix("0X")) {
        return digits(hex, 16);
    }
    if let Some(bin) = run.strip_prefix("0b").or_else(|| run.strip_prefix("0B")) {
        return digits(bin, 2);
    }
    match run.split_once(['e', 'E']) {
        Some((mantissa, exponent)) => digits(mantissa, 10) && digits(exponent, 10),
        None => digits(run, 10),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Backslash {
    Escapes,
    Literal,
    /// Meaning depends on the server: give up.
    Unsupported,
}

/// Index after the closing quote of the quoted text starting at `start`.
fn skip_quoted(chars: &[char], start: usize, close: char, backslash: Backslash) -> Option<usize> {
    let mut i = start + 1;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && backslash == Backslash::Unsupported {
            return None;
        }
        if c == '\\' && backslash == Backslash::Escapes {
            i += 2;
        } else if c == close {
            // A doubled quote is an escaped quote.
            if chars.get(i + 1) == Some(&close) && close != ']' {
                i += 2;
            } else {
                return Some(i + 1);
            }
        } else {
            i += 1;
        }
    }
    None
}

/// Words that write, lock, change session state or run something else. The statement
/// itself must start with a query keyword, so this targets what can appear inside one
/// (data-modifying CTEs, `INTO`, locking clauses, `EXPLAIN ANALYZE`).
const DENIED_WORDS: &[&str] = &[
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "REPLACE",
    "UPSERT",
    "CREATE",
    "ALTER",
    "DROP",
    "TRUNCATE",
    "RENAME",
    "GRANT",
    "REVOKE",
    "INTO",
    "OUTFILE",
    "DUMPFILE",
    "LOCK",
    "UNLOCK",
    "FOR",
    "CALL",
    "EXEC",
    "EXECUTE",
    "DO",
    "SET",
    "COPY",
    "ATTACH",
    "DETACH",
    "PRAGMA",
    "VACUUM",
    "ANALYZE",
    "ANALYSE",
    "REINDEX",
    "REFRESH",
    "LISTEN",
    "NOTIFY",
    "LOAD",
    "HANDLER",
    "PREPARE",
    "DEALLOCATE",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT",
    "DECLARE",
    "KILL",
    "SHUTDOWN",
    "FLUSH",
];

/// MySQL/MariaDB keywords that can precede `(` without being a function call. Only
/// words reserved on both servers: an unreserved word can name a stored function that
/// an unqualified call reaches. The live test `agent_mysql_live_identity` checks that
/// neither server accepts any of them as an unquoted function name.
pub(crate) const MYSQL_PAREN_KEYWORDS: &[&str] = &[
    "IN", "EXISTS", "AS", "VALUES", "FROM", "JOIN", "ON", "AND", "OR", "NOT", "WHEN", "THEN",
    "ELSE", "ALL", "GROUP", "USING", "UNION", "SELECT", "WHERE", "BY", "HAVING", "IS", "LIKE",
    "BETWEEN", "DISTINCT", "LIMIT", "CASE", "WITH", "OVER",
];

/// Keywords that can precede `(` without being a function call (PostgreSQL, SQLite).
const PAREN_KEYWORDS: &[&str] = &[
    "IN",
    "EXISTS",
    "AS",
    "OVER",
    "VALUES",
    "FROM",
    "JOIN",
    "ON",
    "AND",
    "OR",
    "NOT",
    "WHEN",
    "THEN",
    "ELSE",
    "ANY",
    "ALL",
    "SOME",
    "FILTER",
    "GROUP",
    "USING",
    "LATERAL",
    "UNION",
    "INTERSECT",
    "EXCEPT",
    "SELECT",
    "WHERE",
    "BY",
    "HAVING",
    "IS",
    "LIKE",
    "ILIKE",
    "BETWEEN",
    "DISTINCT",
    "LIMIT",
    "OFFSET",
    "ARRAY",
    "ROW",
    "CASE",
    "WITHIN",
    "ROWS",
    "RANGE",
    "WITH",
    "EXPLAIN",
    "RETURN",
];

/// Native MySQL and MariaDB functions (present in both). Only native names are safe
/// there: an unqualified call of any other name resolves to a stored function in the
/// default database. The live test `agent_mysql_live_identity` checks that both
/// servers treat each name as native.
pub(crate) const MYSQL_FUNCTIONS: &[&str] = &[
    // aggregates and windows
    "COUNT",
    "SUM",
    "AVG",
    "MIN",
    "MAX",
    "GROUP_CONCAT",
    "BIT_AND",
    "BIT_OR",
    "STDDEV",
    "STDDEV_POP",
    "STDDEV_SAMP",
    "VARIANCE",
    "VAR_POP",
    "VAR_SAMP",
    "ROW_NUMBER",
    "RANK",
    "DENSE_RANK",
    "PERCENT_RANK",
    "CUME_DIST",
    "NTILE",
    "LAG",
    "LEAD",
    "FIRST_VALUE",
    "LAST_VALUE",
    "NTH_VALUE",
    // conditionals and casts
    "COALESCE",
    "NULLIF",
    "GREATEST",
    "LEAST",
    "IFNULL",
    "IF",
    "CAST",
    "CONVERT",
    // strings
    "LOWER",
    "UPPER",
    "LENGTH",
    "CHAR_LENGTH",
    "CHARACTER_LENGTH",
    "OCTET_LENGTH",
    "SUBSTRING",
    "SUBSTR",
    "TRIM",
    "LTRIM",
    "RTRIM",
    "REPLACE",
    "CONCAT",
    "CONCAT_WS",
    "LEFT",
    "RIGHT",
    "LPAD",
    "RPAD",
    "POSITION",
    "INSTR",
    "LOCATE",
    "REVERSE",
    "REPEAT",
    "ASCII",
    "CHAR",
    "FORMAT",
    "MD5",
    "HEX",
    "UNHEX",
    "REGEXP_REPLACE",
    "REGEXP_SUBSTR",
    "QUOTE",
    // numbers
    "ABS",
    "CEIL",
    "CEILING",
    "FLOOR",
    "ROUND",
    "TRUNCATE",
    "MOD",
    "POWER",
    "POW",
    "SQRT",
    "EXP",
    "LN",
    "LOG",
    "LOG10",
    "SIGN",
    // dates and times
    "EXTRACT",
    "NOW",
    "CURRENT_DATE",
    "CURRENT_TIME",
    "CURRENT_TIMESTAMP",
    "LOCALTIME",
    "LOCALTIMESTAMP",
    "DATE",
    "TIME",
    "DATE_FORMAT",
    "DATE_ADD",
    "DATE_SUB",
    "DATEDIFF",
    "TIMESTAMPDIFF",
    "TIMESTAMPADD",
    "YEAR",
    "MONTH",
    "DAY",
    "HOUR",
    "MINUTE",
    "SECOND",
    "DAYOFWEEK",
    "DAYOFMONTH",
    "DAYOFYEAR",
    "WEEK",
    "QUARTER",
    "LAST_DAY",
    "STR_TO_DATE",
    "FROM_UNIXTIME",
    "UNIX_TIMESTAMP",
    "CURDATE",
    "CURTIME",
    "INTERVAL",
    // JSON
    "JSON_EXTRACT",
    "JSON_UNQUOTE",
    "JSON_OBJECT",
    "JSON_ARRAY",
    "JSON_LENGTH",
    "JSON_KEYS",
    "JSON_CONTAINS",
];

/// Pure built-in functions for PostgreSQL and SQLite. Anything else (user functions,
/// admin, sleep, lock, file or network functions, sequence functions) makes the query
/// "unknown". On PostgreSQL a spelling is not an identity: the connection check rules
/// out user overloads. SQLite has no user-defined SQL functions here.
const ALLOWED_FUNCTIONS: &[&str] = &[
    // aggregates and windows
    "COUNT",
    "SUM",
    "AVG",
    "MIN",
    "MAX",
    "STRING_AGG",
    "GROUP_CONCAT",
    "ARRAY_AGG",
    "JSON_AGG",
    "JSONB_AGG",
    "BOOL_AND",
    "BOOL_OR",
    "EVERY",
    "BIT_AND",
    "BIT_OR",
    "STDDEV",
    "STDDEV_POP",
    "STDDEV_SAMP",
    "VARIANCE",
    "VAR_POP",
    "VAR_SAMP",
    "PERCENTILE_CONT",
    "PERCENTILE_DISC",
    "MODE",
    "CORR",
    "ROW_NUMBER",
    "RANK",
    "DENSE_RANK",
    "PERCENT_RANK",
    "CUME_DIST",
    "NTILE",
    "LAG",
    "LEAD",
    "FIRST_VALUE",
    "LAST_VALUE",
    "NTH_VALUE",
    "TOTAL",
    // conditionals and casts
    "COALESCE",
    "NULLIF",
    "GREATEST",
    "LEAST",
    "IFNULL",
    "IF",
    "IIF",
    "CAST",
    "CONVERT",
    "TYPEOF",
    // strings
    "LOWER",
    "UPPER",
    "LENGTH",
    "CHAR_LENGTH",
    "CHARACTER_LENGTH",
    "OCTET_LENGTH",
    "SUBSTRING",
    "SUBSTR",
    "TRIM",
    "LTRIM",
    "RTRIM",
    "BTRIM",
    "REPLACE",
    "CONCAT",
    "CONCAT_WS",
    "LEFT",
    "RIGHT",
    "LPAD",
    "RPAD",
    "POSITION",
    "STRPOS",
    "INSTR",
    "LOCATE",
    "REVERSE",
    "REPEAT",
    "SPLIT_PART",
    "INITCAP",
    "ASCII",
    "CHR",
    "CHAR",
    "FORMAT",
    "MD5",
    "HEX",
    "UNHEX",
    "REGEXP_REPLACE",
    "REGEXP_LIKE",
    "REGEXP_SUBSTR",
    "REGEXP_MATCHES",
    "PRINTF",
    "QUOTE",
    // numbers
    "ABS",
    "CEIL",
    "CEILING",
    "FLOOR",
    "ROUND",
    "TRUNC",
    "TRUNCATE",
    "MOD",
    "POWER",
    "POW",
    "SQRT",
    "EXP",
    "LN",
    "LOG",
    "LOG10",
    "SIGN",
    "DIV",
    // dates and times
    "EXTRACT",
    "DATE_PART",
    "DATE_TRUNC",
    "NOW",
    "CURRENT_DATE",
    "CURRENT_TIME",
    "CURRENT_TIMESTAMP",
    "LOCALTIME",
    "LOCALTIMESTAMP",
    "DATE",
    "TIME",
    "DATETIME",
    "JULIANDAY",
    "STRFTIME",
    "UNIXEPOCH",
    "TO_CHAR",
    "TO_DATE",
    "TO_TIMESTAMP",
    "TO_NUMBER",
    "AGE",
    "MAKE_DATE",
    "MAKE_INTERVAL",
    "DATE_FORMAT",
    "DATE_ADD",
    "DATE_SUB",
    "DATEDIFF",
    "TIMESTAMPDIFF",
    "TIMESTAMPADD",
    "YEAR",
    "MONTH",
    "DAY",
    "HOUR",
    "MINUTE",
    "SECOND",
    "DAYOFWEEK",
    "DAYOFMONTH",
    "DAYOFYEAR",
    "WEEK",
    "QUARTER",
    "LAST_DAY",
    "STR_TO_DATE",
    "FROM_UNIXTIME",
    "UNIX_TIMESTAMP",
    "CURDATE",
    "CURTIME",
    "INTERVAL",
    // JSON and arrays
    "JSON_EXTRACT",
    "JSON_UNQUOTE",
    "JSON_OBJECT",
    "JSON_ARRAY",
    "JSON_BUILD_OBJECT",
    "JSONB_BUILD_OBJECT",
    "JSON_BUILD_ARRAY",
    "JSONB_BUILD_ARRAY",
    "JSON_ARRAY_LENGTH",
    "JSONB_ARRAY_LENGTH",
    "TO_JSON",
    "TO_JSONB",
    "ROW_TO_JSON",
    "JSON_EXTRACT_PATH_TEXT",
    "JSONB_EXTRACT_PATH_TEXT",
    "JSON_EACH",
    "JSONB_EACH",
    "JSON_TYPEOF",
    "JSONB_TYPEOF",
    "JSON_LENGTH",
    "JSON_KEYS",
    "JSON_CONTAINS",
    "ARRAY_LENGTH",
    "CARDINALITY",
    "UNNEST",
    "GENERATE_SERIES",
];

fn word(token: Option<&Token>) -> Option<&str> {
    match token {
        Some(Token::Word(w)) => Some(w.as_str()),
        _ => None,
    }
}

/// Whether `sql` (for `engine`: "postgres", "mysql", "mariadb", "sqlite") is a single
/// read-only query. Other engines are always "unknown".
pub fn classify(sql: &str, engine: &str) -> SqlSafety {
    let Some(dialect) = Dialect::from_engine(engine) else {
        return SqlSafety::Unknown;
    };
    let Some(mut tokens) = tokenize(sql, dialect) else {
        return SqlSafety::Unknown;
    };
    // One statement only: a trailing `;` is fine.
    while matches!(tokens.last(), Some(Token::Punct(p)) if p == ";") {
        tokens.pop();
    }
    if tokens.is_empty()
        || tokens
            .iter()
            .any(|t| matches!(t, Token::Punct(p) if p == ";"))
    {
        return SqlSafety::Unknown;
    }
    let first = word(tokens.first()).unwrap_or("");
    let leading_ok = match first {
        "SELECT" | "WITH" | "EXPLAIN" => true,
        "SHOW" | "DESCRIBE" | "DESC" => dialect == Dialect::MySql,
        _ => false,
    };
    if !leading_ok {
        return SqlSafety::Unknown;
    }
    for (index, token) in tokens.iter().enumerate() {
        match token {
            Token::Punct(p) if p == ":=" || p == "@" && dialect != Dialect::MySql => {
                return SqlSafety::Unknown;
            }
            Token::Word(w) => {
                let calls = matches!(tokens.get(index + 1), Some(Token::Punct(p)) if p == "(");
                if !calls {
                    if DENIED_WORDS.contains(&w.as_str()) {
                        return SqlSafety::Unknown;
                    }
                    continue;
                }
                let previous = index.checked_sub(1).and_then(|i| tokens.get(i));
                // Qualified names (`schema.fn(`) are user functions, whatever the name.
                if matches!(previous, Some(Token::Punct(p)) if p == ".") {
                    return SqlSafety::Unknown;
                }
                let keywords = match dialect {
                    Dialect::MySql => MYSQL_PAREN_KEYWORDS,
                    Dialect::Postgres | Dialect::Sqlite => PAREN_KEYWORDS,
                };
                if keywords.contains(&w.as_str()) {
                    continue;
                }
                // `x AS t(a, b)`, `CAST(x AS numeric(10, 2))`, `x::varchar(10)`.
                let type_or_alias = match previous {
                    Some(Token::Word(p)) => p == "AS",
                    Some(Token::Punct(p)) => p == "::",
                    _ => false,
                };
                if type_or_alias {
                    continue;
                }
                let allowed = match dialect {
                    Dialect::MySql => MYSQL_FUNCTIONS,
                    Dialect::Postgres | Dialect::Sqlite => ALLOWED_FUNCTIONS,
                };
                if !allowed.contains(&w.as_str()) {
                    return SqlSafety::Unknown;
                }
            }
            // Only plain words are checked as function names: anything else directly
            // before `(` (a quoted name, or a "string" that ANSI_QUOTES makes a name) is
            // a call this check cannot vouch for.
            Token::Quoted | Token::Literal => {
                if matches!(tokens.get(index + 1), Some(Token::Punct(p)) if p == "(") {
                    return SqlSafety::Unknown;
                }
            }
            _ => {}
        }
    }
    SqlSafety::ReadOnly
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_only(sql: &str, engine: &str) -> bool {
        classify(sql, engine) == SqlSafety::ReadOnly
    }

    #[test]
    fn ordinary_queries_are_read_only() {
        for (sql, engine) in [
            ("SELECT * FROM orders WHERE id = 1;", "postgres"),
            (
                "SELECT customer_id, date_trunc('month', created_at) AS m, count(*) \
                 FROM public.orders o JOIN customers c ON c.id = o.customer_id \
                 WHERE o.total > 10 AND o.note LIKE '%x%' GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10",
                "postgres",
            ),
            (
                "WITH recent AS (SELECT * FROM orders WHERE created_at > now() - interval '7 days') \
                 SELECT count(*) FILTER (WHERE total > 0) FROM recent",
                "postgres",
            ),
            ("SELECT CAST(total AS numeric(10, 2)), note::varchar(20) FROM orders", "postgres"),
            ("SELECT x FROM t WHERE id IN (SELECT id FROM u) -- for update", "postgres"),
            ("SELECT 'DELETE FROM t; DROP TABLE x' AS s", "postgres"),
            ("SELECT `name`, DATE_FORMAT(created_at, '%Y-%m') FROM `orders`", "mysql"),
            ("SELECT 'it''s; DROP' FROM t", "mysql"),
            ("SELECT start, close, release FROM prices", "postgres"),
            ("SELECT 1 -- note\n", "mysql"),
            ("SHOW TABLES", "mariadb"),
            ("SELECT name FROM sqlite_master WHERE type = 'table'", "sqlite"),
            ("SELECT strftime('%Y', created_at), [order id] FROM \"orders\"", "sqlite"),
            ("EXPLAIN SELECT * FROM orders", "postgres"),
            (
                "SELECT row_number() OVER (PARTITION BY a ORDER BY b) FROM t",
                "postgres",
            ),
            ("SELECT replace(name, 'a', 'b') FROM t", "mysql"),
            ("SELECT date_trunc('month', created_at) FROM t", "postgres"),
            ("SELECT 1, 1.5, 1e5, 0x1F, 2.5E3 FROM t WHERE id IN (1, 2)", "mysql"),
            ("SELECT id FROM 1table WHERE name = 'café'", "mariadb"),
        ] {
            assert!(read_only(sql, engine), "{engine}: {sql}");
        }
    }

    #[test]
    fn side_effects_and_unmodelled_syntax_are_unknown() {
        for (sql, engine) in [
            // Codex Phase 2 review reproductions.
            ("PRAGMA user_version = 99", "sqlite"),
            ("SELECT 1 INTO OUTFILE \"/tmp/agent-output\"", "mysql"),
            ("SELECT pg_advisory_lock(1)", "postgres"),
            // writes, including inside CTEs
            (
                "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
                "postgres",
            ),
            ("UPDATE t SET a = 1", "postgres"),
            ("REPLACE INTO t VALUES (1)", "mysql"),
            ("SELECT * INTO new_table FROM t", "postgres"),
            ("SELECT * FROM t FOR UPDATE", "postgres"),
            ("SELECT * FROM t LOCK IN SHARE MODE", "mysql"),
            ("SELECT 1; DELETE FROM t", "postgres"),
            ("SELECT 1; SELECT 2", "sqlite"),
            ("EXPLAIN ANALYZE DELETE FROM t", "postgres"),
            ("EXPLAIN (ANALYZE) SELECT 1", "postgres"),
            // functions with effects or outside reach
            ("SELECT pg_sleep(10)", "postgres"),
            ("SELECT nextval('s')", "postgres"),
            ("SELECT set_config('a', 'b', false)", "postgres"),
            ("SELECT pg_read_file('/etc/passwd')", "postgres"),
            ("SELECT lo_import('/etc/passwd')", "postgres"),
            ("SELECT * FROM dblink('x', 'y')", "postgres"),
            ("SELECT SLEEP(5)", "mysql"),
            // Codex round 6: not native in MySQL, so a stored function could answer.
            ("SELECT date_trunc('month', created_at) FROM t", "mysql"),
            ("SELECT to_char(created_at, 'YYYY') FROM t", "mariadb"),
            ("SELECT strftime('%Y', created_at) FROM t", "mysql"),
            // Codex round 7: keyword-named functions, qualified or (MySQL) unreserved.
            ("SELECT agent_t.filter(1)", "mysql"),
            ("SELECT agent_t.filter(1)", "postgres"),
            ("SELECT public.exists(1)", "sqlite"),
            ("SELECT filter(1)", "mariadb"),
            ("SELECT within(1), rows(1)", "mysql"),
            // Codex round 8: names the tokenizer must not take for literals.
            ("SELECT 1agent(1)", "mysql"),
            ("SELECT agent_t.1agent(1)", "mariadb"),
            ("SELECT \"agent_lock\"(1)", "mysql"),
            ("SELECT agent_t.\"agent_lock\"(1)", "mariadb"),
            ("SELECT $lower(1)", "mysql"),
            ("SELECT lower\u{a0}(1)", "mysql"),
            ("SELECT 1 --\u{a0}x\n; DELETE FROM t", "mysql"),
            // Codex round 9: the comment ends at CR, so the call is live SQL.
            ("SELECT 1 -- note\rpg_advisory_lock(1)", "postgres"),
            ("SELECT 1 # note\rGET_LOCK('a', 0)", "mysql"),
            ("SELECT 1e5(1)", "postgres"),
            ("SELECT 'x'(1)", "sqlite"),
            ("SELECT LOAD_FILE('/etc/passwd')", "mysql"),
            ("SELECT GET_LOCK('a', 1)", "mysql"),
            ("SELECT load_extension('x')", "sqlite"),
            ("SELECT app.do_things()", "postgres"),
            ("SELECT \"weird\"(1)", "postgres"),
            ("SELECT @a := 1", "mysql"),
            // syntax this check does not model
            ("SELECT $$; DELETE FROM t; $$", "postgres"),
            ("SELECT /*!50000 SLEEP(1) */ 1", "mysql"),
            // Codex Phase 2 round 2: MariaDB executable comments.
            ("SELECT /*M! GET_LOCK('agent_review', 0) + */ 1", "mariadb"),
            ("SELECT /*M!100100 GET_LOCK('a', 0) + */ 1", "mysql"),
            ("SELECT /*m! SLEEP(1) */ 1", "postgres"),
            ("SELECT 'unterminated", "postgres"),
            ("SELECT 1 /* open", "postgres"),
            ("ATTACH DATABASE 'x' AS y", "sqlite"),
            ("SHOW TABLES", "postgres"),
            ("CALL p()", "mysql"),
            ("", "postgres"),
            ("SELECT 1", "oracle"),
        ] {
            assert!(!read_only(sql, engine), "{engine}: {sql}");
        }
    }

    #[test]
    fn quoting_cannot_hide_statements() {
        // Backslashes in plain strings depend on server settings: never trusted.
        for engine in ["postgres", "mysql", "mariadb", "sqlite"] {
            assert!(!read_only("SELECT 'a\\'; DELETE FROM t; --'", engine));
            assert!(!read_only("SELECT 'x\\', '; DELETE FROM t; --'", engine));
        }
        assert!(!read_only("SELECT \"a\\\"; DELETE FROM t; --\"", "mysql"));
        // Postgres E'' strings always take escapes: the DELETE is inside the string.
        assert!(read_only("SELECT E'a\\'; DELETE FROM t; --'", "postgres"));
        assert!(!read_only("SELECT 'a''; DELETE FROM t", "sqlite"));
        // MySQL `--` without a space is arithmetic, not a comment.
        assert!(!read_only("SELECT 1 --1; DELETE FROM t", "mysql"));
        // Nested comments only nest in Postgres.
        assert!(!read_only(
            "SELECT 1 /* a /* b */ DELETE FROM t */",
            "mysql"
        ));
        assert!(read_only(
            "SELECT 1 /* a /* b */ DELETE FROM t */",
            "postgres"
        ));
    }
}
