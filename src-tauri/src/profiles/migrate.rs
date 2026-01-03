use serde_json::Value;

/// Profile schema version supported by current binary
pub const CURRENT_PROFILE_VERSION: u32 = 1;

/// Future-proof migration entry
///
/// When PROFILE_VERSION changes:
/// - load raw JSON
/// - inspect version
/// - migrate step-by-step to CURRENT_PROFILE_VERSION
pub fn migrate_profile_json(raw: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(raw).map_err(|e| format!("PROFILE_JSON_INVALID: {e}"))?;

    let version = v.get("version").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

    match version {
        CURRENT_PROFILE_VERSION => Ok(raw.to_string()),

        // Example:
        // 0 => migrate_v0_to_v1(v),
        _ => Err(format!("UNSUPPORTED_PROFILE_VERSION: {}", version)),
    }
}

/*
fn migrate_v0_to_v1(v: Value) -> Result<String, String> {
    // TODO: transform old structure
}
*/
