//! Access to user-chosen files in sandboxed (Mac App Store) builds (plan Phase 3).
//!
//! The sandbox only lets the app open files the user picked in a system panel during
//! the current launch. To reopen them later we keep security-scoped bookmarks in a
//! private grant store and "lease" the access while a connection uses the file.
//!
//! - Grants are created only by the backend-owned pickers (`pick`); there is no command
//!   that bookmarks an arbitrary path.
//! - Grants never live in connection profiles, so profile export/import cannot carry them.
//! - Errors carry codes and roles only, never paths or native error text.
//! - `grants.json` must never be added to logs, diagnostics or support archives.
//!
//! Direct (DMG) builds use the same pickers but store nothing and lease nothing.

mod error;
mod lease;
pub mod pick;
mod port;
mod redact;
pub mod safe_save;
mod service;
mod store;
pub mod validate;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(test)]
pub(crate) mod test_support;

pub use error::Role;
pub use lease::{Lease, Leased};
pub use redact::log_safe;
pub use service::{is_in_memory, AccessRequest, FileAccess};

use std::sync::{Arc, OnceLock};

static SERVICE: OnceLock<Arc<FileAccess>> = OnceLock::new();

/// Installs the process-wide service. Called once during app setup.
pub fn install(service: Arc<FileAccess>) {
    let _ = SERVICE.set(service);
}

/// The installed service. Before `install` (unit tests, early startup) a disabled
/// service is returned, which behaves like the direct build.
pub fn service() -> Arc<FileAccess> {
    SERVICE
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(FileAccess::disabled()))
}

/// Builds the service for this distribution with the native bookmark port.
pub fn for_app(app: &tauri::AppHandle) -> Result<Arc<FileAccess>, String> {
    use tauri::Manager;
    if !crate::distribution::Distribution::current().requires_file_grants() {
        return Ok(Arc::new(FileAccess::disabled()));
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "FILE_ACCESS_STORE_IO".to_string())?
        .join("file_access");
    Ok(Arc::new(FileAccess::enabled(
        dir.join("grants.json"),
        native_port(),
    )))
}

#[cfg(target_os = "macos")]
pub fn macos_panels(app: tauri::AppHandle) -> macos::NativePanels {
    macos::NativePanels { app }
}

/// Plugin-dialog panels for builds without grants (direct builds, non-macOS).
pub struct DialogPanels {
    pub app: tauri::AppHandle,
}

impl pick::Panels for DialogPanels {
    fn run(&self, request: pick::PanelRequest) -> Result<Option<pick::PanelResult>, String> {
        use tauri_plugin_dialog::DialogExt;
        let mut builder = self.app.dialog().file().set_title(&request.title);
        if let Some(directory) = &request.directory {
            builder = builder.set_directory(directory);
        }
        if let Some(name) = &request.file_name {
            builder = builder.set_file_name(name);
        }
        let picked = match request.kind {
            pick::PanelKind::OpenFile => builder.blocking_pick_file(),
            pick::PanelKind::SaveFile => builder.blocking_save_file(),
            pick::PanelKind::Folder => builder.blocking_pick_folder(),
        };
        let Some(picked) = picked else {
            return Ok(None);
        };
        let selected = picked
            .into_path()
            .map_err(|_| error::INVALID_PATH.to_string())?;
        let path = (request.validate)(&selected)?;
        Ok(Some(pick::PanelResult {
            path,
            bookmark: None,
        }))
    }
}

#[cfg(target_os = "macos")]
fn native_port() -> Arc<dyn port::BookmarkPort> {
    Arc::new(macos::NativeBookmarks)
}

#[cfg(not(target_os = "macos"))]
fn native_port() -> Arc<dyn port::BookmarkPort> {
    Arc::new(port::Unsupported)
}
