# Review: mac-app-store-flavor — Phase 3

## Status

VERIFIED WITH LIMITATIONS

Phase 2, D16 and the Anthropic/assistant follow-up reviews (PR #58) are preserved in git history for `.agent/REVIEW.md` on `main`.

Reviewer: Codex. Date: 2026-10-11. Branch: `feat/mas-file-access`. Baseline: HEAD, including all uncommitted tracked changes and all requested untracked files. Read `AGENTS.md`, referenced `RTK.md`, `.agent/WORKFLOW.md`, Phase 3 design revisions 2–3, all Phase 3 plan reviews and implementation evidence. Reviewed adjacent profile persistence, runtime restoration, tunnel pooling, database operation ownership, plugin-dialog scopes and file-storage publication. Only this report edited; no application source edits, staging or commit. No P0 found.

## Findings

### P1-1 — App Store staging creates the destination before publication

`src-tauri/src/file_access/safe_save.rs:71–80,106–130`.

`URLForDirectory(... appropriateForURL: destination, create: true)` creates a zero-byte destination when that destination does not exist on this Mac. The existing `publishes_new_and_existing_destinations` test fails at line 159 in both Rust flavors: `replacement: staging must not create the destination`. An independent Foundation probe reproduced `before false`, `after true`, `bytes 0`, `after discard true`. This is separate from bookmark entitlement failures.

Consequently Begin changes the destination, cancellation/failed staging leaves an empty output, and Publish takes the existing-file replacement branch even for a new export. This violates revision 3's destination-untouched contract. Discard currently removes only staging, so it cannot undo this side effect safely. Do not fix it by deleting whatever occupies the destination after failure; another writer may have created it.

**Required:** determine a replacement-directory acquisition/publication strategy that preserves absent as well as existing destinations under the actual save-panel authorization. Preserve atomic publication and avoid silent fallback. Record and escalate the observed preservation failure under the plan's stop-and-escalate rule. Tests must assert destination absence after Begin, cancel and every pre-publication failure, plus original bytes after existing-file failures. Re-run new/existing destination cases in the signed sandbox. The current “239 passed” implementation evidence is not reproducible here.

### P1-2 — Declining or cancelling access still runs Test/Connect and can save a profile

`src/components/connection/ConnectionFormDialog.tsx:187`; `src/lib/file-access/index.ts:193–195`.

Connect ignores the boolean returned by `ensureFileAccess` and proceeds to `profileSaveAndConnect` after declining the confirmation or cancelling the picker. The backend saves the profile before attempting runtime connection (`commands/profile/connect.rs:75–103`), so cancellation can create/update a profile and persist secrets even though access was declined. Test/unsaved runtime recovery has the same control-flow error: its false preflight branch calls `run()`.

A probe executing the current recovery module with declined confirmation recorded **one operation call, zero picker calls**. The existing cancellation test covers cancellation after the first operation fails, not cancellation during preflight.

**Required:** propagate a cancellation outcome and stop before test/connect/save/keychain work. Restore form busy state without recording a failed connection or replacing an existing draft/profile. Add form-level tests for decline, file-panel cancel and folder-panel cancel; assert zero persistence/connect calls and unchanged profiles. Cover the recovery wrapper's initial cancellation branch too.

### P1-3 — Stored-but-unusable grants have no safe Connect recovery; retry creates duplicate profiles

`src/components/connection/ConnectionFormDialog.tsx:185–202,246–275`; `src/lib/file-access/index.ts:152`; `src-tauri/src/commands/profile/connect.rs:75–103`.

`ensureFileAccess` checks stored entries only. A corrupt bookmark, moved resource or failed security-scope start therefore passes preflight. Save-and-connect persists a newly generated profile ID, then fails with `FILE_ACCESS_REQUIRED`. The form catch only displays the error; it neither offers forced grant recovery nor retains the saved profile identity. Pressing Connect again remains create mode, and `buildSavePlan` generates another UUID (`src/lib/tauri/profile.ts:545`). Each attempt can leave another saved profile, while the unusable entry continues passing preflight. Skipping automatic retry of the entire save command avoids one duplicate path but does not implement the planned recovery contract.

**Required:** make file-access failure recovery resumable without replaying profile creation or secret persistence. Either validate/acquire the required resources before persistence with appropriate lifetime protection, or retain the saved profile/ID and retry only runtime connection after explicit recovery. Cover stale/denied/corrupt grants for create and update, both DB and SSH, cancellation during recovery, and repeated backend rejection. Assert one profile identity, one save and bounded connection retries. Include merged saved-profile inputs when Test uses overrides.

### P1-4 — Privacy review leaves live SSH paths in logs and raw engine errors in analytics

`src-tauri/src/commands/connection/lifecycle.rs:74–78`; supporting `src-tauri/src/ssh_tunnel/pool.rs:33–46,88–126`; `src/components/connection/ConnectionFormDialog.tsx:129–133,271–276`; supporting `src/hooks/useEnsureRuntimeConnection.ts:92–98,152–158`.

`TunnelKey.auth_fp` embeds the literal SSH identity-file path (`pk:<path>|pp:<flag>`). Existing `ssh_key = ?key` logs in the connect/tunnel acquisition path therefore expose it even on successful authentication, bypassing the new error redactor. Test/Connect/auto-restore analytics still send `msg.slice(0,240)`; backend engine errors remain unsanitized IPC text, and DuckDB open diagnostics can contain the database pathname. Redacting Rust logs does not redact this frontend telemetry.

These sinks predate Phase 3; they are **unfulfilled explicit privacy obligations**, not newly discovered sandbox escapes. Revision 3 and the final plan review require the entire affected log/analytics path to remain path-free. Implementation evidence cannot unilaterally defer them as out of scope. The new grant event's `{role,outcome}` test does not cover these callers.

**Required:** log opaque tunnel identifiers/safe categories without changing pool equality semantics; emit safe error codes/categories to analytics instead of native/engine text. Preserve useful user-facing errors locally. Test successful SSH acquisition as well as failures using captured logs and sentinel paths; test form and auto-restore analytics with malformed/native errors. Audit console/error reporting. Do not rely solely on exact-string replacement for arbitrary native diagnostics.

### P2-5 — Auto-restore opens a modal recovery prompt without a user action

`src/screens/connection/ConnectionScreen.tsx:219–242`; `src/lib/file-access/index.ts:165–175`.

The runtime-error effect immediately calls `ensureFileAccess`, which opens `confirmDialog` on automatic restoration. The user has not clicked a Grant access action. Confirmation before the file chooser does not satisfy revision 2's requirement to surface an action on the tab/card instead of opening panels automatically. Cancellation opens another error modal. There is also no effect cleanup for an in-flight recovery after switching/closing the tab.

Separately, coalescing covers only the picker: a probe of concurrent `ensureFileAccess` calls for the same request produced **two confirmation dialogs and one picker**. Existing tests assert picker count only.

**Required:** render an explicit recovery action; open all recovery dialogs only from that action, scoped to the still-current tab/profile. Coalesce the complete confirmation/picker transaction, and prevent obsolete completions from triggering retries. Add component-level auto-restore, tab switch/close, cancellation, concurrency and repeated-failure tests. The helper's bounded retry test alone does not cover this effect.

### P2-6 — MAS open/create/recovery validation does not enforce the approved fail-closed policy

`src-tauri/src/file_access/validate.rs:9–15,30–47`; `src-tauri/src/file_access/pick.rs:65–68`; `src-tauri/src/file_access/macos.rs:147–156`.

Open checks only the final component with `symlink_metadata`; symlinked parents are followed during canonicalization. Create accepts an existing Finder alias because it checks regular-file type but never checks the alias flag/signature, and its wildcard branch accepts metadata errors other than NotFound. DB recovery validates only the selected folder: an `expected_path` naming a directory, symlink or alias bypasses file validation and can still produce a stored folder grant. The native adapter validates once, then creates the bookmark without the promised final resource/type recheck.

An isolated Rust probe compiled the current validation module unchanged: **symlink component accepted: true; alias existing_file accepted: false; alias new_file accepted: true**. A Foundation-created alias was independently recognized as an alias and matched the detector's signature; the defect is the missing check in Create/recovery, not failure of that modern-alias fixture.

**Required:** apply the agreed file/type/path policy consistently to open, existing create targets and recovery, reject non-NotFound metadata failures, and reject symlinked components or establish a race-safe identity policy. Keep validation bound to the actual panel URL before bookmark creation. Add malicious-IPC and selection-swap fixtures. Also provide the promised same-path folder replacement/resource-identity evidence: pathname equality alone in `service.rs:91` does not establish it. No kernel sandbox bypass is claimed by these probes; they demonstrate missing application-policy checks.

### P2-7 — Direct macOS SSH Browse now rejects previously supported key paths

`src-tauri/src/file_access/pick.rs:123–145`; `src-tauri/src/commands/file_access.rs:66–68`; `src/components/connection/SshSection.tsx:93–106`.

SSH Browse previously used the plugin-dialog picker and passed its selected path through to libssh2. It now applies `existing_file` in every flavor, so Direct Browse rejects a symlinked private key with `FILE_ACCESS_UNSUPPORTED_ITEM`, although typing that same path still works in the direct engine. On macOS, `panels(app)` also selects the new AppKit adapter unconditionally; the plan specifically keeps plugin-dialog in Direct and non-macOS builds. The new direct test covers an ordinary file only.

**Required:** keep MAS restrictions and native bookmark panels behind the distribution boundary; preserve Direct SSH picker/path behavior, including symlinks and aliases as previously handled by the dialog. Add direct-flavor picker regression cases. Direct typed DB input, lease-free engine opens and sibling-temp export selection are otherwise preserved in the reviewed paths.

## Security, native ownership and lifetime assessment

- **Provenance:** no arbitrary-path grant command exists. `record` is module-private; native bookmark creation uses the retained panel URL, and refresh uses the retained resolved URL while access is active. Folder selection requires exact canonical parent and explicit folder-consent text; SSH bookmarks request read-only access. Recovery's folder-only selection still obtains real folder consent, but its missing file validation is finding P2-6.
- **Capability narrowing:** App Store removes broad static read scopes and retains scope-free read commands; Direct capability is unchanged. Locked plugin-dialog extends runtime file scope for picked files. The new native DB/SSH panels do not call plugin-fs `allow_file`/`allow_directory`. Source inspection supports the intended separation; actual sibling denial while a Rust lease is active remains unverified. Generic plugin folder selection can grant runtime directory scope when explicitly invoked; this is distinct from the native DB-folder picker.
- **AppKit / memory:** panel creation, configuration, modal execution, retained URL access and initial bookmark creation stay in the dispatched main-thread closure. `MainThreadMarker` is constructed there. Only owned paths/bytes cross back to the blocking worker. The receiver blocks a spawn-blocking worker, not the main thread. Locked NSURL bindings implement Send + Sync; resolution/start/stop/refresh retain the same object. No concrete URL use-after-free, double release or unmatched stop found. Panel dismissal, application shutdown, dropped command receivers, alias/resource races and simultaneous modal requests lack native end-to-end evidence. A dropped receiver can still allow the picker flow to finish/store consent; no cancellation protocol is tested.
- **DB leases:** `Arc<Leased<Mutex<Connection>>>` keeps the native connection before the lease in drop order. Blocking opens acquire inside the task; queries own shared handles. DuckDB `with_duckdb_connection` keeps a borrow of the shared handle through the cloned connection's lifetime. Static tracing found no detached raw connection escaping this wrapper. Early open failure and dropped-await ownership appear safe, but tests are generic RAII examples rather than real engine/disconnect/task fixtures.
- **SSH leases:** acquisition is inside the blocking auth routine and covers synchronous `userauth_pubkey_file`; early auth error drops the lease. Pooled authenticated tunnels do not reread the key. New authentication takes another lease. Real encrypted-key authentication, reconnect and dropped-await behavior remain untested.
- **Exports/imports:** grants are separate from profiles and no production profile import/export path references the grant store. The new serde test ignores injected fields; it does not exercise plaintext/encrypted single/all exports or external imports with a populated store as promised. No bookmark-export route found statically. Normal profile DB/key paths remain intentionally exported; bookmarks must not be. Native export publication is blocked by P1-1. No publication-port fault injection or startup staging-residue cleanup was added. `resultingItemURL` is passed as None despite the final plan review's capture requirement.
- **Store:** serialized operations, failure-preserving replacement and 0600 file permissions are present. Save limits entry count but does not bound serialized bytes; load quarantines the entire store above 1 MiB. Add an oversize-save regression and preserve old grants instead of writing a file the next read discards. Stale-refresh save failure preservation, concurrent acquire and store-I/O fixtures are also absent.

## Independent verification

Host: macOS 27.0.1 (26A434), arm64. Commands use the repository's npm and locked Cargo graph.

- `npm run build` and `npm run build -- --mode appstore`: passed. Existing browser-externalization, mixed dynamic/static import and chunk-size warnings remain. App Store Vite mode alone is not evidence of a signed Rust App Store artifact.
- `npm run test:run`: **116 files / 657 tests passed**. Focused file-access/path-field run: **2 files / 15 tests passed**. Those tests do not cover the reported form/auto-restore integration gaps.
- `cargo test --offline --locked file_access::`, default and `--features app-store` (the latter also serialized): **39 passed / 3 failed each**. Two native bookmark tests fail creation with `sandbox_extension_issue_file ... Operation not permitted` / `Denied` under this runner; they do not demonstrate a product bookmark defect. The third failure is the independently reproduced staging side effect in P1-1.
- Full `cargo test --offline --locked`, default and `--features app-store`: **228 passed / 11 failed / 1 ignored each**. Eight unchanged AI loopback fixtures cannot bind sockets (`PermissionDenied: Operation not permitted`); two native bookmark restrictions and the export failure account for the remaining three. Full logs retained under `/private/tmp/politedb-phase3-{direct,appstore}-tests.log`.
- New `profiles_never_carry_file_grants` and `file_access_codes_survive_ssh_wrapping`: passed independently.
- Scratch probes outside the repository: Foundation new-destination creation/discard side effect; actual alias generation; current Rust validation acceptance; current frontend recovery cancellation/concurrent-confirmation behavior. These are focused reproductions, not signed sandbox authorization tests or full UI sessions.
- `git diff --check`: passed. Full Windows/Linux builds and clippy not rerun. No live app UI or interactive signed-harness matrix performed.

## Verification gate and handoff

The implementation evidence itself says the signed interactive matrix is not run. Ad-hoc signing/launch/container creation alone cannot verify persistent access, least privilege or safe publication. Before Phase 3 can be VERIFIED, record pick/persist/quit/relaunch separation; private unpicked denial and plugin-fs sibling denial; SQLite rollback/WAL/crash recovery; DuckDB WAL/spill/checkpoint; encrypted SSH auth; new/existing exports and fault preservation; imported-profile recovery; cancellation, Unicode/spaces, symlinks and unavailable-volume behavior; and last-handle close-before-stop under disconnect/background work.

Fix the findings, add discriminating tests and update implementation evidence before Codex re-review. The export preservation failure requires the plan's stop-and-escalate handling; do not silently weaken publication or expand folder access. Workflow-required Claude security review remains necessary for SSH/profile/file-access scope. No claim of Phase 3 or MAS release readiness.

## Re-review round 2

Reviewer: Codex. Date: 2026-10-11. Branch: `feat/mas-file-access`. Reviewed HEAD-to-working-tree changes, including untracked implementation/tests, against `Phase 3 — Review round 1 fixes` in PLAN.md and P1-1 through P2-7 above. Read AGENTS.md, RTK.md and WORKFLOW.md. Only REVIEW.md edited; probes live under `/private/tmp`. No source edits, staging or commit.

### Fix verification

| Finding | Result | Evidence |
| --- | --- | --- |
| P1-1 | Fixed locally; native authorization remains a limitation | `ReplacementDirectory::stage` uses the existing parent URL. All three safe-save tests pass in both Rust flavors: new/existing publication, discard, and preservation on missing-stage failure. New destination remains absent through staging/discard. No silent fallback added. |
| P1-2 | Fixed | Preflight/recovery cancellation throws `FileAccessCancelled`; form Test/Connect catches it before failure logging/analytics and returns idle. Form decline/folder-cancel tests and helper cancellation tests pass. File and folder cancellation both return null into the same stop path. |
| P1-3 | Partially fixed; still open | `missing` now resolves/starts stored grants and backend checks before persistence. Bare pre-persistence errors permit one retry. However, leases are immediately dropped and late failure still loses the saved identity; see below. The new late-failure test proves only no automatic replay, using update mode. |
| P1-4 | Partially fixed; still open | `TunnelKey::Debug` emits an opaque hash without changing derived equality/hash; affected connection analytics use `errorCode`. Engine/native logging still relies on exact path replacement; see below. |
| P2-5 | Partially fixed; still open | Auto-restore displays an explicit banner; no recovery prompt opens from its effect. Same-request confirmation + picker transactions coalesce. Cancellation does not reconnect. Pending completion is still not scoped to the current tab; two independent component probes fail. |
| P2-6 | Partially fixed; still open | Open/existing Create reject aliases and symlink components; non-NotFound metadata errors fail closed. Native adapter repeats validation/resolution, and stored inode/device identity rejects the tested folder replacement. DB recovery canonicalizes away symlinked parents before validation; independently reproduced below. |
| P2-7 | Fixed by source inspection and existing tests | Native panels are selected only for grant-requiring distribution; Direct uses plugin-dialog plus `lenient`, preserving absolute selected paths including symlinks. No bookmarks in Direct. A dedicated end-to-end Direct symlink/alias picker test is still absent, but no remaining rejection found in this path. |

### Remaining actionable findings

**P1-3 — Keep the grant lease or saved identity across the persistence boundary.** `src-tauri/src/file_access/service.rs:125–126`; `src-tauri/src/commands/profile/connect.rs:62–106`; `src/components/connection/ConnectionFormDialog.tsx:189–213,254–267`.

`missing` drops each successful lease immediately; `ensure_usable` returns only `()`. Secrets/profile writes then run before a separate runtime acquisition. If a folder/key is replaced or its grant fails between checks, runtime returns prefixed `RUNTIME_CONNECT_FAILED: FILE_ACCESS_*` after the profile was saved. The form refuses automatic replay but retains neither that saved ID nor a runtime-only recovery action. A second Connect click in create mode generates another UUID in `buildSavePlan`, so the original late-failure duplicate-profile path remains. This is a code-level persistence/control-flow gap, not a socket/bookmark runner restriction. Retain validated access through the handoff, and/or return/retain the persisted profile identity so recovery retries runtime only. Test create/update with a grant changing after preflight and a second user click; assert one saved identity and no repeated secret persistence. The existing update-mode, one-click mock test cannot establish this invariant.

**P1-4 — Native log fallback still permits sensitive diagnostic text.** `src-tauri/src/file_access/redact.rs:5–22`; callers in `commands/connection/lifecycle.rs:95,327,356` and `commands/profile/connect.rs:104,242,337`.

Successful tunnel-key logging and connection telemetry sinks identified in round 1 are corrected. The separate explicit requirement to avoid exact-string-only native redaction remains unmet: `log_safe` returns arbitrary engine/native text after replacing only supplied/canonical path spellings. A scratch probe importing the unchanged redactor passed `/Users/sentinel/private project/app.db` with a diagnostic containing `file:///Users/sentinel/private%20project/app.db`; the entire encoded path survived. This is an injected diagnostic robustness test, not a claim that this exact message was emitted by a live engine. Use safe codes/categories for logs whose native diagnostics cannot be reliably scrubbed; keep original errors local to user-facing IPC. Add captured-log and malformed/encoded-diagnostic tests plus form/restore analytics coverage; current tests exercise ordinary known-path replacement and Debug output only.

**P2-5 — Obsolete recovery still reconnects after tab switch/close.** `src/components/connection/FileAccessBanner.tsx:22–40`; `src/screens/connection/ConnectionScreen.tsx:860–865`; `src/hooks/useEnsureRuntimeConnection.ts:100–140`.

The banner always calls its captured `onGranted` after the pending grant resolves. There is no unmount/request-generation guard or tab/profile identity check. The connection screen is reused across tab changes (`src/layout/index.tsx:60`); the captured reload can reopen the old profile, update a closed/inactive tab and overwrite shared error/busy state. Two scratch Vitest probes rendering the real banner, deferring `ensureFileAccess`, then (1) unmounting or (2) changing requests/callback before resolving true both observed one obsolete retry. Guard completion by mounted state and originating tab/profile/request generation; check current store state before runtime reload and before applying its result. Add switch/close and repeated-failure integration tests.

**P2-6 — Recovery erases symlink components before enforcing the policy.** `src-tauri/src/file_access/pick.rs:70–75,205–215`.

`canonical_target(expected)` canonicalizes the parent first; `existing_file` then validates the canonical spelling rather than the saved path. A scratch Rust harness compiled the unchanged `pick.rs`, `validate.rs` and `error.rs` with fake panel/store ports. For `link/app.db`, where `link` points to `real`, raw `existing_file` returned `FILE_ACCESS_UNSUPPORTED_ITEM`, but recovery returned `Ok(Some(original_symlink_path))` and recorded one folder grant. Thus recovery bypasses the approved symlink-component rule and hands the engine the original rejected spelling. Validate the normalized original path before canonical comparison. Also bind the saved DB target validation to folder-panel completion: the current native recheck validates only the folder, so it does not recheck the database file after the user waits in that panel. Add malicious expected-path and selection-swap fixtures. No kernel sandbox bypass is claimed.

### Independent verification and limitations

- `npm run test:run`: **118 files / 669 tests passed**. `npm run build` and `npm run build -- --mode appstore`: passed, with existing build warnings.
- Full `cargo test --offline --locked`, Direct and `--features app-store`: **236 passed / 10 failed / 1 ignored each**. All export staging/publication tests pass. Eight unchanged AI loopback fixtures fail socket binding with `PermissionDenied: Operation not permitted`; two native bookmark fixtures fail creation with `sandbox_extension_issue_file ... Operation not permitted` / `Denied`. These ten failures are environment limitations, not product defects. Logs: `/private/tmp/politedb-r2-{direct,appstore}.log`.
- `cargo clippy --offline --locked --all-targets`, both flavors: completed. Five existing production warnings plus the existing test-only `credential_identity.rs:415` useless-format warning. App Store direct-Cargo build also warns that artifacts require the Tauri App Store script; these runs do not establish signed-artifact readiness.
- Independent banner probes: **2 expected regression assertions failed**, showing obsolete callback execution. Fixtures: `/private/tmp/politedb-r2-probes/banner.test.tsx`. Rust validation/redaction probes: `/private/tmp/politedb-r2-rust`; these use actual unchanged modules and fake surrounding ports, not native consent tests.
- `git diff --check`: passed before report append. Static retracing found no new DB-close-before-lease-stop, SSH-auth lease lifetime, Direct export strategy, or profile-bookmark sharing regression. Existing generic lifetime/serde tests do not establish the full real-engine/export-import matrix.
- Interactive signed-sandbox matrix remains **human-required and pending**, including relaunch persistence, private/sibling denial, WAL/spill/checkpoint, encrypted SSH, save-panel authorization and publication faults. This is a limitation, **not a defect or a standalone reason for CHANGES REQUIRED**. No interactive native UI, Windows/Linux build or signed-artifact verification performed. Remaining store-size enforcement and broader fault-injection coverage noted in round 1 remain unproven. Workflow-required Claude security review still applies.

### Final verdict

**CHANGES REQUIRED.** P1-1, P1-2 and P2-7 fixes are accepted within the stated verification limits. P1-3, P1-4, P2-5 and P2-6 retain actionable code gaps above. The verdict rests on those gaps; blocked sockets/bookmarks and the pending human signed-sandbox matrix are recorded separately as limitations.


## Re-review round 3

Reviewer: Codex. Date: 2026-10-11. Branch: `feat/mas-file-access`. Reviewed the HEAD-to-working-tree diff, including untracked implementation and tests, against PLAN.md **Phase 3 — Review round 2 fixes** and the four round 2 open findings. Read AGENTS.md, its RTK.md reference, and WORKFLOW.md. Only REVIEW.md edited; independent probes are under `/private/tmp/politedb-r3-probes`. No source edits, staging or commit.

### Fix verification

| Finding | Result | Evidence |
| --- | --- | --- |
| P1-3 | Lease handoff and repeated Connect fixed; adjacent Save path remains open | `ensure_usable` returns leases; `_file_leases` remains in scope through persistence and awaited runtime creation. The dialog supplies a fixed create ID and later Connect uses update after `RUNTIME_CONNECT_FAILED`. New wrapper tests verify supplied/generated IDs; the form test verifies create then update with one ID. Save still ignores that retained identity; reproduction below. |
| P1-4 | Fixed | `log_safe` returns only a leading code or `OTHER`; no supplied-path replacement remains. The affected connect/test/profile log sinks use it, while original diagnostics still return over local IPC. Literal and encoded sentinel tests pass. TunnelKey Debug stays opaque without changing pooling equality/hash; affected frontend analytics remain code-only. No actionable regression found in this change. |
| P2-5 | Pending-picker switch/unmount fixed; runtime completion remains open | Banner mounted/scope checks suppress its callback after a pending picker resolves on another tab or after unmount. Its component tests pass. Once the callback starts `reloadRuntime`, the hook still applies results without current-tab/generation checks; reproduction below. |
| P2-6 | Fixed within local verification limits | Recovery validates the normalized original saved spelling before canonical comparison, rejecting symlinked parents before opening a panel. It repeats file validation after the folder panel and before storing the grant. Symlinked-path and file-to-folder swap tests pass in both Rust flavors. Native bookmark creation remains bound to the retained panel URL, with selection validation and bookmark resolution checks. These tests establish application-policy checks, not signed sandbox rights or elimination of every filesystem race. |

Previously accepted P1-1, P1-2 and P2-7 remain accepted: safe-save preservation tests pass; cancellation prevents Test/Connect persistence; Direct panels retain plugin-dialog/lenient paths and create no bookmarks. Static retracing found no new database close-before-stop, blocking-task ownership, SSH auth lease lifetime, profile/bookmark sharing or Direct export-strategy regression. Optional create `profileId` is carried through command payloads and secret-key planning; callers omitting it still get a generated UUID.

### Remaining actionable findings

**P1-3 — Save after a late create/connect failure still creates a duplicate.** `src/components/connection/ConnectionFormDialog.tsx:156–158`.

Create-mode Connect can persist profile A and then return `RUNTIME_CONNECT_FAILED`. The dialog correctly retains A's ID for another Connect, but clicking **Save** uses only `initialData.id`, sends `{ mode: "create" }` with no ID, and `buildSavePlan` generates profile B. This is a normal adjacent workflow after connection failure, not a sandbox restriction. An independent component probe rendered the real dialog, injected a late Connect failure, then clicked Save: expected update with the first ID, received create without an ID. The existing five form tests passed in the same probe run.

**Required:** use the retained persisted ID in Save as well as Connect, and keep one authoritative identity across subsequent dialog actions. Add a late-failure → Save regression asserting the same saved profile ID and update semantics. The lease-handoff and second-Connect fixes themselves are accepted; this remaining duplicate path prevents closing P1-3.

**P2-5 — Recovery reload still overwrites another tab's state after the picker has finished.** `src/hooks/useEnsureRuntimeConnection.ts:117–138`; recovery entry point `src/screens/connection/ConnectionScreen.tsx:865`.

The banner guard covers the picker wait only. When the grant completes on tab A, its callback starts `reloadRuntime`; switching to B while that connection is pending leaves A's callback free to call `setError`, `setConnecting`, `updateTab` and session logging. An independent harness rendered the real hook: A's initial restore failed, manual recovery reload was deferred, navigation changed to B, and B's restore established `B current error`. Rejecting A's pending reload then replaced the displayed error with `A obsolete failure`. In the real screen this can display an unrelated error dialog or file-access banner on B. Success likewise clears B's error; a closed tab can receive obsolete session logging even though store `updateTab` ignores missing IDs.

**Required:** scope the complete reload transaction to the originating tab/profile and an invalidated request generation. Before applying success, error, busy-state changes or session records, check that the originating request is still current and the tab still exists. Add switch/close tests during runtime connect, including late success and failure. The pending-picker switch/unmount fixes are accepted; this remaining completion path prevents closing P2-5.

### Independent verification and limitations

- `npm run test:run`: **119 files / 673 tests passed**. `npm run build` and `npm run build -- --mode appstore`: passed; existing build warnings remain.
- Full `cargo test --offline --locked`, Direct and `--features app-store`: **238 passed / 10 failed / 1 ignored each**. Eight AI loopback fixtures cannot bind sockets (`PermissionDenied: Operation not permitted`); two native bookmark fixtures cannot create bookmarks (`sandbox_extension_issue_file ... Operation not permitted`, `Denied`). All ten are environment failures, not defects. Logs: `/private/tmp/politedb-r3-{direct,appstore}.log`.
- Focused `cargo test --offline --locked [--features app-store] file_access:: -- --skip file_access::macos::tests`: **47 passed each**. This explicitly excludes the two environment-blocked native fixtures; it does not claim native authorization verification.
- `cargo clippy --offline --locked --all-targets`, both flavors: completed with the same five production warnings and existing test-only useless-format warning in `credential_identity.rs:415`. Logs: `/private/tmp/politedb-r3-clippy-{direct,appstore}.log`.
- `git diff --check`: passed, including report append.
- Independent UI probes: **2 regression assertions failed / 5 existing form tests passed**. Fixtures and output: `/private/tmp/politedb-r3-probes/{form.test.tsx,hook.test.tsx,result.log}`. Probes use real components/hooks with mocked IPC/store boundaries and establish the two control-flow defects above, not native authorization behavior.
- Interactive signed-sandbox matrix remains **human-required and pending**, including pick/persist/quit/relaunch, private/sibling denial, SQLite WAL/recovery, DuckDB spill/checkpoint, encrypted SSH, and save-panel authorization/publication faults. This known limitation is **not a defect or a standalone reason for CHANGES REQUIRED**. No interactive native UI, Windows/Linux builds or signed-artifact verification performed. Direct Cargo App Store runs warn to use the Tauri App Store script for release artifacts. Workflow-required Claude security review still applies.

### Final verdict

**CHANGES REQUIRED.** P1-4 and P2-6 are closed within the stated limits. P1-3 and P2-5 have narrower, independently reproduced remaining defects above. The verdict rests only on those defects; sandbox socket/bookmark failures and the pending human matrix are separate limitations.

## Re-review round 4

Reviewer: Codex. Date: 2026-10-11. Branch: `feat/mas-file-access`. Reviewed the uncommitted HEAD-to-working-tree changes and untracked regression tests against PLAN.md **Phase 3 — Review round 3 fixes**, specifically round 3's P1-3 and P2-5 open items. Read `AGENTS.md`, referenced `RTK.md`, and `.agent/WORKFLOW.md`. Only this report edited; scratch probes are under `/private/tmp/politedb-r4-probes`. No application source edits, staging or commit. Earlier findings/verdicts above are historical; this round supersedes their open-item status.

### Fix verification

| Finding | Result | Evidence |
| --- | --- | --- |
| P1-3 — Save after late failure | Closed | `ConnectionFormDialog.tsx:156–170` uses `profileId ?? savedNewProfileId` for Save, matching Connect's identity selection. Initial creation supplies the dialog's fixed `newProfileId`; successful Save retains its returned ID. A late `RUNTIME_CONNECT_FAILED` retains the already-persisted identity, so subsequent Save uses update with that same ID. The profile wrapper planning carries the supplied ID into both the command and secret references. The new late-failure → Save component test passes. Independent adjacent probes verify repeated Save creates once then updates the same ID, and editing an existing profile still saves with its original ID. |
| P2-5 — Reload completion scoping | Closed for the reported switch/close defect | `useEnsureRuntimeConnection.ts:30–38,123–166` invalidates the screen generation on tab/profile changes and unmount. Late reload success/failure/finally cannot change the newly shown screen's error/busy state. Tab results and session/analytics records are separately restricted to an originating tab that still exists. Retaining an existing inactive tab's own connection result or failure record is appropriate; it does not overwrite the active tab's state. Repository tests cover failure after switch and success after close. Independent probes additionally cover success/failure after switch and success/failure after close plus unmount; all pass. |

### Regression assessment

No new actionable Phase 3 defect found in this re-review. The existing form cancellation, bounded file-access retry, second-Connect identity, supplied/generated profile ID, banner switch/unmount, path validation, privacy-category and safe-save preservation tests remain green. Static tracing of the affected Save/Connect command payloads, recovery wrapper, banner callback and runtime connection coalescing found no identity or retry regression caused by these fixes. The reload guard changes frontend completion handling; native connection/lease ownership is unchanged by round 3 fixes.

### Independent verification and limitations

- `npm run test:run`: **120 files / 676 tests passed**.
- `npm run build` and `npm run build:appstore`: passed. Existing browser-externalization, mixed static/dynamic import and chunk-size warnings remain.
- Independent real-component/hook probes with mocked IPC/store boundaries: **2 files / 14 tests passed**. These include the existing six form tests and two hook tests plus six additional adjacent cases. Fixtures: `/private/tmp/politedb-r4-probes/{form.test.tsx,scope.test.tsx,vite.config.mts}`. They establish frontend control flow, not native authorization.
- `cargo test --offline --locked file_access:: -- --skip file_access::macos::tests`, Direct and `--features app-store`: **47 passed each**. Both flavor test targets compile. This deliberately excludes the two native bookmark fixtures blocked in this runner. Full Rust suites and clippy were not rerun this round; the prior independent round 3 evidence remains recorded above, rather than being represented as a fresh full-suite result.
- `git diff --check`: passed before and after report update.
- Sandbox-blocked sockets/bookmark creation are environment limitations, not defects. The interactive signed-sandbox matrix remains **human-required and pending**: relaunch persistence, private/sibling denial, SQLite WAL/recovery, DuckDB spill/checkpoint, encrypted SSH, and save-panel authorization/publication faults. No interactive native UI, Windows/Linux build or signed-artifact verification performed. Direct Cargo App Store tests warn to use the Tauri App Store script for release artifacts; passing tests do not establish signed-artifact readiness. Workflow-required Claude security review remains a separate handoff step.

### Final verdict

**VERIFIED WITH LIMITATIONS.** Round 3's P1-3 Save duplicate path and P2-5 reload switch/close completion defect are closed. No genuine, actionable Phase 3 defect remains identified by this re-review. The verdict accepts the reviewed fixes within local verification limits; it does not claim completion of the human signed-sandbox matrix.
