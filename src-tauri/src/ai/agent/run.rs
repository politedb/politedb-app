//! The agent turn coordinator (plan ai-agent R1).
//!
//! One run answers one user question: it calls the model, executes the tool calls it
//! asks for, feeds results back and repeats until the model answers or a limit is
//! reached. The whole transcript (including provider-native replay state) stays here;
//! the frontend only sees [`AgentEvent`]s built from fixed templates.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::model::AgentModel;
use super::protocol::{StepRequest, StopReason, ToolResult, ToolSpec, Turn, Usage};

pub const MAX_STEPS: usize = 8;
pub const MAX_TOOL_CALLS: usize = 16;
pub const TURN_DEADLINE: Duration = Duration::from_secs(120);
pub const MAX_TOOL_RESULT_BYTES: usize = 64 * 1024;
pub const OUTPUT_TOKEN_BUDGET: u64 = 32_000;
pub const STEP_MAX_TOKENS: u32 = 4096;
pub const MAX_QUESTION_BYTES: usize = 16 * 1024;
pub const MAX_ACTIVE_RUNS: usize = 2;
pub const TOOL_TIMEOUT: Duration = Duration::from_secs(30);

pub const CANCELED: &str = "AI_AGENT_CANCELED";
pub const DEADLINE: &str = "AI_AGENT_DEADLINE";

/// Events streamed to the frontend. Labels come from fixed templates; nothing here
/// carries model-authored claims, raw tool output or provider state.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    Step {
        n: usize,
    },
    ToolStarted {
        tool: String,
    },
    ToolFinished {
        tool: String,
        ok: bool,
        truncated: bool,
        duration_ms: u64,
    },
    Answer {
        text: String,
    },
    Done {
        status: RunStatus,
        steps: usize,
        input_tokens: u64,
        output_tokens: u64,
    },
    Error {
        code: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Answered,
    Failed,
    Canceled,
}

/// Where events go (a Tauri channel in the app). `false` means nobody is listening
/// any more, which cancels the run.
pub trait EventSink: Send + Sync {
    fn send(&self, event: AgentEvent) -> bool;
    /// The model accepted a request that declared tools (capability cache, plan R2).
    fn tools_accepted(&self) {}
}

/// What a tool gets besides its arguments.
///
/// Contract (plan R1): a tool stops promptly once `cancel` fires and owns the cleanup
/// of anything it started. Native or blocking work must be spawned on `tracker`, so
/// the coordinator can wait for it to finish before the run releases its slot; no
/// operation may outlive its run.
pub struct ToolContext {
    pub cancel: CancellationToken,
    /// Spawn native/blocking work here so the run can await cleanup (Phase 2+ tools).
    #[allow(dead_code)] // read by tool implementations once they are registered
    pub tracker: TaskTracker,
}

/// A tool the model may call. Arguments arrive as a parsed JSON object;
/// implementations must validate them against their own schema (plan R5).
#[async_trait]
pub trait AgentTool: Send + Sync {
    fn spec(&self) -> ToolSpec;
    async fn run(&self, arguments: Value, ctx: &ToolContext) -> Result<String, String>;
}

/// Tools offered in a run. Empty in Phase 1.
#[derive(Default, Clone)]
pub struct ToolRegistry {
    tools: Vec<Arc<dyn AgentTool>>,
}

impl ToolRegistry {
    // Registered tools arrive in Phase 2 (plan R7); until then only tests build one.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn new(tools: Vec<Arc<dyn AgentTool>>) -> Self {
        Self { tools }
    }

    fn specs(&self) -> Vec<ToolSpec> {
        self.tools.iter().map(|tool| tool.spec()).collect()
    }

    fn find(&self, name: &str) -> Option<&Arc<dyn AgentTool>> {
        self.tools.iter().find(|tool| tool.spec().name == name)
    }
}

pub struct RunInput<'a> {
    pub model_id: &'a str,
    pub system: &'a str,
    pub question: &'a str,
    /// Wall-clock limit for the whole turn ([`TURN_DEADLINE`] in the app).
    pub deadline: Duration,
    /// Limit per tool call ([`TOOL_TIMEOUT`] in the app).
    pub tool_timeout: Duration,
}

/// How long cancelled tools get to finish their cleanup.
pub const CLEANUP_GRACE: Duration = Duration::from_secs(5);
/// Output tokens kept back so the final, tool-free answer always fits the budget.
pub const FINAL_RESERVE_TOKENS: u32 = 4096;
/// Below this, a tool-using step is not worth it: finalize instead.
pub const MIN_STEP_TOKENS: u32 = 1024;

const FINALIZE_INSTRUCTION: &str =
    "\n\nYou can no longer call tools. Answer now with what you have, and say what is missing.";

/// Runs one turn to completion, streaming events. Never returns an error: every
/// outcome ends with `Done` (preceded by `Answer` or `Error`). On every exit path the
/// run's token is cancelled and tool work spawned on the tracker is awaited (up to
/// [`CLEANUP_GRACE`]) before returning.
pub async fn run_turn(
    model: &dyn AgentModel,
    tools: &ToolRegistry,
    input: RunInput<'_>,
    sink: &dyn EventSink,
    cancel: &CancellationToken,
) -> RunStatus {
    let tracker = TaskTracker::new();
    let mut usage = Usage::default();
    let mut steps = 0;
    let outcome = if cancel.is_cancelled() {
        Err(CANCELED.to_string())
    } else {
        tokio::select! {
            // Cancellation wins whenever both branches are ready.
            biased;
            _ = cancel.cancelled() => Err(CANCELED.to_string()),
            result = tokio::time::timeout(
                input.deadline,
                drive(model, tools, &input, sink, cancel, &tracker, &mut usage, &mut steps),
            ) => result.unwrap_or_else(|_| Err(DEADLINE.to_string())),
        }
    };
    // Whatever happened, signal every tool and wait for its native work to stop.
    cancel.cancel();
    tracker.close();
    if tokio::time::timeout(CLEANUP_GRACE, tracker.wait())
        .await
        .is_err()
    {
        tracing::warn!(
            code = "AI_AGENT_CLEANUP_TIMEOUT",
            "agent tool cleanup exceeded grace period"
        );
    }
    let status = match outcome {
        Ok(text) => {
            sink.send(AgentEvent::Answer { text });
            RunStatus::Answered
        }
        Err(code) if code == CANCELED => RunStatus::Canceled,
        Err(code) => {
            sink.send(AgentEvent::Error { code });
            RunStatus::Failed
        }
    };
    sink.send(AgentEvent::Done {
        status,
        steps,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
    });
    status
}

#[allow(clippy::too_many_arguments)]
async fn drive(
    model: &dyn AgentModel,
    tools: &ToolRegistry,
    input: &RunInput<'_>,
    sink: &dyn EventSink,
    cancel: &CancellationToken,
    tracker: &TaskTracker,
    usage: &mut Usage,
    steps: &mut usize,
) -> Result<String, String> {
    if input.question.trim().is_empty() {
        return Err("AI_AGENT_QUESTION_REQUIRED".into());
    }
    if input.question.len() > MAX_QUESTION_BYTES {
        return Err("AI_AGENT_QUESTION_TOO_LONG".into());
    }
    let specs = tools.specs();
    let final_system = format!("{}{FINALIZE_INSTRUCTION}", input.system);
    let floor = model.min_output_tokens(input.model_id);
    let final_reserve = FINAL_RESERVE_TOKENS.max(floor);
    let min_step = MIN_STEP_TOKENS.max(floor);
    let mut turns = vec![Turn::User(input.question.to_string())];
    let mut tool_calls_used = 0;

    loop {
        *steps += 1;
        // Budget (plan R1): the final answer's allowance is always kept back, and every
        // amount is the one the wire really sends (adapters may raise it to a floor).
        let remaining = OUTPUT_TOKEN_BUDGET.saturating_sub(usage.output_tokens);
        let step_allowance = remaining
            .saturating_sub(final_reserve as u64)
            .min(STEP_MAX_TOKENS as u64) as u32;
        let finalizing =
            *steps >= MAX_STEPS || tool_calls_used >= MAX_TOOL_CALLS || step_allowance < min_step;
        let max_tokens = if finalizing {
            let final_allowance = (remaining.min(final_reserve as u64) as u32).max(MIN_STEP_TOKENS);
            if final_allowance.max(floor) as u64 > remaining {
                // Not even the final answer fits: stop without sending anything.
                return Err("AI_AGENT_BUDGET_EXHAUSTED".into());
            }
            final_allowance
        } else {
            step_allowance
        };
        let effective_tokens = max_tokens.max(floor);
        if cancel.is_cancelled() || !sink.send(AgentEvent::Step { n: *steps }) {
            return Err(CANCELED.into());
        }
        // Tools stay declared on the final step (some providers require it once the
        // transcript has tool calls) but calling them is disabled.
        let request = StepRequest {
            model: input.model_id,
            system: if finalizing && !specs.is_empty() {
                &final_system
            } else {
                input.system
            },
            turns: &turns,
            tools: &specs,
            allow_tools: !finalizing,
            max_tokens,
        };
        let envelope = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(CANCELED.into()),
            result = model.step(&request) => match result {
                // After a tool ran, an "unsupported" answer must never trigger the
                // legacy fallback (that would replay private results elsewhere).
                Err(code) if code == super::model::TOOLS_UNSUPPORTED && tool_calls_used > 0 => {
                    return Err("AI_AGENT_TOOLS_REJECTED".into())
                }
                other => other?,
            },
        };
        if cancel.is_cancelled() {
            return Err(CANCELED.into());
        }
        if !specs.is_empty() && *steps == 1 {
            sink.tools_accepted();
        }
        // Unknown usage is charged at the allowance the wire actually sent.
        let charged = envelope.usage.unwrap_or(Usage {
            input_tokens: 0,
            output_tokens: effective_tokens as u64,
        });
        usage.input_tokens = usage.input_tokens.saturating_add(charged.input_tokens);
        usage.output_tokens = usage.output_tokens.saturating_add(charged.output_tokens);

        match envelope.stop {
            StopReason::Refusal => return Err("AI_CHAT_REFUSED".into()),
            StopReason::ToolUse if envelope.tool_calls_runnable() && !finalizing => {
                // A batch with repeated ids is malformed: nothing in it runs.
                let mut ids = HashSet::new();
                if !envelope
                    .tool_calls
                    .iter()
                    .all(|call| ids.insert(call.id.as_str()))
                {
                    return Err(super::wire::RESPONSE_INVALID.into());
                }
                let calls = envelope.tool_calls.clone();
                turns.push(Turn::Assistant(envelope));
                let mut results = Vec::with_capacity(calls.len());
                for call in calls {
                    let result = if tool_calls_used >= MAX_TOOL_CALLS {
                        error_result(&call.id, &call.name, "tool call limit reached; answer now")
                    } else {
                        tool_calls_used += 1;
                        run_tool(
                            tools,
                            &call.id,
                            &call.name,
                            &call.arguments,
                            input.tool_timeout,
                            sink,
                            cancel,
                            tracker,
                        )
                        .await?
                    };
                    results.push(result);
                }
                turns.push(Turn::ToolResults(results));
            }
            // Tool calls from a truncated, refused or final turn are never executed.
            _ if envelope.text.is_empty() => {
                return Err(match envelope.stop {
                    StopReason::MaxTokens => "AI_CHAT_OUTPUT_TOKEN_LIMIT".into(),
                    _ if !envelope.tool_calls.is_empty() => "AI_AGENT_STEP_LIMIT".into(),
                    _ => "AI_CHAT_EMPTY_RESPONSE".into(),
                });
            }
            _ => return Ok(envelope.text),
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_tool(
    tools: &ToolRegistry,
    call_id: &str,
    name: &str,
    arguments: &str,
    timeout: Duration,
    sink: &dyn EventSink,
    cancel: &CancellationToken,
    tracker: &TaskTracker,
) -> Result<ToolResult, String> {
    let Some(tool) = tools.find(name) else {
        // Unknown names are never echoed into events.
        return Ok(error_result(call_id, name, "unknown tool"));
    };
    let Ok(arguments) = serde_json::from_str::<Value>(arguments) else {
        return Ok(error_result(call_id, name, "arguments are not valid JSON"));
    };
    if !arguments.is_object() {
        return Ok(error_result(
            call_id,
            name,
            "arguments must be a JSON object",
        ));
    }
    if cancel.is_cancelled() {
        return Err(CANCELED.into());
    }
    let tool_name = tool.spec().name;
    if !sink.send(AgentEvent::ToolStarted {
        tool: tool_name.clone(),
    }) {
        return Err(CANCELED.into());
    }
    // Each call gets its own child token: a timeout cancels this tool only, a run
    // cancel reaches every tool.
    let ctx = ToolContext {
        cancel: cancel.child_token(),
        tracker: tracker.clone(),
    };
    let started = Instant::now();
    let work = tool.run(arguments, &ctx);
    tokio::pin!(work);
    let outcome = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            ctx.cancel.cancel();
            return Err(CANCELED.into());
        }
        result = &mut work => result,
        _ = tokio::time::sleep(timeout) => {
            // Ask the tool to stop and give it a bounded chance to clean up.
            ctx.cancel.cancel();
            let _ = tokio::time::timeout(CLEANUP_GRACE, &mut work).await;
            Err("tool timed out".into())
        }
    };
    if cancel.is_cancelled() {
        // A result that arrives after cancel is dropped.
        return Err(CANCELED.into());
    }
    let (ok, content) = match outcome {
        Ok(content) => (true, content),
        Err(reason) => (false, reason),
    };
    let (content, truncated) = cap(content, MAX_TOOL_RESULT_BYTES);
    let delivered = sink.send(AgentEvent::ToolFinished {
        tool: tool_name,
        ok,
        truncated,
        duration_ms: started.elapsed().as_millis() as u64,
    });
    if !delivered {
        return Err(CANCELED.into());
    }
    Ok(ToolResult {
        call_id: call_id.into(),
        name: name.into(),
        content,
        is_error: !ok,
    })
}

fn error_result(call_id: &str, name: &str, reason: &str) -> ToolResult {
    ToolResult {
        call_id: call_id.into(),
        name: name.into(),
        content: reason.into(),
        is_error: true,
    }
}

const TRUNCATED_MARKER: &str = "\n[truncated]";

/// Cuts `text` so the result, marker included, is at most `max` bytes, on a char
/// boundary.
fn cap(text: String, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text, false);
    }
    let mut end = max.saturating_sub(TRUNCATED_MARKER.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}{TRUNCATED_MARKER}", &text[..end]), true)
}

// ---------------------------------------------------------------- run registry

const EARLY_CANCEL_TTL: Duration = Duration::from_secs(60);
const MAX_RUN_ID_LEN: usize = 64;

/// Active runs by caller-chosen id (plan R1): duplicate ids are rejected, at most
/// [`MAX_ACTIVE_RUNS`] run at once, and a cancel that arrives before its run started
/// is remembered briefly.
#[derive(Default)]
pub struct RunRegistry {
    inner: Mutex<RegistryInner>,
}

#[derive(Default)]
struct RegistryInner {
    next_generation: u64,
    active: HashMap<String, (u64, CancellationToken)>,
    early: HashMap<String, Instant>,
}

/// Removes its run from the registry when dropped, unless a newer run reused the id.
pub struct RunGuard {
    registry: Arc<RunRegistry>,
    id: String,
    generation: u64,
    pub cancel: CancellationToken,
}

impl RunRegistry {
    pub fn start(self: &Arc<Self>, id: &str) -> Result<RunGuard, String> {
        if id.is_empty()
            || id.len() > MAX_RUN_ID_LEN
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err("AI_AGENT_RUN_ID_INVALID".into());
        }
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.early.retain(|_, at| at.elapsed() < EARLY_CANCEL_TTL);
        if inner.active.contains_key(id) {
            return Err("AI_AGENT_RUN_DUPLICATE".into());
        }
        if inner.active.len() >= MAX_ACTIVE_RUNS {
            return Err("AI_AGENT_BUSY".into());
        }
        let cancel = CancellationToken::new();
        if inner.early.remove(id).is_some() {
            cancel.cancel();
        }
        inner.next_generation += 1;
        let generation = inner.next_generation;
        inner
            .active
            .insert(id.to_string(), (generation, cancel.clone()));
        Ok(RunGuard {
            registry: Arc::clone(self),
            id: id.to_string(),
            generation,
            cancel,
        })
    }

    pub fn cancel(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match inner.active.get(id) {
            Some((_, token)) => token.cancel(),
            None => {
                inner.early.retain(|_, at| at.elapsed() < EARLY_CANCEL_TTL);
                if inner.early.len() < 256 {
                    inner.early.insert(id.to_string(), Instant::now());
                }
            }
        }
    }

    #[cfg(test)]
    pub fn active_count(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active
            .len()
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        let mut inner = self
            .registry
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if inner
            .active
            .get(&self.id)
            .map(|(generation, _)| *generation)
            == Some(self.generation)
        {
            inner.active.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::agent::protocol::{AssistantEnvelope, ToolCall};
    use crate::ai::provider::AiProviderKind;
    use std::collections::VecDeque;

    /// Replies in order; records what each request offered and contained.
    struct ScriptedModel {
        replies: Mutex<VecDeque<Result<AssistantEnvelope, String>>>,
        seen: Mutex<Vec<(usize, usize)>>, // (tools offered, turns)
        delay: Option<Duration>,
    }

    impl ScriptedModel {
        fn new(replies: Vec<Result<AssistantEnvelope, String>>) -> Self {
            Self {
                replies: Mutex::new(replies.into()),
                seen: Mutex::new(Vec::new()),
                delay: None,
            }
        }
    }

    #[async_trait]
    impl AgentModel for ScriptedModel {
        async fn step(&self, request: &StepRequest<'_>) -> Result<AssistantEnvelope, String> {
            self.seen
                .lock()
                .unwrap()
                // Tools callable on this step (declared-but-forbidden counts as none).
                .push((
                    if request.allow_tools {
                        request.tools.len()
                    } else {
                        0
                    },
                    request.turns.len(),
                ));
            if let Some(delay) = self.delay {
                tokio::time::sleep(delay).await;
            }
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Ok(answer("fallback")))
        }
    }

    fn envelope(text: &str, calls: Vec<ToolCall>, stop: StopReason) -> AssistantEnvelope {
        AssistantEnvelope {
            provider: AiProviderKind::Openai,
            model: "m".into(),
            raw: serde_json::json!({}),
            text: text.into(),
            tool_calls: calls,
            stop,
            usage: Some(Usage {
                input_tokens: 10,
                output_tokens: 5,
            }),
        }
    }

    fn answer(text: &str) -> AssistantEnvelope {
        envelope(text, vec![], StopReason::EndTurn)
    }

    fn call(id: &str, name: &str, args: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: args.into(),
        }
    }

    fn tool_use(calls: Vec<ToolCall>) -> AssistantEnvelope {
        envelope("", calls, StopReason::ToolUse)
    }

    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<AgentEvent>>,
        closed: bool,
    }

    impl EventSink for Recorder {
        fn send(&self, event: AgentEvent) -> bool {
            self.events.lock().unwrap().push(event);
            !self.closed
        }
    }

    struct Echo;

    #[async_trait]
    impl AgentTool for Echo {
        fn spec(&self) -> ToolSpec {
            ToolSpec {
                name: "echo".into(),
                description: "echo".into(),
                parameters: serde_json::json!({ "type": "object" }),
            }
        }
        async fn run(&self, arguments: Value, _ctx: &ToolContext) -> Result<String, String> {
            if arguments.get("fail").is_some() {
                return Err("bad input".into());
            }
            Ok("x".repeat(arguments.get("size").and_then(Value::as_u64).unwrap_or(2) as usize))
        }
    }

    fn input() -> RunInput<'static> {
        RunInput {
            model_id: "m",
            system: "sys",
            question: "how many orders?",
            deadline: TURN_DEADLINE,
            tool_timeout: TOOL_TIMEOUT,
        }
    }

    async fn run(model: &ScriptedModel, tools: &ToolRegistry) -> (RunStatus, Vec<AgentEvent>) {
        let sink = Recorder::default();
        let status = run_turn(model, tools, input(), &sink, &CancellationToken::new()).await;
        (status, sink.events.into_inner().unwrap())
    }

    #[tokio::test]
    async fn answers_without_tools() {
        let model = ScriptedModel::new(vec![Ok(answer("42"))]);
        let (status, events) = run(&model, &ToolRegistry::default()).await;
        assert_eq!(status, RunStatus::Answered);
        assert_eq!(events[0], AgentEvent::Step { n: 1 });
        assert_eq!(events[1], AgentEvent::Answer { text: "42".into() });
        assert!(matches!(
            events[2],
            AgentEvent::Done {
                status: RunStatus::Answered,
                steps: 1,
                input_tokens: 10,
                output_tokens: 5
            }
        ));
        assert_eq!(
            model.seen.lock().unwrap()[0],
            (0, 1),
            "no tools offered in Phase 1"
        );
    }

    #[tokio::test]
    async fn runs_tools_and_feeds_results_back() {
        let model = ScriptedModel::new(vec![
            Ok(tool_use(vec![
                call("1", "echo", "{}"),
                call("2", "echo", r#"{"fail":true}"#),
            ])),
            Ok(answer("done")),
        ]);
        let tools = ToolRegistry::new(vec![Arc::new(Echo)]);
        let (status, events) = run(&model, &tools).await;
        assert_eq!(status, RunStatus::Answered);
        assert_eq!(
            model.seen.lock().unwrap()[1],
            (1, 3),
            "user, assistant, tool results"
        );
        assert!(events.contains(&AgentEvent::ToolStarted {
            tool: "echo".into()
        }));
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolFinished { ok: false, .. })));
    }

    #[tokio::test]
    async fn bad_calls_become_error_results_not_crashes() {
        let model = ScriptedModel::new(vec![
            Ok(tool_use(vec![
                call("1", "drop_database", "{}"),
                call("2", "echo", "not json"),
                call("3", "echo", "[1]"),
            ])),
            Ok(answer("ok")),
        ]);
        let tools = ToolRegistry::new(vec![Arc::new(Echo)]);
        let (status, events) = run(&model, &tools).await;
        assert_eq!(status, RunStatus::Answered);
        // None of those calls ran, and the unknown name never reached an event.
        assert!(!events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolStarted { .. })));
        assert!(!format!("{events:?}").contains("drop_database"));
    }

    #[tokio::test]
    async fn tool_calls_from_truncated_or_refused_turns_never_run() {
        for (stop, code) in [
            (StopReason::MaxTokens, "AI_CHAT_OUTPUT_TOKEN_LIMIT"),
            (StopReason::Refusal, "AI_CHAT_REFUSED"),
        ] {
            let model =
                ScriptedModel::new(vec![Ok(envelope("", vec![call("1", "echo", "{}")], stop))]);
            let tools = ToolRegistry::new(vec![Arc::new(Echo)]);
            let (status, events) = run(&model, &tools).await;
            assert_eq!(status, RunStatus::Failed);
            assert!(events.contains(&AgentEvent::Error { code: code.into() }));
            assert!(!events
                .iter()
                .any(|e| matches!(e, AgentEvent::ToolStarted { .. })));
        }
    }

    #[tokio::test]
    async fn last_step_offers_no_tools_and_must_answer() {
        let mut replies: Vec<_> = (0..MAX_STEPS - 1)
            .map(|i| Ok(tool_use(vec![call(&i.to_string(), "echo", "{}")])))
            .collect();
        replies.push(Ok(answer("final")));
        let model = ScriptedModel::new(replies);
        let tools = ToolRegistry::new(vec![Arc::new(Echo)]);
        let (status, events) = run(&model, &tools).await;
        assert_eq!(status, RunStatus::Answered);
        let seen = model.seen.lock().unwrap();
        assert_eq!(seen.len(), MAX_STEPS);
        assert_eq!(seen[MAX_STEPS - 1].0, 0, "final step offers no tools");
        assert!(events.contains(&AgentEvent::Answer {
            text: "final".into()
        }));
    }

    #[tokio::test]
    async fn tool_call_limit_is_enforced() {
        let many: Vec<_> = (0..MAX_TOOL_CALLS + 4)
            .map(|i| call(&i.to_string(), "echo", "{}"))
            .collect();
        let model = ScriptedModel::new(vec![Ok(tool_use(many)), Ok(answer("ok"))]);
        let tools = ToolRegistry::new(vec![Arc::new(Echo)]);
        let (_, events) = run(&model, &tools).await;
        let started = events
            .iter()
            .filter(|e| matches!(e, AgentEvent::ToolStarted { .. }))
            .count();
        assert_eq!(started, MAX_TOOL_CALLS);
        assert_eq!(
            model.seen.lock().unwrap()[1].0,
            0,
            "after the limit no tools are offered"
        );
    }

    #[tokio::test]
    async fn tool_results_are_capped() {
        let model = ScriptedModel::new(vec![
            Ok(tool_use(vec![call(
                "1",
                "echo",
                &format!(r#"{{"size":{}}}"#, MAX_TOOL_RESULT_BYTES * 2),
            )])),
            Ok(answer("ok")),
        ]);
        let tools = ToolRegistry::new(vec![Arc::new(Echo)]);
        let (_, events) = run(&model, &tools).await;
        assert!(events.iter().any(|e| matches!(
            e,
            AgentEvent::ToolFinished {
                truncated: true,
                ..
            }
        )));
        let (capped, truncated) = cap("é".repeat(40), 20);
        assert!(truncated && capped.len() <= 20 && capped.ends_with("[truncated]"));
    }

    #[tokio::test]
    async fn provider_errors_end_the_run_with_their_code() {
        let model = ScriptedModel::new(vec![Err("AI_CHAT_FAILED: 401 Unauthorized".into())]);
        let (status, events) = run(&model, &ToolRegistry::default()).await;
        assert_eq!(status, RunStatus::Failed);
        assert!(events.contains(&AgentEvent::Error {
            code: "AI_CHAT_FAILED: 401 Unauthorized".into()
        }));
    }

    #[tokio::test]
    async fn empty_and_oversized_questions_are_rejected() {
        let model = ScriptedModel::new(vec![]);
        let sink = Recorder::default();
        let long = "x".repeat(MAX_QUESTION_BYTES + 1);
        let status = run_turn(
            &model,
            &ToolRegistry::default(),
            RunInput {
                model_id: "m",
                system: "",
                question: &long,
                deadline: TURN_DEADLINE,
                tool_timeout: TOOL_TIMEOUT,
            },
            &sink,
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(status, RunStatus::Failed);
        assert!(model.seen.lock().unwrap().is_empty(), "nothing was sent");
    }

    #[tokio::test]
    async fn cancel_stops_a_pending_step_and_drops_its_result() {
        let mut model = ScriptedModel::new(vec![Ok(answer("late"))]);
        model.delay = Some(Duration::from_millis(200));
        let sink = Recorder::default();
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            trigger.cancel();
        });
        let status = run_turn(&model, &ToolRegistry::default(), input(), &sink, &cancel).await;
        assert_eq!(status, RunStatus::Canceled);
        let events = sink.events.into_inner().unwrap();
        assert!(!events
            .iter()
            .any(|e| matches!(e, AgentEvent::Answer { .. })));
        assert!(matches!(
            events.last(),
            Some(AgentEvent::Done {
                status: RunStatus::Canceled,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn a_closed_channel_cancels_the_run() {
        let model = ScriptedModel::new(vec![Ok(answer("x"))]);
        let sink = Recorder {
            closed: true,
            ..Default::default()
        };
        let status = run_turn(
            &model,
            &ToolRegistry::default(),
            input(),
            &sink,
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(status, RunStatus::Canceled);
        assert!(model.seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_turn_deadline_is_enforced() {
        let mut model = ScriptedModel::new(vec![Ok(answer("too late"))]);
        model.delay = Some(Duration::from_millis(300));
        let sink = Recorder::default();
        let mut short = input();
        short.deadline = Duration::from_millis(30);
        let status = run_turn(
            &model,
            &ToolRegistry::default(),
            short,
            &sink,
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(status, RunStatus::Failed);
        assert!(sink
            .events
            .into_inner()
            .unwrap()
            .contains(&AgentEvent::Error {
                code: DEADLINE.into()
            }));
    }

    #[tokio::test]
    async fn cancelling_one_run_leaves_a_concurrent_run_alone() {
        let registry = Arc::new(RunRegistry::default());
        let a = registry.start("run-a").unwrap();
        let b = registry.start("run-b").unwrap();
        let mut slow_a = ScriptedModel::new(vec![Ok(answer("a"))]);
        slow_a.delay = Some(Duration::from_millis(200));
        let mut slow_b = ScriptedModel::new(vec![Ok(answer("b"))]);
        slow_b.delay = Some(Duration::from_millis(50));
        let (sink_a, sink_b) = (Recorder::default(), Recorder::default());
        let canceller = Arc::clone(&registry);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            canceller.cancel("run-a");
        });
        let tools = ToolRegistry::default();
        let (status_a, status_b) = tokio::join!(
            run_turn(&slow_a, &tools, input(), &sink_a, &a.cancel),
            run_turn(&slow_b, &tools, input(), &sink_b, &b.cancel),
        );
        assert_eq!(status_a, RunStatus::Canceled);
        assert_eq!(status_b, RunStatus::Answered);
        assert!(sink_b
            .events
            .into_inner()
            .unwrap()
            .contains(&AgentEvent::Answer { text: "b".into() }));
    }

    /// A tool whose native work lives on the tracker and stops only when cancelled.
    struct Worker {
        observed_cancel: Arc<std::sync::atomic::AtomicBool>,
        finished: Arc<std::sync::atomic::AtomicBool>,
        hang: bool,
    }

    #[async_trait]
    impl AgentTool for Worker {
        fn spec(&self) -> ToolSpec {
            ToolSpec {
                name: "worker".into(),
                description: "worker".into(),
                parameters: serde_json::json!({ "type": "object" }),
            }
        }
        async fn run(&self, _arguments: Value, ctx: &ToolContext) -> Result<String, String> {
            let cancel = ctx.cancel.clone();
            let observed = self.observed_cancel.clone();
            let finished = self.finished.clone();
            let handle = ctx.tracker.spawn(async move {
                cancel.cancelled().await;
                observed.store(true, std::sync::atomic::Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(20)).await; // cleanup
                finished.store(true, std::sync::atomic::Ordering::SeqCst);
            });
            if self.hang {
                // Busy until told to stop, like a long query.
                ctx.cancel.cancelled().await;
            }
            let _ = handle.await;
            Ok("done".into())
        }
    }

    fn worker(
        hang: bool,
    ) -> (
        Arc<Worker>,
        Arc<std::sync::atomic::AtomicBool>,
        Arc<std::sync::atomic::AtomicBool>,
    ) {
        let observed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
        (
            Arc::new(Worker {
                observed_cancel: observed.clone(),
                finished: finished.clone(),
                hang,
            }),
            observed,
            finished,
        )
    }

    #[tokio::test]
    async fn a_cancelled_run_never_calls_the_model() {
        for _ in 0..50 {
            let model = ScriptedModel::new(vec![Ok(answer("x"))]);
            let cancel = CancellationToken::new();
            cancel.cancel();
            let sink = Recorder::default();
            let status = run_turn(&model, &ToolRegistry::default(), input(), &sink, &cancel).await;
            assert_eq!(status, RunStatus::Canceled);
            assert!(model.seen.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn deadline_cancels_running_tools_and_waits_for_their_cleanup() {
        let (tool, observed, finished) = worker(true);
        let model = ScriptedModel::new(vec![Ok(tool_use(vec![call("1", "worker", "{}")]))]);
        let mut short = input();
        short.deadline = Duration::from_millis(50);
        let sink = Recorder::default();
        let status = run_turn(
            &model,
            &ToolRegistry::new(vec![tool]),
            short,
            &sink,
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(status, RunStatus::Failed);
        // run_turn returned only after the tool saw the cancel and finished cleanup.
        assert!(observed.load(std::sync::atomic::Ordering::SeqCst));
        assert!(finished.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_tool_timeout_cancels_only_that_tool() {
        let (tool, observed, finished) = worker(true);
        let model = ScriptedModel::new(vec![
            Ok(tool_use(vec![call("1", "worker", "{}")])),
            Ok(answer("ok")),
        ]);
        let mut short = input();
        short.tool_timeout = Duration::from_millis(30);
        let sink = Recorder::default();
        let status = run_turn(
            &model,
            &ToolRegistry::new(vec![tool]),
            short,
            &sink,
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(
            status,
            RunStatus::Answered,
            "the run continues after a tool timeout"
        );
        assert!(observed.load(std::sync::atomic::Ordering::SeqCst));
        assert!(finished.load(std::sync::atomic::Ordering::SeqCst));
        let events = sink.events.into_inner().unwrap();
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolFinished { ok: false, .. })));
    }

    #[tokio::test]
    async fn cancel_during_a_tool_stops_it_and_drops_its_result() {
        let (tool, observed, finished) = worker(true);
        let model = ScriptedModel::new(vec![Ok(tool_use(vec![call("1", "worker", "{}")]))]);
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            trigger.cancel();
        });
        let sink = Recorder::default();
        let status = run_turn(
            &model,
            &ToolRegistry::new(vec![tool]),
            input(),
            &sink,
            &cancel,
        )
        .await;
        assert_eq!(status, RunStatus::Canceled);
        assert!(observed.load(std::sync::atomic::Ordering::SeqCst));
        assert!(finished.load(std::sync::atomic::Ordering::SeqCst));
        let events = sink.events.into_inner().unwrap();
        assert!(!events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolFinished { .. })));
    }

    #[tokio::test]
    async fn duplicate_ids_reject_the_whole_batch_before_anything_runs() {
        let model = ScriptedModel::new(vec![Ok(tool_use(vec![
            call("1", "echo", "{}"),
            call("1", "echo", "{}"),
        ]))]);
        let tools = ToolRegistry::new(vec![Arc::new(Echo)]);
        let (status, events) = run(&model, &tools).await;
        assert_eq!(status, RunStatus::Failed);
        assert!(!events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolStarted { .. })));
        assert!(events.contains(&AgentEvent::Error {
            code: crate::ai::agent::wire::RESPONSE_INVALID.into()
        }));
    }

    /// Reports exactly the allowance it was given as usage, step after step.
    struct GreedyModel {
        requests: Mutex<Vec<(u32, bool)>>,
        report_usage: bool,
        /// Floor the wire would apply (requests below it are sent at it).
        floor: u32,
    }

    #[async_trait]
    impl AgentModel for GreedyModel {
        async fn step(&self, request: &StepRequest<'_>) -> Result<AssistantEnvelope, String> {
            let sent = request.max_tokens.max(self.floor);
            let n = {
                let mut requests = self.requests.lock().unwrap();
                requests.push((sent, request.allow_tools));
                requests.len()
            };
            let mut env = if request.allow_tools {
                tool_use(vec![call(&n.to_string(), "echo", "{}")])
            } else {
                answer("final")
            };
            env.usage = self.report_usage.then_some(Usage {
                input_tokens: 1,
                output_tokens: sent as u64,
            });
            Ok(env)
        }

        fn min_output_tokens(&self, _model: &str) -> u32 {
            self.floor
        }
    }

    #[tokio::test]
    async fn the_output_budget_is_a_hard_ceiling_with_a_reserved_final_answer() {
        for (report_usage, floor) in [
            (true, 0),
            (false, 0),
            (true, 4096),
            (false, 4096),
            (true, 6000),
        ] {
            let model = GreedyModel {
                requests: Mutex::new(Vec::new()),
                report_usage,
                floor,
            };
            let tools = ToolRegistry::new(vec![Arc::new(Echo)]);
            let sink = Recorder::default();
            let status = run_turn(&model, &tools, input(), &sink, &CancellationToken::new()).await;
            assert_eq!(status, RunStatus::Answered);
            let requests = model.requests.lock().unwrap();
            let total: u64 = requests.iter().map(|(t, _)| *t as u64).sum();
            assert!(
                total <= OUTPUT_TOKEN_BUDGET,
                "{total} > budget (usage reported: {report_usage}, floor: {floor})"
            );
            let (last_tokens, last_allows_tools) = *requests.last().unwrap();
            assert!(!last_allows_tools, "final step forbids tools");
            assert!(last_tokens >= MIN_STEP_TOKENS);
            assert!(requests[..requests.len() - 1]
                .iter()
                .all(|(_, allow)| *allow));
        }
    }

    #[tokio::test]
    async fn tools_rejected_after_a_tool_ran_is_not_an_unsupported_signal() {
        let model = ScriptedModel::new(vec![
            Ok(tool_use(vec![call("1", "echo", "{}")])),
            Err(crate::ai::agent::model::TOOLS_UNSUPPORTED.into()),
        ]);
        let tools = ToolRegistry::new(vec![Arc::new(Echo)]);
        let (_, events) = run(&model, &tools).await;
        assert!(events.contains(&AgentEvent::Error {
            code: "AI_AGENT_TOOLS_REJECTED".into()
        }));
    }

    #[tokio::test]
    async fn cancel_and_deadline_never_trigger_finalization() {
        // A cancel/deadline while a step is in flight must end the run immediately —
        // never open a tools-disabled finalization call.
        let mut model = ScriptedModel::new(vec![Ok(answer("late"))]);
        model.delay = Some(Duration::from_millis(80));
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            trigger.cancel();
        });
        let sink = Recorder::default();
        let status = run_turn(&model, &ToolRegistry::default(), input(), &sink, &cancel).await;
        assert_eq!(status, RunStatus::Canceled);
        assert!(
            model.seen.lock().unwrap().len() <= 1,
            "cancellation must not open a finalization step"
        );

        let mut model = ScriptedModel::new(vec![Ok(answer("late"))]);
        model.delay = Some(Duration::from_millis(200));
        let mut short = input();
        short.deadline = Duration::from_millis(30);
        let sink = Recorder::default();
        let status = run_turn(
            &model,
            &ToolRegistry::default(),
            short,
            &sink,
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(status, RunStatus::Failed);
        assert!(
            model.seen.lock().unwrap().len() <= 1,
            "deadline must not open a finalization step"
        );
    }

    #[tokio::test]
    async fn simultaneous_ready_cancel_beats_a_ready_model_with_tools() {
        // Cancel is already ready; a tool-use reply must never start tools.
        for _ in 0..30 {
            let model = ScriptedModel::new(vec![Ok(tool_use(vec![call("1", "echo", "{}")]))]);
            let cancel = CancellationToken::new();
            cancel.cancel();
            let sink = Recorder::default();
            let tools = ToolRegistry::new(vec![Arc::new(Echo)]);
            let status = run_turn(&model, &tools, input(), &sink, &cancel).await;
            assert_eq!(status, RunStatus::Canceled);
            assert!(model.seen.lock().unwrap().is_empty());
            assert!(!sink
                .events
                .into_inner()
                .unwrap()
                .iter()
                .any(|e| matches!(e, AgentEvent::ToolStarted { .. })));
        }
    }

    #[test]
    fn registry_rejects_duplicates_and_limits_concurrency() {
        let registry = Arc::new(RunRegistry::default());
        assert_eq!(
            registry.start("bad id!").err().as_deref(),
            Some("AI_AGENT_RUN_ID_INVALID")
        );
        let a = registry.start("run-a").unwrap();
        assert_eq!(
            registry.start("run-a").err().as_deref(),
            Some("AI_AGENT_RUN_DUPLICATE")
        );
        let _b = registry.start("run-b").unwrap();
        assert_eq!(
            registry.start("run-c").err().as_deref(),
            Some("AI_AGENT_BUSY")
        );
        registry.cancel("run-a");
        assert!(a.cancel.is_cancelled());
        assert!(!_b.cancel.is_cancelled(), "cancel is per run");
        drop(a);
        assert_eq!(registry.active_count(), 1);
    }

    #[test]
    fn cancel_before_start_is_remembered() {
        let registry = Arc::new(RunRegistry::default());
        registry.cancel("run-x");
        let guard = registry.start("run-x").unwrap();
        assert!(guard.cancel.is_cancelled());
    }

    #[test]
    fn an_old_guard_never_removes_a_newer_run() {
        let registry = Arc::new(RunRegistry::default());
        let first = registry.start("run-a").unwrap();
        // Simulate the id being re-registered after the first finished bookkeeping.
        {
            let mut inner = registry.inner.lock().unwrap();
            inner
                .active
                .insert("run-a".into(), (99, CancellationToken::new()));
        }
        drop(first);
        assert_eq!(registry.active_count(), 1, "newer generation kept");
    }
}
