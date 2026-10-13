//! Provider wire formats for tool calling (plan ai-agent R2). Pure functions: build the
//! request body for a [`StepRequest`] and parse a response into an
//! [`AssistantEnvelope`]. Assistant turns are replayed from `envelope.raw`, never
//! rebuilt from parsed fields.

use serde_json::{json, Map, Value};

use super::protocol::{
    AssistantEnvelope, StepRequest, StopReason, ToolCall, ToolResult, ToolSpec, Turn, Usage,
};
use crate::ai::chat::{anthropic_always_thinks, ANTHROPIC_MIN_MAX_TOKENS};
use crate::ai::provider::AiProviderKind;

pub const RESPONSE_INVALID: &str = "AI_AGENT_RESPONSE_INVALID";

/// Prefix for Gemini call ids we had to invent (older API versions send none).
const GEMINI_SYNTHETIC_ID: &str = "gemini-call-";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wire {
    /// Chat Completions `tools` / `tool_calls` / `role: tool`.
    OpenAi,
    Anthropic,
    Gemini,
}

/// Providers whose tool-calling replay contract is verified for v1 (plan R2 matrix).
/// Everything else keeps the legacy assistant.
pub fn wire_for(kind: AiProviderKind) -> Option<Wire> {
    match kind {
        AiProviderKind::Openai | AiProviderKind::Groq | AiProviderKind::Ollama => {
            Some(Wire::OpenAi)
        }
        AiProviderKind::Anthropic => Some(Wire::Anthropic),
        AiProviderKind::Gemini => Some(Wire::Gemini),
        _ => None,
    }
}

/// The floor an adapter applies to `max_tokens` for `model` (0 = none): always-thinking
/// Claude models and Groq GPT-OSS need room for hidden reasoning.
pub fn min_output_tokens(kind: AiProviderKind, model: &str) -> u32 {
    match kind {
        AiProviderKind::Anthropic if anthropic_always_thinks(model) => ANTHROPIC_MIN_MAX_TOKENS,
        AiProviderKind::Groq if model.starts_with("openai/gpt-oss-") => GROQ_GPT_OSS_MIN_TOKENS,
        _ => 0,
    }
}

const GROQ_GPT_OSS_MIN_TOKENS: u32 = 4096;

/// Request path (relative to the provider base URL) and JSON body.
pub fn build(
    wire: Wire,
    kind: AiProviderKind,
    request: &StepRequest<'_>,
) -> Result<(String, Value), String> {
    match wire {
        Wire::OpenAi => Ok(("chat/completions".into(), openai_body(kind, request)?)),
        Wire::Anthropic => Ok(("messages".into(), anthropic_body(request)?)),
        Wire::Gemini => Ok((
            format!(
                "models/{}:generateContent",
                urlencoding::encode(request.model)
            ),
            gemini_body(request)?,
        )),
    }
}

pub fn parse(
    wire: Wire,
    kind: AiProviderKind,
    model: &str,
    value: &Value,
) -> Result<AssistantEnvelope, String> {
    match wire {
        Wire::OpenAi => openai_parse(kind, model, value),
        Wire::Anthropic => anthropic_parse(model, value),
        Wire::Gemini => gemini_parse(model, value),
    }
}

/// Replayed assistant content must come from the same destination.
fn replay(
    envelope: &AssistantEnvelope,
    kind: AiProviderKind,
    model: &str,
) -> Result<Value, String> {
    if envelope.provider != kind || envelope.model != model {
        return Err("AI_AGENT_REPLAY_MISMATCH".into());
    }
    Ok(envelope.raw.clone())
}

/// Token usage, or `None` when the output count is missing or not a number: unknown
/// usage is charged conservatively by the coordinator, never as zero.
fn usage_from(
    usage: Option<&Value>,
    input: &str,
    output: &str,
    extra_output: Option<&str>,
) -> Option<Usage> {
    let usage = usage?;
    let mut output_tokens = usage.get(output)?.as_u64()?;
    if let Some(extra) = extra_output {
        // Optional extra counter (Gemini thoughts); absent means zero.
        output_tokens =
            output_tokens.saturating_add(usage.get(extra).and_then(Value::as_u64).unwrap_or(0));
    }
    Some(Usage {
        input_tokens: usage.get(input).and_then(Value::as_u64).unwrap_or(0),
        output_tokens,
    })
}

// ---------------------------------------------------------------- OpenAI-compatible

fn openai_body(kind: AiProviderKind, request: &StepRequest<'_>) -> Result<Value, String> {
    let mut messages = Vec::new();
    if !request.system.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": request.system }));
    }
    for turn in request.turns {
        match turn {
            Turn::User(text) => messages.push(json!({ "role": "user", "content": text })),
            Turn::Assistant(envelope) => messages.push(replay(envelope, kind, request.model)?),
            Turn::ToolResults(results) => {
                for result in results {
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": result.call_id,
                        // Chat Completions has no error flag for tool messages.
                        "content": tool_content(result),
                    }));
                }
            }
        }
    }
    let mut body = json!({ "model": request.model, "messages": messages, "stream": false });
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        }
                    })
                })
                .collect(),
        );
        body["tool_choice"] = json!(if request.allow_tools { "auto" } else { "none" });
    }
    let groq_gpt_oss = kind == AiProviderKind::Groq && request.model.starts_with("openai/gpt-oss-");
    if groq_gpt_oss {
        // Same rule as the chat path: hidden reasoning needs room before the answer.
        body["max_completion_tokens"] = json!(request.max_tokens.max(GROQ_GPT_OSS_MIN_TOKENS));
        body["reasoning_effort"] = json!("low");
    } else if kind == AiProviderKind::Openai {
        // OpenAI deprecated `max_tokens`; reasoning models (o-series, GPT-5) reject it.
        body["max_completion_tokens"] = json!(request.max_tokens);
    } else {
        body["max_tokens"] = json!(request.max_tokens);
    }
    Ok(body)
}

fn tool_content(result: &ToolResult) -> String {
    if result.is_error {
        format!("ERROR: {}", result.content)
    } else {
        result.content.clone()
    }
}

fn openai_parse(
    kind: AiProviderKind,
    model: &str,
    value: &Value,
) -> Result<AssistantEnvelope, String> {
    let choice = value
        .pointer("/choices/0")
        .ok_or_else(|| RESPONSE_INVALID.to_string())?;
    let message = choice
        .get("message")
        .and_then(Value::as_object)
        .ok_or_else(|| RESPONSE_INVALID.to_string())?;
    let mut raw = message.clone();
    raw.insert("role".into(), json!("assistant"));

    let text = match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };
    let mut tool_calls = Vec::new();
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let function = call
                .get("function")
                .ok_or_else(|| RESPONSE_INVALID.to_string())?;
            let id = call.get("id").and_then(Value::as_str).unwrap_or_default();
            let name = function
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if id.is_empty() || name.is_empty() {
                return Err(RESPONSE_INVALID.into());
            }
            // Required: a call without arguments is malformed, not "no arguments".
            let arguments = match function.get("arguments") {
                Some(Value::String(args)) => args.clone(),
                Some(other @ Value::Object(_)) => other.to_string(),
                _ => return Err(RESPONSE_INVALID.into()),
            };
            tool_calls.push(ToolCall {
                id: id.into(),
                name: name.into(),
                arguments,
            });
        }
    }
    // An explicit refusal wins over anything else in the message.
    let refused = message
        .get("refusal")
        .is_some_and(|r| r.as_str().is_some_and(|r| !r.trim().is_empty()))
        || message
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|parts| {
                parts
                    .iter()
                    .any(|part| part.get("type").and_then(Value::as_str) == Some("refusal"))
            });
    let stop = match choice.get("finish_reason").and_then(Value::as_str) {
        _ if refused => StopReason::Refusal,
        Some("tool_calls") | Some("function_call") => StopReason::ToolUse,
        Some("length") => StopReason::MaxTokens,
        Some("content_filter") => StopReason::Refusal,
        // Some servers (e.g. Ollama) report "stop" together with tool calls.
        Some("stop") if !tool_calls.is_empty() => StopReason::ToolUse,
        Some("stop") => StopReason::EndTurn,
        // No finish reason: never treated as a complete tool turn.
        _ => StopReason::Other,
    };
    let usage = usage_from(
        value.get("usage"),
        "prompt_tokens",
        "completion_tokens",
        None,
    );
    Ok(AssistantEnvelope {
        provider: kind,
        model: model.into(),
        raw: Value::Object(raw),
        text: text.trim().to_string(),
        tool_calls,
        stop,
        usage,
    })
}

// ---------------------------------------------------------------- Anthropic

fn anthropic_body(request: &StepRequest<'_>) -> Result<Value, String> {
    let mut messages: Vec<Value> = Vec::new();
    for turn in request.turns {
        match turn {
            Turn::User(text) => {
                push_user_blocks(&mut messages, vec![json!({ "type": "text", "text": text })])
            }
            Turn::Assistant(envelope) => {
                let content = replay(envelope, AiProviderKind::Anthropic, request.model)?;
                messages.push(json!({ "role": "assistant", "content": content }));
            }
            Turn::ToolResults(results) => push_user_blocks(
                &mut messages,
                results
                    .iter()
                    .map(|result| {
                        json!({
                            "type": "tool_result",
                            "tool_use_id": result.call_id,
                            "content": result.content,
                            "is_error": result.is_error,
                        })
                    })
                    .collect(),
            ),
        }
    }
    let max_tokens = if anthropic_always_thinks(request.model) {
        request.max_tokens.max(ANTHROPIC_MIN_MAX_TOKENS)
    } else {
        request.max_tokens
    };
    // No sampling parameters and no forced tool_choice: always-thinking models reject
    // both, and older models accept their defaults.
    let mut body =
        json!({ "model": request.model, "max_tokens": max_tokens, "messages": messages });
    if !request.system.trim().is_empty() {
        body["system"] = json!(request.system);
    }
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "input_schema": tool.parameters,
                    })
                })
                .collect(),
        );
        if !request.allow_tools {
            // `none` is accepted with thinking (unlike forced `any`/`tool`).
            body["tool_choice"] = json!({ "type": "none" });
        }
    }
    Ok(body)
}

/// Consecutive user content is merged into one message (Anthropic requires alternating
/// roles); tool results stay first because they are pushed first.
fn push_user_blocks(messages: &mut Vec<Value>, blocks: Vec<Value>) {
    if let Some(last) = messages.last_mut() {
        if last["role"] == "user" {
            if let Some(content) = last["content"].as_array_mut() {
                content.extend(blocks);
                return;
            }
        }
    }
    messages.push(json!({ "role": "user", "content": blocks }));
}

fn anthropic_parse(model: &str, value: &Value) -> Result<AssistantEnvelope, String> {
    let content = value
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| RESPONSE_INVALID.to_string())?;
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    for block in content {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => text.push_str(
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            ),
            Some("tool_use") => {
                let id = block.get("id").and_then(Value::as_str).unwrap_or_default();
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if id.is_empty() || name.is_empty() {
                    return Err(RESPONSE_INVALID.into());
                }
                let input = block.get("input").filter(|input| input.is_object());
                let Some(input) = input else {
                    return Err(RESPONSE_INVALID.into());
                };
                tool_calls.push(ToolCall {
                    id: id.into(),
                    name: name.into(),
                    arguments: input.to_string(),
                });
            }
            // thinking, redacted_thinking and anything new: kept in `raw` only.
            _ => {}
        }
    }
    let stop = match value.get("stop_reason").and_then(Value::as_str) {
        Some("tool_use") => StopReason::ToolUse,
        Some("end_turn") | Some("stop_sequence") => StopReason::EndTurn,
        Some("max_tokens") => StopReason::MaxTokens,
        Some("refusal") => StopReason::Refusal,
        _ => StopReason::Other,
    };
    let usage = usage_from(value.get("usage"), "input_tokens", "output_tokens", None);
    Ok(AssistantEnvelope {
        provider: AiProviderKind::Anthropic,
        model: model.into(),
        raw: Value::Array(content.clone()),
        text: text.trim().to_string(),
        tool_calls,
        stop,
        usage,
    })
}

// ---------------------------------------------------------------- Gemini

fn gemini_body(request: &StepRequest<'_>) -> Result<Value, String> {
    let mut contents = Vec::new();
    for turn in request.turns {
        match turn {
            Turn::User(text) => {
                contents.push(json!({ "role": "user", "parts": [{ "text": text }] }))
            }
            Turn::Assistant(envelope) => {
                contents.push(replay(envelope, AiProviderKind::Gemini, request.model)?)
            }
            Turn::ToolResults(results) => contents.push(json!({
                "role": "user",
                "parts": results.iter().map(gemini_function_response).collect::<Vec<_>>(),
            })),
        }
    }
    let mut body = json!({
        "contents": contents,
        "generationConfig": { "maxOutputTokens": request.max_tokens },
    });
    if !request.system.trim().is_empty() {
        body["systemInstruction"] = json!({ "parts": [{ "text": request.system }] });
    }
    if !request.tools.is_empty() {
        body["tools"] = json!([{
            "functionDeclarations": request.tools.iter().map(gemini_declaration).collect::<Vec<_>>(),
        }]);
        if !request.allow_tools {
            body["toolConfig"] = json!({ "functionCallingConfig": { "mode": "NONE" } });
        }
    }
    Ok(body)
}

fn gemini_declaration(tool: &ToolSpec) -> Value {
    json!({
        "name": tool.name,
        "description": tool.description,
        "parameters": gemini_schema(&tool.parameters),
    })
}

/// Gemini accepts an OpenAPI subset: drop JSON-Schema-only keywords.
fn gemini_schema(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| !matches!(key.as_str(), "additionalProperties" | "$schema"))
                .map(|(key, value)| (key.clone(), gemini_schema(value)))
                .collect::<Map<_, _>>(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(gemini_schema).collect()),
        other => other.clone(),
    }
}

fn gemini_function_response(result: &ToolResult) -> Value {
    let response = if result.is_error {
        json!({ "error": result.content })
    } else {
        json!({ "result": result.content })
    };
    let mut part = json!({ "functionResponse": { "name": result.name, "response": response } });
    if !result.call_id.starts_with(GEMINI_SYNTHETIC_ID) {
        part["functionResponse"]["id"] = json!(result.call_id);
    }
    part
}

fn gemini_parse(model: &str, value: &Value) -> Result<AssistantEnvelope, String> {
    let usage = usage_from(
        value.get("usageMetadata"),
        "promptTokenCount",
        "candidatesTokenCount",
        Some("thoughtsTokenCount"),
    );
    let Some(candidate) = value.pointer("/candidates/0") else {
        // No candidate: the prompt itself was blocked.
        if value.pointer("/promptFeedback/blockReason").is_some() {
            return Ok(AssistantEnvelope {
                provider: AiProviderKind::Gemini,
                model: model.into(),
                raw: json!({ "role": "model", "parts": [] }),
                text: String::new(),
                tool_calls: Vec::new(),
                stop: StopReason::Refusal,
                usage,
            });
        }
        return Err(RESPONSE_INVALID.into());
    };
    let content = candidate
        .get("content")
        .cloned()
        .unwrap_or_else(|| json!({ "role": "model", "parts": [] }));
    let parts = content
        .get("parts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    for part in &parts {
        if let Some(call) = part.get("functionCall") {
            let name = call.get("name").and_then(Value::as_str).unwrap_or_default();
            if name.is_empty() {
                return Err(RESPONSE_INVALID.into());
            }
            let id = call
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("{GEMINI_SYNTHETIC_ID}{}", tool_calls.len()));
            // Gemini omits `args` for functions without parameters; anything present
            // must be an object.
            let arguments = match call.get("args") {
                None => "{}".to_string(),
                Some(args @ Value::Object(_)) => args.to_string(),
                Some(_) => return Err(RESPONSE_INVALID.into()),
            };
            tool_calls.push(ToolCall {
                id,
                name: name.into(),
                arguments,
            });
        } else if part.get("thought").and_then(Value::as_bool) != Some(true) {
            text.push_str(part.get("text").and_then(Value::as_str).unwrap_or_default());
        }
    }
    let stop = match candidate.get("finishReason").and_then(Value::as_str) {
        Some("STOP") if !tool_calls.is_empty() => StopReason::ToolUse,
        Some("STOP") => StopReason::EndTurn,
        Some("MAX_TOKENS") => StopReason::MaxTokens,
        Some("SAFETY" | "RECITATION" | "PROHIBITED_CONTENT" | "BLOCKLIST" | "SPII") => {
            StopReason::Refusal
        }
        _ => StopReason::Other,
    };
    Ok(AssistantEnvelope {
        provider: AiProviderKind::Gemini,
        model: model.into(),
        raw: content,
        text: text.trim().to_string(),
        tool_calls,
        stop,
        usage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool() -> ToolSpec {
        ToolSpec {
            name: "list_tables".into(),
            description: "List tables".into(),
            parameters: json!({
                "type": "object",
                "properties": { "schema": { "type": "string" } },
                "additionalProperties": false
            }),
        }
    }

    fn request<'a>(model: &'a str, turns: &'a [Turn], tools: &'a [ToolSpec]) -> StepRequest<'a> {
        StepRequest {
            model,
            system: "You are a database assistant.",
            turns,
            tools,
            allow_tools: true,
            max_tokens: 1024,
        }
    }

    // ------------------------------------------------ OpenAI-compatible

    #[test]
    fn openai_round_trip_with_tool_calls() {
        let response = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        { "id": "call_1", "type": "function", "function": { "name": "list_tables", "arguments": "{\"schema\":\"public\"}" } },
                        { "id": "call_2", "type": "function", "function": { "name": "list_tables", "arguments": "{}" } }
                    ],
                    "reasoning_details": [{ "type": "reasoning.encrypted", "data": "opaque" }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 5 }
        });
        let env = parse(Wire::OpenAi, AiProviderKind::Openai, "gpt-4.1", &response).unwrap();
        assert_eq!(env.stop, StopReason::ToolUse);
        assert_eq!(env.tool_calls.len(), 2);
        assert_eq!(env.tool_calls[0].arguments, "{\"schema\":\"public\"}");
        assert_eq!(
            env.usage,
            Some(Usage {
                input_tokens: 10,
                output_tokens: 5
            })
        );

        let turns = vec![
            Turn::User("tables?".into()),
            Turn::Assistant(env.clone()),
            Turn::ToolResults(vec![
                ToolResult {
                    call_id: "call_1".into(),
                    name: "list_tables".into(),
                    content: "orders".into(),
                    is_error: false,
                },
                ToolResult {
                    call_id: "call_2".into(),
                    name: "list_tables".into(),
                    content: "denied".into(),
                    is_error: true,
                },
            ]),
        ];
        let tools = [tool()];
        let (path, body) = build(
            Wire::OpenAi,
            AiProviderKind::Openai,
            &request("gpt-4.1", &turns, &tools),
        )
        .unwrap();
        assert_eq!(path, "chat/completions");
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages[0]["role"], "system");
        // Assistant replayed verbatim, including provider-only fields.
        assert_eq!(messages[2], env.raw);
        assert_eq!(messages[2]["reasoning_details"][0]["data"], "opaque");
        assert_eq!(
            messages[3],
            json!({ "role": "tool", "tool_call_id": "call_1", "content": "orders" })
        );
        assert_eq!(messages[4]["content"], "ERROR: denied");
        assert_eq!(body["tools"][0]["function"]["name"], "list_tables");
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(
            body["max_completion_tokens"], 1024,
            "OpenAI uses max_completion_tokens"
        );
        assert!(body.get("max_tokens").is_none());
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn openai_without_tools_sends_no_tool_fields() {
        let turns = vec![Turn::User("hi".into())];
        let (_, body) = build(
            Wire::OpenAi,
            AiProviderKind::Ollama,
            &request("qwen3", &turns, &[]),
        )
        .unwrap();
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());
    }

    #[test]
    fn ollama_stop_with_tool_calls_means_tool_use() {
        let response = json!({
            "choices": [{
                "message": { "role": "assistant", "content": "", "tool_calls": [
                    { "id": "c1", "function": { "name": "list_tables", "arguments": { "schema": "main" } } }
                ] },
                "finish_reason": "stop"
            }]
        });
        let env = parse(Wire::OpenAi, AiProviderKind::Ollama, "qwen3", &response).unwrap();
        assert_eq!(env.stop, StopReason::ToolUse);
        // Object arguments are serialised to JSON text.
        assert_eq!(env.tool_calls[0].arguments, "{\"schema\":\"main\"}");
    }

    #[test]
    fn groq_gpt_oss_keeps_its_reasoning_budget() {
        let turns = vec![Turn::User("hi".into())];
        let (_, body) = build(
            Wire::OpenAi,
            AiProviderKind::Groq,
            &request("openai/gpt-oss-120b", &turns, &[]),
        )
        .unwrap();
        assert_eq!(body["max_completion_tokens"], 4096);
        assert_eq!(body["reasoning_effort"], "low");
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn openai_finish_reasons() {
        for (reason, stop) in [
            ("stop", StopReason::EndTurn),
            ("length", StopReason::MaxTokens),
            ("content_filter", StopReason::Refusal),
        ] {
            let response =
                json!({ "choices": [{ "message": { "content": "x" }, "finish_reason": reason }] });
            assert_eq!(
                parse(Wire::OpenAi, AiProviderKind::Openai, "m", &response)
                    .unwrap()
                    .stop,
                stop
            );
        }
        assert!(parse(
            Wire::OpenAi,
            AiProviderKind::Openai,
            "m",
            &json!({ "choices": [] })
        )
        .is_err());
        let nameless = json!({ "choices": [{ "message": { "tool_calls": [{ "id": "1", "function": {} }] } }] });
        assert!(parse(Wire::OpenAi, AiProviderKind::Openai, "m", &nameless).is_err());
    }

    // ------------------------------------------------ Anthropic

    #[test]
    fn anthropic_round_trip_keeps_thinking_blocks_and_orders_results() {
        let response = json!({
            "content": [
                { "type": "thinking", "thinking": "", "signature": "sig-1" },
                { "type": "redacted_thinking", "data": "enc" },
                { "type": "text", "text": "Checking." },
                { "type": "tool_use", "id": "toolu_1", "name": "list_tables", "input": { "schema": "public" } }
            ],
            "stop_reason": "tool_use",
            "usage": { "input_tokens": 20, "output_tokens": 7 }
        });
        let env = parse(
            Wire::Anthropic,
            AiProviderKind::Anthropic,
            "claude-opus-5-5",
            &response,
        )
        .unwrap();
        assert_eq!(env.stop, StopReason::ToolUse);
        assert_eq!(env.text, "Checking.");
        assert_eq!(env.tool_calls[0].arguments, "{\"schema\":\"public\"}");

        let turns = vec![
            Turn::User("tables?".into()),
            Turn::Assistant(env.clone()),
            Turn::ToolResults(vec![ToolResult {
                call_id: "toolu_1".into(),
                name: "list_tables".into(),
                content: "orders".into(),
                is_error: false,
            }]),
            Turn::User("and views?".into()),
        ];
        let tools = [tool()];
        let (path, body) = build(
            Wire::Anthropic,
            AiProviderKind::Anthropic,
            &request("claude-opus-5-5", &turns, &tools),
        )
        .unwrap();
        assert_eq!(path, "messages");
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(
            messages.len(),
            3,
            "tool results and the next user text share one message"
        );
        // Every assistant block, including empty thinking and its signature, is echoed.
        assert_eq!(messages[1]["content"], response["content"]);
        assert_eq!(messages[2]["content"][0]["type"], "tool_result");
        assert_eq!(messages[2]["content"][0]["is_error"], false);
        assert_eq!(messages[2]["content"][1]["type"], "text");
        // Always-thinking rules: floor, no sampling, no forced tool choice.
        assert_eq!(body["max_tokens"], ANTHROPIC_MIN_MAX_TOKENS);
        assert!(body.get("temperature").is_none());
        assert!(body.get("tool_choice").is_none());
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        assert_eq!(body["system"], "You are a database assistant.");
    }

    #[test]
    fn anthropic_older_models_keep_the_requested_limit() {
        let turns = vec![Turn::User("hi".into())];
        let (_, body) = build(
            Wire::Anthropic,
            AiProviderKind::Anthropic,
            &request("claude-sonnet-4-5", &turns, &[]),
        )
        .unwrap();
        assert_eq!(body["max_tokens"], 1024);
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn anthropic_stop_reasons() {
        for (reason, stop) in [
            ("end_turn", StopReason::EndTurn),
            ("max_tokens", StopReason::MaxTokens),
            ("refusal", StopReason::Refusal),
            ("pause_turn", StopReason::Other),
        ] {
            let response = json!({ "content": [], "stop_reason": reason });
            assert_eq!(
                parse(Wire::Anthropic, AiProviderKind::Anthropic, "m", &response)
                    .unwrap()
                    .stop,
                stop
            );
        }
    }

    // ------------------------------------------------ Gemini

    #[test]
    fn gemini_round_trip_keeps_thought_signatures() {
        let response = json!({
            "candidates": [{
                "content": { "role": "model", "parts": [
                    { "text": "thinking...", "thought": true },
                    { "functionCall": { "name": "list_tables", "args": { "schema": "public" } }, "thoughtSignature": "sig" },
                    { "functionCall": { "id": "fc-2", "name": "list_tables", "args": {} } }
                ] },
                "finishReason": "STOP"
            }],
            "usageMetadata": { "promptTokenCount": 9, "candidatesTokenCount": 3, "thoughtsTokenCount": 4 }
        });
        let env = parse(
            Wire::Gemini,
            AiProviderKind::Gemini,
            "gemini-2.5-pro",
            &response,
        )
        .unwrap();
        assert_eq!(env.stop, StopReason::ToolUse);
        assert_eq!(env.text, "", "thought parts are not answer text");
        assert_eq!(env.tool_calls[0].id, "gemini-call-0");
        assert_eq!(env.tool_calls[1].id, "fc-2");
        assert_eq!(
            env.usage,
            Some(Usage {
                input_tokens: 9,
                output_tokens: 7
            })
        );

        let turns = vec![
            Turn::User("tables?".into()),
            Turn::Assistant(env.clone()),
            Turn::ToolResults(vec![
                ToolResult {
                    call_id: "gemini-call-0".into(),
                    name: "list_tables".into(),
                    content: "orders".into(),
                    is_error: false,
                },
                ToolResult {
                    call_id: "fc-2".into(),
                    name: "list_tables".into(),
                    content: "nope".into(),
                    is_error: true,
                },
            ]),
        ];
        let tools = [tool()];
        let (path, body) = build(
            Wire::Gemini,
            AiProviderKind::Gemini,
            &request("gemini-2.5-pro", &turns, &tools),
        )
        .unwrap();
        assert_eq!(path, "models/gemini-2.5-pro:generateContent");
        let contents = body["contents"].as_array().unwrap();
        assert_eq!(contents[1], response["candidates"][0]["content"]);
        assert_eq!(contents[1]["parts"][1]["thoughtSignature"], "sig");
        let parts = contents[2]["parts"].as_array().unwrap();
        assert_eq!(parts[0]["functionResponse"]["response"]["result"], "orders");
        assert!(
            parts[0]["functionResponse"].get("id").is_none(),
            "synthetic ids are not sent"
        );
        assert_eq!(parts[1]["functionResponse"]["id"], "fc-2");
        assert_eq!(parts[1]["functionResponse"]["response"]["error"], "nope");
        let declaration = &body["tools"][0]["functionDeclarations"][0];
        assert!(declaration["parameters"]
            .get("additionalProperties")
            .is_none());
        assert_eq!(body["generationConfig"]["maxOutputTokens"], 1024);
    }

    #[test]
    fn gemini_blocks_and_limits() {
        let blocked = json!({ "promptFeedback": { "blockReason": "SAFETY" } });
        assert_eq!(
            parse(Wire::Gemini, AiProviderKind::Gemini, "m", &blocked)
                .unwrap()
                .stop,
            StopReason::Refusal
        );
        let limited = json!({ "candidates": [{ "content": { "parts": [{ "text": "par" }] }, "finishReason": "MAX_TOKENS" }] });
        let env = parse(Wire::Gemini, AiProviderKind::Gemini, "m", &limited).unwrap();
        assert_eq!(
            (env.stop, env.text.as_str()),
            (StopReason::MaxTokens, "par")
        );
        assert!(parse(Wire::Gemini, AiProviderKind::Gemini, "m", &json!({})).is_err());
    }

    #[test]
    fn missing_or_wrong_shaped_arguments_are_malformed() {
        let openai = json!({ "choices": [{
            "message": { "tool_calls": [{ "id": "1", "function": { "name": "list_tables" } }] },
            "finish_reason": "tool_calls"
        }] });
        assert!(parse(Wire::OpenAi, AiProviderKind::Openai, "m", &openai).is_err());
        let anthropic = json!({
            "content": [{ "type": "tool_use", "id": "t", "name": "list_tables" }],
            "stop_reason": "tool_use"
        });
        assert!(parse(Wire::Anthropic, AiProviderKind::Anthropic, "m", &anthropic).is_err());
        let gemini_bad = json!({ "candidates": [{
            "content": { "parts": [{ "functionCall": { "name": "list_tables", "args": "x" } }] },
            "finishReason": "STOP"
        }] });
        assert!(parse(Wire::Gemini, AiProviderKind::Gemini, "m", &gemini_bad).is_err());
        // Gemini documents `args` as optional (functions without parameters).
        let gemini_none = json!({ "candidates": [{
            "content": { "parts": [{ "functionCall": { "name": "list_schemas" } }] },
            "finishReason": "STOP"
        }] });
        let env = parse(Wire::Gemini, AiProviderKind::Gemini, "m", &gemini_none).unwrap();
        assert_eq!(env.tool_calls[0].arguments, "{}");
    }

    #[test]
    fn openai_refusals_win_over_text_and_calls() {
        let refusal_field = json!({ "choices": [{
            "message": { "content": "I can't", "refusal": "I can't help with that." },
            "finish_reason": "stop"
        }] });
        assert_eq!(
            parse(Wire::OpenAi, AiProviderKind::Openai, "m", &refusal_field)
                .unwrap()
                .stop,
            StopReason::Refusal
        );
        let refusal_part = json!({ "choices": [{
            "message": {
                "content": [{ "type": "refusal", "refusal": "no" }],
                "tool_calls": [{ "id": "1", "function": { "name": "x", "arguments": "{}" } }]
            },
            "finish_reason": "tool_calls"
        }] });
        let env = parse(Wire::OpenAi, AiProviderKind::Openai, "m", &refusal_part).unwrap();
        assert_eq!(env.stop, StopReason::Refusal);
        assert!(!env.tool_calls_runnable());
    }

    #[test]
    fn missing_finish_reasons_never_make_calls_runnable() {
        let openai = json!({ "choices": [{
            "message": { "tool_calls": [{ "id": "1", "function": { "name": "x", "arguments": "{}" } }] }
        }] });
        assert_eq!(
            parse(Wire::OpenAi, AiProviderKind::Openai, "m", &openai)
                .unwrap()
                .stop,
            StopReason::Other
        );
        let gemini = json!({ "candidates": [{ "content": { "parts": [{ "functionCall": { "name": "x" } }] } }] });
        assert_eq!(
            parse(Wire::Gemini, AiProviderKind::Gemini, "m", &gemini)
                .unwrap()
                .stop,
            StopReason::Other
        );
    }

    #[test]
    fn final_steps_declare_tools_but_forbid_calls() {
        let turns = vec![Turn::User("hi".into())];
        let tools = [tool()];
        let mut req = request("gpt-4.1", &turns, &tools);
        req.allow_tools = false;
        let (_, body) = build(Wire::OpenAi, AiProviderKind::Openai, &req).unwrap();
        assert_eq!(body["tool_choice"], "none");
        assert!(body["tools"].is_array());
        req.model = "claude-opus-5-5";
        let (_, body) = build(Wire::Anthropic, AiProviderKind::Anthropic, &req).unwrap();
        assert_eq!(body["tool_choice"], json!({ "type": "none" }));
        req.model = "gemini-2.5-pro";
        let (_, body) = build(Wire::Gemini, AiProviderKind::Gemini, &req).unwrap();
        assert_eq!(body["toolConfig"]["functionCallingConfig"]["mode"], "NONE");
    }

    #[test]
    fn openai_reasoning_models_get_completion_tokens_others_keep_max_tokens() {
        let turns = vec![Turn::User("hi".into())];
        let (_, body) = build(
            Wire::OpenAi,
            AiProviderKind::Openai,
            &request("o3", &turns, &[]),
        )
        .unwrap();
        assert_eq!(body["max_completion_tokens"], 1024);
        assert!(body.get("max_tokens").is_none());
        let (_, body) = build(
            Wire::OpenAi,
            AiProviderKind::Ollama,
            &request("qwen3", &turns, &[]),
        )
        .unwrap();
        assert_eq!(body["max_tokens"], 1024);
        let (_, body) = build(
            Wire::OpenAi,
            AiProviderKind::Groq,
            &request("llama-3.3-70b", &turns, &[]),
        )
        .unwrap();
        assert_eq!(body["max_tokens"], 1024);
    }

    #[test]
    fn partial_usage_is_unknown_not_zero() {
        let openai = json!({
            "choices": [{ "message": { "content": "x" }, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": 5 }
        });
        assert_eq!(
            parse(Wire::OpenAi, AiProviderKind::Openai, "m", &openai)
                .unwrap()
                .usage,
            None
        );
        let anthropic = json!({ "content": [], "stop_reason": "end_turn", "usage": { "output_tokens": "lots" } });
        assert_eq!(
            parse(Wire::Anthropic, AiProviderKind::Anthropic, "m", &anthropic)
                .unwrap()
                .usage,
            None
        );
        let gemini = json!({
            "candidates": [{ "content": { "parts": [{ "text": "x" }] }, "finishReason": "STOP" }],
            "usageMetadata": { "promptTokenCount": 1, "candidatesTokenCount": u64::MAX, "thoughtsTokenCount": 9 }
        });
        let env = parse(Wire::Gemini, AiProviderKind::Gemini, "m", &gemini).unwrap();
        assert_eq!(
            env.usage.unwrap().output_tokens,
            u64::MAX,
            "saturating, no overflow"
        );
    }

    // ------------------------------------------------ Shared

    #[test]
    fn replay_is_bound_to_its_destination() {
        let env = parse(
            Wire::OpenAi,
            AiProviderKind::Openai,
            "gpt-4.1",
            &json!({ "choices": [{ "message": { "content": "hi" }, "finish_reason": "stop" }] }),
        )
        .unwrap();
        let turns = vec![Turn::Assistant(env)];
        let err = build(
            Wire::OpenAi,
            AiProviderKind::Openai,
            &request("gpt-4.1-mini", &turns, &[]),
        )
        .unwrap_err();
        assert_eq!(err, "AI_AGENT_REPLAY_MISMATCH");
        let err = build(
            Wire::OpenAi,
            AiProviderKind::Groq,
            &request("gpt-4.1", &turns, &[]),
        )
        .unwrap_err();
        assert_eq!(err, "AI_AGENT_REPLAY_MISMATCH");
    }

    #[test]
    fn only_verified_providers_get_agent_mode() {
        assert_eq!(wire_for(AiProviderKind::Openai), Some(Wire::OpenAi));
        assert_eq!(wire_for(AiProviderKind::Ollama), Some(Wire::OpenAi));
        assert_eq!(wire_for(AiProviderKind::Anthropic), Some(Wire::Anthropic));
        assert_eq!(wire_for(AiProviderKind::Gemini), Some(Wire::Gemini));
        for kind in [
            AiProviderKind::Openrouter,
            AiProviderKind::Deepseek,
            AiProviderKind::Grok,
            AiProviderKind::GithubCopilot,
        ] {
            assert_eq!(wire_for(kind), None);
        }
    }
}
