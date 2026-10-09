# Branded Keychain Entries Review

## Status
VERIFIED WITH LIMITATIONS

## Task
- ID: branded-keychain-entries
- Scope: .agent/PLAN.md

## Findings

Re-review: no remaining actionable findings in the two P2 fixes. Findings below are retained as resolved history, not pending work.

## Resolution
- Custom physical account spellings no longer map to profile credentials. Listed branded items use a distinct logical profile reference; tests cover list/get/set/delete for custom and profile entries coexisting under the same UUID/purpose.
- Migration returns Result and propagates authoritative reread errors after AlreadyExists. Tests simulate a concurrent writer, denied/locked rereads, and concurrent deletion without retry or resurrection.

### P2 - Existing custom accounts can alias branded credentials
- Location: src-tauri/src/security/credential_identity.rs:176; src-tauri/src/security/credential_store.rs:169.
- Before this change arbitrary custom keys were stored under service `politedb`. A custom key shaped as an uppercase UUID plus `_database` or `_ssh` now maps to the branded service. `list()` still returns the legacy custom account, but `get()` searches only recognized legacy profile aliases, not that exact custom account. `delete()` likewise leaves it behind, and `set()` can overwrite an unrelated profile credential with the same UUID/purpose.
- Preserve namespace identity for pre-existing custom keys; do not infer profile ownership solely from the physical account spelling. Keep listed keys round-trippable without colliding with profile credentials.
- Regression: legacy custom uppercase UUID account alone, then coexistence with a profile credential of the same UUID/purpose; verify list/get/set/delete preserve both independently.

### P2 - Migration race swallows branded read errors and returns stale secret
- Location: src-tauri/src/security/credential_store.rs:198-202.
- If the initial branded read misses but another writer creates it before `add_if_absent`, `AlreadyExists` establishes that the branded credential is authoritative. The subsequent `unwrap_or(legacy_value)` hides access-denied/locked/OS errors and returns the older password, potentially failing reconnect or authenticating with stale credentials. The current race test explicitly expects this stale result rather than checking the required behavior.
- Return a Result from migration; after AlreadyExists propagate non-not-found errors instead of falling back to the legacy password. Specify bounded handling for a concurrent deletion separately; retain legacy on failed persistence.
- Regression: a real simulated interleaving with a successful authoritative reread, plus access-denied and locked rereads after AlreadyExists; errors must propagate and newer values must never be overwritten.

## Verification
- `cargo check --locked`: passed.
- `cargo test --locked`: 125 passed; 1 native smoke test ignored, including P2 and current-only suffix regression tests (Codex rerun, 2026-10-06).
- `git diff HEAD --check`: passed.
- Review was code-based; no real customer Keychain values accessed. Native macOS smoke, signed build access policy, Windows/Linux execution not verified.

## Next Step
Final amendment reviewed: physical parser accepts only `_profile` / `_ssh`; previous suffix helpers and branded old-account get/migrate/delete/list support are removed. Remaining old-suffix literals occur only in negative or custom-key independence tests. Logical credential/database and original legacy profile aliases remain unchanged. No new actionable findings in the reviewed scope. Old branded-only credentials will not resolve, as explicitly requested. Native smoke not rerun by Codex; signed access policy and Windows/Linux execution remain unverified. No commit/push.
