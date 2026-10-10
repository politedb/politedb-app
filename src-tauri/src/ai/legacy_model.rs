//! Cleanup of the model downloaded by the removed bundled runtime (plan D10).
//!
//! Only two fixed files are ever touched: `<app_data>/ai/models/default.gguf` and its
//! interrupted-download sibling `default.gguf.part`. Traversal never follows links:
//! - Unix: `openat(O_DIRECTORY|O_NOFOLLOW)` for `ai` and `models`, then `fstatat` +
//!   `unlinkat` relative to the held `models` handle, so swapping an ancestor after the
//!   check cannot redirect the delete.
//! - Windows: `ai` and `models` are opened without `FILE_SHARE_DELETE` (they cannot be
//!   renamed or replaced while held) and rejected if they are reparse points; the target
//!   is opened with `FILE_FLAG_OPEN_REPARSE_POINT`, checked, and deleted via its handle.
//!
//! Directories are never removed; `ai/providers.json` is never touched.

use std::path::Path;

use serde::Serialize;

pub const FILE_NAMES: [&str; 2] = ["default.gguf", "default.gguf.part"];
pub const UNSAFE_PATH: &str = "AI_LEGACY_MODEL_UNSAFE_PATH";
pub const IO_FAILED: &str = "AI_LEGACY_MODEL_IO_FAILED";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyModelFile {
    pub name: String,
    pub size_bytes: u64,
}

/// Fixed legacy files currently present (empty when there is nothing to clean up).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyModelInfo {
    pub files: Vec<LegacyModelFile>,
}

pub fn info(app_data_root: &Path) -> Result<LegacyModelInfo, String> {
    platform::with_models_dir(app_data_root, |dir| {
        let mut files = Vec::new();
        for name in FILE_NAMES {
            if let Some(size_bytes) = dir.regular_file_size(name)? {
                files.push(LegacyModelFile {
                    name: name.to_string(),
                    size_bytes,
                });
            }
        }
        Ok(LegacyModelInfo { files })
    })
}

/// Deletes the fixed files and returns what remains. Absent files count as deleted;
/// a file that could not be deleted stays in the returned list.
pub fn delete(app_data_root: &Path) -> Result<LegacyModelInfo, String> {
    platform::with_models_dir(app_data_root, |dir| {
        let mut remaining = Vec::new();
        for name in FILE_NAMES {
            let Some(size_bytes) = dir.regular_file_size(name)? else {
                continue;
            };
            if dir.delete_regular_file(name).is_err() {
                remaining.push(LegacyModelFile {
                    name: name.to_string(),
                    size_bytes,
                });
            }
        }
        Ok(LegacyModelInfo { files: remaining })
    })
}

#[cfg(unix)]
mod platform {
    use std::ffi::CString;
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    use super::{IO_FAILED, UNSAFE_PATH};

    pub struct ModelsDir(OwnedFd);

    fn cstr(value: &str) -> CString {
        CString::new(value).expect("fixed names contain no NUL")
    }

    fn open_dir(parent: Option<RawFd>, name: &CString) -> io::Result<OwnedFd> {
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC;
        // SAFETY: valid NUL-terminated path; the returned fd is owned below.
        let fd = unsafe {
            match parent {
                Some(dir) => libc::openat(dir, name.as_ptr(), flags | libc::O_NOFOLLOW),
                None => libc::open(name.as_ptr(), flags),
            }
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `fd` is a freshly opened descriptor we exclusively own.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn map_open_error(error: io::Error) -> Result<Option<OwnedFd>, String> {
        match error.raw_os_error() {
            Some(libc::ENOENT) => Ok(None),
            // O_NOFOLLOW on a symlink, or a non-directory where a directory is expected.
            Some(libc::ELOOP) | Some(libc::ENOTDIR) => Err(UNSAFE_PATH.into()),
            _ => Err(IO_FAILED.into()),
        }
    }

    pub fn with_models_dir<T: Default>(
        root: &Path,
        f: impl FnOnce(&ModelsDir) -> Result<T, String>,
    ) -> Result<T, String> {
        let root_c =
            CString::new(root.as_os_str().as_bytes()).map_err(|_| IO_FAILED.to_string())?;
        let root_fd = match open_dir(None, &root_c) {
            Ok(fd) => fd,
            Err(error) => return map_open_error(error).map(|_| T::default()),
        };
        let Some(ai_fd) = open_dir(Some(root_fd.as_raw_fd()), &cstr("ai"))
            .map(Some)
            .or_else(map_open_error)?
        else {
            return Ok(T::default());
        };
        let Some(models_fd) = open_dir(Some(ai_fd.as_raw_fd()), &cstr("models"))
            .map(Some)
            .or_else(map_open_error)?
        else {
            return Ok(T::default());
        };
        f(&ModelsDir(models_fd))
    }

    impl ModelsDir {
        /// Size of `name` if it is a regular file in this directory (links not followed).
        pub fn regular_file_size(&self, name: &str) -> Result<Option<u64>, String> {
            let name = cstr(name);
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            // SAFETY: valid dir fd, NUL-terminated name, writable stat buffer.
            let rc = unsafe {
                libc::fstatat(
                    self.0.as_raw_fd(),
                    name.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            };
            if rc != 0 {
                return match io::Error::last_os_error().raw_os_error() {
                    Some(libc::ENOENT) => Ok(None),
                    _ => Err(IO_FAILED.into()),
                };
            }
            // SAFETY: fstatat succeeded and initialized the buffer.
            let stat = unsafe { stat.assume_init() };
            if (stat.st_mode & libc::S_IFMT) != libc::S_IFREG {
                return Err(UNSAFE_PATH.into());
            }
            Ok(Some(stat.st_size as u64))
        }

        /// Unlinks `name` relative to this directory. A symlink swapped in after the
        /// check is removed as a link; its target is never touched.
        pub fn delete_regular_file(&self, name: &str) -> Result<(), String> {
            let name = cstr(name);
            // SAFETY: valid dir fd and NUL-terminated name.
            let rc = unsafe { libc::unlinkat(self.0.as_raw_fd(), name.as_ptr(), 0) };
            if rc == 0 {
                return Ok(());
            }
            match io::Error::last_os_error().raw_os_error() {
                Some(libc::ENOENT) => Ok(()),
                _ => Err(IO_FAILED.into()),
            }
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, HANDLE,
    };
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FileAttributeTagInfo, FileDispositionInfo, FileStandardInfo,
        GetFileInformationByHandleEx, GetFinalPathNameByHandleW, SetFileInformationByHandle,
        DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
        FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_GENERIC_READ, FILE_NAME_NORMALIZED, FILE_SHARE_READ, FILE_SHARE_WRITE,
        FILE_STANDARD_INFO, OPEN_EXISTING,
    };

    use super::{IO_FAILED, UNSAFE_PATH};

    struct Handle(HANDLE);

    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: handle was returned by CreateFileW and is closed once.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    pub struct ModelsDir {
        path: PathBuf,
        /// Final path of the held `models` directory, for target parent verification.
        final_path: PathBuf,
        // Held for the whole operation so neither ancestor can be renamed or replaced.
        _ai: Handle,
        _models: Handle,
    }

    /// Resolved path of an open handle (`\\?\` form), compared case-insensitively.
    fn final_path(handle: &Handle) -> Result<PathBuf, String> {
        use std::os::windows::ffi::OsStringExt;
        let mut buf = vec![0u16; 1024];
        // SAFETY: valid handle; buffer length passed matches the allocation.
        let len =
            unsafe { GetFinalPathNameByHandleW(handle.0, &mut buf, FILE_NAME_NORMALIZED) } as usize;
        if len == 0 || len >= buf.len() {
            return Err(IO_FAILED.into());
        }
        Ok(PathBuf::from(std::ffi::OsString::from_wide(&buf[..len])))
    }

    fn same_path(a: &Path, b: &Path) -> bool {
        a.as_os_str().to_string_lossy().to_lowercase()
            == b.as_os_str().to_string_lossy().to_lowercase()
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    fn open(path: &Path, access: u32) -> Result<Option<Handle>, String> {
        let name = wide(path);
        // SAFETY: NUL-terminated wide path; handle ownership moves into `Handle`.
        let result = unsafe {
            CreateFileW(
                PCWSTR(name.as_ptr()),
                access,
                // No FILE_SHARE_DELETE: blocks rename/replace while we hold the handle.
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                HANDLE::default(),
            )
        };
        match result {
            Ok(handle) => Ok(Some(Handle(handle))),
            Err(_) => {
                // SAFETY: reads the thread's last error code.
                let code = unsafe { GetLastError() };
                if code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND {
                    Ok(None)
                } else {
                    Err(IO_FAILED.into())
                }
            }
        }
    }

    fn attributes(handle: &Handle) -> Result<u32, String> {
        let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
        // SAFETY: buffer matches the requested information class.
        unsafe {
            GetFileInformationByHandleEx(
                handle.0,
                FileAttributeTagInfo,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
            )
        }
        .map_err(|_| IO_FAILED.to_string())?;
        Ok(info.FileAttributes)
    }

    fn require_plain_dir(handle: &Handle) -> Result<(), String> {
        let attrs = attributes(handle)?;
        if attrs & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 || attrs & FILE_ATTRIBUTE_DIRECTORY.0 == 0 {
            return Err(UNSAFE_PATH.into());
        }
        Ok(())
    }

    pub fn with_models_dir<T: Default>(
        root: &Path,
        f: impl FnOnce(&ModelsDir) -> Result<T, String>,
    ) -> Result<T, String> {
        let ai_path = root.join("ai");
        let Some(ai) = open(&ai_path, FILE_GENERIC_READ.0)? else {
            return Ok(T::default());
        };
        require_plain_dir(&ai)?;
        let models_path = ai_path.join("models");
        let Some(models) = open(&models_path, FILE_GENERIC_READ.0)? else {
            return Ok(T::default());
        };
        require_plain_dir(&models)?;
        let final_path = final_path(&models)?;
        f(&ModelsDir {
            path: models_path,
            final_path,
            _ai: ai,
            _models: models,
        })
    }

    impl ModelsDir {
        fn open_regular(&self, name: &str, access: u32) -> Result<Option<(Handle, u64)>, String> {
            let Some(handle) = open(&self.path.join(name), access)? else {
                return Ok(None);
            };
            let attrs = attributes(&handle)?;
            if attrs & (FILE_ATTRIBUTE_REPARSE_POINT.0 | FILE_ATTRIBUTE_DIRECTORY.0) != 0 {
                return Err(UNSAFE_PATH.into());
            }
            // The opened file must live directly in the held `models` directory.
            let target = final_path(&handle)?;
            if !target
                .parent()
                .is_some_and(|parent| same_path(parent, &self.final_path))
            {
                return Err(UNSAFE_PATH.into());
            }
            let mut info = FILE_STANDARD_INFO::default();
            // SAFETY: buffer matches the requested information class.
            unsafe {
                GetFileInformationByHandleEx(
                    handle.0,
                    FileStandardInfo,
                    &mut info as *mut _ as *mut _,
                    std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
                )
            }
            .map_err(|_| IO_FAILED.to_string())?;
            Ok(Some((handle, info.EndOfFile as u64)))
        }

        pub fn regular_file_size(&self, name: &str) -> Result<Option<u64>, String> {
            Ok(self
                .open_regular(name, FILE_GENERIC_READ.0)?
                .map(|(_, size)| size))
        }

        pub fn delete_regular_file(&self, name: &str) -> Result<(), String> {
            let Some((handle, _)) = self.open_regular(name, DELETE.0 | FILE_GENERIC_READ.0)? else {
                return Ok(());
            };
            let info = FILE_DISPOSITION_INFO {
                DeleteFile: true.into(),
            };
            // SAFETY: valid handle opened with DELETE access; buffer matches the class.
            unsafe {
                SetFileInformationByHandle(
                    handle.0,
                    FileDispositionInfo,
                    &info as *const _ as *const _,
                    std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
                )
            }
            .map_err(|_| IO_FAILED.to_string())
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::path::PathBuf;

    fn root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("politedb-legacy-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("ai/models")).unwrap();
        fs::write(dir.join("ai/providers.json"), "{}").unwrap();
        dir
    }

    fn names(info: &LegacyModelInfo) -> Vec<&str> {
        info.files.iter().map(|f| f.name.as_str()).collect()
    }

    #[test]
    fn reports_and_deletes_full_and_partial_files() {
        let root = root();
        fs::write(root.join("ai/models/default.gguf"), "abcd").unwrap();
        fs::write(root.join("ai/models/default.gguf.part"), "ab").unwrap();
        let found = info(&root).unwrap();
        assert_eq!(
            found.files,
            vec![
                LegacyModelFile {
                    name: "default.gguf".into(),
                    size_bytes: 4
                },
                LegacyModelFile {
                    name: "default.gguf.part".into(),
                    size_bytes: 2
                },
            ]
        );
        assert!(delete(&root).unwrap().files.is_empty());
        assert!(info(&root).unwrap().files.is_empty());
        assert!(root.join("ai/models").is_dir());
        assert_eq!(
            fs::read_to_string(root.join("ai/providers.json")).unwrap(),
            "{}"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn partial_only_and_neither() {
        let root = root();
        assert!(info(&root).unwrap().files.is_empty());
        fs::write(root.join("ai/models/default.gguf.part"), "x").unwrap();
        assert_eq!(names(&info(&root).unwrap()), vec!["default.gguf.part"]);
        assert!(delete(&root).unwrap().files.is_empty());
        // Repeat delete is a no-op.
        assert!(delete(&root).unwrap().files.is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn missing_directories_mean_nothing_to_clean() {
        let root = std::env::temp_dir().join(format!("politedb-legacy-{}", uuid::Uuid::new_v4()));
        assert!(info(&root).unwrap().files.is_empty());
        fs::create_dir_all(root.join("ai")).unwrap();
        assert!(delete(&root).unwrap().files.is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn permission_denied_reports_remaining_file() {
        let root = root();
        let models = root.join("ai/models");
        fs::write(models.join("default.gguf"), "abcd").unwrap();
        fs::set_permissions(&models, fs::Permissions::from_mode(0o500)).unwrap();
        let remaining = delete(&root);
        fs::set_permissions(&models, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(names(&remaining.unwrap()), vec!["default.gguf"]);
        assert!(models.join("default.gguf").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn refuses_symlinked_ancestors_and_targets() {
        let outside = root();
        fs::write(outside.join("ai/models/default.gguf"), "victim").unwrap();

        // `ai` is a symlink.
        let root_a = std::env::temp_dir().join(format!("politedb-legacy-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root_a).unwrap();
        symlink(outside.join("ai"), root_a.join("ai")).unwrap();
        assert_eq!(delete(&root_a).unwrap_err(), UNSAFE_PATH);

        // `models` is a symlink.
        let root_m = root();
        fs::remove_dir(root_m.join("ai/models")).unwrap();
        symlink(outside.join("ai/models"), root_m.join("ai/models")).unwrap();
        assert_eq!(delete(&root_m).unwrap_err(), UNSAFE_PATH);

        // The target itself is a symlink.
        let root_t = root();
        symlink(
            outside.join("ai/models/default.gguf"),
            root_t.join("ai/models/default.gguf"),
        )
        .unwrap();
        assert_eq!(info(&root_t).unwrap_err(), UNSAFE_PATH);
        assert_eq!(delete(&root_t).unwrap_err(), UNSAFE_PATH);

        assert_eq!(
            fs::read_to_string(outside.join("ai/models/default.gguf")).unwrap(),
            "victim"
        );
        for dir in [outside, root_a, root_m, root_t] {
            let _ = fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn ancestor_swapped_between_info_and_delete_fails_closed() {
        let outside = root();
        fs::write(outside.join("ai/models/default.gguf"), "victim").unwrap();
        let root = root();
        fs::write(root.join("ai/models/default.gguf"), "mine").unwrap();
        assert_eq!(names(&info(&root).unwrap()), vec!["default.gguf"]);

        fs::rename(root.join("ai/models"), root.join("ai/models-old")).unwrap();
        symlink(outside.join("ai/models"), root.join("ai/models")).unwrap();
        assert_eq!(delete(&root).unwrap_err(), UNSAFE_PATH);
        assert_eq!(
            fs::read_to_string(outside.join("ai/models/default.gguf")).unwrap(),
            "victim"
        );
        let _ = fs::remove_dir_all(outside);
        let _ = fs::remove_dir_all(root);
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn root(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("politedb-legacy-win-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("ai/models")).unwrap();
        fs::write(dir.join("ai/providers.json"), "{}").unwrap();
        dir
    }

    #[test]
    fn deletes_fixed_files_and_keeps_providers() {
        let root = root("basic");
        fs::write(root.join("ai/models/default.gguf"), "abcd").unwrap();
        fs::write(root.join("ai/models/default.gguf.part"), "ab").unwrap();
        assert_eq!(info(&root).unwrap().files.len(), 2);
        assert!(delete(&root).unwrap().files.is_empty());
        assert!(info(&root).unwrap().files.is_empty());
        assert_eq!(
            fs::read_to_string(root.join("ai/providers.json")).unwrap(),
            "{}"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn junctioned_models_dir_fails_closed() {
        let outside = root("outside");
        fs::write(outside.join("ai/models/default.gguf"), "victim").unwrap();
        let root = root("junction");
        fs::remove_dir(root.join("ai/models")).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("ai/models"))
            .arg(outside.join("ai/models"))
            .status();
        if !status.is_ok_and(|s| s.success()) {
            eprintln!("skipping: could not create junction");
            return;
        }
        assert_eq!(delete(&root).unwrap_err(), UNSAFE_PATH);
        assert_eq!(
            fs::read_to_string(outside.join("ai/models/default.gguf")).unwrap(),
            "victim"
        );
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn held_models_dir_cannot_be_swapped_during_operation() {
        let root = root("swap");
        fs::write(root.join("ai/models/default.gguf"), "mine").unwrap();
        let swapped = platform::with_models_dir(&root, |_dir| {
            Ok(fs::rename(root.join("ai/models"), root.join("ai/models-old")).is_ok())
        })
        .unwrap();
        assert!(!swapped, "rename of a held ancestor must fail");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn swap_attempts_during_open_and_delete_fail_closed() {
        let root = root("swap-open");
        let models = root.join("ai/models");
        fs::write(models.join("default.gguf"), "mine").unwrap();
        fs::write(models.join("unrelated.txt"), "keep").unwrap();
        let outcome = platform::with_models_dir(&root, |dir| {
            // Both ancestors are held without FILE_SHARE_DELETE: neither can be swapped
            // while the target is opened and deleted through the held directory.
            let ai_swapped = fs::rename(root.join("ai"), root.join("ai-old")).is_ok();
            let models_swapped = fs::rename(&models, root.join("ai/models-old")).is_ok();
            dir.delete_regular_file("default.gguf")?;
            Ok((ai_swapped, models_swapped))
        })
        .unwrap();
        assert_eq!(outcome, (false, false));
        assert!(!models.join("default.gguf").exists());
        assert_eq!(
            fs::read_to_string(models.join("unrelated.txt")).unwrap(),
            "keep"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
