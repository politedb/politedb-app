use std::fs;
use std::io;
use std::path::Path;
use tauri::Manager;

/// Bundle identifier used before the switch to `PoliteDB`. Tauri derives
/// `app_data_dir` from the identifier, so existing installs keep their
/// profiles, license, drafts, snippets and AI models under this folder.
const LEGACY_IDENTIFIER: &str = "com.politehq.politedb";

/// Moves data from the legacy app data folder into the current one.
/// Must run before anything reads from `app_data_dir`.
pub fn migrate_legacy_app_data(app: &tauri::AppHandle) {
    let Ok(target) = app.path().app_data_dir() else {
        return;
    };
    let Some(parent) = target.parent() else {
        return;
    };
    let legacy = parent.join(LEGACY_IDENTIFIER);

    match migrate_dir(&legacy, &target) {
        Ok(0) => {}
        Ok(moved) => tracing::info!(moved, "migrated legacy app data entries"),
        Err(e) => tracing::warn!(kind = ?e.kind(), "legacy app data migration failed"),
    }
}

/// Returns the number of top-level entries moved. Entries that already exist
/// in `target` are left untouched in `legacy` so current data is never overwritten.
fn migrate_dir(legacy: &Path, target: &Path) -> io::Result<usize> {
    if legacy == target || !legacy.is_dir() {
        return Ok(0);
    }

    if !target.exists() {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(legacy, target)?;
        return Ok(1);
    }

    let mut moved = 0;
    for entry in fs::read_dir(legacy)? {
        let entry = entry?;
        let dest = target.join(entry.file_name());
        if dest.exists() {
            continue;
        }
        fs::rename(entry.path(), &dest)?;
        moved += 1;
    }

    // Best effort: drop the legacy folder once everything has been moved.
    let _ = fs::remove_dir(legacy);
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("politedb-migration-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn moves_whole_folder_when_target_missing() {
        let root = scratch_dir("whole");
        let legacy = root.join(LEGACY_IDENTIFIER);
        let target = root.join("PoliteDB");
        write(&legacy.join("profiles/profiles.json"), "old");

        assert_eq!(migrate_dir(&legacy, &target).unwrap(), 1);
        assert!(!legacy.exists());
        assert_eq!(
            fs::read_to_string(target.join("profiles/profiles.json")).unwrap(),
            "old"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn merges_missing_entries_without_overwriting_existing() {
        let root = scratch_dir("merge");
        let legacy = root.join(LEGACY_IDENTIFIER);
        let target = root.join("PoliteDB");
        write(&legacy.join("profiles/profiles.json"), "old");
        write(&legacy.join("snippets/library.json"), "old-snippets");
        write(&target.join("profiles/profiles.json"), "new");

        assert_eq!(migrate_dir(&legacy, &target).unwrap(), 1);
        assert_eq!(
            fs::read_to_string(target.join("profiles/profiles.json")).unwrap(),
            "new"
        );
        assert_eq!(
            fs::read_to_string(target.join("snippets/library.json")).unwrap(),
            "old-snippets"
        );
        // Conflicting entry stays in the legacy folder.
        assert!(legacy.join("profiles/profiles.json").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn noop_when_legacy_missing() {
        let root = scratch_dir("noop");
        let target = root.join("PoliteDB");
        assert_eq!(
            migrate_dir(&root.join(LEGACY_IDENTIFIER), &target).unwrap(),
            0
        );
        assert!(!target.exists());
        fs::remove_dir_all(&root).unwrap();
    }
}
