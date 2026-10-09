# Branded Keychain Entries With Legacy Compatibility

## Status

IMPLEMENTED

## Task

- ID: branded-keychain-entries
- Requested 2026-10-05 from PoliteDB/TablePlus Keychain Access screenshots.
- User approved implementation with "implement di" on 2026-10-05.
- Codex plans/reviews; Grok implements after approval under WORKFLOW.md.
- Proposed branch: fix/branded-keychain-entries.
- Previous task evidence archived in .agent/archive/standalone-table-export/2026-10-05/.
- No commit/push unless requested.

## Goal And Visible Result

macOS application-password items should show:

- Name (label): PoliteDB.
- Where (service): com.politehq.politedb, verified from tauri.conf.json.
- Account for profile database credential: uppercase canonical UUID + \_profile.
- Account for SSH password: same UUID + \_ssh.
- Kind remains application password.
- Do not change access-control policy, synchronization, accessibility, or keychain backend merely to mimic the screenshot.

## Current Code

- security/secrets.rs uses hard-coded service "politedb"; macOS uses custom Security-framework adapter.
- security/keychain_macos.rs create/update omit an explicit label.
- Frontend lib/tauri/profile.ts produces politedb/profile/<id>/<engine>/db_password and politedb/profile/<id>/ssh_password.
- Backend engines/profile_secrets.rs produces profile:<id>:<engine>:password.
- profiles/sharing.rs recognizes local reference prefixes; inspect its import/remap behavior before changing references.
- Other secrets use these shared APIs. Inventory AI/provider/license/custom keys and frontend keychain list/get/delete consumers; do not silently rename unrelated secrets.

## Scope And Architecture

- Central typed credential identity/mapping at the backend boundary. Reuse it for set/get/delete/list; avoid frontend/backend parallel naming rules.
- Preserve existing logical SecretRef values and generic secret API compatibility where possible; map recognized profile keys to the new physical macOS account rather than rewriting every stored profile.
- Map only well-formed recognized profile database/SSH keys; validate UUID and credential purpose. Custom keys stay distinct.
- Verify multiple credential purposes per profile cannot collide. If inventory finds multiple independent database secrets under one UUID, retain a purpose suffix that distinguishes them instead of overwriting.
- New macOS profile writes use branded service and explicit PoliteDB label. Set label at creation and update.
- Windows/Linux physical naming remains unchanged for this macOS presentation task.
- Keep export/import remapping of local profile secret references working.

## Compatibility And Migration

- Read new physical item first, then exact recognized legacy service/account variants only on genuine not-found.
- Never treat access denied, locked keychain, entitlement or OS failures as not-found.
- If legacy read succeeds, attempt idempotent write to the new item. Never delete the old item unless new persistence is confirmed; retain legacy on failed migration.
- Do not overwrite an existing new credential with an older legacy value.
- Profile UUID/ref and persisted connection records must remain usable without re-entering passwords.
- List merges branded/legacy entries with deterministic logical references and no duplicates; existing Keychain screen must still retrieve and delete the listed entry.
- Delete handles recognized branded and legacy counterparts so deletion cannot resurrect a stale password through fallback. Surface real failures instead of claiming success.
- Retain existing data-protection/legacy-keychain fallback, but compose it with service/account migration deliberately.
- No broad startup scan reading every password; migrate lazily on use or explicit save.
- Do not read real user keychain values as agent verification.

## Security

- No raw credentials, account IDs, SQL, profile data or paths in logs/telemetry.
- Preserve existing secrets validation and native access-control behavior.
- Changing display metadata does not grant additional keychain access.

## Verification

- Mapping tests for both known database prefixes, SSH, invalid UUIDs, custom keys and purpose collision cases.
- Adapter/service tests using a fake keychain port: new-only, legacy-only, both entries, migration-write failure, not-found vs access-denied, repeated migration.
- List/get/delete compatibility, no stale resurrection, failure paths.
- Profile create/edit/reconnect, import/export local-ref remapping and SSH credential regression tests.
- cargo check --locked and relevant Rust tests; npm run build and relevant profile/keychain tests if frontend contracts change.
- Disposable native macOS credential smoke: verify Name/Account/Where in Keychain Access, read/update/delete; never use an existing customer password.
- Document Windows/Linux verification limitations and any unavailable native keychain check honestly.

## Implementation Evidence (Grok, 2026-10-05)

Branch: fix/branded-keychain-entries (from main 6b3750d). Uncommitted; no push.

Files:

<!-- prettier-ignore -->
- `src-tauri/src/security/credential_identity.rs` (new): typed ProfileCredential `{profile_id, purpose: Database|Ssh}`; constants BRANDED_SERVICE=com.politehq.politedb, BRANDED_LABEL=PoliteDB, LEGACY_SERVICE=politedb; parses politedb/profile/<uuid>/<engine>/db_password, politedb/profile/<uuid>/ssh_password, profile:<uuid>:<engine>:password, and the branded account `<UPPERCASE-UUID>_database|_ssh`. Canonical hyphenated UUID only; engine segment `[a-z0-9_]+`; everything else (AI keys `politedb:ai:*`, custom keys) is unmapped.
- src-tauri/src/security/credential_store.rs (new): KeychainPort trait + CredentialStore set/get/delete/list (compat/migration rules below) with fake-port tests.
- src-tauri/src/security/keychain_macos.rs: explicit kSecAttrLabel on create and update; add-only add_password_if_absent; get_password_with(upgrade_storage, label) so legacy-service reads skip the old file->data-protection copy; MacKeychain port adapter; ignored native smoke test. Access control/accessibility/sync/data-protection fallback unchanged.
- src-tauri/src/security/secrets.rs: macOS keychain_set/get/delete/list delegate to CredentialStore<MacKeychain>; Windows/Linux keyring path unchanged (service still "politedb").
- src-tauri/src/security/mod.rs: register modules (dead_code allowed off-macOS, where mapping is test-only).
- No frontend, profile-store, or SecretRef changes: persisted refs stay as-is and are mapped at the backend boundary.

Inventory: a profile owns one database credential and one SSH password. Frontend and backend database key formats are aliases of that same credential, so both map to <UUID>\_database (no independent DB secrets found per UUID); SSH maps to <UUID>\_ssh. Other keychain consumers (AI provider keys, Keychain screen custom keys, cassandra/mongo/secrets_util/sharing via keychain_get) keep working through the same API.

Compatibility behavior:

- get: branded item first; only on genuine KEYCHAIN_ITEM_NOT_FOUND read the exact legacy alias (legacy-form key -> same key under "politedb"; branded-form key -> legacy aliases found by listing account names, no value reads). Other errors (access denied, locked, entitlement, OS) are returned. Legacy hit -> add-only write to branded item with label; if it already exists the branded value wins; write failure still returns the legacy value. Legacy items are retained (never deleted on migration). Lazy only; no startup scan.
- set: recognized keys write branded item + label; custom keys unchanged.
- delete: branded item + exact key + all listed legacy aliases of the same credential; all attempted; first failure surfaced; missing = success.
- list: branded accounts + legacy entries collapsed to <UUID>\_purpose, plus unmapped custom keys; sorted, deduped; each listed key round-trips through get/delete.
- Export/import: sharing.rs untouched; it resolves refs through keychain_get, so remap/redaction behavior is unchanged (existing sharing tests pass).

Verification run:

- cargo check --locked: clean, no warnings.
- cargo test --locked: 111 passed, 0 failed, 1 ignored (native smoke). New: 11 identity tests (both DB prefixes, SSH, invalid UUIDs, custom/AI keys, purpose and profile collisions, branded round-trip) and 20 store tests (new-only, legacy-only, both, migration race, migration-write failure, repeated migration, access denied branded/legacy, exact-alias-only fallback, list merge/dedupe, listed legacy entry get/delete, delete with no resurrection, delete failure and list-failure surfacing, create/edit/reconnect cycle).
- cargo test --locked native_branded_credential_smoke -- --ignored: passed with a fresh random UUID and throwaway value. `security find-generic-password` showed class genp, label PoliteDB, svce com.politehq.politedb, acct <UPPERCASE-UUID>\_database; read, update (label kept), delete verified. No existing credential values were read.
- npm run build: passed. npx vitest run profileSharing.test.ts engineFormConfig.test.ts: 7/7 passed.

Limitations / notes for review:

- The test binary is unsigned, so the native smoke ran against the login (file) keychain via the existing missing-entitlement fallback, not the data-protection keychain. Keychain Access GUI was not opened; attributes were checked with `security`. A signed-app check (create/edit profile, reconnect, Keychain screen) is still recommended.
- Windows/Linux: naming intentionally unchanged; only compiled/tested on macOS here.
- First native smoke run failed on an assertion-format issue before cleanup existed and left one throwaway item: service com.politehq.politedb, account EA051829-7F4B-4C82-BACF-126D3D7CAAAA_database, label PoliteDB (dummy value). Deleting it via CLI was blocked by safety review; the user can remove it in Keychain Access.
- Found a pre-existing older item on this Mac under service com.politehq.politedb with legacy-style account profile:<uuid>:postgres:password (created 2026-01-04). Current main never read it; this implementation also neither reads, lists, nor deletes it (not treated as a recognized legacy variant to avoid reviving a stale password). Codex: decide whether it should become a fallback variant.

## Review Fix Evidence (Grok, 2026-10-05)

Fixes for both REVIEW.md P2 findings (user approved: "fix not P2 di"). Still uncommitted on fix/branded-keychain-entries; no push.

P2-1 Custom accounts aliasing branded credentials:

- credential_identity.rs: map_key no longer accepts the physical branded account spelling (<UPPERCASE-UUID>\_database|\_ssh). Such keys are custom keys under the legacy "politedb" service, as before branding.
- Branded items are listed under a new logical key in the app-owned profile namespace: politedb/profile/<lowercase-uuid>/credential/database|ssh (ProfileCredential::branded_logical_key, parse_branded_logical_key; exact canonical spelling required for round-trip). Physical account/label/service unchanged.
- credential_store.rs list: branded accounts -> logical key; legacy recognized profile keys -> logical key; everything else (including UUID-shaped custom accounts) listed as-is and routed to the legacy service on get/set/delete.
- Visible effect: the Keychain screen now shows politedb/profile/<uuid>/credential/... for profile credentials instead of <UUID>\_database. No frontend code change needed (keys are opaque strings).

P2-2 Migration race:

- migrate() now returns Result. Added -> legacy value. AlreadyExists -> branded item is authoritative: re-read value returned; access-denied/locked/OS errors propagated (no legacy fallback). AlreadyExists then not-found on re-read (concurrent delete) -> KEYCHAIN_ITEM_NOT_FOUND, bounded: no retry and no re-add from legacy, so a delete cannot be resurrected. Add failure -> legacy value returned, legacy retained (unchanged).

Regression tests (fake port gained before_add/after_add hooks for real interleavings and an add-call counter):

- migration_race_returns_authoritative_branded_value (concurrent writer between miss and add; newer value returned and never overwritten).
- migration_race_propagates_access_denied_reread, migration_race_propagates_locked_reread (-25293 / -25308 after AlreadyExists propagate; newer branded and legacy retained; one add call).
- migration_race_concurrent_delete_returns_not_found_without_readding.
- legacy_custom_uuid_shaped_account_alone_round_trips_in_legacy_namespace (list/get/set/delete stay in legacy service; no branded item created).
- legacy_custom_uuid_shaped_accounts_coexist_with_profile_credentials (DB + SSH; list/get/set/delete independent both directions).
- legacy_custom_uuid_shaped_account_coexists_with_legacy_profile_items (migration does not merge them).
- listed_branded_entry_round_trips_through_logical_key; identity tests physical_branded_account_is_not_a_logical_profile_key, branded_logical_key_round_trips, branded_logical_key_requires_canonical_spelling.
- Replaced the old migration_race_keeps_existing_branded_value test (it asserted the stale-legacy result).

Verification:

- cargo check --locked: clean, no warnings.
- cargo test --locked credential\_: 40 passed, 0 failed, 1 ignored (native smoke).
- cargo test --locked: 120 passed, 0 failed, 1 ignored.
- cargo fmt --check on security/\*.rs: clean.
- Native smoke not re-run (set/get/delete path for recognized keys unchanged); npm build/vitest not re-run (no frontend change).

## Next Step

Grok implements the approved suffix amendment below, then Codex reviews. No commit/push unless requested.

## Approved Amendment: Profile Account Suffix

- SUPERSEDED for old physical-account compatibility by the final amendment below; do not implement the `_database` fallback requirements in this section.
- User requested replacing physical `_database` with `_profile` on 2026-10-06.
- Change only the physical macOS database-credential account suffix. Keep service/label, `_ssh`, existing logical SecretRefs and logical `credential/database` keys unchanged; do not change Windows/Linux naming.
- Read `_profile` first. On genuine not-found, fall back to `_database` under the branded service, then the existing legacy service aliases. Preserve real errors and the authoritative reread behavior from the P2 fix.
- Migrate old branded `_database` lazily using add-only persistence; never overwrite an existing `_profile` or delete the old value on failed persistence.
- List both physical spellings as one logical database credential; listed keys must round-trip. Delete recognized credentials from both branded spellings and legacy profile aliases, surfacing failures. Custom keys spelled `<UUID>_database` or `<UUID>_profile` under `politedb` must remain independent.
- Keep physical account parsing separate from logical key parsing; do not repurpose the logical purpose suffix when changing the physical suffix.
- Regression tests: new-only, old branded-only, old/new coexistence (new wins), failed migration, denied/locked reads, migration race, list deduplication, delete/no resurrection, custom-key collision independence, SSH unchanged.
- Update disposable native smoke expected account and source comments; do not access real customer secrets.
- Verify cargo check --locked, full cargo test --locked and diff check; record evidence in this plan.

## Amendment Implementation Evidence (Grok, 2026-10-06)

`_profile` physical suffix implemented on fix/branded-keychain-entries. Unstaged on top of the earlier staged work; no commit/push.

Changes:

- credential_identity.rs: CredentialPurpose now keeps the logical suffix (`logical_suffix`: database|ssh, used only for `politedb/profile/<uuid>/credential/<purpose>`) separate from the physical account suffix (`account_suffix`: profile|ssh) and a read-only `previous_account_suffix` (Database -> `database`, Ssh -> none). `branded_account()` writes `<UPPERCASE-UUID>_profile`; new `previous_branded_account()` gives `<UPPERCASE-UUID>_database`. `parse_branded_account` accepts both physical spellings (same credential); logical parsing unchanged, so `credential/profile` is not a logical key. Physical spellings are still never accepted by map_key.
- credential_store.rs: get reads `_profile`; only on genuine not-found reads `_database` under the branded service (no storage-upgrade copy), then the existing legacy-service aliases. Real errors from either read propagate. An older hit goes through the same add-only migrate() into `_profile` (AlreadyExists -> authoritative reread with error propagation; concurrent delete -> not-found, no re-add; add failure -> older value returned, older item retained). set writes only `_profile`. delete removes `_profile`, `_database`, and legacy aliases, surfacing the first failure while attempting all. list collapses both branded spellings to the unchanged logical `credential/database` key.
- keychain_macos.rs: native smoke expects `<UUID>_profile`. secrets.rs: doc comment updated. Service/label, `_ssh`, SecretRefs, logical keys and Windows/Linux naming unchanged.

New regression tests (store): set_writes_profile_suffix_not_previous_spelling, get_new_profile_only_does_not_read_previous_spelling, get_old_branded_only_migrates_to_profile_and_retains_old (fe/be/logical keys), get_old_and_new_branded_prefers_profile_and_never_overwrites_it, old_branded_is_preferred_over_legacy_service, old_branded_migration_failure_returns_value_and_retains_old, access_denied/locked_on_old_branded_is_surfaced_without_legacy_fallback, old_branded_migration_race_returns_authoritative_profile_value, old_branded_migration_race_propagates_locked_reread, old_branded_migration_race_concurrent_delete_is_not_resurrected, repeated_old_branded_migration_reads_only_profile_afterwards, list_dedupes_both_branded_spellings_and_legacy, listed_old_branded_only_entry_round_trips, delete_removes_both_branded_spellings_and_legacy_no_resurrection, delete_surfaces_old_branded_failure_and_still_attempts_others, ssh_never_reads_or_deletes_database_spellings, legacy_custom_keys_with_both_database_spellings_stay_independent. Identity: previous_database_account_parses_to_same_credential, ssh_account_is_unchanged_and_has_no_previous_spelling, plus `_profile` cases in existing custom/lowercase/shape/logical-spelling tests. Existing tests now expect `_profile`; access_denied_on_branded test also asserts no `_database` read; migration_race_returns_authoritative_branded_value now counts reads of the `_profile` item only (the extra `_database` miss is expected).

Verification:

- cargo check --locked: clean, 0 warnings.
- cargo test --locked: 140 passed, 0 failed, 1 ignored (native smoke).
- cargo test --locked credential\_: 60 passed, 1 ignored.
- rustfmt --check on security/\*.rs: clean. git diff --check: clean.
- cargo test --locked native_branded_credential_smoke -- --ignored: passed (fresh random UUID, throwaway value; account `<UUID>_profile`, label PoliteDB, service com.politehq.politedb; read/update/delete). Same unsigned-binary limitation as before (login keychain via fallback). No real credentials read.
- npm build/vitest not re-run (no frontend change).

## Final Approved Amendment: Remove Previous Physical Suffix

- User explicitly requested removing the `_database` suffix and everything supporting it on 2026-10-06. This overrides the previous compatibility amendment.
- Physical branded accounts support only uppercase UUID + `_profile` (database credential) or `_ssh`. Remove previous_account_suffix, previous_branded_account, old physical parser acceptance, branded old-account fallback/migration, list dedup logic for the previous spelling, and delete operations for that spelling.
- Remove obsolete old-branded test helpers/cases and comments. Retain tests for `_profile`, `_ssh`, custom namespace independence, legacy logical profile aliases, error propagation, and migration races from the original `politedb` service.
- Keep logical `credential/database`, Database purpose, db_password and existing frontend/backend logical SecretRefs unchanged. These are not the removed physical suffix. Keep Windows/Linux unchanged.
- Do not delete or read existing real Keychain items as part of implementation. Old branded-only items are no longer resolved; the user may re-save their password if needed. No bulk destructive Keychain cleanup.
- Update active documentation to describe current-only physical suffix support; historical implementation evidence may remain historical, not active requirements.
- Verify cargo check --locked, full cargo test --locked, diff check, and focused search proving production identity/store code contains no previous physical-suffix compatibility paths. Record results; Codex reviews. No commit/push.

## Final Amendment Implementation Evidence (Grok, 2026-10-06)

Previous `_database` physical-suffix support removed on fix/branded-keychain-entries. Uncommitted; no push.

Changes:

- credential_identity.rs: removed `previous_account_suffix` and `previous_branded_account`; `parse_branded_account` accepts only `<UPPERCASE-UUID>_profile` / `_ssh`. Module/function docs describe current-only physical spellings. Logical `credential/database`, Database purpose, db_password and frontend/backend SecretRefs unchanged.
- credential_store.rs: removed `get_previous_and_migrate`; get reads `_profile|_ssh` then (on genuine not-found) the exact legacy `politedb` aliases with the unchanged add-only migrate (authoritative reread, error propagation, no resurrection). delete removes only the branded item plus legacy aliases. list comment/dedup describes branded + legacy only. Docs/warning text say "legacy" instead of "older/previous".
- Tests: removed `old_branded_db` helper and all old-branded cases (17 store tests, 2 identity tests). Added identity `profile_account_parses_to_database_credential`, `ssh_account_parses_to_ssh_credential`, `database_suffix_is_not_a_branded_account`; store `database_suffix_under_branded_service_is_ignored` (a branded `<UUID>_database` item is never read, migrated, listed or deleted; no bulk cleanup) and `legacy_custom_database_and_profile_spellings_stay_independent`. Retained `_profile`/`_ssh`, custom namespace independence, legacy alias, error propagation and legacy-service migration race tests.
- keychain_macos.rs / secrets.rs already reference only `_profile|_ssh`; no change. No real Keychain items read or deleted.

Verification:

- cargo check --locked: clean, 0 warnings.
- cargo test --locked: 125 passed, 0 failed, 1 ignored (native smoke).
- cargo test --locked credential\_: 45 passed, 1 ignored.
- rustfmt --check on security/\*.rs: clean. git diff --check: clean.
- Focused search: production (non-test) sections of credential_identity.rs and credential_store.rs contain no `_database`, `previous` or `old_branded` references; remaining `_database` mentions are only in the negative/custom-key tests above.
- Native smoke not re-run (native adapter unchanged since the `_profile` run). npm build/vitest not re-run (no frontend change).
