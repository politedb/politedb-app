# Mac App Store Distribution Flavor

## Status

IMPLEMENTED

## Task

- ID: mac-app-store-flavor
- Requested 2026-10-09: publish PoliteDB on the Mac App Store (MAS).
- User approved the plan with all decisions D1–D8 on 2026-10-09 ("chốt").
- Previous plan (branded-keychain-entries, IMPLEMENTED) is in git history.
- Implement phases in order on branch `feat/mac-app-store-flavor`; record progress and verification evidence in this file.
- Current: Phases 1, 1c and 2 committed (Phase 2 + D16 on `feat/mas-native-apis`, Codex VERIFIED). Phase 3 (design revision 3) APPROVED by the user on 2026-10-11 ("tôi duyệt làm đi"); IMPLEMENTED on branch `feat/mas-file-access`, Codex VERIFIED WITH LIMITATIONS (round 4), Claude security review clean. Interactive signed-sandbox matrix pending (human). Phases 3–6 follow one per branch; Phase 4/5 need App Store Connect products and signing assets from the user.
- No commit/push unless requested.

## Goal And Visible Result

- A second macOS build flavor, `appstore`, that passes App Store review and uploads to App Store Connect as a universal `.pkg`.
- The existing Developer ID DMG flavor keeps current behavior unchanged: updater, license/trial, non-sandboxed file access, Oracle, local AI runtime.
- Both flavors build from the same source; flavor differences are selected at build time, not by scattered runtime `if` checks.

## Decisions

All decisions resolved by the user on 2026-10-09:

- D1 Monetization in MAS — **Free download + StoreKit In-App Purchase** that unlocks the same features as a paid license. Licensing UI that links to external purchase is removed from the MAS flavor (guideline 3.1.1).
- D2 Local AI runtime — **Amended 2026-10-09: bundled runtime removed from every flavor (Phase 1c).** Originally "excluded from MAS v1". The user removed the AI download/sign/verify steps from `.github/workflows/release.yml`; local AI becomes a user-configured API (Ollama, LM Studio, other OpenAI-compatible servers) available in all flavors, including MAS.
- D3 Oracle — **Hidden in the MAS flavor.** Oracle loads Instant Client `libclntsh.dylib` from `~/Downloads`, `/opt/homebrew/lib`, `DYLD_LIBRARY_PATH` (`src-tauri/src/engines/oracle/mod.rs`), which the sandbox and library validation block.

- D4 Bundle identifier — **Reuse `PoliteDB`** for both flavors (Apple allows one bundle ID for Developer ID and MAS). The MAS sandbox container keeps data separate from the DMG install regardless.
- D5 Minimum macOS — **13.3, same as DMG** (`MIN_SUPPORTED_MACOS_MAJOR/MINOR` in `src-tauri/src/main.rs`). Set `LSMinimumSystemVersion` / `bundle.macOS.minimumSystemVersion` to `13.3` in the MAS config. StoreKit 2 is available on this baseline.
- D6 IAP product model — **Auto-renewable subscriptions, monthly + yearly**, in one subscription group, with the free trial delivered as an App Store introductory offer. The in-app license trial (`trial_started_at` / `trial_expires_at`, `TrialExpiredOverlay.tsx`) is not used in the MAS flavor; the MAS gate is "active subscription OR valid license key (D7)". Product IDs, prices and trial length are configured in App Store Connect and referenced from one constants module.
- D7 Existing license keys — **Accepted in MAS** as a multiplatform entitlement (guideline 3.1.3(b)) while IAP remains available. The MAS build must not show prices, purchase/checkout links, or text directing users to buy outside the App Store; `license_open_external_url` purchase targets are disabled in MAS (account/support links that do not mention purchasing may remain). Key activation/refresh/deactivation keep using the existing backend. Device ID for activation must work in the sandbox (replace the `ioreg` subprocess with the IOKit API; keep the generated ID identical to the current one for the same Mac so DMG and MAS activations count as the same device).
- D8 Entitlement verification — **On-device only** via StoreKit 2 (`Transaction.currentEntitlements`, `Transaction.updates`, StoreKit-verified JWS). No backend changes. Subscription state is not reported to the PoliteDB license backend in v1.

## Current Code Blockers (from repo inspection 2026-10-09)

| Area                                                  | Location                                                                                                                                         | MAS problem                                                                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private API                                           | `tauri.conf.json` `macOSPrivateApi: true`                                                                                                        | Guideline 2.5.1 rejection. Verify `window_chrome.rs` (public NSWindow APIs via `msg_send!`) still works with it off.                                                                                           |
| Self-update                                           | `tauri-plugin-updater` in `main.rs`, `createUpdaterArtifacts`, `src/lib/updater/runtimeUpdater.ts`, capability `updater:default`                 | Guideline 2.4.5: MAS apps must not self-update.                                                                                                                                                                |
| License / external purchase                           | `src-tauri/src/license.rs`, `commands/license.rs` (opens purchase URL), `LicenseDialog.tsx`, `LicenseKeySettings.tsx`, `TrialExpiredOverlay.tsx` | Guideline 3.1.1: external purchase flow must be removed from MAS (D1); see D7 for existing keys.                                                                                                               |
| Device ID via `ioreg` subprocess                      | `license.rs:231`                                                                                                                                 | Subprocess in sandbox. Needed in MAS for license-key activation (D7): replace with IOKit API, same ID output.                                                                                                  |
| Touch ID via `/usr/bin/swift -e`                      | `commands/security.rs:49`                                                                                                                        | Requires Xcode CLT on the user's Mac and spawns a compiler; not viable in sandbox. Replace with LocalAuthentication (`LAContext`) via objc2 for both flavors.                                                  |
| macOS version check via `sw_vers` + `osascript` alert | `main.rs:62`, `main.rs:75`                                                                                                                       | Subprocess + Apple Events in sandbox. Use `NSProcessInfo.operatingSystemVersion` and a native alert; MAS also enforces `LSMinimumSystemVersion`.                                                               |
| Local listeners                                       | `ssh_tunnel/open.rs:38`, `ai_runtime.rs:340`                                                                                                     | Need `com.apple.security.network.server`.                                                                                                                                                                      |
| Oracle client libs                                    | `engines/oracle/mod.rs`                                                                                                                          | Hidden in MAS (D3).                                                                                                                                                                                            |
| Bundled AI helper                                     | `ai_runtime.rs` `resolve_bundled_server_bin`, `resources/ai`                                                                                     | Not bundled in MAS (D2).                                                                                                                                                                                       |
| User-selected files persisted across launches         | SQLite/DuckDB `path` in profiles, SSH private key path (`ssh_tunnel/types.rs`), CSV import/export, DBeaver import (`profiles/import_dbeaver.rs`) | Sandbox grants access only for the current session; persisted paths need security-scoped bookmarks.                                                                                                            |
| Home-relative app files                               | `ssh_tunnel/open.rs:67` `~/.politedb/ssh_known_hosts`                                                                                            | Resolves inside the container under sandbox; works but separate from DMG data. Document.                                                                                                                       |
| Keychain                                              | `security/keychain_macos.rs`                                                                                                                     | Security.framework works in sandbox; the access group must match the MAS team prefix + bundle ID. DMG keychain items are not readable from MAS; users re-enter passwords. The `security` CLI use is test-only. |

## Scope And Architecture

- Build flavor selection:
  - Rust: Cargo feature `app-store` (off by default). Flavor-specific behavior lives behind a small `distribution` module (e.g. `src-tauri/src/distribution.rs`) exposing capabilities such as `supports_self_update()`, `supports_external_license()`, `supports_oracle()`, `supports_local_ai()`. No `cfg` checks scattered across commands.
  - Frontend: Vite mode `appstore` (pinned by `tauri.appstore.conf.json` `beforeBuildCommand` / `beforeDevCommand`) read once in `src/lib/distribution`; UI gates (updater, license purchase links, Oracle engine option, local AI) consume that helper only.
  - Tauri config: `src-tauri/tauri.appstore.conf.json` merged via `tauri build --config`: `macOSPrivateApi: false`, `createUpdaterArtifacts: false`, no updater plugin config, `bundle.macOS.entitlements = entitlements.appstore.plist`, `bundle.macOS.files` embedding `embedded.provisionprofile`, `bundle.resources` without `resources/ai` (D2), `LSApplicationCategoryType = public.app-category.developer-tools`, `ITSAppUsesNonExemptEncryption` set correctly (app uses TLS/SSH — standard exemption; confirm in App Store Connect).
  - Capabilities: separate capability file for MAS without `updater:default`.
- Entitlements `src-tauri/entitlements.appstore.plist`:
  - `app-sandbox = true`, `network.client`, `network.server`, `files.user-selected.read-write`, `files.bookmarks.app-scope`, `com.apple.application-identifier = <TEAMID>.PoliteDB`, `com.apple.developer.team-identifier = <TEAMID>`, keychain access group `<TEAMID>.PoliteDB`.
  - Keep `cs.allow-jit` only if WebView/Monaco needs it under MAS; drop `disable-library-validation` and `allow-unsigned-executable-memory` unless a verified need remains.
- Security-scoped bookmarks:
  - New macOS adapter (`src-tauri/src/security/bookmarks_macos.rs`) behind a narrow port: create bookmark from a user-picked path, resolve + `startAccessingSecurityScopedResource` / stop.
  - Profiles store an optional opaque bookmark next to the existing path field; the path stays the display/compat value. DMG flavor ignores bookmarks (no behavior change).
  - Apply to SQLite/DuckDB files, SSH private key file, and folders used for import/export. Re-prompt with the file picker when a bookmark is stale or missing.
- Native replacements usable by both flavors (safe improvements, kept behavior-equivalent):
  - Touch ID via `LAContext` instead of `/usr/bin/swift`.
  - macOS version via `NSProcessInfo`; alert via native dialog instead of `osascript`.
- Release pipeline: new job in `.github/workflows/release.yml` (manual `workflow_dispatch` only at first) that builds `universal-apple-darwin` with `--features app-store` and `--config tauri.appstore.conf.json`, signs the app with `Apple Distribution`, packages with `productbuild --sign "3rd Party Mac Developer Installer: …"` (or `Mac Installer Distribution`), and uploads with `xcrun altool --upload-app --type macos` using the existing App Store Connect API key. Existing DMG jobs untouched.

## Apple Account Setup (human, outside repo)

- Certificates: `Apple Distribution` (or `Mac App Distribution`) and `Mac Installer Distribution`, exported as `.p12`.
- Provisioning profile: `Mac App Store Connect` for App ID `PoliteDB` (explicit).
- App Store Connect app record: name, SKU, primary category Developer Tools, privacy policy URL, App Privacy answers (PostHog opt-in analytics), screenshots, review notes with a demo database (e.g. bundled sample SQLite or public test server).
- Paid Applications agreement, banking and tax forms completed in App Store Connect (required before IAP can be tested or sold).
- IAP products created per D6 (product IDs, prices, localized names, review screenshot), and a sandbox tester account.
- New GitHub secrets (final names chosen during implementation and recorded here, e.g. `MAS_APP_CERTIFICATE`, `MAS_APP_CERTIFICATE_PASSWORD`, `MAS_INSTALLER_CERTIFICATE`, `MAS_INSTALLER_CERTIFICATE_PASSWORD`, `MAS_PROVISION_PROFILE`). Never commit certificates or profiles.

## Phases

1. Flavor scaffolding: Cargo feature, `distribution` modules (Rust + TS), `tauri.appstore.conf.json`, MAS entitlements and capability file, npm scripts `tauri:build:appstore`. MAS build launches sandboxed locally with updater/license/Oracle/local-AI gated per decisions.
2. Native replacements: LAContext Touch ID, NSProcessInfo version check, native alert. Applied to both flavors with tests where practical.
3. Security-scoped bookmarks for SQLite/DuckDB, SSH key, import/export; profile schema extension with backward-compatible serde defaults; export/import of profiles ignores or strips bookmarks (machine-specific).
4. In-App Purchase (D1): StoreKit 2 bridge in a dedicated native module (Swift package or objc2 bindings, built into the app — never via `/usr/bin/swift`) behind a narrow port (`products`, `purchase`, `restore`, `current_entitlements`, transaction updates listener). Map verified entitlements onto the existing license state shape so feature gating code stays single-sourced. Paywall/upgrade UI in MAS uses StoreKit products and must include Restore Purchases, terms and privacy links. Products per D6 (monthly + yearly subscription, intro-offer trial); feature gate = active subscription OR valid license key (D7); on-device verification only (D8). License-key entry UI stays in MAS with purchase links removed.
5. CI job: universal build, sign, productbuild, upload; dry-run mode that stops before upload.
6. Submission: TestFlight for macOS, internal testing, then App Review.

## Compatibility And Security

- DMG flavor: no behavior change except the Touch ID / version-check native replacements, which must be behavior-equivalent and covered by tests.
- No data migration from DMG to MAS (sandbox cannot read it); document using the existing encrypted profile export/import.
- No raw SQL, credentials, file paths, bookmarks or database names in logs/telemetry.
- Bookmark data is treated like a path: stored locally only, never exported in encrypted profile exports.
- Keep confirmation/transaction/rollback behavior for destructive DB actions unchanged.

## Verification

- `cargo check` / `cargo test` with and without `--features app-store`; `cargo clippy` clean for both.
- `npm run build` and `npm run build:appstore`; `npm run test:run`.
- Unit tests: distribution gating helpers (Rust + TS), profile serde with/without bookmark, bookmark port with a fake adapter, version parsing.
- Local MAS build: `codesign -d --entitlements :- PoliteDB.app` shows sandbox entitlements; app launches sandboxed (Activity Monitor "Sandbox: Yes").
- Manual MAS smoke: connect Postgres/MySQL directly and over SSH tunnel (password + key file), open SQLite file, relaunch and reopen it via bookmark, CSV import/export, keychain save/read, Touch ID, cloud AI provider; confirm updater/license/Oracle/local-AI gating per decisions.
- DMG regression smoke: updater check, license activation, Oracle detection, local AI start, SQLite open, SSH tunnel.
- StoreKit: local tests with a `.storekit` configuration file (purchase, cancel, pending, refund/revoke, restore, expiry if subscription); then App Store sandbox tester on a MAS build; entitlement survives relaunch and offline launch; feature gates match the existing license tiers; no external purchase link visible anywhere in MAS.
- `xcrun altool --validate-app` (or Transporter validation) passes before any upload.
- Document anything not verifiable locally (App Review outcome, TestFlight install on a clean Mac).

## Risks

- App Review may still question `cs.allow-jit` or helper binaries; budget a review round-trip.
- Security-scoped bookmarks touch profile persistence (security-sensitive); keep the change additive.
- Universal build doubles Rust compile time in CI.
- StoreKit is the largest single item: needs Paid Apps agreement, banking/tax, and IAP products configured in App Store Connect, plus a StoreKit configuration file for local testing before sandbox-account testing.

## Implementation Progress

### Phase 1 — Flavor scaffolding (Claude, 2026-10-09)

Branch: `feat/mac-app-store-flavor` (from `main` 7c805a3). Uncommitted; no push.

Files:

- `src-tauri/Cargo.toml`: feature `app-store = []`.
- `src-tauri/src/distribution.rs` (new): `Distribution::{Direct, AppStore}` from `cfg!(feature = "app-store")`; `supports_self_update`, `supports_local_ai_runtime`, `supports_engine(EngineKind)` (Oracle off in MAS); `ensure()` returns `FEATURE_UNAVAILABLE_IN_DISTRIBUTION`. 4 unit tests.
- `src-tauri/src/main.rs`: drivers filtered by `supports_engine`; updater plugin registered only when `supports_self_update`; local AI autostart only when `supports_local_ai_runtime`.
- `src-tauri/src/commands/ai.rs`: `ai_runtime_start`, `ai_runtime_download_default_model` guarded. `src-tauri/src/commands/updater.rs`: `updater_install_if_allowed` guarded.
- `src/lib/distribution/index.ts` (new) + tests: `VITE_DISTRIBUTION` → `DISTRIBUTION_FEATURES` (`selfUpdate`, `externalPurchase`, `localAiRuntime`, `unsupportedEngines`), `isEngineSupported`. `src/vite-env.d.ts` types `VITE_DISTRIBUTION` (and the already-used `VITE_POLITEDB_API_BASE`, `VITE_LICENSE_PRODUCT`).
- Frontend gates: `runtimeUpdater.shouldRunUpdaterCheck` (no update check/badge in MAS); "Buy a license" hidden in `LicenseKeySettings.tsx`, `LicenseDialog.tsx`, `TrialExpiredOverlay.tsx`; GitHub Sponsor menu item hidden in `LeftNav.tsx`; Oracle filtered from the new-connection picker in `ConnectionModal.tsx`. Label lookups via `SUPPORTED_DATABASES` are unchanged so existing profiles still render.
- `src-tauri/tauri.appstore.conf.json` (new): `macOSPrivateApi: false`, capabilities `["appstore"]`, targets `["app"]`, no updater artifacts, `resources: []` (no `resources/ai`), `signingIdentity: null` (comes from `APPLE_SIGNING_IDENTITY`), MAS entitlements, `minimumSystemVersion: 13.3`, `embedded.provisionprofile` copied from `src-tauri/`.
- `src-tauri/entitlements.appstore.plist` (new): sandbox, application-identifier / team-identifier / keychain group `B3X2G545LX.PoliteDB`, network client+server, user-selected read-write, app-scope bookmarks, allow-jit. No `disable-library-validation` / `allow-unsigned-executable-memory`.
- `src-tauri/capabilities/appstore.json` (new): `default.json` minus `updater:default`. DMG config is unchanged and still loads all capability files.
- `scripts/tauri-appstore.sh` (new) + npm `tauri:dev:appstore`, `tauri:build:appstore` (universal). The script restores `src-tauri/Cargo.toml` on exit because Tauri CLI rewrites the `tauri` crate features to drop `macos-private-api` when `macOSPrivateApi` is false.
- `.gitignore`: `src-tauri/embedded.provisionprofile`, `*.provisionprofile`.
- Workflow docs: `.agent/WORKFLOW.md`, `AGENTS.md` switched to Claude (plan/implement) + Codex (critique/review).

Verification:

- `cargo check` / `cargo test` with and without `--features app-store`: 132 passed, 1 ignored each; `distribution` tests pass in both.
- `cargo clippy` both flavors: only 5 pre-existing warnings (`commands/export.rs`, `engines/mysql/driver.rs`); none in changed files.
- `npm run build` (tsc + vite) and `VITE_DISTRIBUTION=appstore vite build`: pass. `npm run test:run`: 112 files, 615 tests passed.
- `APPLE_SIGNING_IDENTITY=- scripts/tauri-appstore.sh build --debug` with a placeholder profile: bundle has `Contents/embedded.provisionprofile`, no `Resources/ai`, `LSMinimumSystemVersion=13.3`, `LSApplicationCategoryType=public.app-category.developer-tools`, `CFBundleIdentifier=PoliteDB`; `codesign -d --entitlements` shows exactly the MAS entitlements above; `Cargo.toml` restored byte-for-byte afterwards.

Limitations / follow-ups (not done in Phase 1):

- Sandboxed launch not tested: needs the real Mac App Store provisioning profile and Apple Distribution certificate (restricted entitlements do not launch ad-hoc).
- ~~Local AI panel UI still renders bundled-runtime controls in MAS~~ — fixed in review round 1 (P1-3).
- Oracle profiles can still arrive via DBeaver/TablePlus import or shared profiles; in MAS they fail to connect (no driver). Needs a clear "not available in this edition" message (Phase 1b).
- `license_open_external_url` still shells out to `open`; move to NSWorkspace in Phase 2 alongside other subprocess replacements.
- `ITSAppUsesNonExemptEncryption` not set; export-compliance answer is a human decision in App Store Connect.
- Team ID `B3X2G545LX` (from the current Developer ID identity in `tauri.conf.json`) is hard-coded in the MAS entitlements; it must match the team that owns the MAS provisioning profile.

### Review round 1 fixes (Claude, 2026-10-09)

Addresses `.agent/REVIEW.md` (Codex, CHANGES REQUIRED). Uncommitted.

- P1-1 external purchase targets: `Distribution::allows_external_url` (`src-tauri/src/distribution.rs`) — direct unchanged; App Store allows only `mailto:` and `https://github.com/politedb/PoliteDB/issues/**` (no userinfo/port, path checked after URL normalization). Enforced first in `license_open_external_url` (`commands/license.rs`). Frontend opener centralized as `openExternalUrl` in `src/lib/tauri/license.ts` (replaces 4 local helpers in `LeftNav.tsx`, `LicenseKeySettings.tsx`, `LicenseDialog.tsx`, `TrialExpiredOverlay.tsx`); it falls back to the webview only when the OS opener fails, never on `FEATURE_UNAVAILABLE_IN_DISTRIBUTION`.
- P1-2 local trial: `Distribution::supports_local_trial`; `license.rs` `apply_trial_policy` strips trial dates and the trial-expired message for App Store, applied through `finalize_state` on load/save (covers API fallback via `normalize_api_state` → save) and in `license_state_clear` before writing. `blocks_ai_feature` → `blocks_ai_feature_for(state, distribution)`: App Store requires `active`. Direct behavior unchanged (existing trial tests still pass). License UI renders trial text only from `trial_expires_at`, so it disappears with the dates.
- P1-3 local AI UI/bootstrap: `useUnavailableAiRuntimeManager` (same return shape, no runtime commands, empty endpoint → no `ensureLocalAiProvider`) chosen per build at module scope in `AiAssistantPanel.tsx`. `providers.ts`: `isAiProviderKindAvailable`, `filterAvailableAiProviders`, `fallbackSelectedAiProviderId`; `getSelectedAiProviderId` ignores a persisted bundled-local selection on App Store. Settings dialog hides local kinds and the Local Runtime section can no longer be selected.
- P2-1: MAS entitlement key corrected to `keychain-access-groups`. The direct `entitlements.mac.plist` still uses the non-standard `com.apple.security.keychain-access-groups` key; it is left unchanged on purpose — enabling the real restricted key with a literal `$(AppIdentifierPrefix)` and no provisioning profile risks the Developer ID app failing to launch. Track separately with a signed DMG smoke test.
- P2-2 single flavor input: frontend flavor now comes from the Vite mode (`npm run build:appstore` / `dev:appstore`, pinned by `tauri.appstore.conf.json` `build.*Command`), so the MAS Tauri config cannot ship the direct frontend; `VITE_DISTRIBUTION` removed. `src-tauri/build.rs` panics when the `app-store` feature and the MAS config (`TAURI_CONFIG` selecting capability `appstore`) disagree, and warns when `app-store` is built without Tauri CLI (private API still on). With a consistent pair, tauri-build's own feature/config check guarantees `macos-private-api` is off in MAS artifacts.

Verification (round 1):

- Rust: `cargo test` 141 passed / 1 ignored with and without `--features app-store` (new: URL allow/deny incl. `..` and `%2e%2e` traversal, userinfo, port, scheme; trial strip/keep; AI gate per flavor). `cargo clippy` both flavors: only the 5 pre-existing warnings.
- `build.rs` matrix: feature off + no `TAURI_CONFIG` → ok; feature on + no `TAURI_CONFIG` → warning; feature off + MAS config → panic; feature on + non-MAS config → panic; feature on + MAS config → ok.
- Frontend: `tsc --noEmit` clean; `npm run test:run` 623 passed (new: `openExternalUrl` fallback policy, provider availability per flavor, unavailable runtime manager never calls runtime commands; `AiAssistantPanel.test.tsx` mock extended).
- `APPLE_SIGNING_IDENTITY=- scripts/tauri-appstore.sh build --debug`: ran `npm run build:appstore` (`vite build --mode appstore`), `build.rs` consistency passed under real Tauri CLI, signed entitlements show `keychain-access-groups = [B3X2G545LX.PoliteDB]`, `Cargo.toml` restored.

- Claude `/security-review` (2026-10-09) on the full uncommitted diff: no findings at confidence >= 8 (URL policy, license/AI gating, entitlements, capabilities, build script reviewed).

Still open after round 1: sandboxed launch with the real profile/certificate; Oracle-import edition message; `open` subprocess → NSWorkspace (Phase 2); direct entitlement key (see P2-1 note); D7 App Review risk under 2.4.5(vi) noted by Codex.

## Phase 1c — Replace bundled local AI with user-configured local API (APPROVED 2026-10-10)

Requested 2026-10-09. Applies to all flavors (direct DMG/Linux/Windows and MAS). Decisions confirmed by the user:

- D9 Bundled runtime — **remove entirely**: `src-tauri/src/ai_runtime.rs`, `ai_runtime_*` commands and registrations (`main.rs`, `commands/ai.rs`, `state/app_state.rs` runtime state, exit shutdown hook), frontend `useAiRuntimeManager` / `useUnavailableAiRuntimeManager`, `AiAssistantRuntimePanes.tsx` runtime screens, runtime controls in `AiAssistantPanelHeader.tsx` / `AiAssistantSettingsDialog.tsx`, `src/lib/tauri/ai.ts` runtime wrappers and `CMD` entries, `scripts/download_default_ai_runtime.sh`, `scripts/setup_llama_runtime.sh`, `scripts/sign-macos-libs.sh`, `bundle.resources: ["resources/ai"]` and `src-tauri/resources/ai/` (+ `.gitignore` entries). Remove the now-meaningless `localAiRuntime` / `supports_local_ai_runtime` distribution flag; MAS config no longer needs `resources: []` for AI.
- D10 Previously downloaded model (`<app_data>/ai/models/default.gguf` and its interrupted-download sibling `default.gguf.part`, ~4–5 GB) — **user-initiated delete button** in AI settings, shown only when either fixed file actually exists (no flavor assumption); never deleted automatically. Backend surface: `ai_legacy_model_info` (presence + size per file) and `ai_legacy_model_delete`. Confinement: trusted root = `app_data_dir()`. Unix: open `ai` then `models` relative to the root with `openat(O_DIRECTORY|O_NOFOLLOW)` and delete with `unlinkat` on the `models` directory handle after `fstatat(AT_SYMLINK_NOFOLLOW)` confirms a regular file (no pathname re-resolution, so ancestor swaps cannot redirect the delete). Windows: open `ai` then `models` with `FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT` and a share mode without `FILE_SHARE_DELETE`, reject reparse points, and keep both handles open for the whole operation so neither ancestor can be renamed or replaced; then open the target with `FILE_FLAG_OPEN_REPARSE_POINT`, verify it is a regular non-reparse file and that its parent is the held `models` directory (`GetFileInformationByHandleEx` file id / final path), and delete through the target handle (`FileDispositionInfo`). Fixtures include a Windows swap attempt during traversal/open (must fail closed). Files only, never directories or recursion; no environment overrides or resource search; `providers.json` untouchable. Already-absent = success; partial failure reports which file remains; UI refreshes info after every attempt. Fixtures: full-only, partial-only, both, neither, permission denied, symlinked `ai` / `models` / target, ancestor swapped between info and delete, and `providers.json`/keys/history unchanged afterwards. Independent of provider selection/deletion and AI entitlement.
- D11 Existing `local` provider record — **Revised (round 2): no provider-file writes at all.** A record matching the legacy signature (`id == "local"`, `kind == ollama`, `label == "PoliteDB AI"`, loopback base URL with port ≠ 11434 and path `/v1`) is a _display hint only_: Settings and the panel show "If this was PoliteDB's built-in AI, it was removed — enter your local server URL" with Dismiss (dismissal stored in localStorage `politedb.ai.legacyLocalNotice.dismissed`). The record keeps its enabled state, URL, models, label and id; nothing is migrated, so an identical user-created record is never changed. Chat against a dead endpoint returns the sanitized connection error with a "Open AI settings" action.
- D12 Local API URL policy — **Revised after Codex critique.** One backend URL policy applied to the final request URL of every AI request (chat, test, validate, model discovery), both at save and at request time. `https`: any host. `http`: only IP literals in loopback/private ranges (`127.0.0.0/8`, `::1`, `10/8`, `172.16/12`, `192.168/16`, `fc00::/7`; IPv4-mapped IPv6 classified by the embedded IPv4) or the exact host `localhost` (connected to loopback only, no system resolver). Rejected: other hostnames over http (incl. `.local`), `0.0.0.0`/`::`, link-local/multicast/reserved, IPv6 zone ids, non-canonical IPv4 spellings (decimal/octal/hex/short) as parsed by `url`, userinfo, query/fragment, schemes other than http/https. AI HTTP clients: redirects disabled, proxies disabled for http local destinations. Cloud kinds keep requiring https.

Also confirmed:

- D13 API key for local servers — **optional key for `local_openai_compatible`** (LM Studio auth, vLLM, LocalAI), stored in keychain with the same `politedb:ai:<id>:api_key` ref as cloud keys and sent as a bearer token only when present. `ollama` stays keyless. Key never logged; deleting the provider deletes its key as for cloud providers.
- D14 Provider kinds/labels — **"Ollama"** (default `http://127.0.0.1:11434/v1`) and **"LM Studio / OpenAI-compatible"** (default `http://127.0.0.1:1234/v1`); both show Host / Sub Path / Model fields like cloud providers, plus "Load models" via `GET <base>/models`. Backend `default_base_url` for `local_openai_compatible` changes from 11434 to 1234 (only affects new providers without a saved URL).

- D15 Model discovery entitlement — **not license-gated**: "Load models" returns only model ids and never runs a completion. Chat, test and validation keep the existing license gate (`blocks_ai_feature`).

Requirements added after Codex plan critique (Blockers 3–5, Should-fix 6–11, Nice-to-have 12–13):

- R1 Single backend transport: model discovery (`ai_provider_list_models`, accepts a draft config so unsaved setups work) and every completion/validation go through Rust with D12 policy and D13 keys. Remove the webview `fetch` paths (`listLocalAiModels`, legacy `generateText` direct-HTTP fallback in `src/lib/ai-assistant/index.ts`); an absent/disabled provider is a setup state that sends no request.
- R2 Preserve kinds and model ids: stop converting `local_openai_compatible` → `ollama` in `normalizeAiProviderConfig`; remove `normalizeLocalAiModelName` model-id rewriting entirely — every saved, typed or server-reported model id (including `default`, `local-model`, `llama3:8b`) is kept exactly, except that surrounding whitespace is trimmed and empty ids are dropped (amended by the user 2026-10-10 after Codex review P2-7). Both kinds appear in Settings; new local providers get unique ids (not `local`); frontend/backend defaults aligned (Ollama 11434, LM Studio 1234) without touching saved URLs.
- R3 Enable/test contract: Settings shows an Enabled toggle. Save persists exactly the form state (including the toggle) after URL-policy/key validation only — no network call, so offline Save works. Test (`ai_provider_test_draft`) and Load models (`ai_provider_list_models`) run on the unsaved draft regardless of `enabled`, persist nothing and never change `enabled`; this is the only exception to R1's "disabled = no request" rule and only on explicit user action. Test is license-gated like today; discovery is not (D15).
- R4 D13 key semantics per kind (also: typed key cleared on dialog close and provider switch; changing kind to `ollama` deletes the stored key after a successful save; save writes config then key and restores the previous config if the key write fails; `ai_provider_set_key` must propagate keychain read/write errors instead of `.ok()`; tests for each failure path): cloud = required, `local_openai_compatible` = optional, `ollama` = none (set-key rejected). Only keychain not-found means "no key"; locked/denied/entitlement errors fail the request. Canonical refs derived from ids; raw keys never returned to the UI; blank input keeps the stored key, explicit "Remove key" deletes it; credentials in URLs rejected; network errors sanitized (no URLs/hosts). Document that http LAN bearer tokens travel unencrypted and recommend https for authenticated LAN servers.
- R5 Selection fallback: enabled-only (selected → default → first enabled); with none, clear selection/model/label, disable submit, keep Settings reachable; handle empty selection events and per-provider model keys; remove bundled-model availability checks from the panel.
- R6 History compatibility: `politedb.ai.chat.*` sessions (incl. `local` attribution), active session, language/context state and cloud model/mode preferences are preserved; viewing history is not license-gated; choosing a replacement provider for a resumed session never rewrites stored per-message attribution; resuming a session whose provider is missing/disabled prompts selection instead of sending to the old endpoint; no broad localStorage clearing. Upgrade fixtures for single/multi-session history.
- R7 Removal inventory (D9): also `useAiAssistantSubmit` local branches, legacy endpoint/model/seen storage helpers in `src/lib/ai-assistant/{index,types,assistant}.ts`, panel runtime mocks/screens, `useUnavailableAiRuntimeManager` + its test, providerAvailability/providers/distribution tests, startup autostart and exit shutdown in `main.rs`. Keep `ai_chat_cancel` state/commands, database `runtimeConnectionId` and `engines/runtime`. Finish with a repo-wide reference sweep (allowlist: legacy cleanup + historical docs).
- R8 Release unit: the uncommitted `release.yml` removals ship only together with D9 and the `bundle.resources` removal (same branch/PR). Clean-checkout package checks for direct macOS/Linux/Windows and MAS assert no runtime binaries/models/resources.
- R9 Docs: README local-server setup (Ollama/LM Studio, ports/subpaths, exact model ids, optional auth, http host limits, if the built-in AI notice appears, point the provider at your own server, manual disk cleanup); obsolete runtime env vars marked unsupported; FEATURE_MAP AI section.
- R13 Single save transaction: replace the frontend's separate save-config + set-key calls (`saveAiProviderWithOptionalKey`) with one backend command `ai_provider_save` that, under the R11 provider lock, reads the prior config and key state, validates (URL policy, key capability per kind), writes the config, then sets/keeps/removes the key, and on key failure restores the prior config. If the rollback write also fails, return a sanitized `AI_PROVIDER_SAVE_ROLLBACK_FAILED` without further writes; the UI reloads providers from disk and shows the error. No network request while holding the lock. Delete uses the same lock (config removal + key deletion). Tests: interleaved save/delete, key-write failure → prior config restored, key-delete failure on kind change, rollback failure path.
- R11 Provider-file persistence: add a provider-file mutation lock in `AppState` covering load/save/delete/key operations, and write `providers.json` with a replace that preserves the original on failure (temp file + fsync + rename over the destination on Unix; `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)` on Windows) instead of the current remove-then-rename in `file_storage::atomic_write_bytes`. Scope the new writer to the AI provider file (other callers unchanged in this phase). Tests: failed replace keeps the old file; concurrent save/delete serialize.
- R12 Validation split: separate URL/key/discovery validation (no model required) from completion validation (`default_model` required) in `commands/ai.rs`, so discovery works on a draft with empty models.
- R10 Discovery/connection bounds: timeouts, response-size and model-count limits, cancellation, stale-draft response protection; empty/invalid lists never erase manually entered models.

Implementation order: (1) backend URL policy (reject non-canonical IPv4 using the original authority text before `url` normalization; transport-level tests with a local test server for redirect/proxy) + validation split (R12) + provider-file lock/replace (R11) + key semantics + discovery/draft-test commands with tests incl. no-network assertions for gated states (direct trial/active/expired, MAS inactive/active); (2) legacy model cleanup (D10) and D11 notice signature; (3) frontend kinds/normalization/selection/settings/history (R2–R6) routed through typed wrappers; (4) remove bundled runtime + resources/scripts/config + distribution flag together with the release.yml change (D9, R7, R8); (5) docs (R9), both-flavor builds/tests/clippy, package checks, localhost/LAN smoke with LM Studio and Ollama, Codex review, Claude `/security-review`.

Scope:

- Backend: delete runtime module/commands/state; add URL policy for local kinds in `commands/ai.rs` (extend `require_https_cloud_url` into a single provider URL policy with tests); D11 legacy-signature notice (display only, no provider-file writes); legacy model info/delete commands for D10.
- Frontend: remove runtime hooks/panes/controls and the module-level runtime-manager selection in `AiAssistantPanel.tsx`; providers.ts drops bundled-local bootstrap (`ensureLocalAiProvider`, `DEFAULT_LOCAL_AI_PROVIDER_ID` default selection) and `localAiRuntime` filtering — local kinds are available in every flavor; settings dialog shows editable host/models for local kinds and the D10 delete button.
- Distribution: drop `localAiRuntime` from TS `DistributionFeatures` and `supports_local_ai_runtime` from Rust; update tests.
- CI: user already removed AI runtime steps from `release.yml`; also remove the stale `BUNDLE_AI_*` / `AI_*` echo lines in the macOS "Print build env summary" step (lines ~72–76). `HF_TOKEN` secret becomes unused (human may delete it).
- Docs: `FEATURE_MAP.md` AI section; remove `resources/ai/README.md`.

Compatibility and security:

- Direct users lose the bundled runtime by design; existing cloud providers, keys and selection are untouched. Chat history/settings unaffected.
- D11 never writes the provider file (notice + dismissal only); D10 deletes only the fixed legacy model path after explicit confirmation.
- No URLs, hosts, prompts or model paths in logs/telemetry.
- MAS: LAN/loopback access is outbound (`network.client`), already granted; no new entitlement.

Verification:

- Rust: URL policy matrix (loopback/LAN http allowed; public http rejected for local and cloud kinds; https any host; userinfo/odd encodings; IPv6), D11 notice: signature match/non-match (custom `id: local`, port 11434, other labels), dismissal persists across reload, provider file byte-identical before/after load, legacy model info/delete with temp dirs; `cargo test` + clippy both flavors.
- Frontend: provider availability in both flavors, settings dialog local fields, delete-model button visibility, panel selection fallback; `npm run build`, `npm run build:appstore`, `npm run test:run`.
- Manual: LM Studio and Ollama on localhost end-to-end chat in direct build; MAS build bundle has no `Resources/ai`; direct DMG build no longer references `resources/ai`.

### Phase 1c — Implementation evidence (Claude, 2026-10-10)

Branch `feat/local-ai-api` (from `feat/mac-app-store-flavor` `b10fa09`). Uncommitted; no push.

Backend (`src-tauri/src/ai/`, new):

- `url_policy.rs` (D12): https any host; http only for canonical IPv4 literals in loopback/private ranges, `::1`, `fc00::/7`, IPv4-mapped (classified by embedded v4) and exact `localhost`; rejects other hostnames incl. `.local`, `0.0.0.0`/`::`, link-local/multicast/public, zone ids, non-canonical IPv4 spellings (checked against the original authority text), userinfo, query/fragment, other schemes. Cloud kinds https only.
- `transport.rs`: `Policy::none()` redirects (3xx → `AI_PROVIDER_REDIRECT_BLOCKED`), connect/request timeouts, `no_proxy` for http, `localhost` pinned to 127.0.0.1 via `resolve`, bounded body reader, URL-free error codes.
- `provider.rs`: types moved from `commands/ai.rs`; per-kind class/key capability/defaults (LM Studio 1234); `validate_for_discovery` vs `validate_for_completion` (R12); model ids preserved exactly; `endpoint()` re-validates every request URL.
- `provider_store.rs` (R4, R13): `save` = validate → read prior file/key state → write config → set/keep/remove key → on key failure restore prior file, rollback failure → `AI_PROVIDER_SAVE_ROLLBACK_FAILED`; Ollama rejects keys and kind change to Ollama deletes the stored key; required kinds must end with a key; `request_key` distinguishes not-found from keychain errors (`AI_PROVIDER_KEYCHAIN_FAILED`). Ports (`SecretPort`, `ProviderFilePort`) with fakes in tests; `adapters.rs` wires Tauri/keychain.
- `chat.rs`: completions (OpenAI-like, Anthropic, Gemini) and `list_models` through the transport; model list capped (500 ids, 256 chars, 2 MiB body).
- `legacy_model.rs` (D10): fixed `default.gguf` / `default.gguf.part`; Unix `openat(O_NOFOLLOW|O_DIRECTORY)` + `fstatat(AT_SYMLINK_NOFOLLOW)` + `unlinkat`; Windows held non-`FILE_SHARE_DELETE` ancestor handles, reparse-point rejection, handle-based delete.
- R11: `AppState::ai_providers_lock` (std mutex, no network while held); `file_storage::json_replace_preserving` (temp + fsync + rename-over, no remove-first) used only for `providers.json`; malformed provider file → `AI_PROVIDER_FILE_INVALID`, never overwritten. `secrets::keychain_get_optional` / `keychain_delete_if_present` (not-found vs other errors, macOS + keyring).
- Commands (`commands/ai.rs`, thin): `ai_provider_save`, `ai_provider_delete` (both under the lock), `ai_provider_list_models` (not license-gated, D15), `ai_provider_test_draft` (license-gated, ignores `enabled`, persists nothing), `ai_chat_complete` (gate → enabled → key), `ai_legacy_model_info/delete`. Removed `ai_provider_save_config`, `ai_provider_set_key`, `ai_provider_validate_config`, `ai_provider_test`, all `ai_runtime_*`.
- D9: deleted `ai_runtime.rs`, runtime state, startup autostart, exit shutdown hook, `supports_local_ai_runtime`; kept `ai_chat_cancel`, `runtimeConnectionId`, `engines/runtime`.

Frontend:

- `src/lib/tauri/ai.ts` / `commands.ts`: new wrappers (`aiProviderSave`, `aiProviderListModels`, `aiProviderTestDraft`, `aiLegacyModelInfo/Delete`); runtime wrappers removed.
- `src/lib/ai-assistant/index.ts` (R1): direct `fetch` paths removed (`listLocalAiModels`, `generateText` fallback, SSE reader); `generateText` requires `providerId` and throws `AI_PROVIDER_NOT_CONFIGURED` otherwise; `endpoint` plumbing removed from all prompt helpers. `assistant.ts` (model-name rewriting, legacy localStorage keys) deleted.
- `providers.ts` (R2, R5, D11, D14): kinds/model ids preserved; labels "Ollama" / "LM Studio / OpenAI-compatible"; local defaults have no placeholder model; unique ids; enabled-only selection with empty-selection clearing + event; `isLegacyBundledProvider` + notice dismissal; `saveAiProvider` (one backend call, no network validation — note: cloud Save no longer pre-validates models; use Test); `aiProviderKeyCapability`.
- Settings dialog rewritten: both local kinds, "+ Add another", Enabled toggle, key field per capability (optional key + Remove stored key + http plaintext warning), Load models with stale-draft guard, draft Test, legacy notice, legacy model Delete with confirmation; typed key cleared on close/switch.
- Panel: runtime manager/screens/bootstrap removed; enabled-only fallback clears selection when nothing is enabled; legacy notice banner with Open settings / Dismiss. Submit hook: provider-only, new setup/disabled/URL-policy error messages.
- Deleted: `useAiRuntimeManager.ts`, `AiAssistantRuntimePanes.tsx`, `useUnavailableAiRuntimeManager.test.ts`, `providerAvailability.test.ts`; `localAiRuntime` removed from distribution flags.

Config/CI/docs (D9, R8, R9): `bundle.resources` removed from `tauri.conf.json` (and the MAS override); 3 runtime scripts and `resources/ai/README.md` deleted; `.gitignore` keeps ignoring leftover local `src-tauri/resources/ai/`; `release.yml` stale `BUNDLE_AI_*`/`AI_*` echo lines removed (on top of the user's removals); `.env.example` runtime vars removed; README "Local AI Servers" section (setup, URL rules, plaintext-key warning, upgrade notes, manual cleanup, unsupported env vars) and release variables updated; FEATURE_MAP AI rows updated.

Verification:

- Rust `cargo test`: 179 passed / 1 ignored, with and without `--features app-store`. New: 9 URL-policy, 5 transport (real loopback server: redirect not followed, localhost pinning, env `HTTP_PROXY` ignored, body limit, URL-free errors), 9 provider, 12 provider-store (rollback, rollback failure, key-delete failure on kind change, keychain read error ≠ missing, per-kind key semantics), 8 chat (bearer only when present, model list parsing/caps, redirect rejection, policy rejection before any request), 6 legacy-model (full/partial/neither, repeat delete, permission denied → remaining, symlinked `ai`/`models`/target, ancestor swapped between info and delete), 2 file-storage replace tests.
- Windows `legacy_model` code type-checked with `cargo check --target x86_64-pc-windows-msvc` in an isolated crate (windows 0.58); not executed.
- `cargo clippy` both flavors: only the 5 pre-existing warnings.
- Frontend: `tsc` clean; `npm run build` and `npm run build:appstore` pass; `npm run test:run` 113 files / 624 tests (new: provider normalization/selection/legacy signature/key capability, `saveAiProvider`, rewritten panel tests incl. setup state with no request, legacy notice dismissal, settings without runtime controls).
- Repo sweep: no references to `ai_runtime`, `llama-server`, `POLITEDB_LLM_*`, `resources/ai` (except the `.gitignore` leftover rule) or `HF_TOKEN` outside `.agent/` history.

Not verified / limitations:

- No Ollama/LM Studio server was running locally; live chat/discovery smoke not performed (covered by loopback fake-server tests).
- License-gate "no network" is enforced by call order in `ai_provider_test_draft` / `ai_chat_complete` (gate before any request); no AppHandle-level test.
- Discovery cancellation is client-side only (stale responses ignored; backend request bounded by the 15 s timeout).
- Debug bundles (ad-hoc signed): direct `tauri build --debug --bundles app` and `scripts/tauri-appstore.sh build --debug` both produce `PoliteDB.app` whose `Contents/Resources` holds only `icon.icns` (no `ai/`, no `llama-server`/`libggml*`); `Cargo.toml` unchanged after the MAS build. The direct command exits 1 afterwards only because updater artifact signing needs `TAURI_SIGNING_PRIVATE_KEY` (not available locally; pre-existing). Linux/Windows packages and properly signed DMG/MAS artifacts not built here.
- `HF_TOKEN` repository secret is now unused (human may delete it).

### Phase 1c — Review round 1 fixes (Claude, 2026-10-10)

Addresses `.agent/REVIEW.md` (Codex, CHANGES REQUIRED). Uncommitted.

- P1-1: `provider_store::snapshot_for_chat` reads config + key together; `ai_chat_complete` calls it under `ai_providers_lock` and releases before network I/O. Draft discovery/test resolve keys under the same lock (`draft_key`). Barrier test `provider_store::tests::concurrency::chat_snapshot_never_sees_new_host_with_old_key` pauses Save after the config write and proves the reader waits and then sees the committed host + new key.
- P1-2: panel never switches silently when the stored selection is missing/disabled: it shows "The AI provider you used before is no longer available. Continue with X?" and blocks submit (provider id passed as empty) until Continue or an explicit model pick. A session whose stored `providerId` is unavailable gets the same guard per session; history and attribution are untouched. Tests: unavailable selection (no request, no selection write until Continue, then sends with the chosen provider) and legacy session with `providerId: "local"`.
- P2-3: draft requests take `auth` (`keep`/`set`/`remove`, same shape as `KeyChange`); `remove` sends no key for optional kinds and is `AI_PROVIDER_API_KEY_MISSING` for required kinds; nothing persisted. Rust + dialog tests.
- P2-4: URL/sub path/API key/remove-key edits, provider switch and dialog close invalidate the draft token and call new `ai_provider_cancel_list_models` (backend `select!` on a per-app discovery cancel slot; a newer discovery cancels the previous). Results merge into the current draft functionally. Dialog tests: stale list after URL edit ignored and edit kept; models typed during loading kept.
- P2-5: on `AI_PROVIDER_SAVE_ROLLBACK_FAILED` `saveAiProvider` emits `politedb-ai-providers-changed` and the dialog reloads the provider from disk (no further writes). Tests in `providerSave.test.ts` and the dialog test.
- P2-6: `provider::validate_for_save` (identity + URL, model optional) used by Save; completion still requires a model and chat rejects an empty model before any request. Save button no longer requires a model. Rust + dialog tests (offline save, disabled state persisted, no network).
- P2-7: plan R2 amended by the user (trim surrounding whitespace; otherwise exact). No code change.
- P2-8: Windows `json_replace_preserving` uses `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)`; legacy cleanup verifies the target's final path parent equals the held `models` directory; Windows-only tests added (fixed-file delete, junctioned `models` fails closed, held ancestor cannot be renamed). Type-checked with `cargo check --tests --target x86_64-pc-windows-msvc` in an isolated crate; not executed (no Windows host).

Verification (round 1): `cargo test` 184 passed / 1 ignored with and without `--features app-store`; clippy only the 5 pre-existing warnings; `tsc` clean; `npm run build` + `npm run build:appstore` pass; `npm run test:run` 114 files / 632 tests (new `AiAssistantSettingsDialog.test.tsx` 5 tests, 2 new panel tests, rollback-failure save test). Codex sandbox note: its 8 Rust failures were `TcpListener::bind` "Operation not permitted" inside its sandbox; they pass here.

Still open: live Ollama/LM Studio smoke; Windows/Linux execution; command-level license-gate no-network test (enforced by call order); backend discovery cancellation is tested through the frontend contract only.

### Phase 1c — Review round 2 fixes (Claude, 2026-10-10)

Addresses the Codex re-review in `.agent/REVIEW.md`. Uncommitted.

- P1-1: `ai_provider_list` now takes `ai_providers_lock`. Barrier test `list_never_sees_config_of_a_save_that_rolls_back` pauses a Save after its config write, fails the key write, and proves List waits and then sees the restored config.
- P2-4 (removal): models removed during a discovery are excluded from its result (`removedDuringDiscoveryRef`). Dialog test.
- P2-4 (ownership): new `ai::cancel::CancelRegistry` keyed by caller request id (`settings-<instance>:<token>`); registration happens first in the command (before the provider lock), early cancels are remembered (bounded) and fire on registration, finished ids are forgotten. `ai_provider_list_models` takes `request_id`; `ai_provider_cancel_list_models(request_id)` cancels only that request. Rust tests: named-request isolation, cancel before registration, finish cleanup, in-flight cancel; dialog test asserts cancels use only its own id.
- P2-9: pending fallback carries the replacement's model; Continue sets provider, model and label together. Panel test with reloads left pending proves the first request uses the replacement's model.
- P2-10: an explicit model pick also accepts the active session's replacement (attribution untouched). Panel test: legacy session → pick model → submit without Continue.
- P2-8: Windows fixtures added — swap attempts on `ai`/`models` during traversal/open/delete fail and an unrelated file survives; failed `MoveFileExW` replacement (read-only destination) keeps the old bytes and cleans the temp file. Type-checked for `x86_64-pc-windows-msvc` (legacy cleanup in an isolated crate); not executed.

Verification (round 2): `cargo test` 189 passed / 1 ignored with and without `--features app-store`; clippy only the 5 pre-existing warnings; `tsc` clean; `npm run build` + `npm run build:appstore` pass; `npm run test:run` 114 files / 635 tests.

### Phase 1c — Review round 3 fixes (Claude, 2026-10-10)

- P1-11: Settings delete no longer writes or broadcasts a replacement selection; the stored selection keeps pointing at the deleted id so open panels show the "no longer available — Continue with X?" guard. Panel test (selected local provider deleted, cloud remains → banner, no request, no auto-selection) and dialog test (delete leaves selection key and emits no selection event).
- P2-10: choosing Auto accepts the active session's replacement like a manual model pick (attribution untouched). Panel test: legacy session → Auto → submit.
- Note: Saving a provider with "Default provider" checked still selects it for chat; that is an explicit user choice of that provider in Settings.

Verification (round 3): `tsc` clean; `npm run build` + `npm run build:appstore` pass; `npm run test:run` 114 files / 638 tests; Rust unchanged since round 2 (189 passed both flavors).

- Codex Re-review 3 (2026-10-10): VERIFIED WITH LIMITATIONS. Claude `/security-review` (2026-10-10) on the full uncommitted diff: no findings at confidence >= 8 (URL policy, transport, key handling, save transaction, license gate, legacy cleanup, deserialization, webview exposure). Optional follow-up: drop `http://127.0.0.1:*` / `http://localhost:*` from CSP `connect-src` now that the webview no longer calls AI endpoints.

### Phase 1c — Scope change: OpenAI-compatible kind removed (user, 2026-10-11)

- User decision ("bỏ hẳn loại provider"): remove the "LM Studio / OpenAI-compatible" (`local_openai_compatible`) provider kind. Ollama is the only local kind. Supersedes D13 (optional key for local servers) and the second half of D14.
- Back-compat: Rust `AiProviderKind::Ollama` carries `#[serde(alias = "local_openai_compatible")]`, so existing `providers.json` files still load; such records become Ollama (URL kept, keyless). A previously stored key is ignored and deleted on the next save of that provider (Ollama key rule). `KeyCapability::Optional` removed; draft `remove` auth now always means "no key" → required kinds error.
- Frontend: kind removed from `AiProviderKind`, labels/defaults/suggestions and Settings; optional-key UI ("Remove stored key", http plaintext warning) removed; copy mentions Ollama only. README updated.
- Verification: Rust alias test (`reads_removed_openai_compatible_kind_as_ollama`), provider-store tests moved to cloud (keyed) / Ollama (keyless) fixtures; frontend fixtures switched to Ollama.

### Phase 2 — Implementation evidence (Claude, 2026-10-11)

Branch `feat/mas-native-apis`. Both flavors; no subprocess left on macOS for these paths.

- New `src-tauri/src/platform/{mod.rs,macos.rs}` (objc2 / IOKit / libc):
  - `os_version` (NSProcessInfo) replaces `sw_vers`; `show_critical_alert` (NSAlert, main thread only) replaces `osascript`.
  - `open_url` (NSURL + NSWorkspace) replaces `open` in `license_open_external_url`; the `distribution::allows_external_url` gate is unchanged.
  - `platform_uuid` (IOKit `IOPlatformUUID`) replaces `ioreg`; `host_name` (`gethostname`) replaces `hostname`. Device ids for existing license activations are unchanged (test compares with `ioreg`).
  - `authenticate_device_owner` (LAContext `DeviceOwnerAuthentication`, oneshot reply, 30 s timeout → `invalidate`) replaces the `/usr/bin/swift` script. Error shape `TOUCH_ID_AUTH_FAILED: <reason>` and non-macOS `TOUCH_ID_UNSUPPORTED_PLATFORM` kept.
- `main.rs`: `parse_macos_version`/osascript removed; `is_supported_macos_version`, `format_macos_version`, `enforce_minimum_macos_version` (min 13.3) use the platform module.
- `license.rs`, `commands/license.rs`: `Command` use gated to non-macOS (Windows/Linux paths unchanged).
- Deps (macOS target only): `objc2-app-kit`, `objc2-local-authentication`, `block2`.
- Verification: `cargo test` 195 passed / 1 ignored in default and `--features app-store` (new: `platform_uuid_matches_ioreg`, `host_name_matches_hostname_tool`, `reports_a_plausible_os_version`, `macos_version_tests::*`); clippy shows only the 5 pre-existing warnings; `cargo fmt` clean.
- Not exercised: real Touch ID/password prompt (needs interactive run), the NSAlert path (needs macOS < 13.3), `open_url` at runtime, Windows/Linux builds.

### Phase 2 — Review round 1 fixes (Claude, 2026-10-11)

- P1-1: `use std::sync::Arc` in `main.rs` is unconditional again (the macOS-only `#[cfg]` had belonged to the removed `StdCommand` import).
- P2-2: `commands/security.rs::prompt_for` trims the reason and falls back to the default prompt for `None`/empty/whitespace; `platform::macos::authenticate_device_owner` additionally rejects a blank reason with `TOUCH_ID_AUTH_FAILED: Authentication failed.` before touching LAContext (defense in depth, never `Ok(true)`).
- `AuthContext` safety comment narrowed to what the code does (invalidate/release only, possibly on another worker; the framework already uses the context from its private reply queue).
- Tests: `blank_reasons_use_the_default_prompt`, `blank_reason_is_rejected_before_the_native_call`. `cargo test` 197 passed / 1 ignored in both flavors; clippy only pre-existing warnings.
- Cross-target `cargo check` not possible on this Mac: Linux stops at pkg-config (no sysroot), Windows at `ring` C build (`assert.h`, no MSVC SDK). Manual audit of non-macOS cfg paths: `Arc` unconditional; `Command`/`StdCommand`/`command_output` gated `not(macos)` and used only by Windows/Linux `open`, `reg`, `hostname` paths; non-macOS `enforce_minimum_macos_version` stub unchanged. Real coverage relies on CI Windows/Linux jobs.

### D16 — AI features are free (user, 2026-10-11)

- User decision ("tính năng AI là free, không cần politedb license"): AI no longer requires a PoliteDB license in either flavor. Supersedes the AI license gate in R3/D15 and P1-2's `blocks_ai_feature_for` (App Store "active only" for AI). Phase 4 (IAP): AI is not part of the paid entitlement.
- Backend: `commands/ai.rs` `ensure_ai_licensed` removed from `ai_provider_test_draft` and `ai_chat_complete`; `license::blocks_ai_feature{,_for}` and their tests removed (no other callers). The `AI_LICENSE_REQUIRED` error no longer exists.
- Frontend: `useAiAssistantSubmit` no longer maps `AI_LICENSE_REQUIRED`. The short-lived "Activate license" notice in AI settings was reverted before commit.
- Unchanged: trial/licence state, `apply_trial_policy`, the app-wide trial-expired overlay, keychain/URL policy, `enabled`/key checks before any request.
- Verification: `cargo test` 195 passed / 1 ignored in default and `--features app-store`, clippy only pre-existing warnings; `npm run test:run` 642 passed; `npm run build` OK.

## Phase 3 — Sandboxed file access (APPROVED 2026-10-11)

### Repo facts (inspection 2026-10-11)

- Expected to work in the sandbox (same-session picker access; to be confirmed in the signed-sandbox harness) (picked and used in the same session through `src/lib/system-dialog` + `src/lib/system-fs`): CSV import, dump restore/backup, BLOB-from-file, SQL/plan/PNG export, `.politedbconnection` export/import, external profile import (Rust reads the path right after the pick).
- Broken in the sandbox:
  1. SQLite/DuckDB path is a typed `<Input>` (`ConnectionBasicsSection.tsx:473`), opened later by `rusqlite::Connection::open` (`engines/sqlite/driver.rs:84,111`) and `duckdb::Connection::open` (`engines/duckdb/driver.rs:68`). No access without a pick; no access after relaunch without a bookmark.
  2. SQLite (`-journal`, `-wal`, `-shm`) and DuckDB (`.wal`) write sibling files; a file-only grant does not cover them.
  3. SSH key: picked (`SshSection.tsx:92`), read by libssh2 at every auth (`ssh_tunnel/open.rs:225`); lost after relaunch.
  4. Table/result export writes a sibling temp `<name>.<token>.politedb-export.tmp` and renames it (`file_storage.rs:264,289`); a save-panel grant covers only the chosen file.
  5. Imported profiles (DBeaver/TablePlus/`.politedbconnection`) carry SSH key / DB paths without any grant.
- Not in scope: SSL key/cert/CA paths are stored but never opened by any engine. `known_hosts` (`~/.politedb`) resolves inside the container home under the sandbox; works, separate from the DMG file.

### Decisions (user, 2026-10-11)

- D17 SQLite/DuckDB sibling files: after picking the DB file, MAS asks for the containing folder (open panel preset to the parent, explanation first); the folder bookmark is what the engine uses.
- D18 Path input: DMG keeps the typed input and adds Browse; MAS is Browse-only with the path shown read-only.
- D19 Imported / ungranted paths: keep the path; connecting without a grant fails with `FILE_ACCESS_REQUIRED` and the UI offers "Choose file…" (preset to that path), stores the grant, then retries.

### Design (revision 2 — addresses Plan Review Phase 3 blockers 1–5 and should-fix 6–10)

**Grant store** (`<app_data>/file_access/grants.json`, Rust-only):
- Schema `{ "version": 1, "grants": [{ "role": "database_folder" | "ssh_key", "path": "<absolute, canonical>", "bookmark": "<base64>" }] }`. Keyed by `(role, path)`; shared by every profile using that file/folder. Not part of profiles, so profile export/import never carries bookmarks (R7); imports never create grants.
- One `Mutex` in `AppState` covers read → modify → refresh → save. Writes use the existing failure-preserving `replace_file` path (not `atomic_write_bytes`), mode 0600. Size cap 1 MiB / 512 entries.
- Malformed file or entry: the file is moved aside as `grants.json.corrupt-<ts>`, the store starts empty and the log gets the code `FILE_ACCESS_STORE_CORRUPT` only. Base64/bookmark errors drop that entry only. I/O errors propagate as `FILE_ACCESS_STORE_IO` (never silently "no grant").
- DB-folder grants are the only DB grant (no redundant file bookmark, R12).

**Native port (B1)** `file_access/port.rs`:
- `create(url_from_panel, mode) -> Bookmark` with `mode` ReadWrite (DB folder) or ReadOnly (SSH key, `securityScopeAllowOnlyReadAccess`).
- `resolve(bookmark) -> ResolvedResource { url: Retained<NSURL> (opaque), path, stale }`.
- `start(resolved) -> Lease`. `Lease` owns the same retained NSURL, calls `startAccessingSecurityScopedResource` and must see `true` (else `FILE_ACCESS_DENIED`), then calls the matching `stop` exactly once on Drop.
- `Lease` is `Send + Sync` via a wrapper; NSURL is immutable and documented thread-safe.
- Stale: re-create the bookmark from the resolved URL while the lease is active and save it. If saving fails, keep the old entry and continue.
- Resolved path ≠ stored path (moved/renamed/replaced): treated as missing → `FILE_ACCESS_REQUIRED`. Never silently open another location.

**Backend-owned pickers (B2)** `commands/file_access.rs`. These are the only way to create grants; there is no `grant(path)` command.
- Pickers run with `tauri_plugin_dialog` blocking pickers inside `spawn_blocking`, so the URL comes straight from the panel and Rust bookmarks it immediately.
- `file_access_pick_database(kind, mode: "open" | "create", expected_path?)`:
  1. Open the file panel (`open`) or the save panel (`create`, which lets MAS create a new DB).
  2. Show the folder panel preset to that file's exact parent. Its title/message explains: "Allow PoliteDB to read and write files in <folder> (needed for database journal files)".
  3. Rust checks that the chosen folder canonicalizes to exactly the file's parent (D17 exact parent, no ancestors). It rejects `/`, a volume root, and the home folder root, with code `FILE_ACCESS_FOLDER_TOO_BROAD` and a message telling the user to move the DB into a folder.
  4. Bookmark the folder and return `{ path }`.
  - Cancel in either panel returns `null` and changes nothing.
  - With `expected_path` (recovery), a different file is rejected with `FILE_ACCESS_WRONG_FILE`. Choosing another file is done by editing the connection.
- `file_access_pick_ssh_key(expected_path?)`: file panel, read-only bookmark, same `expected_path` rule.
- Direct (DMG) flavor: same commands and same pickers; no folder panel, no bookmarks. One UI flow for both flavors.
- `file_access_missing(requests: [{ role, path }])` checks stored entries only. It never resolves bookmarks and never opens panels.

**Errors without paths (B4)**:
- `FILE_ACCESS_REQUIRED:{"role":"database_folder|ssh_key"}`, plus `FILE_ACCESS_DENIED`, `FILE_ACCESS_WRONG_FILE`, `FILE_ACCESS_FOLDER_TOO_BROAD` and `FILE_ACCESS_STORE_*`.
- Error payloads never include paths or NSError text. The frontend knows the path from the profile/draft.
- `lifecycle.rs` connect/test/SSH error paths propagate the code unwrapped; their logs use a `log_safe` helper that reduces any `FILE_ACCESS_*` error to its code.
- Captured-log test with a sentinel path.

**Lifetimes (B5)**:
- SQLite/DuckDB connections become `Arc<DbHandle { conn: Mutex<Connection>, _lease: Option<Lease> }>`. Fields drop in order, so the DB closes (checkpoint/WAL cleanup) before the scope stops.
- Every clone (queries, exports, `spawn_blocking` tasks) shares that Arc, so access lasts until the last user drops it.
- The lease is acquired inside the blocking open and moved into the handle. Test connections use the same handle and release when they drop. `:memory:` takes no lease.
- SSH: the lease is acquired inside `connect_ssh_session_blocking`, kept for the whole `userauth_pubkey_file` call, and covers every fresh auth/reconnect. Pool reuse needs no new lease.

**Export (B3)** — atomicity kept:
- App Store builds stage the temp in `NSFileManager URLForDirectory:NSItemReplacementDirectory appropriateForURL:<destination>`, then publish with `replaceItemAtURL:withItemAtURL:`.
- This is Apple's sandbox-compatible safe-save. It is the same volume and atomic, and preserves the destination on failure.
- Direct builds keep the sibling temp + `replace_file`. Abort deletes only the session temp.
- If the signed-sandbox harness shows the replacement directory is not writable, implementation stops and asks the user (fallback options: destination-folder consent, or non-atomic write). No silent downgrade.

**Frontend (R8)**:
- `src/lib/tauri/fileAccess.ts` holds the typed wrappers. `src/lib/file-access/recovery.ts` decodes `FILE_ACCESS_*`, coalesces concurrent requests into one prompt per `(role, path)`, and retries the original action once after all missing grants are recovered. Cancel or a wrong file aborts without changing the profile.
- `ConnectionBasicsSection`:
  - DMG: typed input + Browse/New.
  - MAS: read-only path + Browse/New + an "In-memory" choice for `:memory:`.
- SSH key picker goes through `file_access_pick_ssh_key`.
- Covered entry points: form Test, Connect, unsaved runtime connection, `useEnsureRuntimeConnection` auto-restore, SSH auth.
- Auto-restore never opens panels by itself. It shows a "Grant access" action on the tab/card.

**Out of scope, documented**:
- `ATTACH`, DuckDB `COPY`/external file scans and custom spill paths outside the granted folder fail with the engine's own error in MAS.
- No grant-management UI in v1 (R11 deferred).
- SSL path fields (never opened).
- `known_hosts` lives in the container home in MAS (separate from DMG).
- Bookmarks are never used for plugin-fs; the frontend keeps only same-session picker access.

### Verification (revision 2)

- **Rust fake-port tests:**
  - grant/missing/acquire in App Store vs Direct;
  - `start=false`, stale refresh (save failure keeps old), moved/missing/corrupt bookmark, corrupt store moved aside, I/O error propagates;
  - concurrent acquire, balanced start/stop, close-before-stop ordering;
  - exact-parent and too-broad folder rules, wrong-file rejection;
  - error payload has no path; captured-log sentinel;
  - export replace path selection and abort.
- **macOS unsandboxed integration:** real bookmark create/resolve/start/stop for a temp file and folder (mechanics only, not rights).
- **Signed sandbox harness (required before marking Phase 3 VERIFIED; does not need App Store upload assets):**
  - Build: `scripts/tauri-appstore.sh build` (Rust `--features app-store` + Vite `--mode appstore`), ad-hoc codesign with a harness entitlements file (sandbox + files.user-selected + bookmarks.app-scope + network; no team/keychain-group keys), then check with `codesign -d --entitlements`.
  - Access rules: an unpicked file is denied; a picked file does not cover its siblings; the picked parent does; cancel or an unrelated folder fails.
  - SQLite rollback + WAL writes, relaunch, reconnect without prompts.
  - DuckDB WAL + forced spill + checkpoint.
  - Encrypted SSH key auth across relaunch.
  - CSV export to a new and to an existing destination, including failure.
  - Imported profile prompts once.
- **Frontend Vitest:** per-flavor input vs Browse; recovery coalescing and single retry; cancel/wrong file keep the profile; auto-restore shows an action without panels; `:memory:` in MAS.
- **Commands:** `cargo test` and `cargo test --features app-store`, clippy both, `npm run build`, `npm run build -- --mode appstore`, `npm run test:run`.
- **Security:** Claude `/security-review` after Codex.

### Design revision 3 (Claude, 2026-10-11) — addresses Plan re-check items 1–5

Supersedes the matching parts of revision 2. Everything else in revision 2 stands.

1. **Native picker adapter (replaces the plugin-dialog pickers for grants).**
   - `file_access/macos_panel.rs` builds `NSOpenPanel` / `NSSavePanel` with objc2-app-kit (features `NSOpenPanel`, `NSSavePanel`, `NSPanel`, `NSWindow`), runs them modally on the main thread (`app.run_on_main_thread` + oneshot; the command awaits it), and keeps the panel's retained `NSURL`.
   - The bookmark is created from that same `NSURL` before it is released; the path is only derived afterwards. No path → NSURL reconstruction.
   - Direct flavor and non-macOS: unchanged plugin-dialog pickers, no bookmarks.
   - The SSH key and DB pickers in the frontend call these commands in both flavors; other pickers (CSV, dump, export, BLOB, `.politedbconnection`) stay on plugin-dialog.

2. **Selection identity, validation and races (fail closed).**
   - Validation happens in Rust on the panel URL's path immediately after selection:
     - The path must be absolute, with no `..`.
     - Open: the selected item must be a regular file. `symlink_metadata` must not show a symlink, so aliases and symlinks are rejected with `FILE_ACCESS_UNSUPPORTED_ITEM`. The canonical path is what gets stored.
     - Create (save panel): the parent must exist and be a directory, and the leaf must be a plain name that is not an existing directory. The canonical path is `canonical(parent)/leaf`; the target does not need to exist.
     - The folder panel result must canonicalize to exactly that parent, and must not be `/`, a volume root or `$HOME`.
   - `expected_path` comparison: canonicalize the expected parent, append its leaf, then compare byte-for-byte with the selection. On case-insensitive volumes the comparison follows the canonical path returned by the filesystem.
   - Swap races:
     - Before bookmarking, the type is re-checked through the panel URL. A mismatch aborts with nothing stored.
     - At connect time the engine opens `<granted folder>/<leaf>` inside the folder lease. Replacing the DB file inside a granted folder is within the user's folder consent (accepted and documented). The folder itself being moved or replaced is detected by the resolved-path check (→ `FILE_ACCESS_REQUIRED`).
   - A missing target or unmounted volume (bookmark resolve fails with not-found / volume unavailable) → `FILE_ACCESS_UNAVAILABLE`. The UI says the file or drive is unavailable and does not open a picker.
   - Acquisition-time stale/denied failures map to `FILE_ACCESS_REQUIRED` and use the same recovery flow.

3. **Export publication (App Store).**
   - The session creates `NSItemReplacementDirectory appropriateForURL:<destination>` (same volume) and writes the staging file there.
   - Publish:
     1. `fsync` and close the staging file.
     2. If the destination exists, call `replaceItemAtURL:withItemAtURL:backupItemName:nil options:0` (original metadata kept). Otherwise call `moveItemAtURL:toURL:`.
     3. Remove the replacement directory.
   - Before publication succeeds the destination is untouched. On failure the staging file and directory are removed and the error is returned (`EXPORT_PUBLISH_FAILED`, no path).
   - The session owns its staging URL. Abort and cancel remove only it.
   - Crash residue lives in the system temporary-items area (OS-cleaned). On startup, stale `*.politedb-export.tmp` items in the app's own temp dir are also removed.
   - **Stop-and-escalate:** if the signed harness shows any authorization or preservation failure (replacement dir unwritable, replace/move denied, original not preserved), implementation stops and asks the user. There is no fallback in code.
   - Tests through an injected publication port: short write, disk full (ENOSPC), permission denied before publication, failure during replace, cancel, a new vs an existing destination, and that the original bytes are kept on every pre-publication failure.

4. **Privacy and plugin exposure.**
   - New and changed connect/test/SSH log statements use `log_safe(err, &[db_path, key_path])`. It reduces `FILE_ACCESS_*` errors to their code and redacts known path strings (and their canonical forms) from engine/native errors as `<path>`.
   - NSError text never enters `FILE_ACCESS_*` payloads.
   - Frontend: the file-access recovery code never calls `trackEvent` / `trackEssentialEvent` with a path or error text (only `{ role, outcome }`); a test asserts this.
   - Debug info (`DiagnosticsSettings.copyDebugInfo`) contains no paths or grants. No other diagnostics or support archive exists today; `grants.json` is excluded from any future one (noted in the module docs).
   - Tests: plaintext and encrypted single/all profile exports and external imports, run with a populated grant store, contain no bookmark bytes or grant fields and create no grants.
   - **MAS capability decision:** remove the static `fs:allow-read` / `fs:allow-app-read` `$HOME`/`$DESKTOP`/`$DOCUMENT`/`$DOWNLOAD` scopes from `capabilities/appstore.json`. Frontend reads in MAS rely only on plugin-dialog's runtime `allow_file` for the picked item. `default.json` (DMG) is unchanged.
   - Harness check: a picked CSV is still readable from the webview, and while a DB-folder lease is active a sibling file in that folder is NOT readable through plugin-fs.

5. **Additional discriminating tests.**
   - Rust (fake ports): two connections sharing one folder grant (single start/stop pair per lease, last drop stops), disconnect while a query/export blocking task holds the handle (stop only after the task ends), open/auth early failure releases the lease, dropped-await of connect releases the lease, malicious IPC (relative path, `..`, symlink, directory as file, wrong role, unsolicited `expected_path`).
   - Signed harness:
     - Run 1 picks and persists; quit; run 2 resolves and uses.
     - SQLite crash recovery: kill during a write transaction, relaunch, journal rollback.
     - Denial controls use files in `~/Documents/politedb-harness/` (outside the container, not public).
     - Paths with non-ASCII characters and spaces; a symlinked DB (expect rejection); a removable or disk-image volume (unmount → `FILE_ACCESS_UNAVAILABLE`).
   - Record OS version and evidence separately for each case.

### Phase 3 — Implementation evidence (Claude, 2026-10-11)

Branch `feat/mas-file-access`.

**Backend `src-tauri/src/file_access/`:**

- `error.rs`: path-free codes. `FILE_ACCESS_REQUIRED` / `FILE_ACCESS_UNAVAILABLE` carry `{"role"}` only.
- `port.rs`: `BookmarkPort`, plus `ScopedResource`, which owns the URL that resolution returned.
- `lease.rs`:
  - `Lease` stops access exactly once on drop.
  - `Leased<T>` drops the inner value before its lease.
- `store.rs`: `grants.json`.
  - Schema version 1, 1 MiB / 512-entry caps.
  - Corrupt or other-version files are moved aside; I/O errors propagate.
  - Written 0600 via the new `file_storage::json_replace_preserving_private`.
- `service.rs` (`FileAccess`):
  - One lock covers load → resolve → refresh → save.
  - A moved item resolves elsewhere → `REQUIRED`.
  - `start=false` → `REQUIRED`.
  - Stale bookmarks are refreshed while the lease is active; a failed save keeps the old bookmark.
  - `missing` checks the store only.
  - Disabled in direct builds.
- `validate.rs`:
  - Rejects relative paths, `..`, symlinks and Finder aliases (magic bytes).
  - New-file targets need an existing parent.
  - The DB folder must be exactly the DB's parent, and not `/`, `/Volumes/<x>` or the real home folder (`getpwuid`, because the sandbox `$HOME` is the container).
  - `is_expected` compares paths lexically and canonically.
- `pick.rs`: backend-owned flows, and the only way grants are created.
  - Database open/create: file panel, then (sandbox) a folder panel preset to the parent with an explanation.
  - Recovery with `expected_path`: folder panel only, and the path is kept.
  - SSH key: read-only bookmark; a different file is `WRONG_FILE`.
- `macos.rs`:
  - `NSOpenPanel` / `NSSavePanel` run on the main thread via `run_on_main_thread`.
  - Validation runs before the bookmark is created from the panel's own NSURL.
  - Resolution uses `WithSecurityScope | WithoutUI`.
- `safe_save.rs`:
  - Direct builds keep the existing sibling temp + rename.
  - App Store builds stage in `NSItemReplacementDirectory` (same volume), then `replaceItemAtURL` for an existing destination or `moveItemAtURL` for a new one, then remove the staging dir.
  - `redact.rs`: `log_safe`.
- `commands/file_access.rs`: `file_access_pick_database(mode, expected_path)`, `file_access_pick_ssh_key(expected_path)`, `file_access_missing(requests)`.
  - There is no command that grants an arbitrary path.
  - Non-macOS uses plugin-dialog panels without bookmarks.
- **Engines:**
  - SQLite/DuckDB `conn` is now `Arc<Leased<Mutex<Connection>>>`, so the connection closes before access stops, and every clone or background task keeps the lease.
  - The lease is acquired inside the blocking open; test opens drop the connection before the lease.
  - SSH: the lease is held across `userauth_pubkey_file` (the only auth path).
- **Logging:**
  - `lifecycle.rs` and `profile/connect.rs` connect/test/SSH error logs go through `log_safe`, which redacts the DB and key paths and keeps only the `FILE_ACCESS_*` code.
  - `ssh_open_error` returns `FILE_ACCESS_*` unwrapped.
  - Pre-existing and unchanged: `useEnsureRuntimeConnection` / `ConnectionFormDialog` send `error.slice(0,240)` to analytics. `FILE_ACCESS_*` codes contain no paths, but engine errors could; flagged for a follow-up, out of Phase 3 scope.
- **Export:** `commands/export.rs` sessions hold a `Staged` from `safe_save::for_distribution()`.
- **Capabilities:** `capabilities/appstore.json` replaces the `$HOME` / `$DESKTOP` / `$DOCUMENT` / `$DOWNLOAD` read scopes with scope-free `fs:allow-read-file` / `fs:allow-read-text-file`, so reads work only for picked files. `default.json` is unchanged.
- **Cargo:** objc2-app-kit features `NSOpenPanel`, `NSSavePanel`, `NSPanel`, `NSWindow`, `NSView`.

**Frontend:**

- `src/lib/tauri/fileAccess.ts` holds the wrappers.
- `src/lib/file-access`:
  - `parseFileAccessError` (code anywhere in the message) and `describeFileAccessError`.
  - `fileAccessRequests(input)`.
  - `ensureFileAccess`: one confirm, then each missing picker, coalesced per (role, path).
  - `withFileAccessRecovery`: retry once, only for repeatable operations.
  - Analytics get `{ role, outcome }` only.
- `DISTRIBUTION_FEATURES.fileGrants` is set for the App Store build.
- `DatabasePathField`:
  - DMG: typed input + Browse… / New….
  - MAS: read-only picker + Browse… / New… / In-memory.
- SSH key picker → `file_access_pick_ssh_key`.
- Wiring:
  - Form Test and `MenuBar` open-database use `withFileAccessRecovery`.
  - Form Connect (save-and-connect is not repeatable) runs `ensureFileAccess` first.
  - Auto-restore never opens panels by itself: a `FILE_ACCESS_REQUIRED` runtime error becomes a confirm prompt, then the connection reloads.
  - Error texts go through `describeFileAccessError`.

**Verification:**

- `cargo test`: 239 passed / 1 ignored in default and `--features app-store`. This includes 50+ new tests:
  - store, service, validate and pick with fake ports and panels;
  - native bookmark round-trip (mechanics only);
  - lease drop order and shared clones;
  - safe-save for new and existing destinations, discard, and a failed publish keeping the original (both stagers);
  - `log_safe` sentinel;
  - SSH code unwrapping;
  - profiles never carrying grants.
- Clippy: only the 5 pre-existing warnings in both flavors (MSRV fix: no `inspect_err`). `cargo fmt` is clean.
- `npm run test:run`: 657 passed (new: 12 recovery tests, 3 `DatabasePathField` tests). `npm run build` and `vite build --mode appstore` OK.
- **Sandbox harness (partial):**
  - `scripts/tauri-appstore.sh build --debug --bundles app` with a scratch config (`bundle.macOS.files: null`, no provisioning profile).
  - Ad-hoc codesign with harness entitlements (sandbox, user-selected rw, bookmarks.app-scope, network, jit); `codesign -d --entitlements` confirmed them.
  - The app launched sandboxed and created `~/Library/Containers/PoliteDB`.
- **Not yet run (needs a human at the panels):** the interactive matrix in revision 2/3:
  - pick DB → folder; WAL write; relaunch with no prompt;
  - SSH key across relaunch;
  - CSV export to a new and an existing file;
  - an unpicked file is denied;
  - a sibling file is not readable via plugin-fs;
  - imported-profile prompt;
  - unmounted volume.
  Phase 3 stays unverified until this matrix is recorded.

### Phase 3 — Review round 1 fixes (Claude, 2026-10-11)

- **P1-1 export staging:**
  - `ReplacementDirectory::stage` passes the destination's existing parent folder as `appropriateForURL`. Only its volume matters, and a not-yet-existing destination is no longer created.
  - Tests assert a new destination stays absent through stage and discard (both stagers), and an existing one keeps its bytes.
- **P1-2 cancellation:**
  - `withFileAccessRecovery` throws `FileAccessCancelled` before `run` when the user declines or cancels (up front or during re-grant).
  - The form's Test/Connect catch it and return to idle without error, analytics or save.
  - Form-level tests (`ConnectionFormDialog.fileAccess.test.tsx`): declining and cancelling the folder panel make no `profileSaveAndConnect`, `connectionTest` or `profileConnectTest` calls.
  - `vite.config.ts`: `test.server.deps.inline: ["react-hook-form"]`, so form components render in Vitest.
- **P1-3 unusable grants / duplicates:**
  - `FileAccess::missing` resolves and briefly starts each grant (no panels). Stale, moved, corrupt, denied or replaced grants count as missing; a gone file or volume → `FILE_ACCESS_UNAVAILABLE`.
  - `profile_save_and_connect` calls `commands::file_access::ensure_usable(&input)` after validation and before secrets or the profile are persisted.
  - The form retries save-and-connect only for that bare pre-persistence code (`failedBeforePersistence`). A prefixed `RUNTIME_CONNECT_FAILED: FILE_ACCESS_*` (after saving) is shown, never replayed; a test asserts a single save call.
- **P1-4 privacy:**
  - `TunnelKey`'s `Debug` prints an opaque hash, so the `ssh_key=?key` logs in `pool.rs`/`lifecycle.rs` no longer contain the key path. Equality and hashing are unchanged (test).
  - Connection analytics (form Test/Save/Connect, auto-restore and manual reload, template/duplicate in MainScreen) send `errorCode(msg)`, the leading UPPER_SNAKE code or `OTHER`, instead of `msg.slice(0,240)`.
  - `query.ts` analytics are untouched: they are not on the file-access path; noted for follow-up.
- **P2-5 auto-restore:**
  - `ConnectionScreen` no longer prompts from an effect. `FILE_ACCESS_REQUIRED` renders `FileAccessBanner` with a "Grant Access…" button; only that click opens panels (`confirm: false`), then the connection reloads.
  - `ensureFileAccess` coalesces the whole confirm + picker transaction per request set (test: one confirm for concurrent callers).
- **P2-6 validation:**
  - `existing_file`, `new_file` and `database_folder` reject symlinked path components (canonical must equal the given path).
  - `new_file` rejects an existing alias or symlink target, and any metadata error other than NotFound.
  - DB recovery validates the saved file (missing → `UNAVAILABLE`).
  - After bookmarking, the native adapter re-validates and resolves the new bookmark; it must match, or nothing is stored.
  - Grants store `file_id` (`dev:inode`); at acquire, a different item at the same path → `REQUIRED` (test: a replaced folder is not trusted).
- **P2-7 direct SSH/DB pickers:**
  - Native panels and strict validation apply only when `requires_file_grants()`.
  - Direct builds on every platform use the plugin-dialog `DialogPanels` with `validate::lenient` (any absolute path as returned, including symlinks).
- **Verification:**
  - `cargo test` 246 passed / 1 ignored in both flavors.
  - Clippy: only the 5 pre-existing warnings in both flavors.
  - `npm run test:run` 669 passed; both frontend builds OK.
- **Still pending:** the interactive signed-sandbox matrix, including export to new and existing destinations.

### Phase 3 — Review round 2 fixes (Claude, 2026-10-11)

- **P1-3 (lease handoff + saved identity):**
  - `commands::file_access::ensure_usable` now returns the acquired leases. `profile_save_and_connect` holds them (`_file_leases`) from the pre-persistence check through the runtime connect, so access cannot lapse between check and use.
  - Frontend: create-mode save-and-connect passes a per-dialog fixed `profileId` (`SaveAndConnectAction` create accepts an optional `profileId`; `buildSavePlan` uses it, else a new UUID).
  - After a `RUNTIME_CONNECT_FAILED` (profile already saved), later Connect clicks run in update mode for that same id: no duplicate for any late connect failure, file-access or not.
  - Tests:
    - the form issues create then update with the same id;
    - `profile.saveId.test.ts`: a supplied id is used, otherwise a UUID is generated.
- **P1-4 (logs):**
  - `file_access::log_safe(error)` now keeps only the leading UPPER_SNAKE code, else `OTHER`. Engine/native text is never logged on these paths; the full message still goes to the user over IPC.
  - The path-replacement approach and the `file_paths` helpers were removed.
  - Test with literal, URL-encoded and code-less sentinels.
- **P2-5 (stale banner completions):**
  - `FileAccessBanner` takes `scope` (`tabId:profileId`) and ignores a completed grant if it unmounted or its scope changed. `onGranted` is captured at click time.
  - Test: rerender with another scope, then unmount, while the picker is pending → no reconnect.
- **P2-6 (recovery validation):**
  - DB recovery validates the saved spelling itself (`normalize_absolute` → `existing_file`, no canonicalize first), so a symlinked folder in it is rejected before any panel opens.
  - The DB file is re-validated after the folder panel closes, before the grant is stored (`grant_folder(..., recheck)`).
  - Tests: symlinked saved path → `UNSUPPORTED_ITEM` with no panel and no grant; file swapped for a folder during the panel → error with no grant.
- **Verification:**
  - `cargo test` 248 passed / 1 ignored in both flavors; clippy only pre-existing warnings.
  - Vitest: all files pass. Both frontend builds pass.

### Phase 3 — Review round 3 fixes (Claude, 2026-10-11)

- **P1-3 (Save after a late connect failure):**
  - Save uses the same single identity as Connect: `profileId ?? savedNewProfileId`, and otherwise creates with the dialog's fixed `newProfileId`. A successful Save of a new profile also records its id, so every later action in the dialog updates it.
  - Test: late Connect failure → Save → `update` with the first id.
- **P2-5 (reload completion scoping):**
  - `useEnsureRuntimeConnection` keeps a generation counter, bumped when the shown tab/profile changes and on unmount.
  - In `reload`, screen state (`setError`, `setConnecting`) is applied only if the generation is unchanged. Tab-specific results (`updateTab`, session open/failed records, analytics) are applied only if the originating tab still exists.
  - Tests (`useEnsureRuntimeConnection.scope.test.tsx`):
    - A's late failure after switching to B keeps B's error; A's own failure is still recorded.
    - A's late success after A was closed updates nothing.
- **Verification:**
  - Vitest: all files pass. Both frontend builds pass.
  - Rust unchanged since round 2: 248 passed / 1 ignored in both flavors.

## Plan Review — Phase 3 (Codex)

Reviewed 2026-10-11 against `AGENTS.md`, `.agent/WORKFLOW.md`, current repository source, locked plugin source and official documentation. This is a plan critique, not implementation verification; Phase 3 remains DRAFT.

### Repo facts and Apple assumptions

- **Confirmed:** database paths are typed today; SQLite connect/test open at `engines/sqlite/driver.rs:84,111`, DuckDB uses `open_duckdb` at `engines/duckdb/driver.rs:68–72`. Both connection types share `Arc<Mutex<Connection>>` and are cloneable. SSH passes the private-key path to `userauth_pubkey_file(user, None, ...)` at `ssh_tunnel/open.rs:230`; Cargo enables vendored OpenSSL. libssh2 reads that file synchronously and can extract the public key with this backend, so a private-key file grant during authentication is appropriate; granting the entire `.ssh` directory is unnecessary. [libssh2 API](https://libssh2.org/libssh2_userauth_publickey_fromfile_ex.html).
- **Entitlement pairing is correct at source level:** `Entitlements.appstore.plist` already enables sandbox, `files.user-selected.read-write` and `files.bookmarks.app-scope`. User-selected authorizes picked files/folders; app-scope enables persistent bookmarks, not unrestricted filesystem access. Verify the actual signed executable's entitlements separately. [Apple entitlement reference](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html).
- **Folder grants are a sound approach:** SQLite needs sibling journals/WAL/SHM; DuckDB also creates a database-relative temporary directory, not just `.wal`. Cover spill/checkpoint/recovery and in-memory temporary-directory configuration. A picked file does not imply access to its parent. Apple's related-item support requires additional declarations and coordination; the current raw database opens do not establish that mechanism. [SQLite temporary files](https://www.sqlite.org/tempfiles.html), [DuckDB footprint](https://duckdb.org/docs/current/operations_manual/footprint_of_duckdb/files_created_by_duckdb), [Apple related items](https://developer.apple.com/videos/play/wwdc2019/701/?time=1460).
- **“Fine in the sandbox already” overstates the evidence.** Frontend wrappers delegate to dialog/fs; backup/restore is frontend file I/O in `src/screens/connection/hooks/useDatabaseBackup.ts`, while external import directly calls `std::fs::read` in `profiles/import_external.rs:41`. These are plausible same-session flows, not signed-sandbox results. SSL path fields are currently merged/stored without engine file reads. `known_hosts_path` uses `dirs::home_dir()` and `.politedb/ssh_known_hosts`; container-home behavior and trust-store persistence still need runtime verification.
- **Two independent permission systems:** locked `tauri-plugin-dialog` 2.6.0 `src/commands.rs` calls plugin-fs `allow_file` for open/save, `allow_directory(path, options.recursive)` for folder picks; its Tauri core scope uses `options.directory` for the directory recursive argument. Native macOS selection is implemented through `rfd` 0.16.0. Those runtime ACL entries are not persisted Apple bookmarks. Conversely, starting an Apple bookmark does not populate plugin-fs ACLs; custom Rust/libssh2/database I/O does not use those plugin ACLs. Context7 confirms persisted-scope saves Tauri filesystem/asset scopes, which must not be assumed to restore Apple sandbox rights. [Official plugin source](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/dialog/src/commands.rs), [persisted-scope README](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/persisted-scope/README.md).

### Blocker

1. **The port discards the security-scoped URL.** `resolve(bytes) -> { path, stale }` followed by `start(path)` cannot faithfully model Apple access: start/stop must use the retained NSURL returned by bookmark resolution, not an NSURL reconstructed from its path. Return an opaque resolved resource/token retaining that URL, plus its current path; let the guard own it, start result and matching stop. Define resolution/start failure handling, moved/deleted resources and stale refresh. Use the resolved location consistently; do not silently open an old pathname or a replacement at it. Test stale refresh/create/save failure without destroying a valid prior grant. [Apple file access](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox), [start/stop contract](https://developer.apple.com/documentation/foundation/nsurl/startaccessingsecurityscopedresource()).

2. **`file_access_grant(path, scope)` has no trustworthy picker provenance.** Being readable does not prove “the user just picked it”: container/publicly readable files and descendants of an existing broad folder grant can already be opened. Bookmarking such paths may persist more access than the user intended; it does not bypass the kernel sandbox, but it widens the application's durable authorization. The command also lacks the requested-file argument/state needed for its claimed ancestor validation; a frontend-supplied request would not establish consent. Prefer a backend-owned select-and-bookmark operation, or a one-use backend picker receipt bound to window, selected URL/type, role and pending operation. Validate the DB-folder relationship in Rust. Never derive a parent grant from a file pick or from imported JSON. Reject unsolicited grants, wrong resource types, relative paths and lexical-prefix tricks; define canonical/symlink containment and the race policy. D17 specifies the containing folder, whereas the design permits any ancestor: retain exact parent by default, or obtain an explicit decision and clear consent for broader access.

3. **The proposed export copy regresses destination safety.** `file_storage.rs:344` syncs and atomically replaces; existing tests explicitly preserve the destination on replacement failure. Copying a container temp onto the selected existing file can truncate it before disk-full, permission, cancellation or crash failure. NSSavePanel authorizes the selected destination, not arbitrary sibling staging or its entire folder. Define a sandbox-compatible replacement strategy and prove it with a signed build, e.g. explicit destination-folder consent allowing same-directory staging, or a validated native coordinated save strategy. Do not assume coordination automatically authorizes arbitrary temp names. Any loss of atomic/preserve-on-failure behavior requires an explicit product decision before approval. Keep abort session-owned, distinguish failure before/after publication, and test existing/new destinations, injected short writes, cancellation, crash boundaries and different volumes. [Apple NSSavePanel](https://developer.apple.com/documentation/appkit/nssavepanel).

4. **“Never logged” conflicts with current error handling.** `commands/connection/lifecycle.rs:65,321` logs raw driver errors; SSH test failure at line 289 logs and wraps `{e:#}`. A path-bearing `FILE_ACCESS_REQUIRED` emitted underneath these handlers will leak its path and may lose its machine-readable prefix. Define structured propagation through connect/test/SSH layers and a sanitized log representation before wiring acquisition. Audit frontend console/analytics/error reporting too. Keep paths only in the local grant UI payload and opaque bookmark data out of logs entirely. Add captured-log tests using a sentinel path and malformed/native NSError failures, alongside stable error decoding tests.

5. **Guard ownership must follow the final native close, including background work.** Storing an independent guard on a cloneable `SqliteConn`/`DuckdbConn` is insufficiently specified. Put the database and access lease in one shared lifetime owner; database final close/checkpoint must run before scope stop. A map disconnect can occur while a cloned query/export or `spawn_blocking` task still runs. Define Send/Sync/thread handling for the retained Objective-C object, failure cleanup, cancellation and test opens; acquire inside or transfer ownership into the blocking task so dropping the awaiting future cannot stop access prematurely. For SSH, retain the lease through the complete native auth call and propagate grant failures without wrapping; cover every real fresh-auth/reconnect path and pool reuse without unnecessary prompts. Validate close-time WAL cleanup, two connections sharing one grant, disconnect during query and early errors.

### Should-fix

6. **Specify grant-store integrity and recovery.** `file_storage::atomic_write_bytes` removes the old destination before rename even on Unix; do not reuse it as a failure-preserving “atomic” store writer. Reuse a suitable replacement boundary such as the existing `replace_file` helper where practical. One lock must cover read/modify/refresh/save, including simultaneous acquisition and grant operations. Define schema/version, size limits, malformed/base64 bookmark handling, file/directory type checks, restrictive store permissions, missing/unmounted-volume recovery and persistence failures. Do not downgrade I/O/corruption/native failures to “no grant” silently. `missing` must distinguish a stored entry from a currently usable grant without eager resolution/prompts for every profile.

7. **Imported data is configuration, not authorization.** Separate storage is a good boundary but needs tests: plaintext/encrypted `.politedbconnection`, single/all exports and external imports must never serialize/accept bookmark bytes or grant-store records. Existing sharing preparation already makes SSH hints portable; SQLite/DuckDB paths remain profile fields. Preserve those established semantics and document that path hints may still disclose local names; “nothing to strip” covers bookmarks only. Existing trusted grants may serve an imported matching path, but imports must never create grants or persist key-file contents. Crash/support archives and container export-temp residue also need explicit exclusion/cleanup rules.

8. **Complete the frontend recovery inventory.** Include profile create/edit Test, normal Connect, unsaved runtime connection creation, `useEnsureRuntimeConnection` auto-restore and SSH authentication. Auto-restore must surface a user action instead of launching many panels in the background. Serialize/coalesce pending requests; once-retry applies to a complete DB-file/folder plus optional SSH-key recovery, not an accidental single-error limit. On cancellation or wrong selection, preserve the previous profile/path and do not reconnect. On successful reselection to a different file, define whether to update the draft/profile or reject the mismatch; a bookmark for B cannot authorize retrying A. Preserve `:memory:` entry/use in MAS despite Browse-only UI, and decide new-database creation now: “if cheap” is an unresolved requirement under the workflow.

9. **Define folder breadth and plugin-scope policy.** Directory access covers other files in that subtree, not merely database sidecars. Explain this before consent; prefer the exact DB parent and avoid root/home grants by default. SSH persistent bookmarks should use `securityScopeAllowOnlyReadAccess`; encode required access mode/role in the service contract. `capabilities/default.json` currently allows broad home/standard-folder reads: Apple still enforces its sandbox, but webview/plugin exposure while scopes are active needs explicit MAS review. If bookmark-backed frontend fs operations are intended, restore only the necessary plugin scope and test it; otherwise keep bookmark usage in Rust. Arbitrary SQL file operations (`ATTACH`, DuckDB `COPY`/external scans and spill locations) are not covered by one initial DB grant: document denial/recovery behavior rather than claiming general sandboxed file access.

10. **Make verification discriminating.** Unsandboxed creation/start tests cannot prove rights or denial; a freshly picked file's session grant can hide bookmark defects even in a sandboxed process. Require a signed sandbox harness before Phase 3 is marked verified (independent of final store upload assets), inspect effective entitlements and relaunch between pick/persist and resolve/use. Verify an unpicked file is denied, picked file does not authorize siblings, picked parent does, and cancel/unrelated folder grants fail. Exercise SQLite rollback/WAL + crash recovery, DuckDB WAL + forced spill + checkpoint, encrypted SSH key auth across relaunch, actual plugin-fs versus direct Rust reads, and NSSavePanel new/existing output failures. Add fake-port tests for start=false, stale/moved/corrupt/missing resources, concurrent acquisitions, balanced stop and close-before-stop; malicious direct IPC, log/export leakage and store write failure. State exact Rust `--features app-store` commands: frontend `--mode appstore` alone does not select Rust distribution. Keep both flavor builds/tests; record platform/OS evidence and limitations separately.

### Nice-to-have

11. Add grant management with forget/reselect and unused-entry cleanup, retaining grants shared by other profiles. Explain that removing a stored bookmark prevents future reuse; already-active scopes or session panel grants may remain until released/relaunch.
12. Avoid the redundant persisted DB-file bookmark when the parent grant is authoritative; commit picker results transactionally after folder consent. Add non-ASCII paths, spaces, symlinks/aliases, case-insensitive volumes, removable/iCloud-backed files and long paths to the platform matrix.

**Conclusion: NOT READY for human approval.** Resolve Blockers 1–5, define new-file and broader-folder decisions, and incorporate the Should-fix contracts before implementation. The entitlement and separate-store direction is viable, but native URL identity, durable consent, export safety and shared lifetimes are currently underspecified. Only this review section was added; no application code, builds, tests or commits. Source/documentation checks do not establish signed-sandbox runtime behavior. The workflow-required Claude `/security-review` remains necessary after implementation review.

### Plan re-check (Codex)

Re-checked 2026-10-11 against Phase 3 Design/Verification revision 2, the original items 1–12 above, current source and locked dependencies. Planning only; DRAFT remains unchanged. Read `AGENTS.md` and `.agent/WORKFLOW.md`. No application code changed.

**Resolved at design level:**

- **B1, resolved-resource ownership:** resolution retains the native NSURL; the lease starts/stops that same object, rejects start=false, and stale-save failure retains the old bookmark. This fixes the original path-only resolution contract. Native picker creation is still unresolved below.
- **B2, durable consent:** backend-owned selection replaces unsolicited `grant(path)`; exact-parent consent, broad-folder rejection, cancellation without persistence and wrong-file rejection are explicit. New DB creation is now a requirement rather than “if cheap.” Resource validation/races still need the contract below.
- **B4, propagation direction:** path-free errors and unwrapped connect/test/SSH propagation are explicit, with a sentinel-log test. Confirmed current hazards: `lifecycle.rs:38` wraps create SSH errors, `:65` logs driver errors, `:289–299` logs/wraps test SSH errors, and `:321` logs test driver errors. The proposed changes must cover all these branches. Frontend/native-error auditing remains below.
- **B5, lifetime direction:** one `Arc<DbHandle>` owns both connection and lease, with connection declared before lease; acquisition inside the blocking task and SSH lease through native authentication address cancellation and final-close ownership. Confirmed `SqliteConn` and `DuckdbConn` currently hold `Arc<Mutex<Connection>>` (`engines/{sqlite,duckdb}/connection.rs:15,11`). Query functions also accept that bare Arc (`sqlite/operation.rs:33`, `duckdb/operation.rs:105`), and DuckDB utilities accept it: migrate these shared boundaries to the lease-owning handle, without letting a detached connection Arc escape. This is an implementation obligation, not a separate lifetime design blocker.
- **S6, store foundation:** schema/version, one mutation lock, caps, restrictive mode, corruption quarantine and I/O errors are defined. Confirmed `file_storage.rs:127,134` has private `replace_file`; public `json_replace_preserving` at `:155` already stages, syncs, replaces and cleans failed temps. Reuse that boundary or extend its permission-aware writer; current `File::create` does not guarantee 0600, so enforce mode on the staged inode before publication. Avoid `atomic_write_bytes` (remove-before-rename).
- **S8, recovery inventory:** Test/Connect/unsaved/auto-restore/SSH, explicit auto-restore action, coalescing, wrong-file/cancel preservation, all-grants-before-once-retry and MAS `:memory:` are now specified. Implementation must discover both DB and SSH needs before retry; `file_access_missing` checks stored presence only, so acquisition-time stale/denied failures also need recovery handling.
- **S9, intended access breadth:** exact DB parent consent, read-only SSH bookmarks, Rust-only bookmark use and denial of SQL access outside grants are explicit. **N12:** redundant DB-file bookmark removed. **N11:** grant-management UI explicitly deferred; acceptable for this phase.
- **S10, verification foundation:** signed sandbox harness, entitlement inspection, relaunch for database/SSH persistence, denial/sibling checks, both Rust flavors and fake-port lifetime tests are now required. `scripts/tauri-appstore.sh` passes `--features app-store` plus the appstore config; frontend mode alone remains insufficient. Runtime proof is correctly deferred until implementation verification.

**Unresolved before approval:**

1. **B1/B2 — picker output contract is factually wrong.** Blocking pickers are usable from Rust commands inside `spawn_blocking`: locked `tauri-plugin-dialog` 2.6.0 `lib.rs:660–680,710–724,755–769` explicitly prohibits main-thread blocking, and `desktop.rs` dispatches native dialog creation onto the main thread. However, its desktop callbacks convert `rfd::FileHandle` to `PathBuf` and return `FilePath`, not the panel's retained NSURL (`desktop.rs:175–179,208–212`; rfd 0.16.0 `panel_ffi.rs:79–83` also extracts `url.path()`). Therefore `create(url_from_panel, mode)` cannot be implemented through the stated plugin API. Choose either a small native macOS panel adapter that retains the selected NSURL and creates the bookmark before releasing it, or explicitly define a backend-picker-path-to-NSURL creation strategy and require signed/relaunch proof that it creates the intended scoped bookmark. The latter preserves backend provenance but must not be described as returning the panel URL. This is distinct from retaining the NSURL returned by bookmark resolution, which is already fixed. [Official dialog docs](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/plugin/dialog.mdx).

2. **B2/S6 — define selection identity and resource validation.** Exact-parent canonicalization alone does not specify regular-file vs directory validation for DB/SSH, absolute-path rejection, symlinks/aliases, or swaps between selection, validation and bookmark creation/open. A new DB has no canonical file yet: canonicalize its existing parent and validate the leaf without requiring the target to exist. Define canonical comparison for `expected_path`, recovery of missing/unmounted targets, and how folder identity affects a replaced DB at the same pathname. Comparing resolved path text cannot detect every replacement, particularly when the only bookmark identifies the parent folder. Add malicious direct-IPC, wrong-type, symlink and swap fixtures; choose and document a fail-closed race policy.

3. **B3 — export is a candidate strategy, not an established guarantee.** Apple's replacement API documents no-data-loss replacement and recommends `NSItemReplacementDirectory` on the destination volume; this supports the direction but does not prove this application's signed-sandbox authorization or every failure/crash outcome. Revision 2 supplies only replacement of an existing item; define publication when the destination does not exist, staging flush/close, replacement options/metadata, failure before vs after publication, session ownership, cancellation and crash-residue cleanup. Broaden the stop-and-escalate rule to any authorization/preservation failure, not only an unwritable replacement directory. Keep original bytes until publication succeeds; add injected short-write/disk-full/permission failures, cancellation, crash boundaries and another-volume destination. A signed prototype may validate the candidate during implementation, with no silent downgrade. [Apple replacement contract](https://developer.apple.com/documentation/foundation/filemanager/replaceitem(at:withitemat:backupitemname:options:resultingitemurl:)).

4. **B4/S7/S9 — privacy and plugin exposure remain incomplete.** Add frontend console/analytics/error-report auditing and malformed/native NSError sentinel cases; sanitizing only `FILE_ACCESS_*` logs does not cover path-bearing engine/native errors on the new paths. Separate grant storage prevents normal profile serialization by construction, but explicitly test plaintext/encrypted single/all exports and external imports never accept/emit grants or key contents. Define support/crash-archive exclusions and export-temp cleanup. `capabilities/default.json` still grants `$HOME/**` and standard-folder reads: “bookmarks never used for plugin-fs” does not remove webview access while a Rust folder lease is active. Record an explicit MAS capability decision and test actual plugin-fs vs direct Rust access, including denied sibling access.

5. **S10 — restore discriminating cases omitted in revision 2.** Add SQLite crash recovery, two connections sharing a grant, disconnect while query/export blocking work runs, open/auth early failure and dropped-await cleanup; export failure injection from item 3; malicious IPC and import/log leakage from items 2/4. Relaunch must separate initial selection/persistence from bookmark resolution/use, and denial controls must use resources outside container/publicly readable locations. Include non-ASCII, spaces, aliases/symlinks and removable-volume cases. Unsandboxed mechanics and static source checks cannot substitute for these signed-sandbox results.

**Conclusion: NOT READY for human approval.** Revision 2 resolves the core retained-resolution URL, backend consent, shared lifetime and recovery direction, but picker output, resource validation/races, new-destination safe publication and the remaining privacy/verification contracts still require revision. No application builds/tests or signed harness were run for this plan-only re-check; source/docs checks establish feasibility boundaries only. Claude's workflow-required `/security-review` remains required after implementation review.


### Plan re-check 2 (Codex)

Re-checked 2026-10-11 against Design revision 3 and the five unresolved items in the preceding re-check. Read `AGENTS.md`, its referenced `RTK.md`, and `.agent/WORKFLOW.md`; inspected current frontend readers, capabilities, diagnostics and locked Rust dependency sources; fetched current API documentation through Context7. This is a plan review. Phase 3 remains DRAFT; READY does not mean APPROVED or VERIFIED.

**Items 1–5: resolved at design level, with implementation obligations below.**

1. **Native picker ownership is feasible.** The new AppKit adapter replaces the plugin's path-only output with the actual retained panel URL. Locked objc2-app-kit 0.3.2 exposes `NSOpenPanel::openPanel(MainThreadMarker)`, inherited `NSSavePanel::runModal`, `NSSavePanel::savePanel(MainThreadMarker)` and `URL() -> Option<Retained<NSURL>>`. Tauri's `AppHandle::run_on_main_thread` accepts a `Send + 'static` closure: an async command can dispatch panel creation/run/bookmark creation there and await a oneshot without blocking the main thread on that receiver. Create `MainThreadMarker` inside the dispatched closure; keep panels there, rather than transferring their main-thread-only objects. NSURL itself has `Send` and `Sync` implementations in locked objc2-foundation. Existing `NSResponder`/`NSApplication` features plus the proposed panel/window features provide the required APIs. [AppKit bindings](https://docs.rs/objc2-app-kit/0.3.2/objc2_app_kit/struct.NSSavePanel.html).

2. **Selection and recovery now have an implementable policy.** Revision 3 distinguishes open/create validation, existing-parent/new-leaf handling, exact-parent consent, missing-volume errors, stale/denied recovery and intentional acceptance of replacement DB files inside the consented folder. These settle the prior product/authorization decisions. Implement the promised fail-closed identity checks accurately: `symlink_metadata` detects symlinks, not Finder aliases; disable panel alias resolution and use native alias/resource checks if aliases must be rejected. Validate existing create targets too, and reject symlinked path components or prove they cannot redirect the operation. Canonical pathname equality alone cannot prove that a folder replaced at the same pathname is the original folder; use native resource identity/bookmark resolution evidence or reject ambiguous resolution. Rechecking only file type is not identity/race protection. Include adversarial swaps, same-path folder replacement and alternate-case expected paths in tests. These are obligations within the chosen policy, not new product decisions.

3. **Safe publication APIs are available; sandbox behavior remains a verification gate.** Locked objc2-foundation 0.3.2 supplies `URLForDirectory_inDomain_appropriateForURL_create_error`, `replaceItemAtURL_withItemAtURL_backupItemName_options_resultingItemURL_error` and `moveItemAtURL_toURL_error`. Their feature gates require `NSFileManager`, `NSPathUtilities`, `NSURL`, `NSError` and (replacement) `NSString`; current foundation default features expose them. Revision 3 now covers new and existing destinations, staging flush/close, metadata options, cancellation, cleanup, injected failures and stop-and-escalate on authorization/preservation failure. Availability does not prove sandbox authorization, crash durability or preservation under every native error. Keep the signed harness as the gate; capture the resulting URL, distinguish publication success from subsequent cleanup failure, and never remove a published destination during abort/error handling. OS temporary-item cleanup is not a guarantee of immediate crash-residue deletion. [Foundation bindings](https://docs.rs/objc2-foundation/0.3.2/objc2_foundation/struct.NSFileManager.html).

4. **Privacy and reduced webview scope are viable, with one necessary ACL clarification.** Removing broad static home/standard-folder scopes is compatible with current frontend reads, **provided command permissions remain**. `src/lib/system-fs/index.ts` invokes `read_file`/`read_text_file`: CSV import, PoliteDB profile import, BLOB loading and dump restore all read a plugin-dialog-selected file. Locked dialog 2.6.0 `commands.rs` extends the fs runtime scope using `allow_file`; it does not authorize disabled IPC commands. Replace the two broad scoped capability objects with narrow, scope-free `fs:allow-read-file` and `fs:allow-read-text-file` permissions. Simply deleting both objects and relying only on `allow_file` would break those readers. Neither narrow permission supplies a static path grant; native DB/SSH panels must not add plugin-fs scopes. Verify every existing reader and denial of an unpicked sibling while a Rust folder lease is active. [Tauri permissions/scopes](https://v2.tauri.app/plugin/file-system/). The privacy/export tests and current path-free `DiagnosticsSettings.copyDebugInfo` address the previous omissions. Audit frontend console/error reporting as well as analytics, and test malformed/native errors: replacing known paths cannot sanitize every encoded path, sidecar name or other native diagnostic. Emit only safe codes/categories for errors that cannot be reliably scrubbed; preserve the original prohibition on raw SQL/customer data.

5. **The discriminating verification matrix is restored.** Revision 3 adds two-connection sharing, disconnect during blocking work, early open/auth failure, dropped-await cleanup, malicious IPC, SQLite crash recovery, private denial controls, relaunch separation and unusual/removable paths. Revision 2 still requires SQLite WAL, DuckDB WAL/spill/checkpoint, encrypted SSH auth, both flavors and the signed harness. Combine this with items 2–4's identity, publication and leakage cases. Define assertions per actual lease/shared handle: balanced start/stop and no stop before final native close; do not accidentally demand one global start for independently acquired leases. Dropped receivers/failed dispatch must not leave orphaned grants, staging files or active leases.

**Feasibility evidence:** a standalone scratch crate under `/private/tmp/politedb-phase3-api-check` passed `cargo check --offline` using the repository's locked objc2 0.6.4, objc2-app-kit 0.3.2 and objc2-foundation 0.3.2. It type-checked both panels, modal runs, retained URL access, all three FileManager APIs and `Retained<NSURL>: Send + Sync`. Tauri dispatch and plugin ACL behavior were checked against local dependency source. This probe did not run panels, integrate a Tauri command or exercise a signed sandbox. No application build/tests or signed harness were run; no application code or dependency files changed.

**Conclusion: READY for human approval.** No unresolved design blocker remains from items 1–5. The concrete corrections above are implementation/review obligations under the existing decisions; signed-sandbox authorization, preservation and lifetime evidence remain required before Phase 3 can be VERIFIED. Any harness failure covered by stop-and-escalate must be brought back to the human, without silent fallback. Claude's workflow-required `/security-review` remains required after implementation review. Only this subsection was appended; DRAFT and all earlier plan/review content remain unchanged.

## Plan Review — Phase 1c (Codex)

Reviewed 2026-10-09 against the current working tree and the uncommitted `.github/workflows/release.yml` diff. Scope: plan critique only; no application implementation. Locations below refer to pre-review source lines. Existing Phase 1 findings and unrelated plan sections are outside this review.

### Blocker

1. **D11 cannot reliably distinguish bundled records from user-created records.** `.agent/PLAN.md:182`; `src/lib/ai-assistant/providers.ts:241`; `src/components/ai-assistant/AiAssistantSettingsDialog.tsx:130`; `src-tauri/src/commands/ai.rs:40,85`. Bootstrap writes `id: "local"`, kind `ollama`, label `PoliteDB AI`, and a random loopback endpoint. Settings also creates user Ollama records with that same id; users can edit their label/endpoint. Provider files have no provenance or migration version. An id/kind/loopback-port predicate can overwrite a user's configuration; kind-only idempotency also fails after the frontend currently normalizes the migrated kind back to `ollama`. **Amend plan:** specify conservative legacy signatures and acknowledge that identical legacy shapes cannot prove ownership. Preserve ambiguous/user-custom records and require explicit user conversion rather than silently resetting their URL. Persist a versioned migration marker atomically with changes, update `host`, `subPath`, and `baseUrl` together, preserve ids/labels/exact models/keys, and serialize load-migrate-save with provider mutations. Test reload after user reconfiguration, failed persistence/retry, concurrent list/save, custom `id: local`, custom loopback ports, already-migrated files, and malformed files without overwriting them.

2. **D12 has no complete hostname/address/transport contract.** `.agent/PLAN.md:183,207`; `src-tauri/src/commands/ai.rs:166,460`. Current guard only checks a string prefix for cloud providers; local providers skip it and requests construct their own client. **Amend plan:** parse and canonicalize the actual final request URL once; reject userinfo, unsupported schemes, ambiguous host/subpath composition, query/fragment credentials, and unspecified addresses (`0.0.0.0`, `::`). Define policy for bracketed IPv6, zone ids, IPv4-mapped IPv6 (classify embedded IPv4), decimal/octal/hex/short IPv4 spellings (canonicalize then classify, or consistently reject), and non-allowed link-local/multicast/reserved ranges. Choose either HTTP literals plus exact `localhost` only (reject other DNS and `.local` mDNS names), or supported LAN DNS/mDNS with all resolved addresses validated and the validated destination pinned for connection. A one-time DNS lookup followed by a second client resolution permits rebinding; hostname text alone rejects legitimate LAN names or accepts unsafe ones. Handle `localhost` without an unrestricted resolver, define proxy behavior so HTTP cannot escape via environment/system proxies, and recheck every request. HTTPS-any-host is intentional D12 behavior, not a private-address ban. Disable redirects by default for AI requests; if redirects are supported, validate each hop/destination, reject HTTPS downgrade and cross-origin credential/body forwarding. Add controlled resolver/redirect-server tests, mixed public/private DNS answers, rebinding, `.local`, mapped private/public/unspecified IPs, and the odd IP spellings above.

3. **Network paths outside Rust bypass D12/D13 and the AI license gate.** `src/lib/ai-assistant/index.ts:305,412,448`; `src/components/ai-assistant/hooks/useAiAssistantSubmit.ts:162,193`; `src-tauri/src/commands/ai.rs:607,650`; `src-tauri/src/license.rs:202`. `listLocalAiModels` fetches directly from the webview with no bearer token. `generateText` falls back to direct HTTP when providerId is absent, using the legacy endpoint; Rust validation, keychain and entitlement checks never run on that branch. **Amend plan:** route model listing and every completion/validation through typed Tauri wrappers and one backend transport/policy service; remove or explicitly isolate the legacy direct-fetch path from production. Define a model-list command accepting validated draft config (including unsaved host/model setup), resolve optional keys in Rust, and return only model ids. Make absent/disabled providers a setup state with no request. Preserve existing completion/test/validation license gates and explicitly decide whether model discovery requires entitlement; discovery must never become a completion bypass. Test direct trial/active/expired states and MAS inactive/active states, with no network traffic for blocked completion paths and no fallback to legacy localStorage endpoints.

4. **Existing normalization destroys D14 kinds and valid server model identifiers.** `src/lib/ai-assistant/providers.ts:162,168`; `src/lib/ai-assistant/assistant.ts:11`; `src/components/ai-assistant/AiAssistantSettingsDialog.tsx:59,130,190`. Frontend converts `local_openai_compatible` to `ollama`; model normalization rewrites `llama-*`, `llama3*`, and Qwen variants to bundled `Qwen2.5-Coder-7B`. Settings does not list the compatible kind and forces all new Ollama records to `local`. This breaks distinct labels/defaults, optional-key semantics, multiple local servers, and the promise to preserve models. **Amend plan:** preserve kind and exact user/server model ids; limit legacy model conversion to positively identified bundled data. Add both provider kinds, generate unique ids for new local providers, retain migrated ids, and align frontend/backend defaults (1234 vs 11434) without rewriting existing saved URLs. Test round trips with Ollama tags such as `llama3:8b`, Qwen quantized/model variants, LM Studio ids, multiple servers, and existing cloud models.

5. **Migrated disabled providers have no recovery flow.** `.agent/PLAN.md:182`; `src/components/ai-assistant/AiAssistantSettingsDialog.tsx:190,224`; `src-tauri/src/commands/ai.rs:656`. Save preserves `draft.enabled: false`; Test calls chat and receives `AI_PROVIDER_DISABLED`. Local saves currently skip validation (`src/lib/ai-assistant/providers.ts:286`). **Amend plan:** define a draft validation flow that can test disabled configuration without enabling it first; on successful explicit save/test, persist the chosen enabled state. Specify offline-save behavior and show an enable/disable control or clear activation action. Test migration → configure → test → enable → reload, failed test staying disabled, and saving edited enabled providers without unintended state changes.

### Should-fix

6. **D13 needs separate key capabilities and explicit secret failure handling.** `src-tauri/src/commands/ai.rs:180,195,295,576,619`; `src/components/ai-assistant/AiAssistantSettingsDialog.tsx:345`; `src/lib/ai-assistant/providers.ts:301`. Both local kinds currently discard key refs/skip stored keys; set-key nevertheless accepts any kind. Keychain location alone does not ensure safe transmission. **Amend plan:** distinguish cloud-required, compatible-optional, and Ollama-keyless behavior in save/ref preservation, retrieval, draft validation, model listing, and set-key. Only genuine not-found means no optional key; locked/denied/entitlement errors must fail rather than silently send unauthenticated requests. Derive canonical refs from ids, never trust supplied refs or return raw stored keys to the UI. Keep blank input meaning “retain”; provide explicit removal if supported, clear typed secrets on dialog close/provider switch, and test rollback on provider-file failure, key replacement/deletion, kind changes, and cloud-key preservation. Reject credentials embedded in URLs; use sanitized network errors rather than interpolating reqwest errors containing URLs (`ai.rs:304`). Verify no secret appears in JSON/localStorage/history/events/logs/errors, and no bearer token reaches redirects. HTTP LAN bearer tokens remain plaintext on the network under D12; document that tradeoff and recommend HTTPS for authenticated LAN servers.

7. **Selection fallback must never pick disabled records or stale endpoints.** `src/lib/ai-assistant/providers.ts:197,209,214`; `src/components/ai-assistant/AiAssistantPanel.tsx:59,196,217,280`. Resolver finally returns `providers[0]` even if every record is disabled; panel filters id `local` using downloaded-model state. The selection event ignores an empty id. **Amend plan:** remove all bundled-model availability checks and define enabled-only selected/default/first fallback; when none exists, clear persisted and in-memory selection/model/label and disable submit while leaving Settings accessible. Explicitly handle empty selection events, delete/disable/reload, auto/manual selection and `politedb.ai.model.selected.<id>`. Preserve valid cloud selections and model preferences; define a new default only when migrated default is unavailable. Test no providers, only migrated-disabled provider, migrated default with enabled cloud fallback, multiple open panels, and previously stored `local` selection.

8. **D9's removal inventory and regression coverage need explicit additions.** `src/components/ai-assistant/hooks/useAiAssistantSubmit.ts:20,53`; `src/lib/ai-assistant/index.ts:283`; `src/lib/ai-assistant/types.ts:3,77`; `src/lib/ai-assistant/assistant.ts:3`; `src/components/ai-assistant/AiAssistantPanel.test.tsx:79,329`; `src/components/ai-assistant/hooks/useUnavailableAiRuntimeManager.test.ts:14`; `src/lib/ai-assistant/providerAvailability.test.ts:34`; `src/lib/ai-assistant/providers.test.ts:79`. **Amend plan:** inventory legacy endpoint/model/seen storage helpers, GenerateOptions/LocalAiSettings callers, submit/error heuristics, provider-save tests, panel runtime mocks/screens, unavailable-hook tests, provider normalization/availability tests, and both distribution test suites. Replace obsolete runtime assertions with local-API regression tests. Remove startup autostart as well as exit shutdown (`src-tauri/src/main.rs:156,273`); remove only `ai_runtime` state and retain `ai_chat_cancel` (`src-tauri/src/state/app_state.rs:53,54`) plus chat cancellation commands. Do not remove database `runtimeConnectionId` or `engines/runtime` merely because names contain “runtime”. Add a final repository reference sweep with an explicit allowlist for intentional legacy cleanup and historical documentation.

9. **D10 misses interrupted downloads and safe cleanup semantics.** `.agent/PLAN.md:181`; `src-tauri/src/ai_runtime.rs:245,734,902`. Existing cleanup also deletes `default.gguf.part`; a crash can leave only that large file, invisible under the proposed exists-only-full-model button. **Amend plan:** decide explicitly whether D10 includes this fixed partial-download sibling, then expose separate presence/sizes and delete only approved fixed files. Keep cleanup independent of provider selection/deletion, never recurse through the AI directory (it contains `providers.json`), never follow environment overrides or resource model search, and define symlink/parent-symlink confinement. Return sanitized errors, treat already-absent cleanup as success, refresh UI after deletion/failure, and test partial-only files, repeat delete, permissions, symlinks, and provider/history/key preservation. MAS visibility should depend on actual existence, not a hardcoded assumption about containers.

10. **Release diff cannot safely ship independently of D9; verification needs clean packaged artifacts.** `.github/workflows/release.yml:72,184,530`; `src-tauri/tauri.conf.json:62`; `src-tauri/tauri.appstore.conf.json:19`. The user removed helper download/sign/verify on macOS/Linux/Windows while current config still bundles `resources/ai` and direct startup/UI still expect the helper. This can yield a helper-free app still advertising bundled runtime; stale ignored local assets can hide the problem in developer builds. **Amend plan:** treat workflow removals, runtime removal and resource/config removal as one release unit; do not publish the workflow-only intermediate state. Remove the stale macOS summary lines as already planned, and add clean-checkout/package verification for direct macOS, Linux and Windows, plus MAS merged config/bundle checks, asserting no runtime binaries/models/resources remain. Preserve unrelated signing/notarization/updater steps. The deleted `sign-macos-libs.sh` is AI-specific, so its removal does not itself remove generic app-library signing. No CI build or signed artifact was executed during this critique.

11. **“Chat history/settings unaffected” needs upgrade fixtures, not just selection tests.** `.agent/PLAN.md:200,208`; `src/components/ai-assistant/hooks/useAiChatSession.ts:5,80,105,157`; `src/components/ai-assistant/AiAssistantPanel.tsx:59`; `src/components/ai-assistant/hooks/useAiAssistantSubmit.ts:193`. Chat sessions keep providerId independently of global selection; legacy endpoint/model settings are separately persisted. **Amend plan:** preserve `politedb.ai.chat.*` payloads, active sessions, messages/SQL/results and language/context state, even when their provider is disabled/missing. Decide how resume chooses an enabled provider without rewriting historical attribution or sending to the old endpoint. Add upgrade fixtures covering legacy single-session data, multi-session history, `local` attribution, selected cloud models and auto/manual mode; migration must not broadly clear localStorage. Keep historical chat viewing and legacy-file cleanup accessible independently of current AI entitlement.

### Nice-to-have

12. **Update user-facing setup docs alongside internal feature mapping.** `README.md:95,213,243`; `.agent/PLAN.md:196`. README still advertises bundled runtime, environment overrides and removed CI variables. Add README to the planned docs scope: local server setup, ports/subpaths, exact model ids, optional auth, URL-policy hostname limitations, migration/enable instructions and manual disk cleanup. Mark obsolete runtime variables unsupported; retain existing cloud-provider instructions.

13. **Specify bounded discovery and connection UX.** `src/lib/ai-assistant/index.ts:305`; `src-tauri/src/commands/ai.rs:460`. Add connection/request timeouts, response-size/model-count limits, cancellation and stale-draft response protection for model discovery; report empty/invalid lists without erasing manually entered models. Keep test/chat cancellation behavior and make external-server errors actionable without exposing hosts or prompts.

### Suggested implementation order and approval conclusion

1. Resolve D11 provenance/ambiguity, D12 hostname/IP/redirect/proxy rules, D13 optional-key contract, disabled-provider recovery and entitlement behavior in the plan before approval.
2. Establish a shared backend URL/transport/key boundary and typed discovery/draft-validation wrappers; add policy/key/license tests first.
3. Implement serialized, durable provider-file migration and fixed-path legacy cleanup with persistence/failure tests.
4. Update frontend kinds/model normalization, provider selection/settings/activation and history compatibility; ensure all production requests use the backend boundary.
5. Remove bundled runtime commands/state/startup/hooks/screens/assets/scripts and update distribution/tests/configs, coupled with the user's release-workflow changes. Finish with docs, both frontend flavor builds, Rust tests/clippy in both flavors, clean packaged artifact checks and localhost/LAN authenticated-server smoke tests. Obtain the workflow-required second security review for migration/keychain/license-sensitive scope (`.agent/WORKFLOW.md:47`) before committing or releasing.

**Conclusion: NOT READY for human approval.** D9–D14 describe the desired product direction, but Blockers 1–5 leave migration ownership, network enforcement and a usable activation path undefined. Resolve those contracts and incorporate Should-fix items into Phase 1c before requesting approval. This review does not approve the phase or change its DRAFT status. Application tests/builds were not run because this task only changes review text; runtime/CI claims above are source/diff observations, not execution evidence.

### Plan re-check (Codex)

Re-checked 2026-10-09 against revised D10–D15, R1–R10, implementation order and current source. “Resolved” means the plan defines the contract, not that implementation is verified.

| Finding                                | Status    | Reason / remaining requirement                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blocker 1 — migration ownership        | Partially | D11 preserves URLs/keys and adds a serialized, persisted marker. The signature still cannot distinguish an identical user-created record; disabling it is a configuration change. Explicitly acknowledge ambiguity and require user confirmation before disabling ambiguous matches; add failed-write/retry, concurrent mutation and reconfiguration/reload fixtures. |
| Blocker 2 — URL/transport policy       | Resolved  | D12 defines allowed addresses, literal-only HTTP plus pinned localhost, mapped IPv6, forbidden URL components, redirect/proxy behavior and request-time enforcement. Reject odd IPv4 spellings using original authority text before parser normalization; include transport tests, not only address predicates.                                                       |
| Blocker 3 — backend/entitlement bypass | Resolved  | R1 removes both webview paths; D15 makes discovery metadata-only and ungated while completion/test/validation retain the gate. Add no-network assertions across direct trial/active/expired and MAS inactive/active states.                                                                                                                                           |
| Blocker 4 — kinds/model identifiers    | Partially | R2 fixes kinds, ids and defaults, but “bundled placeholder values” alone do not prove provenance: an external server may legitimately expose `default` or `local-model`. Preserve every external/saved/server model id exactly; scope any conversion to explicitly confirmed bundled data.                                                                            |
| Blocker 5 — disabled-provider recovery | Partially | R3 adds draft testing and Enabled toggle. Specify offline Save, whether Test persists anything, the chosen enabled state after success, and whether failed testing of an already-enabled provider changes it. R1’s disabled-provider no-request rule needs an explicit exception for user-invoked draft test/discovery.                                               |
| Should-fix 6 — key semantics/failures  | Partially | R4 covers capabilities, canonical refs, not-found, removal and sanitization. Still require typed-secret clearing on close/switch, kind-change semantics, config/key rollback and failure tests. Current `ai_provider_set_key` swallows prior-read errors with `.ok()`; the revised contract must cover writes/removal as well as requests.                            |
| Should-fix 7 — selection               | Resolved  | R5 specifies enabled-only fallback, empty selection/model/label, model keys and accessible Settings; verify deletion/disable/reload and multiple panels.                                                                                                                                                                                                              |
| Should-fix 8 — removal inventory       | Resolved  | D9/R7 cover startup/shutdown, legacy helpers, frontend/tests and distribution; explicitly retain chat cancellation and database runtime code.                                                                                                                                                                                                                         |
| Should-fix 9 — cleanup                 | Partially | D10 includes partial files, sizes, fixed paths, confirmation, independent access and sanitized/idempotent errors. Require checking both `ai` and `models` ancestors, UI refresh after partial failure, and partial-only/permission/symlink/provider-preservation tests.                                                                                               |
| Should-fix 10 — release unit           | Resolved  | R8 couples workflow/runtime/resources removal and requires clean package checks on all targets; retain unrelated signing/updater behavior.                                                                                                                                                                                                                            |
| Should-fix 11 — history                | Partially | R6 adds upgrade fixtures and missing/disabled-provider selection prompt. Explicitly preserve historical attribution when choosing a replacement, active session/language/context state and cloud model/mode preferences; keep viewing available without AI entitlement.                                                                                               |

New issues / feasibility:

- **Blocker — atomic migration cannot reuse the current writer unchanged.** `file_storage::atomic_write_bytes` removes the destination before rename on every platform; rename failure/crash can lose `providers.json`. `AppState` also has no provider-file mutation lock today. Plan a provider-scoped lock covering load/migrate/save/key/delete and replacement that preserves the original on failure; test marker/config consistency. Existing export replacement code demonstrates a reusable platform pattern, but its export-only API is not a provider-file API.
- **Should-fix — symlink confinement wording is incomplete.** Checking only the final file and immediate `models` parent misses an `ai` symlink. Define trusted app-data root, reject redirected descendants and prevent check/delete races; never recurse or delete directories.
- **Should-fix — discovery must work before a model exists.** Current `normalize_provider` rejects empty `default_model`; R1 draft discovery cannot reuse it unchanged. Separate URL/key/discovery validation from completion model validation, and test an unsaved draft with empty models/default model.

**Conclusion: NOT READY for human approval.** Remaining contracts above need clarification, especially Blockers 1/4/5 and atomic persistence. The direction is implementable with focused backend changes; current helpers cannot satisfy it unchanged. DRAFT status retained. No application code, commits, builds or tests; only this subsection added.

### Plan re-check 2 (Codex)

Re-checked 2026-10-09 against round-2 decisions, requirements and current save flow. “Resolved” describes the plan contract, not verified implementation. Previously resolved items remain resolved.

| Item from previous re-check                | Status    | Assessment                                                                                                                                                                          |
| ------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blocker 1 — migration ownership            | Resolved  | D11 is display-only; ambiguous matches retain all provider fields and keys. Stale migration instructions remain below.                                                              |
| Blocker 4 — kinds/model identifiers        | Resolved  | R2 preserves every saved/typed/server model id exactly; no placeholder conversion.                                                                                                  |
| Blocker 5 — disabled-provider recovery     | Resolved  | R3 defines offline Save, exact enabled-state persistence and explicit draft Test/discovery exceptions with no persistence.                                                          |
| Should-fix 6 — key semantics/failures      | Partially | R4 adds secret clearing, kind-change deletion, error propagation and rollback tests; transaction scope and rollback-failure behavior remain undefined.                              |
| Should-fix 9 — cleanup                     | Partially | D10 covers both ancestors, fixed files and refresh after partial failure; add explicit partial-only, permission and provider/history/key-preservation fixtures. Race remains below. |
| Should-fix 11 — history                    | Resolved  | R6 preserves attribution, active session, language/context and cloud preferences; history viewing stays ungated.                                                                    |
| New blocker — provider-file lock/replace   | Resolved  | R11 specifies serialization and replacement preserving the existing file on failure. D11 no longer needs migration-marker consistency. Config/key transaction remains separate.     |
| New should-fix — symlink confinement       | Partially | D10 checks `ai`, `models` and target under a trusted root, but pathname checks followed by `remove_file` still permit ancestor replacement between check and delete.                |
| New should-fix — discovery without a model | Resolved  | R12 separates discovery validation from completion validation; retain an explicit empty-model draft regression test.                                                                |

Remaining / new issues:

- **Blocker — Save must serialize config and key as one backend operation.** R4's config-then-key rollback plus R11's per-operation lock does not explicitly cover the whole transaction. Current `saveAiProviderWithOptionalKey` makes separate save-config/set-key calls; another save/delete can interleave, expose new config with an old key or be overwritten by rollback. Require one backend critical section covering prior config/key reads, validation, config/key mutation or removal, and rollback. Define sanitized reporting/recovery when rollback itself fails; test interleaving, key-delete failure and rollback failure. No network request while holding this lock.
- **Should-fix — cleanup race remains.** Immediate `symlink_metadata` checks do not prevent check/delete races. Specify deletion anchored to trusted directory handles without following redirected descendants, or an equivalent platform-specific confinement strategy; add an ancestor-swap regression alongside the cleanup fixtures above.
- **Should-fix — active Phase 1c text contradicts D11.** Scope still says “provider-file migration for D11”; Compatibility and Verification still describe migration and migrated-record fixtures; R9 still says “re-enable after upgrade” although enabled state is preserved. Replace these with notice/dismissal/reload and no-provider-write fixtures, and conditional setup instructions. Historical review text can remain unchanged.

**Conclusion: NOT READY for human approval.** Core round-2 contracts are substantially resolved and implementable; clarify the config/key transaction and remaining cleanup/text issues first. DRAFT status retained. Only this subsection added; no application code, commits, builds or tests.

### Plan re-check 3 (Codex)

Re-checked 2026-10-09 against R13, revised D10 and active Phase 1c text. Statuses assess plan contracts, not implementation.

| Item                                          | Status    | Assessment                                                                                                                                                                                                                                                 |
| --------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blocker — config/key save transaction         | Resolved  | R13 defines one backend save command, prior-state reads and mutation/rollback under R11's lock, sanitized rollback-failure reporting, disk reload and interleaving/failure tests; no network under the lock.                                               |
| Should-fix — cleanup confinement and fixtures | Partially | Unix directory-relative openat/unlinkat closes the ancestor race; required cleanup/preservation fixtures are present. Windows handle-based deletion protects an already-opened target, but ancestor confinement during target opening remains unspecified. |
| Should-fix — stale D11 migration text         | Resolved  | Active Scope, Compatibility, Verification and R9 now describe a display-only notice, dismissal/reload and unchanged provider data. Historical reviews may retain migration wording.                                                                        |

Remaining issues (no new blocker):

- **Should-fix — Windows opening must also be race-safe.** `FILE_FLAG_OPEN_REPARSE_POINT` protects the component being opened, not intermediate ancestors of a pathname. Checking `ai`/`models` handles then opening the target by full path still permits an ancestor swap before the target handle exists; `FileDispositionInfo` would delete that redirected target. Require opens relative to verified parent handles, or retain handles that deny delete/rename sharing for every checked ancestor throughout traversal and deletion. Validate the target handle as a regular, non-reparse file; add a Windows swap-during-open fixture, not only a swap between info and delete.

**Conclusion: NOT READY for human approval.** Save and D11 text issues are resolved; specify Windows traversal confinement before approval. DRAFT retained. Only this subsection added; no application code, commits, builds or tests.

### Plan re-check 4 (Codex)

Re-checked 2026-10-10: D10 Windows traversal confinement is resolved at plan level. Retained non-reparse ancestor handles deny delete/rename sharing throughout traversal/deletion; target regular-file/parent validation and a fail-closed Windows swap-during-open fixture cover re-check 3's remaining issue.

Quick Phase 1c scan found no remaining Blocker/Should-fix. **Conclusion: READY for human approval.** DRAFT retained; implementation and platform tests still require verification. Only this subsection added; no code changes, commits, builds or tests.
