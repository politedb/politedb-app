# Ollama Native Agent Wire and Context Size (Plan 1)

## Status

APPROVED

## Task

- ID: ollama-native-context
- Split from `.agent/plans/ai-context-usage.md` on 2026-10-16 by the user ("tách plan, viết revision 3 cho plan 1 trước").
  - **Plan 1 (this file):** the Ollama agent context fix (the former R-A).
  - **Plan 2** (`ai-context-usage.md`, revised later): the context meter, usage accounting and admission control.
- **Revision 3.** This is the first text of this file. It continues the R-A contracts of Revision 2 and answers the Codex round-2 items that concern Ollama: **B1, B2, B3, B4**, the Ollama part of **B6**, and **S2/S3** (Ollama scope).
- User decision kept from the parent plan: **D1a**. Ollama's agent wire moves to native `/api/chat` with `options.num_ctx = min(trained max, setting)`. The setting defaults to 16384 and is configurable per provider.
- Builds on the AI agent (`.agent/plans/ai-agent.md`). Branch: `feat/ollama-native-context` from `feat/ai-agent`.
- Workflow:
  1. Codex plan critique;
  2. user approval;
  3. implement;
  4. Codex review;
  5. Claude `/security-review` (provider wire + destination change).
- Codex plan critique of Revision 3: NOT READY (R1–R5). The user settled E1 = (b) and **approved Phase 0 only** on 2026-10-16 ("chốt E1b, duyệt phase 0, chạy probe đi"). Phase 0 is done (below). **Revision 4** below answers R1, R3, R4 and the should-fix items (user: "viết revision 4 rồi gọi codex review lại đi"). **Revision 5** (user: "viết revision 5 rồi gọi codex review lại đi") closes the Revision 4 re-review. **Revision 6** (user: "viết revision 6 rồi gọi codex review lại đi") closes the Revision 5 re-review. Phase 1 still needs a Codex re-review and the user's approval.
- **Approved by the user on 2026-10-16** ("tôi duyệt, làm phase 1 đi"): Phase 1 = A1–A11 as amended by Revisions 4, 5 and 6, after Codex's READY in the Revision 6 re-review.
- No commit/push unless requested.

## Problem

- The agent talks to Ollama through the OpenAI-compatible `/v1/chat/completions`, which **ignores** `num_ctx`. Models therefore run at Ollama's default context, **4096 tokens**, or `OLLAMA_CONTEXT_LENGTH` if the user set it.
- By default Ollama then **silently truncates** the oldest part of the prompt (`truncate` defaults to true). It can also **shift** the context while generating (`shift` defaults to true), dropping earlier tokens.
- In the R7 smoke (`ai-agent.md`, "R7 live smoke: Ollama") this cut agent prompts. The model looped until `AI_AGENT_DEADLINE`.

## Evidence

### P0 probes (Claude, 2026-10-16)

Setup: Ollama **0.40.4** (`/api/version`), model `qwen3:4b`, local server started with `ollama serve` and no env vars. Synthetic prompts only (`"word " × N`). Commands are reproducible with `curl -s http://127.0.0.1:11434/...`.

| # | Request (abridged) | Result |
| --- | --- | --- |
| 1 | `POST /v1/chat/completions` with `options.num_ctx: 16384`, and again with top-level `num_ctx: 16384` | 200. `GET /api/ps` → `context_length: 4096` both times (ignored) |
| 2 | `POST /api/chat` `{stream:false, think:false, options:{num_ctx:16384, num_predict:5}}` | 200. `/api/ps` → `16384` |
| 3 | `POST /v1/chat/completions` after #2 | 200. `/api/ps` → `4096` (reloaded) |
| 4 | `POST /api/chat` `{stream:false, think:false, truncate:false, options:{num_ctx:4096, num_predict:5}}`, prompt ≈ 6000 tokens | **HTTP 400**-class error body: `{"error":"request (6012 tokens) exceeds the available context size (4096 tokens), try increasing it"}` |
| 5 | Same as #4 without `truncate` | 200, `done:true`, `done_reason:"length"`, **`prompt_eval_count: 2050`** (silently truncated, and far below the window) |
| 6 | `POST /api/chat` `{stream:false, think:false, truncate:false, shift:true, options:{num_ctx:4096, num_predict:1500}}`, prompt 3428 tokens | 200, `done_reason:"length"`, `eval_count: 1500` (3428 + 1500 > 4096: the context was shifted) |
| 7 | Same as #6 with **`shift:false`** | 200, `done_reason:"length"`, **`eval_count: 668`** (3428 + 668 = 4096: generation stops at the window, nothing dropped) |
| 8 | `POST /api/chat` with one `tools` entry, `think:true`, `num_predict:1500` | 200, `done:true`, `done_reason:"stop"`. `message = {role, content:"", thinking:"…", tool_calls:[{id:"call_…", function:{index:0, name, arguments:{table:"orders"}}}, {id:"call_…", function:{index:1, …}}]}` |
| 9 | Final step: replay of #8's assistant message verbatim + `{role:"tool", tool_name, tool_call_id, content}` per call, **no `tools` field** | 200, `done_reason:"stop"`, `tool_calls:null`, an answer using the results |
| 10 | `POST /api/show {model}` | `model_info["qwen3.context_length"] = 262144` |

### External (to be confirmed in Phase 0)

- **Version:** `truncate` and `shift` on `/api/chat` reportedly exist from **Ollama 0.12.6** (ollama/ollama #12582). Older servers ignore unknown fields. Source: third-party PR [Valtora/Nojoin#343](https://github.com/Valtora/Nojoin/pull/343).
- **Defaults:** `truncate` defaults to true and truncation is logged only at debug level ([ollama#14259](https://github.com/ollama/ollama/issues/14259), [ollama#8531](https://github.com/ollama/ollama/issues/8531)). Context shifting is supported on a subset of models (`server/routes.go`).
- **Phase 0 confirms the minimum version against the upstream source or release notes** before implementation. If it differs, the constant in A2 changes and nothing else.

## Decisions

- **D1a** (user): native `/api/chat` with `num_ctx = min(trained max, setting)`.
- **E1** — **(b) hard error** (user, 2026-10-16: "chốt E1b"). An Ollama server older than `MIN_NATIVE` fails the agent run with `AI_OLLAMA_UPDATE_REQUIRED`. The copy says "Update Ollama to 0.12.6 or newer to use the AI agent." There is **no** automatic fallback to the legacy assistant and no `/v1` agent run. Codex R2's fallback integration is not needed.

## Requirements

### A1 Destination (S2)

- `ollama_server_prefix(config) -> Result<Url, String>`, working on the validated base (`provider::base_url` + `url_policy::validate`):
  - accepted bases: the path is exactly `P/v1` or `P/v1/`, where `P` is an optional path prefix (no query or fragment, which validation already rejects);
  - result: `origin + P`, with scheme, host and port identical to the base;
  - anything else (`/v1/extra`, no `/v1`, `/api/...`) is **not derivable** (A2).
- Endpoints are built from the prefix with one helper, never through `provider::endpoint` (which appends to `/v1`):
  - `prefix + "/api/chat"`;
  - `prefix + "/api/version"`;
  - `prefix + "/api/show"`.
- Saved configs are never rewritten. Model listing and the legacy chat keep their `/v1` paths.
- Tests:
  - complete **outbound** URLs through `HttpModel` and the probe transport, against a local test server, for `http://127.0.0.1:11434/v1`, `/v1/`, `https://proxy.example/x/v1` and IPv6 `http://[::1]:11434/v1`;
  - rejection of `/v1/extra`, a bare origin and `/api`;
  - no double `/api/...`;
  - the origin never changes.

### A2 Server identification and version gate (B1)

Before a run, after registering the run guard (A6), using the existing transport policy (redirect block, proxy avoidance, localhost pinning, body cap, code-only errors) and **no conversation data**:

1. Not derivable (A1) → compatibility path (step 4).
2. `GET prefix/api/version`, with a 2 s timeout:
   - `200` with JSON `{version: "<semver>"}` and version ≥ `MIN_NATIVE = 0.12.6` → **native** (A3);
   - `200` with a valid version < `MIN_NATIVE` → `AI_OLLAMA_UPDATE_REQUIRED` (E1). No request is sent;
   - `404`, or `200` with a non-Ollama body → go to step 3.
   - Timeout, connection error, `401/403`, `5xx`, a redirect, an oversized or malformed body → **`AI_PROVIDER_UNREACHABLE`**. No request is sent, no fallback to `/v1`, and the result is not cached as negative.
3. Positive identification of a non-Ollama compatible server: `GET base/v1/models` (the existing discovery call) answers `200` with an OpenAI model list → **compatibility path**: today's `/v1` wire, context size unknown. A plain-text notice in the AI settings for that provider: "Context size can't be set for this server." Anything else → `AI_PROVIDER_UNREACHABLE`.
4. Compatibility path = the current behavior for non-Ollama local servers (e.g. providers saved as `local_openai_compatible`). It is chosen only by positive identification, never after an indeterminate failure.

The selection is fixed for the run: no mid-run retry, no destination switch, no resend of a transcript elsewhere.

### A3 Native request

- `model`;
- `messages` (system, user, assistant replay, tool results);
- `tools` (non-final steps only, A5);
- `stream: false`;
- **`truncate: false`** and **`shift: false`** (P0 #4, #7);
- `options.num_ctx` = the run's snapshot (A4);
- `options.num_predict` = the step's effective `max_tokens`.
- `think` is not sent (the server default), and `keep_alive` is the server default.

### A4 Context size (B2)

- **Config:**
  - new `context_size: Option<u32>` on `AiProviderConfig` (serde default `None`, camelCase `contextSize`), with TS types, provider-store validation and a settings field ("Context size (tokens)", Ollama only);
  - range `2048..=262144`, rejected outside it at the store and at the IPC boundary;
  - `None` means default `16384`;
  - ignored for other kinds.
- **Trained max (required before a native run):**
  - `POST prefix/api/show {model}` with a 2 s timeout;
  - valid metadata: `model_info` has **exactly one** key ending in `.context_length` whose value is an integer in `1..=10_000_000`;
  - missing, zero, multiple, non-integer, oversized, or a failed request → **`AI_OLLAMA_MODEL_INFO_UNAVAILABLE`**, and the run does not start. D1a's clamp is never skipped.
- **Effective size:**
  - `num_ctx = min(setting or default, trained max)`;
  - snapshotted once per run and sent on **every** step;
  - background or late metadata never changes an active run's value.
- **Server adjustments:**
  - if Ollama allocates less than requested, `truncate:false` / `shift:false` still fail closed (an error, or `length`);
  - a model load failure (e.g. out of memory) → `AI_OLLAMA_LOAD_FAILED` (code only; the copy suggests a smaller context size);
  - never a silent retry with a smaller value.
- **Tests:**
  - cold cache;
  - missing / multiple / zero metadata;
  - trained max below both the default and the setting;
  - a load-failure response;
  - a settings edit during an active run (the run keeps its value);
  - bounds at the store and over IPC.

### A5 Replay, identity and stop contract (B4)

**Response validation, before any side effect:**
- the top level is an object with `done: true`; `message` is an object, `role == "assistant"`, `content` is a string (may be empty), and `thinking` is a string if present;
- `tool_calls` is absent, `null` or an array. Each element is an object with `function.name` (a non-empty string) and `function.arguments` (an object). Anything else → `AI_AGENT_RESPONSE_INVALID`, and nothing executes.

**Stop mapping:**
- `done_reason: "stop"` with ≥ 1 valid call → `ToolUse`;
- `"stop"` without calls → `EndTurn`;
- `"length"` → `MaxTokens`; its calls are **never** executed;
- any other or missing reason, or `done` not `true` → `AI_AGENT_RESPONSE_INVALID`.

**Internal ids:**
- `protocol::ToolCall.id = "ollama-" + <position in the batch>`, generated by the native parser;
- the coordinator's duplicate check only needs uniqueness within a batch, so no step number is needed.

**Native ids:**
- a native `id` is *valid* when it is a string of 1..=128 chars from `[A-Za-z0-9_-]` and unique in its batch;
- if **every** call in the batch has a valid native id, the result messages carry `tool_call_id = native id`;
- otherwise (any missing, invalid or duplicate) **no** result in that batch carries `tool_call_id`, and correlation is by order and `tool_name` (Ollama's documented contract). Invalid ids are never echoed.

**Replay:**
- the assistant message is replayed **verbatim** from the raw response (content, thinking, tool_calls with native ids, index and order), never rebuilt;
- results go out in call order: `{role: "tool", tool_name, content, tool_call_id?}`.

**Final step:**
- the request **omits `tools`** (P0 #9);
- update the `StepRequest` / `run.rs` comment that says declarations stay on final steps: it now names the Ollama native exception;
- calls in a final response are ignored, as `drive` already does when finalizing.

**Thinking:** replayed to the provider only; never shown, never persisted, never logged.

**Usage:** `prompt_eval_count` / `eval_count` map to the existing `Usage`. Plan 2 owns the presence semantics.

**Context errors:** an HTTP error whose body is the context-size message (P0 #4; matched on a fixed prefix, code only) → `AI_AGENT_CONTEXT_FULL`. The provider text is never displayed.

**Fixtures** (wire unit + `HttpModel` transport-level, asserting the actual outbound JSON):
- two calls to the same function with different arguments;
- two batches in one run;
- missing ids; one invalid id (non-string, spaces, 200 chars); duplicate ids;
- object arguments; non-object arguments (rejected);
- error results;
- mixed content, thinking and calls;
- unknown response fields preserved in replay;
- `length` with calls; `done:false`;
- a final response with calls;
- the context-full error; a load-failure error;
- final requests contain no `tools`;
- every request contains `truncate:false`, `shift:false` and the snapshotted `num_ctx`.

### A6 Probe cache, generations and cancellation (B6, Ollama part)

**Shared generation:**
- move the per-provider generation counter out of `CapabilityCache` into a `ProviderGenerations` owned by `AppState`;
- `snapshot_for_run` reads `(config, key, model, generation)` **under `ai_providers_lock`**;
- `forget_provider` (save/delete) bumps it once for every cache;
- `CapabilityCache` and the new cache both use it.

**`OllamaProbeCache`** (owned by `AppState`):
- `version`: key `(provider id, generation, server prefix)` → `Native(version) | TooOld(version) | Compatible`. TTL 24 h. Indeterminate failures are **not cached**;
- `trained_max`: key `(provider id, generation, server prefix, model)` → `u32`. TTL 1 h (a model can be replaced under the same name);
- a write whose generation is no longer current is dropped (no late writes after save/delete/recreate);
- at most 256 entries; when inserting into a full cache, expired entries are pruned, then the **oldest-inserted** live entry is evicted.

**In-flight requests:**
- concurrent misses for one key share one lookup (a per-key shared future);
- at most 8 lookups in flight in total; beyond that → `AI_PROVIDER_UNREACHABLE` for that run (fail closed);
- a guard removes the in-flight key on success, error, timeout, cancellation or panic, so waiters get the result or an error and nothing stays stuck;
- lookups never hold the provider mutex;
- tasks are owned by the run's tracker or a cache-owned tracker with the same timeouts.

**Cancellation:**
- `ai_agent_start` registers the run (`start_on`) **before** A2/A4 lookups;
- the lookups race the run's cancel token, so cancelling during them ends the run with no conversation request;
- the 120 s turn deadline includes the lookups.

**Tests (by name):**
- cold cache;
- timeout; malformed and oversized bodies;
- expiry;
- save during lookup (late write dropped);
- delete + recreate with the same id;
- concurrent misses (one request);
- the in-flight cap;
- cancel before / during the lookup (no chat request sent);
- eviction when full of live entries.

### A7 Capability cache per wire (B3)

- `CapabilityKey` gains `wire` (`OpenAiChat | OllamaNative | Anthropic | Gemini`) and the destination it applies to (for Ollama, the server prefix or `/v1` base).
- `ai_agent_start` performs A2 selection first, then looks up and records capability with the selected wire's key.
- `ChannelSink::tools_accepted` and unsupported recording use that same key.
- A negative learned on `/v1` therefore never blocks native, and vice versa.
- The explicit tools-unsupported rule is unchanged, and existing entries are not cleared wholesale (old keys simply stop matching).
- Tests:
  - negative on `/v1`, then the server upgrades: native selected and allowed;
  - native positive, then the server is replaced by a compatible one: the compatibility key is separate;
  - probe expiry and failure;
  - a late result across a config change.

### A8 Consent (unchanged contract, stated)

- `consent::endpoint_fingerprint` hashes the saved config (kind, base URL, host, sub path), which A1 never changes.
- A data-access grant for an Ollama provider therefore covers both its `/v1` compatibility path and the native `/api/*` paths **on the same origin and prefix**.
- Test: no base can make A1 produce another origin, so a grant can never be used against a different destination.

### A9 Frontend (S3, Ollama scope)

- **Fixed copy** for the new codes, in `formatAssistantRequestError` (and its regex):
  - `AI_OLLAMA_UPDATE_REQUIRED`;
  - `AI_OLLAMA_MODEL_INFO_UNAVAILABLE`;
  - `AI_OLLAMA_LOAD_FAILED`;
  - `AI_PROVIDER_UNREACHABLE`;
  - `AI_AGENT_CONTEXT_FULL`: "The request did not fit the model's context. Increase Context size in AI settings." The existing copy saying content was shortened does not apply.

  Provider text is never shown.
- **Settings:**
  - the Ollama "Context size (tokens)" field with bounds and default;
  - the compatibility-path notice (A2.3).
- **Tests:** copy per code, field validation, persistence round trip.

## Phase 0 — Results (Claude, 2026-10-16)

Approved by the user for Phase 0 only. Synthetic prompts, local server, no user data.

The scripts are kept in the repo and run with `python3 -I`:
- `.agent/plans/probes/ollama-native-p0.py` (cases 4–10);
- `.agent/plans/probes/ollama-native-p0-correlation.py`.

### Upstream evidence (R5)

- `truncate` and `shift` on `ChatRequest` / `GenerateRequest` come from [ollama#12582](https://github.com/ollama/ollama/pull/12582), "Reapply 'add truncate and shift parameters'", merge commit `6544e1473525c381e89aba4778283900b3ad7145` (2025-10-11).
  - `gh api repos/ollama/ollama/compare/v0.12.5...v0.12.6` contains that commit; `v0.12.4...v0.12.5` and `v0.12.6...v0.12.7` do not.
  - **The first release with both flags is v0.12.6.** `MIN_NATIVE = 0.12.6` is confirmed from the primary source.
- [`api/types.go`](https://github.com/ollama/ollama/blob/main/api/types.go) defines both flags:

  ```go
  // Truncate is a boolean that, when set to true, truncates the chat history messages
  // if the rendered prompt exceeds the context length limit.
  Truncate *bool `json:"truncate,omitempty"`

  // Shift is a boolean that, when set to true, shifts the chat history
  // when hitting the context length limit instead of erroring.
  Shift *bool `json:"shift,omitempty"`
  ```

  Both are pointer types, so omission means the server default (true).
- **Context error forms** in upstream `llm/llama_server_test.go` (L2746–2777): a runner body `{"error":{"message":"request (302 tokens) exceeds the available context size (256 tokens), try increasing it"}}` (400 from the runner) is mapped by the server to **HTTP 413** `"the input length exceeds the context length"`. An unrelated error stays 500 with its own text.
  - The local 0.40.4 build returns **HTTP 400** with the runner text (case 4). The classifier must accept both forms (Revision 4).
- **Load failure:** upstream integration tests (`integration/thinking_test.go`, `integration/generate_jinja_test.go`) match `"requires more system memory"` on load errors. No load failure was provoked here, to avoid exhausting the machine. The classifier uses this fixed substring only; anything else is a generic failure.

### Local probes (Ollama 0.40.4, `qwen3:4b`; server default context, no env vars)

| Case | Request (abridged) | Result |
| --- | --- | --- |
| version | `GET /api/version` | 200 `{"version":"0.40.4"}` |
| show | `POST /api/show` | exactly one `*.context_length` key: `qwen3.context_length = 262144` |
| 4 | prompt ≈ 6000 tokens, `num_ctx 4096`, `truncate:false, shift:false` | **400** `{"error":"request (6011 tokens) exceeds the available context size (4096 tokens), try increasing it"}` |
| 5 | same, no flags | 200, `done_reason:"length"`, `prompt_eval_count: 2050` (silent truncation) |
| 6 | prompt 3428 tokens, `num_predict 1500`, `shift:true` | 200, `length`, `eval_count 1500` (shifted past the window) |
| 7 | same, **`shift:false`** | 200, `length`, **`eval_count 668`** (3428 + 668 = 4096: stops at the window, no error, partial content) |
| — | `/api/ps` after 7 | `context_length 4096` = the `num_ctx` sent |
| 8 | tools, `think` omitted | 200, `stop`. `thinking` present (2955 chars): qwen3 thinks **by default**, so `think` must stay a replayed field. Two calls `{id:"call_…", function:{index, name, arguments:{…}}}` |
| 9a | final: verbatim assistant + results with `tool_call_id`, **no `tools`** | `stop`, no calls, correct answer |
| 9b | final: ids stripped from calls and results | `stop`, no calls, correct answer |
| 9c | final: duplicate ids in calls, results without ids | `stop`, no calls, correct answer |
| 9d | final: valid ids in calls, results without ids | `stop`, no calls, correct answer |
| 10 | unknown model | **404** `{"error":"model '…' not found"}` |

**Correlation probe (results carry only `{"rows": N}`, no table names):**
- calls in the order `orders`, `customers`;
- no ids, values in call order → "300 in orders, 50 in customers";
- no ids, **swapped** values → "50 in orders, 300 in customers": the model follows **order**;
- with valid ids → correct;
- `prompt_eval_count` is **862 in all three**: this model's template does not render ids at all.

### What this settles, and what it changes for Revision 4

- **MIN_NATIVE = 0.12.6** (primary source).
- `truncate:false` makes prompt overflow an error. `shift:false` makes output overflow end with `length` and partial content, not an error. So "context full" is guaranteed only for **prompt** overflow; generation overflow is a `MaxTokens` stop (Codex should-fix 3). Revision 4 must state how `drive` treats a nonempty `length` answer (today it is answered).
- Result correlation by **order + `tool_name`** is the effective contract, and ids may be ignored by templates. The A5 all-or-none id rule stands, and order is authoritative.
- The context-error classifier needs a status in {400, 413} **and** one of two fixed message forms. Load errors match `requires more system memory`. Everything else is generic.
- `think` is omitted on requests (the server default), and returned `thinking` is replayed verbatim.

## Revision 4 (Claude, 2026-10-16): replaces A2, the A4 load-failure clause, A5 "Context errors", the A6 cancellation clause and A9; adds A10, A11

Answers Codex critique R1, R3, R4, R5 and should-fix 1–5 of Revision 3. R2 is moot: E1 = hard error, no fallback. Uses the Phase 0 results above. Everything else in A1–A8 stands.

### A2' Routing table (R1)

All probes send no conversation data. Each uses the existing transport policy (URL validation, redirect block, proxy avoidance, localhost pinning), a **1 s connect / 2 s total** timeout and a **64 KiB** body cap.

Let `B` = the validated saved base. A1 yields prefix `P` only when `B`'s path is exactly `P/v1` or `P/v1/`.

| # | Condition | Probe | Outcome |
| --- | --- | --- | --- |
| 1 | A1 derives `P` | `GET P/api/version` | see 2–6 |
| 2 | 200, JSON object, `version` is a string parsing as `MAJOR.MINOR.PATCH` (optional `-pre` / `+build`, compared by numeric core) with core ≥ 0.12.6 | — | **Native** (A3) |
| 3 | 200, valid `version`, core < 0.12.6 | — | **`AI_OLLAMA_UPDATE_REQUIRED`** (E1b). No agent request |
| 4 | 200 with a JSON object **without** a `version` key, or **404** | `GET provider::endpoint(config, "models")` (the existing discovery URL, already `P/v1/models`) | 200 with `{"object":"list","data":[{"id":string,…}…]}` → **Compatible** (`/v1` wire, context unknown). Anything else → `AI_PROVIDER_UNREACHABLE` |
| 5 | 200 with a JSON `version` that is not a string or not semver, a non-JSON or oversized body, a redirect, 401/403, 5xx, timeout, connection error | — | **`AI_PROVIDER_UNREACHABLE`**. No agent request, not cached |
| 6 | A1 cannot derive `P` (base path not `…/v1`) | `GET provider::endpoint(config, "models")` | as row 4 (**Compatible** only on a valid model list; else `AI_PROVIDER_UNREACHABLE`) |

- **What Compatible means.** The server is positively an OpenAI-compatible server that is **not** an Ollama ≥ 0.12.6 or a recognized older Ollama: rows 2–3 must not have matched, and a model list must have answered. A recognized old Ollama always hits row 3 (E1b), never Compatible.
- The serde alias `local_openai_compatible` is **not** used as a signal: such providers load as `Ollama` and go through this table like any other.
- The selection is fixed for the run: no retry, no switch, no resend.
- Cached per A6. Native / TooOld / Compatible are cached; row 5 never is.
- **Tests:** for each row, assert the exact outbound URLs and **zero `/api/chat` and zero `/v1/chat/completions` sends**:
  - auth, timeout, redirect, malformed, oversized and 5xx bodies;
  - versions `0.12.5`, `0.12.6`, `0.12.6-rc1`, `0.40.4`, `"abc"`, `12`;
  - JSON without `version`;
  - 404 then a valid model list (Compatible); 404 then an invalid list;
  - a custom prefix `https://h/x/v1`;
  - a non-`/v1` base;
  - an alias-loaded provider.

### A4' Load failures and model errors (should-fix, R5)

- **Classifier (code only, fixed strings from Phase 0 upstream evidence):**
  - any 4xx/5xx body whose `error` string contains `requires more system memory` → `AI_OLLAMA_LOAD_FAILED`;
  - **404** with `error` starting `model '` and containing `' not found` → `AI_OLLAMA_MODEL_NOT_FOUND`;
  - anything else → the existing generic request failure code.
- Provider text is never surfaced or logged.
- No retry with a smaller context.
- Tests use stubbed bodies (no memory-exhausting probe).

### A5' Context errors and `length` (R5, should-fix 3)

- **Prompt overflow** (guaranteed by `truncate:false`): HTTP **400 or 413** whose `error` string either
  - matches `request (<digits> tokens) exceeds the available context size (<digits> tokens)`, or
  - starts with `the input length exceeds the context length` (Phase 0: local 0.40.4 sends the first form, upstream maps it to the second)

  → `AI_AGENT_CONTEXT_FULL`. Status alone (413 without a matching body) → also `AI_AGENT_CONTEXT_FULL`. Other 400s → generic.
- **Output overflow** (`shift:false`): Phase 0 #7 shows generation stops with `done_reason:"length"`, **no error**. This maps to `StopReason::MaxTokens`, and the existing `drive` behavior is **kept on purpose** for every wire:
  - calls in a `length` response are never executed;
  - an **empty** `length` response → `AI_CHAT_OUTPUT_TOKEN_LIMIT`;
  - a **nonempty** `length` response is the final answer (today's behavior, `run.rs` L404–412).

  The plan therefore does **not** promise a context-full error for generation overflow.
- **Tests:**
  - both context-error forms; 413 with an unrelated body; an unrelated 400;
  - empty and nonempty `length`, each with calls (no tool runs);
  - `error` strings with appended sensitive-looking text: none is displayed.
- **Result content:** native tool results reuse `wire::tool_content` (`ERROR: …` when `is_error`). Fixtures assert the error text reaches the outbound `content`.

### A6' Preparation, deadline and terminal outcome (R3, should-fix 1)

**Order in `ai_agent_start`** (IPC future, unchanged up-front checks):
1. Snapshot under `ai_providers_lock`: config, key, model, generation (A6), context-size setting.
2. Existing validation, unchanged: provider enabled/kind, connection lookup + binding, data tools / consent gate / history gate, question composition, `start_on` (run slot + cancel token).
3. Return `Ok(())` immediately, as today. **Everything below runs in the spawned task.**

**Spawned task:**
1. `started = Instant::now()`, `deadline = started + TURN_DEADLINE` (one absolute deadline for the whole turn).
2. **Preparation**, raced against the run's cancel token and the deadline:
   - routing (A2');
   - capability lookup with the selected wire's key (A7): a known negative → `TOOLS_UNSUPPORTED`;
   - for Native: trained max (A4) and `num_ctx`;
   - build `HttpModel` for the selected wire.
3. If preparation fails, is cancelled or times out → exactly one terminal pair `Error{code}` + `Done{status: Failed|Canceled, steps: 0, …}` on the channel. Nothing is sent to the chat endpoint, the guard is dropped (slot freed), and the frontend promise settles through the existing event path.
4. Otherwise `run_turn(…, RunInput { deadline: deadline.saturating_duration_since(now), … })`. `run_turn` is unchanged except that `deadline` is now the **remaining** time.
5. The guard is dropped after `run_turn` returns, as today.

- The connection binding and consent/history gates are established before any network work, and checked again by the existing per-request gate before each chat send.
- A connection closed or consent revoked during preparation is caught by that gate on the first send (`alive` / consent checks), so no chat request is sent.

**Shared lookups (A6 in-flight):**
- one shared future per key, owned by the cache (not by a waiter);
- a waiter that is cancelled **detaches** (stops waiting), while the lookup continues for the others and is still bounded by its own 2 s timeout;
- the in-flight cap (8) counts all probe kinds together;
- an entry is removed only by the future that inserted it (compared by an entry id), so a late completion never removes a newer lookup;
- publication checks the generation and inserts **under the cache lock** (one critical section).

**Generation ids:**
- `ai_provider_save` bumps the generation for the **normalized** id returned by `provider_store::save` (and the raw input id, if different);
- delete bumps the stored id.

**Tests:**
- preparation + model steps share one short test deadline (paused tokio clock);
- cancel during routing, during metadata and during `run_turn`: no chat send, one terminal pair, slot freed;
- revoke / connection close during preparation: no chat send;
- two runs waiting on one lookup, one cancelled: the other gets the result;
- the owner panics: the waiters get `AI_PROVIDER_UNREACHABLE` and the key is retryable;
- a save during a lookup: the late result is dropped and a new lookup can start;
- normalized-id invalidation.

### A9' Frontend errors and settings (should-fix 2)

**Types:**
- `contextSize?: number | null` on `AiProviderConfig` in `src/types.ts`;
- defaults/normalization in `src/lib/ai-assistant/providers.ts`, with its tests updated;
- the backend validates on save **and** in `snapshot_for_chat` / `snapshot_for_run`. A stored out-of-range value from a hand-edited file → `AI_PROVIDER_CONFIG_INVALID`, and nothing is sent.

**Error copy:** in `formatAssistantRequestError` (`hooks/useAiAssistantSubmit.ts`), fixed codes are matched **before** the generic `AI_AGENT_` branch and before the provider-request filter, with English and Vietnamese copy:
- `AI_OLLAMA_UPDATE_REQUIRED`;
- `AI_OLLAMA_MODEL_INFO_UNAVAILABLE`;
- `AI_OLLAMA_MODEL_NOT_FOUND`;
- `AI_OLLAMA_LOAD_FAILED`;
- `AI_PROVIDER_UNREACHABLE`;
- `AI_PROVIDER_CONFIG_INVALID`;
- `AI_AGENT_CONTEXT_FULL`.

Tests in `formatAssistantRequestError.test.ts`, with provider-looking text appended to each code; none of it is displayed.

**Settings field:** "Context size (tokens)", Ollama only, integer 2048–262144, empty = 16384, with validation messages. Draft and saved values round-trip.

### A10 Status for the settings notice (R4)

**New thin command** `ai_ollama_status(draft: AiProviderConfig, auth: DraftAuthInput, request_id: string) -> OllamaStatus`, following `ai_provider_test_draft`:
- same draft validation and `draft_key` handling;
- persists nothing;
- returns `{ request_id, kind: "native" | "too_old" | "compatible" | "unreachable" | "not_ollama_kind", version?: string, trained_max?: number }`, with fixed fields only. `version` is the semver string (no other server text); `trained_max` comes from `/api/show` for the draft's default model when native.
- runs the A2' routing (and A4 trained max for native) with the same timeouts, bypassing the run cache (a draft may differ from the saved config);
- results are not written to the run cache.

**Settings dialog:**
- calls it only on explicit actions, never on every keystroke: opening an Ollama provider, the existing **Test** button, and leaving the base URL field after a change;
- shows loading → result; each request carries a new `request_id`, and a response whose id is not the latest for the open provider/draft is ignored;
- switching or closing the provider cancels the pending request (ignore + abort);
- copy:
  - `native`: "Ollama <version>. Agent context: <setting> tokens (model max <trained_max>).";
  - `too_old`: "Update Ollama to 0.12.6 or newer to use the AI agent.";
  - `compatible`: "Context size can't be set for this server.";
  - `unreachable`: "Couldn't reach the server.";
- the status is **never** persisted in `AiProviderConfig`.

**Tests:**
- each status;
- a stale response after an edit, after switching providers, and after delete;
- cancel on close;
- no call while typing;
- the Rust command rejects non-Ollama kinds without network I/O.

### A11 Verification additions (should-fix 4, 5)

- **Transport:** every new request (`/api/version`, `/api/show`, `/api/chat`, `/v1/models` probe) goes through the existing `ai::transport` with redirect blocking, proxy avoidance and localhost pinning. Tests use an injected transport or local test server; the `https://proxy.example/x/v1` case uses a local TLS fixture or an injected transport, never a real host.
- **Regressions:** model listing, draft test, legacy chat and the OpenAI/Anthropic/Gemini/Groq wires keep their exact outbound requests (existing fixtures still pass unchanged).
- **Confinement:** for every accepted base, every native URL has the same origin **and** the same prefix `P`. A data-access grant made under `/v1` remains valid for the native paths, and revocation is still checked per request.
- **Cache freshness:**
  - a 24 h cached Native / TooOld / Compatible identity means a server upgrade or replacement is seen after expiry or after a provider save; tests are named accordingly;
  - old-version expiry → re-probe → native;
  - indeterminate failures are never cached.
- **Live smoke:** `live_smoke.rs` builds its model through the **same preparation function** as the command (routing → metadata → wire), so it exercises native and cannot silently stay on `/v1`. Direct `HttpModel::new` fixtures name their wire explicitly.
- **Gates (all local, synthetic):**
  - default server context: all smoke cases with no context error, and `/api/ps` = the snapshotted `num_ctx`;
  - `context_size = 4096` with a large synthetic first message → `AI_AGENT_CONTEXT_FULL`;
  - a bounded generation-overflow case → a `length` stop handled per A5', no tool executed;
  - a stub server for `0.12.5` → `AI_OLLAMA_UPDATE_REQUIRED` (stub coverage; recorded as such, not as real-version evidence).

## Revision 5 (Claude, 2026-10-16): closes the Revision 4 re-review

Answers the three remaining blockers and the should-fix clarifications of "Re-review — Revision 4". Where this section conflicts with A1–A11 or Revision 4, it wins.

### Evidence addendum

**Invalid-id replay** (local 0.40.4, synthetic). Script `.agent/plans/probes/ollama-native-p0-ids.py`. The replayed assistant has one call; the result is `{"rows":300}`.

| `tool_calls[0].id` in the replayed assistant message | Result |
| --- | --- |
| `"call_abc"` | 200 `stop`, correct answer |
| `"bad id !"` (spaces/punctuation) | 200 `stop`, correct |
| `""` | 200 `stop`, correct |
| `null` | 200 `stop`, correct |
| absent | 200 `stop`, correct |
| `123` (number) | **400** `json: cannot unmarshal number into Go struct field Alias.tool_calls.0.id of type string` |
| `{"x":1}` (object) | **400** `… cannot unmarshal object … of type string` |
| result `tool_call_id: 7` | **400** `… Alias.tool_call_id of type string` |

**Chat context error, pinned upstream:**
- `server/routes.go` at **tag v0.12.6** forwards `Truncate` / `Shift` into the chat completion request (`Shift: req.Shift == nil || *req.Shift`, `Truncate: truncate` near L2078–2079).
- The overflow error comes from the runner as **400 `request (N tokens) exceeds the available context size (M tokens), try increasing it`**, which matches local case 4.
- The `the input length exceeds the context length` form and its 413 mapping belong to the **embedding** path (`normalizeEmbeddingError`, `TestNormalizeEmbeddingError` in `llm/llama_server_test.go`; `embedWithRetry` in `server/routes.go`, main @ `d9b86018cba1`). The earlier attribution to chat was wrong.
- `server/routes.go` main also answers **413** for `request body must not exceed 32 MiB`. A 413 is therefore **not** a context signal.

### C1 Version precedence (blocker 1)

- The version is compared with **SemVer precedence** against the stable `0.12.6`: a prerelease sorts below its release (`0.12.6-rc1 < 0.12.6`), and build metadata is ignored (`0.12.6+abc == 0.12.6`).
- Native requires precedence ≥ `0.12.6`. So `0.12.6-rc1` → `AI_OLLAMA_UPDATE_REQUIRED`, and no chat is sent.
- Tests: `0.12.5`, `0.12.6-rc1` (too old), `0.12.6`, `0.12.6+build`, `0.12.7-rc1` (native), `0.40.4`, `1.0.0`; invalid strings → `AI_PROVIDER_UNREACHABLE` (A2' row 5).

### C2 Status cancellation (blocker 2)

`ai_ollama_status(draft, auth, request_id)` **reuses the existing scoped cancel registry** (`AppState.ai_discovery_cancel`, `ai::cancel::CancelRegistry`):
- `register(&request_id)` happens **before** any await;
- `/api/version`, the `/v1/models` probe and `/api/show` are each raced (`tokio::select!`, biased to cancel) against the receiver;
- `finish(&request_id)` runs on **every** exit through a drop guard;
- cancelling uses the existing command `ai_provider_cancel_list_models(request_id)`. Its doc is updated to "cancels a discovery or status request". No new command is needed.

`request_id`:
- a fresh UUID per call from the frontend;
- an id that is already registered is rejected (`AI_PROVIDER_REQUEST_ID_IN_USE`), as `register` already does for discovery or by adding that check.

Frontend:
- the settings dialog calls cancel for the previous id on close, provider switch, and before starting a new status call;
- the shown status is **cleared immediately** on any edit to base URL, kind, default model or context size, even if no new call starts.

Tests:
- cancel before / during each probe: the backend stops, the registry is empty afterwards;
- close and switch abort backend work, not only ignore the response;
- the draft edit clears the status;
- id reuse is rejected.

### C3 Tool-call id contract (blocker 3)

Validated **before any tool executes**:
- **Response shape:** for each call, `id` must be **absent, `null`, or a JSON string of at most 256 UTF-8 bytes**. Any other type (number, object, array, bool) or a longer string → `AI_AGENT_RESPONSE_INVALID`, and nothing executes. With only these values allowed, the verbatim replay is always decodable by the server (addendum table). The replay stays verbatim.
- **Result `tool_call_id`:** sent only when **every** call in the batch has a non-empty string id and those ids are unique within the batch. Otherwise no result in that batch carries `tool_call_id`.
  - Strings of any content are allowed, since the server accepts them. Ids are never synthesized into the outbound JSON.
  - `tool_call_id` is always a string when present, never a number.
- **Correlation** is by call order and `tool_name` in every case (Phase 0: order is authoritative, and the template ignores ids).
- **Internal ids** (`ollama-<position>`) never appear in outbound JSON.
- **Fixtures** (outbound JSON asserted):
  - absent, null, empty string, non-empty valid string, a string with spaces;
  - duplicate strings;
  - number/object/array/bool ids (rejected, no tool runs);
  - a 257-byte id (rejected);
  - mixed valid and absent ids in one batch (no `tool_call_id` on results);
  - two same-name calls.

### C4 Context-error classifier (should-fix: attribution)

Replaces A5' "Prompt overflow":
- **Context full:** HTTP **400** whose `error` string matches `^request \(\d+ tokens\) exceeds the available context size \(\d+ tokens\)` → `AI_AGENT_CONTEXT_FULL` (pinned to v0.12.6 chat behavior and local case 4).
- **Everything else:**
  - 413 (e.g. the 32 MiB body limit);
  - the embedding-only `the input length exceeds the context length`;
  - other 400s

  → the generic request failure.
- If a future server changes the message, this degrades to a generic error (still fail-closed: nothing is truncated). Phase 1 tests pin both outcomes.
- Load and model errors stay as in A4'. No provider text is displayed or logged.

### C5 Settings status states (should-fix: metadata)

`OllamaStatus.kind` becomes one of `native`, `native_no_model`, `metadata_unavailable`, `model_not_found`, `too_old`, `compatible`, `unreachable`, `not_ollama_kind`. Fixed fields: `version?`, `trained_max?`, `effective?`.
- **`native`:** "Ollama <version>. Agent context: <effective> tokens (model max <trained_max>)", where `effective = min(setting or 16384, trained_max)`, the same value a run would send.
- **`native_no_model`:** the draft has no default model. "Choose a model to see its context size."
- **`metadata_unavailable`:** `/api/show` failed or was invalid. "Couldn't read this model's context size; the agent won't run until it can."
- **`model_not_found`:** "Model not found on this server."
- Changing the default model clears and re-queries (C2). Undefined values are never rendered.

### C6 Preparation terminal events (should-fix)

Fixed codes and one terminal outcome:
- **Preparation failure** → `Error{code}` + `Done{Failed, steps 0}`.
- **Preparation cancel** → `Done{Canceled}` only (as `run_turn` does), no `Error`.
- **Preparation deadline** → `Error{AI_AGENT_DEADLINE}` + `Done{Failed}`.
- A remaining budget of 0 after preparation counts as a deadline: no chat request.
- After emitting a preparation terminal, the task returns **without** calling `run_turn`. `run_turn` emits only its own terminal.
- If `sink.send` returns false (channel closed), work stops at once and the guard is dropped.
- Cancellation wins ties (biased select) at every await in preparation.
- No-send guarantees use the existing paths: connection close / consent revoke **cancel bound runs** (`cancel_on_connections`, revoke → `cancel_profile_runs`), plus the per-request `RequestGate`. The plan no longer claims a liveness check on every send.
- Tests: each of the three sequences exactly once; channel closed during preparation; zero remaining budget.

### C7 Locks and transport (should-fix)

**Lock order:**
- `ProviderGenerations` has its own mutex. Every publisher (probe cache, capability cache) takes **generations → its cache map**, checks the generation, inserts, then releases.
- `forget_provider` takes **generations only** and bumps it.
- No path takes a cache map lock and then the generations lock. Documented in code, and tested by a barrier race (bump between check and insert is impossible).

**Transport:**
- a new `transport::probe_client(class)` with **1 s connect / 2 s total** and the same redirect / proxy / pinning policy;
- `client_for` is unchanged for existing callers (10 s connect);
- body caps: 64 KiB for probes, `CHAT_MAX_BYTES` for native chat.

### C8 Scope, R2 regression, stale text

- **Phase 1 scope for approval** = A1–A11 **as amended by Revision 4 and Revision 5**, including the `ai_ollama_status` command, the status UI (C2/C5) and every gate in A11.
- Stale text:
  - "Out of scope" no longer says settings never shows a context size: C5 shows it;
  - the Risk "minimum version from a secondary source" is closed by Phase 0;
  - the old formatter path in A9 is superseded by A9'.
- **R2 regression** (E1b): an async preparation error `AI_OLLAMA_UPDATE_REQUIRED` rejects the turn and sends **no** legacy request. `FALLBACK_CODES` in `src/lib/ai-assistant/agent.ts` stays unchanged. Tests cover both the async-event path and `formatAssistantRequestError`.

## Revision 6 (Claude, 2026-10-16): closes the Revision 5 re-review

Answers B1, B2, S1 and S2 of "Re-review — Revision 5". Where this section conflicts with earlier text, it wins.

### D1 Cancel registry ownership (B1): replaces C2's registration rules

`ai::cancel::CancelRegistry` gains per-registration tokens. **One semantics for both discovery and status**, compatible with today's discovery behavior:
- `register(id) -> Registration { token: u64, rx }`, where `token` is a counter that increases on every call:
  - if an **early cancel** for `id` is remembered, the new receiver fires at once (unchanged);
  - if `id` is already active, the incumbent is **superseded**: its sender fires and the entry is replaced by the new `(token, tx)`. This is today's discovery behavior; no rejection, no new error code.
- `cancel(id)` fires the active sender and removes the entry, or remembers an early cancel (unchanged).
- `finish(id, token)` removes the entry **only if** the active entry's token equals `token`; otherwise it does nothing. This replaces `finish(id)`.
- Every caller keeps its `Registration` and finishes it through a drop guard that holds `(id, token)`: discovery (`ai_provider_list_models`) and status (`ai_ollama_status`).

Because a stale `finish` can no longer remove a newer registration, the B1 interleaving (A registers X → cancel X → B registers X → A's guard finishes X) leaves B intact.

The C2 text "an id that is already registered is rejected (`AI_PROVIDER_REQUEST_ID_IN_USE`)" is withdrawn. The frontend still sends a fresh UUID per call, and the backend handles reuse by supersession.

**Tests** (`ai/cancel.rs`, plus each command):
- concurrent register of one id: exactly one active entry, and the other is fired;
- cancel → re-register before the old cleanup → old `finish` → the new registration is still active and not fired;
- old cleanup after a replacement;
- early cancel then register: fires at once;
- normal success and error cleanup: the entry is gone;
- a superseded request's guard does not remove the successor;
- existing discovery tests are kept (updated for the new signatures).

**Scope:** `src-tauri/src/ai/cancel.rs`, and `commands/ai.rs` (both commands' guards).

### D2 Chat context-error classifier (B2): replaces C4 "Context full"

`AI_AGENT_CONTEXT_FULL` when the native `/api/chat` response is HTTP **400** and the `error` string, trimmed, matches **either**:
- **(a)** it starts with `the input length exceeds the context length`. This is the v0.12.6 runner error `errorInputTooLong` ([ollamarunner L108](https://github.com/ollama/ollama/blob/v0.12.6/runner/ollamarunner/runner.go#L108-L130) and [llamarunner L99](https://github.com/ollama/ollama/blob/v0.12.6/runner/llamarunner/runner.go#L99-L124) at tag v0.12.6), returned as 400 by the completion handler and forwarded by `llm/server.go` and the chat handler.
- **(b)** it matches `^request \(\d+ tokens\) exceeds the available context size \(\d+ tokens\)`. This is the form **observed on the local 0.40.4 build** (Phase 0 case 4). Its upstream provenance is not pinned: it is reported local evidence only.

Everything else is the generic request failure, still fail-closed:
- 413 (e.g. the 32 MiB body limit);
- other 400s;
- 5xx.

**Provenance correction:**
- The Revision 5 addendum claimed the numeric form for v0.12.6, and claimed the `the input length…` form was embedding-only. Both claims are **wrong**.
- `the input length exceeds the context length` is the chat (and embedding) runner error at v0.12.6.
- The numeric form is a later/local runner message. Its origin version is not established.

**Fixtures** (transport-level, `HttpModel`):
- (a) with and without a trailing newline;
- (b);
- 400 `Bad request`; 400 with `bad request: …`;
- 413 with the body-limit text;
- 500;
- each with sensitive-looking suffixes, which are never displayed or logged.

### D3 Editorial consolidation (S1)

- **Phases:** "Phase 1: implement A1–A9" now reads **"Phase 1: implement A1–A11 as amended by Revisions 4, 5 and 6"**.
- **Files:** `ai/transport.rs` is not reuse-only. It gains `probe_client` (C7). `ai/cancel.rs` is added (D1). The formatter is `formatAssistantRequestError` in `hooks/useAiAssistantSubmit.ts` (A9'); the older path in A9's file list is superseded.

### D4 Evidence scope (S2)

- All local replay and correlation results (Phase 0, addendum) are **reported local evidence** for Ollama 0.40.4 with the `qwen3:4b` template. They show the contracts work there; they do not prove every model template or version.
- Phase 1 therefore keeps:
  - transport-level fixtures for every id shape (absent, null, string, invalid types, duplicates, mixed);
  - the live smoke as an implementation gate.
- The statement that allowed ids make replay decodable is limited to the **id field**. The whole response must still pass A5's shape validation; unknown nested fields are replayed as received and are covered by the "unknown fields preserved" fixture, not by a decodability guarantee.

## Out of scope (Plan 2)

- The context meter.
- Per-request usage presence.
- Limits for other providers.
- Admission control and shortening.

Plan 1 shows a context size only in AI settings (the field and the C5 status line).

## Phases

- **Phase 0 (docs + local probes, no app code):**
  - confirm `MIN_NATIVE` from the upstream Ollama source or changelog (the version that added `truncate` and `shift` to `ChatRequest`) and record the link;
  - re-run P0 #4–#9 on the current local server with the exact command lines saved in this file;
  - probe a load-failure response shape (huge `num_ctx` on a small machine), if reproducible safely;
  - get the user's choice on **E1**.
- **Phase 1:** implement A1–A11 as amended by Revisions 4, 5 and 6.

## Gates

- `cargo test --locked` and `cargo test --locked --features app-store`.
- `cargo clippy --locked --all-targets` with and without `--features app-store` (no new warnings).
- `npm run build`, `npm run test:run`, prettier.
- **Live** (local Ollama, synthetic prompts, throwaway databases only):
  - `live_smoke.rs` at the **default server context** (no `OLLAMA_CONTEXT_LENGTH`): no context error; `/api/ps` reports the snapshotted `num_ctx`; all safety asserts hold;
  - `context_size = 4096` with a large synthetic table → `AI_AGENT_CONTEXT_FULL`, not a silent truncation;
  - a server version check against a stub server answering `{version:"0.12.5"}` → `AI_OLLAMA_UPDATE_REQUIRED` (stub, not a real old install).
- Codex review: `VERIFIED` or `VERIFIED WITH LIMITATIONS`, only for recorded limitations that do not invalidate Plan 2's dependencies. Then Claude `/security-review`.
- Every gate that cannot run is recorded as a limitation, never as passed.

## Files

- **Backend:**
  - `src-tauri/src/ai/agent/wire.rs` (`Wire::OllamaNative` dispatch);
  - new `src-tauri/src/ai/agent/wire_ollama.rs` (A3/A5);
  - `ai/agent/model.rs` (destination selection, `CapabilityKey`, `ProviderGenerations`);
  - `ai/agent/start.rs` (snapshot generation and context size);
  - `ai/agent/protocol.rs` (comment on final declarations);
  - `ai/agent/run.rs` (comment only);
  - new `ai/ollama_probe.rs` (A2/A4/A6);
  - `ai/provider.rs` + `ai/provider_store.rs` (`context_size`, validation, prefix helper);
  - `ai/transport.rs` (`probe_client`, C7);
  - `ai/cancel.rs` (registration tokens, Revision 6 D1);
  - `commands/ai_agent.rs` (order: `start_on` → probes → model → capability);
  - `commands/ai.rs`:
    - save/delete `forget_provider` with the normalized id;
    - the discovery (`ai_provider_list_models`) token-aware cancel guard;
    - the new `ai_ollama_status` command with its token-aware guard;
  - `state/app_state.rs` (new owners).
- **Frontend:**
  - `src/lib/tauri/ai.ts` (`contextSize`);
  - `src/components/ai-assistant/AiAssistantSettingsDialog.tsx`;
  - ~~`hooks/formatAssistantRequestError.ts`~~ (superseded: the formatter lives in `hooks/useAiAssistantSubmit.ts`, A9');
  - provider form tests.

**Revision 4 file additions:**
- **Backend:**
  - the `ai_ollama_status` command (`commands/ai.rs` + `main.rs` registration);
  - the spawned-task preparation in `commands/ai_agent.rs`;
  - the `RunInput.deadline` caller in `run.rs` (behavior unchanged; it now receives the remaining time).
- **Frontend:**
  - `src/types.ts`;
  - `src/lib/ai-assistant/providers.ts` + its tests;
  - `src/lib/tauri/ai.ts` + `commands.ts` (`aiOllamaStatus`);
  - `hooks/useAiAssistantSubmit.ts` (`formatAssistantRequestError`) + `formatAssistantRequestError.test.ts`;
  - `AiAssistantSettingsDialog.tsx` + its tests.

## Risks

- ~~Minimum version from a secondary source~~: closed by Phase 0 (v0.12.6 confirmed from the primary source).
- **Models without context-shift support behave differently at the window.** `shift:false` plus `length` handling is fail-closed either way.
- **Larger `num_ctx` uses more RAM/VRAM.** The default of 16384 is moderate, the setting is user-controlled, and load failures surface with a clear code.
- **Native replay differs across model templates.** Mitigation: transport-level fixtures, plus the live smoke on the default server.

## Plan Review

### Codex critique — Revision 3 (2026-10-16)

**Conclusion: NOT READY for human approval.** D1a stays fixed. E1 remains a human decision; the recommendation is not authorization. This is a static plan review against the actual `feat/ai-agent` working tree, including the parent plan's `### Re-review (round 2)`. No application changes, tests, live requests, provider APIs, credentials or user data were used. P0 is **Claude-reported evidence**, not independently reproduced evidence or a passed gate.

#### Disposition of prior items

| Prior item | Disposition in Plan 1 |
| --- | --- |
| **B1** | **Partially resolved.** A3 now requires both `truncate:false` and `shift:false`, rejects incomplete/unknown stops, fixes wire selection for the run, and avoids fallback on indeterminate transport failures. Minimum-version support and the exact native contract still need Phase 0 evidence. A2's incompatible branches and E1 integration remain blockers below. |
| **B2** | **Resolved at the planning-contract level.** A4 requires bounded metadata before native chat, validates a unique positive trained maximum, clamps even on cold cache, freezes the value, forbids smaller-context retries, and names load/adjustment cases. This honors D1a. Preserve these requirements in tests; reported P0 alone does not verify them. |
| **B3** | **Resolved at the planning-contract level.** A7 selects the wire before capability lookup and carries wire/destination through `ChannelSink` and negative recording. This corrects the current early lookup in `commands/ai_agent.rs` and the current wire-less `CapabilityKey` in `agent/model.rs`. Shared-generation integration remains subject to the B6 notes below. |
| **B4** | **Mostly resolved, with evidence gate remaining.** A5 validates the entire batch before execution, defines null/absent calls, separates internal batch-local IDs from native IDs, gives an all-or-none rule for result IDs, preserves raw replay, and excludes truncated/final calls from execution. Batch-local IDs match `drive`'s per-batch `HashSet`; no step ordinal is needed. Name/order correlation for invalid or missing IDs must be established in Phase 0 and exercised through actual outbound JSON, not inferred from P0's valid-ID example. |
| **B6 — Ollama only** | **Substantially resolved, integration incomplete.** A6 identifies one generation owner, locked snapshots, late-write rejection, TTLs, deterministic eviction, in-flight bounds and cleanup. It also requires early run registration. Deadline/event ownership and shared-lookup cancellation still need the explicit contracts below. Gemini/accounting remain Plan 2 scope. |
| **S2** | **Endpoint representation resolved; routing not fully resolved.** A1 defines a server prefix and three derived endpoints, prohibits `provider::endpoint` for native calls, and requires outbound URL tests. A2 still misstates the compatible discovery URL and contradicts its own identification rule. |
| **S3 — Ollama only** | **Partially resolved.** The split removes meter/admission claims and names state/protocol/error/settings scope. Several listed frontend files/types are not where the plan says, and settings cannot currently consume probe results. Correct the file and IPC scope below. |

#### Approval blockers

1. **R1 — A2 must have one executable routing table.** Step 1 sends a non-derivable base directly to step 4, but step 4 says compatibility is selected *only* through positive identification. Define the bounded positive probe or explicit unavailable result for that branch; never guess a native prefix from an arbitrary saved path. Also replace `GET base/v1/models` with the actual existing discovery destination: `provider::endpoint(config, "models")`, which is already `P/v1/models` for a saved `P/v1` base. Appending `/v1/models` literally doubles `/v1`. The serde alias `local_openai_compatible` becomes `AiProviderKind::Ollama` on load (`provider.rs`); it is not a surviving kind/identity signal. A models list establishes compatibility, not proof that the backend is non-Ollama. State exactly what evidence permits the unknown-context exception, without allowing a recognized old Ollama to bypass E1. Distinguish a valid non-Ollama JSON body from malformed JSON and malformed/missing version fields; define invalid semver/prerelease handling. Give the compatibility probe its own total timeout/body limit. Tests must assert destination and **zero chat sends** on auth, timeout, redirect, malformed/oversized body, 5xx and ambiguous identity, plus successful alias/custom-prefix compatibility.

2. **R2 — E1 recommendation assumes fallback that does not exist.** `src/lib/ai-assistant/agent.ts::FALLBACK_CODES` contains only disabled/provider/tools/engine-unsupported; `AI_OLLAMA_UPDATE_REQUIRED` currently becomes an ordinary failure. If the user chooses the recommendation, add explicit frontend fallback integration and its file/tests to scope. Cover both an IPC rejection and an asynchronous `error`/`done` result, retain the no-tool-ran rule, and preserve the existing history-data stripping/consent behavior in `useAiAssistantSubmit.ts`. Do not add metadata, unreachable, load or context-full codes to automatic fallback. Explain that the selected legacy fallback can send a new conversation request through `/v1` without D1a's context guarantee; A2's “No request is sent” must mean no **agent conversation** request before that explicit fallback, not no request at all. If E1 instead chooses a hard error or warned compatibility wire, rewrite the corresponding flow and tests. E1 must be settled before implementation approval.

3. **R3 — A6 needs a concrete preparation/deadline/terminal-event contract.** The current command validates connection/history/question, calls `start_on`, spawns work and returns immediately. `run_turn` then creates its own tracker and starts a fresh `timeout(input.deadline, drive(...))`. Moving probes before it does **not** include their time in that deadline. Specify one start instant/absolute deadline and pass only remaining time into `run_turn`, or extend coordinator preparation ownership; amend “`run.rs` (comment only)” if required. Keep connection binding and consent/history validation before any conversation send. Choose whether preparation runs inside the spawned task (recommended to preserve immediate start) or in the IPC future, and define cleanup plus exactly one terminal outcome for probe errors/cancel/deadline/channel closure. A registered guard must always be released. Test delayed probes plus delayed model work against **one** 120 s budget with a fake clock/short test budget, no later chat after cancel/revoke/connection close, and no orphaned UI promise or run slot after preparation fails.

4. **R4 — A9 settings status has no defined backend-to-frontend path.** `AppState` owns caches only in Rust; `aiProviderList()` returns saved configs and `aiProviderListModels()` returns `string[]`. Neither exposes native/compatible/too-old/unknown status, and the settings dialog supports unsaved drafts. Define a narrow typed status surface, when it is queried, and how results are bound to provider generation or draft identity. Specify loading/unknown/failure versus positively compatible states, stale response rejection after edit/delete/provider switch, and cancellation. Do not persist transient probe status in `AiProviderConfig` or infer “compatible” from failed discovery. Include command registration/IPC types if adding a command, and tests for the actual settings notice before/after a run and after endpoint edits. Otherwise the required compatibility/update notice is not implementable as scoped.

5. **R5 — Phase 0 must close the protocol gate before Phase 1, not merely adjust a constant.** A version threshold controls silent-truncation protection. Record primary upstream evidence for *both* chat flags and their semantics, sanitized reproducible requests/responses, version provenance, prompt-overflow **and prompt-plus-output boundary** cases. If evidence differs from assumptions, revisit request/parser/error contracts and minimum version together; “the constant ... changes and nothing else” is too strong. Re-run missing/duplicate/invalid-ID same-name result correlation and final replay, including thinking, with the supported native contract. P0 #8/#9 only demonstrate valid native IDs and do not establish the fallback correlation rule. Define a stable load-error classifier from evidence or use a safe generic failure until one is validated; A4/A5 cannot promise `AI_OLLAMA_LOAD_FAILED` from unspecified text. No intentionally memory-exhausting probe is required: use a captured sanitized/stubbed load failure if reproducing it would disrupt the machine. An unresolved protection/replay gate cannot be waived as `VERIFIED WITH LIMITATIONS` for Plan 1 merely because Plan 2 can proceed. Current review authorizes no live probes.

#### Should-fix contracts and verification

1. **Shared lookup cancellation:** choose whether cancelling the first waiter cancels the shared lookup or only detaches that waiter; define the other waiters' outcome and retry eligibility. Count the eight in-flight lookups globally across version/metadata probes, remove entries only for the matching future/generation, and prevent late completion from removing a newer entry. Test two waiting runs with owner cancellation/panic, one surviving waiter, and a replacement lookup after save. Publication must atomically check the shared generation and insert; a check followed by an unlocked insertion still allows late stale writes. Ensure normalized provider IDs are used consistently when bumping generations (`save` currently invalidates using the raw input ID before store normalization).

2. **Correct frontend file scope:** `AiProviderConfig` is imported from `src/types` by `src/lib/tauri/ai.ts`; update its authoritative declaration and `src/lib/ai-assistant/providers.ts` normalization/default helpers, with their existing tests. `formatAssistantRequestError` lives in `hooks/useAiAssistantSubmit.ts`, **not** a standalone `formatAssistantRequestError.ts`; the standalone `.test.ts` does exist. Place fixed-code matching before generic `AI_AGENT_` handling, recognize `AI_OLLAMA_*` before the provider-request filter, and verify English/Vietnamese copy. The current text-matching regex is not the main integration point: a code-only context error must reach the dedicated branch. Test all new codes with appended sensitive-looking provider text and assert none is displayed. Include nullable/default config migration, integer bounds and raw IPC/start-snapshot validation; `snapshot_for_chat` currently only normalizes loaded configs, so save validation alone does not protect startup from an invalid stored value.

3. **Native result and output semantics:** explicitly reuse the existing `tool_content` behavior (`ERROR: ...` for `is_error`) or an equivalent native error representation; fixtures must assert error information survives, not only that the request serializes. Add unknown/missing stop reason and malformed assistant/content/thinking tests. `drive` currently returns nonempty text successfully even for `MaxTokens`; `shift:false` reaching the context boundary can therefore produce a partial answer marked answered. State whether preserving that existing behavior is intended, and test both empty and nonempty `length` responses with calls to ensure no tool executes. Do not promise a context-full error for all generation-boundary cases.

4. **Endpoint/consent tests:** A8 matches the current saved-config fingerprint contract; no consent migration is required by D1a. Test actual destination confinement to **both origin and prefix**, plus grant validity and existing per-request revocation checks. Preserve URL validation, redirect blocking, HTTP proxy avoidance and localhost pinning on every new request. The `https://proxy.example` transport test must use an injected transport/local TLS fixture without contacting a real host; helper-only assertions are insufficient. Keep model listing, draft test, legacy chat and non-Ollama wires unchanged, with targeted regression fixtures.

5. **Cache freshness and gates:** 24 h cached native/compatible/too-old identity means backend replacement/upgrade is only discovered after expiry or invalidation; label A7 tests accordingly rather than implying immediate selection of the new wire. Test old-version expiry/recovery and no negative caching of indeterminate failures. Update `live_smoke.rs` and direct `HttpModel::new` fixtures to exercise the new preparation/native path explicitly: changing only the command can leave those tests on `/v1`. Keep current default-context and irreducible small-context gates, add a bounded generation-overflow gate, and distinguish stub coverage from real-version evidence. No build/test gates were run for this critique; this review changes documentation only.

**Approval exit:** resolve R1–R4 in the plan, settle E1, and make R5 an explicit completed protocol-evidence gate before Phase 1 can be approved/started (or obtain separate approval for Phase 0 only). Incorporate the should-fix contracts into implementation/test scope. B2/B3 and the resolved portions of B4/B6/S2 need no redesign. D1a remains unchanged; Plan 2 accounting/admission requirements are not reopened here.

### Re-review — Revision 4

Codex, 2026-10-16. **Conclusion: NOT READY for human approval of Phase 1.** E1 = (b) is settled; only Phase 0 is approved. Plan status remains DRAFT. This review changes only this subsection; no application implementation or approval is implied.

**Review basis:** read `AGENTS.md` and `.agent/WORKFLOW.md`, then checked Revision 4 against `feat/ai-agent`: `commands/ai_agent.rs`, `commands/ai.rs`, `ai/agent/{run,wire,model,start,protocol,consent}.rs`, provider/store/transport, `state/app_state.rs`, connection cancellation, `src/types.ts`, provider helpers, Tauri wrappers, `agent.ts`, `useAiAssistantSubmit.ts`, the settings dialog, and both saved probe scripts. No real provider credentials, saved provider files, databases or user data were accessed. No build/test gates were run for this documentation review.

**Evidence distinction:** Phase 0's local results remain Claude-reported. An independent synthetic invalid-ID replay attempt and a subsequent `/api/version` check were blocked locally by `URLError: [Errno 1] Operation not permitted`; they establish no Ollama response or server availability. Primary upstream source was independently checked: [v0.12.5 API types](https://github.com/ollama/ollama/blob/v0.12.5/api/types.go), [v0.12.6 API types](https://github.com/ollama/ollama/blob/v0.12.6/api/types.go), [v0.12.6 chat handler](https://github.com/ollama/ollama/blob/v0.12.6/server/routes.go), and [PR #12582](https://github.com/ollama/ollama/pull/12582). The stable-release threshold and forwarding of both flags into chat completion are supported. This does not verify every prerelease or every newer model template.

#### Disposition of R1–R5

| Item | Revision 4 disposition |
| --- | --- |
| **R1** | **Mostly resolved; version qualification still blocks.** A2' is executable for derivable and arbitrary saved paths; the models endpoint now matches `provider::endpoint(config, "models")`. Alias handling, positive compatibility evidence, bounded probes, malformed-version handling and no-chat failure cases are explicit. Compatibility proves the protocol, not absence of Ollama; the stated row precedence correctly prevents a *recognized* old server bypass. Numeric-core prerelease comparison remains unsafe at the support boundary (blocker 1 below). |
| **R2** | **Closed as moot by user decision E1b.** No fallback integration is needed. Existing `FALLBACK_CODES` excludes the new errors, so preserve that set. Add an asynchronous preparation-error regression proving `AI_OLLAMA_UPDATE_REQUIRED` rejects the turn without a legacy request; also cover direct error formatting. |
| **R3** | **Resolved at the planning-contract level.** A6' preserves immediate IPC return, performs preparation after `start_on` in spawned work, shares one turn budget, passes remaining duration to `run_turn`, and defines terminal events/guard release. Existing connection close and consent revoke cancel registered bound runs; `ConsentGate` itself does not universally check connection liveness. Implement the promised no-send checks using that cancellation path plus the request gate, rather than assuming an `alive` check already exists on every send. Cancellation must win ties and an exhausted remaining budget must not send chat. |
| **R4** | **Partially resolved.** A10 supplies a draft-aware, nonpersisted typed status command, registration/wrappers, triggers and stale-result tests. Actual abort ownership is still unspecified: a request id alone cannot cancel a Tauri invocation (blocker 2). Metadata-unavailable status/copy also needs the should-fix below. |
| **R5** | **Partially resolved.** Stable MIN_NATIVE, omitted `think`, both flags, ordered same-name results, final replay and deliberate `length` behavior now have useful evidence/contracts. A fixed memory-error substring with stub tests is acceptable without exhausting RAM. The saved scripts cover missing/duplicate/valid IDs, but never invalid IDs; A5's invalid-ID/replay contradiction remains (blocker 3). The cited 413 evidence is also misattributed, as detailed below. No fresh runtime gate passed in this review. |

#### Disposition of the five should-fix items

| Item | Disposition |
| --- | --- |
| **1 — Shared lookup cancellation** | **Resolved in intent by A6'.** Cache-owned work survives waiter cancellation; cap is global; entry ids protect replacement work; owner panic and normalized-id invalidation have tests. Preserve truly atomic generation validation/publication when moving generations out of `CapabilityCache`: holding only a probe-cache mutex does not exclude a bump in a separate generation owner. Specify shared synchronization or a consistent lock order that both publication and invalidation obey, including capability writes. |
| **2 — Frontend scope** | **Resolved by A9' and file additions.** Authoritative types/helpers and the actual formatter location are now named. Fixed-code branches precede generic handling; nullable defaults, IPC/stored bounds, bilingual copy and sensitive-suffix tests are in scope. Keep the old nonexistent formatter path only as superseded historical text. |
| **3 — Result/output semantics** | **Substantially resolved by A5'.** `tool_content` preserves errors; nonempty `MaxTokens` intentionally remains answered and empty output remains an error, matching `drive`. Calls never run for `length` or finalization. Retain explicit fixtures for unknown/missing stop and malformed role/content/thinking, not merely happy-path outbound JSON. Invalid-ID handling remains blocker 3. |
| **4 — Endpoint/consent tests** | **Resolved by A11.** Actual outbound origin and prefix confinement, saved-config grant continuity, revocation, injected HTTPS fixtures and unchanged existing wires are explicit. Native transport must retain validation and body limits. `transport::client_for` currently has a fixed 10 s connect timeout; the promised 1 s connect timeout requires a narrow transport option, with old callers' defaults preserved. |
| **5 — Freshness and gates** | **Resolved by A11.** Cached upgrade/replacement recognition is explicitly delayed until expiry/save, old-version recovery and indeterminate failures are covered, and smoke uses shared preparation. Default-context, small-context, bounded generation-overflow and old-version stub gates are distinguished. These remain future implementation gates, not Phase 0 passes. |

#### Remaining approval blockers

1. **Version gate must not infer flag support from the numeric core of `0.12.6-rc1`.** A2' admits it as Native even though the evidence establishes the final v0.12.6 release, and the flags were reintroduced after earlier reverts. An earlier prerelease can silently ignore them. Require normal SemVer precedence against stable `0.12.6` (build metadata does not affect precedence), or reject prereleases unless their support is separately established. State the outcome for `0.12.6-rc1` and test it as below-threshold/no chat. This closes the remaining R1 protection gap without changing D1a or E1.

2. **A10 must define backend cancellation, not just “ignore + abort.”** Existing `ai_provider_list_models` registers `request_id` in `ai_discovery_cancel`, races its receiver, and exposes `ai_provider_cancel_list_models`; `ai_provider_test_draft` has no such mechanism. The proposed `ai_ollama_status` signature registers nothing and no cancellation command is scoped. Define either a dedicated status cancel command/registry or explicit reuse of the existing scoped registry/cancel command, with unique ids, registration before waiting, both version and metadata raced against cancellation, and cleanup on every exit. Add the wrapper/registration as needed. Invalidate status identity on every relevant draft/model edit even when no replacement query starts, and test that close/switch aborts backend work as well as ignoring the response. This completes R4.

3. **A5 cannot both replay invalid IDs verbatim and promise never to echo them.** The raw assistant message includes `tool_calls[].id`; omitting IDs only from tool results still echoes invalid IDs in assistant replay. In particular, the [current upstream API](https://github.com/ollama/ollama/blob/main/api/types.go) declares `ToolCall.ID` as a string: a non-string value preserved in replay can fail request decoding after tools have already executed. The saved probes never test that case. Choose one consistent pre-side-effect contract: reject malformed/unreplayable IDs with `AI_AGENT_RESPONSE_INVALID`, or explicitly authorize narrowly sanitized replay and document its exception to verbatim preservation. Define missing/null, invalid string, non-string and duplicate cases separately. Add outbound replay fixtures and a synthetic invalid-ID probe/equivalent primary-source validation. Keep call order authoritative. This is the remaining R5 evidence/contract blocker, not a reason to discard the successful order-correlation evidence.

#### Additional should-fix clarifications (not independent approval blockers)

- **Correct the error-evidence attribution.** The cited [upstream test](https://github.com/ollama/ollama/blob/main/llm/llama_server_test.go) is `TestNormalizeEmbeddingError`, invoking `normalizeEmbeddingError`; it does not establish 413 normalization for `/api/chat`. Preserve local 400 evidence as reported, label 413 handling defensive unless chat-specific source/capture establishes it, and pin upstream evidence to a commit/tag rather than moving line numbers. A5' also deliberately classifies every 413 as context-full, broader than Phase 0's “status and message” statement; label that product policy explicitly. No raw body should escape either branch.
- **Separate native identity from metadata availability in A10.** Version can succeed while the draft has no default model, `/api/show` fails, or metadata is invalid. Current optional `trained_max` and the sole `unreachable` failure kind do not explain that state. Define fixed metadata-missing/model-not-found copy, avoid displaying undefined values, and display effective `min(setting/default, trained_max)` when claiming “Agent context,” rather than an unclamped setting. Changing the selected default model must invalidate old metadata.
- **Keep phase scope authoritative.** “Phase 1: implement A1–A9” predates A10/A11. Explicitly include Revision 4's replacements, status command and additional gates in the scope presented for approval. Remove or label superseded minimum-version-risk text and the claim that settings never displays context outside the field, now contradicted by A10.
- **Preparation terminal semantics:** A6' promises `Error + Done` even for cancellation, whereas existing `run_turn` emits only `Done(Canceled)`. Either is workable with the current frontend, but name fixed cancel/deadline codes and test the chosen sequence; do not accidentally emit two terminal outcomes through both preparation and `run_turn`. Channel closure cannot guarantee delivery: stop work on failed sends and release the guard.

**Approval exit:** close the three blockers, carry the should-fix clarifications into the implementation/test contract, and obtain explicit human approval of Phase 1. Preserve E1b, D1a, the Phase 0-only authorization, and Plan 2's separate scope. Implementation and all runtime/build gates remain pending.


### Re-review — Revision 5

Codex, 2026-10-16. **Conclusion: NOT READY for human approval of Phase 1.** DRAFT and Phase 0-only authorization remain unchanged. D1a and E1b remain settled.

**Review basis:** read `AGENTS.md`, `.agent/WORKFLOW.md`, RTK guidance, the complete plan and the invalid-id probe script; checked branch `feat/ai-agent`, including `ai/cancel.rs`, its discovery commands, `commands/ai_agent.rs`, `ai/agent/run.rs`, `ai/transport.rs`, `model.rs` capability cache, `state/app_state.rs`, frontend `agent.ts` fallback/event handling, `useAiAssistantSubmit.ts`, and settings discovery/draft handling. This is a documentation review: no application edits, live generation probes, builds or tests; no saved provider files, credentials, databases or real user data accessed. Local addendum results remain Claude-reported; inspecting the script verifies its synthetic request construction, not its claimed responses. Primary v0.12.6 source was independently fetched for the chat handler, both runners, completion transport and API types.

#### Prior approval blockers

| Revision 4 blocker | Disposition |
| --- | --- |
| **1 — Version precedence** | **Closed by C1.** Stable SemVer comparison, build metadata and boundary prerelease tests are explicit. `0.12.6-rc1` cannot send chat. `0.12.7-rc1` follows the chosen normal SemVer policy; this is not fresh runtime evidence for that prerelease. |
| **2 — Status cancellation** | **Partially closed by C2; ownership remains blocking (B1 below).** Registry/command reuse, early registration, cancellation-biased probe waits, frontend aborts and drop cleanup are now concrete. Existing `register` does **not** reject duplicates: it replaces the sender and signals the older request (`ai/cancel.rs:35–38`). C2 permits adding the check, so this is an implementation obligation, not existing behavior. The check and cleanup must also address reuse after cancellation. |
| **3 — Invalid native IDs** | **Closed at the planning-contract level by C3.** Absent/null/string replay and non-string/overlong rejection before tools remove the verbatim-replay contradiction. Result IDs are all-or-none, strings only; internal IDs stay local; same-name order and mixed-ID fixtures are explicit. The script covers the addendum's numeric/object/null/missing/string cases; array/bool/overlong and mixed batches remain implementation fixtures. Preserve raw assistant replay separately from internal protocol IDs. |

#### Prior should-fix disposition

| Item | Disposition |
| --- | --- |
| **Original 1 — Shared lookup cancellation** | **Closed in contract by A6' + C7.** Cache-owned work, detached waiters, global eight-lookup cap, entry ownership, panic cleanup and generation-before-cache lock order address the prior concerns. Include capability publication under that same order; snapshot/save serialization still uses `ai_providers_lock`. |
| **Original 2 — Frontend scope** | **Closed by A9' + C8.** Authoritative types/helpers, actual formatter location, fixed-code ordering, bilingual copy, stored/IPC validation and sensitive-suffix tests remain required. |
| **Original 3 — Result/output semantics** | **Closed by A5' + C3.** Error-result content survives; malformed response fixtures remain required; empty/nonempty `length` deliberately retain coordinator behavior and execute no tools. |
| **Original 4 — Endpoint/consent** | **Closed by A11 + C6/C7.** Origin/prefix confinement and unchanged grants/wires remain gates; bound-run cancellation plus request gates supply no-send protection. Dedicated probe client must preserve validation, redirects, plaintext proxy avoidance and localhost pinning with 1 s connect / 2 s total. |
| **Original 5 — Freshness/gates** | **Closed in contract by A11 + C8.** Upgrade detection is TTL/save-bound, smoke shares preparation and bounded generation overflow is explicit. No implementation gate has passed through this review. |
| **Additional — Error attribution** | **Not closed; C4 introduces B2 below.** Removing unconditional 413 classification is correct, but the claimed embedding-only message is also emitted by minimum-supported chat runners. |
| **Additional — Settings metadata** | **Closed by C5.** Native identity survives missing model/metadata, fixed copy avoids undefined values, effective size is clamped, model edits clear/re-query. Keep draft identity invalidation on auth edits too, as existing `updateConnection` does. |
| **Additional — Authoritative phase scope** | **Closed by C8 precedence.** Approval scope includes A1–A11 and both revisions, status command/UI and all added gates. Remaining obsolete bullets are editorial should-fix S1. |
| **Additional — Preparation terminals** | **Closed by C6.** Failure/deadline emit Error + Done(Failed); cancel emits only Done(Canceled); zero remaining budget sends nothing. Frontend event handling supports these sequences; unchanged `FALLBACK_CODES` plus C8's async regression preserves E1b. Failed channel delivery stops preparation and releases the run guard. |

#### Remaining blockers

1. **B1 — C2 must specify registration ownership across both status and discovery.** `CancelRegistry::cancel` removes the active entry immediately (`ai/cancel.rs:43–54`), and `finish(id)` blindly removes whatever now owns that id (`:59–61`). Interleaving: status A registers X; cancel X removes A's sender; discovery/status B registers X before A unwinds; A's drop guard calls `finish(X)` and removes B. B's receiver then closes and its work is canceled despite no cancel for B. Rejecting only *currently registered* duplicates does not cover this gap. Require atomic registration/rejection and ownership-safe cleanup: either retain canceled ownership until its guard finishes (reject reuse meanwhile), or return a registration token and finish only the matching token. Apply compatible ownership semantics to **both** commands using this shared registry; scope `ai/cancel.rs` and discovery changes explicitly. Test concurrent duplicate registration, cancel → re-register before old cleanup, old cleanup after replacement, early cancel, and normal success/error cleanup. A rejected duplicate must never finish the incumbent registration. Fresh frontend UUIDs reduce accidental collisions but do not establish the backend reuse contract C2 promises.

2. **B2 — C4 excludes a known chat overflow form at MIN_NATIVE.** The assertion that `the input length exceeds the context length` belongs only to embeddings is false for v0.12.6. Both [ollamarunner](https://github.com/ollama/ollama/blob/v0.12.6/runner/ollamarunner/runner.go#L125) and [llamarunner](https://github.com/ollama/ollama/blob/v0.12.6/runner/llamarunner/runner.go#L120) return that error when prompt truncation is disabled; their **completion** handlers return 400. [Completion transport](https://github.com/ollama/ollama/blob/v0.12.6/llm/server.go#L1393) preserves the status and trimmed body in `api.StatusError`; the [chat handler](https://github.com/ollama/ollama/blob/v0.12.6/server/routes.go#L2026) forwards that status/error into its nonstream response path. C4 would therefore turn known minimum-version prompt overflow into generic failure, contrary to the dedicated context-full contract. Add this evidenced 400 form to the classifier and transport-level fixtures alongside the reported newer numeric form; keep unrelated 400/413 generic. Correct the addendum's claimed v0.12.6 provenance for the numeric form. This is an error-contract/evidence blocker, **not** evidence that `truncate:false` fails to protect data.

#### Remaining should-fix (not independent approval blockers)

- **S1 — Consolidate obsolete scope bullets.** Despite explicit C8 precedence, `Phases` still says A1–A9 and `Files` still says transport reuse-only plus the nonexistent formatter module. Update or label them superseded; include registry/discovery work needed by B1. Keep older review history intact.
- **S2 — Bound evidence claims.** One qwen3 template's reported replay success is not proof for every supported template/version. Keep missing/null/string fixtures and live smoke as implementation gates; describe the addendum as reported local evidence. The broad claim that allowed IDs make every raw assistant replay decodable must still be read together with all A5 response-shape validation, not as a guarantee about arbitrary unknown nested fields.

**Approval exit:** resolve B1 and B2 in the plan, carry S1/S2 into the implementation handoff, then seek explicit human approval for Phase 1. No application implementation is authorized by this review; all build/runtime gates remain pending.


### Re-review — Revision 6

Codex, 2026-10-16. **Conclusion: READY for human approval of Phase 1.** No remaining approval blockers found in Revision 6. This is readiness of the planning contract, not implementation approval or verification. Status stays **DRAFT**; the existing authorization remains Phase 0 only. D1a, E1b and Plan 2's separate scope remain unchanged.

**Review basis:** read `AGENTS.md`, `.agent/WORKFLOW.md`, RTK guidance, the plan and Revision 5 findings; verified the current branch is `feat/ai-agent`. Inspected `src-tauri/src/ai/cancel.rs`, its register/finish/cancel callers in `commands/ai.rs`, and registry ownership in `state/app_state.rs`. Independently read tag-pinned upstream v0.12.6 sources through the web tool (terminal network fetch was unavailable). No application code changed; no generation probes, builds or tests run; no provider credentials, saved provider data, databases or real user data accessed. Local Phase 0 results remain Claude-reported evidence, not independently rerun results.

#### Disposition of B1, B2, S1 and S2

| Item | Disposition |
| --- | --- |
| **B1 — Cancel-registry ownership** | **Closed in the planning contract by D1.** Existing `register` supersedes the incumbent (`ai/cancel.rs:30–38`), `cancel` removes it (`:43–54`), and `finish(id)` unconditionally removes the current entry (`:59–61`). Discovery currently registers before validation/waiting and finishes explicitly after the awaited result (`commands/ai.rs:104–115`). D1 preserves supersession and early-cancel behavior, adds registration identity, and makes cleanup conditional on the matching token. Therefore A's stale cleanup cannot remove B after either cancel/re-register or direct replacement. Both discovery and status must adopt the token-aware drop guard; changing only the registry or status would be incomplete. D1 explicitly scopes both command guards and covers the required interleavings, concurrent supersession and success/error cleanup. The withdrawn duplicate-rejection policy is no longer an implementation requirement. |
| **B2 — Chat context-error classifier** | **Closed by D2.** HTTP 400 plus either the minimum-version runner prefix or the reported newer numeric form now maps to `AI_AGENT_CONTEXT_FULL`; unrelated 400/413/5xx stay generic. The v0.12.6 completion-to-chat forwarding chain independently confirms the first form (links below). D2 corrects the embedding-only and numeric-form provenance claims and requires transport-level positive/negative fixtures, newline handling and sensitive-suffix containment. Neither the numeric form nor 413 normalization is presented as independently established v0.12.6 chat behavior. |
| **S1 — Authoritative scope** | **Substantively closed; minor editorial cleanup remains below.** `Phases` now includes A1–A11 as amended by Revisions 4–6. D1/D3 explicitly include registry and both discovery/status callers, probe transport changes and the actual formatter location. Revision 6's precedence removes ambiguity about the intended implementation. |
| **S2 — Evidence scope** | **Closed by D4.** Local replay results are bounded to the reported 0.40.4/qwen3:4b environment. ID-field decodability is separated from whole-response validation; unknown nested fields have preservation fixtures, not a universal guarantee. Missing/null/string/invalid/duplicate/mixed ID fixtures and live smoke remain implementation gates. |

#### Pinned upstream verification

- Both v0.12.6 runners reject oversized input when truncation is disabled and return HTTP 400 from their **completion** handlers: [ollamarunner definition/overflow](https://github.com/ollama/ollama/blob/v0.12.6/runner/ollamarunner/runner.go#L108-L130), [completion mapping](https://github.com/ollama/ollama/blob/v0.12.6/runner/ollamarunner/runner.go#L792-L807); [llamarunner definition/overflow](https://github.com/ollama/ollama/blob/v0.12.6/runner/llamarunner/runner.go#L99-L124), [completion mapping](https://github.com/ollama/ollama/blob/v0.12.6/runner/llamarunner/runner.go#L567-L582).
- [Completion transport](https://github.com/ollama/ollama/blob/v0.12.6/llm/server.go#L1393-L1399) carries the runner status and trimmed body into `api.StatusError`. The [chat handler](https://github.com/ollama/ollama/blob/v0.12.6/server/routes.go#L2026-L2036) forwards those fields, and its [nonstream branch](https://github.com/ollama/ollama/blob/v0.12.6/server/routes.go#L2065-L2090) returns that status with an `error` string. This supports D2's HTTP 400 classification without relying on embedding normalization.

#### New blockers versus should-fix

**New blockers: none.**

**Should-fix — editorial only:** D2's definition line references are off: at tag v0.12.6, `errorInputTooLong` is at ollamarunner **L108** and llamarunner **L99**, not L114/L104. Use the pinned links above. The `Files` list still contains the nonexistent `hooks/formatAssistantRequestError.ts` entry despite D3/A9' superseding it; remove it or mark it historical. Expand `commands/ai.rs`'s parenthetical beyond save/delete to name discovery's token guard and status command. These do not block approval because D1/D3 and revision precedence already define the correct scope; keep prior review history intact.

**Implementation handoff:** allocate registration tokens and modify active entries atomically under the registry mutex; install each token-aware guard immediately after registration, before fallible validation or awaits. Retain D1's early-cancel and supersession regression tests for both command paths. Test D2 through the actual bounded native HTTP response parser, keeping provider text out of UI/logs in generic and recognized branches. No build/runtime gate has passed through this documentation review.

**Approval exit:** the human may now approve Phase 1 against A1–A11 as amended by Revisions 4, 5 and 6, including the remaining editorial corrections and all recorded implementation gates. This review itself grants no permission to implement, commit or push.
