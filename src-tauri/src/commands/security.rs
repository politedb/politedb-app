/// How long the system authentication prompt may stay open.
#[cfg(target_os = "macos")]
const TOUCH_ID_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[cfg(target_os = "macos")]
const DEFAULT_TOUCH_ID_REASON: &str = "Authenticate with Touch ID to continue.";

/// LocalAuthentication raises an Objective-C exception for an empty reason, so blank
/// input falls back to the default prompt.
#[cfg(target_os = "macos")]
fn prompt_for(reason: Option<String>) -> String {
    reason
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| DEFAULT_TOUCH_ID_REASON.to_string())
}

#[tauri::command]
pub async fn security_touch_id_authenticate(reason: Option<String>) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        // LocalAuthentication directly (works in the sandbox and without Xcode tools).
        crate::platform::macos::authenticate_device_owner(&prompt_for(reason), TOUCH_ID_TIMEOUT)
            .await
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = reason;
        Err("TOUCH_ID_UNSUPPORTED_PLATFORM".to_string())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn blank_reasons_use_the_default_prompt() {
        assert_eq!(prompt_for(None), DEFAULT_TOUCH_ID_REASON);
        assert_eq!(prompt_for(Some(String::new())), DEFAULT_TOUCH_ID_REASON);
        assert_eq!(prompt_for(Some("  \n\t".into())), DEFAULT_TOUCH_ID_REASON);
        assert_eq!(prompt_for(Some(" Run query ".into())), "Run query");
    }
}
