# Restore ≤1.4 WebView Storage (macOS, Windows, Linux)

## Status

IMPLEMENTED

## Task

- ID: legacy-webkit-storage
- Requested 2026-10-14 by the user:
  - The bundle-id rename to `com.politedb.PoliteDB` was dropped ("thôi vậy tôi không đổi bundle ID nữa"). Fix the lost WebView storage instead ("fix lại chỗ webkit cho tôi là được").
  - Scope widened to all three platforms ("chọn c, làm cả ba trong một plan").
- The cancelled plan `bundle-id-rename` was never approved and is not kept.
- Branch: `fix/legacy-webkit-storage` from `main`.
- Data migration + new dependency → Codex plan critique → user approval → implement → Codex review → Claude `/security-review`.
- Approved by the user on 2026-10-14 ("tôi duyệt, chạy phase 0 đi"). The user skipped the Codex plan critique; Codex still reviews the implementation.
- No commit/push unless requested.

## Problem

1.5.0 changed the bundle identifier from `com.politehq.politedb` to `PoliteDB` (`3801445`). `5d2cfed` migrates only `app_data_dir`. localStorage lives in the WebView engine's store, which is also keyed by the identifier. So every ≤1.4 user who upgraded lost:

- app settings (`politedb:app-settings:v1`), theme/font/density;
- connection groups (`politedb.connection-groups.v1`), pinned connections (`politedb.pinned-connections.v1`), keyboard shortcuts (`politedb.keyboard-shortcuts.v1`);
- AI chat sessions (`politedb.ai.chat.*`), AI provider/model selection;
- analytics consent and the welcome flag.

The old data is still on disk on every platform:

| Platform | Engine              | Old store (≤1.4)                                                                                             | Why 1.5 lost it                                                                                                                                                                                                                                      | Origin                                                               |
| -------- | ------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| macOS    | WKWebView           | `~/Library/WebKit/com.politehq.politedb/WebsiteData/Default/<hash>/<hash>/LocalStorage/localstorage.sqlite3` | WebKit folder is not an app folder; never migrated                                                                                                                                                                                                   | `tauri://localhost`                                                  |
| Windows  | WebView2 (Chromium) | `%LOCALAPPDATA%\com.politehq.politedb\EBWebView\Default\Local Storage\leveldb`                               | Tauri forces the WebView2 data dir to `LocalData/<id>` (`tauri-2.10.1/src/manager/webview.rs:504`); the migration only moves `%APPDATA%\<id>` (Roaming)                                                                                              | `http://tauri.localhost` (v2 default, no `useHttpsScheme` in config) |
| Linux    | WebKitGTK           | under `~/.local/share/com.politehq.politedb` (same LocalData rule)                                           | Config windows are created **before** the `setup` hook (`tauri-2.10.1/src/app.rs:2373`). The new WebView creates `~/.local/share/PoliteDB` first, so `migrate_dir` only merges missing top-level entries and leaves the old WebKitGTK folders behind | `tauri://localhost`                                                  |

Formats:

- WebKit (macOS, recent WebKitGTK): SQLite `ItemTable(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL)` with UTF-16LE values, in an origin folder whose `origin` file names scheme and host. Confirmed on this Mac.
- Older WebKitGTK may use `<base>/localstorage/<scheme>_<host>_0.localstorage` (same table). The reader supports both layouts.
- Chromium LevelDB (snappy-compressed). Entry key `_<origin>\0<enc><name>`; value `<enc><bytes>`, where `enc` `0x00` = UTF-16LE and `0x01` = Latin-1. `META:` / `VERSION` entries are ignored.

## Goal And Visible Result

On the first launch of the fixed build, on macOS, Windows and Linux, a user who ever ran ≤1.4 gets back their old groups, pins, shortcuts, settings and chats wherever the 1.5 store has nothing under that key. Nothing set in 1.5 is overwritten. It runs once.

## Requirements

### R1 Backend reader

- New module `src-tauri/src/legacy_web_storage/` with:
  - `mod.rs`: shared types, filter/caps, temp-copy helper, and the port.
  - `webkit.rs`: SQLite reader for macOS and Linux.
  - `chromium.rs`: LevelDB reader for Windows.
- The port (OCP):

  ```rust
  trait LegacyStoreReader { fn read(&self) -> Result<Vec<(String, String)>, ReadError>; }
  ```

  One impl is selected per target by `cfg`, so callers never branch on the platform.

- Thin command `legacy_web_storage_read` in `commands/`, registered in `main.rs`. It returns `{ entries: [{key, value}], skipped: n }` or a fixed error code `LEGACY_STORAGE_UNREADABLE`. Under the `app-store` feature it returns empty (the sandbox can't read outside its container and MAS has no old data).
- **Source paths** are fixed and built in Rust (`LEGACY_IDENTIFIER = "com.politehq.politedb"`). No path comes from the frontend.
  - macOS: `<home>/Library/WebKit/com.politehq.politedb/WebsiteData/Default`.
  - Windows: `app.path().local_data_dir()/com.politehq.politedb/EBWebView/Default/Local Storage/leveldb`.
  - Linux: `app.path().local_data_dir()/com.politehq.politedb`. The WebKitGTK storage layouts underneath are confirmed in Phase 0.
- **Origin selection:**
  - WebKit: read each `<hash>/<hash>/origin` at a fixed depth, without following symlinks, and accept only scheme `tauri` + host `localhost`. With the older Linux layout, accept only the `tauri_localhost_0.localstorage` file.
  - Chromium: accept only entries whose origin is exactly `http://tauri.localhost` (and `https://tauri.localhost`, in case it was ever enabled).
  - Zero matches → empty. More than one WebKit origin folder → empty, never a guess.
- **Read without touching the source:** copy the database files (SQLite + `-wal`/`-shm`; or the whole LevelDB directory, excluding the `LOCK` file) into a private temp dir, open the copy read-only, and delete the temp dir afterwards.
- **Decode:**
  - WebKit values are UTF-16LE.
  - Chromium names and values: the prefix byte selects UTF-16LE or Latin-1.
  - Invalid rows are skipped and counted.
- **Filter:**
  - keep only keys starting with `politedb.` or `politedb:`;
  - drop `politedb.analytics.session_id` (ephemeral) and `politedb.migration.*`.
- **Caps:** ≤ 2,000 keys, value ≤ 5 MB, total ≤ 20 MB. The source copy is capped too: skip if the store exceeds 100 MB.
- **Logging:** counts and error kinds only. Never keys, values or paths.

### R2 New dependency (Windows only)

- A pure-Rust LevelDB reader with snappy support (candidate: `rusty-leveldb`), added as `[target.'cfg(windows)'.dependencies]` and also compiled for tests so the decoder is tested on every CI platform.
- Pin the version, keep `Cargo.lock` in sync, and run the dependency through the review.
- If Phase 0 shows it can't open a real WebView2 store, fall back to a minimal read-only SSTable/log reader limited to what Chromium writes. That would be a plan amendment.

### R3 Frontend import (before anything reads localStorage)

- New typed wrapper `src/lib/tauri/legacyWebStorage.ts`, plus an import routine `src/lib/legacyWebStorage.ts`.
- Called as the **first** step of `boot()` in `src/main.tsx`, before theme/font/density/analytics, and only in the Tauri runtime.
- Steps:
  1. If the marker `politedb.migration.legacyWebStorage.v1` exists, stop.
  2. Call the command, with a 3 s timeout.
  3. For each entry, `setItem` **only if `getItem(key) === null`**.
  4. Set the marker. On error or timeout, don't set it; increment `politedb.migration.legacyWebStorage.attempts`, and once it reaches 3, set the marker and give up.
  5. If at least one key was written, call `window.location.reload()` once. Some modules read localStorage at import time (`src/stores/keyboardShortcuts.ts` `loadShortcuts()` at store creation), before `boot()` runs; the reload restarts them from the restored values. The marker prevents a loop.
- Web (non-Tauri): no call. The marker is set so it never repeats.

### R4 Invariants

- The old store is never written, moved or deleted.
- 1.5 values always win; import fills gaps only.
- The app starts normally if anything fails (no blocking error UI).
- Restored ≤1.4 chats predate the agent data tools, so they carry no `dataRead` taint. They have no owner entry in `politedb.ai.chatOwners`, so they behave like other ownerless legacy chats today. Verify this in the purge-on-profile-change path.
- `data_migration.rs` is unchanged (app data already migrates correctly on all three platforms).

## Phases

- **Phase 0 — Real-store probes (no app code).** For each platform, install 1.4.0, create throwaway data (a group, a pin, a shortcut, a setting, a chat), upgrade to 1.5.2, and record:
  1. where the old store is and its exact layout/format: WebKitGTK version and layout on Ubuntu 22.04; WebView2 LevelDB entry encoding;
  2. which origin it uses;
  3. that the old store survived the upgrade.

  Then copy the old store (throwaway data only) as test fixtures under `src-tauri/tests/fixtures/legacy_web_storage/<platform>/`.
  - macOS: this Mac (already confirmed for the format).
  - Windows/Linux: a VM, or a CI job that installs 1.4.0 → 1.5.2 headlessly. **Needs the user** (no Windows/Linux machine in this workspace).

- **Phase 1 — Implement R1–R4.**

### Phase 0 — Results, macOS (Claude, 2026-10-14)

1.4.0 was **not** installed on this Mac: it would overwrite the user's working 1.5.2 install. Instead, the user's existing ≤1.4 store was inspected read-only from a scratchpad copy. Only structure, key names and JSON shapes were printed, never values.

- **Layout:**
  - `~/Library/WebKit/com.politehq.politedb/WebsiteData/Default/salt` plus two origin folders, `<h>/<h>/` (same hash twice).
  - Each origin folder holds `origin` and `LocalStorage/localstorage.sqlite3` with `-wal`/`-shm`.
  - An older-layout folder `WebsiteData/LocalStorage/` exists but is empty here; older macOS/WebKit versions may keep `<scheme>_<host>_0.localstorage` files there. The reader supports both layouts (same as the old WebKitGTK layout).
- **`origin` file format:** two serialized origins (top frame + frame). Each is:
  - protocol: `u32 LE length`, `u8 1` (8-bit string), bytes;
  - host: same encoding;
  - port: `u8 0` = no port, or `u8 1` + `u16 LE port`.

  Observed:
  - production: `tauri`/`localhost`, no port, twice;
  - dev: `http`/`localhost`/`1420`.

  The reader accepts a folder only if **both** origins parse exactly as `tauri`, `localhost`, no port, with no trailing bytes. Anything else is ignored.

- **Store:**
  - `ItemTable(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)`; 18 rows, all values BLOB and all valid UTF-16LE.
  - Most data was only in the WAL (main file 28 KB, WAL 230 KB), so copying `-wal`/`-shm` with the database is required.
  - Largest value 3.7 KB.
- **Key families found (≤1.4):**
  - Still read by the current app:
    - `politedb:app-settings:v1` (theme, uiFont, density, defaultRowLimit, queryTimeoutSeconds, autosaveSqlDrafts, autoConnectLastProfile, healthCheckInterval);
    - `politedb.connection-groups.v1` (assignments keyed by profile id; profiles migrate with app data, so ids match);
    - `politedb.pinned-connections.v1`;
    - `politedb.ai.chat.global-ai-assistant` and `politedb.ai.chat.tab-<id>` (same `{scopeKey, activeSessionId, sessions[], updatedAt}` shape as today);
    - `politedb.ai.provider.selected`, `politedb.analytics.consent`, `politedb.analytics.install_date`, `politedb:welcome:seen`.
  - **No longer read anywhere in `src/`:** `politedb.ai.endpoint`, `politedb.ai.model`, `politedb.ai.model.seen` (the removed local-runtime era), `politedb.analytics.session_id`, `politedb.analytics.last_active_date`.
  - Not prefixed (already excluded): the PostHog `ph_*_posthog` blob.
- **Amendment to R1's filter — approved by the user on 2026-10-14 ("đồng ý allowlist"):** replace the `politedb.`/`politedb:` prefix rule with an **allowlist of keys the current app reads**:
  - exact: `politedb:app-settings:v1`, `politedb.connection-groups.v1`, `politedb.pinned-connections.v1`, `politedb.keyboard-shortcuts.v1`, `politedb.ai.provider.selected`, `politedb.ai.model.selectionMode`, `politedb.analytics.consent`, `politedb.analytics.install_date`, `politedb:welcome:seen`, `politedb.ai.legacyLocalNotice.dismissed`;
  - prefix: `politedb.ai.chat.`, `politedb.ai.model.selected.`.

  This avoids reviving dead legacy AI endpoint/model keys (Phase 1c removed the legacy local endpoint path), and the import can only touch state the app knows how to read.

- **Follow-up checks for Phase 1:**
  - a restored `politedb.ai.provider.selected` naming a provider that no longer exists must fall back cleanly;
  - restored chat JSON must load through `useAiChatSession` parsing;
  - `tab-<id>` chats only reappear if the persisted tab ids (app data `persistent/`, already migrated) match. Otherwise they are inert.
- **No real fixture taken from this store:** it holds the user's data. Phase 1 builds fixtures in tests with the exact schema and origin encoding above.
- **Windows / Linux: no real-store probe.** The user declined a CI job ("không cần job CI"). The Chromium LevelDB and WebKitGTK readers are built from the documented formats and tested with synthesized fixtures. They fail closed (empty import) on anything unexpected. **Accepted limitation:** no real 1.4 → 1.5 upgrade has been verified on Windows/Linux.

## Files

- `src-tauri/src/legacy_web_storage/{mod,webkit,chromium}.rs` (new), `src-tauri/src/commands/legacy_web_storage.rs` (new, thin), `src-tauri/src/commands/mod.rs`, `src-tauri/src/main.rs`.
- `src-tauri/Cargo.toml`, `Cargo.lock` (R2).
- `src/lib/tauri/legacyWebStorage.ts`, `src/lib/legacyWebStorage.ts`, `src/main.tsx`.
- Fixtures under `src-tauri/tests/fixtures/legacy_web_storage/` (throwaway data only).

## Verification

- Rust unit tests (run on every CI platform, because the readers are compiled for tests everywhere):
  - **WebKit SQLite:**
    - origin selection (tauri accepted; http/inspector ignored; 0 or 2 matches → empty);
    - WAL-only rows included;
    - old Linux layout;
    - UTF-16LE decoding;
    - corrupt DB → error code, no panic;
    - symlinked folders ignored;
    - source byte-identical after the read.
  - **Chromium LevelDB:**
    - origin filter (`http://tauri.localhost` only; other origins and `META:` ignored);
    - UTF-16LE vs Latin-1 names/values;
    - snappy blocks;
    - `LOCK` not copied;
    - corrupt store → error code;
    - source unchanged.
  - **Shared:** prefix filter, deny list, caps.
  - **Real fixtures from Phase 0** for all three platforms.
- Vitest:
  - marker present → no call;
  - fills missing keys only, never overwrites;
  - sets the marker;
  - reloads only when something was written;
  - error → attempts counter, then the marker after 3;
  - timeout path;
  - non-Tauri → no call.
- `cargo test`, `cargo clippy`, `npm run build`, `npm run test:run`, prettier. CI builds on Windows and Linux.
- Manual upgrade 1.4.0 → 1.5.2 → fixed build, on each platform. **macOS on this Mac:** save a copy of the current `~/Library/WebKit/politedb` first so it can be restored. **Windows and Linux on a VM:**
  - old groups/pins/shortcuts/chats appear where 1.5 had none;
  - 1.5 settings are unchanged;
  - a second launch does nothing;
  - the old store is unchanged.

## Risks

- **Internal formats:**
  - WebKit's localStorage schema and Chromium's LevelDB encoding are not public APIs.
  - Readers fail closed (empty import), and the app starts normally.
  - Real fixtures pin today's formats.
- **New dependency on Windows:** supply-chain surface; parser bugs on untrusted input. Here the input is the app's own old store, and the store is size-capped.
- **Windows/Linux verification depends on the user providing VMs or CI runs.** Without them, those platforms ship with unit/fixture coverage only, and that must be recorded as a limitation.
- **Reviving old values:** ≤1.4 data may be months old. It only fills keys the user never set in 1.5.
- One extra reload on the first launch when something was imported.

### Phase 1 — Implementation evidence (Claude, 2026-10-14)

Branch `fix/legacy-webkit-storage` (from `main` @ `b74100b`), uncommitted.

**Backend:**

- `src-tauri/src/legacy_web_storage/mod.rs`:
  - `LEGACY_IDENTIFIER`, the allowlist (`EXACT_KEYS` + `KEY_PREFIXES`, per the approved amendment), caps;
  - the `LegacyStore` enum (`WebKit { general, flat }` / `Chromium { leveldb }`) and `legacy_store()`, which picks paths per platform via `cfg`;
  - `read()`, which returns empty when no store exists;
  - `select()` (allowlist + caps), `ScratchDir` (0700, removed on drop), `copy_files` (regular files only, symlinks rejected, 100 MB budget), `utf16le`.
- `webkit.rs`:
  - `find_database`: both layouts, origin folders at a fixed depth, symlinks skipped, two app origins → `Ambiguous`;
  - `is_app_origin`: exact parse of the Phase 0 `origin` format; both origins must be `tauri`/`localhost`/no port, with no trailing bytes;
  - `read_items`: copies the db + `-wal` + `-shm`, opens the copy `SQLITE_OPEN_READ_ONLY`, decodes UTF-16LE values.
- `chromium.rs`:
  - copies the LevelDB directory (top-level regular files, without `LOCK`) and opens the copy with `create_if_missing: false`;
  - keeps only `_<origin>\0<name>` entries whose origin is exactly `http(s)://tauri.localhost`;
  - decodes the 0 = UTF-16LE / 1 = Latin-1 prefix.

  Compiled for Windows and for tests on every platform.

- `commands/legacy_web_storage.rs`:
  - thin async command; the read runs in `spawn_blocking`;
  - returns empty when `Distribution::supports_legacy_web_storage_import()` is false (App Store);
  - error → `LEGACY_STORAGE_UNREADABLE`;
  - logs counts / error kind only.
- Wiring: `distribution.rs` (new capability), `commands/mod.rs`, `main.rs` (module + handler).
- `Cargo.toml`: `rusty-leveldb = "=4.0.1"` (Windows target dependency + dev-dependency). `Cargo.lock` adds only `rusty-leveldb`, `crc32c`, `errno`, `errno-dragonfly`, `fs2`, `integer-encoding`; `snap` was already present.

**Frontend:**

- `src/lib/tauri/legacyWebStorage.ts` (wrapper, `CMD.legacyWebStorageRead`).
- `src/lib/legacyWebStorage.ts`, `restoreLegacyWebStorage({read, storage, timeoutMs})`:
  - marker check;
  - 3 s timeout;
  - writes only keys whose `getItem` is `null`;
  - marker after success;
  - attempts counter → marker after 3 failures;
  - unavailable storage → no-op;
  - if the marker can't be written, no reload, to avoid a loop.
- `src/main.tsx`: first step of `boot()` in the Tauri runtime; `"restored"` → `window.location.reload()`.

**Verification:**

- `cargo test legacy_web_storage` → 15 passed.
  - WebKit: exact origin parsing, including the real Phase 0 bytes and every truncation; WAL-only rows read with source db and WAL byte-identical after; dev origin ignored; two app origins → `Ambiguous`; flat layout; corrupt db → error; symlinked origin folder / flat file ignored.
  - Chromium: snappy tables + log entries, both encodings, the dev origin and `META:` ignored, lookalike origins rejected, unknown value encoding counted, `LOCK` present and the source directory byte-identical after; corrupt manifest → error; no `CURRENT` → `Open` (nothing created).
  - Shared: allowlist, caps, UTF-16 decoding, platform paths.
- **Real-store smoke** (`cargo test real_legacy_store_smoke -- --ignored --nocapture`, prints key names only): this Mac's ≤1.4 store → `entries=12 skipped=0`. That is the 12 allowlisted keys from Phase 0; the 6 dead/ephemeral keys were dropped.
- `cargo test` → 216 passed / 2 ignored. `cargo clippy --all-targets` → 8 warnings, identical to the `main` baseline. `--features app-store` clippy clean of new warnings.
- Vitest: `src/lib/legacyWebStorage.test.ts` 8 passed; full suite 117 files / 659 tests passed. `npm run build` OK; prettier clean.
- **Not verified:**
  - **Windows/Linux compile and run.** A local cross-check fails in third-party C builds (`ring` needs the Windows SDK headers), so CI is the first compile on those targets. Windows-only `cfg` branches were reviewed by hand (dead-code allowances added).
  - **R4's purge-path check.** `politedb.ai.chatOwners` exists only on the unmerged `feat/ai-agent` branch; on `main` restored chats are ordinary legacy chats.

**Manual run on this Mac** (user approved "chạy thử đi", 2026-10-14):

- **Build:** `npx tauri build --bundles app` (updater artifacts off), signed with Developer ID `B3X2G545LX`, `CFBundleIdentifier=PoliteDB`, not notarized. `main` differs from v1.5.2 only in CI files.
- **Backup first:** `~/politedb-webkit-backup-20261014/` holds copies of `~/Library/WebKit/politedb` and `~/Library/WebKit/com.politehq.politedb`, plus SHA-1s of the legacy files and key + value-hash listings of the `tauri://localhost` store before and after. No values were printed.
- **First launch:** the store went from 10 to 17 keys. Added:
  - 4 `politedb.ai.chat.tab-<id>`
  - `politedb.analytics.consent`
  - `politedb.connection-groups.v1`
  - the marker

  Every pre-existing key kept its value hash (`global-ai-assistant`, `provider.selected`, `install_date`, `pinned-connections`, `app-settings`, `welcome:seen`, `session_id`). Only `last_active_date` changed, as the app does on any launch. Dead keys (`ai.endpoint`, `ai.model`, `ai.model.seen`) were not restored.

- **Legacy store:** all 19 file SHA-1s are identical after the run.
- **Second launch:** the key/hash listing is identical to the first (no second import).
- **No UI screenshot:** a window capture fell back to a full-screen capture of unrelated apps. It was deleted unviewed for content and not repeated.

### Fixes for Codex review round 1 (Claude, 2026-10-14)

`.agent/REVIEW.md` "Review: legacy-webkit-storage Phase 1": CHANGES REQUIRED, 1 P1 + 3 P2. All fixed:

1. **P1, a throwing storage getter could abort startup.** `restoreLegacyWebStorage` now takes `storage: () => Storage` and calls it inside its guard. `main.tsx` passes `() => window.localStorage`. A throwing getter (`SecurityError`) → `"done"`, and boot continues. Regression: the unavailable-storage test now also throws from the getter itself.
2. **P2, one failed write ended the import and marked it complete:**
   - writes are now per entry, so a failing entry no longer stops later ones;
   - any failure → no marker; it goes through the bounded attempts policy (marker `gave-up` after 3);
   - written keys stay, and a reload happens when something was written;
   - reloads are finite, because every reload follows a new write and written keys are skipped next time;
   - a marker write failure also counts as an attempt.

   Regressions: first entry fails while the later one is written, then recovery on the next launch; give-up after 3 incomplete imports; marker-unwritable case does not loop.

3. **P2, parent symlinks bypassed the source check:**
   - `LegacyStore` variants now carry `root` (the `com.politehq.politedb` folder), and `real_dir_chain(root, path)` requires `root` and every folder down to `general`/`flat`/`leveldb` to be a real directory;
   - `find_database` takes the already-checked folders and also requires `inner/LocalStorage` to be a real directory.

   Regressions (unix): symlinked `inner/LocalStorage`, symlinked flat folder, symlinked `general`, symlinked store root (WebKit); symlinked leveldb folder (Chromium).

4. **P2, the smoke test printed key names.** It now prints only counts.

Also: the minor R3 deviation (web build did not set the marker) is resolved. The web build runs the same routine with an empty read, which sets the marker.

**Verification:**

- `cargo test` → 218 passed / 2 ignored (`legacy_web_storage`: 17 passed).
- `cargo clippy --all-targets` → 8 warnings, same as baseline.
- Vitest `legacyWebStorage.test.ts` → 10 passed (5 repeated runs).
- Full suite: 117 files / 661 tests passed. One run showed 1 failed test elsewhere; 3 later full runs passed. Recorded as flaky, unidentified, outside this change's files.
- `npm run build` OK; prettier clean.

## Plan Review

(Codex)
