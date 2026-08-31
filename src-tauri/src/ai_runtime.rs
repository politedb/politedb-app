use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Manager;
use tokio::fs as async_fs;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::time::sleep;

use crate::state::AppState;

/// Default context window for bundled `llama-server`. Large enough for app context and short
/// conversation history while keeping KV cache bounded on lower-memory devices.
const DEFAULT_CONTEXT_SIZE: u32 = 4096;
const MIN_CONTEXT_SIZE: u32 = 512;
const MAX_CONTEXT_SIZE: u32 = 131_072;
/// `llama-server` defaults `-b` to a large value; that pre-allocates buffers and commonly causes OOM
/// on 8 GB machines next to a multi‑GB GGUF.
const DEFAULT_BATCH_SIZE: u32 = 128;
const MIN_BATCH_SIZE: u32 = 32;
const MAX_BATCH_SIZE: u32 = 8192;
const DEFAULT_HOST: &str = "127.0.0.1";
const START_TIMEOUT: Duration = Duration::from_secs(90);
const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_MODEL_API_NAME: &str = "Qwen2.5-Coder-7B";
const DEFAULT_MODEL_DISPLAY_NAME: &str = "Qwen2.5-Coder 7B Instruct (Q4_K_M)";
const DEFAULT_MODEL_URL: &str = "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf?download=true";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AiRuntimePhase {
    Missing,
    Stopped,
    Starting,
    Ready,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiRuntimeStatus {
    pub phase: AiRuntimePhase,
    pub endpoint: Option<String>,
    pub model_name: Option<String>,
    pub server_bin: Option<String>,
    pub model_path: Option<String>,
    pub pid: Option<u32>,
    pub managed_by_app: bool,
    pub missing: Vec<String>,
    pub last_error: Option<String>,
    pub model_downloaded_bytes: Option<u64>,
    pub model_total_bytes: Option<u64>,
}

#[derive(Debug)]
pub struct AiRuntimeHandle {
    pub child: Option<Child>,
    pub phase: AiRuntimePhase,
    pub endpoint: Option<String>,
    pub port: Option<u16>,
    pub model_name: Option<String>,
    pub model_path: Option<PathBuf>,
    pub server_bin: Option<PathBuf>,
    pub last_error: Option<String>,
    pub managed_by_app: bool,
    pub model_downloaded_bytes: Option<u64>,
    pub model_total_bytes: Option<u64>,
    pub cancel_model_download: bool,
    start_generation: u64,
}

impl Default for AiRuntimeHandle {
    fn default() -> Self {
        Self {
            child: None,
            phase: AiRuntimePhase::Stopped,
            endpoint: None,
            port: None,
            model_name: None,
            model_path: None,
            server_bin: None,
            last_error: None,
            managed_by_app: false,
            model_downloaded_bytes: None,
            model_total_bytes: None,
            cancel_model_download: false,
            start_generation: 0,
        }
    }
}

impl AiRuntimeHandle {
    fn to_status(&self, missing: Vec<String>) -> AiRuntimeStatus {
        let pid = self.child.as_ref().and_then(|child| child.id());
        AiRuntimeStatus {
            phase: self.phase.clone(),
            endpoint: self.endpoint.clone(),
            model_name: self.model_name.clone(),
            server_bin: self
                .server_bin
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            model_path: self
                .model_path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            pid,
            managed_by_app: self.managed_by_app,
            missing,
            last_error: self.last_error.clone(),
            model_downloaded_bytes: self.model_downloaded_bytes,
            model_total_bytes: self.model_total_bytes,
        }
    }
}

fn os_bin_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "llama-server.exe"
    }

    #[cfg(not(target_os = "windows"))]
    {
        "llama-server"
    }
}

fn resources_root_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(resource_dir);
    }

    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"));
    roots
}

fn find_named_file(root: &Path, file_name: &str, max_depth: usize) -> Option<PathBuf> {
    fn walk(dir: &Path, file_name: &str, depth: usize, max_depth: usize) -> Option<PathBuf> {
        if depth > max_depth {
            return None;
        }

        let entries = fs::read_dir(dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if path.file_name().is_some_and(|name| name == file_name) {
                    return Some(path);
                }
                continue;
            }

            if path.is_dir() {
                if let Some(found) = walk(&path, file_name, depth + 1, max_depth) {
                    return Some(found);
                }
            }
        }

        None
    }

    if !root.exists() {
        return None;
    }

    walk(root, file_name, 0, max_depth)
}

fn resolve_bundled_server_bin(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(from_env) = std::env::var("POLITEDB_LLM_SERVER_BIN") {
        let path = PathBuf::from(from_env);
        if path.exists() {
            return Some(path);
        }
    }

    for root in resources_root_candidates(app) {
        let direct_candidates = [
            root.join("ai")
                .join("bin")
                .join(std::env::consts::OS)
                .join(os_bin_name()),
            root.join("bin")
                .join(std::env::consts::OS)
                .join(os_bin_name()),
            root.join(std::env::consts::OS).join(os_bin_name()),
            root.join("bin").join(os_bin_name()),
            root.join(os_bin_name()),
        ];

        if let Some(found) = direct_candidates.into_iter().find(|path| path.exists()) {
            return Some(found);
        }

        if let Some(found) = find_named_file(&root, os_bin_name(), 5) {
            return Some(found);
        }
    }

    None
}

fn resolve_bundled_model_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(from_env) = std::env::var("POLITEDB_LLM_MODEL_PATH") {
        let path = PathBuf::from(from_env);
        if path.exists() {
            return Some(path);
        }
    }

    if let Ok(path) = app_data_model_path(app) {
        if path.exists() {
            return Some(path);
        }
    }

    for root in resources_root_candidates(app) {
        let direct_candidates = [
            root.join("ai").join("models").join("default.gguf"),
            root.join("models").join("default.gguf"),
            root.join("default.gguf"),
        ];

        if let Some(found) = direct_candidates.into_iter().find(|path| path.exists()) {
            return Some(found);
        }

        if let Some(found) = find_named_file(&root, "default.gguf", 5) {
            return Some(found);
        }
    }

    None
}

fn app_data_model_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(root.join("ai").join("models").join("default.gguf"))
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid model path (no parent directory).".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create model directory: {e}"))?;
    Ok(())
}

fn missing_items(server_bin: Option<&Path>, model_path: Option<&Path>) -> Vec<String> {
    let mut missing = Vec::new();
    if server_bin.is_none() {
        missing.push(
            "Missing llama-server binary. Put it at src-tauri/resources/ai/bin/<os>/llama-server"
                .to_string(),
        );
    }
    if model_path.is_none() {
        missing.push(
            "Missing GGUF model. Set POLITEDB_LLM_MODEL_PATH or place default.gguf in the app data folder under ai/models/default.gguf".to_string(),
        );
    }

    missing
}

fn detect_missing(app: &tauri::AppHandle) -> (Option<PathBuf>, Option<PathBuf>, Vec<String>) {
    let server_bin = resolve_bundled_server_bin(app);
    let model_path = resolve_bundled_model_path(app);
    let missing = missing_items(server_bin.as_deref(), model_path.as_deref());

    (server_bin, model_path, missing)
}

#[cfg(unix)]
fn ensure_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let meta = std::fs::metadata(path).map_err(|e| format!("Read metadata failed: {e}"))?;
    let mut perms = meta.permissions();
    let mode = perms.mode();
    if mode & 0o111 == 0 {
        perms.set_mode(mode | 0o755);
        std::fs::set_permissions(path, perms)
            .map_err(|e| format!("Failed to mark binary executable: {e}"))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn resolved_context_size() -> u32 {
    if let Ok(raw) = std::env::var("POLITEDB_LLM_CONTEXT_SIZE") {
        if let Ok(n) = raw.trim().parse::<u32>() {
            return n.clamp(MIN_CONTEXT_SIZE, MAX_CONTEXT_SIZE);
        }
    }
    DEFAULT_CONTEXT_SIZE
}

fn resolved_batch_size() -> u32 {
    if let Ok(raw) = std::env::var("POLITEDB_LLM_BATCH_SIZE") {
        if let Ok(n) = raw.trim().parse::<u32>() {
            return n.clamp(MIN_BATCH_SIZE, MAX_BATCH_SIZE);
        }
    }
    DEFAULT_BATCH_SIZE
}

/// When set (e.g. `0` for CPU-only), passed as `-ngl` to `llama-server`. When unset, the binary default applies.
fn resolved_gpu_layers() -> Option<u32> {
    let raw = std::env::var("POLITEDB_LLM_GPU_LAYERS").ok()?;
    raw.trim().parse::<u32>().ok()
}

fn default_model_download_url() -> String {
    std::env::var("POLITEDB_LLM_DEFAULT_MODEL_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL_URL.to_string())
}

fn pick_free_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind((DEFAULT_HOST, 0)).map_err(|e| format!("Bind free port failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Read local addr failed: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

async fn wait_until_port_ready(port: u16, generation: u64, state: &AppState) -> Result<(), String> {
    let started = Instant::now();
    loop {
        if TcpStream::connect((DEFAULT_HOST, port)).await.is_ok() {
            return Ok(());
        }

        if started.elapsed() > START_TIMEOUT {
            return Err("Timed out waiting for AI runtime to accept connections.".into());
        }

        {
            let runtime = state.ai_runtime.lock().await;
            if !is_current_start(&runtime, port, generation) {
                return Err("AI_RUNTIME_START_SUPERSEDED".into());
            }
        }

        sleep(Duration::from_millis(350)).await;
    }
}

fn is_current_start(runtime: &AiRuntimeHandle, port: u16, generation: u64) -> bool {
    runtime.start_generation == generation && runtime.port == Some(port)
}

fn format_ai_runtime_early_exit(status: std::process::ExitStatus) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if status.signal() == Some(9) {
            return format!(
                "AI runtime exited early with status {status} (SIGKILL — often out of memory)."
            );
        }
    }
    format!("AI runtime exited early with status {status}")
}

fn clear_inactive_endpoint(handle: &mut AiRuntimeHandle) {
    handle.endpoint = None;
    handle.port = None;
    handle.managed_by_app = false;
}

async fn ensure_child_not_exited(handle: &mut AiRuntimeHandle) -> Result<bool, String> {
    if let Some(child) = handle.child.as_mut() {
        match child.try_wait() {
            Ok(Some(status)) => {
                handle.child = None;
                handle.phase = AiRuntimePhase::Error;
                handle.last_error = Some(format_ai_runtime_early_exit(status));
                clear_inactive_endpoint(handle);
                Ok(false)
            }
            Ok(None) => Ok(true),
            Err(e) => Err(format!("Failed to inspect AI runtime process: {e}")),
        }
    } else {
        Ok(false)
    }
}

fn model_name_from_path(path: &Path) -> String {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default();
    if file_name == "default.gguf" {
        return DEFAULT_MODEL_DISPLAY_NAME.to_string();
    }
    path.file_stem()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "local-model".to_string())
}

pub async fn ai_runtime_status(app: &tauri::AppHandle, state: &AppState) -> AiRuntimeStatus {
    let (server_bin, model_path, missing) = detect_missing(app);
    let mut runtime = state.ai_runtime.lock().await;
    if ensure_child_not_exited(&mut runtime).await.unwrap_or(false) && runtime.endpoint.is_some() {
        return runtime.to_status(missing);
    }

    // Keep Starting while a download or llama-server spawn is in flight (child is still none).
    if runtime.child.is_none() && matches!(runtime.phase, AiRuntimePhase::Starting) {
        runtime.server_bin = server_bin;
        if runtime.model_path.is_none() {
            runtime.model_path = model_path.clone();
            runtime.model_name = model_path.as_deref().map(model_name_from_path);
        }
        return runtime.to_status(missing);
    }

    if runtime.child.is_none() {
        runtime.server_bin = server_bin;
        runtime.model_path = model_path.clone();
        runtime.model_name = model_path.as_deref().map(model_name_from_path);
        runtime.model_downloaded_bytes = None;
        runtime.model_total_bytes = None;
        if !missing.is_empty() {
            runtime.phase = AiRuntimePhase::Missing;
        } else if !matches!(runtime.phase, AiRuntimePhase::Error) {
            runtime.phase = AiRuntimePhase::Stopped;
        }
        if !matches!(runtime.phase, AiRuntimePhase::Starting) {
            clear_inactive_endpoint(&mut runtime);
        }
    }

    runtime.to_status(missing)
}

pub async fn ai_runtime_start(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<AiRuntimeStatus, String> {
    let (server_bin, model_path, missing) = detect_missing(app);
    {
        let runtime = state.ai_runtime.lock().await;
        if is_model_download_in_progress(&runtime) {
            return Err("AI_MODEL_DOWNLOAD_BUSY: model download is in progress".to_string());
        }
        if matches!(runtime.phase, AiRuntimePhase::Starting) {
            return Ok(runtime.to_status(missing));
        }
    }
    let Some(server_bin) = server_bin else {
        let mut runtime = state.ai_runtime.lock().await;
        if is_model_download_in_progress(&runtime) {
            return Err("AI_MODEL_DOWNLOAD_BUSY: model download is in progress".to_string());
        }
        if matches!(runtime.phase, AiRuntimePhase::Starting) {
            return Ok(runtime.to_status(missing));
        }
        runtime.phase = AiRuntimePhase::Missing;
        runtime.last_error = Some("AI server binary not found.".to_string());
        return Ok(runtime.to_status(missing));
    };

    let Some(model_path) = model_path else {
        let mut runtime = state.ai_runtime.lock().await;
        if is_model_download_in_progress(&runtime) {
            return Err("AI_MODEL_DOWNLOAD_BUSY: model download is in progress".to_string());
        }
        if matches!(runtime.phase, AiRuntimePhase::Starting) {
            return Ok(runtime.to_status(missing));
        }
        runtime.phase = AiRuntimePhase::Missing;
        runtime.last_error = Some("AI GGUF model not found.".to_string());
        return Ok(runtime.to_status(missing));
    };

    ensure_executable(&server_bin)?;

    let port = pick_free_port()?;
    let endpoint = format!("http://{DEFAULT_HOST}:{port}/v1");
    let context_size = resolved_context_size();
    let batch_size = resolved_batch_size();

    let mut command = Command::new(&server_bin);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    command
        .arg("-m")
        .arg(&model_path)
        .arg("--alias")
        .arg(DEFAULT_MODEL_API_NAME)
        .arg("--host")
        .arg(DEFAULT_HOST)
        .arg("--port")
        .arg(port.to_string())
        .arg("-c")
        .arg(context_size.to_string())
        .arg("-b")
        .arg(batch_size.to_string());
    if let Some(ngl) = resolved_gpu_layers() {
        command.arg("-ngl").arg(ngl.to_string());
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);

    let generation = {
        let mut runtime = state.ai_runtime.lock().await;
        if is_model_download_in_progress(&runtime) {
            return Err("AI_MODEL_DOWNLOAD_BUSY: model download is in progress".to_string());
        }
        if matches!(runtime.phase, AiRuntimePhase::Starting) {
            return Ok(runtime.to_status(missing.clone()));
        }
        if ensure_child_not_exited(&mut runtime).await? && runtime.endpoint.is_some() {
            return Ok(runtime.to_status(missing.clone()));
        }

        runtime.phase = AiRuntimePhase::Starting;
        runtime.last_error = None;
        runtime.server_bin = Some(server_bin.clone());
        runtime.model_path = Some(model_path.clone());
        runtime.model_name = Some(model_name_from_path(&model_path));
        runtime.model_downloaded_bytes = None;
        runtime.model_total_bytes = None;

        match command.spawn() {
            Ok(child) => {
                runtime.start_generation = runtime.start_generation.wrapping_add(1);
                runtime.port = Some(port);
                runtime.endpoint = Some(endpoint.clone());
                runtime.child = Some(child);
                runtime.managed_by_app = true;
                runtime.start_generation
            }
            Err(e) => {
                runtime.phase = AiRuntimePhase::Error;
                runtime.last_error = Some(format!("Failed to start bundled AI runtime: {e}"));
                return Err(format!("Failed to start bundled AI runtime: {e}"));
            }
        }
    };

    if let Err(e) = wait_until_port_ready(port, generation, state).await {
        let mut runtime = state.ai_runtime.lock().await;
        if !is_current_start(&runtime, port, generation) {
            return Ok(runtime.to_status(missing.clone()));
        }
        if let Some(child) = runtime.child.as_mut() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        runtime.child = None;
        runtime.phase = AiRuntimePhase::Error;
        runtime.last_error = Some(e.clone());
        runtime.endpoint = None;
        runtime.port = None;
        runtime.managed_by_app = false;
        return Err(e);
    }

    let mut runtime = state.ai_runtime.lock().await;
    if !is_current_start(&runtime, port, generation) {
        return Ok(runtime.to_status(missing.clone()));
    }
    runtime.phase = AiRuntimePhase::Ready;
    Ok(runtime.to_status(missing))
}

pub async fn ai_runtime_stop(state: &AppState) -> Result<AiRuntimeStatus, String> {
    let mut runtime = state.ai_runtime.lock().await;
    if is_model_download_in_progress(&runtime) {
        return Err("AI_MODEL_DOWNLOAD_BUSY: model download is in progress".to_string());
    }
    stop_runtime_handle(&mut runtime).await?;
    Ok(runtime.to_status(Vec::new()))
}

fn is_model_download_in_progress(runtime: &AiRuntimeHandle) -> bool {
    matches!(runtime.phase, AiRuntimePhase::Starting)
        && (runtime.model_downloaded_bytes.is_some() || runtime.model_total_bytes.is_some())
}

async fn abort_model_download(state: &AppState, temp_path: &Path, error: String) -> String {
    let _ = fs::remove_file(temp_path);
    let mut runtime = state.ai_runtime.lock().await;
    runtime.phase = AiRuntimePhase::Missing;
    runtime.last_error = Some(error.clone());
    runtime.model_path = None;
    runtime.model_name = None;
    runtime.model_downloaded_bytes = None;
    runtime.model_total_bytes = None;
    runtime.cancel_model_download = false;
    error
}

async fn download_cancel_requested(state: &AppState) {
    loop {
        {
            let runtime = state.ai_runtime.lock().await;
            if runtime.cancel_model_download {
                return;
            }
        }
        sleep(Duration::from_millis(100)).await;
    }
}

async fn apply_canceled_model_download(
    state: &AppState,
    temp_path: &Path,
    server_bin: Option<&Path>,
) -> AiRuntimeStatus {
    let _ = fs::remove_file(temp_path);
    let mut runtime = state.ai_runtime.lock().await;
    runtime.phase = AiRuntimePhase::Missing;
    runtime.last_error = Some("AI model download canceled.".to_string());
    runtime.model_path = None;
    runtime.model_name = None;
    runtime.model_downloaded_bytes = None;
    runtime.model_total_bytes = None;
    runtime.cancel_model_download = false;
    runtime.to_status(missing_items(server_bin, None))
}

async fn stop_runtime_handle(runtime: &mut AiRuntimeHandle) -> Result<(), String> {
    if let Some(child) = runtime.child.as_mut() {
        child
            .kill()
            .await
            .map_err(|e| format!("Failed to stop AI runtime: {e}"))?;
        let _ = child.wait().await;
    }

    runtime.child = None;
    runtime.phase = AiRuntimePhase::Stopped;
    runtime.endpoint = None;
    runtime.port = None;
    runtime.managed_by_app = false;
    runtime.model_downloaded_bytes = None;
    runtime.model_total_bytes = None;
    Ok(())
}

pub async fn ai_runtime_autostart_if_available(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<(), String> {
    let (_server_bin, _model_path, missing) = detect_missing(app);
    if !missing.is_empty() {
        return Ok(());
    }

    let runtime = ai_runtime_status(app, state).await;
    if matches!(
        runtime.phase,
        AiRuntimePhase::Ready | AiRuntimePhase::Starting
    ) {
        return Ok(());
    }

    let _ = ai_runtime_start(app, state).await?;
    Ok(())
}

pub fn ai_runtime_force_shutdown_blocking(state: &AppState) {
    let mut runtime = state.ai_runtime.blocking_lock();

    if let Some(child) = runtime.child.as_mut() {
        let _ = child.start_kill();
    }

    runtime.child = None;
    runtime.phase = AiRuntimePhase::Stopped;
    runtime.endpoint = None;
    runtime.port = None;
    runtime.managed_by_app = false;
    runtime.last_error = None;
    runtime.model_downloaded_bytes = None;
    runtime.model_total_bytes = None;
}

pub async fn ai_runtime_download_default_model(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<AiRuntimeStatus, String> {
    {
        let runtime = state.ai_runtime.lock().await;
        if is_model_download_in_progress(&runtime) {
            return Err("AI_MODEL_DOWNLOAD_BUSY: model download is in progress".to_string());
        }
    }

    let (server_bin, _model_path, missing) = detect_missing(app);
    if server_bin.is_none() {
        let mut runtime = state.ai_runtime.lock().await;
        if is_model_download_in_progress(&runtime) {
            return Err("AI_MODEL_DOWNLOAD_BUSY: model download is in progress".to_string());
        }
        runtime.phase = AiRuntimePhase::Missing;
        runtime.last_error = Some("AI server binary not found.".to_string());
        return Ok(runtime.to_status(missing));
    }

    let destination = app_data_model_path(app)?;
    ensure_parent_dir(&destination)?;
    let temp_path = destination.with_extension("gguf.part");

    {
        let mut runtime = state.ai_runtime.lock().await;
        if is_model_download_in_progress(&runtime) {
            return Err("AI_MODEL_DOWNLOAD_BUSY: model download is in progress".to_string());
        }
        runtime.phase = AiRuntimePhase::Starting;
        runtime.last_error = Some("Downloading AI model...".to_string());
        runtime.model_path = Some(destination.clone());
        runtime.model_name = Some(DEFAULT_MODEL_DISPLAY_NAME.to_string());
        runtime.model_downloaded_bytes = Some(0);
        runtime.model_total_bytes = None;
        runtime.cancel_model_download = false;
    }

    let model_url = default_model_download_url();
    let client = reqwest::Client::builder()
        .connect_timeout(DOWNLOAD_CONNECT_TIMEOUT)
        .build()
        .map_err(|e| format!("AI_MODEL_DOWNLOAD_FAILED: {e}"))?;
    let downloaded = async {
        let response = tokio::select! {
            _ = download_cancel_requested(state) => {
                return Ok(
                    apply_canceled_model_download(state, &temp_path, server_bin.as_deref()).await,
                );
            }
            result = tokio::time::timeout(
                DOWNLOAD_STALL_TIMEOUT,
                client.get(&model_url).send(),
            ) => {
                match result {
                    Ok(response) => {
                        response.map_err(|e| format!("AI_MODEL_DOWNLOAD_FAILED: {e}"))?
                    }
                    Err(_) => {
                        return Err(
                            "AI_MODEL_DOWNLOAD_FAILED: timed out waiting for download to start"
                                .into(),
                        );
                    }
                }
            }
        };

        if !response.status().is_success() {
            return Err(format!(
                "AI_MODEL_DOWNLOAD_FAILED: {} {}",
                response.status().as_u16(),
                response
                    .status()
                    .canonical_reason()
                    .unwrap_or("Unknown download error")
            ));
        }

        let total_bytes = response.content_length();
        {
            let mut runtime = state.ai_runtime.lock().await;
            runtime.model_total_bytes = total_bytes;
        }

        let mut file = async_fs::File::create(&temp_path)
            .await
            .map_err(|e| format!("Failed to create temp model file: {e}"))?;
        let mut response = response;
        let mut downloaded_bytes: u64 = 0;
        loop {
            let chunk = tokio::select! {
                _ = download_cancel_requested(state) => {
                    return Ok(
                        apply_canceled_model_download(state, &temp_path, server_bin.as_deref())
                            .await,
                    );
                }
                chunk = tokio::time::timeout(DOWNLOAD_STALL_TIMEOUT, response.chunk()) => {
                    match chunk {
                        Ok(chunk) => {
                            chunk.map_err(|e| format!("AI_MODEL_DOWNLOAD_FAILED: {e}"))?
                        }
                        Err(_) => {
                            return Err(
                                "AI_MODEL_DOWNLOAD_FAILED: timed out waiting for download data"
                                    .into(),
                            );
                        }
                    }
                }
            };
            let Some(chunk) = chunk else {
                break;
            };

            downloaded_bytes = downloaded_bytes.saturating_add(chunk.len() as u64);
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Failed to write downloaded model chunk: {e}"))?;
            let mut runtime = state.ai_runtime.lock().await;
            runtime.model_downloaded_bytes = Some(downloaded_bytes);
            runtime.model_total_bytes = total_bytes;
        }

        {
            let runtime = state.ai_runtime.lock().await;
            if runtime.cancel_model_download {
                drop(runtime);
                return Ok(
                    apply_canceled_model_download(state, &temp_path, server_bin.as_deref()).await,
                );
            }
        }

        file.flush()
            .await
            .map_err(|e| format!("Failed to flush downloaded model file: {e}"))?;
        drop(file);

        {
            let runtime = state.ai_runtime.lock().await;
            if runtime.cancel_model_download {
                drop(runtime);
                return Ok(
                    apply_canceled_model_download(state, &temp_path, server_bin.as_deref()).await,
                );
            }
        }

        async_fs::rename(&temp_path, &destination)
            .await
            .map_err(|e| format!("Failed to finalize downloaded model: {e}"))?;

        let mut runtime = state.ai_runtime.lock().await;
        runtime.phase = AiRuntimePhase::Stopped;
        runtime.last_error = None;
        runtime.model_path = Some(destination.clone());
        runtime.model_name = Some(model_name_from_path(&destination));
        runtime.model_downloaded_bytes = None;
        runtime.model_total_bytes = None;
        runtime.cancel_model_download = false;

        Ok(runtime.to_status(Vec::new()))
    }
    .await;

    match downloaded {
        Ok(status) => Ok(status),
        Err(error) => Err(abort_model_download(state, &temp_path, error).await),
    }
}

pub async fn ai_runtime_cancel_model_download(
    app: &tauri::AppHandle,
    state: &AppState,
) -> AiRuntimeStatus {
    let (server_bin, _model_path, _missing) = detect_missing(app);
    let mut runtime = state.ai_runtime.lock().await;

    if matches!(runtime.phase, AiRuntimePhase::Starting)
        && (runtime.model_downloaded_bytes.is_some() || runtime.model_total_bytes.is_some())
    {
        runtime.cancel_model_download = true;
        runtime.last_error = Some("Canceling AI model download...".to_string());
    }

    runtime.to_status(missing_items(server_bin.as_deref(), None))
}

pub async fn ai_runtime_delete_default_model(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<AiRuntimeStatus, String> {
    let model_path = app_data_model_path(app)?;
    let partial_path = model_path.with_extension("gguf.part");

    {
        let mut runtime = state.ai_runtime.lock().await;
        if is_model_download_in_progress(&runtime) {
            return Err("AI_MODEL_DELETE_BUSY: model download is in progress".to_string());
        }
        stop_runtime_handle(&mut runtime).await?;
        if model_path.exists() {
            fs::remove_file(&model_path)
                .map_err(|error| format!("AI_MODEL_DELETE_FAILED: {error}"))?;
        }
        if partial_path.exists() {
            fs::remove_file(&partial_path)
                .map_err(|error| format!("AI_MODEL_DELETE_FAILED: {error}"))?;
        }
    }

    Ok(ai_runtime_status(app, state).await)
}

#[cfg(test)]
mod tests {
    use super::{
        clear_inactive_endpoint, is_current_start, is_model_download_in_progress, missing_items,
        AiRuntimeHandle, AiRuntimePhase,
    };
    use std::path::Path;

    #[test]
    fn reports_missing_model_when_server_exists_but_model_is_absent() {
        let missing = missing_items(Some(Path::new("/tmp/llama-server")), None);

        assert_eq!(missing.len(), 1);
        assert!(missing[0].contains("Missing GGUF model"));
    }

    #[test]
    fn reports_no_missing_items_when_server_and_model_exist() {
        let missing = missing_items(
            Some(Path::new("/tmp/llama-server")),
            Some(Path::new("/tmp/default.gguf")),
        );

        assert!(missing.is_empty());
    }

    #[test]
    fn reports_both_missing_items_when_nothing_exists() {
        let missing = missing_items(None, None);

        assert_eq!(missing.len(), 2);
        assert!(missing
            .iter()
            .any(|item| item.contains("Missing llama-server binary")));
        assert!(missing
            .iter()
            .any(|item| item.contains("Missing GGUF model")));
    }

    #[test]
    fn current_start_requires_matching_generation_and_port() {
        let mut runtime = AiRuntimeHandle::default();
        runtime.start_generation = 3;
        runtime.port = Some(1234);

        assert!(is_current_start(&runtime, 1234, 3));
        assert!(!is_current_start(&runtime, 1234, 2));
        assert!(!is_current_start(&runtime, 9999, 3));
    }

    #[test]
    fn download_in_progress_requires_starting_and_bytes() {
        let mut runtime = AiRuntimeHandle::default();
        runtime.phase = AiRuntimePhase::Starting;
        assert!(!is_model_download_in_progress(&runtime));

        runtime.model_downloaded_bytes = Some(0);
        assert!(is_model_download_in_progress(&runtime));
    }

    #[test]
    fn dead_child_clears_stale_endpoint() {
        let mut runtime = AiRuntimeHandle::default();
        runtime.endpoint = Some("http://127.0.0.1:1234/v1".to_string());
        runtime.port = Some(1234);
        runtime.managed_by_app = true;
        runtime.phase = AiRuntimePhase::Error;

        clear_inactive_endpoint(&mut runtime);

        assert!(runtime.endpoint.is_none());
        assert!(runtime.port.is_none());
        assert!(!runtime.managed_by_app);
    }
}
