# Subscription Renewal Dates (live lookup)

## Status

IMPLEMENTED

## Task

- ID: subscription-renewal
- Requested 2026-10-19; redesigned 2026-10-20. Pro is sold as a **yearly Polar subscription**. Polar leaves `expires_at` empty on subscription license keys, so the app cannot show a date. Show the renewal or end date in the app and the license email.
- Approved by the user on 2026-10-20 ("duyệt"). Pre-existing fallback work is folded into the new branches.
- User decisions 2026-10-20: no Manage subscription button; entitlement stays **license-key only**, and renewal info is looked up **live from Polar** when needed, **with nothing stored**: no new tables and no subscription webhooks.
- The earlier DB-sync design (Codex READY at Revision 4) is archived at `.agent/archive/subscription-renewal/plan-revision-4-db-sync.md`. Its mapping, copy, deadline and privacy rules are reused here; its storage, webhook, ordering and race sections are dropped.
- Repos and branches:
  - backend `politedb-backend`, branch `feat/subscription-renewal` from `feat/polar-sdk-1` (base `c0a50f4`);
  - app `politedb-app`, branch `feat/subscription-renewal` from `feat/pro-gating` (base `9d7cf53`).
- Pre-existing uncommitted work on both repos: the "Renews with your subscription" fallback text.
  - backend files: `src/services/license-email.ts`, `src/services/polar-service.ts`, `test/license-email.test.ts`, `test/polar-service.test.ts`;
  - app files: `LicenseKeySettings.tsx`, `LicenseKeySettings.trial.test.tsx`.
  - It is committed separately only when the user asks.
- Workflow: Claude implements after approval; Codex reviews each phase; `/security-review` afterwards (license scope). No commit/push unless the user asks.

## Goal And Visible Result

- Settings → License key and the License dialog show one row:

  | Case | Label | Value |
  |---|---|---|
  | Key has a valid `expires_at` (one-time key) | Expires at | `<date>` with `(in N days)`, `(today)` or `(expired N days ago)` (today's behaviour) |
  | Key `expires_at` unparseable | Expires at | Unknown |
  | `active` | Renews on | `<date>` (in N days / today) |
  | `trialing` | First payment | `<date>` (in N days / today) |
  | `canceled` | Ends on | `<date>` (in N days / today) |
  | `pausing` | Pauses on | `<date>` |
  | `paused` | Status | Paused |
  | `incomplete` | Status | Payment pending |
  | `past_due` | Payment | Past due. Update your payment method |
  | `ended` with date | Ended on | `<date>` |
  | `ended` without date | Status | Ended |
  | known status, required date missing or unparseable, or a stale app state with a past `renews_at` | Status | Renews automatically / Canceled / … (status words, no date) |
  | `subscriptionStatus` null (nothing known) | Renewal | Renews with your subscription |

- No Manage subscription button (user decision 2026-10-20). Customers keep using the existing "Lost license key?" portal link (Direct) and Polar's own emails.
- The license email shows the same rows, with UTC dates ("October 19, 2027") and no "(in N days)".
- **Entitlement is unchanged.** Pro still depends only on the license key:
  - `status == "active"`;
  - Polar's `expires_at`;
  - revocation through `benefit_grant.revoked` / validate 404.

  Renewal data is display only and never locks or unlocks Pro. Offline behaviour is unchanged (former D8, out of scope).

## Baseline (inspected 2026-10-19/20)

- Backend:
  - activate/validate are in `src/services/polar-license-key.ts`: `mapActivationResponse` at :118-143, `mapValidatedResponse` at :145-174, the validate-404 branch at :458-477;
  - the trusted key objects expose `id`, `customer_id`, `benefit_id` (`ValidatedLicenseKey`, `GrantedLicenseKey` in SDK `models-P8aaHkKR.d.mts:21697-21774`, :12613-12686);
  - the license email is sent in `sendLicenseEmailForGrant` (`src/services/polar-service.ts:107-139`): claim → `licenseKeys.get` → send. `LicenseKeyRead` also has `customer_id` and `benefit_id`.
- SDK 2026-10:
  - `benefitGrants.list({ organization_id, customer_id, is_granted, page, limit })` returns `{ items, pagination: { total_count, max_page } }` and needs scope `benefits:read`;
  - `BenefitGrant` has `subscription_id`, `customer_id`, `benefit_id`, `benefit.type` and `properties.license_key_id`;
  - `subscriptions.get(id)` needs `subscriptions:read`. `Subscription` has `status`, `current_period_end`, `cancel_at_period_end`, `pause_at_period_end`, `ends_at`, `ended_at`, `trial_end` and `customer_id`;
  - `RequestOptions.timeout` is in seconds.
- Shared Polar client: `src/libs/polar.ts`, 15 s per call.
- App:
  - `src-tauri/src/license.rs`: `LicenseApiResponse` at :183-209 (snake_case with camelCase aliases, unknown keys ignored), `LicenseState` at :54-103, `normalize_api_state` at :777-853, `entitlement` at :353-385;
  - the app's HTTP limit is 15 s per attempt and 30 s per operation (:25-28);
  - the expiry row is duplicated in `LicenseKeySettings.tsx:150-172` and `LicenseDialog.tsx:197-210`;
  - `LICENSE_PORTAL_URL` is in `src/lib/license/proAccess.ts:28`; the App Store flavor blocks `polar.sh` in Rust (`distribution.rs:40-45`). MAS stays ungated until IAP exists.

## Design

### R1. Response contract (additive)

- Activate and validate **success** responses gain:
  - `subscriptionStatus`: `active | trialing | past_due | canceled | pausing | paused | incomplete | ended | null`;
  - `renewsAt`, `endsAt`: ISO string or `null`.
- `null` or absent means unknown. `expiresAt` keeps meaning "Polar key expiry" and is never filled from the subscription.
- The validate-404 body is unchanged and carries none of the fields.
- Old apps ignore the new fields; a new app against an old backend sees them absent.

### R2. Live lookup: `src/services/polar-renewal.ts`

`resolveRenewal({ key: { id, customer_id, benefit_id }, requestStartedAt })` returns `{ subscriptionStatus, renewsAt, endsAt } | null`.

1. Run `benefitGrants.list({ organization_id, customer_id: key.customer_id, limit: 100, page: 1 })` with no `is_granted` filter.
   - If `pagination.max_page > 1`, return `null` (truncated; no partial conclusions).
   - Keep the grants where all of these hold:
     - `benefit.type == "license_keys"`;
     - `properties.license_key_id == key.id`;
     - `customer_id == key.customer_id`;
     - `benefit_id == key.benefit_id`.
   - Zero or several matches → `null`. One match with `subscription_id == null` → `null` (not a subscription key).
2. Run `subscriptions.get(grant.subscription_id)`.
   - If the subscription's `id` or `customer_id` differs from what was expected, return `null` and log `renewal: conflict`.
3. Map with R3.

- Nothing is persisted, and there is no DB access.
- It uses a dedicated Polar client (same token and environment), so the mandatory client keeps its settings.

### R3. Mapping (pure, first match wins; from archived Z4)

| # | Condition | `subscriptionStatus` | date |
|---|---|---|---|
| 1 | `ended_at` set; or status in `canceled`, `unpaid`, `incomplete_expired`; or (`cancel_at_period_end` or `ends_at`) with the end already past | `ended` | `endsAt = ended_at ?? ends_at ?? current_period_end` |
| 2 | status `paused` | `paused` | — |
| 3 | `pause_at_period_end` | `pausing` | `endsAt = current_period_end` |
| 4 | status `incomplete` | `incomplete` | — |
| 5 | `ends_at` set or `cancel_at_period_end` | `canceled` | `endsAt = ends_at ?? current_period_end` |
| 6 | status `past_due` | `past_due` | — |
| 7 | status `trialing` | `trialing` | `renewsAt = trial_end ?? current_period_end`, only if parseable and `> now`, else null |
| 8 | status `active` | `active` | `renewsAt = current_period_end`, only if parseable and `> now`, else null |
| 9 | any other or unrecognised status | null | — |

- Status never depends on date eligibility: a known status is always reported. A date that is missing, unparseable, equal to `now` or (for `renewsAt`) in the past is dropped (null field), and the presentation then shows the status-words row ("Status: Renews automatically" for `active`, "Status: Trial" for `trialing`, "Status: Canceled" for `canceled`, "Status: Pausing" for `pausing`).
- Tests assert both the DTO and the presentation (app and email) for `active` with a missing, malformed, equal-to-now and past `current_period_end`, and the same for `trialing`.
- Dates are output as ISO UTC strings.

### R4. Deadline and isolation (from archived Z1, with no DB)

- `requestStartedAt` is captured **once, at service entry, before any mandatory work**: as the first statement of `activatePolarLicenseKey` and `validatePolarLicenseKey`, and of `sendLicenseEmailForGrant` (before the claim, so the claim, `licenseKeys.get` and the existing plan-name `benefits.get` all count). It is passed unchanged to `resolveRenewal`, and the clock is injectable for tests.
- Deadline = `min(requestStartedAt + 12 s, now + 2.5 s)`. If 300 ms or less remains, return `null` without any call.
  - 12 s from request start keeps at least 3 s of headroom under the app's 15 s per-attempt limit.
- Each Polar call gets `timeout = remaining / 1000` s, never rounded up. A step is skipped if 300 ms or less remains before it starts.
- The caller awaits `Promise.race([work, deadlineTimer])`. On timeout it returns `null`.
  - `work` owns a terminal `.catch` that maps errors to static categories (`renewal: timeout|scope|rate_limit|upstream|conflict|truncated|unknown`) and a `.finally` that clears the timer. There is never an unhandled rejection.
  - Raw errors, ids, emails, keys and SDK bodies never reach `console`, `reportError`, Express (`app.ts:123-125`) or the process handlers (`server.ts:61-64`).
  - Because `work` makes only Polar calls (no DB), a late completion after the timeout has no side effect.
- Activate calls it **after** persisting the activation. Validate calls it on the **success** path only. Neither request fails because of it.
- Precise guarantee:
  - renewal lookup never delays a response past 12 s from request start (plus timer jitter);
  - if the mandatory Polar calls alone take longer, that is today's behaviour and is unchanged.

### R5. License email

- `LicenseEmailInput` gains a separate `renewal?: { subscriptionStatus, renewsAt, endsAt }`. `expiresAt` is not repurposed.
- In `sendLicenseEmailForGrant`, the existing order is kept: claim → `licenseKeys.get`. Then `resolveRenewal` runs with that key's `id`, `customer_id` and `benefit_id`, still inside the claim and with its own catch, before the send. This covers the grant webhook and admin resend.
- The claim TTL (5 min) is far above the 2.5 s budget.
- A `null` result renders the fallback row and the email still sends. Enrichment never writes `email_error`.
- Mandatory failures (key get, send) keep today's `LICENSE_EMAIL_FAILED` recording, retry and claim release. A successful send still clears `email_error` as today.
- HTML and text use the Goal table, without "(in N days)". When the key has a real `expires_at`, the existing Expires row wins.

### R6. App (from archived X6)

- **Rust:**
  - `LicenseApiResponse` gains `subscription_status`, `renews_at`, `ends_at`, as `Option<String>` with camelCase aliases;
  - `LicenseState` gains the same fields, with `#[serde(default)]` and in every constructor (`inactive`, legacy conversion);
  - `normalize_api_state` sets them **from the payload only**: absent or null means cleared, never inherited, which covers the validate-404 body;
  - `LICENSE_STATE_VERSION` is unchanged; `entitlement`, `apply_local_expiry` and `pro_access_until` are untouched;
  - the existing `activation_token` carry-over on a null payload token is unchanged and is documented only.
- **TS:** `LicenseState` gains `subscription_status?` (the R1 union, or null), `renews_at?: string | null` and `ends_at?: string | null`.
- **Presentation:**
  - `src/lib/license/renewal.ts` exports a pure `renewalPresentation(state, now)` → `{ label, value, tone }` following the Goal table;
  - `LicenseKeySettings.tsx` and `LicenseDialog.tsx` both render from it, which replaces the duplicated expiry markup;
  - a real key `expires_at` takes precedence;
  - "(in N days)" is computed from local `now`; a stale past `renews_at` shows "Status: Renews automatically".

## Tests

- **Backend (vitest; `createPolarMock` gains `benefitGrants.list` and `subscriptions.get`; fixtures gain `customer_id`, `benefit_id` and SDK-shaped pagination):**
  - `resolveRenewal`:
    - an exact match;
    - no match, several matches, and `subscription_id` null;
    - mismatched license key, customer and benefit;
    - `max_page = 2` (truncated);
    - a subscription whose id or customer does not match.
  - Mapping: every row of R3, the cross-product (terminal × cancel/pause flags, paused/incomplete × `ends_at`, trialing × cancel, active × past period), and missing or malformed dates.
  - Deadline (fake timers, deferred mocks):
    - caller-level, with a fake clock advanced inside the mocked mandatory Polar calls:
      - 11 s of mandatory work → the enrichment budget is 1 s or less;
      - 11.8 s → no enrichment call;
      - more than 12 s → no added enrichment wait;
      - covered for activate, validate, grant email and admin resend;
    - the SDK `requestOptions.timeout` argument decreases from the first enrichment call to the second;
    - a lookup then get that would overrun is cut off after the first step;
    - a call hanging past the deadline → `null` at the deadline, and the late rejection is caught and categorised;
    - no `unhandledRejection` in any case.
  - Error categories: 403 → `scope`, 429 → `rate_limit`, 5xx → `upstream`, network → `timeout` / `upstream`.
  - Activate and validate:
    - the fields are present on success;
    - they are absent on the 404 branch;
    - a lookup failure still returns a successful license response;
    - activate runs the lookup after persistence (call order).
  - Email:
    - the renew date in HTML and text;
    - the fallback on a lookup failure, with `email_error` not written by enrichment;
    - a dated key keeps its Expires row;
    - admin resend uses the same path;
    - concurrent grant and resend: only the claim winner sends.
  - Privacy sentinels: SDK errors whose messages hold an email, key and ids; capture `console.*` and `reportError` and assert that none appear.
- **App:**
  - Rust:
    - parse the new fields (camel and snake);
    - response → commit → reload;
    - active → 404 clears the fields;
    - an old backend (fields absent);
    - explicit nulls;
    - switching keys;
    - deactivate and clear;
    - a network failure keeps the previous snapshot;
    - any `subscription_status` or past `renews_at` / `ends_at` leaves `paid_license`, `pro_access` and `pro_access_until` unchanged.
  - Vitest:
    - `renewalPresentation` for every Goal row, including today, past, invalid and null dates and a dated key with subscription fields;
    - both screens render the shared row.

## Phases

1. **Phase 1, backend:** R1–R5, and the backend tests.
2. **Phase 2, app:** R6, and the app tests for both flavors.

Deploy the backend first. Each side tolerates the other being old.

## Rollout (human)

1. Grant `benefits:read` and `subscriptions:read` to the production Polar token. Sandbox already has `subscriptions:read`; confirm `benefits:read` on both.
2. Deploy the backend. There is no migration and no webhook change.
3. Release the app.

## Verification

- Backend: `npm run lint`, `npx prettier --check src test`, `npx tsc --noEmit -p .`, `npx vitest run`.
- App: `cargo test` (default features and `app-store`), `cargo clippy`, `npm run build`, `npm run build:appstore`, `npm run test:run`, and a UI check of both screens in Direct and App Store builds.
- Manual sandbox check (the user):
  1. press Refresh → `Renews on …`;
  2. cancel in the portal and press Refresh → `Ends on …`;
  3. send an admin resend → the email shows the date.

## Accepted Trade-offs

- Each activate and validate makes up to 2 extra Polar calls (about 0.3–1 s). Validate runs only at app start and on Refresh; email runs once per grant.
- If Polar is slow or down, or a scope is missing, the row shows "Renews with your subscription" for that request. Pro is unaffected.
- A customer with more than 100 grants gets the fallback (truncated). This is unlikely for a single-product app.
- No caching. It can be added later (for example an in-memory TTL, or storing the immutable `subscription_id` per key) only if latency or rate limits require it.

## Compatibility And Security

- The response change is additive, and entitlement is untouched.
- Renewal data is returned only for the caller's own key: the identity comes from Polar's validate/activate response, and the grant and subscription must match it exactly.
- No amounts, prices, customer names or emails are added to responses or logs.
- The app stores three display fields in its existing owner-only state file.

## Phase 1 — Implementation evidence (Claude, 2026-10-20)

Backend branch `feat/subscription-renewal` (from `feat/polar-sdk-1` `c0a50f4`), uncommitted. It includes the folded-in fallback work. Before starting, the local dev database `politedb` (container `politedb-postgres`) was dropped and recreated empty, as the user asked; migrations run on the next backend start.

- `src/services/polar-renewal.ts` (new):
  - `resolveRenewal` (R2 exact grant lookup, R4 deadline: `Promise.race` against the owned caught work promise, per-call `timeout = remaining / 1000`, a 300 ms step floor, static `renewal: <category>` logs);
  - `mapRenewal` (R3);
  - `renewalFields`;
  - an injectable clock (`renewalNow`, `setRenewalClockForTesting`).
  - It uses `getPolarClient()`, which builds a new client per call, with per-call timeout overrides, so the mandatory calls keep their 15 s default.
- `src/services/polar-license-key.ts`:
  - `requestStartedAt` is the first statement of activate and validate;
  - activate resolves after the activation and device rows are stored;
  - validate resolves on the success path only; the 404 body is unchanged.
- `src/services/polar-service.ts`: `requestStartedAt` is the first statement of `sendLicenseEmailForGrant`; `resolveRenewal` runs after `licenseKeys.get` and the plan-name `benefits.get`, inside the claim; `renewal` is passed to the email.
- `src/services/license-email.ts`:
  - `renewalRow` follows the Goal table, and the key's own expiry takes precedence;
  - an unparseable key expiry now shows "Unknown", which was the raw string before;
  - `LicenseEmailInput.renewal` is new.
- Tests:
  - new `test/polar-renewal.test.ts` (52): mapping rows, precedence cross-product, missing/malformed/equal/past dates for active and trialing, exact-match filters, ambiguous and null subscription, truncation, subscription identity, error categories, privacy sentinel, and deadline cases (11.8 s skip, 11 s budget ≤ 1 s, decreasing second timeout, cut-off after the first step, hanging call → null at the deadline with no unhandled rejection, late completion ignored);
  - `test/license.test.ts`: renewal on activate (looked up after the rows are stored) and on validate, absent on 404, null on failure, caller-level cap (11 s, 11.8 s, 13 s, slow activate);
  - `test/polar-service.test.ts`: email renewal, fallback on failure with no `email_error`, admin resend, a dated key, the caller-level cap for webhook and resend;
  - `test/license-email.test.ts`: every `renewalRow` row and the Unknown expiry;
  - `test/helpers.ts`: `grantFixture`, `grantList`, `subscriptionFixture`, `customer_id` on the key fixture, `benefitGrants` / `subscriptions` mocks.
- Verification:
  - `npm run lint` clean;
  - `npx prettier --check src test` clean;
  - `npx tsc --noEmit -p .` clean;
  - `npm run build` clean;
  - `npx vitest run` with `TEST_POSTGRES_URL` on `politedb-smoke-pg`: **194/194 passed** (9 files).
- Live sandbox read-only smoke: `resolveRenewal` on the two newest granted keys returned `active` with `renewsAt` 2027-10-19, in 742 ms and 1184 ms. Only display keys and results were printed.

### Phase 1 — Fixes for Codex review (Claude, 2026-10-20)

- **P2-1:** `mapRenewal` now selects the R3 field first and then parses it (`toMs(a ?? b)`), so a malformed preferred date is dropped, never replaced by the fallback field.
  - Covered cases: a malformed `trial_end` with a valid period end, a malformed `ends_at` with a past or future period end, and a malformed `ended_at` with a valid `ends_at`.
  - Also covered: a trial end equal to now, and an R3 → `renewalRow` email matrix for active and trialing with missing, malformed, equal-to-now and past dates.
- **P2-2:** the resolver clock reads `Date.now` at call time (`systemClock`), and the fake-timer tests bind it explicitly. `afterEach` restores real timers before resetting the clock. New and changed tests:
  - an exact 300 ms / 301 ms boundary;
  - a late rejection categorised as `renewal: upstream`;
  - no `subscriptions.get` after a grant list that completes past the deadline;
  - `vi.getTimerCount() == 0` after timeout and after an in-time finish;
  - no unhandled rejection in every case.
- **P2-3:**
  - activate gets 11 s (budget ≤ 1 s), 11.8 s and 13 s cases;
  - webhook and resend each get 11 s, 11.8 s and 13 s;
  - validate succeeds with a failed enrichment;
  - two resends race while a deferred lookup holds the claim: only the winner enriches and sends;
  - the stored `email_error` is read inside the send mock (still the earlier SMTP error, never written by enrichment);
  - caller-boundary privacy: `reportError` is mocked, `console.*` is captured, and the HTTP validate response and the webhook path are checked with sentinel SDK errors.
- Verification:
  - lint, prettier, `tsc` and `git diff --check` clean;
  - `npx vitest run` with `TEST_POSTGRES_URL`: **215/215 passed** (9 files).

### Phase 1 — Fixes for Codex re-review round 1 (Claude, 2026-10-20)

- **P2-2:** new fake-timer cases where the grant list finishes in time and `subscriptions.get` hangs past the deadline.
  - At the deadline: `null`, `renewal: timeout`, zero timers.
  - Then a late rejection (logged as `renewal: rate_limit`) or a late resolve (result unchanged, no further log). Zero timers and no unhandled rejection in both cases.
- **P2-3:** the real webhook path races the admin resend in both orders while the winner's renewal lookup is held (deferred) on an unsent delivery with a key:
  - the webhook holds the claim → the resend is skipped;
  - the resend holds the claim → the webhook is skipped.
  - In both, only the winner enriches (one grant list call) and sends.
  - The resend-vs-resend case is kept.
- Verification: lint, prettier, `tsc` and `git diff --check` clean; `npx vitest run` with `TEST_POSTGRES_URL`: **219/219 passed** (9 files).

## Phase 2 — Implementation evidence (Claude, 2026-10-20)

App branch `feat/subscription-renewal` (from `feat/pro-gating` `9d7cf53`), uncommitted. The folded-in fallback work in `LicenseKeySettings.tsx` and its test is superseded by the shared row.

- **Rust (`src-tauri/src/license.rs`):**
  - `LicenseApiResponse` gains `subscription_status`, `renews_at`, `ends_at` (`#[serde(default)]`, camelCase aliases);
  - `LicenseState` gains the same as `#[serde(default)]`, also in `inactive`;
  - `normalize_api_state` takes them from the payload only via `pick_string` (absent, null or blank → cleared);
  - entitlement code is untouched; `LICENSE_STATE_VERSION` is unchanged.
- **TS:** `LicenseState` gains the three fields, with `SubscriptionDisplayStatus`.
- **Presentation:**
  - new `src/lib/license/renewal.ts`: `renewalPresentation(state, now)` → `{ label, value, detail?, tone }`, and `RENEWAL_TONE_CLASS`;
  - the relative count uses local calendar days ("in N days", "today", "expired N days ago", "expired today");
  - `LicenseKeySettings.tsx` and `LicenseDialog.tsx` render from it, replacing both duplicated expiry blocks;
  - the expired wording changed from "(expired from N days)" to "(expired N days ago)";
  - the now-unused `formatDaysUntil` was removed from `src/utils/convert.ts`.
  - No Manage subscription button (user decision).
- **Tests:**
  - Rust:
    - `renewal_fields_parse_in_camel_and_snake_case`;
    - `renewal_fields_come_from_the_response_only` (old backend, nulls, blanks, the 404 body);
    - `renewal_fields_never_change_entitlement` (every status with past dates, plus a locked license);
    - `a_state_file_without_renewal_fields_still_loads`;
    - the loopback `renewal_fields_follow_each_response_and_survive_failures` (commit → reload, 500 keeps the snapshot, the 404 body clears, a key switch, deactivate, clear).
  - Vitest:
    - new `src/lib/license/renewal.test.ts` covers every Goal row, today/past/invalid/null dates, key-expiry precedence and the fallback only when nothing is known;
    - the Settings renewal-row tests were updated;
    - `LicenseDialog.lostKey.test.tsx` gains the shared-row and fallback cases.
- **Verification:**
  - `npx prettier --check src` clean;
  - `npm run build` and `npm run build:appstore` succeed;
  - `npm run test:run`: **885/885** (146 files);
  - `cargo fmt --check` clean;
  - `cargo test` and `cargo test --features app-store`: **440 passed, 15 ignored** each;
  - `cargo clippy --all-targets`: only pre-existing warnings, none in the changed files (`engines/mysql/driver.rs`, `security/credential_identity.rs`, `commands/export.rs`).
- **Not done:** the visual UI check of both screens. `tauri:dev` was not running, and an end-to-end check needs the backend restarted on `feat/subscription-renewal` against the recreated dev DB. This is left to the user's manual sandbox check (Verification).

### Phase 2 — Fixes for Codex review (Claude, 2026-10-20)

- **P2:** `renewalPresentation` treats any present `expires_at` (`!= null`), including blank or whitespace, as the key's own expiry. That shows "Expires at: Unknown" and never a subscription row or the fallback. Tests cover `"soon"`, `""` and `"   "`, with and without subscription fields.
- **P3:**
  - `renewal.test.ts` sets `process.env.TZ` per case and asserts the exact local date (`formatDateTime` of the expected local day) plus the day wording for:
    - local midnight crossing a different UTC date (Asia/Ho_Chi_Minh);
    - a UTC date ahead of the local date (America/Los_Angeles);
    - spring-forward and fall-back days (America/New_York);
    - a non-hour offset (Asia/Kolkata).
  - Both screens now assert the renewal row, status words and the fallback under the Direct and App Store feature sets (`LicenseKeySettings.lostKey.test.tsx`, `LicenseDialog.lostKey.test.tsx`).
  - Rust `renewal_end_dates_parse_in_camel_and_snake_case` proves a non-null `endsAt` / `ends_at` alias.
- Verification:
  - `npx prettier --check src` and `npx tsc --noEmit` clean;
  - `npm run build` and `npm run build:appstore` succeed;
  - `npm run test:run`: **894/894** (146 files);
  - `cargo fmt --check` clean;
  - `cargo test` and `cargo test --features app-store`: **441 passed, 15 ignored** each.

### Phase 2 — Fixes for Codex re-review round 1 (Claude, 2026-10-20)

- **P3 (TZ cleanup):** the time-zone tests now delete `process.env.TZ` when it was initially absent (assigning `undefined` would store the string `"undefined"`), and restore the saved string otherwise.
- **P3 (Dialog status words):** the Direct/App Store dialog test now also asserts a known status without a usable date (`paused` → "Status: Paused", with no fallback text).
- Verification: prettier and `tsc` clean; `npm run test:run` **894/894** (the new assertions extend existing tests); a `TZ=UTC` run of `renewal.test.ts` passes 27/27.

## Plan Review

Reviewed offline against both working trees, the archived Revision 4 contract, and the installed SDK 1.0.2 `2026-10` types/runtime. Paths prefixed `backend:` refer to `politedb-backend`; `app:` refers to this repo. No network calls or application changes.

### Blocker

None identified in the chosen architecture. R1 is additive and keeps expiry separate; R2 uses the supported query, rejects truncated/ambiguous results, and checks the exact key/customer/benefit followed by subscription/customer identity. Omitting `is_granted` avoids excluding historical grants. The scopes and seconds-based timeout match the installed SDK. Evidence: `backend:node_modules/@polar-sh/sdk/dist/index-CgqeU9bV.d.mts:150-158`; `backend:node_modules/@polar-sh/sdk/dist/2026-10/services/benefit_grants.mjs:5-30`; `backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:13507-13515,17050-17058,19363-19369`; `backend:node_modules/@polar-sh/sdk/dist/base-C7LedWf8.d.mts:39-43`.

### Should-fix

1. **S1 — Resolve R3's known-active/date contradiction before implementation.** `plan:110-113` maps `active` only when `current_period_end > now`, otherwise to null, but immediately requires missing/unparseable dates to preserve the known status. Thus a missing, invalid or already-past period end loses `active` and reaches the unknown-renewal fallback instead of the specified status-words row. Specify `active` status independently of date eligibility, with a null renewal date when no usable future date exists; preserve terminal/cancel/pause precedence. Add explicit expected DTO and presentation assertions for active + missing, malformed, equal-to-now and past dates, including email output. This fixes display correctness only. Evidence: `plan:48-49,103-113,152,169`; Polar separates status from the period timestamp at `backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:19299-19309`.

2. **S2 — Make the request-start deadline testable through its callers.** R4 names `requestStartedAt`, but does not identify where it is captured or how it reaches the resolver; existing endpoints pass only `req.body`, and both license services start mandatory work without a request timestamp. A timestamp created immediately before enrichment would satisfy isolated resolver tests while allowing 11 seconds of mandatory work plus another 2.5 seconds, violating the promised 12-second cap. Specify capture at request/service entry before mandatory work, carry it unchanged through activate/validate, and define the email invocation's start point consistently for webhook and resend (including the existing optional `benefits.get`). Add caller-level fake-clock tests that advance time inside mandatory calls: 11 seconds leaves at most 1 second; 11.8 seconds skips enrichment; mandatory work already beyond 12 seconds adds no enrichment wait. Keep the existing mandatory-work exception. Evidence: `plan:118-128,133,170-180`; `backend:src/routes/license.ts:12-24`; `backend:src/services/polar-license-key.ts:413-443,446-493`; `backend:src/services/polar-service.ts:107-123`. Also assert the actual second SDK argument's timeout decreases between calls, rather than merely checking resolver return time.

### Nice-to-have

None required within this scope. R3's terminal → paused → scheduled pause → incomplete → scheduled end → delinquent → trial → active ordering otherwise follows the archived contract and Polar's distinct end/pause fields (`backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:19319-19361`). R4's owned caught work promise, race and static logging contain late failures; implementation must race that caught/finalized promise itself, never discard a rejecting derived promise (`plan:121-124`; raw-error sinks at `backend:src/app.ts:123-125`, `backend:src/server.ts:61-64`). R5 places enrichment inside the existing claim and outside mandatory email-error handling; retain the existing plan-name benefit lookup and its failure behavior (`backend:src/services/polar-service.ts:107-139`). R6 matches response normalization, existing portal entry points and distribution gating (`app:src-tauri/src/license.rs:183-209,777-845`; `app:src/lib/license/proAccess.ts:28`; `app:src/components/modal/LicenseDialog.tsx:76-83,216-245`). Lifecycle/entitlement, privacy, both-screen/flavor tests and backend-first rollout are appropriately scoped (`plan:160-226`). Live lookup, no backend storage/webhooks, app snapshot persistence, and D8 remain as decided.

**Conclusion: NOT READY** — resolve S1's mapping contract and S2's deadline wiring/verification contract. No architecture or scope expansion requested.

### Plan re-check (Codex)

Re-checked offline on 2026-10-20 against the current backend working tree and installed SDK. This is a design re-check, not implementation verification; the proposed resolver, wiring and tests are not yet implemented. Earlier review text is retained as history. Only this plan was edited; no application changes, commits or network calls.

- **S1 — Resolved at plan level.** R3 rows 7–8 now preserve `trialing` / `active` independently of timestamp eligibility; unusable renewal dates become null and render the known-status row. Terminal/cancel/pause precedence remains intact. Explicit DTO plus app/email presentation assertions cover missing, malformed, equal-to-now and past dates for both statuses (`plan:103-115`). This matches the SDK's separate status, billing-period and trial-end fields (`backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:19299-19309,19319-19325`). Past `endsAt` remains available for the specified ended-date row; the new past-date exclusion is specifically for `renewsAt` (`plan:103,113`).
- **S2 — Resolved at plan level.** R4 now captures the timestamp as the first statement of each named service, before mandatory work, passes it unchanged, and specifies an injectable clock (`plan:119-130`). These are concrete insertion points before activation validation/persistence (`backend:src/services/polar-license-key.ts:413-443`), validation and its success-path updates (`backend:src/services/polar-license-key.ts:446-493`), and email claim/key/optional benefit lookup (`backend:src/services/polar-service.ts:107-123`). Both webhook delivery and admin resend converge on that email service (`backend:src/services/polar-service.ts:178-184,214-219`); the email budget starts at this explicitly chosen invocation boundary. Caller-level fake-clock coverage now requires 11 s, 11.8 s and over-12 s cases across all four paths, plus decreasing actual SDK request-option timeouts (`plan:172-181`). The installed SDK accepts the override as the second argument and uses seconds (`backend:node_modules/@polar-sh/sdk/dist/2026-10/services/benefit_grants.mjs:17-30`; `backend:node_modules/@polar-sh/sdk/dist/base-C7LedWf8.d.mts:34-36`). Its internal millisecond ceiling does not replace the independently raced absolute deadline (`backend:node_modules/@polar-sh/sdk/dist/base-Cir88A-B.mjs:87-109`; `plan:120-124`).

**New Blocker:** None.

**New Should-fix:** None. The edits introduce no identified correctness, security, privacy or testability issue. They retain display-only mapping, optional enrichment isolation, static error categories and privacy sentinels (`plan:124-127,137-138,194,205`). Existing mandatory email failures remain separate from enrichment failures (`backend:src/services/polar-service.ts:133-139`).

**New Nice-to-have:** None within the requested scope.

**Conclusion: READY** — S1 and S2 are resolved in the DRAFT design. Implementation and execution of the specified regression tests remain for the approved implementation phases; no runtime checks were run for this plan-only review. Status remains DRAFT pending human approval.
