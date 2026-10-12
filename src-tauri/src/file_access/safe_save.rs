//! Where an export is staged before it replaces the user's chosen file (plan B3).
//!
//! Direct builds stage next to the destination and rename. A save panel in the sandbox
//! grants only the chosen file, not its folder, so App Store builds stage in the
//! system's replacement directory for that volume and publish with
//! `replaceItemAtURL` / `moveItemAtURL`. Either way the destination is untouched until
//! publication succeeds.

use std::path::{Path, PathBuf};

use crate::file_storage;

/// A staged export owned by one session.
#[derive(Debug)]
pub struct Staged {
    pub temp_path: PathBuf,
    /// Directory to remove with the staged file (replacement directory).
    cleanup_dir: Option<PathBuf>,
}

pub trait SafeSave: Send + Sync {
    fn stage(&self, final_path: &Path, token: &str) -> Result<Staged, String>;
    /// Flushes and publishes. On error the destination is unchanged.
    fn publish(&self, staged: &Staged, final_path: &Path) -> Result<(), String>;
    /// Removes only what `stage` created.
    fn discard(&self, staged: &Staged);
}

pub fn for_distribution() -> &'static dyn SafeSave {
    #[cfg(target_os = "macos")]
    if crate::distribution::Distribution::current().requires_file_grants() {
        return &replacement::ReplacementDirectory;
    }
    &Sibling
}

/// Exclusive temp file next to the destination (existing direct-build behavior).
pub struct Sibling;

impl SafeSave for Sibling {
    fn stage(&self, final_path: &Path, token: &str) -> Result<Staged, String> {
        Ok(Staged {
            temp_path: file_storage::export_create_temp(final_path, token)?,
            cleanup_dir: None,
        })
    }

    fn publish(&self, staged: &Staged, final_path: &Path) -> Result<(), String> {
        file_storage::export_publish_temp(&staged.temp_path, final_path)
    }

    fn discard(&self, staged: &Staged) {
        let _ = file_storage::export_discard_temp(&staged.temp_path);
    }
}

#[cfg(target_os = "macos")]
pub mod replacement {
    use super::*;
    use objc2_foundation::{
        NSFileManager, NSFileManagerItemReplacementOptions, NSSearchPathDirectory,
        NSSearchPathDomainMask, NSURL,
    };

    pub struct ReplacementDirectory;

    impl SafeSave for ReplacementDirectory {
        fn stage(&self, final_path: &Path, token: &str) -> Result<Staged, String> {
            // Only the volume of `appropriateForURL` matters. Passing a destination that
            // does not exist yet makes Foundation create it as an empty file on some
            // systems, so pass its (existing) folder instead: the destination must stay
            // untouched until publication.
            let folder = final_path
                .parent()
                .and_then(NSURL::from_directory_path)
                .ok_or("Invalid export path".to_string())?;
            let dir = NSFileManager::defaultManager()
                .URLForDirectory_inDomain_appropriateForURL_create_error(
                    NSSearchPathDirectory::ItemReplacementDirectory,
                    NSSearchPathDomainMask::UserDomainMask,
                    Some(&folder),
                    true,
                )
                .map_err(|_| "Create export staging directory failed".to_string())?
                .to_file_path()
                .ok_or("Create export staging directory failed".to_string())?;
            let name = final_path
                .file_name()
                .ok_or("Invalid export path".to_string())?;
            let temp_path =
                file_storage::export_create_temp(&dir.join(name), token).map_err(|e| {
                    let _ = std::fs::remove_dir_all(&dir);
                    e
                })?;
            Ok(Staged {
                temp_path,
                cleanup_dir: Some(dir),
            })
        }

        fn publish(&self, staged: &Staged, final_path: &Path) -> Result<(), String> {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&staged.temp_path)
                .and_then(|f| f.sync_all())
                .map_err(|_| "Sync export temp failed".to_string())?;
            let new_item = NSURL::from_file_path(&staged.temp_path)
                .ok_or("Invalid export temp path".to_string())?;
            let destination =
                NSURL::from_file_path(final_path).ok_or("Invalid export path".to_string())?;
            let manager = NSFileManager::defaultManager();
            let published = if final_path.exists() {
                // Keeps the original's metadata; on failure the original is untouched.
                manager
                    .replaceItemAtURL_withItemAtURL_backupItemName_options_resultingItemURL_error(
                        &destination,
                        &new_item,
                        None,
                        NSFileManagerItemReplacementOptions::empty(),
                        None,
                    )
            } else {
                manager.moveItemAtURL_toURL_error(&new_item, &destination)
            };
            published.map_err(|_| "Publish export failed".to_string())?;
            // Published: cleanup problems must not turn success into an error.
            if let Some(dir) = &staged.cleanup_dir {
                let _ = std::fs::remove_dir_all(dir);
            }
            Ok(())
        }

        fn discard(&self, staged: &Staged) {
            let _ = file_storage::export_discard_temp(&staged.temp_path);
            if let Some(dir) = &staged.cleanup_dir {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_access::test_support::TempDir;

    fn savers() -> Vec<(&'static str, Box<dyn SafeSave>)> {
        #[allow(unused_mut)]
        let mut all: Vec<(&'static str, Box<dyn SafeSave>)> = vec![("sibling", Box::new(Sibling))];
        #[cfg(target_os = "macos")]
        all.push(("replacement", Box::new(replacement::ReplacementDirectory)));
        all
    }

    fn write(staged: &Staged, bytes: &[u8]) {
        std::fs::write(&staged.temp_path, bytes).unwrap();
    }

    #[test]
    fn publishes_new_and_existing_destinations() {
        for (name, saver) in savers() {
            let dir = TempDir::new();
            let target = dir.path().join("out.csv");
            let staged = saver.stage(&target, "t1").unwrap();
            assert!(
                !target.exists(),
                "{name}: staging must not create the destination"
            );
            write(&staged, b"NEW");
            saver.publish(&staged, &target).unwrap();
            assert_eq!(std::fs::read(&target).unwrap(), b"NEW", "{name}");

            let staged = saver.stage(&target, "t2").unwrap();
            write(&staged, b"NEWER");
            saver.publish(&staged, &target).unwrap();
            assert_eq!(std::fs::read(&target).unwrap(), b"NEWER", "{name}");
            assert!(!staged.temp_path.exists(), "{name}: no residue");
            if let Some(cleanup) = &staged.cleanup_dir {
                assert!(!cleanup.exists(), "{name}: staging dir removed");
            }
        }
    }

    #[test]
    fn discard_keeps_the_original() {
        for (name, saver) in savers() {
            let dir = TempDir::new();
            let target = dir.path().join("out.csv");
            std::fs::write(&target, b"ORIGINAL").unwrap();
            let staged = saver.stage(&target, "t").unwrap();
            write(&staged, b"PARTIAL");
            saver.discard(&staged);
            assert_eq!(std::fs::read(&target).unwrap(), b"ORIGINAL", "{name}");
            assert!(!staged.temp_path.exists(), "{name}");

            // A new destination stays absent through stage and discard.
            let fresh = dir.path().join("fresh.csv");
            let staged = saver.stage(&fresh, "t2").unwrap();
            assert!(!fresh.exists(), "{name}: stage must not create it");
            write(&staged, b"PARTIAL");
            saver.discard(&staged);
            assert!(!fresh.exists(), "{name}: discard must not leave it");
        }
    }

    #[test]
    fn failed_publish_keeps_the_original() {
        for (name, saver) in savers() {
            let dir = TempDir::new();
            let target = dir.path().join("out.csv");
            std::fs::write(&target, b"ORIGINAL").unwrap();
            let staged = saver.stage(&target, "t").unwrap();
            // The staged file vanished (e.g. cleaned up underneath us): publication fails.
            std::fs::remove_file(&staged.temp_path).unwrap();
            assert!(saver.publish(&staged, &target).is_err(), "{name}");
            assert_eq!(std::fs::read(&target).unwrap(), b"ORIGINAL", "{name}");
            saver.discard(&staged);
        }
    }
}
