# Review: mac-app-store-flavor — Phase 1c

## Status

VERIFIED WITH LIMITATIONS

Reviewer: Codex. Branch: `feat/local-ai-api`; baseline: HEAD. Read AGENTS.md, WORKFLOW.md and Phase 1c/evidence first. Reviewed full working-tree delta, staged deletions and untracked `src-tauri/src/ai/` / `providerSave.test.ts`. Only this report changed; no application edits, staging or commit. No P0 found.

## Round 1 findings (retained; current disposition)

Historical dispositions below are superseded by the latest re-review; see Re-review 3 for current status.

1. **P1-1 — UNRESOLVED (partial fix) — Config/key reads bypass Save transaction.** `src-tauri/src/commands/ai.rs:118`: chat reads config/key without `ai_providers_lock`; `ai/provider_store.rs:79` publishes config before changing key. Concurrent chat can send the old cloud token to the newly configured host, even if Save later rolls back. List/draft key reads also bypass the lock. **Fix:** snapshot config/key under the same lock, release before network I/O. **Regression:** barrier-controlled Save paused after config replacement; concurrent chat/list and save/delete observe committed state only, including rollback.

2. **P1-2 — RESOLVED (original silent fallback; new recovery regressions below) — Resumed history silently uses replacement provider.** `src/components/ai-assistant/AiAssistantPanel.tsx:455`: session switching never checks session `providerId`; global enabled fallback at `:170` remains submittable. Missing/disabled local history can be sent to an enabled cloud provider without R6's replacement prompt. **Fix:** session-aware recovery guard requiring explicit replacement; preserve historical attribution. **Regression:** single/multi-session upgrade fixtures, missing/disabled `local` plus enabled cloud fallback; zero requests before choice; active session/language/context/model mode and attribution preserved.

3. **P2-3 — RESOLVED — Remove stored key still authenticates draft requests.** `src/components/ai-assistant/AiAssistantSettingsDialog.tsx:206` / `:262` pass no override; `src-tauri/src/ai/provider_store.rs:129` falls back to stored token. Test/discovery can transmit the key the draft removes. **Fix:** tri-state keep/set/remove draft auth, without persistence. **Regression:** Remove + Test/Load models sends no Authorization; keychain unchanged.

4. **P2-4 — UNRESOLVED (partial fix) — Stale discovery overwrites intervening edits; cancellation incomplete.** `src/components/ai-assistant/AiAssistantSettingsDialog.tsx:150`: edits do not invalidate token; `:215` merges captured draft. Changing URL/auth or adding/removing models while waiting accepts the old response and can lose edits. Backend discovery has no cancellation (`src-tauri/src/commands/ai.rs:83`). **Fix:** invalidate relevant edits, merge current state functionally, add request-scoped cancellation. **Regression:** deferred response after URL/auth/model edits, close/switch, cancel during body reading.

5. **P2-5 — RESOLVED — Rollback failure never reloads disk state.** `src/components/ai-assistant/AiAssistantSettingsDialog.tsx:247` only displays error; `src/lib/ai-assistant/providers.ts:268` notifies only on success. R13 rollback failure may leave new config on disk while panels retain old config. **Fix:** reload/notify on `AI_PROVIDER_SAVE_ROLLBACK_FAILED`, without further writes. **Regression:** key failure + rollback failure; dialog/all panels show disk state. Replace contrary assertion in `src/lib/ai-assistant/providerSave.test.ts:60`.

6. **P2-6 — RESOLVED — Offline Save requires completion model.** `src-tauri/src/ai/provider_store.rs:42` uses completion validation; Settings blocks Save at `AiAssistantSettingsDialog.tsx:225` / `:630`. R3 requires URL/key-only Save. **Fix:** separate identity/URL/key Save validation from completion validation. **Regression:** empty-model offline Save, enabled true/false, exact toggle persisted and no network.

7. **P2-7 — RESOLVED (user-amended R2 permits surrounding-whitespace trimming) — Model ids still rewritten.** `src/lib/ai-assistant/providers.ts:153`, `src-tauri/src/ai/provider.rs:100`, `src-tauri/src/ai/chat.rs:306` trim identifiers despite R2's byte-for-byte contract. **Fix:** preserve nonempty saved/typed/server ids verbatim. **Regression:** whitespace-bearing ids survive discovery/save/reload/chat; current Rust “exact” test expects trimming instead.

8. **P2-8 — UNRESOLVED (code fixed; required fixtures incomplete) — Windows guarantees incomplete.** `src-tauri/src/file_storage.rs:141` omits R11's explicit write-through replacement; `src-tauri/src/ai/legacy_model.rs:297` lacks D10 target-parent identity verification. Cleanup fixtures at `:347` are Unix-only; required Windows swap-during-open test absent. Held ancestor handles reduce risk; no redirected deletion reproduced. **Fix:** specified Windows replacement/parent verification and native fixtures. **Regression:** failed replacement preserves old bytes; reparse/ancestor swaps fail closed; unrelated files intact.

## Round 1 contract coverage (historical)

| Contract | Assessment |
| --- | --- |
| D9, R7 | Runtime commands/state/UI/scripts/resources removed; chat cancellation and database runtime retained. |
| D10 | Explicit cleanup and Unix confinement present; Windows gap #8. |
| D11 | Display-only notice/dismissal, no automatic provider-file migration. |
| D12 | Shared/request-time URL policy, canonical IPv4, mapped IPv6, blocked redirects, HTTP proxy suppression and pinned localhost present. |
| D13, R4 | Optional bearer/keyless Ollama/canonical refs/not-found distinction present; #1/#3 remain. |
| D14, R2 | Kinds/default ports/unique ids present; exact-id gap #7. |
| D15, R1, R12 | Discovery ungated/no-model drafts; chat/test gated; webview HTTP fallback removed. |
| R3, R5, R6 | Normal enabled-only fallback present; Save/history gaps #2/#6. |
| R8, R9 | Workflow/config/docs removal aligned; clean cross-platform packages unverified. |
| R10, R11, R13 | Bounds/transaction foundation present; #1/#4/#5/#8 remain. |

Cloud completion payloads remain consistent with HEAD. No additional static license-gate bypass found; chat/test gate precedes network. Add command-level no-network matrix: direct trial/active/expired, MAS inactive/active; discovery/history/cleanup remain accessible. Concurrency fixtures are missing; existing RefCell store tests are sequential. Existing writer failure test fails temp creation, not replacement.

## Round 1 verification / limitations (historical)

- `npm run test:run`: **113 files / 624 tests passed**. `npm run build` and `npm run build:appstore`: **passed**, Vite chunk/import warnings.
- `cargo test --offline`, with and without `--features app-store`: **171 passed / 8 failed / 1 ignored each**. All eight failures are loopback `TcpListener::bind` returning `Operation not permitted` in this sandbox. Transport execution remains unverified here; these failures do not establish product regressions.
- `cargo clippy --offline`, with and without `--features app-store`: passed with five existing warnings in unchanged export/MySQL code. MAS also emits the expected non-Tauri-CLI private-API warning; these checks do not certify MAS packaging.
- No live Ollama/LM Studio, UI inspection, signed MAS launch or clean macOS/Linux/Windows packages independently executed. PLAN package evidence is implementer evidence. Missing Settings/history/concurrency/Windows fixtures materially limit coverage.
- Workflow-required Claude security review remains necessary after fixes; no commit/release authorized.


## Re-review — 2026-10-10

Status remains **CHANGES REQUIRED**. Re-read round-1 fixes and amended R2; reviewed the full delta against HEAD, staged removals and every untracked AI module/test (including the replacement `providerSave.test.ts` whose old version is staged for deletion). No code edits, staging or commit. No new P0/P1 found; P1-1 remains partially open.

### Remaining findings / new regressions

- **P1-1 — List still observes tentative Save state.** `src-tauri/src/commands/ai.rs:49`: `ai_provider_list` lacks the provider lock. Save publishes config before key mutation (`ai/provider_store.rs:80`); a concurrent List can cache that config even when the key operation fails and rollback restores disk. Chat snapshots and draft key reads are fixed. Lock List too; add barrier-controlled List plus failed-Save rollback coverage (current barrier test covers successful chat snapshot only).
- **P2-4 — Removing models still loses an edit.** `src/components/ai-assistant/AiAssistantSettingsDialog.tsx:191`: removal leaves the discovery token valid, so a delayed list re-adds the removed model through `addModels`. URL/auth edits and added models are handled. Invalidate removal or exclude removed IDs; test deferred discovery after removal.
- **P2-4 — Cancellation lacks request ownership.** `src-tauri/src/commands/ai.rs:104`, `AiAssistantSettingsDialog.tsx:85`: one app-wide slot and id-less Cancel allow a closed dialog mounting or another panel editing to cancel unrelated discovery. Cancellation before slot registration is also lost (discovery waiting for Save's provider lock, Cancel sees no sender, then discovery starts). Use request-scoped ownership that covers registration; test two panels, cancel before registration and cancel during body reading.
- **P2-9 — Continue can submit the previous provider's model.** `src/components/ai-assistant/AiAssistantPanel.tsx:205`: after live disable/delete, fallback confirmation changes ID and removes the block while model/label still belong to the old provider until async List finishes. Apply the fallback's model/label together before unblocking; test with deferred reload and distinct provider models.
- **P2-10 — Explicit replacement model pick remains blocked.** `AiAssistantPanel.tsx:243`, `:360`: model selection clears `pendingFallback` but never accepts replacement for the active legacy session, so `sessionProviderUnavailable` still blocks submission. Accept that explicit choice for the active session while preserving historical attribution; test picking a replacement without an extra Continue.
- **P2-8 — Required Windows failure/race fixtures incomplete.** Implementation now uses write-through replacement and verifies target parent against the held directory. `src-tauri/src/ai/legacy_model.rs:569` only attempts to rename held `models`; it does not open/delete the target during the swap attempt or verify unrelated-file preservation. Add the specified traversal/open fixture and failed-replacement old-bytes fixture. Native execution is an environment limitation, distinct from missing test cases.

### Resolved checks

P1-2's original missing/disabled-history leak is guarded; historical attribution is retained. P2-3's draft auth is keep/set/remove without persistence. P2-5 broadcasts rollback failure and reloads disk state without another write. P2-6 separates offline Save from completion validation. P2-7 complies with revised R2: trim surrounding whitespace, preserve remaining identifier. Runtime removal, command registration, distribution/config/workflow changes remain aligned; no additional static gate bypass found.

### Verification / limitations

- `npm run test:run`: **114 files / 632 tests passed**. `npm run build` and `npm run build:appstore`: **passed**, existing Vite externalization/import/chunk warnings.
- `cargo test --offline`, with and without `--features app-store`: **176 passed / 8 failed / 1 ignored each**. All eight failures are `TcpListener::bind` loopback returning `Operation not permitted` in this sandbox; transport tests were not executable here, not established product regressions. New store concurrency/auth/offline-save tests passed.
- Clippy not rerun; round-1 results above are historical. No native Windows/Linux execution, live Ollama/LM Studio, UI smoke or signed/clean package verification in this re-review. Windows isolated-crate checking in PLAN is implementer evidence only. Command-level entitlement/no-network matrix and backend cancellation fixtures remain absent.
- Workflow-required Claude security review remains outstanding before release/commit handoff.

## Re-review 2 — 2026-10-10

Status: **CHANGES REQUIRED**. Reviewed the full uncommitted delta against HEAD, including staged removals and untracked modules/tests, against the previous re-review and Phase 1c round-2 fixes. No application edits, staging or commit. No P0 found.

### Findings

- **P1-11 — Delete bypasses replacement consent.** `src/components/ai-assistant/AiAssistantSettingsDialog.tsx:328` automatically broadcasts the fallback as selected after deleting the selected provider. With local selected and cloud enabled, Panel reload clears `pendingFallback`; normal sessions have no stored `providerId`, so the historical-session guard does not help. Closing Settings and submitting can send the local conversation to cloud without Continue or an explicit provider choice. Leave replacement consent to Panel instead of broadcasting an automatically accepted fallback. Regression: delete selected local provider with cloud available; no cloud request until explicit replacement consent.
- **P2-10 — Partially unresolved: Auto replacement remains blocked.** `src/components/ai-assistant/AiAssistantPanel.tsx:277`: a resumed session attributed to a missing provider stays blocked after explicitly choosing Auto because this handler does not accept replacement for the active session. Manual model selection is fixed. Apply the same session acceptance to Auto; preserve attribution. Regression: unavailable historical provider → Auto → submit without another Continue.

### Resolved checks

- **P1-1:** List shares the provider transaction lock; failed-Save rollback/List barrier fixture passes.
- **P2-4 removal + ownership:** removed models are excluded from delayed discovery; unique dialog request IDs scope cancellation, registration precedes the provider lock, and early cancels are remembered. Cancellation wraps the discovery future, including body reading. Relevant dialog/registry tests pass.
- **P2-9:** Continue applies replacement provider/model/label together; deferred-reload regression passes.
- **P2-8:** Windows ancestor-swap/open/delete/unrelated-file preservation and failed-replacement old-bytes/temp-cleanup fixtures are now present. Native Windows execution remains a limitation, not an open finding.
- Runtime removal, command registration, distribution/config/workflow changes and prior resolved checks remain aligned. No additional concrete backend regression found.

### Verification / limitations

- `npm run test:run`: **114 files / 635 tests passed**. `npm run build` and `npm run build:appstore`: **passed**, existing Vite warnings.
- Isolated temporary Vitest reproduction outside the repository: **2 passed / 14 skipped**, confirming both findings above (`/private/tmp/politedb-frontend-review2/repro.test.tsx`). Delete reproduction exercises the exact selection event emitted by Settings against the real Panel.
- `cargo test --offline`, with and without `--features app-store`: **181 passed / 8 failed / 1 ignored each**. All eight failures occur at loopback `TcpListener::bind`: sandbox returns `Operation not permitted`. Network transport execution remains unverified here; these failures do not establish product regressions. Store concurrency and cancellation registry tests pass.
- `cargo clippy --offline`, both flavors: **passed**, five pre-existing export/MySQL warnings; app-store also emits the expected non-Tauri-CLI warning.
- No native Windows/Linux execution, live Ollama/LM Studio, UI smoke or signed/clean package verification. Windows isolated-crate check remains implementer evidence. Command-level entitlement/no-network matrix and discovery cancellation during body-reading lack direct execution coverage. Workflow-required Claude security review remains outstanding.

## Re-review 3 — 2026-10-10

Status: **VERIFIED WITH LIMITATIONS**. Read Re-review 2 and Phase 1c round-3 fixes; checked P1-11/P2-10 against the uncommitted HEAD delta, including the untracked Settings dialog test, and traced adjacent selection/reload/submit/session paths. Only this report edited; no application edits, staging or commit.

### Resolved checks

- **P1-11 — RESOLVED.** Settings deletion leaves the stored chat selection unchanged and emits no replacement-selection event. The providers-changed reload offers the enabled fallback through `pendingFallback`; submission remains blocked until Continue or explicit model/Auto choice. Dialog selection-preservation and local-to-cloud Panel guard regressions pass.
- **P2-10 — RESOLVED.** Auto clears pending fallback and accepts replacement for the active session, then selects an enabled default/first provider and its default model. The historical session's `providerId` is not rewritten. Legacy-session → Auto → submit regression passes; manual selection and Continue regressions also pass.
- No new concrete regression found from these two fixes. No remaining P0/P1 or approved P2 findings; previous resolved dispositions stand.

### Verification / limitations

- `npm run test:run`: **114 files / 638 tests passed**. `npm run build` and `npm run build:appstore`: **passed**, existing Vite warnings.
- `cargo test --offline`, with and without `--features app-store`: **181 passed / 8 failed / 1 ignored each**. All eight failures occur at loopback `TcpListener::bind` (`ai/chat.rs:330`, `ai/transport.rs:96,159`): sandbox returns `PermissionDenied: Operation not permitted`. These are environment-blocked network tests, not demonstrated product regressions; transport execution remains unverified.
- No live desktop UI smoke, Ollama/LM Studio, native Windows/Linux or signed/clean package execution in this round. Prior command-level entitlement/no-network and body-reading cancellation coverage limitations remain; workflow-required Claude security review is still outstanding. This status verifies the reviewed fixes with these limitations, not release readiness.
