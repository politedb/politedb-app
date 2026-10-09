# Review: mac-app-store-flavor — Phase 1

## Status

VERIFIED WITH LIMITATIONS

## Task and scope

- ID: mac-app-store-flavor
- Reviewer: Codex, 2026-10-09
- Branch: `feat/mac-app-store-flavor`; baseline: `HEAD` (7c805a3).
- Reviewed all uncommitted changes against HEAD, including the staged deletion of `scripts/grok-handoff.sh` and every untracked MAS script/config/entitlement/capability/distribution file. Read AGENTS.md, WORKFLOW.md and PLAN.md first.
- Only this report was written. No application edits, staging or commit.

**Round 1 historical verdict:** CHANGES REQUIRED. Three P1 gaps blocked Phase 1 verification; two P2 findings needed follow-up. No P0 found. The progress section acknowledged local-AI UI as “Phase 1b,” but D2 and numbered Phase 1 already required that gate. Current disposition is recorded in Re-review below; the original evidence is retained here as history.

StoreKit, native replacements, bookmarks, CI and submission are later-phase work; their absence alone is not a Phase 1 finding. This report does not certify submission readiness or Apple acceptance of D7.

## Round 1 findings (historical)

### P1-1 — External purchase targets remain enabled in Rust

**Re-review disposition: RESOLVED.**

**Location:** `src-tauri/src/commands/license.rs:55`; `src-tauri/src/distribution.rs:29`; frontend gate at `src/components/modal/LicenseDialog.tsx:254`.

`license_open_external_url` accepts arbitrary URLs and invokes the OS opener in MAS. The correctly built frontend hides pricing/Sponsor buttons, but calling the command with their URLs still attempts to open them. D7 explicitly requires disabling purchase targets at this boundary. A flavor mismatch also makes this reachable from visible UI (P2-2). Moving the opener to NSWorkspace in Phase 2 will not supply the missing policy.

**Fix:** Add Rust distribution policy. In MAS, reject purchase/sponsor destinations before opening; permit only reviewed non-purchase support/account destinations and safe schemes. Preserve direct behavior; keep policy separate from the native opener replacement.

**Regression:** MAS pricing/checkout/sponsor/unapproved redirect targets produce zero opener calls; reviewed support/mail links remain functional. Direct pricing/Sponsor remains. MAS-rendered dialog/settings/navigation expose no purchase/Sponsor actions.

### P1-2 — MAS still initializes and honors the direct local trial

**Re-review disposition: RESOLVED.**

**Location:** `src-tauri/src/license.rs:102`, `:180`; `src/components/modal/LicenseDialog.tsx:163`; `src/components/settings/LicenseKeySettings.tsx:114`.

`LicenseState::inactive` still creates a 14-day local trial in MAS. `blocks_ai_feature` permits an inactive license until that local trial expires; cloud-AI commands use it (`src-tauri/src/commands/ai.rs:606`, `:654`). License UI still displays the local trial end/expiry. D6 excludes this trial and specifies active subscription OR valid existing key. Hiding Buy buttons leaves the direct entitlement policy active.

**Fix:** Select trial policy through the distribution boundary. MAS must neither initialize nor honor/display legacy trial dates, including persisted/API fallback fields. Until Phase 4 supplies StoreKit, valid existing licenses remain the available entitlement path. Keep one authoritative license state and preserve direct trial behavior.

**Regression:** Fresh MAS inactive state and persisted future/expired legacy trials never grant AI access or show legacy-trial text; valid active keys still grant access. Direct fresh/expired/activated/refreshed/deactivated behavior remains. Phase 4 subscription/intro-offer tests must use this same authoritative gate.

### P1-3 — Bundled local-AI UI and bootstrap remain exposed

**Re-review disposition: RESOLVED.**

**Location:** `src/components/ai-assistant/AiAssistantSettingsDialog.tsx:271`, `:435`; `src/components/ai-assistant/AiAssistantPanel.tsx:196`; `src/lib/ai-assistant/providers.ts:185`.

`localAiRuntime: false` is declared but not consumed by assistant UI/bootstrap. MAS still renders Local Runtime Start/Download controls, while Rust rejects these actions and the bundle omits their server. The assistant still creates the bundled local provider and defaults empty selection to local. Existing configured cloud fallback works; fresh installs still initialize an unavailable provider. This fails D2 and Phase 1 visible gating.

**Fix:** Apply distribution policy to provider bootstrap/selection and runtime controls. Hide excluded local-runtime UI; avoid creating/selecting bundled local defaults in MAS; handle persisted local selection through cloud selection/setup. Preserve direct local AI and unrelated provider credentials.

**Regression:** Fresh MAS, persisted bundled-local selection, configured cloud provider; no runtime controls or bundled-local bootstrap/start/download calls in MAS. Direct Start/Stop/Download/autostart remain.

### P2-1 — Incorrect Keychain entitlement key

**Re-review disposition: RESOLVED in source; real-profile/sandbox verification outstanding.**

**Location:** `src-tauri/entitlements.appstore.plist:37`.

The plist uses `com.apple.security.keychain-access-groups`; Apple's key is `keychain-access-groups`. The declared array therefore does not explicitly establish the intended group. The valid macOS application identifier may still supply the default group, so this is not evidence that every Keychain operation fails. Printing signed entitlements or validating plist syntax does not validate entitlement semantics.

**Fix:** Correct the MAS key and compare prefix/group with the real provisioning profile. Do not change the direct plist, branded secret identities, or compatibility behavior as part of this finding.

**Regression:** Assert exact key/group; inspect signed app and decoded real profile; save/read/delete a disposable credential in the properly signed sandbox. Preserve existing account mappings.

Sources: [Apple Keychain Access Groups entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/keychain-access-groups), [Apple keychain group derivation](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps).

### P2-2 — Independent flavor inputs permit inconsistent artifacts

**Re-review disposition: PARTIALLY RESOLVED / UNRESOLVED residual P2 for prebuilt frontend artifacts.**

**Location:** `src/lib/distribution/index.ts:20`, `:41`; `src-tauri/src/distribution.rs:21`; `scripts/tauri-appstore.sh:19`; `src-tauri/Cargo.toml:26`.

The MAS npm wrapper correctly supplies environment, Cargo feature and config together. Other build paths have no consistency assertion; unknown frontend values silently become direct. A normal Tauri build with MAS config/feature but no frontend environment embeds direct UI: purchase/Sponsor links and Oracle return, updater checks target an unregistered plugin, local runtime actions fail. Conversely, appstore frontend with direct Rust hides supported functionality while updater registration and local-AI autostart remain enabled.

The Cargo feature also does not remove `tauri/macos-private-api`. Raw Cargo checks/tests with `--features app-store` retain that dependency feature; the CLI/config path performs its removal. Passing raw Cargo checks is not evidence of guideline 2.5.1 compliance.

**Fix:** Keep Rust authoritative; generate/validate frontend flavor from the same build input and reject inconsistent/unknown inputs. Assert actual MAS dependency graph and merged config before packaging. A startup assertion can add diagnostics but does not replace artifact validation.

**Regression:** Both valid combinations pass; both mismatches and unknown values fail clearly. MAS artifact has no private API feature, updater permission/plugin, or AI resources. Subsequent direct build retains private API feature and original capabilities/resources.

## Round 1 compatibility and D1–D8 audit (historical)

- **Direct/DMG:** Default environment and no Cargo feature preserve updater registration/install, Oracle registry, local-AI autostart/start/download, license/trial and purchase/Sponsor UI. Base config, direct entitlements and dependency `macos-private-api` are unchanged. No concrete direct regression found in static review; real DMG flows were not smoke-tested.
- **Capabilities:** MAS explicitly selects `appstore`, whose permissions equal default minus `updater:default`. Direct discovers both files; their union adds no effective permission. Inherited broad filesystem scopes do not override Apple's sandbox or provide persistent bookmarks.
- **Config:** MAS disables private API and updater artifacts, replaces resources with `[]`, selects app bundling, sets minimum 13.3, selects MAS entitlements and embeds profile. Identifier remains `PoliteDB`; inherited DeveloperTool category maps to developer tools. Inherited `plugins.updater` config remains despite plan wording; it is inert with the plugin unregistered, not a demonstrated updater bypass.
- **D1/D7:** Reviewed purchase buttons and Sponsor are hidden with correct frontend flavor; activation/refresh/deactivation remain. Backend rejection is missing (P1-1). Device-ID native replacement remains Phase 2. D7 is not automatic App Review approval: 2.4.5(vi) restricts license-key/copy-protection flows, while 3.1.3(b) requires corresponding IAP. Validate final optional legacy-key flow before submission; Phase 1 cannot be submitted as a key-only product.
- **D2:** No AI resources; start/download/autostart blocked. UI/bootstrap incomplete (P1-3).
- **D3:** Oracle removed from picker/runtime registry. Imported/shared Oracle profiles remain representable and fail with generic `ENGINE_NOT_SUPPORTED` (`src-tauri/src/commands/profile/connect.rs:292`). Add edition-specific feedback in the recorded follow-up without corrupting profiles.
- **D4/D5:** Identifier/minimum OS match decisions. Verify hard-coded team/prefix against the real profile. Container isolation alone does not establish Keychain isolation; application identifiers/groups matter too.
- **D6/D8:** Legacy trial exclusion missing (P1-2). StoreKit products, intro offers, verification/updates/restore and subscription-or-key entitlement are Phase 4, not verified here.
- **2.4.5/2.5.1:** Self-update blocked at registration, permission selection, UI check and install command. AI executables excluded. Private API disabled through config/CLI, not Cargo feature alone. Native replacements/bookmarks and sandbox launch still pending. `allow-jit` lacks demonstrated necessity; ad-hoc entitlement inspection cannot establish App Review acceptance.

Policy: [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), checked 2026-10-09. Storefront/approved exceptions vary; D7 deliberately requires a stricter universal no-external-purchase policy. Configuration references retrieved through Context7: [Tauri configuration merging](https://v2.tauri.app/develop/configuration-files/), [Tauri App Store distribution](https://v2.tauri.app/distribute/app-store/). Local CLI schema confirms capability discovery.

## Script restoration and security/privacy

An unchanged script copy was tested in temporary directories with mock `npx` rewriting a disposable manifest. Success, exit 7, process-group SIGINT (Ctrl-C equivalent) and process-group SIGTERM all restored original bytes and removed backup. No restoration defect reproduced. This did not exercise real Tauri subprocess/signing behavior. SIGKILL/power loss cannot execute EXIT cleanup; concurrent manifest edits/builds may be overwritten by snapshot restoration. Avoid concurrent flavor builds in this checkout.

No new sensitive SQL/credential/database/path logging or telemetry found in changed application code. Analytics consent, branded Keychain mappings and destructive-action confirmation/transaction/rollback paths are unchanged. Provisioning profiles ignored; no certificate/profile/key introduced in reviewed files. URL policy and entitlement are security-sensitive findings. Workflow calls for a separate Claude security pass after fixes.

Workflow-doc changes and removed Grok handoff script consistently switch to Claude/Codex; no application-runtime effect found. They were included in this review, not excluded as unrelated noise.

## Round 1 reviewer verification (historical)

- `npm run build`: passed for default/direct and `VITE_DISTRIBUTION=appstore`, both including TypeScript checking.
- `npm run test:run`: 112 files / 615 tests passed in each environment.
- `cargo check --locked`: passed with and without `--features app-store`.
- `cargo test --locked`: 132 passed / 1 ignored with and without `--features app-store`.
- Script restoration mock: four cases passed as above.
- `git diff HEAD --check`: passed before report write. Post-check inventory retained original tracked/untracked changes and staged deletion.

Build warnings remain for browser-externalized `node:zlib`, mixed static/dynamic imports and large chunks. Existing helper tests cover individual flags, not command/UI integration or cross-flavor consistency.

Not performed: Clippy, real universal bundle/signing/profile validation, sandbox launch, affected-screen GUI inspection, native Keychain smoke, DMG updater/license/Oracle/local-AI smoke, StoreKit, Transporter or App Review. Raw Cargo checks use base dependency/config path, not the CLI-rewritten MAS manifest. Implementer's ad-hoc bundle evidence was read, not independently reproduced. These limitations remain after P1 fixes; final MAS artifact needs real signing/sandbox verification.

## Re-review — round 1 fixes (Codex, 2026-10-09)

Reviewed the complete working tree against `HEAD` (7c805a3), staged and unstaged changes plus every untracked file, after reading AGENTS.md, WORKFLOW.md, round 1 report and PLAN.md's fix section. No application code, staging or commit. No remaining P0/P1 or new supported-flow direct regression found. Status is **VERIFIED WITH LIMITATIONS**, with the residual P2 and signing/runtime checks below explicitly open.

### Finding dispositions

| Finding | Result | Evidence and remaining boundary |
| --- | --- | --- |
| P1-1 | Resolved | `Distribution::allows_external_url` permits direct URLs unchanged; MAS allows mail and reviewed GitHub issue paths only. URL parsing normalizes traversal and rejects unapproved HTTPS hosts/paths, userinfo and non-default ports. `license_open_external_url` checks policy before spawning the opener. Shared `openExternalUrl` suppresses webview fallback on the exact distribution error; other opener failures retain existing browser/mail fallback. Purchase/Sponsor actions remain hidden in MAS. Policy tests and fallback tests pass. |
| P1-2 | Resolved | Load/save apply trial policy before expiry normalization; activation/refresh API normalization always exits through save. Clear strips trial fields before writing. Fresh and persisted/API fallback dates never reach MAS storage/UI, and the MAS AI gate requires active status even if given an unsanitized future trial. Inactive constructors still create temporary trial fields internally; these are stripped at authoritative boundaries and never grant MAS access. Direct policy is identity, preserving trial and activation/refresh/deactivation behavior. |
| P1-3 | Resolved | MAS selects the unavailable runtime hook at module initialization. Empty endpoint prevents bundled provider bootstrap; the hook invokes no runtime commands. Panel/settings filter local kinds, the canonical persisted `local` selection becomes empty, and existing cloud providers supply selection fallback. Fresh installs remain unconfigured until cloud setup. Direct retains the original runtime hook, provider bootstrap, controls and autostart. Credentials/persisted provider records are filtered for display, not deleted. |
| P2-1 | Source fix resolved; verification limited | MAS plist now contains exactly `keychain-access-groups = [B3X2G545LX.PoliteDB]`; the invalid prefixed key is absent. Application/team identifiers agree in source. Real provisioning authorization and signed sandbox save/read/delete remain unverified. |
| P2-2 | Partially resolved; residual P2 unresolved | Normal Tauri hooks now choose the right Vite mode; feature/config mismatches are rejected. Raw Cargo tests remain usable with a warning for MAS. The check still does not identify the compiled frontend, and the assertion is narrower than the “always ships” comment. See residual finding below. |

### P2-2 residual — frontend artifact flavor is not validated

**Location:** `src-tauri/build.rs:15-35`; `src/lib/distribution/index.ts:4-6`, `:45-47`; `src-tauri/tauri.appstore.conf.json:3-6`.

The frontend still independently reads Vite mode. Rust checks only the Cargo feature against a capability name in `TAURI_CONFIG`; it never reads the flavor of `frontendDist` or the active dev server. Standard `tauri build/dev` hooks resolve the original normal-path mismatch, but a prebuilt frontend pipeline can embed MAS assets into a direct Rust release (for example, `npm run build:appstore` followed by raw `cargo build --release --features tauri/custom-protocol`), or retain direct assets when MAS build hooks are overridden. No current assertion detects either asset mismatch. The raw release example is a static execution-path assessment, not a release build reproduced in this re-review. Backend purchase/runtime/updater guards still protect MAS commands; the artifact can nevertheless expose incompatible UI or hide working direct features.

**Follow-up:** Emit frontend flavor metadata and validate it against authoritative Rust/config selection for packaged artifacts; retain raw Cargo test support. Until then, package only through the flavor-specific Tauri hooks, and avoid reusing `dist` or overriding those hooks across flavors. This remains P2, not a demonstrated failure of the supported wrapper or a new P1.

Mapping arbitrary Vite modes to direct is now intentional: `development`, `production`, `test` and custom modes are build modes, not invalid distribution values. The former `VITE_DISTRIBUTION` typo path is gone.

### build.rs compatibility assessment

- Both raw Cargo test flavors pass independently. Direct with `TAURI_CONFIG={}` also passes after the MAS test, exercising the actual build script and tauri-build on return to direct.
- Compiled the current consistency function unchanged into a temporary harness, omitting only the subsequent `tauri_build::build()` call. Six cases: direct/no config passes; MAS/no config passes with warning; direct/`{}` passes; MAS/`{}` rejects; direct/MAS config rejects; MAS/MAS config passes. This matrix verifies the custom function, not real MAS CLI packaging.
- `TAURI_CONFIG` changes trigger reruns; Cargo separately tracks feature combinations. Direct CLI configurations without an `appstore` capability do not trip the new check. MAS feature with an explicitly direct override is intentionally rejected, rather than a direct/test regression.
- Installed tauri-build 2.6.1 merges the override into base config and compares CLI-managed manifest features with `AppConfig::features()`. This supports private-API exclusion on the normal MAS CLI path, but does not prove the entire transitive feature graph or frontend identity. Raw MAS Cargo tests still use the base private-API feature and are not distributable MAS evidence.
- A capability string is a marker, not validation of the full MAS policy. Preserve wrapper/config discipline until packaging validation is added. Implementer's real CLI ad-hoc build evidence was read, not repeated here.

Config/hook behavior checked against current [Tauri config documentation](https://v2.tauri.app/develop/configuration-files/) and [App Store distribution documentation](https://v2.tauri.app/distribute/app-store/) through Context7, plus installed tauri-build source.

### Direct entitlement rationale and regression assessment

Leaving `entitlements.mac.plist` unchanged is reasonable **for this MAS-only fix**. It is byte-identical to HEAD. Its existing `com.apple.security.keychain-access-groups` key is still invalid; the accompanying claim that it prevents -34018 is not established. Replacing it blindly would newly claim a restricted entitlement, while the direct bundle config embeds no provisioning profile and the value contains a literal Xcode substitution variable. Apple's [distribution signing guidance](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac?changes=_9) requires profile authorization for `keychain-access-groups`; [Xcode keychain configuration](https://developer.apple.com/documentation/xcode/configuring-keychain-sharing?changes=_3) documents Xcode's variable expansion. Those facts support deferring a direct signing change; they do not prove every such change necessarily breaks launch.

Track direct entitlement cleanup separately with proper variable resolution, provisioning decision, existing-credential access and signed DMG launch/save/read/delete tests. Do not treat preserving the typo as fixing direct Keychain semantics. MAS prefix/group still needs comparison with the real profile. Apple's [Keychain sharing documentation](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps?changes=lat__7_7&language=objc) also distinguishes access groups from ordinary file-based macOS Keychain behavior; container isolation alone does not prove secret isolation.

Direct compatibility checked statically and through tests: local trial policy remains unchanged; pricing/Sponsor/support/mail OS opening and generic-error fallback remain; AI local hook/bootstrap/start/download/autostart remain; updater registration/check/install remain. Base Tauri config and direct entitlement bytes are unchanged, and MAS capability permissions equal default minus `updater:default`. No new logging/telemetry or changes to branded secret identities, credentials, profile persistence or destructive database safeguards found. Workflow/Grok-script changes remain administrative.

### Re-review verification and limits

- `npm run build`: passed (direct; TypeScript + Vite).
- `npm run build:appstore`: passed (TypeScript + Vite appstore mode).
- `npm run test:run`: **115 files, 623 tests passed**.
- `cargo test --locked`: **141 passed, 1 ignored**.
- `cargo test --locked --features app-store`: **141 passed, 1 ignored**.
- `TAURI_CONFIG='{}' cargo test --locked` without MAS feature: **141 passed, 1 ignored**.
- Temporary consistency-function matrix: six expected results; exact MAS entitlement key/group and unchanged direct plist assertions passed; capability comparison passed.
- `git diff HEAD --check`: passed before report update; final inventory preserves staged deletion and all tracked/untracked application changes.

Frontend warnings remain: browser-externalized `node:zlib`, mixed static/dynamic imports and large chunks. No new dependency-manager/lockfile issue found. No Clippy rerun; implementer's existing-warning report is not independently certified here.

No GUI/signed DMG smoke, real universal MAS bundle, real profile/certificate validation, sandbox launch or native Keychain smoke performed. New AI tests cover availability helpers and the stub; existing panel tests mock availability as true, so actual MAS panel/settings integration is supported by source review rather than a rendered integration test. URL tests exercise policy/fallback, not a live OS opener. License tests cover policy/gates, not real activation API calls. The ignored native Keychain test remains ignored. Temporary constructor/API trial fields are safe at reviewed boundaries but tests do not directly invoke AppHandle persistence paths.

Later-phase limitations remain: native subprocess replacement (including device ID), bookmarks, StoreKit and signed distribution/submission. Imported Oracle feedback and real signed sandbox validation remain follow-ups. D7 acceptance, `allow-jit` necessity and App Review outcome are not certified. Workflow still calls for Claude's separate security pass on license/URL/entitlement changes; Codex did not perform or mark that pass complete.
