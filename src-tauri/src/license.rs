use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;
#[cfg(not(target_os = "macos"))]
use std::process::Command as StdCommand;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use crate::distribution::Distribution;
use crate::file_storage as storage;

const LICENSE_STATE_VERSION: u32 = 1;
const TRIAL_DURATION_DAYS: i64 = 14;
const TRIAL_EXPIRED_MESSAGE: &str = "Your 14-day free trial has expired.";

/// Bounds for one license operation; the operation lock is held for at most `operation`.
#[derive(Debug, Clone, Copy)]
struct HttpLimits {
    connect: Duration,
    attempt: Duration,
    operation: Duration,
}

const HTTP_LIMITS: HttpLimits = HttpLimits {
    connect: Duration::from_secs(5),
    attempt: Duration::from_secs(15),
    operation: Duration::from_secs(30),
};
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_SERVER_MESSAGE_CHARS: usize = 300;

/// Runs license mutations one at a time, end to end (HTTP included), so none acts on a
/// snapshot another one replaced while it waited.
fn license_op_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}
/// Guards each read-modify-write of the state file. Never held across an `await`.
static LICENSE_FILE_LOCK: Mutex<()> = Mutex::new(());
/// Orders every snapshot handed to the frontend, including re-reads without a disk change
/// (an expiry), so a delayed older snapshot can never replace a newer one.
static SNAPSHOT_SEQ: AtomicU64 = AtomicU64::new(0);

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
    /// Whether Pro features are unlocked. Derived on every read; never trusted from input.
    #[serde(default)]
    pub pro_access: bool,
    /// When the current Pro access ends (epoch ms); `None` when unlimited or locked. Derived.
    #[serde(default)]
    pub pro_access_until: Option<i64>,
    /// An active license on a paid plan, trials excluded (the AI gateway tier). Derived.
    #[serde(default)]
    pub paid_license: bool,
    /// Original start of a trial kept on this device by older builds; sent once to the
    /// license server so the trial keeps its remaining days.
    #[serde(default)]
    pub legacy_trial_started_at: Option<i64>,
    /// The legacy trial was handed over to the license server and is never captured again.
    #[serde(default)]
    pub legacy_retired: bool,
    /// Incremented by every write of the state file.
    #[serde(default)]
    pub revision: u64,
    /// Order of this snapshot within the process; the frontend publishes only newer ones.
    #[serde(default, skip_deserializing)]
    pub snapshot_seq: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LicenseErrorKind {
    Config,
    Timeout,
    Network,
    Http,
    Malformed,
    Storage,
}

/// A failed license operation. Carries no request body, response body or URL; `state` is
/// the current snapshot so the frontend can still publish it.
#[derive(Debug, Clone, Serialize)]
pub struct LicenseOpError {
    pub kind: LicenseErrorKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(rename = "retryAfterMs", skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<Box<LicenseState>>,
}

impl LicenseOpError {
    fn new(kind: LicenseErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            status: None,
            retry_after_ms: None,
            message: message.into(),
            state: None,
        }
    }

    fn storage(error: String) -> Self {
        Self::new(LicenseErrorKind::Storage, error)
    }
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

fn parse_license_api_response(text: &str) -> Option<LicenseApiResponse> {
    if let Ok(parsed) = serde_json::from_str::<LicenseApiResponse>(text) {
        return Some(parsed);
    }
    let value: Value = serde_json::from_str(text).ok()?;
    for key in ["data", "license", "result"] {
        if let Some(inner) = value.get(key) {
            if let Ok(parsed) = serde_json::from_value::<LicenseApiResponse>(inner.clone()) {
                return Some(parsed);
            }
        }
    }
    serde_json::from_value::<LicenseApiResponse>(value).ok()
}

impl LicenseState {
    /// A fresh state whose local trial starts at `now`, the same instant used to evaluate it.
    fn inactive_at(device: &LicenseDeviceInfo, now: i64) -> Self {
        let trial_started_at = now;
        let trial_expires_at =
            now.saturating_add(chrono::Duration::days(TRIAL_DURATION_DAYS).num_milliseconds());

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
            pro_access_until: None,
            paid_license: false,
            legacy_trial_started_at: None,
            legacy_retired: false,
            revision: 0,
            snapshot_seq: 0,
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

/// The paid license's end. A present but unreadable expiry never unlocks anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PaidExpiry {
    Unlimited,
    At(i64),
    Invalid,
}

/// Only an absent (or null) expiry is unlimited; any present value must parse, so a blank
/// or malformed one never unlocks anything.
fn paid_expiry(state: &LicenseState) -> PaidExpiry {
    match state.expires_at.as_deref().map(str::trim) {
        None => PaidExpiry::Unlimited,
        Some(raw) => parse_expiry_timestamp(raw)
            .map(|expiry| PaidExpiry::At(expiry.timestamp_millis()))
            .unwrap_or(PaidExpiry::Invalid),
    }
}

fn is_active(state: &LicenseState) -> bool {
    state.status.trim().eq_ignore_ascii_case("active")
}

/// Whether the plan is paid. The API's `plan` tier decides whenever it is present (only
/// "pro" is paid, blank or unknown values are not); older servers send only a display name,
/// where "Pro" and the former "Ultimate" are paid, with an optional trailing "plan".
fn paid_tier(plan: Option<&str>, plan_name: Option<&str>) -> bool {
    if let Some(plan) = plan {
        return plan.trim().eq_ignore_ascii_case("pro");
    }
    plan_name.is_some_and(|name| {
        let name = name.trim().to_lowercase();
        let base = name
            .strip_suffix(" plan")
            .map(str::trim_end)
            .unwrap_or(name.as_str());
        matches!(base, "pro" | "ultimate")
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Entitlement {
    paid: bool,
    pro_access: bool,
    until: Option<i64>,
}

/// End of a trial that is running at `now`.
fn running_trial_end(state: &LicenseState, distribution: Distribution, now: i64) -> Option<i64> {
    if !distribution.supports_local_trial() {
        return None;
    }
    let expires_at = state.trial_expires_at?;
    let started = state.trial_started_at.unwrap_or(i64::MIN);
    (started <= now && now < expires_at).then_some(expires_at)
}

/// Pro access is the union of an active paid license and a running trial; it lasts until
/// the latest end among them (no end if the paid license is unlimited). Flavors that do not
/// gate Pro features always unlock them.
fn entitlement(state: &LicenseState, distribution: Distribution, now: i64) -> Entitlement {
    let expiry = paid_expiry(state);
    let paid = is_active(state)
        && paid_tier(state.plan.as_deref(), state.plan_name.as_deref())
        && match expiry {
            PaidExpiry::Unlimited => true,
            PaidExpiry::At(expires_at) => now < expires_at,
            PaidExpiry::Invalid => false,
        };
    if !distribution.gates_pro_features() {
        return Entitlement {
            paid,
            pro_access: true,
            until: None,
        };
    }
    let paid_end = paid.then_some(match expiry {
        PaidExpiry::At(expires_at) => Some(expires_at),
        _ => None,
    });
    let (pro_access, until) = match (paid_end, running_trial_end(state, distribution, now)) {
        (Some(None), _) => (true, None),
        (Some(Some(paid)), Some(trial)) => (true, Some(paid.max(trial))),
        (Some(Some(paid)), None) => (true, Some(paid)),
        (None, Some(trial)) => (true, Some(trial)),
        (None, None) => (false, None),
    };
    Entitlement {
        paid,
        pro_access,
        until,
    }
}

/// Single exit path for license state handed to storage and the frontend.
fn finalize_state(mut state: LicenseState, distribution: Distribution, now: i64) -> LicenseState {
    state = apply_trial_policy(state, distribution);
    normalize_state_timestamps(&mut state);
    apply_local_expiry(&mut state, now);
    let entitlement = entitlement(&state, distribution, now);
    state.paid_license = entitlement.paid;
    state.pro_access = entitlement.pro_access;
    state.pro_access_until = entitlement.until;
    state
}

fn apply_local_expiry(state: &mut LicenseState, now: i64) {
    if !is_active(state) {
        if state
            .trial_expires_at
            .is_some_and(|trial_expires_at| trial_expires_at <= now)
            && state.message.as_deref().unwrap_or("").trim().is_empty()
        {
            state.message = Some(TRIAL_EXPIRED_MESSAGE.to_string());
        }
        return;
    }

    if let PaidExpiry::At(expires_at) = paid_expiry(state) {
        if expires_at <= now {
            state.status = "expired".to_string();
            if state.message.as_deref().unwrap_or("").trim().is_empty() {
                state.message = Some("This license has expired.".to_string());
            }
        }
    }
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
    state.legacy_trial_started_at = state
        .legacy_trial_started_at
        .map(normalize_unix_timestamp_millis);
}

/// Records the original start of a trial kept by an older build, once, so the first
/// license-server sync can honour it. Never recaptured after the hand-over.
fn capture_legacy_trial(state: &mut LicenseState) -> bool {
    if state.legacy_retired || state.legacy_trial_started_at.is_some() {
        return false;
    }
    let Some(started_at) = state.trial_started_at else {
        return false;
    };
    state.legacy_trial_started_at = Some(normalize_unix_timestamp_millis(started_at));
    true
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

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn lock_file() -> MutexGuard<'static, ()> {
    LICENSE_FILE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The only decoder of the state file (or a fresh state when there is none). Applies the
/// legacy-trial capture; `true` means the result differs from disk and must be written.
/// Call with the file lock held.
fn read_state_locked(
    path: &Path,
    device: &LicenseDeviceInfo,
    distribution: Distribution,
    now: i64,
) -> Result<(LicenseState, bool), LicenseOpError> {
    let existing =
        storage::json_read_if_exists::<LicenseState>(path).map_err(LicenseOpError::storage)?;
    let (state, mut dirty) = match existing {
        // A newer build's file is left untouched rather than reset.
        Some(state) if state.version > LICENSE_STATE_VERSION => {
            return Err(LicenseOpError::storage(
                "License data was saved by a newer version of PoliteDB.".to_string(),
            ))
        }
        // Older versions are migrated in place (`with_device` sets the current version),
        // keeping credentials and the original trial start.
        Some(state) => {
            let migrated = state.version < LICENSE_STATE_VERSION;
            (state, migrated)
        }
        None => (LicenseState::inactive_at(device, now), true),
    };
    let mut state = state.with_device(device);
    normalize_state_timestamps(&mut state);
    if distribution.supports_local_trial() {
        dirty |= capture_legacy_trial(&mut state);
    }
    Ok((state, dirty))
}

/// Writes `state` as the revision after `disk_revision`. Call with the file lock held.
fn write_state_locked(
    path: &Path,
    mut state: LicenseState,
    disk_revision: u64,
) -> Result<LicenseState, LicenseOpError> {
    state.revision = disk_revision.saturating_add(1);
    // Keeps the previous file if the replacement fails; owner-only (it holds the key).
    storage::json_replace_private(path, &state).map_err(LicenseOpError::storage)?;
    Ok(state)
}

/// Finalizes a state for the frontend and stamps its snapshot order. Call with the file
/// lock held, so sequence order matches read/write order.
fn snapshot(state: LicenseState, distribution: Distribution, now: i64) -> LicenseState {
    let mut state = finalize_state(state, distribution, now);
    state.snapshot_seq = SNAPSHOT_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    state
}

fn load_at(
    path: &Path,
    device: &LicenseDeviceInfo,
    distribution: Distribution,
    now: i64,
) -> Result<LicenseState, LicenseOpError> {
    let _file = lock_file();
    let (state, dirty) = read_state_locked(path, device, distribution, now)?;
    let state = if dirty {
        let revision = state.revision;
        write_state_locked(path, finalize_state(state, distribution, now), revision)?
    } else {
        state
    };
    Ok(snapshot(state, distribution, now))
}

/// Fields owned by this device rather than by a license operation or the caller: they are
/// always taken from disk.
fn carry_device_fields(next: &mut LicenseState, disk: &LicenseState) {
    next.trial_started_at = disk.trial_started_at;
    next.trial_expires_at = disk.trial_expires_at;
    next.legacy_trial_started_at = disk.legacy_trial_started_at;
    next.legacy_retired = disk.legacy_retired;
}

/// Re-reads disk and writes `build(disk)` in one file-lock section, keeping device fields.
fn commit_at(
    path: &Path,
    device: &LicenseDeviceInfo,
    distribution: Distribution,
    now: i64,
    build: impl FnOnce(&LicenseState) -> LicenseState,
) -> Result<LicenseState, LicenseOpError> {
    let _file = lock_file();
    let (disk, _) = read_state_locked(path, device, distribution, now)?;
    let mut next = build(&disk).with_device(device);
    carry_device_fields(&mut next, &disk);
    let written = write_state_locked(path, finalize_state(next, distribution, now), disk.revision)?;
    Ok(snapshot(written, distribution, now))
}

/// Attaches the current snapshot to a failed operation so the frontend can publish it.
fn with_current_state(
    mut error: LicenseOpError,
    path: &Path,
    device: &LicenseDeviceInfo,
    distribution: Distribution,
) -> LicenseOpError {
    if let Ok(state) = load_at(path, device, distribution, now_ms()) {
        error.state = Some(Box::new(state));
    }
    error
}

fn state_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, LicenseOpError> {
    storage::path_license_state(app).map_err(LicenseOpError::storage)
}

pub fn license_state_load(app: &tauri::AppHandle) -> Result<LicenseState, LicenseOpError> {
    load_at(
        &state_path(app)?,
        &license_device_info(),
        Distribution::current(),
        now_ms(),
    )
}

/// Fails with `code` unless Pro features are unlocked right now. For Pro-only commands; an
/// unreadable license file counts as locked.
pub fn require_pro(app: &tauri::AppHandle, code: &str) -> Result<(), String> {
    pro_gate(Distribution::current(), || license_state_load(app), code)
}

/// Flavors that do not gate Pro features pass without touching the license file.
fn pro_gate(
    distribution: Distribution,
    load: impl FnOnce() -> Result<LicenseState, LicenseOpError>,
    code: &str,
) -> Result<(), String> {
    if !distribution.gates_pro_features() {
        return Ok(());
    }
    match load() {
        Ok(state) if state.pro_access => Ok(()),
        _ => Err(code.to_string()),
    }
}

pub async fn license_state_save(
    app: &tauri::AppHandle,
    state: LicenseState,
) -> Result<LicenseState, LicenseOpError> {
    let path = state_path(app)?;
    let _op = license_op_lock().lock().await;
    commit_at(
        &path,
        &license_device_info(),
        Distribution::current(),
        now_ms(),
        |_| state,
    )
}

pub async fn license_state_clear(app: &tauri::AppHandle) -> Result<LicenseState, LicenseOpError> {
    let path = state_path(app)?;
    let _op = license_op_lock().lock().await;
    clear_at(&path, &license_device_info(), Distribution::current())
}

fn clear_at(
    path: &Path,
    device: &LicenseDeviceInfo,
    distribution: Distribution,
) -> Result<LicenseState, LicenseOpError> {
    let now = now_ms();
    commit_at(path, device, distribution, now, |_| {
        LicenseState::inactive_at(device, now)
    })
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

/// Builds the state from a license API response. The plan fields come from the response
/// only (never from `previous`), so a stale paid plan cannot outlive a downgrade. Trial and
/// legacy fields are filled in from disk by `commit_at`.
fn normalize_api_state(
    payload: LicenseApiResponse,
    device: &LicenseDeviceInfo,
    previous: Option<&LicenseState>,
    license_key: Option<String>,
) -> LicenseState {
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
        plan_name: pick_string(&[payload.plan_name]),
        customer_email: pick_string(&[
            payload.customer_email,
            previous.and_then(|state| state.customer_email.clone()),
        ]),
        instance_name: pick_string(&[
            payload.instance_name,
            previous.and_then(|state| state.instance_name.clone()),
        ]),
        // The response decides the expiry: null or missing means unlimited, and a finite
        // deadline is never inherited from `previous`. Blank values stay present (invalid).
        expires_at: payload.expires_at.map(|expiry| expiry.trim().to_string()),
        activated_at: pick_i64(&[
            payload.activated_at,
            previous.and_then(|state| state.activated_at),
        ]),
        last_validated_at: pick_i64(&[
            payload.last_validated_at,
            previous.and_then(|state| state.last_validated_at),
            Some(now_ms()),
        ]),
        seats_allowed: pick_u32(&[
            payload.seats_allowed,
            previous.and_then(|state| state.seats_allowed),
        ]),
        devices_used: pick_u32(&[
            payload.devices_used,
            previous.and_then(|state| state.devices_used),
        ]),
        trial_started_at: None,
        trial_expires_at: None,
        message: pick_string(&[
            payload.message,
            payload.error,
            previous.and_then(|state| state.message.clone()),
        ]),
        // Present-but-blank stays present: it is not a paid tier.
        plan: payload.plan.map(|plan| plan.trim().to_string()),
        pro_access: false,
        pro_access_until: None,
        paid_license: false,
        legacy_trial_started_at: None,
        legacy_retired: false,
        revision: 0,
        snapshot_seq: 0,
    };
    normalize_state_timestamps(&mut state);
    state
}

fn request_error(error: reqwest::Error) -> LicenseOpError {
    if error.is_timeout() {
        timeout_error()
    } else {
        LicenseOpError::new(
            LicenseErrorKind::Network,
            "Could not reach the license server.",
        )
    }
}

fn timeout_error() -> LicenseOpError {
    LicenseOpError::new(
        LicenseErrorKind::Timeout,
        "The license server did not respond in time.",
    )
}

fn malformed_error() -> LicenseOpError {
    LicenseOpError::new(
        LicenseErrorKind::Malformed,
        "The license server sent an unexpected response.",
    )
}

/// `Retry-After` as delay-seconds or an HTTP date.
fn parse_retry_after(value: &str, now: i64) -> Option<u64> {
    let value = value.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(seconds.saturating_mul(1_000));
    }
    let at = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    Some(u64::try_from(at.timestamp_millis().saturating_sub(now)).unwrap_or(0))
}

/// Reads at most `MAX_RESPONSE_BYTES` of the body.
async fn read_capped(mut response: reqwest::Response) -> Result<Vec<u8>, LicenseOpError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(malformed_error());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(malformed_error());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// The server's own message for a failed request, shortened.
fn server_message(payload: &LicenseApiResponse) -> Option<String> {
    pick_string(&[payload.message.clone(), payload.error.clone()])
        .map(|message| message.chars().take(MAX_SERVER_MESSAGE_CHARS).collect())
}

async fn post_license_api(
    api_base: &str,
    action: &str,
    body: &LicenseApiRequest,
    limits: HttpLimits,
) -> Result<LicenseApiResponse, LicenseOpError> {
    let base = api_base.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(LicenseOpError::new(
            LicenseErrorKind::Config,
            "License API is not configured.",
        ));
    }
    tokio::time::timeout(
        limits.operation,
        post_candidates(base, action, body, limits),
    )
    .await
    .unwrap_or_else(|_| Err(timeout_error()))
}

async fn post_candidates(
    base: &str,
    action: &str,
    body: &LicenseApiRequest,
    limits: HttpLimits,
) -> Result<LicenseApiResponse, LicenseOpError> {
    let client = reqwest::Client::builder()
        .connect_timeout(limits.connect)
        .timeout(limits.attempt)
        .build()
        .map_err(request_error)?;

    for url in license_endpoint_candidates(base, action) {
        let response = client
            .post(&url)
            .json(body)
            .send()
            .await
            .map_err(request_error)?;
        let status = response.status();
        let retry_after_ms = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| parse_retry_after(value, now_ms()));
        let bytes = read_capped(response).await?;
        let text = String::from_utf8_lossy(&bytes);
        let http_error = |message: Option<String>| LicenseOpError {
            kind: LicenseErrorKind::Http,
            status: Some(status.as_u16()),
            retry_after_ms,
            message: message
                .unwrap_or_else(|| format!("The license server returned {}.", status.as_u16())),
            state: None,
        };

        match parse_license_api_response(&text) {
            Some(payload) if status.is_success() => return Ok(payload),
            Some(_) if status == reqwest::StatusCode::NOT_FOUND => continue,
            Some(payload) => return Err(http_error(server_message(&payload))),
            None if status == reqwest::StatusCode::NOT_FOUND
                || text.contains("Cannot POST")
                || text.contains("<!DOCTYPE html") =>
            {
                continue
            }
            None if !status.is_success() => return Err(http_error(None)),
            None => return Err(malformed_error()),
        }
    }

    Err(LicenseOpError {
        kind: LicenseErrorKind::Http,
        status: Some(404),
        retry_after_ms: None,
        message: "The license server endpoint was not found.".to_string(),
        state: None,
    })
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

/// Where a license operation runs; split out so tests can use a temporary file.
struct OpTarget<'a> {
    /// `license_op_lock()` in the app; a private lock per test.
    lock: &'a tokio::sync::Mutex<()>,
    path: &'a Path,
    device: &'a LicenseDeviceInfo,
    distribution: Distribution,
    limits: HttpLimits,
}

async fn activate_at(
    target: &OpTarget<'_>,
    api_base: &str,
    product: String,
    license_key: String,
) -> Result<LicenseState, LicenseOpError> {
    let _op = target.lock.lock().await;
    let request = LicenseApiRequest {
        product,
        license_key: Some(license_key.clone()),
        activation_token: None,
        device: target.device.clone(),
    };
    let payload = post_license_api(api_base, "activate", &request, target.limits)
        .await
        .map_err(|error| {
            with_current_state(error, target.path, target.device, target.distribution)
        })?;
    commit_at(
        target.path,
        target.device,
        target.distribution,
        now_ms(),
        |_| normalize_api_state(payload, target.device, None, Some(license_key)),
    )
}

async fn refresh_at(
    target: &OpTarget<'_>,
    api_base: &str,
    product: String,
) -> Result<LicenseState, LicenseOpError> {
    let _op = target.lock.lock().await;
    let current = load_at(target.path, target.device, target.distribution, now_ms())?;
    let request = LicenseApiRequest {
        product,
        license_key: current.license_key.clone(),
        activation_token: current.activation_token.clone(),
        device: target.device.clone(),
    };
    let payload = post_license_api(api_base, "validate", &request, target.limits)
        .await
        .map_err(|error| {
            with_current_state(error, target.path, target.device, target.distribution)
        })?;
    commit_at(
        target.path,
        target.device,
        target.distribution,
        now_ms(),
        |disk| normalize_api_state(payload, target.device, Some(disk), disk.license_key.clone()),
    )
}

async fn deactivate_at(
    target: &OpTarget<'_>,
    api_base: &str,
    product: String,
) -> Result<LicenseState, LicenseOpError> {
    let _op = target.lock.lock().await;
    // Read under the operation lock: this is the license on disk now, never an older one.
    let current = load_at(target.path, target.device, target.distribution, now_ms())?;
    let request = LicenseApiRequest {
        product,
        license_key: current.license_key.clone(),
        activation_token: current.activation_token.clone(),
        device: target.device.clone(),
    };
    post_license_api(api_base, "deactivate", &request, target.limits)
        .await
        .map_err(|error| {
            with_current_state(error, target.path, target.device, target.distribution)
        })?;
    clear_at(target.path, target.device, target.distribution)
}

fn app_target<'a>(path: &'a Path, device: &'a LicenseDeviceInfo) -> OpTarget<'a> {
    OpTarget {
        lock: license_op_lock(),
        path,
        device,
        distribution: Distribution::current(),
        limits: HTTP_LIMITS,
    }
}

pub async fn license_activate(
    app: &tauri::AppHandle,
    api_base: String,
    product: String,
    license_key: String,
) -> Result<LicenseState, LicenseOpError> {
    let path = state_path(app)?;
    let device = license_device_info();
    activate_at(&app_target(&path, &device), &api_base, product, license_key).await
}

pub async fn license_refresh(
    app: &tauri::AppHandle,
    api_base: String,
    product: String,
) -> Result<LicenseState, LicenseOpError> {
    let path = state_path(app)?;
    let device = license_device_info();
    refresh_at(&app_target(&path, &device), &api_base, product).await
}

pub async fn license_deactivate(
    app: &tauri::AppHandle,
    api_base: String,
    product: String,
) -> Result<LicenseState, LicenseOpError> {
    let path = state_path(app)?;
    let device = license_device_info();
    deactivate_at(&app_target(&path, &device), &api_base, product).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const NOW: i64 = 1_800_000_000_000;
    const DAY: i64 = 86_400_000;

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

    fn no_trial() -> LicenseState {
        LicenseState {
            trial_started_at: None,
            trial_expires_at: None,
            ..LicenseState::inactive_at(&test_device(), NOW)
        }
    }

    fn licensed(status: &str, plan: Option<&str>, plan_name: Option<&str>) -> LicenseState {
        LicenseState {
            status: status.to_string(),
            plan: plan.map(str::to_string),
            plan_name: plan_name.map(str::to_string),
            ..no_trial()
        }
    }

    fn with_trial(status: &str, trial_expires_at: i64) -> LicenseState {
        LicenseState {
            status: status.to_string(),
            trial_started_at: Some(trial_expires_at - 14 * DAY),
            trial_expires_at: Some(trial_expires_at),
            ..LicenseState::inactive_at(&test_device(), NOW)
        }
    }

    fn iso(ms: i64) -> String {
        chrono::DateTime::from_timestamp_millis(ms)
            .unwrap()
            .to_rfc3339()
    }

    fn direct(state: &LicenseState, now: i64) -> Entitlement {
        entitlement(state, Distribution::Direct, now)
    }

    fn temp_path() -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("politedb-license-{}", uuid::Uuid::new_v4()))
            .join("state.json")
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

    #[test]
    fn plan_fields_come_from_the_response_only() {
        let device = test_device();
        let previous = LicenseState {
            plan: Some("pro".to_string()),
            plan_name: Some("Ultimate".to_string()),
            ..LicenseState::inactive_at(&device, NOW)
        };
        let state = normalize_api_state(empty_payload(), &device, Some(&previous), None);
        assert_eq!(state.plan, None);
        assert_eq!(state.plan_name, None);

        let mut payload = empty_payload();
        payload.plan = Some("  ".to_string());
        let state = normalize_api_state(payload, &device, Some(&previous), None);
        assert_eq!(state.plan.as_deref(), Some(""));
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
            LicenseState::inactive_at(&test_device(), NOW),
            Distribution::AppStore,
        );
        assert_eq!(fresh.trial_started_at, None);
        assert_eq!(fresh.trial_expires_at, None);

        let mut expired = with_trial("inactive", 1_000);
        expired.message = Some(TRIAL_EXPIRED_MESSAGE.to_string());
        let mut expired = apply_trial_policy(expired, Distribution::AppStore);
        assert_eq!(expired.trial_expires_at, None);
        assert_eq!(expired.message, None);
        // No trial message is re-added once the dates are gone.
        apply_local_expiry(&mut expired, NOW);
        assert_eq!(expired.message, None);
    }

    #[test]
    fn app_store_keeps_unrelated_messages() {
        let mut state = with_trial("invalid", 1_000);
        state.message = Some("License key is invalid.".to_string());
        let next = apply_trial_policy(state, Distribution::AppStore);
        assert_eq!(next.message.as_deref(), Some("License key is invalid."));
    }

    #[test]
    fn paid_tier_needs_a_positive_paid_signal() {
        // (plan, plan_name, paid)
        let cases: &[(Option<&str>, Option<&str>, bool)] = &[
            (Some("pro"), None, true),
            (Some(" PRO "), Some("Polar License"), true),
            (Some("free"), Some("Ultimate"), false),
            (Some(""), Some("Pro"), false),
            (Some("  "), Some("Pro"), false),
            (Some("enterprise"), None, false),
            (None, Some("Pro"), true),
            (None, Some("pro"), true),
            (None, Some(" Pro plan "), true),
            (None, Some("Pro plans"), false),
            (None, Some("Ultimate"), true),
            (None, Some("ultimate plan"), true),
            (None, Some("Polar License"), false),
            (None, Some(""), false),
            (None, Some("plan"), false),
            (None, None, false),
        ];
        for (plan, plan_name, paid) in cases {
            assert_eq!(
                paid_tier(*plan, *plan_name),
                *paid,
                "{plan:?} / {plan_name:?}"
            );
        }
    }

    #[test]
    fn only_an_active_unexpired_paid_license_is_paid() {
        for status in ["inactive", "expired", "invalid", "error"] {
            assert!(!direct(&licensed(status, Some("pro"), None), NOW).pro_access);
        }
        let paid = direct(&licensed(" Active ", Some("pro"), None), NOW);
        assert_eq!(
            paid,
            Entitlement {
                paid: true,
                pro_access: true,
                until: None
            }
        );
        assert!(!direct(&licensed("active", None, None), NOW).pro_access);
        assert!(!direct(&licensed("active", None, Some("Polar License")), NOW).pro_access);
    }

    #[test]
    fn paid_expiry_bounds_access() {
        let mut state = licensed("active", Some("pro"), None);
        state.expires_at = Some(iso(NOW + DAY));
        assert_eq!(direct(&state, NOW).until, Some(NOW + DAY));
        // Equal to now counts as expired.
        state.expires_at = Some(iso(NOW));
        assert!(!direct(&state, NOW).pro_access);
        apply_local_expiry(&mut state, NOW);
        assert_eq!(state.status, "expired");
        // A present but unreadable expiry never unlocks; status is left alone.
        let mut malformed = licensed("active", Some("pro"), None);
        malformed.expires_at = Some("next year".to_string());
        assert!(!direct(&malformed, NOW).paid);
        apply_local_expiry(&mut malformed, NOW);
        assert_eq!(malformed.status, "active");
    }

    #[test]
    fn running_trial_unlocks_pro_until_it_expires() {
        assert_eq!(
            direct(&with_trial("inactive", NOW + 1), NOW),
            Entitlement {
                paid: false,
                pro_access: true,
                until: Some(NOW + 1)
            }
        );
        assert!(!direct(&with_trial("inactive", NOW), NOW).pro_access);
        assert!(!direct(&with_trial("inactive", NOW - 1), NOW).pro_access);
        // A trial that has not started yet does not count.
        let mut future = with_trial("inactive", NOW + 20 * DAY);
        future.trial_started_at = Some(NOW + DAY);
        assert!(!direct(&future, NOW).pro_access);
    }

    #[test]
    fn access_lasts_until_the_latest_eligible_grant() {
        let paid_until = |days: i64| {
            let mut state = with_trial("active", NOW + 7 * DAY);
            state.plan = Some("pro".to_string());
            state.expires_at = Some(iso(NOW + days * DAY));
            state
        };
        // Paid ends first: the trial keeps access.
        assert_eq!(direct(&paid_until(1), NOW).until, Some(NOW + 7 * DAY));
        // Trial ends first: the paid license keeps access.
        assert_eq!(direct(&paid_until(30), NOW).until, Some(NOW + 30 * DAY));
        // Unlimited paid license plus a trial: no end.
        let mut unlimited = paid_until(1);
        unlimited.expires_at = None;
        assert_eq!(direct(&unlimited, NOW).until, None);
        assert!(direct(&unlimited, NOW).pro_access);
        // Neither grant.
        assert_eq!(
            direct(&no_trial(), NOW),
            Entitlement {
                paid: false,
                pro_access: false,
                until: None
            }
        );
    }

    #[test]
    fn app_store_unlocks_pro_before_any_other_rule() {
        let mut expired = licensed("active", Some("pro"), None);
        expired.expires_at = Some(iso(NOW - DAY));
        for state in [no_trial(), expired, with_trial("inactive", NOW + DAY)] {
            let entitlement = entitlement(&state, Distribution::AppStore, NOW);
            assert!(entitlement.pro_access);
            assert_eq!(entitlement.until, None);
        }
        let stripped = finalize_state(
            with_trial("inactive", NOW + DAY),
            Distribution::AppStore,
            NOW,
        );
        assert_eq!(stripped.trial_expires_at, None);
        assert!(stripped.pro_access);
    }

    #[test]
    fn derived_fields_from_input_are_recomputed() {
        let mut forged = no_trial();
        forged.pro_access = true;
        forged.paid_license = true;
        forged.pro_access_until = Some(i64::MAX);
        let next = finalize_state(forged, Distribution::Direct, NOW);
        assert!(!next.pro_access);
        assert!(!next.paid_license);
        assert_eq!(next.pro_access_until, None);
    }

    #[test]
    fn load_creates_once_and_orders_every_snapshot() {
        let path = temp_path();
        // Fresh states start a real trial at the wall clock.
        let now = now_ms();
        let device = test_device();
        let first = load_at(&path, &device, Distribution::Direct, now).unwrap();
        let second = load_at(&path, &device, Distribution::Direct, now).unwrap();
        // The fresh state is written once; a plain re-read does not write.
        assert_eq!(first.revision, 1);
        assert_eq!(second.revision, 1);
        assert_eq!(first.trial_started_at, second.trial_started_at);
        assert!(second.snapshot_seq > first.snapshot_seq);
        // A re-read after the trial ended: same revision, newer snapshot, access gone.
        let later = load_at(
            &path,
            &device,
            Distribution::Direct,
            first.trial_expires_at.unwrap(),
        )
        .unwrap();
        assert_eq!(later.revision, 1);
        assert!(later.snapshot_seq > second.snapshot_seq);
        assert!(first.pro_access);
        assert!(!later.pro_access);
    }

    #[test]
    fn malformed_expiry_survives_save_and_reload() {
        let path = temp_path();
        // Fresh states start a real trial at the wall clock.
        let now = now_ms();
        let device = test_device();
        load_at(&path, &device, Distribution::Direct, now).unwrap();
        let saved = commit_at(&path, &device, Distribution::Direct, now, |disk| {
            LicenseState {
                status: "active".to_string(),
                plan: Some("pro".to_string()),
                expires_at: Some("garbage".to_string()),
                ..disk.clone()
            }
        })
        .unwrap();
        assert!(!saved.paid_license);
        let reloaded = load_at(&path, &device, Distribution::Direct, now).unwrap();
        assert_eq!(reloaded.expires_at.as_deref(), Some("garbage"));
        assert!(!reloaded.paid_license);
        // The trial still counts.
        assert!(reloaded.pro_access);
    }

    fn write_legacy_file(path: &Path, started_seconds: i64) {
        let mut legacy = with_trial("inactive", 0);
        legacy.trial_started_at = Some(started_seconds);
        legacy.trial_expires_at = Some(started_seconds + 14 * 86_400);
        let mut value = serde_json::to_value(&legacy).unwrap();
        let object = value.as_object_mut().unwrap();
        // A file written by an older build has none of the new fields.
        for key in [
            "pro_access",
            "pro_access_until",
            "paid_license",
            "legacy_trial_started_at",
            "legacy_retired",
            "revision",
            "snapshot_seq",
            "plan",
        ] {
            object.remove(key);
        }
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }

    #[test]
    fn legacy_trial_start_is_captured_before_any_mutation_and_kept() {
        let path = temp_path();
        let device = test_device();
        let started = 1_790_000_000; // seconds, as older files may hold
        write_legacy_file(&path, started);

        // A mutation before the first load still keeps the original start.
        let cleared = clear_at(&path, &device, Distribution::Direct).unwrap();
        assert_eq!(cleared.legacy_trial_started_at, Some(started * 1_000));
        assert_eq!(cleared.trial_started_at, Some(started * 1_000));

        let saved = commit_at(&path, &device, Distribution::Direct, NOW, |_| {
            LicenseState {
                legacy_trial_started_at: Some(NOW),
                trial_started_at: Some(NOW),
                ..LicenseState::inactive_at(&device, NOW)
            }
        })
        .unwrap();
        // Callers cannot replace device-owned fields.
        assert_eq!(saved.legacy_trial_started_at, Some(started * 1_000));
        assert_eq!(saved.trial_started_at, Some(started * 1_000));

        let reloaded = load_at(&path, &device, Distribution::Direct, NOW).unwrap();
        assert_eq!(reloaded.legacy_trial_started_at, Some(started * 1_000));
    }

    #[test]
    fn retired_legacy_trial_is_never_recaptured() {
        let mut state = with_trial("inactive", NOW);
        state.legacy_retired = true;
        assert!(!capture_legacy_trial(&mut state));
        assert_eq!(state.legacy_trial_started_at, None);

        let mut state = with_trial("inactive", NOW);
        assert!(capture_legacy_trial(&mut state));
        let first = state.legacy_trial_started_at;
        state.trial_started_at = Some(NOW);
        assert!(!capture_legacy_trial(&mut state));
        assert_eq!(state.legacy_trial_started_at, first);
    }

    #[test]
    fn pro_gate_locks_free_and_unreadable_states() {
        let direct = Distribution::Direct;
        let pro = finalize_state(with_trial("inactive", NOW + DAY), direct, NOW);
        assert_eq!(pro_gate(direct, || Ok(pro), "CODE"), Ok(()));
        let free = finalize_state(no_trial(), direct, NOW);
        assert_eq!(
            pro_gate(direct, || Ok(free), "CODE"),
            Err("CODE".to_string())
        );
        let unreadable = || Err(LicenseOpError::storage("Parse JSON failed".into()));
        assert_eq!(
            pro_gate(direct, unreadable, "CODE"),
            Err("CODE".to_string())
        );
        // The App Store flavor never reads the file, so an unreadable one cannot lock it.
        assert_eq!(
            pro_gate(
                Distribution::AppStore,
                || panic!("the license file must not be read"),
                "CODE"
            ),
            Ok(())
        );
    }

    #[test]
    fn the_response_decides_the_expiry() {
        let device = test_device();
        let expired_paid = LicenseState {
            status: "active".to_string(),
            plan: Some("pro".to_string()),
            expires_at: Some(iso(NOW - DAY)),
            ..no_trial()
        };
        let renewal = |expiry: Option<&str>| {
            let mut payload = empty_payload();
            payload.status = Some("active".to_string());
            payload.plan = Some("pro".to_string());
            payload.expires_at = expiry.map(str::to_string);
            let next = normalize_api_state(payload, &device, Some(&expired_paid), None);
            finalize_state(LicenseState { ..next }, Distribution::Direct, NOW)
        };
        // Null or missing after an expired deadline: an unlimited renewal, not the old date.
        let unlimited = renewal(None);
        assert_eq!(unlimited.expires_at, None);
        assert!(unlimited.paid_license);
        assert_eq!(unlimited.status, "active");
        assert_eq!(unlimited.pro_access_until, None);
        // Present but blank or unreadable: never paid.
        for invalid in ["", "   ", "soon"] {
            let state = renewal(Some(invalid));
            assert!(state.expires_at.is_some(), "{invalid:?} stays present");
            assert!(!state.paid_license, "{invalid:?}");
            assert!(!state.pro_access, "{invalid:?}");
        }
        // A future deadline is used as given.
        assert_eq!(
            renewal(Some(&iso(NOW + DAY))).pro_access_until,
            Some(NOW + DAY)
        );
    }

    #[test]
    fn invalid_paid_expiry_keeps_a_valid_trial_across_reload() {
        let path = temp_path();
        let device = test_device();
        let now = now_ms();
        load_at(&path, &device, Distribution::Direct, now).unwrap();
        for invalid in ["", "garbage"] {
            commit_at(&path, &device, Distribution::Direct, now, |disk| {
                let mut payload = empty_payload();
                payload.status = Some("active".to_string());
                payload.plan = Some("pro".to_string());
                payload.expires_at = Some(invalid.to_string());
                normalize_api_state(payload, &device, Some(disk), None)
            })
            .unwrap();
            let reloaded = load_at(&path, &device, Distribution::Direct, now).unwrap();
            assert!(!reloaded.paid_license, "{invalid:?}");
            assert!(reloaded.pro_access, "the trial still counts ({invalid:?})");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_write_keeps_the_previous_file() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_path();
        let device = test_device();
        let now = now_ms();
        let saved = commit_at(&path, &device, Distribution::Direct, now, |disk| {
            LicenseState {
                license_key: Some("KEY".to_string()),
                ..disk.clone()
            }
        })
        .unwrap();
        // The first write of a new file is revision 1.
        assert_eq!(saved.revision, 1);
        let dir = path.parent().unwrap();
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let failed = clear_at(&path, &device, Distribution::Direct);
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(failed.is_err());
        let disk = load_at(&path, &device, Distribution::Direct, now).unwrap();
        assert_eq!(disk.license_key.as_deref(), Some("KEY"));
        assert_eq!(disk.revision, 1);
        assert_eq!(disk.trial_started_at, saved.trial_started_at);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    fn write_versioned_file(path: &Path, version: u32, started_ms: i64) {
        let mut state = with_trial("inactive", started_ms + 14 * DAY);
        state.trial_started_at = Some(started_ms);
        state.license_key = Some("OLD-KEY".to_string());
        state.version = version;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(&state).unwrap()).unwrap();
    }

    #[test]
    fn an_older_version_is_migrated_not_reset() {
        let device = test_device();
        let now = now_ms();
        let exhausted = now - 30 * DAY;
        // Load, clear and a credential write as the first operation all keep the original
        // (exhausted) trial and its legacy capture.
        for first in ["load", "clear", "commit"] {
            let path = temp_path();
            write_versioned_file(&path, 0, exhausted);
            let state = match first {
                "load" => load_at(&path, &device, Distribution::Direct, now),
                "clear" => clear_at(&path, &device, Distribution::Direct),
                _ => commit_at(&path, &device, Distribution::Direct, now, |disk| {
                    disk.clone()
                }),
            }
            .unwrap();
            assert_eq!(state.version, LICENSE_STATE_VERSION, "{first}");
            assert_eq!(state.trial_started_at, Some(exhausted), "{first}");
            assert_eq!(state.legacy_trial_started_at, Some(exhausted), "{first}");
            assert!(
                !state.pro_access,
                "an exhausted trial stays exhausted ({first})"
            );
            if first == "load" {
                assert_eq!(state.license_key.as_deref(), Some("OLD-KEY"));
            }
            // A restart sees the same.
            let again = load_at(&path, &device, Distribution::Direct, now).unwrap();
            assert_eq!(again.trial_started_at, Some(exhausted), "{first}");
        }
    }

    #[test]
    fn a_newer_version_is_left_untouched() {
        let path = temp_path();
        let device = test_device();
        write_versioned_file(&path, LICENSE_STATE_VERSION + 1, NOW);
        let before = std::fs::read(&path).unwrap();
        let error = load_at(&path, &device, Distribution::Direct, NOW).unwrap_err();
        assert_eq!(error.kind, LicenseErrorKind::Storage);
        assert!(clear_at(&path, &device, Distribution::Direct).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn retry_after_accepts_seconds_and_http_dates() {
        assert_eq!(parse_retry_after("120", NOW), Some(120_000));
        let date = chrono::DateTime::from_timestamp_millis(NOW + 90_000)
            .unwrap()
            .to_rfc2822();
        assert_eq!(parse_retry_after(&date, NOW), Some(90_000));
        assert_eq!(parse_retry_after("soon", NOW), None);
    }

    // ------------------------------------------------------------ HTTP and ordering

    type Handler = Arc<dyn Fn(&str, &serde_json::Value) -> Reply + Send + Sync>;

    #[derive(Clone)]
    enum Reply {
        Json {
            delay_ms: u64,
            status: u16,
            body: String,
            headers: Vec<(&'static str, String)>,
        },
        /// Accept the request, send headers, then never finish the body.
        Stall,
    }

    fn json(delay_ms: u64, body: serde_json::Value) -> Reply {
        Reply::Json {
            delay_ms,
            status: 200,
            body: body.to_string(),
            headers: vec![],
        }
    }

    /// A loopback license server; records `(path, body)` of each request in arrival order.
    async fn server(handler: Handler) -> (String, Arc<Mutex<Vec<(String, serde_json::Value)>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/api/v1", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let handler = handler.clone();
                let log = log.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let (path, body) = loop {
                        let n = socket.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        let text = String::from_utf8_lossy(&buf).to_string();
                        let Some(split) = text.find("\r\n\r\n") else {
                            continue;
                        };
                        let length = text[..split]
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if buf.len() < split + 4 + length {
                            continue;
                        }
                        let path = text.split_whitespace().nth(1).unwrap_or("").to_string();
                        let body = serde_json::from_slice(&buf[split + 4..split + 4 + length])
                            .unwrap_or(serde_json::Value::Null);
                        break (path, body);
                    };
                    log.lock().unwrap().push((path.clone(), body.clone()));
                    match handler(&path, &body) {
                        Reply::Json {
                            delay_ms,
                            status,
                            body,
                            headers,
                        } => {
                            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                            let extra: String = headers
                                .iter()
                                .map(|(name, value)| format!("{name}: {value}\r\n"))
                                .collect();
                            let response = format!(
                                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            );
                            let _ = socket.write_all(response.as_bytes()).await;
                        }
                        Reply::Stall => {
                            let _ = socket
                                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{")
                                .await;
                            tokio::time::sleep(Duration::from_secs(60)).await;
                        }
                    }
                });
            }
        });
        (base, seen)
    }

    const TEST_LIMITS: HttpLimits = HttpLimits {
        connect: Duration::from_millis(500),
        attempt: Duration::from_millis(400),
        operation: Duration::from_millis(900),
    };

    fn target<'a>(
        lock: &'a tokio::sync::Mutex<()>,
        path: &'a Path,
        device: &'a LicenseDeviceInfo,
    ) -> OpTarget<'a> {
        OpTarget {
            lock,
            path,
            device,
            distribution: Distribution::Direct,
            limits: TEST_LIMITS,
        }
    }

    fn activation(token: &str) -> serde_json::Value {
        serde_json::json!({
            "status": "active",
            "activationToken": token,
            "plan": "pro",
            "planName": "Pro",
        })
    }

    #[tokio::test]
    async fn a_queued_deactivate_targets_the_newer_activation() {
        let handler: Handler = Arc::new(|path, body| {
            if path.ends_with("/activate") {
                let key = body["licenseKey"].as_str().unwrap_or("").to_string();
                json(150, activation(&format!("token-{key}")))
            } else {
                json(
                    0,
                    serde_json::json!({ "status": "inactive", "plan": "free" }),
                )
            }
        });
        let (base, seen) = server(handler).await;
        let path = temp_path();
        let device = test_device();
        let lock = tokio::sync::Mutex::new(());
        let target = target(&lock, &path, &device);

        let (activated, cleared) =
            tokio::join!(activate_at(&target, &base, "p".into(), "B".into()), async {
                // Starts while the activation is in flight; must wait for it.
                tokio::time::sleep(Duration::from_millis(30)).await;
                deactivate_at(&target, &base, "p".into()).await
            });
        let activated = activated.unwrap();
        let cleared = cleared.unwrap();
        assert_eq!(activated.activation_token.as_deref(), Some("token-B"));
        let requests = seen.lock().unwrap().clone();
        let deactivate = requests
            .iter()
            .find(|(path, _)| path.ends_with("/deactivate"))
            .expect("deactivate sent");
        assert_eq!(deactivate.1["activationToken"], "token-B");
        assert_eq!(cleared.license_key, None);
        assert!(cleared.revision > activated.revision);
        assert!(cleared.snapshot_seq > activated.snapshot_seq);
    }

    #[tokio::test]
    async fn two_activations_apply_in_lock_order() {
        let handler: Handler = Arc::new(|_, body| {
            let key = body["licenseKey"].as_str().unwrap_or("").to_string();
            let delay = if key == "A" { 200 } else { 0 };
            json(delay, activation(&format!("token-{key}")))
        });
        let (base, _) = server(handler).await;
        let path = temp_path();
        let device = test_device();
        let lock = tokio::sync::Mutex::new(());
        let target = target(&lock, &path, &device);
        let (a, b) = tokio::join!(activate_at(&target, &base, "p".into(), "A".into()), async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            activate_at(&target, &base, "p".into(), "B".into()).await
        });
        let (a, b) = (a.unwrap(), b.unwrap());
        // B queued behind the slow A, so B is the newer write and the state on disk.
        assert!(b.revision > a.revision);
        let disk = load_at(&path, &device, Distribution::Direct, now_ms()).unwrap();
        assert_eq!(disk.license_key.as_deref(), Some("B"));
    }

    #[tokio::test]
    async fn clear_then_reactivate_with_the_same_key() {
        let handler: Handler = Arc::new(|_, body| {
            let key = body["licenseKey"].as_str().unwrap_or("").to_string();
            json(0, activation(&format!("token-{key}")))
        });
        let (base, _) = server(handler).await;
        let path = temp_path();
        let device = test_device();
        let lock = tokio::sync::Mutex::new(());
        let target = target(&lock, &path, &device);
        let first = activate_at(&target, &base, "p".into(), "K".into())
            .await
            .unwrap();
        let cleared = {
            let _op = lock.lock().await;
            clear_at(&path, &device, Distribution::Direct).unwrap()
        };
        assert_eq!(cleared.license_key, None);
        let again = activate_at(&target, &base, "p".into(), "K".into())
            .await
            .unwrap();
        assert_eq!(again.license_key.as_deref(), Some("K"));
        assert!(again.revision > cleared.revision && cleared.revision > first.revision);
        assert!(again.pro_access);
    }

    #[tokio::test]
    async fn a_refresh_queued_behind_a_deactivate_sees_no_license() {
        let handler: Handler = Arc::new(|path, _| {
            if path.ends_with("/deactivate") {
                json(
                    150,
                    serde_json::json!({ "status": "inactive", "plan": "free" }),
                )
            } else if path.ends_with("/validate") {
                json(0, activation("token-stale"))
            } else {
                json(0, activation("token-K"))
            }
        });
        let (base, seen) = server(handler).await;
        let path = temp_path();
        let device = test_device();
        let lock = tokio::sync::Mutex::new(());
        let target = target(&lock, &path, &device);
        activate_at(&target, &base, "p".into(), "K".into())
            .await
            .unwrap();
        let (cleared, refreshed) = tokio::join!(deactivate_at(&target, &base, "p".into()), async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            refresh_at(&target, &base, "p".into()).await
        });
        cleared.unwrap();
        let refreshed = refreshed.unwrap();
        // The refresh ran after the deactivation and sent no credentials.
        let requests = seen.lock().unwrap().clone();
        let validate = requests
            .iter()
            .find(|(path, _)| path.ends_with("/validate"))
            .expect("validate sent");
        assert!(validate.1.get("licenseKey").is_none());
        assert!(validate.1.get("activationToken").is_none());
        assert_eq!(refreshed.license_key, None);
    }

    #[tokio::test]
    async fn a_stalled_server_times_out_and_releases_the_lock() {
        let handler: Handler = Arc::new(|path, _| {
            if path.ends_with("/activate") {
                Reply::Stall
            } else {
                json(0, serde_json::json!({}))
            }
        });
        let (base, _) = server(handler).await;
        let path = temp_path();
        let device = test_device();
        let lock = tokio::sync::Mutex::new(());
        let target = target(&lock, &path, &device);
        load_at(&path, &device, Distribution::Direct, now_ms()).unwrap();

        let started = std::time::Instant::now();
        let (stalled, cleared, reads) = tokio::join!(
            activate_at(&target, &base, "p".into(), "K".into()),
            async {
                tokio::time::sleep(Duration::from_millis(30)).await;
                let _op = lock.lock().await;
                clear_at(&path, &device, Distribution::Direct)
            },
            async {
                // Read-only gates never wait for the operation lock.
                tokio::time::sleep(Duration::from_millis(100)).await;
                let before = std::time::Instant::now();
                let state = load_at(&path, &device, Distribution::Direct, now_ms());
                (state.is_ok(), before.elapsed())
            }
        );
        let error = stalled.unwrap_err();
        assert_eq!(error.kind, LicenseErrorKind::Timeout);
        assert!(error.state.is_some(), "the current snapshot is attached");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(cleared.is_ok());
        assert!(reads.0);
        // A later activation is not blocked by the timed-out one.
        let queued = tokio::time::timeout(
            Duration::from_secs(2),
            activate_at(&target, &base, "p".into(), "K".into()),
        )
        .await
        .expect("the lock was released");
        assert_eq!(queued.unwrap_err().kind, LicenseErrorKind::Timeout);
        assert!(reads.1 < Duration::from_millis(100));
        // Nothing was written by the failed activation.
        let disk = load_at(&path, &device, Distribution::Direct, now_ms()).unwrap();
        assert_eq!(disk.license_key, None);
    }

    #[tokio::test]
    async fn all_fallback_candidates_share_one_deadline() {
        // Every candidate is slow and 404s: four attempts must still end at the deadline.
        let handler: Handler = Arc::new(|_, _| Reply::Json {
            delay_ms: 350,
            status: 404,
            body: "{}".into(),
            headers: vec![],
        });
        let (base, _) = server(handler).await;
        let root = base.trim_end_matches("/api/v1").to_string();
        let started = std::time::Instant::now();
        let request = LicenseApiRequest {
            product: "p".into(),
            license_key: None,
            activation_token: None,
            device: test_device(),
        };
        let error = post_license_api(&root, "validate", &request, TEST_LIMITS)
            .await
            .unwrap_err();
        assert_eq!(error.kind, LicenseErrorKind::Timeout);
        assert!(started.elapsed() < Duration::from_millis(1_300));
    }

    #[tokio::test]
    async fn http_errors_are_typed_without_raw_bodies() {
        let handler: Handler = Arc::new(|path, _| {
            if path.ends_with("/activate") {
                Reply::Json {
                    delay_ms: 0,
                    status: 429,
                    body: r#"{"error":"RATE_LIMITED"}"#.into(),
                    headers: vec![("Retry-After", "120".to_string())],
                }
            } else {
                Reply::Json {
                    delay_ms: 0,
                    status: 200,
                    body: "<html>not json</html>".into(),
                    headers: vec![],
                }
            }
        });
        let (base, _) = server(handler).await;
        let path = temp_path();
        let device = test_device();
        let lock = tokio::sync::Mutex::new(());
        let target = target(&lock, &path, &device);
        let error = activate_at(&target, &base, "p".into(), "K".into())
            .await
            .unwrap_err();
        assert_eq!(error.kind, LicenseErrorKind::Http);
        assert_eq!(error.status, Some(429));
        assert_eq!(error.retry_after_ms, Some(120_000));

        let error = refresh_at(&target, &base, "p".into()).await.unwrap_err();
        assert_eq!(error.kind, LicenseErrorKind::Malformed);
        assert!(!error.message.contains("html"));
    }
}
