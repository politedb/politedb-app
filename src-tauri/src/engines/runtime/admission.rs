//! Admission of new work on a runtime connection (plan tab-database-reconnect
//! R20): a connection opened from settings that have since been saved
//! differently (or whose profile was removed) is stale and refused, whatever
//! the frontend has published. Work admitted earlier is not interrupted.

use std::sync::Arc;

use dashmap::DashMap;
use uuid::Uuid;

use crate::engines::EngineConnection;
use crate::profiles::store::current_revision;
use crate::profiles::target_override::RuntimeTarget;
use crate::state::AppState;

/// The connection's profile was saved again or removed since it was opened.
pub const RUNTIME_STALE: &str = "RUNTIME_STALE";
/// The connection has no recorded target (never expected; fails closed).
pub const RUNTIME_IDENTITY_MISSING: &str = "RUNTIME_IDENTITY_MISSING";

/// Whether a connection opened on `target` may take new work, given the
/// stored revision of each profile.
pub fn check_target(
    target: Option<&RuntimeTarget>,
    current: impl Fn(Uuid) -> Option<String>,
) -> Result<(), &'static str> {
    let target = target.ok_or(RUNTIME_IDENTITY_MISSING)?;
    let Some(profile_id) = target.profile_id else {
        // Not opened from a saved profile: nothing can make it stale.
        return Ok(());
    };
    match current(profile_id) {
        Some(revision) if Some(&revision) == target.profile_revision.as_ref() => Ok(()),
        _ => Err(RUNTIME_STALE),
    }
}

type Targets = DashMap<Uuid, RuntimeTarget>;

fn admit_target(targets: &Targets, connection_id: Uuid) -> Result<(), &'static str> {
    let target = targets.get(&connection_id).map(|t| t.clone());
    check_target(target.as_ref(), current_revision)
}

/// The connection, if it may take new work. Never holds two map entries at
/// once, never awaits, never takes the profile store lock.
pub fn admit_runtime(state: &AppState, connection_id: Uuid) -> Result<EngineConnection, String> {
    let conn = state
        .connections
        .get(&connection_id)
        .map(|c| c.value().clone())
        .ok_or("CONNECTION_NOT_FOUND")?;
    admit_target(&state.runtime_targets, connection_id)?;
    Ok(conn)
}

/// Admission of one AI run's connection, checked again before every tool
/// that touches it: `Err` carries the code that ends the run.
pub fn runtime_admission(state: &AppState, connection_id: Uuid) -> RuntimeAdmission {
    let targets: Arc<Targets> = Arc::clone(&state.runtime_targets);
    Arc::new(move || admit_target(&targets, connection_id).map_err(str::to_string))
}

pub type RuntimeAdmission = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::EngineKind;

    fn target(profile: Option<Uuid>, revision: Option<&str>) -> RuntimeTarget {
        RuntimeTarget {
            profile_id: profile,
            profile_revision: revision.map(str::to_string),
            database_override: None,
            engine: EngineKind::Postgres,
            display: "db".into(),
        }
    }

    /// Every reader of the runtime map either goes through `admit_runtime` or
    /// is an approved exception (publication, listing, removal, liveness);
    /// a new direct reader fails this test.
    #[test]
    fn no_command_bypasses_admission() {
        const APPROVED: &[(&str, &str)] = &[
            // admit_runtime itself
            ("src/engines/runtime/admission.rs", ".connections"),
            // publication, listing, removal
            (
                "src/commands/connection/lifecycle.rs",
                "state.connections.insert(",
            ),
            ("src/commands/connection/lifecycle.rs", ".connections"),
            (
                "src/commands/connection/lifecycle.rs",
                "state.connections.remove(",
            ),
            // existence only: a session begun before a save keeps working
            (
                "src/commands/sql_session.rs",
                "state.connections.contains_key(",
            ),
            // AI run liveness (existence only); tools are admitted separately
            ("src/commands/ai_agent.rs", "Arc::clone(&state.connections)"),
        ];
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut found = Vec::new();
        let mut stack = vec![root.join("src")];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                    continue;
                }
                let rel = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                let text = std::fs::read_to_string(&path).unwrap();
                for line in text.lines() {
                    let code = line.trim();
                    let reads = code.contains("state.connections")
                        || code == ".connections"
                        || code.contains("&state.connections");
                    if !reads || code.starts_with("//") {
                        continue;
                    }
                    let approved = APPROVED
                        .iter()
                        .any(|(file, pattern)| rel == *file && code.contains(pattern));
                    if !approved {
                        found.push(format!("{rel}: {code}"));
                    }
                }
            }
        }
        assert!(found.is_empty(), "readers bypassing admission: {found:#?}");
    }

    #[test]
    fn admits_only_the_current_revision() {
        let id = Uuid::new_v4();
        let now = |_| Some("r2".to_string());
        assert_eq!(
            check_target(Some(&target(Some(id), Some("r2"))), now),
            Ok(())
        );
        assert_eq!(
            check_target(Some(&target(Some(id), Some("r1"))), now),
            Err(RUNTIME_STALE)
        );
        // Removed profile.
        assert_eq!(
            check_target(Some(&target(Some(id), Some("r2"))), |_| None),
            Err(RUNTIME_STALE)
        );
        // Not from a saved profile.
        assert_eq!(check_target(Some(&target(None, None)), |_| None), Ok(()));
        // No recorded target fails closed.
        assert_eq!(check_target(None, now), Err(RUNTIME_IDENTITY_MISSING));
    }
}
