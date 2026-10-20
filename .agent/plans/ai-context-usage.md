# AI Agent — Context Usage, Context Budget and Ollama Context Size

## Status

DRAFT

## Task

- **Split 2026-10-16** (user: "tách plan, viết revision 3 cho plan 1 trước"). The Ollama native wire and context size (Revision 2 R-A, with Codex round-2 B1–B4, the Ollama part of B6, and S2/S3 for Ollama) moved to **Plan 1, `.agent/plans/ollama-native-context.md`**. This file becomes **Plan 2**: the context meter, usage accounting and admission control (R-B, R-C; Codex round-2 B5, B6 for Gemini and metadata, B7, S1, S3 and S4). It is revised after Plan 1 and depends on it.

- ID: ai-context-usage
- Requested 2026-10-16 by the user:
  - show how much of the model's context a chat uses, like Claude Code's context meter (ring + breakdown);
  - fold in the Ollama context problem found in the R7 smoke ("commit phần trước rồi viết plan đi").
- Builds on the AI agent (`.agent/plans/ai-agent.md`, Phases 1–3).
- Branch: `feat/ai-context-usage` from `feat/ai-agent` (needs the agent code; rebase onto `main` once `feat/ai-agent` merges).
- Workflow: Codex plan critique → user approval → implement per phase → Codex review. Phase 3 changes the provider wire for Ollama, so it also gets a Claude `/security-review`.
- Decisions 2026-10-16 (user): **D1a, D2a, D3a, D4** ("chốt D1a, D2a, D3a, D4").
- Codex plan review round 1: NOT READY (8 blockers). **Revision 2** below answers them (user: "viết revision 2 rồi gọi codex review lại đi"); awaiting the Codex re-review.
- No commit/push unless requested.

## Background (inspection 2026-10-16)

### Limits today: bytes, not tokens

| Part                   | Limit                                  | Where                                    |
| ---------------------- | -------------------------------------- | ---------------------------------------- |
| question               | 16 KB                                  | `run.rs` `MAX_QUESTION_BYTES`            |
| history sent           | 12 messages, ≤ 2 KB each, ≤ 8 KB total | `agent/mod.rs`                           |
| editor SQL             | 8 KB                                   | `agent/mod.rs`                           |
| composed first message | 40 KB                                  | `MAX_PROMPT_BYTES`                       |
| each tool result       | 64 KB                                  | `MAX_TOOL_RESULT_BYTES`                  |
| steps / tool calls     | 8 / 16                                 | `MAX_STEPS`, `MAX_TOOL_CALLS`            |
| output                 | 4096 per step, 32 000 per turn         | `STEP_MAX_TOKENS`, `OUTPUT_TOKEN_BUDGET` |

- **No total transcript limit.** Tool results accumulate across steps, so the worst case is ≈ 40 KB + 16 × 64 KB ≈ 1 MB (≈ 250k tokens) on the last step. That can exceed a 128k window and make the provider reject the request.
- Each question starts a fresh transcript. History is clipped, so context does not grow across a chat. The meter is therefore per turn and grows step by step.

### Usage reported today

- Every wire parses provider usage into `protocol::Usage { input_tokens, output_tokens }` (`wire.rs` `usage_from`).
- The coordinator only **sums** it, and `AgentEvent::Done { input_tokens, output_tokens }` carries the totals. The size of the **latest request**, which is what fills the context, is not reported.
- The legacy assistant (`ai_chat_complete`) returns only text and no usage.

### Context window per provider

- **Ollama.** Verified against 0.40.4 (2026-10-16):
  - `/api/show` → `model_info["<arch>.context_length"]`, the trained maximum (qwen3:4b: 262144);
  - `/api/ps` → `models[].context_length`, the size the model actually runs with: **4096 by default**, or `OLLAMA_CONTEXT_LENGTH`.
  - Probe results:
    - `/v1/chat/completions` (the wire the app uses) **ignores** `num_ctx`, both as `options.num_ctx` and at top level; the model stays at 4096;
    - native `/api/chat` with `options.num_ctx: 16384` loads the model at 16384;
    - a later `/v1` request reloads it at 4096.
  - In the R7 smoke the Ollama log showed `truncated = 1`: agent prompts were silently cut, and the model looped until `AI_AGENT_DEADLINE`.
- **Gemini:** `GET /v1beta/models/{model}` returns `inputTokenLimit` and `outputTokenLimit`.
- **Anthropic:** unknown whether the Models API returns a context size (Phase 0).
- **OpenAI, Groq:** the models API returns no context size, so a static table is needed.

## Goal And Visible Result

- **The ring.** A small ring next to the model name in the AI panel, shown while the agent is on. It fills with the context used by the latest request of the current turn.
  - Hover: "12.3k / 16k tokens (77%)".
  - Click: a breakdown like the screenshot the user shared: System prompt, Tools, Question & history, Tool results, Model turns, Reserved for answer, Free space. Totals come from the provider; the split is estimated and marked "~".
  - Colors: neutral below 70%, amber from 70%, red from 90%.
  - Unknown window: tokens only, no percentage.
- **The budget.** A turn never sends a request that cannot fit. When the transcript nears the window, older tool results are shortened. If it still does not fit, the agent answers with what it has.
- **Ollama.** Agent requests run with a usable context (no silent truncation). If truncation is still detected, the UI says so and how to fix it.

## Decisions

- **D1 Ollama context.** **(a)** (user, 2026-10-16).
  - (a) **Recommended:** move Ollama's agent wire from OpenAI-compatible `/v1` to native `/api/chat`, which supports tools, and send `options.num_ctx`. Value: `min(trained max, setting)`, with the default setting 16384 and a per-provider "Context size" field in AI settings (Ollama only). This is a new wire with its own replay fixtures, like the Phase 1 adapters.
  - (b) Keep `/v1`. Detect truncation, warn, and document `OLLAMA_CONTEXT_LENGTH` in the Ollama setup copy. Small, but users must restart Ollama with an env var, and other clients can reload the model at 4096 at any time (probe above).
- **D2 When the transcript does not fit.** **(a)** (user, 2026-10-16).
  - (a) **Recommended:** first shorten the oldest tool results in place to `[result shortened to fit the context: N KB]`, keeping every tool call paired with its result as providers require. If it still does not fit, run the final answer step without tools ("answer with what you have").
  - (b) Stop the turn with `AI_AGENT_CONTEXT_FULL` and a message.
- **D3 Window sizes for OpenAI / Anthropic / Groq.** **(a)** (user, 2026-10-16).
  - (a) **Recommended:** one static table in one Rust module, keyed by model id prefix, with conservative values. Unknown models show tokens only.
  - (b) A user-entered "Context size" per provider for every kind.
- **D4 Legacy assistant.** **No meter** (user, 2026-10-16). It sends a fixed small prompt (schema ≤ 5 600 chars, 6 messages), and its wire returns no usage.

## Requirements

### R1 Per-request usage events (backend)

- A new `AgentEvent::Context { step, input_tokens, exact, window, breakdown }` is emitted after each model step:
  - `input_tokens`: provider-reported prompt tokens of **that** request; `exact: false` when the provider gave none (then estimated, R2);
  - `window`: from R3, or `null`;
  - `breakdown`: estimated tokens per category (R2).
- `Done` stays as is (turn totals).
- Labels are fixed; the event carries numbers only, no prompt text (R6 of ai-agent).

### R2 Breakdown estimate

- The coordinator measures the bytes of each part of the request it sends:
  - system prompt;
  - tool specs (serialized);
  - first user message, with `compose_question` reporting the byte split between question, history, context line and editor SQL;
  - tool results;
  - assistant turns (including replayed provider envelopes);
  - reserved output (`max_tokens` of the next step).
- Each part's tokens = provider `input_tokens` × part bytes / total bytes. Without usage, ≈ bytes / 4 (marked estimated). Reserved output is the step's `max_tokens`, not estimated.
- Pure function, unit-tested with fixed inputs.

### R3 Context window resolution

- A new `ai::context_window` module, a narrow port: `window(config, model) -> Option<Window { tokens, source }>`, where `source` is one of `provider | table | setting`.
  - **Ollama:** the effective window is `num_ctx` sent (D1a); otherwise `/api/ps` `context_length` once the model is loaded, then `/api/show` trained max as an upper bound.
  - **Gemini:** `models.get` → `inputTokenLimit`.
  - **Anthropic:** Phase 0 decides between the Models API field and the D3 table.
  - **OpenAI, Groq:** the D3 table.
- Cached per (provider id, model, provider generation), reusing the `CapabilityCache` invalidation (save/delete bumps the generation), with a 24 h TTL. Lookups have a short timeout and never block a run: unknown → `None`.
- Network policy: same host/URL policy and key handling as the existing provider calls (`ai::transport`). No new hosts.

### R4 Transcript budget (coordinator)

- Before each step: `needed = estimated prompt tokens + max_tokens`. Prompt tokens come from the last exact `input_tokens` plus an estimate of the bytes added since, so the measurement stays accurate.
- If `needed > 0.9 × window`, apply D2.
- Without a known window, use a conservative byte cap on the transcript, e.g. 256 KB, so a 1 MB worst case is impossible.
- **Ollama truncation signal:** if reported `input_tokens ≥ window − 64`, set `truncated_suspected` in the `Context` event (Ollama reports the truncated count).
- Tests:
  - shortening keeps call/result pairing;
  - the final answer step runs without tools;
  - the byte cap applies without a window;
  - the truncation flag is set;
  - existing budget, deadline and cancel tests stay green.

### R5 Ollama context (D1)

- **D1a:**
  - a new `Wire::OllamaNative` for `/api/chat`:
    - request: `messages` with `tool_calls` (arguments as an object), `role: "tool"` results, `tools`, `options.num_ctx`, `options.num_predict` = step `max_tokens`, `stream: false`;
    - response: `message.content`, `message.tool_calls`, `done_reason`, `prompt_eval_count` / `eval_count` → `Usage`;
    - replay of thinking content as returned.
  - `wire_for(Ollama)` → native. Model listing and the legacy chat stay as today.
  - Fixtures as in Phase 1:
    - parallel tool calls, tool result replay, missing/invalid fields fail closed;
    - `done_reason: "length"` → `MaxTokens`.
  - A live check via `live_agent_smoke` / `live_smoke.rs` with the default server context (no env var).
- **D1b:** setup copy and a warning when `truncated_suspected` is set.

### R6 UI

- `ContextMeter` component (ring plus popover breakdown), placed in the panel header next to the model selector. It is fed by `Context` events through `runAgentTurn` (`onContext`).
  - It keeps the latest values per chat scope in memory only (not persisted; numbers only).
  - It resets on a new question. After the turn ends, it shows the final values in a lighter style.
- **Ollama** with `truncated_suspected`: an amber notice: "The model's context is full and Ollama cut part of the request." It includes the fix for D1b, or the context size setting for D1a.
- Accessible: `role="meter"`, `aria-valuenow/max`, and text in the popover.
- Tests:
  - rendering at 0 / 50 / 75 / 95 % and unknown window;
  - the breakdown sums to the total;
  - reset on a new question;
  - the Ollama notice.

## Phases

- **Phase 0 — Probes (no app code).**
  1. Anthropic: does the Models API return a context size?
  2. Gemini `inputTokenLimit` for the models in the app's suggestions.
  3. Ollama native `/api/chat`:
     - tool-call request/response shapes with `qwen3:4b`;
     - `prompt_eval_count` when truncated vs not;
     - whether `num_ctx` persists across requests.

  Record results here.

- **Phase 1 — R1 + R2 + R3 + R6:** usage events, the estimate, window resolution and the meter. No behavior change in runs.
- **Phase 2 — R4:** the transcript budget.
- **Phase 3 — R5:** Ollama context (D1).

## Files

- Backend:
  - `src-tauri/src/ai/agent/run.rs`: the event, per-step measurement, budget;
  - `src-tauri/src/ai/agent/mod.rs`: `compose_question` split;
  - new `src-tauri/src/ai/context_window.rs`;
  - `src-tauri/src/ai/agent/wire.rs` (+ a new Ollama native wire module in Phase 3);
  - `src-tauri/src/commands/ai_agent.rs`: window lookup at run start.
- Frontend:
  - `src/lib/tauri/aiAgent.ts`: event type;
  - `src/lib/ai-assistant/agent.ts`: `onContext`;
  - new `src/components/ai-assistant/ContextMeter.tsx`, plus a test;
  - the panel header (`AiAssistantPanel.tsx`);
  - `AiAssistantSettingsDialog.tsx`: the Ollama context size for D1a.

## Verification

- `cargo test`, `cargo clippy` (both flavors), `npm run build`, `npm run test:run`, prettier.
- Live:
  - `live_smoke.rs` against Ollama with the **default** server context: no `truncated = 1` in the Ollama log (D1a), and the `Context` events report a window matching `/api/ps`;
  - cloud providers via the user's keys, per `ai-agent-smoke-checklist.md` plus the meter.
- UI: the ring and the popover in the built-in browser harness and in the desktop app.

## Risks

- Breakdown numbers are estimates (provider tokenizers differ). Only the total is exact, and the UI says so.
- Static window tables go stale. They should be conservative and fall back to tokens-only for unknown models.
- A new Ollama wire repeats the Phase 1 replay risks (tool-call ids, thinking). Fixtures and the live check mitigate this.
- Shortening tool results can lower answer quality. It only applies near the limit, and the meter makes it visible.
- Extra provider calls for window lookups are cached and never on the run's critical path.

## Revision 2 (Claude, 2026-10-16): replaces "Requirements", "Phases", "Files" and "Verification" above

Answers the Codex Plan Review (8 blockers, 4 should-fix) below. D1a/D2a/D3a/D4 unchanged. Anthropic windows come from the D3a table; the Models API is not needed.

### P0 Probe evidence (Ollama 0.40.4, `qwen3:4b`, local, synthetic prompts only)

| Probe                                                                                                                                             | Result                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/chat/completions` with `options.num_ctx` / top-level `num_ctx`                                                                               | ignored; `/api/ps` stays 4096                                                                                                                                           |
| `/api/chat` with `options.num_ctx: 16384`                                                                                                         | loaded at 16384; a later `/v1` call reloads at 4096                                                                                                                     |
| `/api/chat`, prompt ≈ 6000 tokens, `num_ctx: 4096`, **`truncate: false`**                                                                         | **HTTP error:** `request (6012 tokens) exceeds the available context size (4096 tokens), try increasing it`                                                             |
| Same, without `truncate`                                                                                                                          | silently truncated: `done_reason: "length"`, `prompt_eval_count: 2050` (**below** the window, so a "near full" heuristic would miss it)                                 |
| `/api/chat` with tools, `think: true`                                                                                                             | `done: true`, `done_reason: "stop"`, `message.tool_calls: [{id: "call_…", function: {index, name, arguments: {object}}}]`, separate `message.thinking`, empty `content` |
| Final step: replay the original assistant message (thinking + calls) + `role: "tool"` results (`tool_name`, `tool_call_id`), **no `tools` field** | answered from the results, `tool_calls: null`, `done_reason: "stop"`                                                                                                    |
| `/api/show`                                                                                                                                       | `model_info["qwen3.context_length"] = 262144` (trained max)                                                                                                             |

### Phase order (blocker 6)

1. **Phase A — Ollama native wire and context size (R-A).** Lands first, so no later phase shows or budgets against an Ollama size that is not enforced.
2. **Phase B — accounting and meter (R-B):** exact per-request usage, limits, the context event and the UI. Display only; no change to what is sent.
3. **Phase C — admission control (R-C):** shortening, the final-request check, the hard byte cap.

Each phase has its own Codex review and recorded gate evidence before the next starts.

### R-A Ollama native `/api/chat` (blockers 4, 5, 6, 8)

**A1 Destination**

- `ollama_native_base(config)`: start from the validated `base_url(config)`. Only a path that is exactly `/v1` or `/v1/` (after an optional proxy prefix `P`) maps to `P` + `/api/chat`. Scheme, host and port must equal the validated base; otherwise native is not derivable. Saved configs are never rewritten.
- Model listing and the legacy chat keep their current `/v1` paths.
- Tests: default `http://127.0.0.1:11434/v1`, trailing slash, `https://proxy/x/v1`, base without `/v1`, ambiguous bases (`/v1/extra`, query/fragment), and that the origin never changes.

**A2 Is it Ollama?**

- Before the first native run for a destination: `GET <native base>/api/version`, with no conversation data, a 2 s timeout and the existing transport policy (redirect block, proxy avoidance, body cap, code-only errors).
- A JSON `{version}` response → native. Anything else (404, auth, timeout, non-JSON, or a `local_openai_compatible` server such as LM Studio) → the run uses today's `/v1` wire, with the context size **unknown** (R-B).
- Cached per destination and provider generation (A6).
- Decided **before** the run starts and fixed for the run: no switching endpoints mid-run, and no resending a transcript to another endpoint.

**A3 Request**

- Fields:
  - `model`;
  - `messages` (system, user, assistant, tool);
  - `tools` (only when tools may be called, A5);
  - `stream: false`;
  - `think`: absent unless the model returned thinking (the server's default);
  - **`truncate: false`**;
  - `options.num_ctx` = the run's snapshotted size (A4);
  - `options.num_predict` = the step's effective `max_tokens`.
- `keep_alive` uses the server default.

**A4 Context size setting**

- New `context_size: Option<u32>` on `AiProviderConfig`, plus TS types, provider-store validation, settings UI (Ollama only, "Context size (tokens)"), and serde default `None`. Meaningful only for `Ollama`; ignored elsewhere.
- Bounds 2 048 ..= 262 144, validated in the provider store and at the IPC boundary (direct IPC values outside the bounds are rejected). Default 16 384.
- At run start, `num_ctx = min(setting or default, trained max)`. The trained max comes from the cached `/api/show` lookup (A6); on a cache miss the setting is used unclamped, and the background lookup fills the cache for later runs.
- The value is snapshotted once per run and sent on **every** step. Saving settings affects later runs only.

**A5 Replay and stop contract**

- **IDs:**
  - each call gets an internal id `ollama:{step}:{index}`, used by `protocol::ToolCall.id` and the coordinator's duplicate check;
  - a native `id`, if present, is kept in the raw envelope only;
  - the raw assistant message is replayed **verbatim** (content, `thinking`, `tool_calls` with native ids and order), never rebuilt from parsed fields;
  - tool results are sent as `{role: "tool", tool_name, tool_call_id?: native id when present, content}`, in the original call order.
- **Stop:**
  - a response must have `done: true`;
  - `done_reason: "stop"` with complete calls → `ToolUse`; `"stop"` without calls → `EndTurn`;
  - `"length"` → `MaxTokens`, and calls in it are **never** executed;
  - a missing, unknown or incomplete reason, or malformed calls (non-object arguments, missing name), → `AI_AGENT_RESPONSE_INVALID`;
  - an HTTP error carrying the context-size message → `AI_AGENT_CONTEXT_FULL` (code only).
- **Final step:** the request **omits `tools`** (P0 shows replay works without declarations). Any `tool_calls` in a final response are ignored and not executed, as the coordinator already does when finalizing.
- **Thinking:** never shown as the answer and never persisted.
- **Usage:** `prompt_eval_count` and `eval_count`, with their presence tracked separately (R-B1).
- **Fixtures:**
  - two calls to the same function with different arguments;
  - multiple batches;
  - missing ids;
  - duplicate or malformed native ids (ignored: the internal ids decide);
  - object arguments;
  - error results;
  - shortened results (R-C);
  - mixed content, thinking and calls;
  - unknown fields preserved in replay;
  - `length` with calls;
  - `done: false`;
  - final responses with calls;
  - the context-full error.
- Live gate: `live_smoke.rs` with the **default server context** (no env var). Pass when every case runs with no context error and `/api/ps` shows the snapshotted `num_ctx`.

**A6 Caches (blocker 7, Ollama part)**

- New `OllamaProbeCache` (not `CapabilityCache`):
  - key (provider id, provider generation, destination origin+prefix) → `is_ollama` + version;
  - key (…, model) → trained max.
- The generation is read in `snapshot_for_run` **under `ai_providers_lock`**, together with the config.
- Save/delete call `forget_provider` on it as on `CapabilityCache`. A completion whose generation is stale is dropped.
- TTL: success 24 h, failure 10 min. At most 256 entries, with expired entries pruned on insert.
- Concurrent misses are deduplicated (an in-flight set). Lookups never run under the provider mutex.
- **Startup latency:** on a miss, A2 runs before the first run (2 s cap, local server). The trained max lookup runs in the background and never blocks.

**A7 Consent**

- `consent::endpoint_fingerprint` hashes the saved config (kind, base URL, host, sub path), which is unchanged. A grant therefore covers the deterministic same-origin translation `/v1` → `/api/chat` on the same server, and the plan says so.
- Test: native base derivation cannot change scheme/host/port, so it cannot select another destination under an existing grant.

### R-B Accounting and meter (blockers 3, 6; should-fix 1–3)

**B1 Usage with presence (blocker 3)**

- `protocol::Usage` becomes `{ input_tokens: Option<u64>, output_tokens: Option<u64> }`, parsed independently.
- The coordinator's charging is unchanged: missing output is charged at the effective allowance. `Done` stays cumulative.
- Normalization:
  - OpenAI/Groq/Ollama `/v1`: input = `prompt_tokens` (already includes cached tokens; `prompt_tokens_details` is not added again);
  - Anthropic: input = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (each optional);
  - Gemini: input = `promptTokenCount` (+ `toolUsePromptTokenCount` if present); output keeps the existing candidate+thoughts sum;
  - Ollama native: `prompt_eval_count` / `eval_count`.
- Fixtures per wire: complete, input only, output only, malformed, cached counters.

**B2 Limits**

- New `ai::context_limits`, a pure function `limits(kind, model, run snapshot) -> Limits { input: Option<u64>, output: Option<u64>, combined: Option<u64>, source: Table | Probe | Setting | Unknown }`.
  - **Ollama native:** `combined = num_ctx` sent (Setting). Ollama via `/v1`: Unknown.
  - **D3a table:**
    - one module, entries with documented meaning (input, output and/or combined);
    - matching on exact model ids or an explicit family prefix with a boundary (`gpt-4o` matches `gpt-4o-2024-08-06`, not `gpt-4o5`);
    - longest match wins; unknown → Unknown.
    - Covers OpenAI, Anthropic and Groq models in the app's suggestions.
  - **Gemini:** `models.get` → `inputTokenLimit` / `outputTokenLimit`, cached like A6 (key + generation, background, Unknown on miss). Only the model id is sent.
- Constraints checked, each only when known: prompt ≤ input; max_tokens ≤ output; prompt + max_tokens ≤ combined.

**B3 `Context` event (should-fix 1, 2)**

- A fixed DTO:

  ```text
  Context {
    step: u32,
    prompt_tokens: Option<u64>,
    prompt_exact: bool,
    output_reserve: u32,
    input_limit: Option<u64>, output_limit: Option<u64>, combined_limit: Option<u64>,
    parts: { system, tools, question, history, context, editor_sql, tool_results, model_turns }: u64,
    shortened_results: u32,
  }
  ```

  - Numbers and booleans only. No labels, model/provider/endpoint ids, names, arguments or text.
  - `source` stays internal.

- **Meter equation:**
  - `sum(parts) = prompt_tokens`. When the count is not exact, `prompt_tokens` is the R-C1 estimate and `prompt_exact = false`;
  - parts are split by serialized bytes of each category, with largest-remainder rounding, zero-safe, saturating, and labelled "illustrative" in the UI;
  - `output_reserve` = the **same request's** effective `max_tokens`;
  - free = `combined − prompt − reserve`, or `input − prompt` when only an input limit is known.
- Emitted after each response with that request's numbers, and also when a request fails with a context error (`prompt_exact = false`).
- Before the first response: no event, and the UI shows "measuring".
- `compose_question` returns the byte split of its sections (question, history, context line, editor SQL), including delimiters, so the parts add up.
- Privacy tests:
  - Rust serialization and the TS channel, with sentinel strings in the question, table names, editor SQL, tool arguments/results, thinking and error bodies;
  - assert their absence from `Context`, logs, analytics and meter state.

**B4 UI (should-fix 3)**

- `ContextMeter`, rendered by `AiAssistantChatArea.tsx` next to the model controls and fed from `hooks/useAiAssistantSubmit.ts` via a new `onContext` on `runAgentTurn`.
- Lifecycle:
  - `runAgentTurn` drops every callback after it settles, or after abort or a newer request (`requestSeqRef`);
  - state is keyed by chat scope + session id + run id + the run's provider/model snapshot;
  - it is cleared on a new question, legacy fallback (D4), session switch, purge/revoke, or provider/model change;
  - memory only, at most 32 scopes;
  - never written to `ChatMessage`, localStorage, share or export.
- Accessibility:
  - with a known limit: `role="meter"` with `aria-valuenow/max`;
  - unknown: text only ("12.3k tokens");
  - the popover opens from the keyboard (Enter/Space) and closes with Escape; it does not depend on hover.
- Thresholds: neutral below 70%, amber 70–89%, red ≥ 90%.
- **Ollama:** on `AI_AGENT_CONTEXT_FULL`, show "The request did not fit the model's context (N tokens). Increase Context size in AI settings." (`truncate: false` makes this exact.) Via `/v1`: "Context size unknown". No truncation guess anywhere.
- Tests:
  - 0/50/75/95%, unknown limit, input-only limit;
  - the parts sum;
  - late events after abort;
  - same-scope session switch;
  - two tabs;
  - fallback before tools;
  - failed start;
  - provider edit;
  - keyboard and ARIA.

### R-C Admission control (blockers 1, 2)

**C1 Estimates: best effort, stated as such**

The plan no longer promises that a request "never exceeds". It promises the following.

- **Display estimate:**
  - after a response with an exact count, `prompt ≈ exact + (bytes added since) × observed tokens-per-byte of this run`;
  - before any exact count, the bytes of the serialized request divided by 3 (deliberately conservative for code and Unicode);
  - shortening resets the baseline: estimate = `exact × (bytes now / bytes then)`, marked not exact.
- **Admission estimate** (used to decide): the display estimate × 1.25, plus 16 tokens per message for framing, saturating.

**C2 Hard local byte cap for every provider**

- The serialized request (system, specs, all turns including raw replay envelopes, results) must stay ≤ `MAX_REQUEST_BYTES = 512 KiB`, whatever the window. With an unknown window this is the only limit.
- Placeholders and shortening count toward it.
- A single response envelope is already capped at 2 MiB by transport. If one replayed envelope alone exceeds the cap, the run stops: `AI_AGENT_CONTEXT_FULL`.

**C3 Algorithm before every send (including the final request)**

1. Build the actual candidate request: the same system or finalize instruction, the declarations the wire will send (none on Ollama native finals), and the effective `max_tokens` including adapter floors.
2. If it fits (C2 and every known B2 limit, using the admission estimate) → send.
3. Else shorten eligible results **oldest first**, one at a time:
   - replace a result's **content** with `[result shortened to fit the context: N KB]`;
   - never drop or reorder a call or result;
   - never edit raw assistant envelopes, thinking/signatures, ids, Anthropic grouping or Gemini `functionResponse` names and ids;
   - error and denied results stay as they are (already short).

   Recompute after each change.

4. If no eligible result is left and it still does not fit:
   - not yet finalizing → switch to the final request (step 1 with the finalize instruction) and recheck;
   - already final → stop locally with `AI_AGENT_CONTEXT_FULL`.

   Never send it. Never a ninth step. Never a request after cancel/deadline. No tool re-execution, no legacy fallback.

5. `gate.check()` runs immediately before every actual send, including the final one.
6. A provider context error (Ollama message, OpenAI `context_length_exceeded`, Anthropic/Gemini equivalents, mapped by code only) → `AI_AGENT_CONTEXT_FULL`, with no retry.

Shortening reduces what is sent. It never re-reads data or widens consent.

**C4 Tests**

- First-request overflow.
- Zero eligible results.
- An irreducible large question or replay envelope.
- Adapter floors (Anthropic/Groq).
- Output budget exhaustion.
- Repeated shortening across steps.
- Cancel/revoke during finalization.
- Token-dense Unicode and code inputs.
- A huge replay envelope.
- Serialized-request fixtures per wire proving pairing is preserved:
  - OpenAI `tool_call_id`;
  - Anthropic grouped `tool_result` order/ids/`is_error`, with thinking and signatures unchanged;
  - Gemini `functionResponse` names/ids/order, with `thoughtSignature` unchanged;
  - Ollama native order/`tool_name`.

  Each fixture covers multiple results per batch and denied or limit results.

### Phase gates (should-fix 4)

Each phase requires:

- `cargo test --locked` and `cargo test --locked --features app-store`;
- `cargo clippy --locked --all-targets` with and without `--features app-store`, with no new warnings;
- `npm run build`, `npm run test:run` and prettier;
- a Codex review at VERIFIED or better, with evidence recorded here, before the next phase starts.

| Phase | Additional gate                                                                                                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | Native fixtures (A5); endpoint, config and validation tests; the live Ollama smoke at the default server context; Claude `/security-review`.                                             |
| **B** | Per-wire usage fixtures; privacy sentinels; cache and generation race tests; UI lifecycle tests; the meter checked in the built-in browser harness and in the desktop app.               |
| **C** | Admission tests (C4); a live Ollama smoke with a forced small `context_size` (e.g. 4096) showing shortening and then a final answer, or `AI_AGENT_CONTEXT_FULL`, with no provider error. |

Live probes use only synthetic prompts, throwaway databases and the local Ollama. Cloud checks need the user's keys. The predecessor gates (cloud smoke, Touch ID) stay open and are not satisfied by this plan.

### Files (revised)

- **Backend:**
  - `ai/agent/run.rs` (C3, Context event);
  - `ai/agent/protocol.rs` (Usage presence);
  - `ai/agent/wire.rs` (usage normalization, `Wire::OllamaNative`) and a new `ai/agent/wire_ollama.rs`;
  - `ai/agent/model.rs` (destination selection);
  - `ai/agent/mod.rs` (`compose_question` split);
  - `ai/agent/start.rs` (snapshot of the generation and context size);
  - new `ai/context_limits.rs` (table + limits);
  - new `ai/ollama_probe.rs` (A2/A6 cache);
  - `ai/provider.rs` + the provider store (`context_size`);
  - `commands/ai_agent.rs` and the save/delete `forget_provider` call sites.
- **Frontend:**
  - `src/lib/tauri/aiAgent.ts`, `src/lib/tauri/ai.ts` (types);
  - `src/lib/ai-assistant/agent.ts` (`onContext`, settle guard);
  - `src/components/ai-assistant/hooks/useAiAssistantSubmit.ts`;
  - `src/components/ai-assistant/AiAssistantChatArea.tsx`;
  - new `ContextMeter.tsx` + test;
  - `AiAssistantSettingsDialog.tsx` (Ollama context size).

## Plan Review

Reviewed by Codex, 2026-10-16, against the working tree on `feat/ai-agent`. Read `AGENTS.md`, `.agent/WORKFLOW.md`, the predecessor plan (including Revision 2 and implementation evidence), and the named backend/frontend paths. **D1a, D2a, D3a and D4 remain settled.** This review requests implementation contracts, not new product decisions. Status stays `DRAFT`.

Read-only code inspection and current Context7 documentation only; no real provider requests, credentials, user databases, runtime logs, builds or tests accessed/run. Prior probe claims in Background were not independently reproduced. Existing predecessor release gates and accepted limitations remain in force.

### Blockers

1. **R4 / D2a — the final answer request can still overflow.** In `agent/run.rs::drive`, finalization adds `FINALIZE_INSTRUCTION`, retains tool declarations, and respects `min_output_tokens` (Anthropic and Groq floors), `FINAL_RESERVE_TOKENS`, remaining output budget and the eight-step limit. Removing permission to call tools does not remove these prompt bytes. Define a bounded algorithm: construct the actual candidate request, shorten only eligible result content in oldest-first order, recompute its budget, then construct and recheck the final candidate including instruction, declarations and effective output allowance. If even all result placeholders cannot fit (large initial question/history, arguments or immutable replay state), terminate locally with a fixed context-full code; **never send an oversized final request**. No extra ninth step, no model request after cancellation/deadline, no tool re-execution or legacy fallback after tools ran. Check the disclosure gate immediately before every actual send, including finalization. Test first-request overflow, zero eligible results, irreducible assistant/tool arguments, adapter floors, output budget exhaustion, repeated shortening, and cancellation/revocation during finalization.

2. **R2/R4 — byte heuristics cannot establish “a turn never sends a request that cannot fit.”** `last input_tokens + added bytes/4` undercounts some code, Unicode and token-dense content, misses request wrappers/tool schema expansion, and cannot handle deletions from shortening without a new baseline. A reported Ollama count may already describe a truncated prompt. Separate display estimates from conservative admission accounting. Define first-request estimation, missing/partial usage, model/wire-specific framing, post-shortening rebasing, rounding/saturating arithmetic and a fixed hard byte cap for **every** provider (including `AssistantEnvelope.raw`, call arguments, specs, system and result wrappers). Current responses can each be up to 2 MiB (`transport::CHAT_MAX_BYTES`); Background's ≈1 MiB is a tool-result scenario, not the full worst case. Set the unknown-window cap numerically rather than “e.g. 256 KB”; unknown context size cannot promise fit. Either substantiate a conservative bound/token counting policy without new undisclosed data transfers, or explicitly narrow the guarantee to best-effort estimation plus fail-closed local limits/provider error handling. Tests need token-dense/Unicode inputs, huge replay envelopes, shortening that reduces the baseline, and a prompt larger than the limit before any exact usage exists.

3. **R1/R3/R4 — one `window.tokens` conflates different limits and usage semantics.** Gemini exposes separate input and output limits; reserving output against `inputTokenLimit` does not make it a combined context window. Specify input limit, output limit and combined limit where applicable, and apply only relevant inequalities. D3a still permits one Rust table, but entries need documented meanings, output caps and bounded model matching (exact IDs/known family boundaries, longest match, no accidental `gpt-4` match for unrelated future IDs). `wire.rs::usage_from` currently returns `Some(Usage { input_tokens: 0, ... })` when output exists but input is absent, and discards valid input when output is absent. `Usage` therefore cannot determine R1's `exact` flag reliably. Track prompt-count presence independently from output charging; missing output must retain existing conservative charging. Normalize full provider input counts, including Anthropic cache creation/read counters when present, without double counting OpenAI cached-token details or Gemini thought/output counters. Preserve `Done` as cumulative accounting rather than replacing it with the latest request. Add per-wire partial/missing/malformed/cached usage fixtures and independent-limit/floor cases. Resolve Anthropic metadata availability in Phase 0 or explicitly choose the D3a table before approving its dependent phase; do not leave the source contract undefined.

4. **R5 — native Ollama needs a complete replay and finalization contract.** `protocol::ToolCall.id` and `drive` require distinct IDs in each batch; native documented calls may have no ID, and tool results use `tool_name`. Define adapter-generated internal IDs, deterministic call-order mapping, and preservation of native optional IDs/indexes without injecting internal IDs into the raw replay message. Test two calls to the **same function** with different arguments, multiple batches, missing IDs, duplicates/malformed supplied identities, object arguments, error results and shortened results. Replay the original assistant message including `thinking` and call ordering verbatim; never reconstruct it from `text`/parsed calls, expose thinking as the answer, or persist it. Require a complete nonstream response (`done: true`) and a valid stop reason; `stop` with complete calls maps to `ToolUse`, `length` must never execute calls, unknown/incomplete/malformed responses fail closed. Crucially, specify native behavior for `allow_tools: false`: existing adapters keep declarations and send protocol-specific disabling controls; the proposed native payload has no disabling rule. Prove a supported native control or omit declarations if replay permits, retain local prohibition on execution, and test unsolicited calls on finalization. Include mixed content/thinking/calls and unknown replay fields. New wire activation must wait for these fixtures plus supported-server evidence, not merely a successful single tool call.

5. **R3/R5 — endpoint derivation is currently wrong for `/api/chat`; compatibility and consent require explicit scope.** `provider::endpoint` concatenates onto the saved base, whose Ollama default is `http://127.0.0.1:11434/v1`; returning `api/chat` from `wire::build` would request `/v1/api/chat`. Define an agent-only native base derivation that preserves any configured proxy prefix, origin/port and URL validation, with tests for default `/v1`, trailing slash, custom prefixed URLs and ambiguous bases. Do not globally change saved base URLs: model listing and legacy chat must retain their current paths. Also, saved `local_openai_compatible` providers deserialize as `Ollama` (`provider.rs`); they are not proven native Ollama servers. Specify an explicit unsupported-native outcome/migration path without broadly treating 404, auth, timeout, context errors or generic 400 as tools-unsupported. No automatic resend of private tool transcripts to `/v1` or another destination. Keep transport redirect blocking, HTTP proxy avoidance, localhost pinning, body caps and code-only errors for metadata and native requests. Bind the derived destination to the existing consent endpoint fingerprint policy (`consent::endpoint_fingerprint`); explicitly document whether deterministic same-server path translation retains grants or invalidates them, and test that it cannot silently select another destination. This is a contract for D1a, not a request to revert it.

6. **R3 / phases — the UI can report an unenforced Ollama window before Phase 3.** Phase 1 must not display the future 16384 setting or the trained maximum as the current `/v1` runtime context; Phase 2 must not budget against either as if already enforced. `/api/show` describes an upper bound, not allocated context; `/api/ps` is transient runtime state and another client/legacy request can reload the model. Split stable model metadata from request-bound effective settings and observed runtime state. Before native activation, report unknown effective size unless current evidence supports it; do not cache `/api/ps` as effective for 24 hours. For D1a, define validated positive integer setting bounds/default/missing-metadata behavior, trained-limit clamping, resource/OOM handling, and immutable per-run snapshot of the actual `num_ctx` sent on **every** step. `AiProviderConfig` currently has no context field: add backend/TS types, provider-store validation/default compatibility, settings serialization and snapshot wiring to the file scope. Reject invalid direct IPC values; settings changes affect subsequent runs and cannot rewrite an active run's displayed denominator. Reorder native activation before relying on its setting, or explicitly gate those Phase 1/2 paths.

7. **R3 — cache reuse is not an implemented invalidation contract.** `CapabilityCache` contains boolean entries and private generation state; `start::snapshot_for_run` reads config/key/model/generation under `ai_providers_lock`, and provider save/delete call `forget_provider`. Specify a narrow shared generation/snapshot mechanism for window entries rather than overloading boolean capability records or reading a new generation after releasing the snapshot lock. Cache by resolved destination, provider identity/kind, model and generation (plus setting/wire identity where relevant); reject late writes after save/delete/recreate, prune/bound entries, define TTL expiry and failure/negative retry behavior. Model replacement/server restart can change metadata without a provider save: define refresh behavior and keep configured `num_ctx` authoritative per request rather than a stale runtime observation. “Lookup at run start,” “never block a run,” and cold-cache network discovery currently conflict. Choose bounded background discovery with unknown on miss, or explicitly allow bounded startup latency; own cancellation/timeouts/tasks and deduplicate concurrent misses without holding the provider mutex across I/O. Tests need cold cache, timeout, malformed/oversized metadata, save/delete races, setting/model/endpoint changes, stale completion, expiry and simultaneous runs.

8. **R4/R6 — the truncation notice asserts evidence the heuristic does not provide.** `input_tokens >= window - 64` means near capacity, not proof that Ollama cut a request; truncation can also yield a count below that threshold. Keep `truncated_suspected` explicitly heuristic and use “may have been shortened” copy unless a verified server signal proves truncation. Specify minimum supported server/version behavior and Phase 0 evidence with a synthetic known prompt; do not infer safety solely from absence of `truncated = 1` in logs. Current upstream request types document `truncate`/`shift` controls: investigate/version-gate these as possible fail-closed protection rather than assuming all deployed servers support them. A rejected request must remain code-only and cannot execute tools or silently downgrade. Test near-full-but-intact and shortened-below-threshold cases; do not mark truncated usage as an exact count of the original request.

### Should-fix (fold into requirements and acceptance tests)

1. **R1/R2/R6 — define one consistent meter equation.** Ring currently measures latest prompt, while breakdown includes reserved answer and free space; those cannot all sum to `input_tokens`. Define `sum(prompt categories) = latest prompt count`, reserve as the **same request's effective** output allowance (not an unknown next step), and free/overage separately against the applicable limit. Allocate integer remainders deterministically, handle zero bytes/counts and overflow, and label proportional byte splits as illustrative estimates (not tokenization measurements). Include serialized provider framing and first-message delimiters without double counting `raw` and parsed assistant fields. “Grows step by step” is not invariant after shortening. Specify behavior before the first response and after failed/cancelled turns, including whether the first failed request has no measured usage.

2. **R1/R6 — numeric-only context event needs a fixed DTO and privacy tests.** Use fixed named numeric categories plus booleans/nulls and the fixed event discriminator; do not emit dynamic labels/map keys, model/provider/endpoint IDs, prompt fragments, tool names/arguments/results, metadata bodies, raw replay, or error details in `Context`. Keep `source` internal unless represented by a fixed safe code. Existing `Answer` text is intentionally part of the established protocol; “numbers only” applies to the new context payload, not a breaking rewrite of all events. Add Rust serialization and TS channel fixtures with sensitive sentinels in question, schema/table, editor SQL, tools, thinking and error bodies; assert absence from context events, logs/analytics and meter storage. Metadata requests may carry only the required model identifier/auth, never conversation data; no new countTokens/discovery disclosure scope by accident.

3. **R6 / Files — wire through actual submit and header owners with lifecycle guards.** `AiAssistantPanel.tsx` delegates submissions to `hooks/useAiAssistantSubmit.ts`, which calls `runAgentTurn` and checks `requestSeqRef`; model controls render through `AiAssistantChatArea.tsx`. Add these integration files and tests, not only panel/component/`agent.ts`. `runAgentTurn` currently continues receiving channel callbacks after `settle`; new `onContext` must ignore aborted/completed/obsolete runs. Key transient meter ownership by chat scope **and session/run** and immutable provider/model snapshot so tab/session/model/provider switches, fallback, deletion, revoke/purge and unmount cannot show another turn's values beside the current model. Clear on legacy fallback (D4), new question and relevant purge; bound/evict any memory cache. Test late events after abort, same-scope session switch, two tabs/runs, fallback before tools, failed start and provider edits. Keep meter data out of `ChatMessage`/localStorage/share/export. For unknown max, avoid determinate `aria-valuenow/max`; provide accessible token text and keyboard-operated popover, not hover-only access.

4. **Phases / Verification — make review gates executable.** Every phase needs concrete exit criteria, separate Codex review and recorded evidence before activating dependent behavior. Phase 0 uses official docs plus synthetic fixtures; any later live probe needs the user's explicit authorization/keys and must not inspect real chats/databases or unrestricted server logs. Phase 1: per-wire usage, numeric privacy, metadata transport/cache and UI lifecycle tests. Phase 2: serialized request fixtures proving shortening preserves OpenAI `tool_call_id`, Anthropic grouped next-user `tool_result` ordering/IDs/error flags and unchanged thinking/signatures, Gemini `functionResponse` names/real-vs-synthetic IDs/order and unchanged `thoughtSignature`; alter result **content only**, never drop a call/result or edit raw assistant envelopes. Include multiple results per batch and failed/denied/limit-generated results, without weakening consent after shortening private content. Phase 3: full `HttpModel`→transport request/replay fixtures, endpoint/config migration tests, native no-tools finalization and synthetic live smoke on the supported server, then the planned security review. Preserve predecessor OpenAI/Anthropic/Gemini smoke and native approval gates; a document review does not satisfy them. Spell out `cargo test --locked`, `cargo test --locked --features app-store`, and matching `cargo clippy --locked --all-targets` with/without `--features app-store`, plus npm build/relevant tests and UI checks. Record unavailable gates as limitations, never as passed.

### Documentation consulted

- [Ollama native chat/tool replay](https://github.com/ollama/ollama/blob/main/docs/api.md) and [tool calling](https://github.com/ollama/ollama/blob/main/docs/capabilities/tool-calling.mdx): object arguments, optional call identity, tool-name result messages and native response fields. [Current request types](https://github.com/ollama/ollama/blob/main/api/types.go) document thinking and truncation/shift controls; these are upstream evidence, not proof of support on the locally probed version.
- [Anthropic usage types](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/types/usage.py): separate input/cache/output counters; total input must include cache counters when present. Models API context metadata remains an explicit Phase 0 verification item.
- [Gemini token documentation](https://ai.google.dev/gemini-api/docs/generate-content/tokens): separate model input/output limits and token counting. This review does not authorize sending prompts to an additional token-count endpoint.

**Conclusion: NOT READY for human approval.** Address blockers with explicit contracts and phase ownership, fold should-fix items into tests/scope, then re-review. No application implementation or approval is authorized by this review.

### Re-review (round 2)

Reviewed by Codex, 2026-10-16, on `feat/ai-agent`. Read `AGENTS.md` and `.agent/WORKFLOW.md` first; checked Revision 2 against the current provider/store/transport, protocol/wire/model/start/coordinator, consent, command, channel and submit/UI owners. **D1a/D2a/D3a/D4 stay fixed; status stays DRAFT.** This is a plan critique, not implementation verification. Only this subsection was added. No builds/tests, provider requests, credentials, real user data or runtime logs were accessed. Public documentation was checked through Context7, supplemented by primary upstream sources. P0 results remain **Claude-reported observations**, not independently reproduced evidence.

#### Disposition of prior blockers

| Prior item                            | Disposition                                     | Assessment of Revision 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — final request overflow            | **Resolved at plan level**                      | C2/C3 bound the actual serialized candidate, shorten content only, recheck the final request with its declarations/instruction/floors, terminate locally if irreducible, preserve eight steps/cancel/deadline/consent, and prohibit replay/fallback after tools. C4 covers the required adjacent cases. On switching to finalization, implementation must recompute the final allowance from remaining output budget using the existing `drive` rules, not reuse the rejected tool-step allowance. |
| 2 — unjustified fit guarantee         | **Resolved in principle; clarification needed** | C1 explicitly narrows admission to best effort; C2 fixes an all-provider 512 KiB serialized-body cap including raw envelopes. This is an acceptable answer to the prior blocker, **not a conservative token bound**. C1 arithmetic and phase ownership still need S1/S4 below. The old unconditional Goal language must be reconciled.                                                                                                                                                             |
| 3 — limits and usage semantics        | **Partially resolved; still blocking**          | B1 independent presence, conservative missing-output charging and cumulative Done are correct directions. B2 separates input/output/combined limits, bounds matching and chooses the Anthropic table. Incomplete aggregate presence and Gemini prompt-vs-tool-use semantics remain B5.                                                                                                                                                                                                             |
| 4 — native replay/finalization        | **Partially resolved; still blocking**          | A5 now specifies ordered raw replay, internal IDs, complete stops, no execution on length/final turns, and omission of tools on finals, with broad fixtures. Malformed/duplicate native identities are still replayed as result identities (B4); supported-server and overflow behavior remain B1.                                                                                                                                                                                                 |
| 5 — destination/compatibility/consent | **Partially resolved; still blocking**          | A1 correctly scopes translation to a terminal `/v1` path and preserves proxy prefix/origin; A7 explicitly retains grants for that deterministic translation, consistent with the current fingerprint. But A2 treats every discovery failure as permission to use `/v1` (B1), and “native base” ambiguously means the chat URL versus the server prefix (S2).                                                                                                                                       |
| 6 — unenforced Ollama window/phasing  | **Partially resolved; still blocking**          | A-before-B-before-C, positive bounded settings, full config/TS/store scope and immutable per-run settings resolve the original phase-order defect. A4's unclamped cold-cache request and lack of handling for a server-adjusted allocation remain B2.                                                                                                                                                                                                                                              |
| 7 — cache/generation contract         | **Partially resolved; still blocking**          | Separate metadata records, locked snapshots, TTLs, negative retry and dedup are specified. The existing capability cache is not wire-specific (B3); new cache ownership, Gemini invalidation, bounded eviction and in-flight lifecycle remain B6.                                                                                                                                                                                                                                                  |
| 8 — false truncation claim            | **Partially resolved; still blocking**          | Removing the near-full heuristic is correct; P0's low truncated count shows why. However, `truncate:false` plus any `{version}` does not establish the fail-closed contract for supported deployments (B1). B4 UI also treats every context-full outcome as an exact server rejection, although C3 generates that same code locally.                                                                                                                                                               |

#### Disposition of prior should-fix items

| Prior item                  | Disposition                                                       | Assessment                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — meter equation          | **Partially resolved; promote remaining ambiguity to blocker B7** | Fixed categories, same-request reserve, illustrative splits and deterministic rounding are good. Ring numerator/denominator, overage, nullable prompt totals and serialized framing ownership remain undefined.                                                                                                                                                                 |
| 2 — numeric DTO/privacy     | **Resolved at plan level, subject to B7**                         | Fixed named numeric fields, internal source, sentinel tests and no conversation data in metadata requests satisfy the privacy scope. Preserve the existing fixed `type: "context"` discriminator and camelCase event serialization; nulls are allowed. Do not reinterpret “numbers only” as changing existing Answer events.                                                    |
| 3 — actual owners/lifecycle | **Resolved at plan level**                                        | B4 names `useAiAssistantSubmit`, `AiAssistantChatArea`, settle/request guards, run/session/provider/model ownership, bounded transient storage, fallback/purge clears and keyboard/unknown-limit accessibility tests. Keep completed/failed/canceled displays tied to the last actual attempt, rather than presenting a previous measured request as the failed candidate (B7). |
| 4 — executable phase gates  | **Mostly resolved; S4 remains**                                   | Explicit locked Rust tests, both flavors of clippy, npm/UI checks, independent reviews, native fixtures/security review and predecessor gates are preserved. `VERIFIED WITH LIMITATIONS` must be explicitly permitted only for recorded limitations that do not invalidate a dependency. Unavailable required gates cannot silently pass.                                       |

#### Remaining and new blockers

1. **B1 — A2/A3/P0: native safety is not version-gated; discovery failure silently restores the original truncation risk.** A2 accepts any JSON `{version}` without a minimum supported version/feature rule. A3 disables prompt truncation but leaves context shifting unspecified. Current upstream defines separate `Truncate` and `Shift` controls; the chat handler defaults an omitted `shift` to true. A single overlong initial-prompt observation on one model/version does not prove behavior when generation reaches the remaining context, nor prove that older servers recognize the flags. Specify a supported-version/backend contract, both prompt-overflow and generation-overflow behavior (use `shift:false` where supported, or substantiate an equivalent), and code-only failures. Include synthetic boundary tests with prompt plus output exceeding the window, not only prompt alone. A2 must distinguish **positively identified compatible non-native servers** from auth/timeout/redirect/malformed/unsupported-version/indeterminate failures. Those failures must not silently send the conversation through `/v1`, ignoring D1a/context size for ten minutes; give a fixed explicit unavailable/unsupported outcome and compatibility path. No mid-run retry or destination switch. [Ollama request types](https://github.com/ollama/ollama/blob/main/api/types.go), [chat handler and shift defaults](https://github.com/ollama/ollama/blob/main/server/routes.go).

   P0 evidence should record the complete synthetic request options (including shift/think/num_predict), response status/shape, exact version provenance and a reproducible sanitized command/fixture. The current table supports investigating these claims; it does not establish a minimum version or universal protection. Do not mark Phase A passed solely because `/api/ps` matches once or a tool round trip succeeds.

2. **B2 — A4: cold-cache operation violates fixed D1a clamping and may advertise more context than actually allocated.** D1a is `min(trained max, setting)`, but A4 explicitly sends the setting **unclamped** when metadata is absent. Even when metadata is present, sending `num_ctx` does not by itself prove the server honored it for every supported model/backend; a trained limit below the requested setting can make the cold and warm runs behave differently. Choose a bounded metadata lookup before activation, or fail with an explicit metadata-unavailable outcome when clamping cannot be established; do not silently change the settled decision. Validate trained-max metadata, including missing/zero/multiple architecture fields. Define OOM/load failure and server clamping/adjustment behavior, with no silent smaller-context retry. Freeze the effective value and displayed denominator for the whole run; background metadata must not rewrite it. Test cold cache, missing metadata, a trained max below both default and setting, rejected/adjusted allocation, and a settings edit during an active run.

3. **B3 — new integration gap: `CapabilityCache` can reject the native run before native selection, or poison another wire.** In actual code `ai_agent_start` checks the capability key before constructing `HttpModel`; its key is `(provider id, model, saved base_url, generation)`, and records do not identify the wire. A2 can select native or `/v1` under that identical key as probe entries expire. A negative learned on `/v1` can therefore prevent native selection entirely; a native result can influence the compatibility path. Include resolved wire/destination/support-contract identity in capability lookup/recording, perform the check only after selection, and retain the locked config generation. Extend `ChannelSink::tools_accepted` and unsupported recording accordingly. Test negative `/v1` then native, native then compatible, probe expiry/failure, and late results across config changes. This does not authorize clearing all capability state or weakening the explicit-tools-unsupported rule.

4. **B4 — A5: generated IDs solve the coordinator check but not malformed native result correlation.** A5 says malformed/duplicate native IDs are ignored, yet preserves them verbatim and sends `tool_call_id: native id when present`. Two same-name calls with the same native ID consequently yield duplicate wire identities; a malformed non-string ID can also be echoed. Define whether invalid supplied identities reject the whole batch before any tool executes, or are never used in result messages and correlation is strictly by name/order under a proven contract. Raw replay can remain verbatim; it must not become permission to manufacture ambiguous result IDs. Specify absent/null/empty `tool_calls`, required assistant/message/content types and response validation before side effects. Map `ollama:{step}:{index}` through an explicit ordinal source: current `StepRequest`/`wire::parse` have no step parameter. Add transport-level multi-batch/same-function fixtures asserting actual outbound result fields, including invalid IDs and final unsolicited calls. The StepRequest comment currently promises declarations on finals and must be updated for the native exception.

5. **B5 — B1: “presence independently” needs a complete-total rule, and billing usage must not masquerade as latest-request occupancy.** For Anthropic, define whether absent optional cache counters mean zero, require a valid base input count before `prompt_exact:true`, and treat present-but-malformed relevant counters as unknown rather than emitting an exact partial sum. Apply the same rule to Gemini candidate+thought output: malformed present extras cannot become zero while retaining a known output charge. Keep independent prompt presence and allowance charging with saturating sums. The current `usage_from` cannot supply these distinctions; changing `Usage` to optional fields also affects `run_turn`'s cumulative accumulator, so specify a distinct totals representation or equally explicit accumulation contract.

   Gemini documents `promptTokenCount` separately from tokens in tool-use prompts, and its total includes both. B1 adds `toolUsePromptTokenCount` and then B3 labels the result the exact occupancy of the serialized outbound prompt. That equivalence is not established: distinguish provider-side tool-use accounting from the client request's prompt count, state the supported API semantics, and keep any aggregate billing total separate when necessary. Do not double count replayed client function responses already covered by the request prompt. Add nonzero tool-use, cached, input-only/output-only, missing-base and malformed-extra fixtures. [Gemini GenerateContent usage metadata](https://ai.google.dev/api/generate-content#UsageMetadata).

6. **B6 — A6/B2: cache race and lifetime requirements remain incomplete.** Saying “generation is read” does not identify the shared authority: the existing generation lives privately inside `CapabilityCache`, while A6 creates another cache. Specify one snapshot generation/token under `ai_providers_lock`, shared with all metadata/capability writes, or an explicit synchronized mechanism. Gemini cannot literally use Ollama's cache key/owner: name its state owner and ensure save/delete/recreate invalidate it too. Include provider kind, resolved metadata destination, model and relevant wire/settings identity. “At most 256 entries” plus pruning expired entries is insufficient when 256 live entries exist: choose deterministic eviction or rejection, and bound in-flight work separately.

   Define cleanup on success/error/timeout/cancellation so a failed or canceled owner cannot leave an in-flight key permanently stuck; concurrent waiters need the result or an explicit Unknown outcome. Own spawned background tasks and timeouts. A2 currently proposes waiting before the run starts, but `ai_agent_start` does not register its cancellable run guard until after model construction and validation: specify registration/cancellation/deadline ownership for that new wait, and test cancel-before-start with no later conversation send. Freeze the B2 limits used by a run, or explicitly define generation-safe metadata updates; a background response cannot silently change an active denominator/admission policy. Restore the prior cold-cache/timeout/malformed/oversized/expiry/recreate/concurrent-miss tests by name rather than relying on “cache and generation race tests.”

7. **B7 — B3/B4: the meter still lacks one executable occupancy/error equation.** Define ring occupancy explicitly: e.g. prompt only versus combined limit, with reserve/free separate, or prompt+reserve versus combined; whichever is chosen must agree with tooltip, colors and ARIA. For input-only limits use prompt/input and show the independent output allowance separately. Define output-only/unknown limits, negative free space as explicit overage or saturating zero plus overage, zero denominators and out-of-range measurements (ARIA must stay valid). `prompt_tokens: Option` conflicts with unconditional `sum(parts)=prompt_tokens`; either always provide an estimate for an attempted request or define the null/parts state.

   Allocate every serialized wrapper, escaping expansion, tool-result wrapper and raw envelope byte to exactly one category, without counting parsed assistant fields again; `compose_question` section lengths alone are not a serialized-wire partition. Preserve that partition through shortening/finalization. C3 can reject a candidate **locally**, but B3 emits a failed-attempt estimate only when a request fails with a context error, and B4 says `truncate:false` makes the context-full notice exact. Use an attempt snapshot for both local admission failures and provider context errors; keep `prompt_exact:false` when no valid usage was returned. A local estimate failure does not prove the provider would reject the prompt. Numeric N must mean the snapshotted limit, not a measured failed-prompt size. Define final values after success, generic failure and cancel so stale prior-step usage is not presented as measurement of an unsent/rejected candidate.

#### Additional should-fix requirements

1. **S1 — C1 arithmetic and monotonicity.** `/3` plus 25% is a heuristic, not “deliberately conservative for Unicode” as a bound. Specify ceiling division, observed-ratio denominator/zero behavior, baseline serialized body identity, saturating multiply-before-divide, and deterministic recomputation after additions, omissions and repeated shortening. Proportional rebasing can underweight immutable high-density content; retain the best-effort label and test that shortening does not spuriously increase the estimate or reselect an already-shortened result forever. C3's claim that error results are already short is false generally: `run_tool` permits failed result content up to 64 KiB. Either deliberately keep them immutable and accept local context-full, or allow content-only shortening while preserving `is_error`; test that choice.

2. **S2 — A1/A2 endpoint representation.** A1's helper appears to return `P/api/chat`, whereas A2 appends `/api/version` to a “native base.” Define the helper as validated server prefix `origin/P`, then derive exactly `P/api/chat`, `P/api/version` and `P/api/show`; do not produce `/api/chat/api/version` or append twice through `provider::endpoint`. Test complete outbound URLs through `HttpModel` and the probe transport, not only URL helper outputs. Explicitly reject ambiguous bases rather than stripping arbitrary path segments. Existing URL validation already rejects query/fragment; keep that behavior.

3. **S3 — stale overarching text and file scope.** Revision 2 supersedes Requirements/Phases/Files/Verification but leaves Goal/Risks claiming guaranteed fit and no critical-path metadata latency, conflicting with C1 and A2. State which clauses replace those claims. Include `state/app_state.rs` (new cache ownership), `agent/protocol.rs`/wire/model request contracts, and the existing frontend context-error formatter in scope: its current regex does not recognize `AI_AGENT_CONTEXT_FULL` and its existing copy claims shortening occurred. Keep user-facing context errors fixed/code-only; do not parse/display echoed provider text.

4. **S4 — phase ownership and gates.** B3 depends on C1 for missing-usage estimates although C1 is assigned to Phase C; implement the pure accounting/serialization estimator in B and activate admission/mutation only in C. State whether B2 output constraints are display-only in B (as phase order promises) or become behavior in C. Phase A should not claim Phase C shortening tests already pass; describe the small-context C gate as cases that deterministically exercise shortening, successful finalization and irreducible local failure separately. Retain explicit authorization for any later live probes and use synthetic prompts/throwaway data only. No cloud keys or real logs are required for this review. Fix “VERIFIED or better” to the actual workflow statuses and record every unavailable gate and its dependency impact.

**Conclusion: NOT READY for human approval.** Revision 2 substantially improves the plan and resolves prior blockers 1–2 at the contract level, but B1–B7 remain approval blockers. Resolve these contracts and incorporate S1–S4 before another plan review. D1a/D2a/D3a/D4 remain unchanged; no implementation, live probe, commit or approval is authorized by this critique.
