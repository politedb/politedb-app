# Review: mac-app-store-flavor — Phase 2

## Status

VERIFIED

Reviewer: Codex. Date: 2026-10-11. Branch: `feat/mas-native-apis`; baseline: HEAD. Read AGENTS.md, RTK.md, WORKFLOW.md and PLAN.md, including “Phase 2 — Implementation evidence”. Reviewed every uncommitted tracked change and both untracked `src-tauri/src/platform/` files. Traced adjacent license identity, distribution URL policy and frontend query/save authentication gates. Only this report changed; no application edits, staging or commit. No P0 found.

## Findings

Historical round 1 findings below; both resolved in the re-review section. The latest verdict supersedes the original request for fixes.

1. **P1-1 — Windows/Linux builds lose the `Arc` import.** `src-tauri/src/main.rs:27`: deleting `StdCommand` left its macOS-only `#[cfg]` attached to `use std::sync::Arc`. The unconditional driver construction at lines 90–105 still uses `Arc`, so both Windows and Linux fail name resolution. An isolated Rust fragment using the exact current import reproduced E0412/E0433 with installed `aarch64-unknown-linux-gnu` and `x86_64-pc-windows-msvc` targets. **Fix:** make the `Arc` import unconditional. **Regression:** compile both non-macOS target paths; full native CI checks should cover both flavors.

2. **P2-2 — Empty authentication reason can terminate the desktop process.** `src-tauri/src/platform/macos.rs:105` (input at `commands/security.rs:10`): `Some("")` reaches `evaluatePolicy` unchanged. Apple explicitly documents `NSInvalidArgumentException` for an empty localized reason; an isolated Objective-C probe on this Mac confirmed the exception. The old Swift subprocess contained this failure outside PoliteDB and returned `TOUCH_ID_AUTH_FAILED: …`; the native call now exposes the desktop process to an uncaught Objective-C exception instead of returning an IPC error. **Fix:** reject empty reasons with the established authentication-error prefix before native invocation, or use the default reason for empty input; handle whitespace-only input consistently. **Regression:** `None`, empty, whitespace-only and normal reasons; invalid input must never reach the native evaluator or return authentication success. See [Apple evaluatePolicy documentation](https://developer.apple.com/documentation/localauthentication/lacontext/evaluatepolicy%28_%3Alocalizedreason%3Areply%3A%29) and the installed SDK `LAContext.h` warning.

## Memory, thread safety and compatibility assessment

- **`AuthContext` / unsafe Send:** the retained context stays alive across the await; the wrapper is private and not Sync, and the reply captures no context. Startup/preflight occur before suspension; timeout invalidation and destruction may occur on a different Tokio worker. No concrete concurrent Rust access or use-after-free found. However, the source assertion that Apple documents LAContext as usable from any thread was not substantiated by the inspected SDK header/binding. The reply’s unspecified queue does not itself prove the context’s full thread-safety contract. Document the precise cross-thread invalidate/release guarantee or confine these operations to one executor before broadening this wrapper. This is a safety-evidence limitation, not a demonstrated additional defect.
- **`RcBlock`:** only `Mutex<Option<oneshot::Sender<Result<(), String>>>>` is captured; this state supports callback execution/destruction on another thread. The block is heap-owned and the escaping evaluation retains/copies it; dropping the local handle before await is compatible with asynchronous delivery. NSError is borrowed only during the callback and converted immediately to an owned String. The mutex/take limits delivery to once; a late send after timeout is harmless. `RcBlock` being !Send alone does not establish a bug in this native escaping call. The binding explicitly requires a sendable reply; see [block2 thread-safety documentation](https://docs.rs/block2/0.6.2/block2/#thread-safety) and [Apple callback contract](https://developer.apple.com/documentation/localauthentication/lacontext/evaluatepolicy%28_%3Alocalizedreason%3Areply%3A%29).
- **IOKit/CF ownership:** matching dictionary ownership is consumed by `IOServiceGetMatchingService`; no second CFRelease is needed. Each nonzero service receives one `IOObjectRelease` immediately after the property read, including null-property/type-mismatch paths. The nonnull property uses the CF create rule and RAII; type-checked downcast does not leak or double-release it. Signatures agree with the installed IOKit headers. See [Apple matching-service ownership contract](https://developer.apple.com/documentation/iokit/1514535-ioservicegetmatchingservice).
- **License identity:** native IOPlatformUUID equals the previous ioreg parser output on this Mac; the hash/format and fallback seed are unchanged. Hostname equality test passes. Actual sandbox access to IOPlatformUUID remains unverified; a failure there would invoke the existing hostname/user/arch fallback and could change device identity between installations.
- **Version/alert/URL:** native version and minimum 13.3 comparison are consistent with the replaced paths. NSAlert requires a main-thread marker and is called from Tauri startup setup. NSWorkspace retains the existing distribution gate before opening. `FAILED_TO_OPEN_URL` prefix stays stable, but native details become `invalid url`/`no handler`; subprocess launch/status details intentionally disappear. Touch ID keeps DeviceOwnerAuthentication (including password fallback), the default reason, 30-second timeout and `TOUCH_ID_AUTH_FAILED` prefix. `TOUCH_ID_EXEC_FAILED` disappears with the removed compiler subprocess. Cancellation/preflight errors use localized NSError descriptions; timeout returns `Authentication failed.`.
- **Touch ID gating:** only successful native evaluation resolves `Ok(true)`; unavailable policy, failed reply, channel closure and timeout return Err. Timeout invalidates the context. Existing SQL, AI read and save callers await authentication and stop on rejection. No new fail-open path found. These gates remain the existing frontend workflow controls, not a newly introduced backend authorization boundary. The non-macOS command still rejects with `TOUCH_ID_UNSUPPORTED_PLATFORM`.
- **Cfg/dependencies:** platform module and native dependencies are macOS-only. Windows/Linux subprocess implementations are preserved apart from finding P1-1. Full native Windows/Linux application builds were not run.

## Verification / limitations

- `cargo test --offline platform::`, default and `--features app-store`: **3 passed each**, including UUID/hostname compatibility.
- `cargo test --offline macos_version_tests`: **3 passed**.
- Full `cargo test --offline`, default and `--features app-store`: **187 passed / 8 failed / 1 ignored each**. All eight failures are unchanged AI loopback fixtures at `ai/chat.rs:330` and `ai/transport.rs:96,159`, where socket bind returns `PermissionDenied: Operation not permitted` in this sandbox. They do not establish Phase 2 regressions; implementer’s 195-pass result was not reproducible here under these restrictions.
- Existing `AiAssistantMessageCard.test.tsx`: **4 passed**, including authentication-before-query ordering. No new tests/source changes made.
- Isolated `/private/tmp` probes: exact cfg import fails Linux/Windows metadata compilation; native empty-reason evaluation throws `NSInvalidArgumentException` (caught in the probe). These are focused reproductions, not full cross-platform builds or an end-to-end Tauri crash test.
- `git diff --check`: passed. Clippy, frontend builds and complete frontend tests not rerun for this backend-only review.
- Real Touch ID/password success, user/system cancellation, timeout dismissal, dropped-future cleanup, NSAlert UI, NSWorkspace runtime opening and signed sandbox device identity remain untested. Authentication outcome/timeout fixtures are absent; add focused coverage when fixing P2-2. No claim of MAS packaging or release readiness.
- Fix P1-1 and P2-2, record evidence in PLAN.md, then request Codex re-review. Workflow-required Claude security review remains necessary for the license-sensitive scope.

## Re-review — Phase 2 round 1 fixes (Codex, 2026-10-11)

Branch confirmed: `feat/mas-native-apis`. Read AGENTS.md, RTK.md, WORKFLOW.md and PLAN.md's “Phase 2 — Review round 1 fixes”. Re-reviewed the complete tracked uncommitted diff against HEAD and both untracked `src-tauri/src/platform/` files. Only this report edited; no source changes, staging or commit.

### Finding disposition

- **P1-1 — RESOLVED.** `src-tauri/src/main.rs:27`: `use std::sync::Arc` is unconditional. The surrounding removed macOS cfg no longer affects driver construction. Isolated metadata probes using the current import and `Arc::new` compile for installed `aarch64-unknown-linux-gnu` and `x86_64-pc-windows-msvc` targets. These prove the reported name-resolution defect is fixed, not that full applications build on those platforms.
- **P2-2 — RESOLVED.** `src-tauri/src/commands/security.rs:11`: `prompt_for` handles None, empty and whitespace-only input with the existing default, and trims a normal reason. `src-tauri/src/platform/macos.rs:125`: the native entry point rejects blank reasons before `start_owner_authentication`, so they cannot reach `LAContext` or return success. Both regression tests pass; the native rejection fixture runs without an authentication prompt. Nonblank IPC input still requires successful native evaluation.
- **Regressions — none found.** Rechecked macOS-only module/dependency selection, non-macOS identity/URL/unsupported-auth paths, device-ID hashing and fallback, URL distribution policy, startup version enforcement, CF/IOKit ownership and authentication completion/timeout handling. Existing behavior is preserved apart from the approved native replacements and blank-reason normalization. No new fail-open path found. The revised AuthContext comment removes the unsupported claim of an Apple-documented general threading guarantee; it does not independently establish that guarantee. The prior cross-thread invalidate/release safety-evidence limitation remains, with no concrete defect demonstrated.

### Independent verification and remaining limits

- `cargo test --offline --locked`, default and `--features app-store`: **189 passed / 8 failed / 1 ignored each**. The two new blank-reason tests, UUID/hostname comparisons, native version tests and existing license/distribution tests passed in both runs. All eight failures remain the same unchanged AI loopback fixtures (`ai/chat.rs:330`, `ai/transport.rs:96,159`), failing with socket-bind `PermissionDenied: Operation not permitted`. Claude's 197-pass result cannot be independently reproduced under this sandbox restriction; no new failure observed.
- `cargo test --offline --locked blank_`: **3 passed** (the two new regression tests plus an existing blank-input test). Linux/Windows isolated Arc metadata probes: **passed**. `git diff --check`: **passed**.
- Full Windows/Linux builds not independently run; the probes and cfg audit cover P1-1 only. Native CI remains required. Frontend builds/tests and clippy not rerun for these backend fixes; prior review evidence is retained above.
- Real Touch ID/password success, cancellation, timeout dismissal, dropped-future cleanup, NSAlert/NSWorkspace UI and signed MAS sandbox UUID access remain untested. Blank-reason fixtures address the reported crash but do not provide native outcome/timeout coverage. No MAS packaging or release-readiness claim. Workflow-required Claude security review still applies to this license-sensitive scope.

**Final verdict: VERIFIED.** P1-1 and P2-2 resolved; no additional actionable finding in the reviewed Phase 2 diff. Verification limits above remain explicit.

## D16 review

**Verdict: VERIFIED.** Reviewer: Codex. Date: 2026-10-11. No actionable finding in D16.

Scope: only PLAN.md “D16 — AI features are free” and the unstaged diff against the index in `src-tauri/src/commands/ai.rs`, `src-tauri/src/license.rs`, and `src/components/ai-assistant/hooks/useAiAssistantSubmit.ts`. The index contains the already-reviewed Phase 2 work; its VERIFIED verdict is unchanged. Read AGENTS.md, RTK.md and WORKFLOW.md. Only this section appended; no source edits, staging or commit.

- **Callers / dead code:** repository source search finds no remaining `ensure_ai_licensed`, `blocks_ai_feature`, `blocks_ai_feature_for` or `AI_LICENSE_REQUIRED` references. The unused license import and test-only `now_ms` helper are removed. `with_trial` remains used by the retained trial-policy tests. Frontend change removes only obsolete error classification; existing provider failures retain their handling.
- **License compatibility:** D16 does not change license load/save/clear, activation, refresh, expiry normalization, device identity or distribution policy. Load/save still finalize through `apply_trial_policy` and `apply_local_expiry`; clear still applies distribution trial policy. Direct trial dates/messages remain; App Store strips local trial dates and trial-expired messages while preserving unrelated errors. Remaining policy/expiry tests pass in both builds. App-wide trial UI is outside D16 and unchanged as explicitly required by the decision; this verdict does not claim unrestricted app access after trial expiry or completed IAP implementation.
- **Checks before requests:** chat still obtains config/key together under the provider lock through `snapshot_for_chat`, rejecting missing/disabled providers and missing required cloud keys before network I/O. Model presence is checked before completion. Draft Test still validates completion config and resolves its key before calling chat; its existing deliberate exception for disabled drafts is preserved, as is discovery's explicit draft exception. Keyless local providers retain their existing keyless contract. Every completion/discovery request still validates the final endpoint through `provider::endpoint` before sending; redirect rejection, HTTP proxy bypass and localhost pinning remain unchanged. Removing entitlement checks introduces no alternative transport or frontend fetch fallback.
- **Data exposure:** intended expansion is access to existing AI requests without a PoliteDB entitlement. Payload construction, selected provider/key ownership, keychain access, request destinations, error sanitization, logging and telemetry are unchanged. Draft probes still send only the existing short probe; no new fields, automatic requests or secret-return path added. No new data exposure found in D16.

Independent verification:

- `npm run build`: passed; existing Vite externalization, dynamic-import and chunk-size warnings remain.
- Focused Vitest run over `src/components/ai-assistant`, `src/lib/ai-assistant`, `src/lib/tauri/license.test.ts` and `src/lib/politedbBackend/ai.test.ts`: **12 files / 85 tests passed**.
- `cargo test --offline --locked`, default and `--features app-store`: **187 passed / 8 failed / 1 ignored each**. Retained license/trial/distribution tests, enabled/key checks and URL-policy fixtures pass. All eight failures are the unchanged loopback fixtures at `ai/chat.rs:330` and `ai/transport.rs:96,159`, failing on socket bind with `PermissionDenied: Operation not permitted`; no D16-specific failure found. PLAN.md's 195-pass result cannot be reproduced inside this sandbox.
- `git diff --check`: passed. No live provider request, signed App Store sandbox run or UI session performed; no command-level license-state matrix fixture added. Static command tracing and both compiled test flavors cover the removed gate and preserved pre-request checks, with live transport coverage limited by the socket restriction. Workflow-required Claude security review still applies to license-sensitive scope.
## Review: 17f6ec6 (Anthropic Opus 5.5 fix)

**Verdict: VERIFIED WITH LIMITATIONS.** Reviewer: Codex. Date: 2026-10-12. No P0/P1 or blocking defect found in the requested change.

Scope: `git show 17f6ec6` on `feat/mas-native-apis`, its three changed files, and adjacent completion callers, provider normalization, transport and error handling. Read AGENTS.md, RTK.md and .agent/WORKFLOW.md. Current HEAD is `7af083e`; the three reviewed files have no diff against `17f6ec6`, so local checks exercise the reviewed implementation. Only this report changed; no source edits, staging or commit. `src/components/ai-assistant/AiAssistantMessageParts.tsx` excluded from review and untouched.

### Findings and compatibility

- **Core fix correct:** payload omits all sampling parameters and omits missing/whitespace-only system content, while preserving nonblank system text and the existing system-message extraction/role mapping. Missing `thinking` is valid for Opus 5.5: adaptive thinking is automatic. Text extraction concatenates every text block in order, skips thinking and other block types, and retains the existing outer trim. See [official Opus 5.5 migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide). The user's successful real-API Test is accepted as user-supplied evidence, not independently repeated here.
- **Nonblocking compatibility/cost limitation — `src-tauri/src/ai/chat.rs:195`:** the 4096 floor applies to every Anthropic model, including older models without automatic thinking; it overrides explicit smaller limits. Probe allowance rises from 128 to 4096 (32x); absent-limit allowance rises from 1024 to 4096 (4x). Internal assistant budgets of 96–640 are also raised. These are larger permitted budgets, not guaranteed token consumption or proportional billing/latency increases: early stopping still applies. Thinking is billed as output, and nonstreaming responses provide no progress while thinking; the existing 180-second timeout remains. This meets the requested floor but does not preserve older-model cost caps. A follow-up should scope budget policy by model capability or explicitly document this provider-wide policy and benchmark actual usage/latency before treating 4096 as a tuned value.
- **Nonblocking older-model behavior change — `src-tauri/src/ai/chat.rs:193`:** omission remains API-compatible with older Claude defaults, but drops caller temperature (assistant 0.1, probe 0.0, previous fallback 0.2). Older-model output variability can change. This is an intentional consequence of the requested no-sampling policy, not evidence that older models reject the request. No live older-model quality comparison was performed.
- **Budget does not guarantee an answer — `src-tauri/src/ai/chat.rs:228`:** 4096 provides room for thinking plus text but cannot guarantee nonempty or complete output for arbitrary prompts. `stop_reason` remains unexamined: thinking-only output reaches existing generic empty-response errors; text truncated at `max_tokens` is returned as text. Follow-up: distinguish token exhaustion using a stable local error, without returning provider messages; add exhaustion fixtures. This is a pre-existing response-handling gap exposed by automatic thinking, not a demonstrated failure of the user-confirmed probe.
- **Model suggestions/default:** all four suggested IDs are documented; the new Sonnet default applies to new providers and blank-default fallback. Nonblank saved model IDs remain unchanged and older models remain manually selectable. Suggestions are not a whitelist. Context7 official SDK docs confirm Sonnet/Opus/Fable IDs; [official Haiku 5.5 overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview) confirms Haiku and compares all four models. Availability for individual accounts was not tested. Removing older suggestions reduces discoverability but does not migrate saved configurations.
- **Other providers:** OpenAI-compatible/Groq/Gemini payloads, dispatch, headers, endpoints, timeouts and suggestions are unchanged. Anthropic's floor and sampling omission do not reach OpenRouter or other adapters, including Claude selected through OpenRouter. No new regression found outside Anthropic; this commit does not claim to add Opus 5.5 compatibility through every intermediary.
- **Provider-error redaction preserved:** `provider_http_error` changes only by a comment. HTTP errors still expose status and a filtered, bounded code/type/status; `/error/message` and raw response bodies are never returned or logged by this path. Anthropic authentication/version headers and the shared validated transport remain unchanged. Existing SQL-echo redaction test passes. This is preservation of the existing code-only contract, not proof that a malicious provider cannot embed data in its code field; character filtering is not semantic redaction. No new leakage path found.

### Verification and coverage limits

- `npm run build`: passed; existing browser externalization, dynamic-import and chunk-size warnings remain.
- Focused Vitest: `src/lib/ai-assistant`, `src/lib/tauri/ai.test.ts`, `src/lib/politedbBackend/ai.test.ts`: **8 files / 50 tests passed**, including all **12 provider tests** (also run separately).
- `cargo test --offline --locked ai::chat::tests`: **6 passed / 3 failed**. Both new Anthropic tests, model-list parser/cap tests, provider-error redaction and pre-request policy rejection passed. Three unchanged loopback fixtures fail at `chat.rs:354` because socket bind returns `PermissionDenied: Operation not permitted`; network integration could not be independently verified under this sandbox. No new assertion failure found.
- New tests cover sampling omission (`temperature`, `top_p`), no-system probe, floor, explicit model, nonblank system extraction, preservation of a larger limit, concatenated text after thinking and empty content. Missing assertions/fixtures: `top_k`, whitespace-only system, absent max_tokens/default-model fallback, legacy Claude payloads, mixed user/assistant history, malformed/redacted-thinking blocks, `stop_reason: max_tokens`, and Anthropic-style `/error/type` with a sensitive `/error/message`. Add focused fixtures in a follow-up; current generic redaction fixture only uses `/error/code`.
- No live API calls, account/model availability checks, UI session, cost/latency measurements or full Rust suite performed. User-confirmed Test supports the actual Opus 5.5 probe; it does not establish older-model quality, complex-prompt completion or cost behavior. Verdict approves the requested compatibility fix with these explicit limits.


## Review: 7af083e (HEAD)

**Verdict: VERIFIED WITH LIMITATIONS.** Reviewer: Codex. Date: 2026-10-12. No new actionable finding in the amendment; prior `17f6ec6` findings and limitations remain applicable.

Scope: read AGENTS.md, RTK.md and .agent/WORKFLOW.md; inspected `git show 7af083e`, `git diff 17f6ec6 7af083e`, the preceding review, shared Button/class merging and adjacent assistant controls. HEAD confirmed as `7af083eeea65ea79dffd41bb297bbe8af39f3f0d` on `feat/mas-native-apis`. Preserved the existing uncommitted REVIEW.md content; only this section appended. No source edits, staging or commit.

- **Amendment identity:** both commits have parent `9072397529608ffabdddaf5730bb529b9ec17f69`. The entire tree delta is exactly two additions of `text-xs` to Run/Insert classes in `src/components/ai-assistant/AiAssistantMessageParts.tsx:151,161`. An exit-code-0 comparison excluding that file proves every other tracked file is identical, including all three files reviewed under `17f6ec6`. The earlier review's exclusion of MessageParts is covered here; its Anthropic assessment is retained rather than independently repeated.
- **Visual consistency:** Run and Insert now use identical `px-2 py-1 text-xs` sizing, matching their SQL Preview header and compact preview text. Exercising installed `twMerge` confirms `text-xs` replaces shared Button's `text-sm`, while preserving padding and other styles. The legacy “Insert into editor” button remains `text-sm` through Button's default; this separate legacy presentation is unchanged and is not claimed to match the new compact actions.
- **Accessibility / regressions:** native button semantics, visible Run/Insert names, focus behavior, colors, padding, handlers, read-only/connection gates and loading/disabled logic are unchanged. The font/line-height reduction also reduces intrinsic button dimensions; no static evidence of a new blocking target-size issue found. No new request, state mutation or authorization path. Existing tests exercise named Run lookup, successful result rendering, absent-connection and mutating-SQL hiding, and authentication before production reads.

Independent verification:

- `npm run build`: **passed**. Browser externalization, ineffective dynamic-import and large-chunk warnings remain; no build/type error.
- `npm run test:run -- src/components/ai-assistant src/lib/ai-assistant src/lib/tauri/ai.test.ts src/lib/politedbBackend/ai.test.ts`: **11 files / 82 tests passed**, including all four SQL-preview component regressions.
- `git diff --check`: **passed**. Application source/package files have no working-tree diff against HEAD.
- No rendered desktop/browser inspection, zoom/keyboard/contrast audit or new Insert-specific fixture performed. Visual consistency is verified from source and actual class merging, not a screenshot; tests do not establish rendered geometry or comprehensive accessibility. No Rust rerun: backend tree is identical to the prior reviewed commit, whose socket-bind restrictions, API/coverage and cost/behavior limitations remain recorded above.

## Review: f52fd48 (Anthropic follow-up)

**Verdict: CHANGES REQUIRED.** Reviewer: Codex. Date: 2026-10-12.

Scope: read AGENTS.md, RTK.md, .agent/WORKFLOW.md and both preceding Anthropic reviews; inspected the complete `git show f52fd48`, adjacent provider dispatch, command validation/cancellation and assistant error handling. HEAD is `f52fd48d801e383cc0c0039c41fc401d06fa5ed4` on `feat/mas-native-apis`. Only this review appended; no application source edits, staging or commit.

### Required finding

- **P2 — `src-tauri/src/ai/chat.rs:250-257`: nonempty refusals bypass `AI_CHAT_REFUSED`.** The refusal branch is inside `if text.is_empty()`. A response containing a text block and `stop_reason: "refusal"` returns success, so the assistant never displays the new refusal message and downstream completion consumers can treat declined/partial output as a completed answer. Anthropic documents exactly this response shape with a nonempty text block in [Handle streaming refusals](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/handle-streaming-refusals). An isolated Rust harness compiled the commit's exact `anthropic_text` function and reproduced `Ok("Hello..")` for that fixture. Check `stop_reason == "refusal"` independently of text emptiness and return the fixed `AI_CHAT_REFUSED` code; add a nonempty-refusal regression alongside the empty fixture. Keep provider `stop_details.explanation`, messages and partial content out of the error. This is incomplete fulfillment of the requested refusal mapping, not a claim that ordinary successful answer text must be redacted.

### Four-limitations assessment

1. **Budget scope resolved for supported direct IDs:** the 4096 floor applies only to parsed versions >= (4, 7) and unknown IDs; explicit larger budgets survive. Older direct Claude versions preserve smaller limits. The [official Opus 5.5 migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide) explicitly identifies non-default sampling rejection as beginning with Opus 4.7. The numerical policy is intentionally applied across model families and unknown IDs; that guide alone does not establish every future family's thinking capability. The floor remains a chosen allowance, not a measured guarantee of completion or cost/latency.
2. **Older-model request behavior restored:** parsed <4.7 models receive caller temperature and max_tokens, with previous 0.2 / 1024 defaults when absent. Probe retains 0.0 / 128; assistant budgets such as 96 are no longer raised for those IDs. System extraction, role mapping and message content remain unchanged; blank model overrides now correctly fall back to the configured model.
3. **Stop reasons partially resolved:** empty/whitespace or thinking-only `max_tokens` responses return `AI_CHAT_OUTPUT_TOKEN_LIMIT`; empty refusals return `AI_CHAT_REFUSED`, and frontend recognizes that code in English/Vietnamese. Nonempty refusals remain unresolved as above. Nonempty `max_tokens` output deliberately remains successful, matching the existing OpenAI-compatible behavior and the new explicit regression fixture; it has no truncation notice. This review does not interpret the earlier empty-answer limitation as requiring rejection of all partial text.
4. **Coverage substantially expanded, incomplete refusal case:** six Anthropic-focused Rust tests cover version parsing, both payload policies, top_k omission, whitespace system omission, blank-model fallback, absent budget, history roles, redacted thinking, empty stop reasons and Anthropic `/error/type` redaction. New frontend test verifies English/Vietnamese refusal wording and token-limit wording. The amendment removes the previous nonblank-system assertion; nonblank system extraction is unchanged and statically checked. Missing nonempty-refusal coverage permits the required finding.

### ID parser and redaction

- **Direct API formats:** checked dated `claude-3-5-sonnet-20241022`, `claude-3-7-sonnet-20250219`, `claude-3-opus-20240229`, `claude-sonnet-4-20250514`, modern `claude-opus-4-6`, `claude-opus-4-7`, and minorless `claude-opus-5`; also historical `claude-3-5-sonnet-latest` / `claude-3-opus-latest` aliases and modern short aliases. Numeric extraction handles both 3.x ordering and name-first ordering; eight-digit dates are ignored and omitted minor means zero. [Model IDs and versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions) confirms dated IDs, short aliases and pinned dateless IDs.
- **Cloud/proxy limitation, nonblocking for current adapters:** Bedrock `anthropic.claude-3-5-sonnet-20241022-v2:0` and region-prefixed `us.anthropic.claude-opus-4-6-v1` return None and therefore use the documented unknown-ID floor/omission policy. Vertex `claude-sonnet-4-5@20250929` parses as (4, 0), losing its minor segment because it includes `@date`; its old/new classification remains correct for this actual 4.5 ID. `claude-3-5-sonnet-v2@20241022` parses (3, 5). No native Bedrock signing/runtime or Vertex OAuth/predict adapter exists in provider dispatch: Anthropic sends Messages API with x-api-key and anthropic-version; OpenRouter remains a separate OpenAI-compatible adapter. Do not claim older-model preservation for arbitrary proxy aliases or cloud IDs. Normalize provider-specific IDs before capability detection if that support is added.
- **Redaction invariant preserved:** unchanged `provider_http_error` returns only HTTP status and filtered/bounded code/type/status; never `/error/message` or raw bodies. New stop-reason errors are fixed literals; thinking/redacted_thinking and stop_details are not returned by error paths. Anthropic SQL-echo fixture and existing generic redaction fixture pass. No new logging, telemetry, key/URL exposure or transport-policy change. Existing caveat remains: character filtering cannot semantically redact a malicious provider's code field.

### Independent verification

- `npm run build`: passed; existing externalization, dynamic-import and chunk-size warnings remain.
- Focused frontend suite (`src/components/ai-assistant`, `src/lib/ai-assistant`, Tauri/backend AI wrappers): **12 files / 83 tests passed**. New formatter test also passed separately.
- `cargo test --offline --locked ai::chat::tests`: **10 passed / 3 failed**. All six Anthropic-focused tests passed. Three unchanged loopback tests fail at `chat.rs:394` with socket-bind PermissionDenied / Operation not permitted; environment restriction, not a commit defect.
- Temporary offline Rust harness under `/private/tmp` compiled exact parser/refusal functions from reviewed source and confirmed ID classifications and the nonempty-refusal reproduction above. No repository source changed for the harness.
- `git diff --check`: passed before report append. No live provider call, desktop UI session, full Rust suite or app-store flavor rerun; transport/live-provider and actual cost/latency remain unverified.

Next: Claude fixes the refusal branch and adds the nonempty fixture, records verification, then requests Codex re-review. No change needed to the documented 4.7 sampling threshold.

## Re-review: f52fd48 refusal fix

**Verdict: VERIFIED WITH LIMITATIONS.** Reviewer: Codex. Date: 2026-10-12. Prior P2 resolved; no new findings.

Scope: read AGENTS.md, RTK.md and .agent/WORKFLOW.md; reviewed the uncommitted `src-tauri/src/ai/chat.rs` diff against HEAD and adjacent response parsing/provider dispatch and frontend error formatting. Only this report appended; no source edits, staging or commit.

- **P2 resolved — `src-tauri/src/ai/chat.rs:251-259`:** refusal is checked independently of text emptiness. Both empty and nonempty refusals return exactly `AI_CHAT_REFUSED`; partial text and `stop_details.explanation` cannot enter the error. The added nonempty fixture asserts that exact code and would fail on the previous implementation.
- **Regression review:** text concatenation, trimming and thinking/redacted-thinking filtering are unchanged. Empty `max_tokens` output retains `AI_CHAT_OUTPUT_TOKEN_LIMIT`; nonempty `max_tokens` output remains successful. Ordinary `end_turn` output and empty content without a stop reason retain their previous results. Existing fixtures cover these adjacent paths. Payload policy, model parsing, transport, other providers and frontend wording are unchanged; the existing English/Vietnamese refusal formatter still recognizes the fixed code.

Independent verification:

- `cargo test --offline --locked ai::chat::tests`: **10 passed / 3 failed**. The response regression and all other non-network chat tests passed. Three unchanged loopback fixtures fail at `chat.rs:393` because socket bind returns `PermissionDenied: Operation not permitted`; no assertion regression observed.
- Same Rust command with the three loopback fixtures explicitly skipped: **10 passed / 0 failed**.
- `npm run test:run -- src/components/ai-assistant/hooks/formatAssistantRequestError.test.ts`: **1 file / 1 test passed**, including English/Vietnamese refusal and token-limit wording assertions.
- `git diff --check`: passed. No live provider call, desktop UI session, frontend build or full Rust suite rerun for this backend-only fix. Loopback transport remains unverified in this sandbox; prior broader-review limitations remain applicable.

The refusal fix is verified within this scope; the prior required P2 no longer blocks handoff.


## Review: 173e36c (assistant header)

**Verdict: CHANGES REQUIRED.** Reviewer: Codex. Date: 2026-10-12.

Scope: read AGENTS.md, RTK.md and .agent/WORKFLOW.md; reviewed complete `git show 173e36c`, message body/placeholder, floating container, session timing and adjacent submission paths. HEAD is `173e36c01d629a173c21c258752cae88fbc56303` on `feat/mas-native-apis`. Only this report appended; no source edits, staging or commit.

### Finding

- **P2 — `src/components/ai-assistant/AiAssistantMessageCard.tsx:199`: new duration text has insufficient contrast.** `text-xs text-neutral-400` renders 12px informative text on the floating launcher's white background (`FloatingAssistantLauncher.tsx:120`). Built CSS resolves neutral-400 to `oklch(70.8% 0 0)`, yielding approximately **2.59:1** contrast; small text needs **4.5:1**. Use `text-neutral-500` (approximately **4.73:1** on white) or darker while retaining the compact size. Existing panel duration/timestamps use the same pale color, but this commit newly introduces it for floating duration; this finding targets the added line.

### Message-state correctness

- **Streaming empty/whitespace:** no static Thought/chevron or duration header; existing body placeholder shows Thinking..., retaining `aria-busy="true"` and `aria-live="polite"`. A stale durationMs is suppressed while streaming.
- **Streaming with text:** no header or duration; existing body renders partial answer text and removes Thinking.... Thus “only Thinking...” describes the empty streaming placeholder, not suppression of streamed answer text. Rendering of parts/SQL/results is unchanged. Existing synthetic empty-text messages with populated parts can show placeholder plus parts; this is pre-existing, not introduced here.
- **Completed with duration:** one floating duration line above the body; existing formatDuration hides absent/zero/negative/<1000ms values and rounds seconds at >=1000ms (4200ms -> Worked for 4s). Minute/hour formatting is reused unchanged. There is no duplicate floating duration because panel markup is gated by !floating.
- **Completed without duration or under 1s:** no header; answer remains visible. Empty completed messages have no Thinking... placeholder. Duration remains informational, with no expand affordance or interaction.
- **Errors:** role=assistant error messages follow the same timing gate; error body/parts remain intact, and duration describes elapsed attempt rather than successful completion. Error styling and handling are untouched; no new error masking or success-state mutation.
- **Non-floating/user presentation:** panel role label, duration, body and hover actions unchanged; floating user messages never receive duration/assistant header. No handlers, focusable elements, keyboard behavior, copy names or SQL safety gates changed. Removed Thought/chevron were plain spans, not an accessible disclosure control. New timing line is ordinary text, not a live announcement.

### Verification and coverage limits

- `npm run test:run -- src/components/ai-assistant src/lib/ai-assistant src/lib/tauri/ai.test.ts src/lib/politedbBackend/ai.test.ts`: **12 files / 84 tests passed**.
- `npm run build`: **passed** (TypeScript and Vite). Existing browser externalization, ineffective dynamic-import, chunk-size and plugin timing warnings remain.
- `git diff --check`: **passed** before report append. Source tree matches reviewed commit.
- Added test covers empty streaming and completed 4200ms only, using separate mounts. It does not prove an in-place streaming-to-completed transition, streaming with text/stale duration, absent duration, 999/1000ms boundary, minute/hour formatting, errors, panel or user presentation. Add focused render/rerender fixtures for these states; missing tests are coverage limitations, not evidence of another runtime defect.
- Visual/accessibility assessment uses source plus generated CSS and calculated contrast. No rendered desktop/browser session, zoom/geometry inspection or screen-reader session performed; those remain unverified. No Rust checks needed for this frontend-only diff.

Next: Claude darkens the added duration text, adds focused state regressions, records verification and requests re-review.


## Re-review: 173e36c contrast fix

**Verdict: VERIFIED WITH LIMITATIONS.** Reviewer: Codex. Date: 2026-10-12. The assistant-header P2 is resolved; no new findings in the fix.

Scope: read AGENTS.md, RTK.md and .agent/WORKFLOW.md; re-reviewed the uncommitted `git diff` in AiAssistantMessageCard.tsx and AiAssistantMessageCard.test.tsx against HEAD `173e36c01d629a173c21c258752cae88fbc56303`, plus the original finding and floating container. Preserved the existing review content; only this section appended. No source edits, staging or commit.

- **Contrast fix verified:** the sole runtime change replaces `text-neutral-400` with `text-neutral-500` on the floating assistant duration line. Production CSS resolves `--color-neutral-500` to `oklch(55.6% 0 0)` and `.text-neutral-500` to that variable. Against the launcher's `bg-white`, calculated contrast is **4.732:1**, exceeding the **4.5:1** small-text threshold. Compact size and font weight remain unchanged.
- **Focused regressions verified:** same mounted card rerenders from empty streaming to completed (`Thinking...` disappears; `Worked for 1m 5s` appears). Fixtures suppress duration for streaming text with stale duration, absent duration and 999ms, and show it at 1000ms. Panel keeps its role label and exactly one duration; floating user messages receive no duration. Existing SQL-preview tests retain read-only execution, connection gating, mutating-query suppression and production authentication ordering. Timing gates, formatting, body rendering, actions and SQL safety code are unchanged.
- `npm run test:run -- src/components/ai-assistant src/lib/ai-assistant src/lib/tauri/ai.test.ts src/lib/politedbBackend/ai.test.ts`: **12 files / 87 tests passed**.
- `npm run build`: **passed** (TypeScript and Vite). Browser externalization, ineffective dynamic-import, chunk-size and plugin timing warnings remain.
- `git diff --check`: **passed** before and after report append.
- **Limitations:** contrast assessed from source and generated CSS; no rendered desktop/browser, zoom/geometry or screen-reader inspection performed. Tests do not directly assert the color class/contrast, preservation of partial answer text, hour formatting or error-message presentation. These are nonblocking coverage limits for this one-class fix; no behavior change was found in those paths. Existing panel duration contrast remains outside this finding's scope. No Rust checks needed for this frontend-only diff.

Next: contrast fix is ready for commit when requested by the human.


## Review: legacy-webkit-storage Phase 1

**Verdict: CHANGES REQUIRED.** Reviewer: Codex. Date: 2026-10-14.

Scope: read `AGENTS.md`, `.agent/WORKFLOW.md`, RTK instructions and `.agent/plans/legacy-webkit-storage.md` (IMPLEMENTED), then reviewed the complete uncommitted diff on `fix/legacy-webkit-storage` against `b74100b557f9b46ab9526c7231267be6f006f818`, plus all five requested untracked paths. `.claude/launch.json` excluded. Application code unchanged; only this review appended. No real stores under `~/Library/WebKit` accessed, no ignored real-store tests run, and no real user values printed.

### Findings, ranked

1. **P1 — `src/main.tsx:26`: unavailable localStorage can abort desktop startup.** `window.localStorage` is evaluated while constructing the arguments, outside the helper's try/catch. When the browser storage getter throws `SecurityError`, `boot()` rejects before theme setup, persistent restore and `render()`, leaving the app blank. The existing unavailable-storage test only supplies an object whose methods throw; it does not exercise this getter. Synthetic execution of the exact call shape confirms rejection before the helper guard. Acquire storage inside a guarded startup path (or inject a guarded accessor), skip migration on failure, and test that boot continues to render. This violates R4's requirement that migration failure never prevent normal startup.

2. **P2 — `src/lib/legacyWebStorage.ts:81-85`: a failed write permanently completes an incomplete import.** The catch ends the entire entry loop, then writes the success marker. A single large chat exceeding remaining localStorage quota can prevent smaller settings/groups/pins later in the response from being attempted, and later launches never retry even after storage becomes available. A synthetic throwing `setItem` reproduced `first=done`, marker present, later group absent, and only one backend read across two invocations. Handle failures per entry so later small entries still get a chance; route incomplete imports through the bounded failure/attempt policy rather than marking them successful. Preserve already written values and arrange the reload needed for module-time readers after partial success. Add first-entry failure and partial-write regressions, including recovery on a later launch. R3 specifies no completion marker on error before the three-attempt give-up limit.

3. **P2 — `src-tauri/src/legacy_web_storage/webkit.rs:47-48,58-59`: parent symlinks bypass the source-selection boundary.** `symlink_metadata` checks only the final database component. A symlinked `inner/LocalStorage` directory or the entire flat-layout directory therefore resolves to an outside regular database and is accepted. A temporary Rust harness importing the exact production module returned one imported entry for each synthetic symlink case. The existing regression covers a symlinked hash folder and a symlinked database file, leaving these parent cases uncovered. Check each traversed storage-directory component before reading/copying (including the flat root), and add these two fixtures. R1 requires discovery without following symlinks; this is a boundary violation, not evidence that the original database is written.

4. **P2 — `src-tauri/src/legacy_web_storage/mod.rs:388-392`: real-store smoke test logs raw storage keys.** Although ignored by default, this checked-in test explicitly reads the actual legacy store and prints every restored key when run as documented. Dynamic chat/model key suffixes contain persisted identifiers; R1 permits counts/error kinds only and explicitly prohibits logging keys. Remove the key listing and retain counts or use synthetic fixtures for key assertions. This finding comes from source inspection; the real-store test was not executed.

### Independent verification

- `cargo test --offline --locked legacy_web_storage`: **15 passed / 1 ignored**. Synthetic WebKit/WAL and Chromium/snappy fixtures pass; real-store smoke stays ignored.
- `npm run test:run -- src/lib/legacyWebStorage.test.ts`: **8 passed**.
- `npm run test:run`: **117 files / 659 tests passed**.
- `npm run build`: **passed**, including TypeScript. Browser externalization, ineffective dynamic-import, large-chunk and plugin-timing warnings emitted in existing modules.
- `cargo clippy --offline --locked --all-targets` and the same command with `--features app-store`: **passed**, with warnings reported in existing unchanged code; no new legacy-storage diagnostic reported.
- `cargo test --offline --locked`: **208 passed / 8 failed / 2 ignored**. All eight failures are unchanged AI chat/transport loopback tests whose socket bind returns `PermissionDenied: Operation not permitted` (`src/ai/chat.rs:393`, `src/ai/transport.rs:96,159`). Full-suite verification is limited by sandbox networking; focused migration tests pass.
- Temporary harnesses under `/private/tmp/politedb-storage-review` execute the transpiled production TypeScript helper and import the production Rust module directly. They reproduce findings 1–3 using in-memory storage and throwaway SQLite files only; no repository application/test edits required.
- `git diff --check`: **passed** before report append.

### Scope and remaining limitations

- Exact allowlist amendment, frontend fill-only checks, timeout handling, backend fixed error mapping, private scratch cleanup, App Store early return, Windows-only pinned production dependency plus cross-platform dev dependency, and unchanged `data_migration.rs` reviewed. No new source write path found in either reader. Dependency review covers manifest/lock changes and exercised parser behavior; no external vulnerability audit performed.
- Provider selection already falls back selected → enabled default → first enabled; restored legacy chat snapshots use the existing parser. `chatOwners`/`dataRead` purge behavior is absent on this branch, matching the plan's stated limitation; integration with the unmerged agent branch is not verified.
- Windows/Linux target builds and real upgrade runs not performed. Synthesized fixtures do not establish real WebView2/WebKitGTK interoperability. The plan records the user's acceptance of missing real Windows/Linux probes; this is a limitation rather than a new required finding.
- No desktop launch/manual upgrade performed: it would access the real user stores. The implementer's recorded macOS smoke/manual evidence was read, not independently repeated.
- Non-Tauri boot skips the migration call but does not set the web marker requested by R3; no native read/reload occurs, so recorded as a minor plan deviation rather than a separate blocking defect. The planned reader trait is represented by a cfg-dispatched enum; platform branching remains centralized.

Next: Claude fixes findings, records focused regressions, and requests Codex re-review. Data migration also requires Claude's security-review pass under `.agent/WORKFLOW.md` before handoff is complete. No staging or commit performed.

## Re-review: legacy-webkit-storage Phase 1 round 2

**Verdict: VERIFIED WITH LIMITATIONS.** Reviewer: Codex. Date: 2026-10-14. All four prior findings resolved; no new P0/P1/P2 findings.

Scope: read `AGENTS.md`, `.agent/WORKFLOW.md`, RTK instructions, the Phase 1 review and the plan's `Fixes for Codex review round 1`. Reviewed the current uncommitted diff against `b74100b557f9b46ab9526c7231267be6f006f818` on `fix/legacy-webkit-storage`, plus all requested untracked reader, command, frontend helper/test and wrapper files. `.claude/launch.json` excluded. Only this report appended; no application-code edits, staging or commit. No real stores under `~/Library/WebKit` accessed or printed; ignored real-store smoke test not run.

### Prior finding dispositions

1. **P1 resolved — `src/main.tsx:29`, `src/lib/legacyWebStorage.ts:66`: throwing storage getter.** Startup passes an accessor; acquisition and marker lookup now execute inside the helper's guard. A `SecurityError` returns `done` without a backend read, allowing boot to reach its existing setup/render path. Added regression exercises a throwing accessor as well as throwing storage methods. Theme/font/density and module-time shortcut reads retain their existing guards. Actual full boot/render with a throwing getter was not exercised; helper behavior and call-site wiring verified separately.
2. **P2 resolved — `src/lib/legacyWebStorage.ts:84-109`: incomplete import marked successful.** Each entry has its own guard; failed entries no longer suppress later writes. Incomplete imports count toward the three-attempt give-up policy without a success marker. Partial writes return `restored`, so module-time readers reload from restored values; subsequent imports skip those values. Tests verify first-entry failure with a later successful write, recovery on the next invocation, three incomplete attempts, preservation of existing values, and no repeated reload when the marker alone is unwritable. Marker-write failure also records an attempt. If storage cannot persist either marker or counter, attempts cannot be durably bounded; no-write invocations still request no reload.
3. **P2 resolved — `src-tauri/src/legacy_web_storage/mod.rs:148-159,196-209`, `src-tauri/src/legacy_web_storage/webkit.rs:54-56`: parent symlink boundary.** Both reader variants now validate the identifier root and every directory down to their source layout; WebKit additionally rejects symlinked `inner/LocalStorage`. Synthetic fixtures reject the two reported cases, symlinked general/root directories, and a symlinked Chromium leveldb directory. Regular-store and WAL fixtures still pass. Checks are metadata-based; concurrent hostile directory replacement is not tested or made atomic by this fix.
4. **P2 resolved — `src-tauri/src/legacy_web_storage/mod.rs:412-428`: smoke test logs storage keys.** Source inspection confirms only entry/skipped counts are printed; raw-key loop removed. Test remains ignored and was not executed.

The minor non-Tauri R3 deviation is also resolved: boot supplies an empty read function outside Tauri, setting the marker through the same helper without native invocation. This wiring was checked statically; no dedicated non-Tauri boot integration test exists.

### Independent verification

- `npm run test:run -- src/lib/legacyWebStorage.test.ts`: **1 file / 10 tests passed**.
- `cargo test --offline --locked legacy_web_storage`: **17 passed / 1 ignored**. Tests use throwaway SQLite/WAL and LevelDB/snappy stores, including source-preservation and symlink regressions.
- `npm run test:run`: **117 files / 661 tests passed** in this run; no frontend failure reproduced.
- `npm run build`: **passed**, including TypeScript. Existing browser externalization, ineffective dynamic-import, chunk-size and plugin-timing warnings remain in unrelated modules.
- `cargo clippy --offline --locked --all-targets` and the same command with `--features app-store`: **passed**. Reported warnings concern unchanged MySQL, credential-identity and export code; none reported in the new migration modules.
- `git diff --check`: **passed** before report append.

### Remaining limitations and handoff

No desktop launch/manual upgrade, real-store smoke, Windows/Linux target build, real WebView2/WebKitGTK probe, or full Rust suite rerun. The focused Rust suite and both macOS Clippy flavors pass; previous full-suite loopback restrictions and accepted Windows/Linux interoperability limitations remain. Synthetic fixtures establish the tested reader behavior, not real upgrade compatibility. Integration with `chatOwners`/`dataRead` on the unmerged agent branch remains unverified. No external dependency vulnerability audit performed.

Codex re-review is complete within this scope. Claude's security-review pass remains required by `.agent/WORKFLOW.md` for data migration before handoff is complete; this verdict does not attest that pass occurred. Commit only when requested by the human.

## Review: keychain-service-rename Phase 1

**Verdict: VERIFIED WITH LIMITATIONS.** Reviewer: Codex. Date: 2026-10-14.

Reviewed commit `3dd0bec34e832a89ecebadce94af14547edf0f8b` on `fix/keychain-service-rename`, against `main` / `b74100b557f9b46ab9526c7231267be6f006f818`. Read `AGENTS.md`, `.agent/WORKFLOW.md`, RTK guidance and `.agent/plans/keychain-service-rename.md` first. Reviewed `git show 3dd0bec` and the complete base-to-commit diff, including ignored native-test code; traced production keychain entry points and the unchanged adapter's storage fallback. Application sources match the reviewed commit. Only this review appended; unrelated `.claude/launch.json` preserved. No application edits, staging or commit.

### Findings, ranked

- **P0: none found.**
- **P1: none found.**
- **P2 — Missing regression for the synchronization boundary.** `src-tauri/src/security/secrets.rs:28`; test setup `src-tauri/src/security/credential_store.rs:342`. All store tests instantiate `CredentialStore` directly with a `RefCell` fake, bypassing `MAC_STORE_LOCK`. The existing migration hooks exercise add/reread races, but none proves the R7 case: delete waiting while get has read an old value and is about to add it. Removing or shortening the production lock would leave the entire current suite green. Add a deterministic threaded test using a thread-safe fake and barriers/channels through the same synchronization boundary: pause get after the previous/legacy read, start delete, finish migration, then assert delete completes with all profile namespaces absent and no subsequent resurrection. Cover both migration sources and logical aliases of the same credential. This is a nonblocking coverage gap; inspection found the present lock correctly spans each complete production store operation.

### Migration and compatibility assessment

- Read order is current `PoliteDB` → previous `com.politehq.politedb` → legacy `politedb` aliases. Only genuine not-found advances the chain. Previous reads disable storage upgrade; add failure retains the source and returns its usable value. `AlreadyExists` returns the authoritative current reread or its error without retry/re-add.
- Previous retirement occurs only after this call reports `Added` and a reread equals the copied value. Failed verification or deletion retains the previous item; messages contain no account or secret. Successful set writes the current namespace before best-effort previous cleanup, as allowed by R6. Legacy aliases retain their existing policy.
- Delete attempts both branded services and every recognized legacy alias, retaining the first error while continuing cleanup. List deduplicates logical credentials and surfaces previous-service errors. Unsupported previous accounts remain ignored. Custom UUID-shaped physical accounts remain unmapped under `politedb`; `_database` support is not reintroduced. Logical SecretRefs, profile/export formats and non-macOS storage remain unchanged.
- All production get/set/delete/list/optional-read calls enter `mac_store_call`; no production native-adapter bypass found. The mutex is process-wide and held through migration and retirement. Its broader coverage of unmapped keys is a documented R7 deviation: an ACL prompt can now delay AI/custom-key operations too. `keychain_delete_if_present` still consists of two separately locked operations; the lock does not provide cross-process or external Keychain Access synchronization.

### Verification run

Commands below used the required `rtk` prefix; Rust commands ran in `src-tauri/`.

- `cargo test --locked security::credential_store::tests::`: **42 passed**, 0 failed; fake keychain only.
- `cargo test --locked security::credential_identity::tests::`: **16 passed**, 0 failed; pure identity/parser tests.
- `cargo clippy --locked --all-targets`: **passed**, 0 errors; RTK reports 6 warning occurrences in MySQL driver formatting, an unchanged identity-test formatting line, and export MSRV compatibility. None is on added/modified lines. No baseline Clippy run performed.
- `npm run build`: **passed**, TypeScript and Vite. Browser externalization, ineffective dynamic imports, large chunks and plugin timing warnings remain outside this diff.
- `git diff b74100b 3dd0bec --check`: **passed**. Final working-tree whitespace/status check recorded after append.

### Limits and release gates

- **No real keychain items were read, printed, created or deleted.** Neither ignored native smoke test ran; no desktop connection/manual migration, `security` command or native probe ran. The author's reported native smoke and Phase 0 file-keychain results are recorded evidence, not independently verified results from this review.
- The fake matches service names exactly; it cannot prove that native `PoliteDB` and `politedb` lookup, uniqueness, listing and deletion are distinct. The plan reports file-keychain success, but data-protection case sensitivity remains unverified. The Phase 0 statement covering every existing DMG install is broader than this review can establish from one installed build. This verdict does **not** clear the MAS/data-protection release gate: retain the signed/provisioned native probe before shipping that path, and choose a distinct service string if it fails. SQLite storage alone is not evidence of API comparison semantics.
- Signed-app ACL prompts, access-group behavior, actual file-to-data-protection transitions and Windows/Linux execution were not verified. Downgrade credential loss after approved D2a retirement remains intentional.
- Workflow requires Claude's security review after Codex review. The plan records one before this review; Claude should perform the required post-review pass, including these limits, before release handoff.
