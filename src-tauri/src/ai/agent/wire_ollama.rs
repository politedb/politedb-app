//! Ollama's native `/api/chat` wire (plan ollama-native-context A3, A5, C3).
//!
//! Every request disables prompt truncation and context shifting (`truncate:false`,
//! `shift:false`) and carries the run's context size, so an oversized prompt is an
//! error instead of being cut silently. The assistant message is replayed verbatim;
//! tool results are correlated by call order and `tool_name`, and carry
//! `tool_call_id` only when every call of their batch has a usable native id.

use serde_json::{json, Map, Value};

use super::protocol::{AssistantEnvelope, StepRequest, StopReason, ToolCall, Turn};
use super::wire::{function_tools, replay, tool_content, usage_from, RESPONSE_INVALID};
use crate::ai::provider::AiProviderKind;

/// Longest native tool-call id accepted (C3).
const MAX_ID_BYTES: usize = 256;

/// Internal id of the call at `position` in its batch. Only used inside the run; never
/// sent to the server.
pub fn internal_id(position: usize) -> String {
    format!("ollama-{position}")
}

/// Native ids usable as `tool_call_id`: present for every call, non-empty, unique.
fn result_ids(calls: &[Value]) -> Option<Vec<String>> {
    let mut ids = Vec::with_capacity(calls.len());
    for call in calls {
        let id = call.get("id")?.as_str()?;
        if id.is_empty() || ids.iter().any(|seen| seen == id) {
            return None;
        }
        ids.push(id.to_string());
    }
    Some(ids)
}

pub fn body(request: &StepRequest<'_>, num_ctx: u32) -> Result<Value, String> {
    let mut messages = Vec::new();
    if !request.system.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": request.system }));
    }
    let mut last_calls: Vec<Value> = Vec::new();
    for turn in request.turns {
        match turn {
            Turn::User(text) => messages.push(json!({ "role": "user", "content": text })),
            Turn::Assistant(envelope) => {
                let raw = replay(envelope, AiProviderKind::Ollama, request.model)?;
                last_calls = raw
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                messages.push(raw);
            }
            Turn::ToolResults(results) => {
                if results.len() != last_calls.len() {
                    return Err(RESPONSE_INVALID.into());
                }
                let ids = result_ids(&last_calls);
                for (position, result) in results.iter().enumerate() {
                    // Results arrive in call order; correlation is by position.
                    if result.call_id != internal_id(position) {
                        return Err(RESPONSE_INVALID.into());
                    }
                    let mut message = json!({
                        "role": "tool",
                        "tool_name": result.name,
                        "content": tool_content(result),
                    });
                    if let Some(ids) = &ids {
                        message["tool_call_id"] = json!(ids[position]);
                    }
                    messages.push(message);
                }
            }
        }
    }
    let mut body = json!({
        "model": request.model,
        "messages": messages,
        "stream": false,
        "truncate": false,
        "shift": false,
        "options": { "num_ctx": num_ctx, "num_predict": request.max_tokens },
    });
    // The final step omits declarations: calling tools is then impossible, and Ollama
    // replays earlier calls without them.
    if request.allow_tools && !request.tools.is_empty() {
        body["tools"] = function_tools(request.tools);
    }
    Ok(body)
}

fn invalid<T>() -> Result<T, String> {
    Err(RESPONSE_INVALID.into())
}

/// Validates the whole response before anything runs (A5, C3).
pub fn parse(model: &str, value: &Value) -> Result<AssistantEnvelope, String> {
    let Some(object) = value.as_object() else {
        return invalid();
    };
    if object.get("done") != Some(&Value::Bool(true)) {
        return invalid();
    }
    let Some(message) = object.get("message").and_then(Value::as_object) else {
        return invalid();
    };
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return invalid();
    }
    let Some(text) = message.get("content").and_then(Value::as_str) else {
        return invalid();
    };
    if message
        .get("thinking")
        .is_some_and(|thinking| !thinking.is_string())
    {
        return invalid();
    }
    let calls: &[Value] = match message.get("tool_calls") {
        None | Some(Value::Null) => &[],
        Some(Value::Array(calls)) => calls,
        Some(_) => return invalid(),
    };
    let mut tool_calls = Vec::with_capacity(calls.len());
    for (position, call) in calls.iter().enumerate() {
        let Some(call) = call.as_object() else {
            return invalid();
        };
        match call.get("id") {
            None | Some(Value::Null) => {}
            Some(Value::String(id)) if id.len() <= MAX_ID_BYTES => {}
            // A number/object id would make the replay undecodable after tools ran.
            Some(_) => return invalid(),
        }
        let Some(function) = call.get("function").and_then(Value::as_object) else {
            return invalid();
        };
        let name = function.get("name").and_then(Value::as_str).unwrap_or("");
        if name.is_empty() {
            return invalid();
        }
        let Some(arguments) = function.get("arguments").filter(|a| a.is_object()) else {
            return invalid();
        };
        tool_calls.push(ToolCall {
            id: internal_id(position),
            name: name.to_string(),
            arguments: arguments.to_string(),
        });
    }
    let stop = match object.get("done_reason").and_then(Value::as_str) {
        Some("stop") if !tool_calls.is_empty() => StopReason::ToolUse,
        Some("stop") => StopReason::EndTurn,
        // Generation reached `num_predict` or the window (`shift:false`): calls in it
        // never run (the coordinator only runs calls of a `ToolUse` turn).
        Some("length") => StopReason::MaxTokens,
        _ => return invalid(),
    };
    Ok(AssistantEnvelope {
        provider: AiProviderKind::Ollama,
        model: model.into(),
        // Verbatim, including `thinking` and native ids, for replay to this server.
        raw: Value::Object(Map::clone(message)),
        text: text.trim().to_string(),
        tool_calls,
        stop,
        usage: usage_from(Some(value), "prompt_eval_count", "eval_count", None),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::agent::protocol::{ToolResult, ToolSpec, Usage};

    fn tool() -> ToolSpec {
        ToolSpec {
            name: "get_row_count".into(),
            description: "Rows in a table".into(),
            parameters: json!({"type": "object", "properties": {"table": {"type": "string"}}}),
        }
    }

    fn response(calls: Value, reason: &str) -> Value {
        json!({
            "model": "qwen3:4b",
            "done": true,
            "done_reason": reason,
            "prompt_eval_count": 152,
            "eval_count": 729,
            "message": {
                "role": "assistant",
                "content": "",
                "thinking": "private reasoning",
                "tool_calls": calls,
                "x_future_field": {"kept": true}
            }
        })
    }

    fn two_calls(ids: (Value, Value)) -> Value {
        json!([
            {"id": ids.0, "function": {"index": 0, "name": "get_row_count", "arguments": {"table": "orders"}}},
            {"id": ids.1, "function": {"index": 1, "name": "get_row_count", "arguments": {"table": "customers"}}}
        ])
    }

    fn result(position: usize, content: &str, is_error: bool) -> ToolResult {
        ToolResult {
            call_id: internal_id(position),
            name: "get_row_count".into(),
            content: content.into(),
            is_error,
        }
    }

    fn request<'a>(turns: &'a [Turn], tools: &'a [ToolSpec], allow: bool) -> StepRequest<'a> {
        StepRequest {
            model: "qwen3:4b",
            system: "sys",
            turns,
            tools,
            allow_tools: allow,
            max_tokens: 1000,
        }
    }

    #[test]
    fn same_function_twice_round_trips_by_order_with_valid_ids() {
        let env = parse(
            "qwen3:4b",
            &response(two_calls((json!("call_a"), json!("call_b"))), "stop"),
        )
        .unwrap();
        assert_eq!(env.stop, StopReason::ToolUse);
        assert_eq!(
            env.tool_calls
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            ["ollama-0", "ollama-1"]
        );
        assert_eq!(env.tool_calls[1].arguments, r#"{"table":"customers"}"#);
        assert_eq!(
            env.usage,
            Some(Usage {
                input_tokens: 152,
                output_tokens: 729
            })
        );
        let turns = vec![
            Turn::User("q".into()),
            Turn::Assistant(env.clone()),
            Turn::ToolResults(vec![result(0, "300", false), result(1, "boom", true)]),
        ];
        let tools = [tool()];
        let body = body(&request(&turns, &tools, true), 16384).unwrap();
        assert_eq!(body["truncate"], json!(false));
        assert_eq!(body["shift"], json!(false));
        assert_eq!(body["stream"], json!(false));
        assert_eq!(
            body["options"],
            json!({"num_ctx": 16384, "num_predict": 1000})
        );
        assert!(body.get("think").is_none());
        let messages = body["messages"].as_array().unwrap();
        // Verbatim replay: thinking, native ids and unknown fields included.
        assert_eq!(messages[2], env.raw);
        assert_eq!(messages[2]["thinking"], json!("private reasoning"));
        assert_eq!(messages[2]["x_future_field"], json!({"kept": true}));
        assert_eq!(
            messages[3],
            json!({"role": "tool", "tool_name": "get_row_count", "content": "300", "tool_call_id": "call_a"})
        );
        assert_eq!(messages[4]["content"], json!("ERROR: boom"));
        assert_eq!(messages[4]["tool_call_id"], json!("call_b"));
        assert_eq!(body["tools"][0]["function"]["name"], json!("get_row_count"));
        // Internal ids never leave the run.
        assert!(!body.to_string().contains("ollama-"));
    }

    #[test]
    fn results_carry_no_id_unless_every_call_has_a_unique_one() {
        for ids in [
            (Value::Null, json!("call_b")),
            (json!(""), json!("call_b")),
            (json!("dup"), json!("dup")),
            (json!("bad id !"), Value::Null),
        ] {
            let mut calls = two_calls(ids.clone());
            if ids.1.is_null() {
                calls[1].as_object_mut().unwrap().remove("id");
            }
            let env = parse("qwen3:4b", &response(calls, "stop")).unwrap();
            let turns = vec![
                Turn::User("q".into()),
                Turn::Assistant(env),
                Turn::ToolResults(vec![result(0, "300", false), result(1, "50", false)]),
            ];
            let body = body(&request(&turns, &[], true), 4096).unwrap();
            for message in &body["messages"].as_array().unwrap()[3..] {
                assert!(message.get("tool_call_id").is_none(), "{ids:?}: {message}");
                assert_eq!(message["tool_name"], json!("get_row_count"));
            }
        }
        // A string with spaces is still a usable id when all are present and unique.
        let env = parse(
            "qwen3:4b",
            &response(two_calls((json!("bad id !"), json!("ok"))), "stop"),
        )
        .unwrap();
        let turns = vec![
            Turn::User("q".into()),
            Turn::Assistant(env),
            Turn::ToolResults(vec![result(0, "1", false), result(1, "2", false)]),
        ];
        let body = body(&request(&turns, &[], true), 4096).unwrap();
        assert_eq!(body["messages"][3]["tool_call_id"], json!("bad id !"));
    }

    #[test]
    fn unreplayable_ids_and_malformed_responses_are_rejected_before_any_tool_runs() {
        for id in [
            json!(123),
            json!({"x": 1}),
            json!([1]),
            json!(true),
            json!("x".repeat(257)),
        ] {
            let calls = two_calls((id.clone(), json!("ok")));
            assert_eq!(
                parse("m", &response(calls, "stop")).unwrap_err(),
                RESPONSE_INVALID,
                "{id}"
            );
        }
        let ok_id = json!("x".repeat(256));
        assert!(parse("m", &response(two_calls((ok_id, json!("y"))), "stop")).is_ok());

        let bad = [
            json!({"done": false, "done_reason": "stop", "message": {"role": "assistant", "content": ""}}),
            json!({"done": true, "message": {"role": "assistant", "content": ""}}),
            json!({"done": true, "done_reason": "load", "message": {"role": "assistant", "content": ""}}),
            json!({"done": true, "done_reason": "stop", "message": {"role": "user", "content": ""}}),
            json!({"done": true, "done_reason": "stop", "message": {"role": "assistant"}}),
            json!({"done": true, "done_reason": "stop", "message": {"role": "assistant", "content": 5}}),
            json!({"done": true, "done_reason": "stop", "message": {"role": "assistant", "content": "", "thinking": 1}}),
            json!({"done": true, "done_reason": "stop", "message": {"role": "assistant", "content": "", "tool_calls": {}}}),
            json!({"done": true, "done_reason": "stop", "message": {"role": "assistant", "content": "", "tool_calls": [1]}}),
            json!({"done": true, "done_reason": "stop", "message": {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "", "arguments": {}}}]}}),
            json!({"done": true, "done_reason": "stop", "message": {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "f", "arguments": "{}"}}]}}),
            json!({"done": true, "done_reason": "stop", "message": {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "f"}}]}}),
            json!([]),
        ];
        for value in bad {
            assert_eq!(parse("m", &value).unwrap_err(), RESPONSE_INVALID, "{value}");
        }
    }

    #[test]
    fn stop_reasons() {
        let plain = |reason: &str, content: &str| json!({"done": true, "done_reason": reason, "message": {"role": "assistant", "content": content}});
        assert_eq!(
            parse("m", &plain("stop", "hi")).unwrap().stop,
            StopReason::EndTurn
        );
        let length = parse("m", &plain("length", "partial")).unwrap();
        assert_eq!(length.stop, StopReason::MaxTokens);
        assert_eq!(length.text, "partial");
        // Calls in a truncated response are parsed but never runnable.
        let cut = parse(
            "m",
            &response(two_calls((json!("a"), json!("b"))), "length"),
        )
        .unwrap();
        assert_eq!(cut.stop, StopReason::MaxTokens);
        assert!(!cut.tool_calls_runnable());
        // `null` or absent tool_calls mean none.
        let none = json!({"done": true, "done_reason": "stop", "message": {"role": "assistant", "content": "x", "tool_calls": null}});
        assert!(parse("m", &none).unwrap().tool_calls.is_empty());
    }

    #[test]
    fn the_final_step_omits_tools_and_still_replays_calls() {
        let env = parse(
            "qwen3:4b",
            &response(two_calls((json!("a"), json!("b"))), "stop"),
        )
        .unwrap();
        let turns = vec![
            Turn::User("q".into()),
            Turn::Assistant(env),
            Turn::ToolResults(vec![result(0, "1", false), result(1, "2", false)]),
        ];
        let tools = [tool()];
        let body = body(&request(&turns, &tools, false), 8192).unwrap();
        assert!(body.get("tools").is_none());
        assert_eq!(
            body["messages"][2]["tool_calls"].as_array().unwrap().len(),
            2
        );
    }

    #[test]
    fn two_batches_keep_their_own_correlation() {
        let first = parse(
            "qwen3:4b",
            &response(two_calls((json!("a"), json!("b"))), "stop"),
        )
        .unwrap();
        let second = parse(
            "qwen3:4b",
            &response(
                json!([{"function": {"name": "get_row_count", "arguments": {"table": "t"}}}]),
                "stop",
            ),
        )
        .unwrap();
        let turns = vec![
            Turn::User("q".into()),
            Turn::Assistant(first),
            Turn::ToolResults(vec![result(0, "1", false), result(1, "2", false)]),
            Turn::Assistant(second),
            Turn::ToolResults(vec![result(0, "3", false)]),
        ];
        let body = body(&request(&turns, &[], true), 8192).unwrap();
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages[3]["tool_call_id"], json!("a"));
        assert_eq!(messages[6]["content"], json!("3"));
        assert!(
            messages[6].get("tool_call_id").is_none(),
            "second batch has no ids"
        );
        // A result count that does not match its batch is never sent.
        let broken = vec![
            Turn::User("q".into()),
            Turn::Assistant(
                parse(
                    "qwen3:4b",
                    &response(two_calls((json!("a"), json!("b"))), "stop"),
                )
                .unwrap(),
            ),
            Turn::ToolResults(vec![result(0, "1", false)]),
        ];
        assert_eq!(
            super::body(&request(&broken, &[], true), 8192).unwrap_err(),
            RESPONSE_INVALID
        );
    }

    #[test]
    fn replay_only_to_the_same_model() {
        let env = parse(
            "qwen3:4b",
            &response(two_calls((json!("a"), json!("b"))), "stop"),
        )
        .unwrap();
        let turns = vec![Turn::User("q".into()), Turn::Assistant(env)];
        let mut other = request(&turns, &[], true);
        other.model = "llama3";
        assert_eq!(body(&other, 4096).unwrap_err(), "AI_AGENT_REPLAY_MISMATCH");
    }
}
