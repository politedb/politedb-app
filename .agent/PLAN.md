# Mac App Store Distribution Flavor

## Status

IMPLEMENTED

## Task

- ID: mac-app-store-flavor
- Requested 2026-10-09: publish PoliteDB on the Mac App Store (MAS).
- User approved the plan with all decisions D1–D8 on 2026-10-09 ("chốt").
- Previous plan (branded-keychain-entries, IMPLEMENTED) is in git history.
- Implement phases in order on branch `feat/mac-app-store-flavor`; record progress and verification evidence in this file.
- Current: Phase 1 implemented and Codex review findings (P1-1..P1-3, P2-1, P2-2) fixed; ready for Codex re-review. Phases 2–6 not started; set back to `APPROVED` to continue.
- No commit/push unless requested.

## Goal And Visible Result

- A second macOS build flavor, `appstore`, that passes App Store review and uploads to App Store Connect as a universal `.pkg`.
- The existing Developer ID DMG flavor keeps current behavior unchanged: updater, license/trial, non-sandboxed file access, Oracle, local AI runtime.
- Both flavors build from the same source; flavor differences are selected at build time, not by scattered runtime `if` checks.

## Decisions

All decisions resolved by the user on 2026-10-09:

- D1 Monetization in MAS — **Free download + StoreKit In-App Purchase** that unlocks the same features as a paid license. Licensing UI that links to external purchase is removed from the MAS flavor (guideline 3.1.1).
- D2 Local AI runtime (`llama-server`, 22 MB in `resources/ai/bin/macos`) — **Excluded from MAS v1.** `resources/ai` is not bundled in the MAS flavor; cloud AI providers keep working. Local-AI UI is hidden in MAS.
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
