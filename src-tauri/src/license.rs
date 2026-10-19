use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(not(target_os = "macos"))]
use std::process::Command as StdCommand;

use crate::distribution::Distribution;
use crate::file_storage as storage;

const LICENSE_STATE_VERSION: u32 = 1;
const TRIAL_DURATION_DAYS: i64 = 14;
const TRIAL_EXPIRED_MESSAGE: &str = "Your 14-day free trial has expired.";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseDeviceInfo {
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    pub arch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseState {
    pub version: u32,
    pub status: String,
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    pub arch: String,
    pub license_key: Option<String>,
    pub activation_token: Option<String>,
    pub license_id: Option<String>,
    pub plan_name: Option<String>,
    pub customer_email: Option<String>,
    pub instance_name: Option<String>,
    pub expires_at: Option<String>,
    pub activated_at: Option<i64>,
    pub last_validated_at: Option<i64>,
    pub seats_allowed: Option<u32>,
    pub devices_used: Option<u32>,
    pub trial_started_at: Option<i64>,
    pub trial_expires_at: Option<i64>,
    pub message: Option<String>,
    /// Feature tier reported by the license API ("pro" or "free"); absent on older servers.
    #[serde(default)]
    pub plan: Option<String>,
    /// Whether Pro features are unlocked. Derived in `finalize_state`; never trusted from input.
    #[serde(default)]
    pub pro_access: bool,
}

#[derive(Debug, Clone, Serialize)]
struct LicenseApiRequest {
    product: String,
    #[serde(rename = "licenseKey", skip_serializing_if = "Option::is_none")]
    license_key: Option<String>,
    #[serde(rename = "activationToken", skip_serializing_if = "Option::is_none")]
    activation_token: Option<String>,
    device: LicenseDeviceInfo,
}

#[derive(Debug, Clone, Deserialize)]
struct LicenseApiResponse {
    status: Option<String>,
    #[serde(alias = "activationToken")]
    activation_token: Option<String>,
    #[serde(alias = "licenseId")]
    license_id: Option<String>,
    #[serde(alias = "planName")]
    plan_name: Option<String>,
    #[serde(alias = "customerEmail")]
    customer_email: Option<String>,
    #[serde(alias = "instanceName")]
    instance_name: Option<String>,
    #[serde(alias = "expiresAt")]
    expires_at: Option<String>,
    #[serde(alias = "activatedAt")]
    activated_at: Option<i64>,
    #[serde(alias = "lastValidatedAt")]
    last_validated_at: Option<i64>,
    #[serde(alias = "seatsAllowed")]
    seats_allowed: Option<u32>,
    #[serde(alias = "devicesUsed")]
    devices_used: Option<u32>,
    plan: Option<String>,
    message: Option<String>,
    error: Option<String>,
}

fn parse_license_api_response(text: &str) -> Result<LicenseApiResponse, String> {
    serde_json::from_str::<LicenseApiResponse>(text).or_else(|direct_err| {
        let value: Value = serde_json::from_str(text).map_err(|json_err| {
            format!("{direct_err}; raw body: {text}; json parse error: {json_err}")
        })?;

        for key in ["data", "license", "result"] {
            if let Some(inner) = value.get(key) {
                if let Ok(parsed) = serde_json::from_value::<LicenseApiResponse>(inner.clone()) {
                    return Ok(parsed);
                }
            }
        }

        serde_json::from_value::<LicenseApiResponse>(value.clone()).map_err(|nested_err| {
            format!("{direct_err}; raw body: {text}; nested parse error: {nested_err}")
        })
    })
}

impl LicenseState {
    pub fn inactive(device: &LicenseDeviceInfo) -> Self {
        let trial_started_at = chrono::Utc::now().timestamp_millis();
        let trial_expires_at =
            (chrono::Utc::now() + chrono::Duration::days(TRIAL_DURATION_DAYS)).timestamp_millis();

        Self {
            version: LICENSE_STATE_VERSION,
            status: "inactive".to_string(),
            device_id: device.device_id.clone(),
            device_name: device.device_name.clone(),
            platform: device.platform.clone(),
            arch: device.arch.clone(),
            license_key: None,
            activation_token: None,
            license_id: None,
            plan_name: None,
            customer_email: None,
            instance_name: None,
            expires_at: None,
            activated_at: None,
            last_validated_at: None,
            seats_allowed: None,
            devices_used: None,
            trial_started_at: Some(trial_started_at),
            trial_expires_at: Some(trial_expires_at),
            message: None,
            plan: None,
            pro_access: false,
        }
    }

    fn with_device(mut self, device: &LicenseDeviceInfo) -> Self {
        self.version = LICENSE_STATE_VERSION;
        self.device_id = device.device_id.clone();
        self.device_name = device.device_name.clone();
        self.platform = device.platform.clone();
        self.arch = device.arch.clone();
        self
    }
}

fn parse_expiry_timestamp(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .ok()
}

/// Drops the local trial in flavors that do not offer it (App Store uses subscription
/// intro offers), including dates persisted by older builds or returned by the API.
fn apply_trial_policy(mut state: LicenseState, distribution: Distribution) -> LicenseState {
    if distribution.supports_local_trial() {
        return state;
    }
    state.trial_started_at = None;
    state.trial_expires_at = None;
    if state.message.as_deref() == Some(TRIAL_EXPIRED_MESSAGE) {
        state.message = None;
    }
    state
}

/// Single exit path for license state handed to storage and the frontend.
fn finalize_state(state: LicenseState) -> LicenseState {
    apply_pro_access(
        apply_local_expiry(apply_trial_policy(state, Distribution::current())),
        Distribution::current(),
        chrono::Utc::now().timestamp_millis(),
    )
}

/// Pro features unlock with an active paid license or a running trial. Flavors that do not
/// gate Pro features (App Store) always unlock them.
fn has_pro_access(state: &LicenseState, distribution: Distribution, now: i64) -> bool {
    if !distribution.gates_pro_features() {
        return true;
    }
    let licensed = state.status.trim().eq_ignore_ascii_case("active")
        && !state
            .plan
            .as_deref()
            .is_some_and(|plan| plan.trim().eq_ignore_ascii_case("free"));
    let in_trial = distribution.supports_local_trial()
        && state
            .trial_expires_at
            .is_some_and(|expires_at| expires_at > now);
    licensed || in_trial
}

fn apply_pro_access(mut state: LicenseState, distribution: Distribution, now: i64) -> LicenseState {
    state.pro_access = has_pro_access(&state, distribution, now);
    state
}

fn apply_local_expiry(mut state: LicenseState) -> LicenseState {
    normalize_state_timestamps(&mut state);

    let status = state.status.trim().to_lowercase();
    let now = chrono::Utc::now().timestamp_millis();

    if status != "active" {
        if state
            .trial_expires_at
            .is_some_and(|trial_expires_at| trial_expires_at <= now)
            && state.message.as_deref().unwrap_or("").trim().is_empty()
        {
            state.message = Some(TRIAL_EXPIRED_MESSAGE.to_string());
        }
        return state;
    }

    let Some(expires_at) = state.expires_at.clone() else {
        return state;
    };
    let Some(expiry) = parse_expiry_timestamp(&expires_at) else {
        return state;
    };

    if expiry.timestamp_millis() <= now {
        state.status = "expired".to_string();
        if state.message.as_deref().unwrap_or("").trim().is_empty() {
            state.message = Some("This license has expired.".to_string());
        }
    }

    state
}

fn normalize_unix_timestamp_millis(value: i64) -> i64 {
    let abs = value.saturating_abs();

    // License APIs commonly return Unix seconds. The frontend and local expiry
    // checks use milliseconds, so normalize seconds before persisting.
    if abs > 0 && abs < 10_000_000_000 {
        value.saturating_mul(1_000)
    } else {
        value
    }
}

fn normalize_state_timestamps(state: &mut LicenseState) {
    state.activated_at = state.activated_at.map(normalize_unix_timestamp_millis);
    state.last_validated_at = state.last_validated_at.map(normalize_unix_timestamp_millis);
    state.trial_started_at = state.trial_started_at.map(normalize_unix_timestamp_millis);
    state.trial_expires_at = state.trial_expires_at.map(normalize_unix_timestamp_millis);
}

#[cfg(not(target_os = "macos"))]
fn command_output(cmd: &str, args: &[&str]) -> Option<String> {
    let output = StdCommand::new(cmd).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(target_os = "macos")]
fn machine_identity_source() -> Option<String> {
    // Same IOPlatformUUID `ioreg` reported, read via IOKit (no subprocess in the sandbox).
    crate::platform::macos::platform_uuid()
}

#[cfg(target_os = "linux")]
fn machine_identity_source() -> Option<String> {
    std::fs::read_to_string("/etc/machine-id")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::fs::read_to_string("/var/lib/dbus/machine-id")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
}

#[cfg(target_os = "windows")]
fn machine_identity_source() -> Option<String> {
    let output = command_output(
        "reg",
        &[
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ],
    )?;

    output.lines().find_map(|line| {
        if !line.contains("MachineGuid") {
            return None;
        }
        line.split_whitespace()
            .last()
            .map(|value| value.to_string())
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn machine_identity_source() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn host_name() -> Option<String> {
    crate::platform::macos::host_name()
}

#[cfg(not(target_os = "macos"))]
fn host_name() -> Option<String> {
    command_output("hostname", &[])
}

fn detect_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("HOSTNAME")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .or_else(host_name)
        .unwrap_or_else(|| "This device".to_string())
}

fn build_device_id(seed: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    let bytes = hasher.finalize();
    let hex = format!("{:x}", bytes);
    format!(
        "{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..24]
    )
}

pub fn license_device_info() -> LicenseDeviceInfo {
    let platform = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let device_name = detect_device_name();
    let source = machine_identity_source().unwrap_or_else(|| {
        format!(
            "{}:{}:{}",
            device_name,
            std::env::var("USER").unwrap_or_default(),
            arch
        )
    });

    LicenseDeviceInfo {
        device_id: build_device_id(&source),
        device_name,
        platform,
        arch,
    }
}

pub fn license_state_load(app: &tauri::AppHandle) -> Result<LicenseState, String> {
    let device = license_device_info();
    let path = storage::path_license_state(app)?;
    let value = storage::json_read_if_exists::<LicenseState>(&path)?;
    let existing = value.filter(|state| state.version == LICENSE_STATE_VERSION);
    let next = finalize_state(
        existing
            .unwrap_or_else(|| LicenseState::inactive(&device))
            .with_device(&device),
    );
    storage::json_write_atomic(&path, &next)?;
    Ok(next)
}

pub fn license_state_save(
    app: &tauri::AppHandle,
    state: LicenseState,
) -> Result<LicenseState, String> {
    let device = license_device_info();
    let next = finalize_state(state.with_device(&device));
    let path = storage::path_license_state(app)?;
    storage::json_write_atomic(&path, &next)?;
    Ok(next)
}

pub fn license_state_clear(app: &tauri::AppHandle) -> Result<LicenseState, String> {
    let device = license_device_info();
    let path = storage::path_license_state(app)?;
    let previous = storage::json_read_if_exists::<LicenseState>(&path)?;
    let mut next = LicenseState::inactive(&device);

    if let Some(previous) = previous {
        next.trial_started_at = previous.trial_started_at.or(next.trial_started_at);
        next.trial_expires_at = previous.trial_expires_at.or(next.trial_expires_at);
    }
    let next = apply_trial_policy(next, Distribution::current());

    storage::json_write_atomic(&path, &next)?;
    Ok(apply_pro_access(
        apply_local_expiry(next),
        Distribution::current(),
        chrono::Utc::now().timestamp_millis(),
    ))
}

fn pick_string(values: &[Option<String>]) -> Option<String> {
    values
        .iter()
        .find_map(|value| value.as_ref().map(|v| v.trim().to_string()))
        .filter(|value| !value.is_empty())
}

fn pick_u32(values: &[Option<u32>]) -> Option<u32> {
    values.iter().find_map(|value| *value)
}

fn pick_i64(values: &[Option<i64>]) -> Option<i64> {
    values.iter().find_map(|value| *value)
}

fn default_trial_started_at(previous: Option<&LicenseState>) -> i64 {
    previous
        .and_then(|state| state.trial_started_at)
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis())
}

fn default_trial_expires_at(previous: Option<&LicenseState>, trial_started_at: i64) -> i64 {
    previous
        .and_then(|state| state.trial_expires_at)
        .unwrap_or_else(|| {
            trial_started_at + chrono::Duration::days(TRIAL_DURATION_DAYS).num_milliseconds()
        })
}

fn normalize_api_state(
    payload: LicenseApiResponse,
    device: &LicenseDeviceInfo,
    previous: Option<&LicenseState>,
    license_key: Option<String>,
) -> LicenseState {
    let trial_started_at = default_trial_started_at(previous);
    let trial_expires_at = default_trial_expires_at(previous, trial_started_at);

    let mut state = LicenseState {
        version: LICENSE_STATE_VERSION,
        status: pick_string(&[
            payload.status,
            previous.map(|state| state.status.clone()),
            Some("inactive".to_string()),
        ])
        .unwrap_or_else(|| "inactive".to_string()),
        device_id: device.device_id.clone(),
        device_name: device.device_name.clone(),
        platform: device.platform.clone(),
        arch: device.arch.clone(),
        license_key: license_key.or_else(|| previous.and_then(|state| state.license_key.clone())),
        activation_token: pick_string(&[
            payload.activation_token,
            previous.and_then(|state| state.activation_token.clone()),
        ]),
        license_id: pick_string(&[
            payload.license_id,
            previous.and_then(|state| state.license_id.clone()),
        ]),
        plan_name: pick_string(&[
            payload.plan_name,
            previous.and_then(|state| state.plan_name.clone()),
        ]),
        customer_email: pick_string(&[
            payload.customer_email,
            previous.and_then(|state| state.customer_email.clone()),
        ]),
        instance_name: pick_string(&[
            payload.instance_name,
            previous.and_then(|state| state.instance_name.clone()),
        ]),
        expires_at: pick_string(&[
            payload.expires_at,
            previous.and_then(|state| state.expires_at.clone()),
        ]),
        activated_at: pick_i64(&[
            payload.activated_at,
            previous.and_then(|state| state.activated_at),
        ]),
        last_validated_at: pick_i64(&[
            payload.last_validated_at,
            previous.and_then(|state| state.last_validated_at),
            Some(chrono::Utc::now().timestamp_millis()),
        ]),
        seats_allowed: pick_u32(&[
            payload.seats_allowed,
            previous.and_then(|state| state.seats_allowed),
        ]),
        devices_used: pick_u32(&[
            payload.devices_used,
            previous.and_then(|state| state.devices_used),
        ]),
        trial_started_at: Some(trial_started_at),
        trial_expires_at: Some(trial_expires_at),
        message: pick_string(&[
            payload.message,
            payload.error,
            previous.and_then(|state| state.message.clone()),
        ]),
        plan: pick_string(&[payload.plan, previous.and_then(|state| state.plan.clone())]),
        pro_access: false,
    };
    normalize_state_timestamps(&mut state);
    state
}

async fn post_license_api(
    api_base: &str,
    action: &str,
    body: &LicenseApiRequest,
) -> Result<LicenseApiResponse, String> {
    let base = api_base.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("License API is not configured.".to_string());
    }

    let client = reqwest::Client::new();
    let candidates = license_endpoint_candidates(base, action);
    let mut last_error = String::new();

    for url in candidates {
        let res = client
            .post(&url)
            .json(body)
            .send()
            .await
            .map_err(|e| format!("License request failed: {e}"))?;

        let status = res.status();
        let body_text = res
            .text()
            .await
            .map_err(|e| format!("License response read failed: {e}"))?;

        match parse_license_api_response(&body_text) {
            Ok(payload) => {
                if !status.is_success() {
                    let message = pick_string(&[payload.message.clone(), payload.error.clone()])
                        .unwrap_or_else(|| format!("License API returned {status}"));
                    if status == reqwest::StatusCode::NOT_FOUND {
                        last_error = format!("{message} ({url})");
                        continue;
                    }
                    return Err(message);
                }
                return Ok(payload);
            }
            Err(parse_error) => {
                last_error = format!("{parse_error} ({url})");
                if status == reqwest::StatusCode::NOT_FOUND
                    || body_text.contains("Cannot POST")
                    || body_text.contains("<!DOCTYPE html")
                {
                    continue;
                }
                return Err(format!("License response parse failed: {parse_error}"));
            }
        }
    }

    Err(format!(
        "License API endpoint not found. Checked common routes for base '{base}'. Last error: {last_error}"
    ))
}

fn license_endpoint_candidates(base: &str, action: &str) -> Vec<String> {
    let action = action.trim().trim_start_matches('/');
    let mut candidates = Vec::new();

    let push = |list: &mut Vec<String>, url: String| {
        if !list.iter().any(|existing| existing == &url) {
            list.push(url);
        }
    };

    if base.ends_with("/api/v1") {
        push(&mut candidates, format!("{base}/licenses/{action}"));
        push(&mut candidates, format!("{base}/{action}"));
        return candidates;
    }

    if base.ends_with("/v1") {
        let root = base.trim_end_matches("/v1");
        push(&mut candidates, format!("{base}/licenses/{action}"));
        push(&mut candidates, format!("{base}/{action}"));
        push(&mut candidates, format!("{root}/api/v1/licenses/{action}"));
        push(&mut candidates, format!("{root}/api/v1/{action}"));
        return candidates;
    }

    if base.ends_with("/api") {
        push(&mut candidates, format!("{base}/v1/licenses/{action}"));
        push(&mut candidates, format!("{base}/v1/{action}"));
        return candidates;
    }

    push(&mut candidates, format!("{base}/v1/licenses/{action}"));
    push(&mut candidates, format!("{base}/api/v1/licenses/{action}"));
    push(&mut candidates, format!("{base}/v1/{action}"));
    push(&mut candidates, format!("{base}/api/v1/{action}"));
    candidates
}

pub async fn license_activate(
    app: &tauri::AppHandle,
    api_base: String,
    product: String,
    license_key: String,
) -> Result<LicenseState, String> {
    let device = license_device_info();
    let payload = post_license_api(
        &api_base,
        "activate",
        &LicenseApiRequest {
            product,
            license_key: Some(license_key.clone()),
            activation_token: None,
            device: device.clone(),
        },
    )
    .await?;

    let next = normalize_api_state(payload, &device, None, Some(license_key));
    license_state_save(app, next)
}

pub async fn license_refresh(
    app: &tauri::AppHandle,
    api_base: String,
    product: String,
) -> Result<LicenseState, String> {
    let current = license_state_load(app)?;
    let device = license_device_info();
    let payload = post_license_api(
        &api_base,
        "validate",
        &LicenseApiRequest {
            product,
            license_key: current.license_key.clone(),
            activation_token: current.activation_token.clone(),
            device: device.clone(),
        },
    )
    .await?;

    let next = normalize_api_state(
        payload,
        &device,
        Some(&current),
        current.license_key.clone(),
    );
    license_state_save(app, next)
}

pub async fn license_deactivate(
    app: &tauri::AppHandle,
    api_base: String,
    product: String,
) -> Result<LicenseState, String> {
    let current = license_state_load(app)?;
    let device = license_device_info();

    let _ = post_license_api(
        &api_base,
        "deactivate",
        &LicenseApiRequest {
            product,
            license_key: current.license_key.clone(),
            activation_token: current.activation_token.clone(),
            device,
        },
    )
    .await?;

    license_state_clear(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_device() -> LicenseDeviceInfo {
        LicenseDeviceInfo {
            device_id: "device-id".to_string(),
            device_name: "device".to_string(),
            platform: "test".to_string(),
            arch: "test".to_string(),
        }
    }

    fn empty_payload() -> LicenseApiResponse {
        LicenseApiResponse {
            status: None,
            activation_token: None,
            license_id: None,
            plan_name: None,
            customer_email: None,
            instance_name: None,
            expires_at: None,
            activated_at: None,
            last_validated_at: None,
            seats_allowed: None,
            devices_used: None,
            plan: None,
            message: None,
            error: None,
        }
    }

    #[test]
    fn normalize_unix_timestamp_millis_converts_seconds() {
        assert_eq!(
            normalize_unix_timestamp_millis(1_767_000_000),
            1_767_000_000_000
        );
        assert_eq!(
            normalize_unix_timestamp_millis(1_767_000_000_123),
            1_767_000_000_123
        );
    }

    #[test]
    fn normalize_api_state_uses_fourteen_day_trial_fallback() {
        let device = test_device();
        let trial_started_at = 1_767_000_000_000;
        let previous = LicenseState {
            trial_started_at: Some(trial_started_at),
            trial_expires_at: None,
            ..LicenseState::inactive(&device)
        };

        let state = normalize_api_state(empty_payload(), &device, Some(&previous), None);

        assert_eq!(
            state.trial_expires_at,
            Some(trial_started_at + chrono::Duration::days(TRIAL_DURATION_DAYS).num_milliseconds())
        );
    }

    #[test]
    fn normalize_api_state_converts_api_seconds_to_millis() {
        let device = test_device();
        let mut payload = empty_payload();
        payload.status = Some("active".to_string());
        payload.activated_at = Some(1_767_000_000);
        payload.last_validated_at = Some(1_767_000_100);

        let state = normalize_api_state(payload, &device, None, Some("key".to_string()));

        assert_eq!(state.status, "active");
        assert_eq!(state.activated_at, Some(1_767_000_000_000));
        assert_eq!(state.last_validated_at, Some(1_767_000_100_000));
    }

    fn with_trial(status: &str, trial_expires_at: i64) -> LicenseState {
        LicenseState {
            status: status.to_string(),
            trial_started_at: Some(trial_expires_at - 1_000),
            trial_expires_at: Some(trial_expires_at),
            ..LicenseState::inactive(&test_device())
        }
    }

    #[test]
    fn direct_keeps_trial_dates_and_message() {
        let mut state = with_trial("inactive", 1_000);
        state.message = Some(TRIAL_EXPIRED_MESSAGE.to_string());
        let next = apply_trial_policy(state.clone(), Distribution::Direct);
        assert_eq!(next.trial_started_at, state.trial_started_at);
        assert_eq!(next.trial_expires_at, state.trial_expires_at);
        assert_eq!(next.message.as_deref(), Some(TRIAL_EXPIRED_MESSAGE));
    }

    #[test]
    fn app_store_strips_fresh_and_persisted_trials() {
        let fresh = apply_trial_policy(
            LicenseState::inactive(&test_device()),
            Distribution::AppStore,
        );
        assert_eq!(fresh.trial_started_at, None);
        assert_eq!(fresh.trial_expires_at, None);

        let mut expired = with_trial("inactive", 1_000);
        expired.message = Some(TRIAL_EXPIRED_MESSAGE.to_string());
        let expired = apply_trial_policy(expired, Distribution::AppStore);
        assert_eq!(expired.trial_expires_at, None);
        assert_eq!(expired.message, None);
        // No trial message is re-added once the dates are gone.
        assert_eq!(apply_local_expiry(expired).message, None);
    }

    #[test]
    fn app_store_keeps_unrelated_messages() {
        let mut state = with_trial("invalid", 1_000);
        state.message = Some("License key is invalid.".to_string());
        let next = apply_trial_policy(state, Distribution::AppStore);
        assert_eq!(next.message.as_deref(), Some("License key is invalid."));
    }

    const NOW: i64 = 1_800_000_000_000;

    fn licensed(status: &str, plan: Option<&str>) -> LicenseState {
        LicenseState {
            status: status.to_string(),
            plan: plan.map(str::to_string),
            trial_started_at: None,
            trial_expires_at: None,
            ..LicenseState::inactive(&test_device())
        }
    }

    #[test]
    fn active_paid_license_unlocks_pro() {
        assert!(has_pro_access(
            &licensed("active", None),
            Distribution::Direct,
            NOW
        ));
        assert!(has_pro_access(
            &licensed("active", Some("pro")),
            Distribution::Direct,
            NOW
        ));
        assert!(has_pro_access(
            &licensed(" Active ", Some("PRO")),
            Distribution::Direct,
            NOW
        ));
    }

    #[test]
    fn inactive_expired_or_free_plan_does_not_unlock_pro() {
        for status in ["inactive", "expired", "invalid", "error"] {
            assert!(!has_pro_access(
                &licensed(status, None),
                Distribution::Direct,
                NOW
            ));
        }
        assert!(!has_pro_access(
            &licensed("active", Some("free")),
            Distribution::Direct,
            NOW
        ));
    }

    #[test]
    fn running_trial_unlocks_pro_until_it_expires() {
        assert!(has_pro_access(
            &with_trial("inactive", NOW + 1),
            Distribution::Direct,
            NOW
        ));
        assert!(!has_pro_access(
            &with_trial("inactive", NOW),
            Distribution::Direct,
            NOW
        ));
        assert!(!has_pro_access(
            &with_trial("inactive", NOW - 1),
            Distribution::Direct,
            NOW
        ));
    }

    #[test]
    fn app_store_keeps_pro_unlocked() {
        assert!(has_pro_access(
            &licensed("inactive", None),
            Distribution::AppStore,
            NOW
        ));
        assert!(has_pro_access(
            &licensed("active", Some("free")),
            Distribution::AppStore,
            NOW
        ));
    }

    #[test]
    fn pro_access_from_input_is_recomputed() {
        let mut forged = licensed("inactive", None);
        forged.pro_access = true;
        let next = apply_pro_access(forged, Distribution::Direct, NOW);
        assert!(!next.pro_access);
    }

    #[test]
    fn normalize_api_state_keeps_plan_from_payload_or_previous() {
        let device = test_device();
        let mut payload = empty_payload();
        payload.plan = Some("pro".to_string());
        let state = normalize_api_state(payload, &device, None, None);
        assert_eq!(state.plan.as_deref(), Some("pro"));

        let previous = LicenseState {
            plan: Some("pro".to_string()),
            ..LicenseState::inactive(&device)
        };
        let state = normalize_api_state(empty_payload(), &device, Some(&previous), None);
        assert_eq!(state.plan.as_deref(), Some("pro"));
    }
}
