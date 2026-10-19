//! Tauri-backed implementations of the provider storage ports.

use tauri::AppHandle;

use super::provider::AiProviderFile;
use super::provider_store::{ProviderFilePort, SecretPort};
use crate::file_storage;
use crate::security::secrets;

pub struct AppProviderFiles<'a>(pub &'a AppHandle);

impl ProviderFilePort for AppProviderFiles<'_> {
    fn load(&self) -> Result<AiProviderFile, String> {
        let path = file_storage::path_ai_providers(self.0)?;
        // A malformed file is an error, so it is never overwritten by a save.
        file_storage::json_read_if_exists::<AiProviderFile>(&path)
            .map(Option::unwrap_or_default)
            .map_err(|_| "AI_PROVIDER_FILE_INVALID".to_string())
    }

    fn save(&self, file: &AiProviderFile) -> Result<(), String> {
        let path = file_storage::path_ai_providers(self.0)?;
        file_storage::json_replace_preserving(&path, file)
            .map_err(|_| "AI_PROVIDER_FILE_WRITE_FAILED".to_string())
    }
}

pub struct AppSecrets<'a>(pub &'a AppHandle);

impl SecretPort for AppSecrets<'_> {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        secrets::keychain_get_optional(self.0, key)
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        secrets::keychain_set(self.0, key, value)
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        secrets::keychain_delete_if_present(self.0, key)
    }
}

/// The agent's data-access consent file.
pub struct AppConsentFiles<'a>(pub &'a AppHandle);

impl super::agent::consent::ConsentFiles for AppConsentFiles<'_> {
    fn read(&self) -> Result<Option<super::agent::consent::ConsentFile>, String> {
        let path = file_storage::path_ai_data_access(self.0)?;
        file_storage::json_read_strict(&path).map_err(|_| "AI_DATA_ACCESS_UNREADABLE".to_string())
    }

    fn save(&self, file: &super::agent::consent::ConsentFile) -> Result<(), String> {
        let path = file_storage::path_ai_data_access(self.0)?;
        file_storage::json_replace_private(&path, file)
            .map_err(|_| "AI_DATA_ACCESS_WRITE_FAILED".to_string())
    }
}

/// Native approval of agent data queries: LocalAuthentication on macOS, unavailable
/// elsewhere (data tools are then off in safe/production mode).
pub fn native_approval() -> Option<std::sync::Arc<dyn super::agent::data::tools::ApprovalPort>> {
    #[cfg(target_os = "macos")]
    {
        Some(std::sync::Arc::new(MacApproval))
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
struct MacApproval;

#[cfg(target_os = "macos")]
#[async_trait::async_trait]
impl super::agent::data::tools::ApprovalPort for MacApproval {
    async fn approve(&self, reason: &str) -> Result<bool, String> {
        crate::platform::macos::authenticate_device_owner(
            reason,
            std::time::Duration::from_secs(60),
        )
        .await
    }
}
