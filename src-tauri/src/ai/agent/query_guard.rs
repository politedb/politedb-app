//! Validation for SQL the agent runs itself (plan ai-agent R4, Phase 3 data tools).
//!
//! A query is accepted only when sqlparser reads it as exactly one plain query that
//! modifies nothing, locks nothing and calls only pure built-ins, **and** the Phase 2
//! lexical check agrees. What runs is the parser's own rendering of the validated tree,
//! never the model's text, so comments and quoting tricks cannot smuggle anything past
//! the check. On PostgreSQL the caller must also confirm the connection's catalog
//! (`CatalogExecutor::only_builtin_code`) and run it read-only.

use std::ops::ControlFlow;

use sqlparser::ast::{
    Expr, FunctionArguments, ObjectName, ObjectNamePart, Query, SetExpr, Statement, TableFactor,
    Visit, Visitor,
};
use sqlparser::dialect::{Dialect, PostgreSqlDialect, SQLiteDialect};
use sqlparser::parser::Parser;

use super::sql_safety::{self, SqlSafety, ALLOWED_FUNCTIONS};

/// Code prefix of every rejection; the reason after it is fixed text the model can
/// act on.
pub const NOT_ALLOWED: &str = "AI_QUERY_NOT_ALLOWED";

/// Longest SQL the agent may submit.
pub const MAX_QUERY_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardDialect {
    Postgres,
    Sqlite,
}

impl GuardDialect {
    fn parser(self) -> Box<dyn Dialect> {
        match self {
            Self::Postgres => Box::new(PostgreSqlDialect {}),
            Self::Sqlite => Box::new(SQLiteDialect {}),
        }
    }

    fn engine(self) -> &'static str {
        match self {
            Self::Postgres => "postgres",
            Self::Sqlite => "sqlite",
        }
    }
}

fn reject(reason: &str) -> String {
    format!("{NOT_ALLOWED}: {reason}")
}

/// Validates `sql` and returns the SQL to execute (the rendering of the parsed query).
pub fn validate(sql: &str, dialect: GuardDialect) -> Result<String, String> {
    if sql.len() > MAX_QUERY_BYTES {
        return Err(reject("the query is too long"));
    }
    let statements = Parser::parse_sql(dialect.parser().as_ref(), sql)
        .map_err(|_| reject("the query could not be parsed; write one plain SELECT"))?;
    let [statement] = statements.as_slice() else {
        return Err(reject("send exactly one statement"));
    };
    let Statement::Query(_) = statement else {
        return Err(reject(
            "only a read-only SELECT (or WITH … SELECT) is allowed",
        ));
    };
    let mut guard = Guard {
        statements: 0,
        failure: None,
    };
    let _ = statement.visit(&mut guard);
    if let Some(reason) = guard.failure {
        return Err(reject(&reason));
    }
    let rendered = statement.to_string();
    // Defence in depth: the text that runs must also pass the lexical check.
    if sql_safety::classify(&rendered, dialect.engine()) != SqlSafety::ReadOnly {
        return Err(reject(
            "the query uses syntax or functions that cannot be run automatically",
        ));
    }
    Ok(rendered)
}

struct Guard {
    statements: usize,
    failure: Option<String>,
}

impl Guard {
    fn fail(&mut self, reason: impl Into<String>) -> ControlFlow<()> {
        self.failure = Some(reason.into());
        ControlFlow::Break(())
    }
}

/// A single, unquoted name on the pure built-in allow-list.
fn allowed_function(name: &ObjectName) -> Result<(), String> {
    let [ObjectNamePart::Identifier(ident)] = name.0.as_slice() else {
        return Err("qualified or computed function names are not allowed".into());
    };
    if ident.quote_style.is_some() {
        return Err("quoted function names are not allowed".into());
    }
    let upper = ident.value.to_ascii_uppercase();
    if ALLOWED_FUNCTIONS.contains(&upper.as_str()) {
        Ok(())
    } else {
        let shown: String = ident.value.chars().take(64).collect();
        Err(format!("function not allowed: {shown}"))
    }
}

fn plain_body(body: &SetExpr) -> bool {
    match body {
        SetExpr::Select(_) | SetExpr::Query(_) | SetExpr::Values(_) => true,
        SetExpr::SetOperation { left, right, .. } => plain_body(left) && plain_body(right),
        _ => false,
    }
}

impl Visitor for Guard {
    type Break = ();

    fn pre_visit_statement(&mut self, statement: &Statement) -> ControlFlow<()> {
        self.statements += 1;
        if self.statements > 1 || !matches!(statement, Statement::Query(_)) {
            return self.fail("data-changing statements are not allowed");
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_query(&mut self, query: &Query) -> ControlFlow<()> {
        if !plain_body(&query.body) {
            return self.fail("data-changing statements are not allowed");
        }
        if !query.locks.is_empty() || query.for_clause.is_some() {
            return self.fail("locking clauses (FOR UPDATE/SHARE) are not allowed");
        }
        if query.settings.is_some()
            || query.format_clause.is_some()
            || !query.pipe_operators.is_empty()
        {
            return self.fail("this query form is not supported");
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_select(&mut self, select: &sqlparser::ast::Select) -> ControlFlow<()> {
        if select.into.is_some() {
            return self.fail("SELECT INTO is not allowed");
        }
        if !select.optimizer_hints.is_empty() {
            return self.fail("optimizer hints are not allowed");
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_table_factor(&mut self, factor: &TableFactor) -> ControlFlow<()> {
        match factor {
            TableFactor::Table { name, args, .. } => {
                // `FROM fn(...)`: a table function call.
                if args.is_some() {
                    if let Err(reason) = allowed_function(name) {
                        return self.fail(reason);
                    }
                }
                ControlFlow::Continue(())
            }
            TableFactor::Derived { .. }
            | TableFactor::NestedJoin { .. }
            | TableFactor::UNNEST { .. } => ControlFlow::Continue(()),
            _ => self.fail("this kind of FROM item is not supported"),
        }
    }

    fn pre_visit_expr(&mut self, expr: &Expr) -> ControlFlow<()> {
        // A schema-qualified type can be a user type (its input or domain check runs
        // code); unqualified names only reach built-ins once the search path is pinned.
        let cast_type = match expr {
            Expr::Cast { data_type, .. } => Some(data_type),
            Expr::TypedString(typed) => Some(&typed.data_type),
            _ => None,
        };
        if cast_type.is_some_and(|t| t.to_string().contains('.') || t.to_string().contains('"')) {
            return self.fail("casts to schema-qualified or quoted types are not allowed");
        }
        if let Expr::Function(function) = expr {
            if function.uses_odbc_syntax || !matches!(function.parameters, FunctionArguments::None)
            {
                return self.fail("this function call form is not supported");
            }
            if let Err(reason) = allowed_function(&function.name) {
                return self.fail(reason);
            }
        }
        ControlFlow::Continue(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(sql: &str, dialect: GuardDialect) -> String {
        validate(sql, dialect).unwrap_or_else(|e| panic!("{sql}: {e}"))
    }

    fn rejected(sql: &str, dialect: GuardDialect) {
        let err = validate(sql, dialect).expect_err(sql);
        assert!(err.starts_with(NOT_ALLOWED), "{err}");
    }

    #[test]
    fn plain_queries_are_accepted_and_rendered() {
        use GuardDialect::*;
        for (sql, dialect) in [
            ("SELECT * FROM orders WHERE id = 1;", Postgres),
            (
                "WITH m AS (SELECT date_trunc('month', created_at) AS month, count(*) AS n \
                 FROM public.orders GROUP BY 1) SELECT * FROM m ORDER BY month DESC LIMIT 12",
                Postgres,
            ),
            ("SELECT a FROM t UNION ALL SELECT b FROM u", Postgres),
            ("SELECT x FROM t WHERE id IN (SELECT id FROM u)", Postgres),
            ("SELECT n FROM generate_series(1, 3) AS g(n)", Postgres),
            (
                "SELECT CAST(total AS numeric(10, 2)), note::text, DATE '2026-01-01'",
                Postgres,
            ),
            (
                "SELECT strftime('%Y', created_at), count(*) FROM orders GROUP BY 1",
                Sqlite,
            ),
            (
                "SELECT row_number() OVER (PARTITION BY a ORDER BY b) FROM t",
                Postgres,
            ),
        ] {
            ok(sql, dialect);
        }
        // Comments are gone from what runs.
        let rendered = ok("SELECT 1 -- note\n", GuardDialect::Postgres);
        assert!(!rendered.contains("note"));
    }

    #[test]
    fn the_r4_corpus_is_rejected() {
        use GuardDialect::*;
        for (sql, dialect) in [
            // writes, also inside CTEs and set operations
            ("INSERT INTO t VALUES (1)", Postgres),
            ("UPDATE t SET a = 1", Sqlite),
            ("DELETE FROM t", Postgres),
            (
                "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
                Postgres,
            ),
            (
                "WITH i AS (INSERT INTO t VALUES (1) RETURNING id) SELECT id FROM i",
                Postgres,
            ),
            ("CREATE TABLE x (a int)", Postgres),
            ("DROP TABLE t", Sqlite),
            ("SELECT * INTO new_t FROM t", Postgres),
            ("COPY t TO '/tmp/x'", Postgres),
            // locking
            ("SELECT * FROM t FOR UPDATE", Postgres),
            ("SELECT * FROM t FOR SHARE SKIP LOCKED", Postgres),
            // multi-statement and comment tricks
            ("SELECT 1; DELETE FROM t", Postgres),
            ("SELECT 1 /* ; */; DROP TABLE t", Sqlite),
            ("SELECT $$x$$", Postgres),
            // admin, file, network and session functions
            ("SELECT pg_sleep(1)", Postgres),
            ("SELECT pg_advisory_lock(1)", Postgres),
            ("SELECT pg_read_file('/etc/passwd')", Postgres),
            ("SELECT * FROM pg_ls_dir('.')", Postgres),
            ("SELECT lo_import('/etc/passwd')", Postgres),
            ("SELECT * FROM dblink('x', 'y') AS t(a int)", Postgres),
            ("SELECT set_config('a', 'b', false)", Postgres),
            ("SELECT nextval('s')", Postgres),
            ("SELECT public.lower(1)", Postgres),
            ("SELECT \"lower\"(1)", Postgres),
            ("SELECT load_extension('x')", Sqlite),
            ("SELECT readfile('/etc/passwd')", Sqlite),
            // user types reachable only by qualified or quoted names
            ("SELECT CAST(1 AS public.side_effect_type)", Postgres),
            ("SELECT 1::public.d", Postgres),
            ("SELECT CAST(1 AS \"MyType\")", Postgres),
            // SQLite statements
            ("PRAGMA user_version = 1", Sqlite),
            ("ATTACH DATABASE 'x.db' AS x", Sqlite),
            ("VACUUM", Sqlite),
            // EXPLAIN is run by the explain tool itself, not passed through
            ("EXPLAIN ANALYZE DELETE FROM t", Postgres),
            ("", Postgres),
        ] {
            rejected(sql, dialect);
        }
        rejected(&"SELECT 1 ".repeat(MAX_QUERY_BYTES), GuardDialect::Postgres);
    }
}
