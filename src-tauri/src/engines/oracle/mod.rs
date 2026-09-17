pub mod connection;
pub mod driver;
pub mod operation;

use std::collections::HashSet;
use std::path::Path;
use std::sync::OnceLock;

fn oracle_client_search_dirs() -> Vec<String> {
    let mut out = Vec::new();

    if let Ok(dir) = std::env::var("ORACLE_CLIENT_LIB_DIR") {
        if !dir.trim().is_empty() {
            out.push(dir);
        }
    }

    if let Ok(pathlist) = std::env::var("DYLD_LIBRARY_PATH") {
        for part in pathlist.split(':') {
            if !part.trim().is_empty() {
                out.push(part.trim().to_string());
            }
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        out.push(format!("{home}/Downloads/instantclient_23_3"));
        out.push(format!("{home}/instantclient_23_3"));
    }

    out.push("/opt/homebrew/lib".to_string());
    out.push("/usr/local/lib".to_string());

    let mut seen = HashSet::new();
    out.into_iter()
        .filter(|s| seen.insert(s.clone()))
        .collect::<Vec<_>>()
}

pub fn ensure_oracle_client_initialized() -> Result<(), String> {
    static INIT: OnceLock<Result<(), String>> = OnceLock::new();

    INIT.get_or_init(|| {
        let mut attempt_errors: Vec<String> = Vec::new();

        for dir in oracle_client_search_dirs() {
            let lib = Path::new(&dir).join("libclntsh.dylib");
            if !lib.exists() {
                continue;
            }

            let mut p = oracle::InitParams::new();
            if let Err(e) = p.oracle_client_lib_dir(&dir) {
                attempt_errors.push(format!("{dir}: {e}"));
                continue;
            }
            let init_res = p.init().map(|_| ()).map_err(|e| e.to_string());

            match init_res {
                Ok(()) => return Ok(()),
                Err(e) => attempt_errors.push(format!("{dir}: {e}")),
            }
        }

        let p = oracle::InitParams::new();
        if p.init().is_ok() {
            return Ok(());
        }

        let mut msg = String::from(
            "ORACLE_CLIENT_INIT_FAILED: cannot load Oracle Client (libclntsh.dylib). Set ORACLE_CLIENT_LIB_DIR to your Instant Client folder, e.g. /Users/<you>/Downloads/instantclient_23_3",
        );
        if !attempt_errors.is_empty() {
            msg.push_str(" | attempts: ");
            msg.push_str(&attempt_errors.join(" ; "));
        }
        Err(msg)
    })
    .clone()
}
