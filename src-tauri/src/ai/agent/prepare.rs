//! Preparing a run's model before any conversation request (plan ollama-native-context
//! A2', A4, A6', A7, C6).
//!
//! For Ollama, the server is identified first (native ≥ 0.12.6, too old, or a positively
//! compatible server), and for native the model's trained context length is read so
//! `num_ctx = min(setting, trained max)` is fixed for the run. Capability is looked up
//! only after the wire is known. Preparation shares the turn's single deadline, races
//! the run's cancel token, and ends with exactly one terminal outcome when it fails.

use std::future::Future;
use std::sync::Arc;

use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::model::{CapabilityCache, CapabilityKey, HttpModel, NativeTarget, TOOLS_UNSUPPORTED};
use super::run::{AgentEvent, EventSink, RunGuard, RunStatus, DEADLINE};
use crate::ai::ollama::{
    self, Identity, IdentityKey, OllamaProbeCache, TrainedMaxKey, PREPARATION_CANCELED,
    UPDATE_REQUIRED,
};
use crate::ai::provider::{self, AiProviderConfig, AiProviderKind};

pub struct Prepared {
    pub model: HttpModel,
    pub capability_key: CapabilityKey,
}

/// Everything a run needs from the provider, read once under the provider lock.
pub struct PrepareInput {
    pub config: AiProviderConfig,
    pub key: Option<String>,
    pub model_id: String,
    pub generation: u64,
}

/// A run's model: ready now (fixed-wire kinds), or to be prepared in the run task.
pub enum Preparation {
    Ready(Prepared),
    Probe(PrepareInput),
}

/// Kinds with a fixed wire prepare without I/O (errors fail the command up front);
/// Ollama is identified later, inside the turn deadline.
pub fn begin(input: PrepareInput, capabilities: &CapabilityCache) -> Result<Preparation, String> {
    if needs_probes(&input.config) {
        Ok(Preparation::Probe(input))
    } else {
        prepare_static(input, capabilities).map(Preparation::Ready)
    }
}

/// Whether the kind needs network preparation (only Ollama does).
pub fn needs_probes(config: &AiProviderConfig) -> bool {
    config.kind == AiProviderKind::Ollama
}

fn check_capability(
    capabilities: &CapabilityCache,
    model: HttpModel,
    capability_key: CapabilityKey,
) -> Result<Prepared, String> {
    if capabilities.get(&capability_key) == Some(false) {
        return Err(TOOLS_UNSUPPORTED.into());
    }
    Ok(Prepared {
        model,
        capability_key,
    })
}

/// Kinds with a fixed wire: no network, so this runs in the IPC call and its errors
/// fail the command up front, as before.
pub fn prepare_static(
    input: PrepareInput,
    capabilities: &CapabilityCache,
) -> Result<Prepared, String> {
    let capability_key =
        CapabilityKey::for_default_wire(&input.config, &input.model_id, input.generation)
            .ok_or_else(|| super::model::PROVIDER_UNSUPPORTED.to_string())?;
    let model = HttpModel::new(input.config, input.key)?;
    check_capability(capabilities, model, capability_key)
}

/// Ollama: identify the server, then (native) read the trained maximum and fix
/// `num_ctx`. Never sends conversation data.
pub async fn prepare_ollama(
    input: PrepareInput,
    probes: &OllamaProbeCache,
    capabilities: &CapabilityCache,
    cancel: &CancellationToken,
) -> Result<Prepared, String> {
    let PrepareInput {
        config,
        key,
        model_id,
        generation,
    } = input;
    let identity_key = IdentityKey {
        provider_id: config.id.clone(),
        generation,
        base: config.base_url.clone().unwrap_or_default(),
    };
    let identity = {
        let config = config.clone();
        probes
            .identity
            .get_or_lookup(
                identity_key,
                ollama::identity_cacheable,
                async move { ollama::identify(&config).await },
                cancel,
            )
            .await?
    };
    match identity {
        Identity::TooOld { .. } => Err(UPDATE_REQUIRED.into()),
        Identity::Compatible => {
            let capability_key = CapabilityKey::for_default_wire(&config, &model_id, generation)
                .ok_or_else(|| super::model::PROVIDER_UNSUPPORTED.to_string())?;
            let model = HttpModel::new(config, key)?;
            check_capability(capabilities, model, capability_key)
        }
        Identity::Native { prefix, .. } => {
            let trained = {
                let (config, prefix, model) = (config.clone(), prefix.clone(), model_id.clone());
                probes
                    .trained_max
                    .get_or_lookup(
                        TrainedMaxKey {
                            provider_id: config.id.clone(),
                            generation,
                            prefix: prefix.as_str().to_string(),
                            model: model.clone(),
                        },
                        ollama::trained_max_cacheable,
                        async move { ollama::trained_max(&config, &prefix, &model).await },
                        cancel,
                    )
                    .await?
            };
            let num_ctx = provider::requested_context_size(&config).min(trained);
            let chat_url = provider::ollama_endpoint(&config, &prefix, "api/chat")?;
            let capability_key = CapabilityKey::new(
                &config.id,
                &model_id,
                super::wire::Wire::OllamaNative,
                prefix.as_str(),
                generation,
            );
            let model = HttpModel::ollama_native(config, NativeTarget { chat_url, num_ctx });
            check_capability(capabilities, model, capability_key)
        }
    }
}

/// How preparation ended when it did not produce a model.
#[derive(Debug, PartialEq, Eq)]
pub enum PrepEnd {
    Failed(String),
    Canceled,
    Deadline,
}

/// Runs `prepare` against the turn's absolute `deadline` and the run's cancel token
/// (cancel wins ties).
pub async fn prepare_within<F>(
    deadline: Instant,
    cancel: &CancellationToken,
    prepare: F,
) -> Result<Prepared, PrepEnd>
where
    F: Future<Output = Result<Prepared, String>>,
{
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(PrepEnd::Canceled),
        _ = tokio::time::sleep_until(deadline) => Err(PrepEnd::Deadline),
        result = prepare => match result {
            Ok(prepared) => Ok(prepared),
            Err(code) if code == PREPARATION_CANCELED || cancel.is_cancelled() => {
                Err(PrepEnd::Canceled)
            }
            Err(code) => Err(PrepEnd::Failed(code)),
        },
    }
}

/// The one terminal outcome of a run that ended during preparation (C6): failure and
/// deadline are `Error` + `Done{Failed}`, cancel is `Done{Canceled}` alone.
pub fn emit_end(sink: &dyn EventSink, end: PrepEnd) {
    let status = match end {
        PrepEnd::Failed(code) => {
            if !sink.send(AgentEvent::Error { code }) {
                return;
            }
            RunStatus::Failed
        }
        PrepEnd::Deadline => {
            if !sink.send(AgentEvent::Error {
                code: DEADLINE.into(),
            }) {
                return;
            }
            RunStatus::Failed
        }
        PrepEnd::Canceled => RunStatus::Canceled,
    };
    sink.send(AgentEvent::Done {
        status,
        steps: 0,
        input_tokens: 0,
        output_tokens: 0,
    });
}

/// The whole run task (A6', C6): one absolute deadline for preparation and the model
/// steps; a preparation failure, cancel or deadline ends with one terminal outcome on
/// `terminal` and never calls `run`; otherwise `run` gets the model and the time left.
/// The run guard (its slot and cancel token) is released on every path.
pub async fn drive_turn<F, Fut>(
    preparation: Preparation,
    probes: Arc<OllamaProbeCache>,
    capabilities: Arc<CapabilityCache>,
    guard: RunGuard,
    turn_deadline: std::time::Duration,
    terminal: &dyn EventSink,
    run: F,
) where
    F: FnOnce(Prepared, std::time::Duration, CancellationToken) -> Fut,
    Fut: Future<Output = ()>,
{
    let cancel = guard.cancel.clone();
    let deadline = Instant::now() + turn_deadline;
    let prepared = match preparation {
        Preparation::Ready(prepared) => Ok(prepared),
        Preparation::Probe(input) => {
            prepare_within(
                deadline,
                &cancel,
                prepare(input, probes, capabilities, cancel.clone()),
            )
            .await
        }
    };
    let end = match prepared {
        Err(end) => Some(end),
        // Cancel wins over a model that became ready at the same moment.
        Ok(_) if cancel.is_cancelled() => Some(PrepEnd::Canceled),
        Ok(prepared) => match remaining(deadline) {
            None => Some(PrepEnd::Deadline),
            Some(left) => {
                run(prepared, left, cancel).await;
                None
            }
        },
    };
    if let Some(end) = end {
        emit_end(terminal, end);
    }
    drop(guard);
}

/// The run's time left after preparation, or `None` once the deadline passed.
pub fn remaining(deadline: Instant) -> Option<std::time::Duration> {
    let left = deadline.saturating_duration_since(Instant::now());
    (!left.is_zero()).then_some(left)
}

/// Prepares any kind: static kinds without I/O, Ollama with probes.
pub async fn prepare(
    input: PrepareInput,
    probes: Arc<OllamaProbeCache>,
    capabilities: Arc<CapabilityCache>,
    cancel: CancellationToken,
) -> Result<Prepared, String> {
    if needs_probes(&input.config) {
        prepare_ollama(input, &probes, &capabilities, &cancel).await
    } else {
        prepare_static(input, &capabilities)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::agent::wire::Wire;
    use crate::ai::generations::ProviderGenerations;
    use crate::ai::provider::tests::provider;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Mutex;
    use std::time::Duration;

    fn server(routes: Vec<(&'static str, String)>) -> (u16, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                log.lock().unwrap().push(path.clone());
                let body = routes
                    .iter()
                    .find(|(p, _)| *p == path)
                    .map(|(_, b)| b.clone());
                let response = match body {
                    Some(body) => format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    ),
                    None => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
                };
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (port, seen)
    }

    fn ollama_config(port: u16, context_size: Option<u32>) -> AiProviderConfig {
        let mut config = provider(AiProviderKind::Ollama, &format!("http://127.0.0.1:{port}"));
        config.context_size = context_size;
        provider::normalize_fields(config)
    }

    struct Env {
        probes: Arc<OllamaProbeCache>,
        capabilities: Arc<CapabilityCache>,
    }

    fn make_env() -> Env {
        let gens = Arc::new(ProviderGenerations::default());
        Env {
            probes: Arc::new(OllamaProbeCache::new(gens.clone())),
            capabilities: Arc::new(CapabilityCache::with_generations(gens)),
        }
    }

    fn input(config: AiProviderConfig) -> PrepareInput {
        PrepareInput {
            config,
            key: None,
            model_id: "qwen3:4b".into(),
            generation: 0,
        }
    }

    async fn run(env: &Env, config: AiProviderConfig) -> Result<Prepared, String> {
        prepare(
            input(config),
            env.probes.clone(),
            env.capabilities.clone(),
            CancellationToken::new(),
        )
        .await
    }

    const VERSION: &str = r#"{"version":"0.40.4"}"#;
    fn show(max: u32) -> String {
        format!(r#"{{"model_info":{{"qwen3.context_length":{max}}}}}"#)
    }

    #[tokio::test]
    async fn native_clamps_num_ctx_to_the_trained_maximum() {
        for (setting, trained, expected) in [
            (None, 262_144, 16_384),
            (None, 8_192, 8_192),
            (Some(4_096), 262_144, 4_096),
            (Some(65_536), 32_768, 32_768),
        ] {
            let (port, seen) = server(vec![
                ("/api/version", VERSION.into()),
                ("/api/show", show(trained)),
            ]);
            let env = make_env();
            let prepared = run(&env, ollama_config(port, setting)).await.unwrap();
            assert_eq!(prepared.model.wire(), Wire::OllamaNative);
            assert_eq!(
                prepared.model.native_target().unwrap().num_ctx,
                expected,
                "{setting:?} {trained}"
            );
            assert_eq!(
                prepared.model.native_target().unwrap().chat_url.as_str(),
                format!("http://127.0.0.1:{port}/api/chat")
            );
            assert_eq!(*seen.lock().unwrap(), ["/api/version", "/api/show"]);
        }
    }

    #[tokio::test]
    async fn too_old_and_metadata_failures_never_reach_chat() {
        let (port, seen) = server(vec![("/api/version", r#"{"version":"0.12.5"}"#.into())]);
        let env = make_env();
        assert_eq!(
            run(&env, ollama_config(port, None)).await.err().as_deref(),
            Some(UPDATE_REQUIRED)
        );
        assert_eq!(*seen.lock().unwrap(), ["/api/version"]);

        let (port, seen) = server(vec![
            ("/api/version", VERSION.into()),
            ("/api/show", r#"{"model_info":{}}"#.into()),
        ]);
        let env = make_env();
        assert_eq!(
            run(&env, ollama_config(port, None)).await.err().as_deref(),
            Some(ollama::MODEL_INFO_UNAVAILABLE)
        );
        assert!(seen.lock().unwrap().iter().all(|p| !p.contains("chat")));
    }

    #[tokio::test]
    async fn compatible_servers_keep_the_v1_wire() {
        let (port, _) = server(vec![(
            "/v1/models",
            r#"{"object":"list","data":[{"id":"m"}]}"#.into(),
        )]);
        let env = make_env();
        let prepared = run(&env, ollama_config(port, None)).await.unwrap();
        assert_eq!(prepared.model.wire(), Wire::OpenAi);
        assert!(prepared.model.native_target().is_none());
    }

    #[tokio::test]
    async fn a_v1_negative_does_not_block_native() {
        let (port, _) = server(vec![
            ("/api/version", VERSION.into()),
            ("/api/show", show(8192)),
        ]);
        let env = make_env();
        let config = ollama_config(port, None);
        let compat = CapabilityKey::for_default_wire(&config, "qwen3:4b", 0).unwrap();
        env.capabilities.record(compat, false);
        assert!(run(&env, config.clone()).await.is_ok());
        // A native negative does block native.
        let prefix = provider::ollama_server_prefix(&config).unwrap();
        env.capabilities.record(
            CapabilityKey::new("p1", "qwen3:4b", Wire::OllamaNative, prefix.as_str(), 0),
            false,
        );
        assert_eq!(
            run(&env, config).await.err().as_deref(),
            Some(TOOLS_UNSUPPORTED)
        );
    }

    #[tokio::test]
    async fn identity_is_cached_and_trained_max_reused() {
        let (port, seen) = server(vec![
            ("/api/version", VERSION.into()),
            ("/api/show", show(8192)),
        ]);
        let env = make_env();
        let config = ollama_config(port, None);
        run(&env, config.clone()).await.unwrap();
        run(&env, config).await.unwrap();
        assert_eq!(seen.lock().unwrap().len(), 2, "second run uses the cache");
    }

    #[test]
    fn static_kinds_prepare_without_io_and_keep_the_up_front_negative() {
        let env = make_env();
        let mut config = provider(AiProviderKind::Openai, "https://api.openai.com");
        config = provider::normalize_fields(config);
        let prepared = prepare_static(input(config.clone()), &env.capabilities).unwrap();
        assert_eq!(prepared.model.wire(), Wire::OpenAi);
        env.capabilities.record(prepared.capability_key, false);
        assert_eq!(
            prepare_static(input(config), &env.capabilities)
                .err()
                .as_deref(),
            Some(TOOLS_UNSUPPORTED)
        );
    }

    // ------------------------------------------------ deadline and terminal events

    #[derive(Default)]
    struct Recorder(Mutex<Vec<AgentEvent>>, bool);

    impl EventSink for Recorder {
        fn send(&self, event: AgentEvent) -> bool {
            self.0.lock().unwrap().push(event);
            !self.1
        }
    }

    fn pending() -> impl Future<Output = Result<Prepared, String>> {
        std::future::pending()
    }

    #[tokio::test]
    async fn preparation_shares_the_turn_deadline() {
        // A short test deadline stands in for the 120 s turn deadline.
        let deadline = Instant::now() + Duration::from_millis(50);
        let end = prepare_within(deadline, &CancellationToken::new(), pending()).await;
        assert_eq!(end.err(), Some(PrepEnd::Deadline));
        assert!(remaining(deadline).is_none(), "nothing left for the chat");
    }

    #[tokio::test]
    async fn cancel_wins_and_ends_with_done_canceled_only() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let deadline = Instant::now(); // also expired: cancel still wins
        let end = prepare_within(deadline, &cancel, pending())
            .await
            .err()
            .unwrap();
        assert_eq!(end, PrepEnd::Canceled);
        let sink = Recorder::default();
        emit_end(&sink, end);
        let events = sink.0.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(
            events[0],
            AgentEvent::Done {
                status: RunStatus::Canceled,
                ..
            }
        ));
    }

    #[test]
    fn failure_and_deadline_emit_error_then_done_failed() {
        for (end, code) in [
            (PrepEnd::Failed(UPDATE_REQUIRED.into()), UPDATE_REQUIRED),
            (PrepEnd::Deadline, DEADLINE),
        ] {
            let sink = Recorder::default();
            emit_end(&sink, end);
            let events = sink.0.lock().unwrap();
            assert_eq!(events.len(), 2);
            assert!(matches!(&events[0], AgentEvent::Error { code: c } if c == code));
            assert!(matches!(
                events[1],
                AgentEvent::Done {
                    status: RunStatus::Failed,
                    steps: 0,
                    ..
                }
            ));
        }
        // A closed channel stops after the first failed send.
        let closed = Recorder(Mutex::new(Vec::new()), true);
        emit_end(&closed, PrepEnd::Failed("X".into()));
        assert_eq!(closed.0.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn cancel_during_routing_sends_no_chat() {
        // A server that accepts and never answers.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepted = Arc::new(Mutex::new(0usize));
        let count = accepted.clone();
        std::thread::spawn(move || {
            let mut held = Vec::new();
            for stream in listener.incoming().take(4) {
                *count.lock().unwrap() += 1;
                held.push(stream);
            }
            std::thread::sleep(Duration::from_secs(5));
        });
        let env = make_env();
        let cancel = CancellationToken::new();
        let fut = prepare(
            input(ollama_config(port, None)),
            env.probes.clone(),
            env.capabilities.clone(),
            cancel.clone(),
        );
        let canceller = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            canceller.cancel();
        });
        let started = std::time::Instant::now();
        let end = prepare_within(Instant::now() + Duration::from_secs(120), &cancel, fut).await;
        assert_eq!(end.err(), Some(PrepEnd::Canceled));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(
            *accepted.lock().unwrap(),
            1,
            "only the version probe connected"
        );
    }

    // ------------------------------------------- the whole run task (drive_turn)

    /// Routes with a delay before answering (ms), or `None` to hang.
    fn timed_server(
        routes: Vec<(&'static str, String, Option<u64>)>,
    ) -> (u16, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let routes = routes.clone();
                let log = log.clone();
                std::thread::spawn(move || {
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                    log.lock().unwrap().push(path.clone());
                    match routes.iter().find(|(p, _, _)| *p == path) {
                        Some((_, body, Some(delay))) => {
                            std::thread::sleep(Duration::from_millis(*delay));
                            let _ = stream.write_all(
                                format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                    body.len()
                                )
                                .as_bytes(),
                            );
                        }
                        Some((_, _, None)) => std::thread::sleep(Duration::from_secs(10)),
                        None => {
                            let _ = stream.write_all(
                                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            );
                        }
                    }
                });
            }
        });
        (port, seen)
    }

    struct Task {
        registry: Arc<super::super::run::RunRegistry>,
        connection: uuid::Uuid,
        sink: Recorder,
        ran: Arc<Mutex<Option<Duration>>>,
    }

    impl Task {
        fn new() -> Self {
            Self {
                registry: Arc::new(super::super::run::RunRegistry::default()),
                connection: uuid::Uuid::new_v4(),
                sink: Recorder::default(),
                ran: Arc::default(),
            }
        }

        async fn drive(&self, preparation: Preparation, turn: Duration) {
            let env = make_env();
            let guard = self
                .registry
                .start_on("run-1", Some(self.connection))
                .unwrap();
            let ran = self.ran.clone();
            drive_turn(
                preparation,
                env.probes.clone(),
                env.capabilities.clone(),
                guard,
                turn,
                &self.sink,
                |_prepared, left, _cancel| async move {
                    *ran.lock().unwrap() = Some(left);
                },
            )
            .await;
        }

        fn slot_released(&self) -> bool {
            self.registry.start_on("run-1", None).is_ok()
        }

        fn only_done(&self, status: RunStatus) -> bool {
            let events = self.sink.0.lock().unwrap();
            matches!(events.last(), Some(AgentEvent::Done { status: s, .. }) if *s == status)
        }
    }

    fn probe(port: u16) -> Preparation {
        Preparation::Probe(input(ollama_config(port, None)))
    }

    #[tokio::test]
    async fn preparation_and_model_share_one_deadline() {
        // Preparation alone outlasts the turn: no model step, one deadline outcome.
        let (port, seen) = timed_server(vec![("/api/version", VERSION.into(), Some(1_500))]);
        let task = Task::new();
        task.drive(probe(port), Duration::from_millis(300)).await;
        assert!(
            task.ran.lock().unwrap().is_none(),
            "no chat after the deadline"
        );
        {
            let events = task.sink.0.lock().unwrap();
            assert!(matches!(&events[0], AgentEvent::Error { code } if code == DEADLINE));
            assert_eq!(events.len(), 2);
        }
        assert!(task.only_done(RunStatus::Failed));
        assert!(task.slot_released());
        assert!(seen.lock().unwrap().iter().all(|p| !p.contains("chat")));

        // Preparation time is taken from the model's budget.
        let (port, _) = timed_server(vec![
            ("/api/version", VERSION.into(), Some(250)),
            ("/api/show", show(8192), Some(0)),
        ]);
        let task = Task::new();
        task.drive(probe(port), Duration::from_secs(3)).await;
        let left = task.ran.lock().unwrap().expect("model ran");
        assert!(left <= Duration::from_millis(2_760), "{left:?}");
        assert!(
            task.sink.0.lock().unwrap().is_empty(),
            "run_turn owns the terminal"
        );
        assert!(task.slot_released());
    }

    #[tokio::test]
    async fn cancel_or_connection_close_during_metadata_sends_no_chat() {
        for close_connection in [false, true] {
            let (port, seen) = timed_server(vec![
                ("/api/version", VERSION.into(), Some(0)),
                ("/api/show", String::new(), None), // hangs
            ]);
            let task = Arc::new(Task::new());
            let canceller = {
                let task = task.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    if close_connection {
                        task.registry.cancel_on_connections(&[task.connection]);
                    } else {
                        task.registry.cancel("run-1");
                    }
                })
            };
            let started = std::time::Instant::now();
            task.drive(probe(port), Duration::from_secs(120)).await;
            canceller.await.unwrap();
            assert!(started.elapsed() < Duration::from_secs(1));
            assert!(task.ran.lock().unwrap().is_none());
            assert_eq!(task.sink.0.lock().unwrap().len(), 1, "Done only");
            assert!(task.only_done(RunStatus::Canceled));
            assert!(task.slot_released());
            let seen = seen.lock().unwrap();
            assert!(seen.iter().any(|p| p == "/api/show"), "{close_connection}");
            assert!(seen.iter().all(|p| !p.contains("chat")));
        }
    }

    #[tokio::test]
    async fn failures_end_once_and_release_the_slot() {
        let (port, _) = timed_server(vec![(
            "/api/version",
            r#"{"version":"0.12.5"}"#.into(),
            Some(0),
        )]);
        let task = Task::new();
        task.drive(probe(port), Duration::from_secs(5)).await;
        assert!(task.ran.lock().unwrap().is_none());
        {
            let events = task.sink.0.lock().unwrap();
            assert!(matches!(&events[0], AgentEvent::Error { code } if code == UPDATE_REQUIRED));
            assert_eq!(events.len(), 2);
        }
        assert!(task.slot_released());

        // A ready model runs with (almost) the whole turn.
        let task = Task::new();
        let env = make_env();
        let config =
            provider::normalize_fields(provider(AiProviderKind::Openai, "https://api.openai.com"));
        let ready = prepare_static(input(config), &env.capabilities).unwrap();
        task.drive(Preparation::Ready(ready), Duration::from_secs(5))
            .await;
        assert!(task.ran.lock().unwrap().unwrap() > Duration::from_secs(4));
        assert!(task.slot_released());
    }

    // ------------------------------- drive_turn with the real coordinator (run_turn)

    use crate::ai::agent::model::AgentModel;
    use crate::ai::agent::protocol::{AssistantEnvelope, StepRequest, StopReason};
    use crate::ai::agent::run::{run_turn, RequestGate, RunInput, ToolRegistry};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    /// Answers after `delay`; counts the requests it received.
    struct SlowModel {
        delay: Duration,
        calls: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl AgentModel for SlowModel {
        async fn step(&self, _request: &StepRequest<'_>) -> Result<AssistantEnvelope, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(self.delay).await;
            Ok(AssistantEnvelope {
                provider: AiProviderKind::Ollama,
                model: "m".into(),
                raw: serde_json::json!({"role": "assistant", "content": "done"}),
                text: "done".into(),
                tool_calls: vec![],
                stop: StopReason::EndTurn,
                usage: None,
            })
        }
    }

    /// The consent gate: closed once `revoked` is set.
    struct ConsentGate(Arc<AtomicBool>);

    impl RequestGate for ConsentGate {
        fn check(&self) -> Result<(), String> {
            if self.0.load(Ordering::SeqCst) {
                Err(crate::ai::agent::consent::DATA_ACCESS_REQUIRED.into())
            } else {
                Ok(())
            }
        }
    }

    /// Runs the production task path: preparation, then `run_turn` with the time left.
    async fn drive_with_coordinator(
        task: &Task,
        preparation: Preparation,
        turn: Duration,
        model: &SlowModel,
        gate: &dyn RequestGate,
        sink: &Recorder,
    ) {
        let env = make_env();
        let guard = task
            .registry
            .start_on("run-1", Some(task.connection))
            .unwrap();
        drive_turn(
            preparation,
            env.probes.clone(),
            env.capabilities.clone(),
            guard,
            turn,
            sink,
            |_prepared, left, cancel| async move {
                let input = RunInput {
                    model_id: "m",
                    system: "sys",
                    question: "q",
                    deadline: left,
                    tool_timeout: Duration::from_secs(5),
                    cleanup_grace: Duration::from_millis(100),
                    gate,
                };
                run_turn(model, &ToolRegistry::default(), input, sink, &cancel).await;
            },
        )
        .await;
    }

    fn dones(sink: &Recorder) -> usize {
        sink.0
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, AgentEvent::Done { .. }))
            .count()
    }

    #[tokio::test]
    async fn preparation_and_a_slow_model_share_one_turn_deadline() {
        // 600 ms of preparation + a 3 s model against a 1.5 s turn: the model step is
        // cut at the turn's end, not after a fresh 1.5 s.
        let (port, _) = timed_server(vec![
            ("/api/version", VERSION.into(), Some(600)),
            ("/api/show", show(8192), Some(0)),
        ]);
        let task = Task::new();
        let model = SlowModel {
            delay: Duration::from_secs(3),
            calls: AtomicUsize::new(0),
        };
        let open = ConsentGate(Arc::new(AtomicBool::new(false)));
        let sink = Recorder::default();
        let started = std::time::Instant::now();
        drive_with_coordinator(
            &task,
            probe(port),
            Duration::from_millis(1_500),
            &model,
            &open,
            &sink,
        )
        .await;
        let elapsed = started.elapsed();
        assert!(elapsed < Duration::from_millis(2_000), "{elapsed:?}");
        assert!(elapsed >= Duration::from_millis(1_400), "{elapsed:?}");
        assert_eq!(model.calls.load(Ordering::SeqCst), 1);
        let events = sink.0.lock().unwrap();
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::Error { code } if code == DEADLINE)));
        drop(events);
        assert_eq!(dones(&sink), 1, "exactly one terminal");
        assert!(task.slot_released());
    }

    #[tokio::test]
    async fn consent_revoked_during_preparation_sends_no_chat() {
        let (port, _) = timed_server(vec![
            ("/api/version", VERSION.into(), Some(400)),
            ("/api/show", show(8192), Some(0)),
        ]);
        let task = Task::new();
        let model = SlowModel {
            delay: Duration::from_millis(10),
            calls: AtomicUsize::new(0),
        };
        let revoked = Arc::new(AtomicBool::new(false));
        let gate = ConsentGate(revoked.clone());
        let flip = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            revoked.store(true, Ordering::SeqCst);
        });
        let sink = Recorder::default();
        drive_with_coordinator(
            &task,
            probe(port),
            Duration::from_secs(10),
            &model,
            &gate,
            &sink,
        )
        .await;
        flip.await.unwrap();
        assert_eq!(
            model.calls.load(Ordering::SeqCst),
            0,
            "no request after revoke"
        );
        let events = sink.0.lock().unwrap();
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Error { code }
            if code == crate::ai::agent::consent::DATA_ACCESS_REQUIRED)));
        drop(events);
        assert_eq!(dones(&sink), 1);
        assert!(task.slot_released());
    }

    #[tokio::test]
    async fn a_closed_channel_stops_the_task_and_releases_the_slot() {
        // Closed during a preparation failure: one send attempt, nothing else.
        let (port, _) = timed_server(vec![(
            "/api/version",
            r#"{"version":"0.12.5"}"#.into(),
            Some(0),
        )]);
        let task = Task::new();
        let model = SlowModel {
            delay: Duration::from_millis(10),
            calls: AtomicUsize::new(0),
        };
        let open = ConsentGate(Arc::new(AtomicBool::new(false)));
        let closed = Recorder(Mutex::new(Vec::new()), true);
        drive_with_coordinator(
            &task,
            probe(port),
            Duration::from_secs(5),
            &model,
            &open,
            &closed,
        )
        .await;
        assert_eq!(closed.0.lock().unwrap().len(), 1);
        assert!(task.slot_released());

        // Closed when the model phase starts: no model request is sent.
        let task = Task::new();
        let env = make_env();
        let config =
            provider::normalize_fields(provider(AiProviderKind::Openai, "https://api.openai.com"));
        let ready = prepare_static(input(config), &env.capabilities).unwrap();
        let closed = Recorder(Mutex::new(Vec::new()), true);
        drive_with_coordinator(
            &task,
            Preparation::Ready(ready),
            Duration::from_secs(5),
            &model,
            &open,
            &closed,
        )
        .await;
        assert_eq!(model.calls.load(Ordering::SeqCst), 0);
        assert!(task.slot_released());
    }
}
