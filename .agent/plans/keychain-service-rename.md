# Keychain Service Rename → `PoliteDB`

## Status

IMPLEMENTED

## Task

- ID: keychain-service-rename
- Requested 2026-10-14 by the user: profile credentials still show "Where: com.politehq.politedb" in Keychain Access; move them to `PoliteDB` with a migration ("viết plan đổi sang PoliteDB kèm migration đi").
- Plan file: `.agent/plans/keychain-service-rename.md` (`.agent/PLAN.md` still holds the Mac App Store plan; `.agent/plans/ai-agent.md` is in progress).
- Branch: `fix/keychain-service-rename` from `main` (independent of `feat/ai-agent`).
- Security-sensitive (keychain, data migration): Codex plan critique → user approval → implement → Codex review → Claude `/security-review`.
- Approved by the user on 2026-10-14 ("tôi duyệt, làm phase 1 đi") with D2a/D3a, after Phase 0. The user skipped the Codex plan critique; Codex still reviews the implementation, followed by Claude `/security-review`.
- No commit/push unless requested.

## Background (inspection 2026-10-14)

- Branded entries were added in `63e986e` (plan branded-keychain-entries). On macOS a recognized profile credential lives in one item:
  - service (Where) = `BRANDED_SERVICE = "com.politehq.politedb"` (`src-tauri/src/security/credential_identity.rs:38`)
  - label (Name) = `PoliteDB`
  - account = `<UPPERCASE-UUID>_profile` or `<UPPERCASE-UUID>_ssh`
- The constant's doc says "Bundle identifier from `tauri.conf.json`", but the bundle identifier is now `PoliteDB` (`src-tauri/tauri.conf.json:5`). Only the app data folder was migrated (`src-tauri/src/data_migration.rs`, `LEGACY_IDENTIFIER`); the keychain service was left behind.
- `CredentialStore` (`src-tauri/src/security/credential_store.rs`) already implements one migration hop: branded item first, then on a genuine not-found the pre-branding aliases under `LEGACY_SERVICE = "politedb"`, copied with `add_if_absent` (never overwrites), the legacy item retained. Delete removes the branded item plus every legacy alias; list merges both services into logical keys.
- Logical keys (`politedb/profile/<uuid>/credential/<purpose>` and the pre-branding spellings) are what profiles and the frontend persist. They do **not** change, so no profile file, export, or frontend change is needed.
- Non-macOS platforms use `keyring` with `LEGACY_SERVICE`; unchanged.
- Keychain access group is already `<TeamID>.PoliteDB` in both flavors (`entitlements.mac.plist`, `entitlements.appstore.plist`). The service attribute is independent of the access group, so neither flavor needs entitlement changes.
- AI provider keys and custom Keychain-screen keys use `LEGACY_SERVICE` (`politedb`) and are out of scope.

## Goal And Visible Result

- New and updated profile credentials are stored with Where = `PoliteDB` (Name `PoliteDB`, same account spelling).
- Existing credentials under `com.politehq.politedb` keep working with no prompt to re-enter passwords, and are moved to `PoliteDB`.
- Deleting a profile/credential removes it from `PoliteDB`, `com.politehq.politedb`, and every `politedb` legacy alias, so no stale copy can resurrect it.
- Keychain screen (list) shows each credential once.

## Requirements

### R1 Service constants

- `BRANDED_SERVICE = "PoliteDB"` (current).
- New `PREVIOUS_BRANDED_SERVICE = "com.politehq.politedb"` (read/migrate/delete only; never written).
- `LEGACY_SERVICE = "politedb"` unchanged.
- Fix the stale doc comments in `credential_identity.rs`, `credential_store.rs` and `secrets.rs`.
- The account spelling under `PREVIOUS_BRANDED_SERVICE` is parsed with the same `parse_branded_account` rules (only `<UPPERCASE-UUID>_profile|_ssh`; anything else is ignored).

### R2 Read path (`get`) — two-hop lazy migration

For a mapped key:

1. `get(BRANDED_SERVICE)` → found: return.
2. Genuine not-found → `get(PREVIOUS_BRANDED_SERVICE, upgrade_storage = false)` → found: migrate (R3).
3. Genuine not-found → existing legacy alias path (unchanged; migrates straight into `BRANDED_SERVICE`).
4. Any non-not-found error at any hop (access denied, locked, missing entitlement) is returned, never treated as not-found (same rule as today).

### R3 Migration from the previous branded service

- `add_if_absent(BRANDED_SERVICE, account, value, label)` with the existing semantics:
  - `Added` → value returned; then remove the previous item (see D2).
  - `AlreadyExists` → the new item is authoritative; re-read it (existing bounded handling, including "removed concurrently → not-found, never re-add").
  - add failed → previous item retained, value returned (credential stays usable).
- The previous item is never deleted unless the new item was `Added` by this call **and** a re-read of the new item returns exactly the copied value. A failed delete is logged (no account/value in the log) and not surfaced to the caller.

### R4 Delete

- Delete `BRANDED_SERVICE` item, `PREVIOUS_BRANDED_SERVICE` item, and all legacy aliases. First error surfaced (existing pattern).

### R5 List

- Merge well-formed accounts from `BRANDED_SERVICE` and `PREVIOUS_BRANDED_SERVICE` plus legacy accounts; the logical-key set collapses duplicates. A `list` error on the previous service is surfaced like the others.

### R6 Set

- Unchanged: writes only `BRANDED_SERVICE`. A stale previous-service item may remain until the next `get`/`delete` of that credential; `get` never reaches it because the new item answers first. (Optionally `set` also deletes the previous item best-effort; see D2.)

### R7 Concurrency

- Today's `get`-migrate vs `delete` race can resurrect a deleted credential: T1 reads a legacy value, T2 deletes everything, T1 `add_if_absent` re-creates it. A second hop widens that window.
- Serialize `CredentialStore` operations on mapped keys behind one process-wide `Mutex` in `secrets.rs::mac_store_call` (unmapped keys keep running unlocked). Keychain calls are short; a file-keychain ACL prompt holding the lock only delays other keychain calls.

### R8 Case-sensitivity gate (Phase 0)

`PoliteDB` and the legacy `politedb` differ only by case. If Keychain Services matched `kSecAttrService` case-insensitively for lookup or uniqueness, branded items and legacy custom keys shaped like `<UUID>_profile` would alias each other. Before any code change, a throwaway probe on this Mac (signed dev build, data-protection keychain **and** file keychain) must show:

- an item `(politedb, X)` is not found by `get(PoliteDB, X)`, and vice versa;
- adding `(PoliteDB, X)` while `(politedb, X)` exists returns success (not `errSecDuplicateItem`);
- deleting `(PoliteDB, X)` leaves `(politedb, X)` intact.

If any check fails, stop and return to the user with a different service string (for example `PoliteDB Credentials`); do not ship a case-only difference.

## Decisions

- **D1 Service string** — `PoliteDB` (user, 2026-10-14). Subject to the R8 gate.
- **D2 Old items after a successful copy** — **(a)** (user, 2026-10-14).
  - (a) **Recommended:** delete the `com.politehq.politedb` item after a verified copy (R3). Keychain Access stops showing the old Where, with no stale password copies. Cost: downgrading to an older build loses that credential (the old build cannot read `PoliteDB`); a pre-branding `politedb` alias, if present, would be re-migrated by the old build instead.
  - (b) Keep it, like the current legacy policy. Downgrade-safe, but the old entry stays visible and goes stale after a password change.
- **D3 When to migrate** — **(a)** (user, 2026-10-14).
  - (a) **Recommended:** lazy, on first `get` of each credential (connect/test/edit). No startup cost and no keychain prompts at launch. Profiles never opened keep the old item until opened.
  - (b) Lazy plus a one-time background sweep at launch over `list(PREVIOUS_BRANDED_SERVICE)`. Everything moves at once, but items that ended up in the file keychain (unsigned/dev builds, missing entitlement fallback) can show one macOS access prompt per item at launch.
- Legacy `politedb` profile aliases keep today's retain policy (out of scope).

## Files

- `src-tauri/src/security/credential_identity.rs`: constants, docs, tests.
- `src-tauri/src/security/credential_store.rs`: two-hop get, migrate-from-previous, delete, list; fake-keychain tests.
- `src-tauri/src/security/secrets.rs`: doc comment; process-wide lock for mapped keys (R7).
- Phase 0 probe: a throwaway `#[ignore]` test (`keychain_macos.rs`) run manually, using random accounts and cleaning up after itself; never touches real profile items.
- No frontend, profile, export, or non-macOS changes.

## Phases

- **Phase 0 — Probe (R8).** Run the case-sensitivity probe; record results here. Stop on failure.

### Phase 0 — Results (Claude, 2026-10-14)

Probe: a throwaway Swift tool in the session scratchpad (not in the repo). It mirrors the adapter's query (`kSecClassGenericPassword`, `kSecAttrSynchronizable=false`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` on the data-protection path), uses random accounts `politedb-probe-<uuid>_profile`, runs both orders (`politedb` first, then `PoliteDB` first), and deletes every item it creates. It never touches real profile items.

- **File keychain (login): PASS 14/14.** For both orders: `get` of the other case is `errSecItemNotFound`; `list` of one service excludes the other; adding the other case succeeds (no `errSecDuplicateItem`); values stay distinct; deleting one leaves the other intact.
- **Data-protection keychain: not runnable locally.** Unsigned or ad-hoc builds get `-34018` (missing entitlement). Builds signed with Developer ID plus `keychain-access-groups`, and an `.app` bundle with the MAS profile signed with Apple Distribution, are both killed at launch (exit 137, restricted entitlement without a matching provisioned run).
- **Which keychain real installs use:** the installed Developer ID build (`/Applications/PoliteDB.app`) carries the entitlement key `com.apple.security.keychain-access-groups` with the unexpanded literal `$(AppIdentifierPrefix)PoliteDB`. It has no effective `keychain-access-groups`, so the adapter's `-34018` fallback stores DMG credentials in the **file keychain**. This matches the user's screenshot (item with an Access Control tab). The file-keychain result therefore covers every existing DMG install.
- **Remaining gap:** only the MAS flavor uses the data-protection keychain, and it has not shipped, so no existing MAS items need migrating. The data-protection keychain stores attributes in a SQLite table with a unique index over the raw attribute values, so a case-sensitive match is expected, but this is unverified. Gate: before the first MAS release, rerun the probe inside a TestFlight/sandbox build (`.agent/PLAN.md` Phase 4/5). If it fails there, change `BRANDED_SERVICE` before MAS ships.
- **Out of scope:** the unexpanded DMG entitlement noted above. It is not changed by this plan.

Verdict: **R8 gate passed for the file keychain (all current users). Data-protection keychain deferred to the MAS release gate.** Phase 1 may proceed once the plan is APPROVED.

- **Phase 1 — Implement R1–R7** on `fix/keychain-service-rename`.

## Verification

- Unit tests (fake keychain), at least:
  - get: new hit; previous hit → copied, previous removed (D2a) only after verified re-read; previous hit + add fails → value returned, previous kept; previous hit + `AlreadyExists` → new value wins; previous read access-denied → error, no legacy fallback; previous not-found → legacy path still migrates into `PoliteDB`; previous delete failure → value still returned.
  - delete removes all three namespaces; error in any is surfaced.
  - list collapses items present in both branded services and legacy into one logical key; malformed accounts under the previous service ignored.
  - set never writes the previous or legacy service.
  - `<UUID>_profile` custom key under `politedb` stays a custom key (regression).
  - delete racing a migrating get cannot resurrect (lock).
- `cargo test` (security modules), `cargo clippy`, `npm run build`.
- Manual on this Mac (signed `tauri:dev` build), with a throwaway profile:
  1. On `main`, save a password → Keychain Access shows Where `com.politehq.politedb`.
  2. Switch to the branch, connect → works without prompt; Keychain Access shows Where `PoliteDB`; old entry gone (D2a).
  3. Change the password → only the `PoliteDB` entry changes.
  4. Delete the profile → no entry left in any service.
  5. Keychain screen lists the credential once before and after migration.
- MAS flavor: same steps 1–2 on an `appstore` dev build if the signing assets are available; otherwise record as a limitation.

## Risks

- Case-only service difference (R8 gate).
- Downgrade after D2a loses migrated credentials (old build reads only the old service). Acceptable for a desktop app with forward-only updates.
- A credential stored only in the file keychain may show one macOS access prompt when first migrated (existing behavior for legacy items).
- Never log accounts, service values combined with profile ids, or secret values.

### Phase 1 — Implementation evidence (Claude, 2026-10-14)

Branch `fix/keychain-service-rename` (from `main` @ `b74100b`), uncommitted.

- `credential_identity.rs`: `BRANDED_SERVICE = "PoliteDB"`, new `PREVIOUS_BRANDED_SERVICE = "com.politehq.politedb"`, docs fixed (the stale "bundle identifier" comment, the case-sensitivity note referencing Phase 0).
- `credential_store.rs`:
  - `get`: new → previous (`upgrade_storage=false`) → legacy aliases. Non-not-found errors stop at the hop that raised them.
  - `migrate` now also reports whether this call added the branded item. The legacy path ignores that flag; the previous path then calls `retire_previous`, which re-reads the branded item and deletes the previous item only on an exact match. Otherwise, or on a failed delete, it logs a fixed message (no account/value) and keeps the item.
  - `set`: writes the new service, then deletes the previous-service item best-effort (D2a hygiene; R6 option taken). Unmapped keys unchanged.
  - `delete`: new + previous + legacy aliases, first error surfaced.
  - `list`: merges both branded services and legacy.
- `secrets.rs`: process-wide `MAC_STORE_LOCK` around every `mac_store_call` (R7). **Deviation:** it covers all keys, not only mapped ones. It is simpler, `keychain_delete_if_present` is still two separate calls, and unmapped calls are as short as mapped ones.
- `keychain_macos.rs`: new ignored native smoke `native_previous_service_migration_smoke`. It seeds a previous-service item plus a same-account custom item under `politedb`, then checks migration to `PoliteDB` with the label, removal of the previous item, that the custom item stays intact, and that delete cleans up. Cleanup covers all three services.

Verification:

- `cargo test security::` → 59 passed, 2 ignored (13 new fake-keychain tests: previous-only migrate + retire; preferred over legacy; previous not-found → legacy into the new service; previous read error surfaced with no legacy read; copy failure keeps previous; copy race keeps the newer value and previous; unverifiable copy (changed value / access denied) keeps previous; previous delete failure still returns the value; set removes stale previous and tolerates cleanup failure; custom key set never touches previous; delete across services + previous failure surfaced; list collapses services and ignores malformed accounts; list error on the previous service surfaced). All existing tests unchanged and passing.
- `cargo test --locked native_ -- --ignored` on this Mac → both native smokes pass (file keychain, the path DMG installs use).
- `cargo test` → 214 passed / 0 failed / 2 ignored. `cargo clippy --all-targets` → 8 warnings, identical to the `main` baseline (none in changed code).
- No frontend change, so `npm run build` was not needed.
- **Not done:**
  - The manual app round-trip (main build → branch build with a throwaway profile). The native smoke exercises the same store and adapter against the real login keychain.
  - A threaded test for `MAC_STORE_LOCK`: the fake keychain is `RefCell`-based, so the lock is covered by inspection only.
  - Data-protection keychain: deferred to the MAS release gate (Phase 0).

- Claude `/security-review` (2026-10-14): no findings. Codex implementation review not yet done; committed on the user's request ("commit keychain trước đi").

### Codex review P2 fix (Claude, 2026-10-14)

Codex review "keychain-service-rename Phase 1": VERIFIED WITH LIMITATIONS, with one P2: no regression proved the R7 lock. The user chose to fix it ("chọn a, thêm test rồi commit").

- The lock moved from `secrets.rs` into `credential_store::serialized(port, f)`: a process-wide `STORE_LOCK` held for the whole store operation. `mac_store_call` now calls it, so production and tests share one synchronization boundary. Behavior is unchanged.
- New `tests::concurrency` with a thread-safe fake (`SyncKeychain`):
  1. a `get` that migrates from `com.politehq.politedb` (and, in a second test, from a legacy `politedb` alias) pauses right after reading the old value;
  2. a `delete` through another alias of the same credential starts meanwhile; the test asserts it is still blocked after 150 ms;
  3. the migration is released;
  4. the test asserts the delete then removed every namespace and later `get`s through both aliases return not-found.
- Mutation check: with the lock replaced by a no-op, both tests fail (delete not blocked). With the lock restored, both pass.
- `cargo test` → 216 passed / 2 ignored (`security::` 61 passed). `cargo clippy --all-targets` → 8 warnings, same as baseline.

## Plan Review

(Codex)
