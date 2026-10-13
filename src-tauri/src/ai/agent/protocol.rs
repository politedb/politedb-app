//! Provider-neutral agent transcript (plan ai-agent R1/R2).
//!
//! The authoritative record of an assistant turn is its [`AssistantEnvelope`]: the
//! provider-native content is kept verbatim in `raw` and replayed unchanged on the next
//! request (Anthropic thinking blocks and signatures, Gemini `thoughtSignature`,
//! OpenRouter `reasoning_details`, …). `text` and `tool_calls` are parsed views for the
//! coordinator; they are never used to rebuild what is sent back.
//!
//! Envelopes live only in backend memory for the length of a run. They are never
//! persisted, sent to the frontend or logged.

use serde_json::Value;

use crate::ai::provider::AiProviderKind;

/// A tool offered to the model. `parameters` is a JSON Schema object.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

/// A tool call requested by the model. `arguments` is the raw JSON text the model
/// produced; the coordinator validates it before anything runs.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// Finished answering.
    EndTurn,
    /// Waiting for tool results.
    ToolUse,
    /// Output budget exhausted; tool calls (if any) may be incomplete.
    MaxTokens,
    /// The provider refused or filtered the answer.
    Refusal,
    Other,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AssistantEnvelope {
    /// Destination this envelope came from; it is only ever replayed there.
    pub provider: AiProviderKind,
    pub model: String,
    /// Provider-native assistant message/content, replayed verbatim.
    pub raw: Value,
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub stop: StopReason,
    pub usage: Option<Usage>,
}

impl AssistantEnvelope {
    /// Tool calls may run only from a complete, non-refused turn.
    pub fn tool_calls_runnable(&self) -> bool {
        self.stop == StopReason::ToolUse && !self.tool_calls.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    pub call_id: String,
    pub name: String,
    pub content: String,
    pub is_error: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Turn {
    User(String),
    Assistant(AssistantEnvelope),
    /// Results for every call of the preceding assistant turn, in call order.
    ToolResults(Vec<ToolResult>),
}

/// One model request: the whole transcript so far plus the tools on offer.
#[derive(Debug, Clone)]
pub struct StepRequest<'a> {
    pub model: &'a str,
    pub system: &'a str,
    pub turns: &'a [Turn],
    pub tools: &'a [ToolSpec],
    /// `false` keeps the tools declared but forbids calling them (final step).
    pub allow_tools: bool,
    pub max_tokens: u32,
}
