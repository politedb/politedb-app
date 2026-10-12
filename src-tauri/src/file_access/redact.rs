//! Log-safe error text for code paths that touch user files (AGENTS.md: never log paths).

/// Log-safe form of an error from a code path that opens user files: only its leading
/// code (e.g. `SQLITE_OPEN_FAILED`, `FILE_ACCESS_REQUIRED`), else `OTHER`. Engine and
/// native diagnostics can carry paths in forms no replacement can reliably catch
/// (URL-encoded, relative, sidecar names), so their text never reaches logs; the full
/// message still goes to the frontend for the user.
pub fn log_safe(error: &str) -> String {
    let code: String = error
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == '_')
        .collect();
    if code.len() >= 3 && code.contains('_') && code.starts_with(|c: char| c.is_ascii_uppercase()) {
        code
    } else {
        "OTHER".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_access_errors_keep_only_the_code() {
        assert_eq!(
            log_safe(r#"FILE_ACCESS_REQUIRED:{"role":"ssh_key"}"#),
            "FILE_ACCESS_REQUIRED"
        );
    }

    #[test]
    fn diagnostics_never_reach_logs() {
        let sentinel = "/Users/sentinel/private project/app.db";
        for err in [
            format!("SQLITE_OPEN_FAILED: unable to open {sentinel} (code 14)"),
            "DUCKDB_OPEN_FAILED: IO Error: file:///Users/sentinel/private%20project/app.db".into(),
            format!("could not open {sentinel}"),
            String::new(),
        ] {
            let safe = log_safe(&err);
            assert!(
                !safe.contains("sentinel") && !safe.contains("private"),
                "{safe}"
            );
        }
        assert_eq!(
            log_safe("SQLITE_OPEN_FAILED: unable to open x"),
            "SQLITE_OPEN_FAILED"
        );
        assert_eq!(log_safe("could not open x"), "OTHER");
    }
}
