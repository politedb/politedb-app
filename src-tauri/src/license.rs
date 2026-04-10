use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::process::Command as StdCommand;

use crate::file_storage as storage;

const LICENSE_STATE_VERSION: u32 = 1;

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
    pub message: Option<String>,
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
    message: Option<String>,
    error: Option<String>,
}

impl LicenseState {
    pub fn inactive(device: &LicenseDeviceInfo) -> Self {
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
            message: None,
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
    let output = command_output("ioreg", &["-rd1", "-c", "IOPlatformExpertDevice"])?;
    output
        .lines()
        .find_map(|line| {
            if !line.contains("IOPlatformUUID") {
                return None;
            }
            line.split('=')
                .nth(1)
                .map(|value| value.trim().trim_matches('"').to_string())
        })
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
        line.split_whitespace().last().map(|value| value.to_string())
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn machine_identity_source() -> Option<String> {
    None
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
        .or_else(|| command_output("hostname", &[]))
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
    Ok(value
        .unwrap_or_else(|| LicenseState::inactive(&device))
        .with_device(&device))
}

pub fn license_state_save(
    app: &tauri::AppHandle,
    state: LicenseState,
) -> Result<LicenseState, String> {
    let device = license_device_info();
    let next = state.with_device(&device);
    let path = storage::path_license_state(app)?;
    storage::json_write_atomic(&path, &next)?;
    Ok(next)
}

pub fn license_state_clear(app: &tauri::AppHandle) -> Result<LicenseState, String> {
    let path = storage::path_license_state(app)?;
    storage::remove_if_exists(&path)?;
    Ok(LicenseState::inactive(&license_device_info()))
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

fn normalize_api_state(
    payload: LicenseApiResponse,
    device: &LicenseDeviceInfo,
    previous: Option<&LicenseState>,
    license_key: Option<String>,
) -> LicenseState {
    LicenseState {
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
        message: pick_string(&[
            payload.message,
            payload.error,
            previous.and_then(|state| state.message.clone()),
        ]),
    }
}

async fn post_license_api(
    api_base: &str,
    path: &str,
    body: &LicenseApiRequest,
) -> Result<LicenseApiResponse, String> {
    let base = api_base.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("License API is not configured.".to_string());
    }

    let client = reqwest::Client::new();
    let res = client
        .post(format!("{base}{path}"))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("License request failed: {e}"))?;

    let status = res.status();
    let payload = res
        .json::<LicenseApiResponse>()
        .await
        .map_err(|e| format!("License response parse failed: {e}"))?;

    if !status.is_success() {
        return Err(
            pick_string(&[payload.message.clone(), payload.error.clone()])
                .unwrap_or_else(|| format!("License API returned {status}")),
        );
    }

    Ok(payload)
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
        "/v1/licenses/activate",
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
        "/v1/licenses/validate",
        &LicenseApiRequest {
            product,
            license_key: current.license_key.clone(),
            activation_token: current.activation_token.clone(),
            device: device.clone(),
        },
    )
    .await?;

    let next = normalize_api_state(payload, &device, Some(&current), current.license_key.clone());
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
        "/v1/licenses/deactivate",
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
