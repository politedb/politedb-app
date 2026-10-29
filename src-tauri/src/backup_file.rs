//! Backup files written whole into a temp sibling of the destination and
//! published by rename, so the destination keeps its previous content
//! unless publishing succeeds. Unlike export sessions (appended text), a
//! backup is written once, as bytes, and every terminal step reports what
//! it did: a temp that could not be removed is said so, and a published
//! session leaves a tombstone, so a late or repeated call is answered
//! consistently ("already published") instead of "not found".

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use uuid::Uuid;

use crate::file_storage;

pub const ALREADY_PUBLISHED: &str = "BACKUP_FILE_ALREADY_PUBLISHED";
pub const TEMP_NOT_REMOVED: &str = "BACKUP_FILE_TEMP_NOT_REMOVED";
pub const NOT_FOUND: &str = "BACKUP_FILE_NOT_FOUND";
pub const WRONG_STATE: &str = "BACKUP_FILE_WRONG_STATE";
pub const WRITE_FAILED: &str = "BACKUP_FILE_WRITE_FAILED";
pub const PUBLISH_FAILED: &str = "BACKUP_FILE_PUBLISH_FAILED";
pub const BEGIN_FAILED: &str = "BACKUP_FILE_BEGIN_FAILED";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    /// Temp created, nothing written.
    Open,
    /// The whole backup is in the temp.
    Written,
    WriteFailed,
    PublishFailed,
    /// Removing the temp failed; abort may be tried again.
    AbortFailed,
    /// Renamed onto the destination. Kept, without paths, as a tombstone.
    Published,
}

struct Session {
    state: State,
    /// None once published (nothing on disk is owned any more).
    paths: Option<(PathBuf, PathBuf)>,
}

/// Sessions by id. One lock for all: every step is a short file operation.
pub struct BackupFiles {
    sessions: Mutex<HashMap<Uuid, Session>>,
}

static BACKUP_FILES: OnceLock<BackupFiles> = OnceLock::new();

/// The app's backup file sessions.
pub fn backup_files() -> &'static BackupFiles {
    BACKUP_FILES.get_or_init(BackupFiles::new)
}

impl BackupFiles {
    fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Uuid, Session>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Creates an exclusive temp sibling of `final_path`.
    pub fn begin(&self, final_path: PathBuf) -> Result<Uuid, String> {
        if final_path.as_os_str().is_empty() {
            return Err(BEGIN_FAILED.into());
        }
        let id = Uuid::new_v4();
        let temp = file_storage::export_create_temp(&final_path, &id.to_string())
            .map_err(|_| BEGIN_FAILED.to_string())?;
        self.lock().insert(
            id,
            Session {
                state: State::Open,
                paths: Some((temp, final_path)),
            },
        );
        Ok(id)
    }

    /// Writes the whole backup, once.
    pub fn write(&self, id: Uuid, bytes: &[u8]) -> Result<(), String> {
        let mut sessions = self.lock();
        let session = sessions.get_mut(&id).ok_or(NOT_FOUND)?;
        match (session.state, &session.paths) {
            (State::Published, _) => Err(ALREADY_PUBLISHED.into()),
            (State::Open, Some((temp, _))) => {
                if std::fs::write(temp, bytes).is_ok() {
                    session.state = State::Written;
                    Ok(())
                } else {
                    session.state = State::WriteFailed;
                    Err(WRITE_FAILED.into())
                }
            }
            _ => Err(WRONG_STATE.into()),
        }
    }

    /// Renames the written temp onto the destination. On failure the
    /// destination keeps its content and the temp waits for abort.
    pub fn publish(&self, id: Uuid) -> Result<(), String> {
        let mut sessions = self.lock();
        let session = sessions.get_mut(&id).ok_or(NOT_FOUND)?;
        match (session.state, &session.paths) {
            (State::Published, _) => Err(ALREADY_PUBLISHED.into()),
            (State::Written, Some((temp, dest))) => {
                if file_storage::export_publish_temp(temp, dest).is_ok() {
                    session.state = State::Published;
                    session.paths = None;
                    Ok(())
                } else {
                    session.state = State::PublishFailed;
                    Err(PUBLISH_FAILED.into())
                }
            }
            _ => Err(WRONG_STATE.into()),
        }
    }

    /// Removes the temp of a session not published. Nothing owned (aborted
    /// before, unknown) is Ok; a published one answers ALREADY_PUBLISHED.
    /// A failed removal keeps the session so abort can be tried again.
    pub fn abort(&self, id: Uuid) -> Result<(), String> {
        let mut sessions = self.lock();
        let Some(session) = sessions.get_mut(&id) else {
            return Ok(());
        };
        if session.state == State::Published {
            return Err(ALREADY_PUBLISHED.into());
        }
        let removed = match &session.paths {
            Some((temp, _)) => file_storage::export_discard_temp(temp).is_ok(),
            None => true,
        };
        if removed {
            sessions.remove(&id);
            Ok(())
        } else {
            session.state = State::AbortFailed;
            Err(TEMP_NOT_REMOVED.into())
        }
    }

    /// Lets go of a session whose temp could not be removed (it stays on
    /// disk; the user was told). Only from AbortFailed: never a tombstone.
    pub fn forget(&self, id: Uuid) -> Result<(), String> {
        let mut sessions = self.lock();
        match sessions.get(&id).map(|s| s.state) {
            None => Ok(()),
            Some(State::AbortFailed) => {
                sessions.remove(&id);
                Ok(())
            }
            Some(State::Published) => Err(ALREADY_PUBLISHED.into()),
            Some(_) => Err(WRONG_STATE.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("politedb-backup-file-{}", Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn temps(d: &std::path::Path) -> usize {
        fs::read_dir(d)
            .unwrap()
            .filter(|e| file_storage::is_export_temp_path(&e.as_ref().unwrap().path()))
            .count()
    }

    #[test]
    fn writes_bytes_once_and_publishes_over_the_destination() {
        let files = BackupFiles::new();
        let d = dir();
        let dest = d.join("shop.dumb");
        fs::write(&dest, b"old").unwrap();
        let id = files.begin(dest.clone()).unwrap();
        // Nothing to publish yet.
        assert_eq!(files.publish(id), Err(WRONG_STATE.into()));
        let bytes: Vec<u8> = (0..=255).collect();
        files.write(id, &bytes).unwrap();
        assert_eq!(files.write(id, b"again"), Err(WRONG_STATE.into()));
        assert_eq!(fs::read(&dest).unwrap(), b"old", "untouched before publish");
        files.publish(id).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), bytes);
        assert_eq!(temps(&d), 0);
        // The tombstone answers every later call the same way.
        assert_eq!(files.publish(id), Err(ALREADY_PUBLISHED.into()));
        assert_eq!(files.abort(id), Err(ALREADY_PUBLISHED.into()));
        assert_eq!(files.write(id, b"x"), Err(ALREADY_PUBLISHED.into()));
        assert_eq!(files.forget(id), Err(ALREADY_PUBLISHED.into()));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn abort_after_writing_removes_the_temp_and_keeps_the_destination() {
        let files = BackupFiles::new();
        let d = dir();
        let dest = d.join("shop.dumb");
        fs::write(&dest, b"old").unwrap();
        let id = files.begin(dest.clone()).unwrap();
        files.write(id, b"new").unwrap();
        files.abort(id).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"old");
        assert_eq!(temps(&d), 0);
        // Nothing owned any more: repeated abort is fine, publish is not.
        files.abort(id).unwrap();
        assert_eq!(files.publish(id), Err(NOT_FOUND.into()));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_failed_write_cannot_be_published() {
        let files = BackupFiles::new();
        let d = dir();
        let id = files.begin(d.join("shop.dumb")).unwrap();
        // The temp replaced by a directory: writing it fails.
        let temp = {
            let s = files.lock();
            s.get(&id).unwrap().paths.as_ref().unwrap().0.clone()
        };
        fs::remove_file(&temp).unwrap();
        fs::create_dir(&temp).unwrap();
        assert_eq!(files.write(id, b"x"), Err(WRITE_FAILED.into()));
        assert_eq!(files.publish(id), Err(WRONG_STATE.into()));
        assert!(!d.join("shop.dumb").exists());
        fs::remove_dir_all(d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_temp_that_cannot_be_removed_is_reported_and_abort_can_retry() {
        use std::os::unix::fs::PermissionsExt;
        let files = BackupFiles::new();
        let d = dir();
        let id = files.begin(d.join("shop.dumb")).unwrap();
        files.write(id, b"new").unwrap();
        // A read-only directory: its entries cannot be removed.
        fs::set_permissions(&d, fs::Permissions::from_mode(0o555)).unwrap();
        assert_eq!(files.abort(id), Err(TEMP_NOT_REMOVED.into()));
        assert_eq!(files.publish(id), Err(WRONG_STATE.into()));
        fs::set_permissions(&d, fs::Permissions::from_mode(0o755)).unwrap();
        files.abort(id).unwrap();
        assert_eq!(temps(&d), 0);
        fs::remove_dir_all(d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn forget_lets_go_of_a_temp_left_behind_only() {
        use std::os::unix::fs::PermissionsExt;
        let files = BackupFiles::new();
        let d = dir();
        let id = files.begin(d.join("shop.dumb")).unwrap();
        assert_eq!(files.forget(id), Err(WRONG_STATE.into()));
        fs::set_permissions(&d, fs::Permissions::from_mode(0o555)).unwrap();
        assert_eq!(files.abort(id), Err(TEMP_NOT_REMOVED.into()));
        files.forget(id).unwrap();
        fs::set_permissions(&d, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(temps(&d), 1, "left on disk, as reported");
        assert_eq!(files.abort(id), Ok(()), "nothing owned any more");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_failed_publish_keeps_the_destination_and_waits_for_abort() {
        let files = BackupFiles::new();
        let d = dir();
        // The destination is a non-empty directory: rename onto it fails.
        let dest = d.join("shop.dumb");
        fs::create_dir(&dest).unwrap();
        fs::write(dest.join("keep"), b"k").unwrap();
        let id = files.begin(dest.clone()).unwrap();
        files.write(id, b"new").unwrap();
        assert_eq!(files.publish(id), Err(PUBLISH_FAILED.into()));
        assert_eq!(fs::read(dest.join("keep")).unwrap(), b"k");
        assert_eq!(files.publish(id), Err(WRONG_STATE.into()));
        files.abort(id).unwrap();
        assert_eq!(temps(&d), 0);
        fs::remove_dir_all(d).unwrap();
    }
}
