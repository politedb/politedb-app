//! Backend-owned picker flows: the only way grants are created (plan B2). The selected
//! item comes straight from a system panel, is validated, and (sandboxed builds) is
//! bookmarked from the panel's own URL before anything else sees it.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::error::{self, Role};
use super::service::{normalize_absolute, FileAccess};
use super::validate;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanelKind {
    OpenFile,
    SaveFile,
    Folder,
}

pub type Validator = Box<dyn Fn(&Path) -> Result<PathBuf, String> + Send>;

pub struct PanelRequest {
    pub kind: PanelKind,
    pub title: String,
    pub message: String,
    pub prompt: String,
    pub directory: Option<PathBuf>,
    pub file_name: Option<String>,
    /// Show dot files (SSH keys live in `~/.ssh`).
    pub show_hidden: bool,
    /// Runs on the selection before any bookmark is created; returns the canonical path.
    pub validate: Validator,
    /// `Some(read_only)`: create a security-scoped bookmark from the panel URL.
    pub bookmark: Option<bool>,
}

pub struct PanelResult {
    pub path: PathBuf,
    pub bookmark: Option<Vec<u8>>,
}

/// System open/save/folder panels. Blocking: call from a blocking task.
pub trait Panels {
    /// `Ok(None)` when the user cancels.
    fn run(&self, request: PanelRequest) -> Result<Option<PanelResult>, String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseMode {
    /// Choose an existing database file.
    Open,
    /// Choose where a new database file will be created.
    Create,
}

/// Picks a database file (and, sandboxed, grants its folder). With `expected` (recovery
/// for a saved connection) only the folder is asked for and the path must not change.
pub fn database(
    panels: &dyn Panels,
    access: &FileAccess,
    mode: DatabaseMode,
    expected: Option<&str>,
) -> Result<Option<String>, String> {
    let strict = access.is_enabled();
    if let Some(expected) = expected {
        if strict {
            // The saved file itself must still pass the open checks before its folder
            // is granted.
            // Validate the saved spelling itself (no canonicalizing first), so a symlinked
            // folder in it is rejected like in the open panel.
            let saved = normalize_absolute(Path::new(expected.trim()))?;
            if std::fs::symlink_metadata(&saved).is_err() {
                return Err(error::unavailable(Role::DatabaseFolder));
            }
            let database = validate::existing_file(&saved)?;
            // Re-checked after the folder panel closes, before the grant is stored.
            let recheck = move || validate::existing_file(&saved).map(|_| ());
            return Ok(
                grant_folder(panels, access, &database, Some(Box::new(recheck)))?
                    .map(|_| expected.to_string()),
            );
        }
    }

    let file = panels.run(PanelRequest {
        kind: match mode {
            DatabaseMode::Open => PanelKind::OpenFile,
            DatabaseMode::Create => PanelKind::SaveFile,
        },
        title: match mode {
            DatabaseMode::Open => "Open Database".into(),
            DatabaseMode::Create => "New Database".into(),
        },
        message: String::new(),
        prompt: match mode {
            DatabaseMode::Open => "Open".into(),
            DatabaseMode::Create => "Create".into(),
        },
        directory: None,
        file_name: None,
        show_hidden: false,
        validate: match (strict, mode) {
            (false, _) => Box::new(validate::lenient),
            (true, DatabaseMode::Open) => Box::new(validate::existing_file),
            (true, DatabaseMode::Create) => Box::new(validate::new_file),
        },
        bookmark: None,
    })?;
    let Some(file) = file else {
        return Ok(None);
    };
    if access.is_enabled() && grant_folder(panels, access, &file.path, None)?.is_none() {
        // No folder access means the database cannot be written: treat as cancelled.
        return Ok(None);
    }
    Ok(Some(file.path.to_string_lossy().into_owned()))
}

/// Picks an SSH private key; sandboxed builds keep a read-only grant. With `expected`
/// the user must choose that same file.
pub fn ssh_key(
    panels: &dyn Panels,
    access: &FileAccess,
    expected: Option<&str>,
) -> Result<Option<String>, String> {
    let expected_path = expected.map(canonical_target).transpose()?;
    let directory = expected_path
        .as_deref()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .or_else(|| validate::real_home().map(|home| home.join(".ssh")));
    let file_name = expected_path
        .as_deref()
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().into_owned());
    let expected_owned = expected.map(str::to_string);
    let strict = access.is_enabled();
    let result = panels.run(PanelRequest {
        kind: PanelKind::OpenFile,
        title: "Choose SSH Private Key".into(),
        message: String::new(),
        prompt: "Choose".into(),
        directory,
        file_name,
        show_hidden: true,
        validate: Box::new(move |selected| {
            let path = if strict {
                validate::existing_file(selected)?
            } else {
                validate::lenient(selected)?
            };
            match &expected_owned {
                Some(expected) if !validate::is_expected(expected, &path) => {
                    Err(error::WRONG_FILE.into())
                }
                _ => Ok(path),
            }
        }),
        bookmark: access.is_enabled().then_some(true),
    })?;
    let Some(result) = result else {
        return Ok(None);
    };
    if let Some(bookmark) = &result.bookmark {
        access.record(Role::SshKey, &result.path, bookmark)?;
    }
    Ok(Some(match expected {
        Some(expected) => expected.to_string(),
        None => result.path.to_string_lossy().into_owned(),
    }))
}

/// Asks for the database's folder with an explanation, then stores its grant.
fn grant_folder(
    panels: &dyn Panels,
    access: &FileAccess,
    database: &Path,
    recheck: Option<Box<dyn FnOnce() -> Result<(), String>>>,
) -> Result<Option<()>, String> {
    let folder = database
        .parent()
        .ok_or_else(|| error::INVALID_PATH.to_string())?
        .to_path_buf();
    let folder_name = display_name(&folder);
    let db_name = display_name(database);
    let database_owned = database.to_path_buf();
    let home = validate::real_home();
    let result = panels.run(PanelRequest {
        kind: PanelKind::Folder,
        title: "Allow Access to Folder".into(),
        message: format!(
            "PoliteDB needs access to the folder “{folder_name}” to read and write “{db_name}” \
             and its journal files. PoliteDB will be able to read and write files in this folder."
        ),
        prompt: "Allow Access".into(),
        directory: Some(folder),
        file_name: None,
        show_hidden: false,
        validate: Box::new(move |selected| {
            validate::database_folder(selected, &database_owned, home.as_deref())
        }),
        bookmark: Some(false),
    })?;
    let Some(result) = result else {
        return Ok(None);
    };
    let bookmark = result
        .bookmark
        .ok_or_else(|| error::PANEL_FAILED.to_string())?;
    if let Some(recheck) = recheck {
        recheck()?;
    }
    access.record(Role::DatabaseFolder, &result.path, &bookmark)?;
    Ok(Some(()))
}

/// Canonical form of a stored/typed path (its folder canonicalized when it exists).
fn canonical_target(path: &str) -> Result<PathBuf, String> {
    let path = normalize_absolute(Path::new(path.trim()))?;
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(error::INVALID_PATH.into());
    };
    Ok(std::fs::canonicalize(parent)
        .map(|parent| parent.join(name))
        .unwrap_or(path.clone()))
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_access::test_support::{FakePort, TempDir};
    use std::cell::RefCell;
    use std::sync::Arc;

    /// (kind, preset directory, bookmark mode) of each panel shown.
    type Seen = (PanelKind, Option<PathBuf>, Option<bool>);

    /// Answers panels in order; `None` = cancel. Records each request kind.
    struct ScriptedPanels {
        answers: RefCell<Vec<Option<PathBuf>>>,
        seen: RefCell<Vec<Seen>>,
    }

    impl ScriptedPanels {
        fn new(answers: Vec<Option<PathBuf>>) -> Self {
            Self {
                answers: RefCell::new(answers),
                seen: RefCell::new(Vec::new()),
            }
        }
    }

    impl Panels for ScriptedPanels {
        fn run(&self, request: PanelRequest) -> Result<Option<PanelResult>, String> {
            self.seen.borrow_mut().push((
                request.kind,
                request.directory.clone(),
                request.bookmark,
            ));
            let answer = self.answers.borrow_mut().remove(0);
            let Some(selected) = answer else {
                return Ok(None);
            };
            let path = (request.validate)(&selected)?;
            let bookmark = request
                .bookmark
                .map(|_| path.to_string_lossy().into_owned().into_bytes());
            Ok(Some(PanelResult { path, bookmark }))
        }
    }

    fn enabled(dir: &TempDir) -> (Arc<FakePort>, FileAccess) {
        let port = Arc::new(FakePort::default());
        let access = FileAccess::enabled(dir.path().join("grants.json"), port.clone());
        (port, access)
    }

    fn db_dir(dir: &TempDir) -> (PathBuf, PathBuf) {
        let folder = dir.path().join("data");
        std::fs::create_dir(&folder).unwrap();
        let db = folder.join("app.db");
        std::fs::write(&db, b"").unwrap();
        (folder, db)
    }

    #[test]
    fn direct_build_asks_for_the_file_only() {
        let dir = TempDir::new();
        let (_, db) = db_dir(&dir);
        let panels = ScriptedPanels::new(vec![Some(db.clone())]);
        let picked = database(&panels, &FileAccess::disabled(), DatabaseMode::Open, None).unwrap();
        assert_eq!(picked.as_deref(), db.to_str());
        assert_eq!(panels.seen.borrow().len(), 1);
    }

    #[test]
    fn sandboxed_open_grants_the_parent_folder() {
        let dir = TempDir::new();
        let (folder, db) = db_dir(&dir);
        let (port, access) = enabled(&dir);
        let panels = ScriptedPanels::new(vec![Some(db.clone()), Some(folder.clone())]);
        let picked = database(&panels, &access, DatabaseMode::Open, None).unwrap();
        assert_eq!(picked.as_deref(), db.to_str());
        let seen = panels.seen.borrow();
        assert_eq!(
            seen[1],
            (PanelKind::Folder, Some(folder.clone()), Some(false))
        );
        // The stored grant now leases.
        port.register(folder.to_str().unwrap(), &folder);
        assert!(access
            .acquire_database(db.to_str().unwrap())
            .unwrap()
            .is_some());
    }

    #[test]
    fn create_mode_allows_a_new_file() {
        let dir = TempDir::new();
        let (folder, _) = db_dir(&dir);
        let (_, access) = enabled(&dir);
        let target = folder.join("new.duckdb");
        let panels = ScriptedPanels::new(vec![Some(target.clone()), Some(folder)]);
        let picked = database(&panels, &access, DatabaseMode::Create, None).unwrap();
        assert_eq!(picked.as_deref(), target.to_str());
        assert_eq!(panels.seen.borrow()[0].0, PanelKind::SaveFile);
    }

    #[test]
    fn cancelling_the_folder_stores_nothing() {
        let dir = TempDir::new();
        let (_, db) = db_dir(&dir);
        let (_, access) = enabled(&dir);
        let panels = ScriptedPanels::new(vec![Some(db.clone()), None]);
        assert_eq!(
            database(&panels, &access, DatabaseMode::Open, None).unwrap(),
            None
        );
        assert!(!dir.path().join("grants.json").exists());
    }

    #[test]
    fn another_folder_is_rejected() {
        let dir = TempDir::new();
        let (_, db) = db_dir(&dir);
        let (_, access) = enabled(&dir);
        let panels = ScriptedPanels::new(vec![Some(db), Some(dir.path().to_path_buf())]);
        assert_eq!(
            database(&panels, &access, DatabaseMode::Open, None).unwrap_err(),
            error::WRONG_FILE
        );
        assert!(!dir.path().join("grants.json").exists());
    }

    #[test]
    fn recovery_asks_only_for_the_folder_and_keeps_the_path() {
        let dir = TempDir::new();
        let (folder, db) = db_dir(&dir);
        let (port, access) = enabled(&dir);
        port.register(folder.to_str().unwrap(), &folder);
        let expected = format!("{}/./app.db", folder.display());
        let panels = ScriptedPanels::new(vec![Some(folder.clone())]);
        let picked = database(&panels, &access, DatabaseMode::Open, Some(&expected)).unwrap();
        assert_eq!(picked.as_deref(), Some(expected.as_str()));
        assert_eq!(panels.seen.borrow().len(), 1);
        let missing = access
            .missing(&[crate::file_access::AccessRequest {
                role: Role::DatabaseFolder,
                path: db.to_string_lossy().into_owned(),
            }])
            .unwrap();
        assert!(missing.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn recovery_rejects_a_symlinked_saved_path() {
        let dir = TempDir::new();
        let (folder, _) = db_dir(&dir);
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&folder, &link).unwrap();
        let (_, access) = enabled(&dir);
        let panels = ScriptedPanels::new(vec![Some(folder)]);
        let saved = link.join("app.db");
        assert_eq!(
            database(
                &panels,
                &access,
                DatabaseMode::Open,
                Some(saved.to_str().unwrap())
            )
            .unwrap_err(),
            error::UNSUPPORTED_ITEM
        );
        assert!(
            panels.seen.borrow().is_empty(),
            "no panel for a rejected path"
        );
        assert!(!dir.path().join("grants.json").exists());
    }

    #[test]
    fn recovery_rechecks_the_database_after_the_folder_panel() {
        let dir = TempDir::new();
        let (folder, db) = db_dir(&dir);
        let (_, access) = enabled(&dir);
        // The file is swapped for a folder while the user is in the folder panel.
        struct SwapPanels<'a>(&'a Path, ScriptedPanels);
        impl Panels for SwapPanels<'_> {
            fn run(&self, request: PanelRequest) -> Result<Option<PanelResult>, String> {
                std::fs::remove_file(self.0).unwrap();
                std::fs::create_dir(self.0).unwrap();
                self.1.run(request)
            }
        }
        let panels = SwapPanels(&db, ScriptedPanels::new(vec![Some(folder)]));
        assert!(database(
            &panels,
            &access,
            DatabaseMode::Open,
            Some(db.to_str().unwrap())
        )
        .is_err());
        assert!(!dir.path().join("grants.json").exists());
    }

    #[test]
    fn ssh_key_recovery_rejects_a_different_file() {
        let dir = TempDir::new();
        let key = dir.path().join("id_ed25519");
        let other = dir.path().join("id_rsa");
        std::fs::write(&key, b"k").unwrap();
        std::fs::write(&other, b"k").unwrap();
        let (_, access) = enabled(&dir);
        let panels = ScriptedPanels::new(vec![Some(other)]);
        assert_eq!(
            ssh_key(&panels, &access, Some(key.to_str().unwrap())).unwrap_err(),
            error::WRONG_FILE
        );
        let panels = ScriptedPanels::new(vec![Some(key.clone())]);
        assert_eq!(
            ssh_key(&panels, &access, Some(key.to_str().unwrap()))
                .unwrap()
                .as_deref(),
            key.to_str()
        );
        assert_eq!(panels.seen.borrow()[0].2, Some(true));
    }

    #[test]
    fn direct_ssh_key_pick_creates_no_bookmark() {
        let dir = TempDir::new();
        let key = dir.path().join("id_ed25519");
        std::fs::write(&key, b"k").unwrap();
        let panels = ScriptedPanels::new(vec![Some(key.clone())]);
        assert_eq!(
            ssh_key(&panels, &FileAccess::disabled(), None)
                .unwrap()
                .as_deref(),
            key.to_str()
        );
        assert_eq!(panels.seen.borrow()[0].2, None);
    }
}
