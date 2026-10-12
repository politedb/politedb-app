//! Checks on picker results before anything is bookmarked (fail closed, plan rev. 3).

use std::path::{Path, PathBuf};

use super::error;
use super::service::normalize_absolute;

/// An existing regular file: not a symlink or Finder alias, and no symlinked folder in
/// its path (the canonical path must equal the given one). Returns that path.
pub fn existing_file(path: &Path) -> Result<PathBuf, String> {
    let path = normalize_absolute(path)?;
    let meta = std::fs::symlink_metadata(&path).map_err(|_| error::INVALID_PATH.to_string())?;
    if !meta.file_type().is_file() || is_finder_alias(&path) {
        return Err(error::UNSUPPORTED_ITEM.into());
    }
    without_symlinks(&path)
}

/// Fails unless `path` resolves to itself (no symlinked component anywhere).
fn without_symlinks(path: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path).map_err(|_| error::INVALID_PATH.to_string())?;
    if canonical != path {
        return Err(error::UNSUPPORTED_ITEM.into());
    }
    Ok(canonical)
}

/// Direct (unsandboxed) builds keep their previous picker behavior: any absolute path,
/// including symlinks and aliases, exactly as the panel returned it.
pub fn lenient(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(error::INVALID_PATH.into());
    }
    Ok(path.to_path_buf())
}

/// Stable identity of an item (`device:inode`), stored with a grant so a different item
/// later found at the same path is not trusted.
#[cfg(unix)]
pub fn file_id(path: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(path)
        .ok()
        .map(|meta| format!("{}:{}", meta.dev(), meta.ino()))
}

#[cfg(not(unix))]
pub fn file_id(_path: &Path) -> Option<String> {
    None
}

/// Finder alias files are regular files starting with `book\0\0\0\0mark`; they point
/// elsewhere, so they are rejected like symlinks.
fn is_finder_alias(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 12];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .is_ok_and(|_| &head[..4] == b"book" && &head[8..12] == b"mark")
}

/// A file to create (save panel): its folder must exist; an existing target must be a
/// regular file. Returns `canonical(folder)/name`; the file need not exist.
pub fn new_file(path: &Path) -> Result<PathBuf, String> {
    let path = normalize_absolute(path)?;
    let name = path
        .file_name()
        .filter(|n| !n.is_empty())
        .ok_or_else(|| error::INVALID_PATH.to_string())?
        .to_owned();
    let parent = path
        .parent()
        .ok_or_else(|| error::INVALID_PATH.to_string())?;
    let parent = without_symlinks(parent)?;
    if !parent.is_dir() {
        return Err(error::INVALID_PATH.into());
    }
    let target = parent.join(name);
    match std::fs::symlink_metadata(&target) {
        // Replacing an existing file: it must be a plain file like any opened one.
        Ok(meta) if !meta.file_type().is_file() || is_finder_alias(&target) => {
            Err(error::UNSUPPORTED_ITEM.into())
        }
        Ok(_) => Ok(target),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(target),
        Err(_) => Err(error::INVALID_PATH.into()),
    }
}

/// The folder picked for a database must be exactly the database's parent (plan D17)
/// and not a whole disk or home folder.
pub fn database_folder(
    folder: &Path,
    database: &Path,
    home: Option<&Path>,
) -> Result<PathBuf, String> {
    let folder = normalize_absolute(folder)?;
    let meta = std::fs::symlink_metadata(&folder).map_err(|_| error::INVALID_PATH.to_string())?;
    if !meta.file_type().is_dir() {
        return Err(error::UNSUPPORTED_ITEM.into());
    }
    let folder = without_symlinks(&folder)?;
    let expected = database
        .parent()
        .ok_or_else(|| error::INVALID_PATH.to_string())?;
    if folder != expected {
        return Err(error::WRONG_FILE.into());
    }
    if too_broad(&folder, home) {
        return Err(error::FOLDER_TOO_BROAD.into());
    }
    Ok(folder)
}

/// `/`, a mounted volume root (`/Volumes/<name>`) or the user's home folder.
fn too_broad(folder: &Path, home: Option<&Path>) -> bool {
    let depth = folder.components().count();
    if depth <= 1 {
        return true;
    }
    if folder.starts_with("/Volumes") && depth <= 3 {
        return true;
    }
    home.is_some_and(|home| folder == home)
}

/// Whether `selected` (canonical, from a picker) is the item a profile refers to.
/// `expected` may be typed or imported, so it is compared lexically and canonically.
pub fn is_expected(expected: &str, selected: &Path) -> bool {
    let Ok(expected) = normalize_absolute(Path::new(expected.trim())) else {
        return false;
    };
    if expected == selected {
        return true;
    }
    let (Some(parent), Some(name)) = (expected.parent(), expected.file_name()) else {
        return false;
    };
    std::fs::canonicalize(parent).is_ok_and(|parent| parent.join(name) == selected)
}

/// The account's real home folder. In the sandbox `$HOME` points into the container,
/// so ask the user database instead.
#[cfg(unix)]
pub fn real_home() -> Option<PathBuf> {
    use std::ffi::CStr;
    // SAFETY: getpwuid returns a pointer into static storage or null; we copy the
    // directory string out immediately.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_dir.is_null() {
            return None;
        }
        let dir = CStr::from_ptr((*pw).pw_dir).to_string_lossy().into_owned();
        std::fs::canonicalize(dir).ok()
    }
}

#[cfg(not(unix))]
pub fn real_home() -> Option<PathBuf> {
    dirs::home_dir()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_access::test_support::TempDir;

    #[test]
    fn existing_file_accepts_regular_files_only() {
        let dir = TempDir::new();
        let file = dir.path().join("app.db");
        std::fs::write(&file, b"").unwrap();
        assert_eq!(existing_file(&file).unwrap(), file);
        assert_eq!(
            existing_file(dir.path()).unwrap_err(),
            error::UNSUPPORTED_ITEM
        );
        assert_eq!(
            existing_file(Path::new("app.db")).unwrap_err(),
            error::INVALID_PATH
        );
        assert_eq!(
            existing_file(&dir.path().join("x/../app.db")).unwrap_err(),
            error::INVALID_PATH
        );
    }

    #[test]
    fn finder_aliases_are_rejected() {
        let dir = TempDir::new();
        let alias = dir.path().join("alias.db");
        std::fs::write(&alias, b"book\0\0\0\0mark\0\0\0\0rest").unwrap();
        assert_eq!(existing_file(&alias).unwrap_err(), error::UNSUPPORTED_ITEM);
        assert_eq!(new_file(&alias).unwrap_err(), error::UNSUPPORTED_ITEM);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_folders_in_the_path_are_rejected() {
        let dir = TempDir::new();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::write(real.join("app.db"), b"").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(
            existing_file(&link.join("app.db")).unwrap_err(),
            error::UNSUPPORTED_ITEM
        );
        assert_eq!(
            new_file(&link.join("new.db")).unwrap_err(),
            error::UNSUPPORTED_ITEM
        );
        assert_eq!(
            database_folder(&link, &real.join("app.db"), None).unwrap_err(),
            error::UNSUPPORTED_ITEM
        );
    }

    #[test]
    fn lenient_keeps_any_absolute_path() {
        assert_eq!(
            lenient(Path::new("/a/../b/link")).unwrap(),
            Path::new("/a/../b/link")
        );
        assert_eq!(lenient(Path::new("rel")).unwrap_err(), error::INVALID_PATH);
    }

    #[cfg(unix)]
    #[test]
    fn file_ids_change_when_an_item_is_replaced() {
        let dir = TempDir::new();
        let a = dir.path().join("a");
        std::fs::create_dir(&a).unwrap();
        let before = file_id(&a).unwrap();
        std::fs::remove_dir(&a).unwrap();
        std::fs::write(dir.path().join("spacer"), b"x").unwrap();
        std::fs::create_dir(&a).unwrap();
        assert_ne!(Some(before), file_id(&a));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_rejected() {
        let dir = TempDir::new();
        let file = dir.path().join("real.db");
        std::fs::write(&file, b"").unwrap();
        let link = dir.path().join("link.db");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert_eq!(existing_file(&link).unwrap_err(), error::UNSUPPORTED_ITEM);
        assert_eq!(new_file(&link).unwrap_err(), error::UNSUPPORTED_ITEM);
    }

    #[test]
    fn new_file_needs_an_existing_folder() {
        let dir = TempDir::new();
        let target = dir.path().join("new.db");
        assert_eq!(new_file(&target).unwrap(), target);
        assert_eq!(
            new_file(&dir.path().join("nope/new.db")).unwrap_err(),
            error::INVALID_PATH
        );
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        assert_eq!(
            new_file(&dir.path().join("sub")).unwrap_err(),
            error::UNSUPPORTED_ITEM
        );
    }

    #[test]
    fn database_folder_must_be_the_exact_parent() {
        let dir = TempDir::new();
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let db = sub.join("app.db");
        assert_eq!(database_folder(&sub, &db, None).unwrap(), sub);
        // An ancestor would grant more than the user agreed to.
        assert_eq!(
            database_folder(dir.path(), &db, None).unwrap_err(),
            error::WRONG_FILE
        );
        assert_eq!(
            database_folder(&sub, &db, Some(&sub)).unwrap_err(),
            error::FOLDER_TOO_BROAD
        );
    }

    #[test]
    fn broad_folders_are_detected() {
        assert!(too_broad(Path::new("/"), None));
        assert!(too_broad(Path::new("/Volumes/Backup"), None));
        assert!(!too_broad(Path::new("/Volumes/Backup/db"), None));
        assert!(!too_broad(
            Path::new("/Users/me/db"),
            Some(Path::new("/Users/me"))
        ));
    }

    #[test]
    fn expected_paths_match_lexically_or_canonically() {
        let dir = TempDir::new();
        let db = dir.path().join("app.db");
        assert!(is_expected(db.to_str().unwrap(), &db));
        let dotted = format!("{}/./app.db", dir.path().display());
        assert!(is_expected(&dotted, &db));
        assert!(!is_expected(
            dir.path().join("other.db").to_str().unwrap(),
            &db
        ));
        assert!(!is_expected("relative.db", &db));
    }
}
