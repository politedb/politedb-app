//! Security-scoped bookmarks and system panels via AppKit/Foundation.

use std::path::PathBuf;

use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSModalResponseOK, NSOpenPanel, NSSavePanel};
use objc2_foundation::{
    NSData, NSError, NSString, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions, NSURL,
};

use super::error;
use super::pick::{PanelKind, PanelRequest, PanelResult, Panels};
use super::port::{BookmarkPort, PortError, ScopedResource};

/// `NSFileNoSuchFileError`, `NSFileReadNoSuchFileError`, `NSFileReadNoPermissionError`.
const NO_SUCH_FILE: [isize; 2] = [4, 260];

pub struct NativeBookmarks;

impl BookmarkPort for NativeBookmarks {
    fn resolve(&self, bookmark: &[u8]) -> Result<Box<dyn ScopedResource>, PortError> {
        let data = NSData::with_bytes(bookmark);
        let mut stale = Bool::NO;
        let options = NSURLBookmarkResolutionOptions::WithSecurityScope
            | NSURLBookmarkResolutionOptions::WithoutUI;
        // SAFETY: `stale` outlives the call; the data is a bookmark we created.
        let url = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &data, options, None, &mut stale,
            )
        }
        .map_err(|e| classify(&e))?;
        let path = url.to_file_path().ok_or(PortError::Corrupt)?;
        Ok(Box::new(NativeResource {
            url,
            path,
            stale: stale.as_bool(),
        }))
    }
}

fn classify(error: &NSError) -> PortError {
    if NO_SUCH_FILE.contains(&error.code()) {
        PortError::Unavailable
    } else {
        PortError::Corrupt
    }
}

/// Holds the NSURL returned by bookmark resolution; start/stop/refresh use it.
struct NativeResource {
    url: Retained<NSURL>,
    path: PathBuf,
    stale: bool,
}

impl ScopedResource for NativeResource {
    fn path(&self) -> PathBuf {
        self.path.clone()
    }

    fn stale(&self) -> bool {
        self.stale
    }

    fn start(&self) -> bool {
        // SAFETY: plain message send on a valid file URL.
        unsafe { self.url.startAccessingSecurityScopedResource() }
    }

    fn stop(&self) {
        // SAFETY: only called by `Lease::drop` after a successful `start`.
        unsafe { self.url.stopAccessingSecurityScopedResource() }
    }

    fn bookmark(&self, read_only: bool) -> Result<Vec<u8>, PortError> {
        create_bookmark(&self.url, read_only)
    }
}

fn create_bookmark(url: &NSURL, read_only: bool) -> Result<Vec<u8>, PortError> {
    let mut options = NSURLBookmarkCreationOptions::WithSecurityScope;
    if read_only {
        options |= NSURLBookmarkCreationOptions::SecurityScopeAllowOnlyReadAccess;
    }
    url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
        options, None, None,
    )
    .map(|data| data.to_vec())
    .map_err(|_| PortError::Denied)
}

/// Runs panels on the main thread (AppKit requirement) and blocks the calling worker
/// until the user closes them. Never call from the main thread.
pub struct NativePanels {
    pub app: tauri::AppHandle,
}

impl Panels for NativePanels {
    fn run(&self, request: PanelRequest) -> Result<Option<PanelResult>, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.app
            .run_on_main_thread(move || {
                let _ = tx.send(run_panel(request));
            })
            .map_err(|_| error::PANEL_FAILED.to_string())?;
        rx.recv().map_err(|_| error::PANEL_FAILED.to_string())?
    }
}

fn run_panel(request: PanelRequest) -> Result<Option<PanelResult>, String> {
    let mtm = MainThreadMarker::new().ok_or_else(|| error::PANEL_FAILED.to_string())?;
    let panel: Retained<NSSavePanel> = match request.kind {
        PanelKind::SaveFile => NSSavePanel::savePanel(mtm),
        PanelKind::OpenFile | PanelKind::Folder => {
            let open = NSOpenPanel::openPanel(mtm);
            let folder = request.kind == PanelKind::Folder;
            open.setCanChooseFiles(!folder);
            open.setCanChooseDirectories(folder);
            open.setAllowsMultipleSelection(false);
            // Return aliases as themselves so validation can reject them.
            open.setResolvesAliases(false);
            Retained::into_super(open)
        }
    };
    panel.setTitle(Some(&NSString::from_str(&request.title)));
    if !request.message.is_empty() {
        panel.setMessage(Some(&NSString::from_str(&request.message)));
    }
    panel.setPrompt(Some(&NSString::from_str(&request.prompt)));
    panel.setCanCreateDirectories(request.kind != PanelKind::OpenFile);
    panel.setShowsHiddenFiles(request.show_hidden);
    if let Some(directory) = &request.directory {
        if let Some(url) = NSURL::from_directory_path(directory) {
            panel.setDirectoryURL(Some(&url));
        }
    }
    if let Some(name) = &request.file_name {
        panel.setNameFieldStringValue(&NSString::from_str(name));
    }

    if panel.runModal() != NSModalResponseOK {
        return Ok(None);
    }
    let url = panel.URL().ok_or_else(|| error::PANEL_FAILED.to_string())?;
    let selected = url
        .to_file_path()
        .ok_or_else(|| error::INVALID_PATH.to_string())?;
    let path = (request.validate)(&selected)?;
    // Bookmark the panel's own URL (it carries the user's consent), never a URL rebuilt
    // from a path.
    let bookmark = match request.bookmark {
        Some(read_only) => {
            let bytes = create_bookmark(&url, read_only).map_err(|_| error::DENIED.to_string())?;
            // Re-check after bookmarking: the item must still pass validation and the
            // bookmark must point at it, or nothing is stored.
            let again = (request.validate)(&selected)?;
            let resolved = NativeBookmarks
                .resolve(&bytes)
                .map_err(|_| error::DENIED.to_string())?
                .path();
            if again != path || resolved != path {
                return Err(error::DENIED.into());
            }
            Some(bytes)
        }
        None => None,
    };
    Ok(Some(PanelResult { path, bookmark }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_access::test_support::TempDir;

    /// Mechanics only: outside the sandbox this cannot prove access rights.
    #[test]
    fn bookmarks_round_trip_for_files_and_folders() {
        let dir = TempDir::new();
        let file = dir.path().join("id_ed25519");
        std::fs::write(&file, b"k").unwrap();
        for (path, read_only) in [(dir.path().to_path_buf(), false), (file.clone(), true)] {
            let url = if path.is_dir() {
                NSURL::from_directory_path(&path).unwrap()
            } else {
                NSURL::from_file_path(&path).unwrap()
            };
            let bytes = create_bookmark(&url, read_only).unwrap();
            let resource = NativeBookmarks.resolve(&bytes).unwrap();
            assert_eq!(resource.path(), path);
            assert!(resource.start());
            resource.stop();
        }
    }

    #[test]
    fn deleted_items_resolve_as_unavailable_or_moved() {
        let dir = TempDir::new();
        let file = dir.path().join("gone.db");
        std::fs::write(&file, b"").unwrap();
        let bytes = create_bookmark(&NSURL::from_file_path(&file).unwrap(), true).unwrap();
        std::fs::remove_file(&file).unwrap();
        match NativeBookmarks.resolve(&bytes) {
            Err(error) => assert_eq!(error, PortError::Unavailable),
            // Some macOS versions still resolve the old path; the service then fails the
            // open, never another location.
            Ok(resource) => assert_eq!(resource.path(), file),
        }
    }

    #[test]
    fn garbage_is_corrupt() {
        assert!(NativeBookmarks.resolve(b"not a bookmark").is_err());
    }
}
