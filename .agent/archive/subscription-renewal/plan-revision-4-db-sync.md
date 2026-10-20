# Subscription Renewal Dates

## Status

DRAFT

## Task

- ID: subscription-renewal
- Requested 2026-10-19: Pro is sold as a **yearly Polar subscription**. Polar leaves `expires_at` empty on subscription license keys, so the app shows no date. Show the real renewal / end date in the app and in the license email, following the usual pattern for subscription desktop apps.
- The user granted `subscriptions:read` to the sandbox Polar access token on 2026-10-19.
- Repos: `politedb-backend` (Phase 1) and `politedb-app` (Phase 2).
- Branches: backend `feat/subscription-renewal` from `feat/polar-sdk-1`; app `feat/subscription-renewal` from `feat/pro-gating`.
- Workflow: Claude implements after approval; Codex reviews each phase; `/security-review` after Codex (license scope). No commit/push unless the user asks.

## Goal And Visible Result

- Settings → License key (and the License dialog) show one of:
  - `Renews on 19/10/2027 (in 365 days)`: subscription active and set to renew.
  - `Ends on 19/10/2027 (in 365 days)`: cancelled, still paid until the period end.
  - `Payment past due`: renewal payment failed, Polar is retrying.
  - `Renews with your subscription`: renewal info unknown (fallback, today's text).
  - A dated key (one-time purchase) keeps today's `Expires at <date> (in N days)`.
- A **Manage subscription** button (Direct flavor only) opens the Polar customer portal.
- The license email says `Renewal: Renews on October 19, 2027` when the grant comes from a subscription.
- **Entitlement does not change.** Pro is still unlocked by `status == "active"` plus Polar's `expires_at`; losing Pro still comes from Polar revoking the grant (webhook `benefit_grant.revoked` and validate returning 404). Renewal dates are display only and never lock Pro.

## Consolidated Spec (authoritative, Revision 4, Codex READY 2026-10-20)

This section is the implementation contract. Sections after it (Baseline, the original Decisions and Phases, and Revisions 2–4) are kept as evidence and history. Where wording differs, this section and the referenced Z/Y/X items win, in that order.

### Contract

- **Display only.** Entitlement, `expires_at` locking, revocation via `benefit_grant.revoked` / validate 404, and the offline behaviour (D8) do not change.
- **Response fields** on activate and validate success (D2, Z4):
  - `subscriptionStatus`: `active | trialing | past_due | canceled | pausing | paused | incomplete | ended | null`;
  - `renewsAt`, `endsAt`: ISO string or `null`.
  - The validate-404 body is unchanged and carries none of them.

### Backend (Phase 1, `politedb-backend`, branch `feat/subscription-renewal` from `feat/polar-sdk-1`)

1. **Tables**, in migration `src/migrations/Migration20261020000000AddPolarSubscriptions.ts`, registered in `src/migrations/index.ts` and `entities`:
   - `polar_license_links`: PK `license_key_id`; `grant_id`, `customer_id`, `benefit_id`, nullable `subscription_id`, `created_at` (Z2).
   - `polar_subscriptions`: PK `id`; `customer_id`, `product_id`, `status`, `cancel_at_period_end`, `pause_at_period_end`; bigint `current_period_end_ms`, `ends_at_ms`, `ended_at_ms`, `trial_end_ms`, `version_ms`; `delivered_at`, `reconciled_at`, `created_at`; index `idx_polar_subscriptions_customer` (Y3, Z3).
2. **Link writers (Z2, Y2 lookup rules).**
   - Grant webhook: runs first, in its own try/catch, and never blocks email or revocation (Z5).
   - Exact lookup on a miss:
     - `benefitGrants.list({organization_id, customer_id, limit: 100, page: 1})`;
     - `max_page > 1` means truncated, so the result is unknown;
     - a match needs the exact `license_key_id`, `customer_id` and `benefit_id`.
   - Both writers use `INSERT … ON CONFLICT DO NOTHING`, then re-read the winning row. A read-time identity check that fails → `null`, the row is kept, and `renewal: conflict` is logged.
3. **Snapshot writer (Z3).**
   - Webhook writes only when the version is strictly newer (or nothing is stored); API writes when the version is equal or newer, or has no version.
   - After the write, re-read the row. `reconciled_at` is set only by an applied API write.
   - All eleven `subscription.*` events use the webhook writer. A write failure → `AppError(503, "RENEWAL_SYNC_FAILED")` (Z5).
4. **Mapping (Z4 table, then Y4 rows 4–6)** is a pure function and the first match wins: ended → paused → pausing → incomplete → canceled → past_due → trialing → active → null.
5. **Resolver (Z1).**
   - `resolveRenewal`, deadline `min(start + 12 s, now + 2.5 s)`, skipped when 300 ms or less remains.
   - Bounded detachment: the caller races the work against the deadline. The work promise owns its catch/finally with static log categories, and no new step starts after the deadline.
   - Stale means `reconciled_at` older than 24 h, or the period end has passed → `subscriptions.get`. Fresh → DB only.
6. **Call sites.**
   - Activate: after persistence.
   - Validate: success path only.
   - Grant email and admin resend: after `licenseKeys.get`, inside the existing claim, isolated from the email catch (Z6).
7. **Email copy:**
   - `LicenseEmailInput.renewal` is a separate field;
   - HTML and text follow the Y5 + Z4 copy tables, with UTC dates and no "(in N days)";
   - the fallback text appears only when `subscriptionStatus` is null.
8. **Tests:**
   - Z1–Z6 and Y2–Y8 lists, on SQLite;
   - on Postgres: the migration tests (X9/Y8) and the race tests (Z2, Z3);
   - sentinel privacy tests (Y7, Z5);
   - mocks extended (Y8).

### App (Phase 2, `politedb-app`, branch `feat/subscription-renewal` from `feat/pro-gating`)

1. **Rust (X6):**
   - `LicenseApiResponse` gains `subscription_status`, `renews_at`, `ends_at`, with camelCase aliases;
   - `LicenseState` gains the same fields as `#[serde(default)]` and in every constructor;
   - they are set from the payload only, and absent means cleared;
   - the state version is unchanged and entitlement is untouched.
2. **TS:** `LicenseState` gains the three fields, with the Z4 union.
3. **Presentation:**
   - `src/lib/license/renewal.ts` `renewalPresentation(state, now)` follows the Y5 + Z4 tables;
   - it is used by `LicenseKeySettings.tsx` and `LicenseDialog.tsx`;
   - the real key expiry takes precedence.
4. **Manage subscription (X7):** Direct flavor only, in the active panel of both screens, opening `LICENSE_PORTAL_URL`.
5. **Tests:** the X6 Rust lifecycle and entitlement tests; Vitest for every presentation row and for the button in Direct vs App Store; builds and tests for both flavors.

### Rollout (human, Y8)

1. Check the token scopes `benefits:read` and `subscriptions:read`, and API version 2026-10, on sandbox and production.
2. Back up the DB.
3. Deploy the backend.
4. Enable the `subscription.*` webhook events.
5. Release the app.

There is no backfill: keys are enriched on their next validate, email or resend.

### Accepted trade-offs

- A link conflict degrades to the fallback copy without auto-repair (operator fix).
- A missed webhook inside the 24 h window shows only after the window.
- Keys whose owners never open the app stay unenriched.
- Detached enrichment is not guaranteed to complete at shutdown.
- D8 (offline grace) stays out of scope.

## Baseline (inspected 2026-10-19)

Backend (`politedb-backend`, branch `feat/polar-sdk-1`):

- Entities in one file `src/db/entities.ts`: `License` (linked to Polar by key string; stores no Polar ids), `Activation`, `PolarLicenseDelivery` (PK `grantId`; stores `polarOrderId`, `polarBenefitId`, `polarLicenseKeyId`), `Trial`. **Nothing stores a Polar customer or subscription id.**
- Migrations: explicit list in `src/migrations/index.ts`, run by `orm.migrator.up()` on boot (`src/db/orm.ts:39`); entities must also be added to the exported `entities` array (`src/db/entities.ts:149`). New migration = `npm run db:diff` SQL pasted into `MigrationYYYYMMDDHHMMSS<Name>.ts` and appended. `test/migrations.pg.test.ts` pins the executed list and requires an empty schema diff. SQLite tests build the schema from entities.
- Webhooks: `processPolarEvent` (`src/services/polar-service.ts`) handles `benefit_grant.created/updated/revoked`; every `subscription.*` event falls into the `ignored` default. The grant payload carries `subscription_id`, `customer_id`, `properties.license_key_id`. It is read nowhere today.
- License endpoints (`src/services/polar-license-key.ts`): activate/validate return `status, licenseId (Polar key id), licenseKey, activationToken, planName, plan, customerEmail, instanceName, expiresAt, activatedAt, lastValidatedAt, seatsAllowed, devicesUsed, product, message, source`. The validate 404 branch returns only `status, plan, licenseKey, activationToken: null, product, message, source`. `ValidatedLicenseKey` / `GrantedLicenseKey` expose `customer_id` but no subscription id.
- SDK 1.0.2 `subscriptions.get(id)` and `subscriptions.list({ customer_id, active, … })` exist on the 2026-10 client. `Subscription` has `status` (`incomplete|incomplete_expired|trialing|active|past_due|canceled|unpaid|paused`), `current_period_end`, `cancel_at_period_end`, `ends_at`, `ended_at`, `customer_id`, `product_id`, `modified_at`.
- Accepted 2026-10 subscription webhooks: `subscription.created, active, updated, canceled, uncanceled, past_due, cycled, paused, resumed, revoked, migrated` (each `data: Subscription`).

App (`politedb-app`, branch `feat/pro-gating`):

- `src-tauri/src/license.rs`: `LicenseApiResponse` (:183-209) parses snake_case with camelCase aliases and ignores unknown keys. `normalize_api_state` (:777-853) builds `LicenseState` (:54-103) from the response; plan and expiry fields come from the response only. `entitlement` (:353-385): paid = `status == "active"` && paid tier && not past `expires_at`; null `expires_at` = unlimited. State is a JSON file (`<app_data>/license/state.json`, version 1).
- Validate runs on store `load()` and on the Refresh button only; no background timer. No offline grace window: a subscription key with null `expires_at` keeps Pro offline until an online validate sees the revocation.
- Frontend: `LicenseState` TS type (`src/lib/tauri/license.ts:18-56`). The expiry row is rendered in two places: `LicenseKeySettings.tsx:150-172` and `LicenseDialog.tsx:197-210`. `LICENSE_PORTAL_URL` (`src/lib/license/proAccess.ts:28`) is already used for the lost-key flow, gated by `DISTRIBUTION_FEATURES.externalPurchase`. The App Store flavor blocks `polar.sh` URLs in Rust (`distribution.rs:40-45`).
- Uncommitted on both branches: the "Renews with your subscription" fallback text (backend email `Renewal` row; app Settings row). This plan keeps it as the unknown-renewal fallback.

## Decisions

- D1 Source of truth: **backend DB synced from Polar `subscription.*` webhooks**, with a one-off Polar API lookup when the DB has no row yet (keys sold before this feature, or a missed webhook). The app only talks to our backend.
- D2 Response contract (additive, flat, camelCase like the existing fields): `subscriptionStatus: "active" | "trialing" | "past_due" | "canceled" | "ended" | null`, `renewsAt: ISO string | null`, `endsAt: ISO string | null`. `null` / absent = unknown → app shows the fallback text. `expiresAt` keeps meaning "Polar key expiry" and is never filled from the subscription (it is a hard lock in the app).
- D3 Mapping from Polar `Subscription`:
  - `active` or `trialing`, `cancel_at_period_end = false` → status as is, `renewsAt = current_period_end`.
  - `active` or `trialing`, `cancel_at_period_end = true` → `subscriptionStatus = "canceled"`, `endsAt = ends_at ?? current_period_end`.
  - `past_due` or `unpaid` → `"past_due"`, `renewsAt = current_period_end`.
  - `canceled` (ended), `incomplete_expired` → `"ended"`, `endsAt = ended_at ?? ends_at`.
  - `incomplete`, `paused` → `null` (fallback text).
- D4 Link license key → subscription: store `subscription_id` (and `customer_id`) from the grant webhook on `PolarLicenseDelivery`, keyed by `polarLicenseKeyId`. Fallback lookup: `subscriptions.list({ customer_id, active: true })` filtered to `env.polarProductIds`, latest `current_period_end` wins; the result is cached in the DB.
- D5 Out-of-order webhooks: upsert only when the incoming `modified_at` (or `created_at`) is newer than the stored one.
- D6 Failure isolation: renewal lookup failures (Polar down, missing scope, no row) never fail activate/validate or the license email. They return `null` fields and log `subscription lookup failed: <error name>` with no ids or emails.
- D7 Manage subscription: Direct flavor only, opens `LICENSE_PORTAL_URL`; hidden in the App Store flavor (the Rust URL policy blocks `polar.sh` there; MAS stays ungated until IAP exists, `distribution.rs:53-55`).
- D8 Offline grace — **out of scope** (user, 2026-10-19: option a). Current behaviour is kept: a subscription key keeps Pro offline, and a revocation is seen on the next online validate (app start or Refresh). This plan is display only. A periodic validate plus grace window would change entitlement and needs its own plan.

## Phase 1 — Backend (`politedb-backend`)

1. Entity `PolarSubscription` (table `polar_subscriptions`): `id` (Polar subscription id, PK), `customerId` (indexed), `productId`, `status`, `currentPeriodEnd`, `cancelAtPeriodEnd`, `endsAt`, `endedAt`, `polarModifiedAt`, `createdAt`, `updatedAt`. No customer email or name.
2. `PolarLicenseDelivery`: add nullable `polarSubscriptionId`, `polarCustomerId`; index on `polarLicenseKeyId`.
3. Migration `Migration20261020000000AddPolarSubscriptions` (create table + add columns + index), appended to `migrations/index.ts`; extend `test/migrations.pg.test.ts` (executed list, migrate from the previous migration and assert table and columns, empty schema diff).
4. New module `src/services/polar-subscription.ts`:
   - `upsertSubscriptionFromPolar(sub)` with the D5 ordering rule;
   - `renewalForLicenseKey({ licenseKeyId, customerId })` → `{ subscriptionStatus, renewsAt, endsAt }`, doing DB lookup then the D4 fallback, never throwing (D6);
   - pure `mapRenewal(sub)` implementing D3.
5. `processPolarEvent`: new cases for every accepted `subscription.*` type → upsert. Grant created/updated: persist `subscription_id` / `customer_id` on the delivery row.
6. `mapActivationResponse` / `mapValidatedResponse`: add the D2 fields from `renewalForLicenseKey` (key id = `license_key.id` / `validated.id`, customer = `customer_id`). The 404 branch is unchanged (no renewal fields).
7. License email: `emailExpiry` stays for dated keys. For subscription grants, `renewsAt` comes from `renewalForLicenseKey` and shows `Renewal: Renews on <date>`; otherwise the existing fallback text.
8. Tests (vitest, SQLite + Postgres):
   - `mapRenewal` table for every D3 row;
   - webhook upsert, including out-of-order `modified_at`, signed through the route;
   - grant stores `subscription_id`;
   - validate/activate return renewal from the DB;
   - fallback via a `subscriptions.list` mock, then cached;
   - Polar failure → null fields and the request still succeeds;
   - email shows the renew date;
   - the 404 branch has no renewal fields;
   - migration test.
   - `createPolarMock` gains `subscriptions: { get, list }`.

## Phase 2 — App (`politedb-app`)

1. Rust `LicenseApiResponse`: `subscription_status` (alias `subscriptionStatus`), `renews_at` (`renewsAt`), `ends_at` (`endsAt`), all `Option<String>`.
2. `LicenseState`: the same three fields, `#[serde(default)]`, set in `normalize_api_state` from the response only (like `plan`); cleared when absent. `LICENSE_STATE_VERSION` unchanged (additive optional fields). `entitlement`, `apply_local_expiry` and `pro_access_until` are untouched.
3. TS `LicenseState`: add `subscription_status?`, `renews_at?`, `ends_at?`.
4. New component `src/components/license/LicenseRenewalRow.tsx` (pure; takes `LicenseState` and `now`), used by both `LicenseKeySettings.tsx` and `LicenseDialog.tsx` to replace the duplicated expiry rendering. Precedence: dated `expires_at` → `Expires at …`; else D3 status text; else fallback.
5. **Manage subscription** button next to Refresh/Deactivate when `DISTRIBUTION_FEATURES.externalPurchase` and the license is active, opening `LICENSE_PORTAL_URL` via `openExternalUrl`.
6. Tests:
   - Rust: parse new fields (camel and snake), carried into state, absent → None, entitlement unchanged when `renews_at` is in the past, old state file without the fields still loads;
   - Vitest: `LicenseRenewalRow` for every visible state, Manage button Direct vs App Store, the two screens render the shared row.

## Deploy Order And Setup (human)

1. Production Polar access token gets `subscriptions:read`.
2. Polar webhook endpoints (sandbox and production) subscribe to the `subscription.*` events listed in Baseline.
3. Deploy the backend (migration runs on boot). Old apps ignore the new fields.
4. Release the app. A new app against an old backend sees null fields and shows the fallback text.

## Compatibility And Security

- Additive response fields; no existing field changes meaning. Entitlement and lock behaviour are unchanged (D8).
- The validate/activate caller already proves possession of the license key; renewal info is returned only for that key's own subscription. No amounts, prices, customer names or emails are added to responses or logs.
- Webhook signature verification is unchanged; subscription payloads are processed only after `validateEvent`.
- Subscription ids are stored server side only. The app persists three display fields in its existing owner-only state file.

## Verification

- Backend: `npm run lint`, `npx prettier --check src test`, `npx tsc --noEmit -p .`, `npx vitest run`, plus a Postgres run (`TEST_POSTGRES_URL` on a throwaway container).
- App: `cargo test` (license, distribution), `cargo clippy`, `npm run build`, `npm run test:run`.
- Manual sandbox check:
  - redeliver a `subscription.updated` webhook;
  - press Refresh → `Renews on …`;
  - cancel in the portal → `Ends on …`;
  - resend the license email.

## Risks

- Missing `subscriptions:read` in production → only the fallback text (D6), no outage. Verify the token before deploy.
- Webhooks not subscribed → DB stays empty; the API fallback covers it at extra Polar calls (one per validate until cached).
- Customer with several active subscriptions → D4 picks the one for a configured product with the latest period end; the grant link from step 5 avoids the guess for new purchases.
- Date shown in the user's locale (`formatDateTime`); the backend returns UTC ISO.

## Revision 2 (addresses Codex Plan Review, 2026-10-19)

Base commits: backend `c0a50f4` (`feat/polar-sdk-1`), app `9d7cf53` (`feat/pro-gating`). Pre-existing uncommitted work on both: the "Renews with your subscription" fallback (backend: `src/services/license-email.ts`, `src/services/polar-service.ts`, `test/license-email.test.ts`, `test/polar-service.test.ts`; app: `LicenseKeySettings.tsx`, `LicenseKeySettings.trial.test.tsx`). It is committed separately before Phase 1/2 starts.

This revision **replaces D3–D6** and the matching Phase 1 steps. D1, D2 (field names), D7, D8 stay.

### X1. Exact key → subscription link (replaces D4; Blocker 1)

- New table `polar_license_links`, PK `license_key_id` (Polar key id). Columns:
  - `grant_id`, `customer_id`, `subscription_id` (nullable: null = the grant has no subscription, e.g. a one-time purchase);
  - `source` (`webhook` | `lookup`), `resolved_at`;
  - `lookup_failed_at`, `next_lookup_at` (negative cache).
- It is independent of `polar_license_key_deliveries`: no email fields are created or touched to cache identity.
- Sources, in precedence order:
  1. **Grant webhook** (`benefit_grant.created/updated/cycled/revoked`, `license_keys` benefit with `properties.license_key_id`): upsert `{grant_id, customer_id, subscription_id}` with `source = webhook`. This runs **before** any email early-return, so disabled mail, an already-sent email or a missing email never skips it.
  2. **Lookup** for keys with no row:
     - call `benefitGrants.list({ organization_id, customer_id, page, limit: 100 })` with no `is_granted` filter, so historical grants count;
     - keep only grants whose `benefit.type == "license_keys"` and whose `properties.license_key_id` **equals** the caller's key id, with the same `customer_id` as the trusted validate/activate result;
     - exactly one match → store it with `source = lookup`; zero or conflicting matches → store nothing and set the negative cache.
- A `lookup` row never overwrites a `webhook` row. A non-null `subscription_id` is never overwritten by null.
- There is no customer/product guess. Unresolved means unknown, so the app shows the fallback text.
- Scopes needed: `benefits:read` (grant list; the backend already reads benefits, but production must be checked) and `subscriptions:read`. `customers.getState` is not used.

### X2. Subscription snapshot table and atomic ordering (replaces D5; Should-fix 1)

- `polar_subscriptions`, PK `id`. Columns:
  - `customer_id`, `product_id`, `status`;
  - `current_period_end`, `cancel_at_period_end`, `ends_at`, `ended_at`, `trial_end`;
  - `polar_version_at` (timestamptz, ms precision) = `modified_at ?? created_at`;
  - `synced_at`, `created_at`.
- All nullable Polar timestamps are nullable columns. No customer email or name is stored.
- One writer for webhook and API snapshots, `upsertSubscriptionSnapshot(sub)`. It is a single SQL statement: `INSERT … ON CONFLICT (id) DO UPDATE SET … WHERE excluded.polar_version_at >= polar_subscriptions.polar_version_at`, which works on Postgres and SQLite.
  - On an equal version the later write wins (idempotent redelivery).
  - A snapshot with a missing or unparseable version is stored only when no row exists.
  - `synced_at` is always bumped when the version is equal or newer.
- Every one of the eleven accepted `subscription.*` events routes to this writer. Event names are never ranked, and `revoked` is treated as an event, not a status.
- Subscription events never change `License.status` and never send email.

### X3. Display mapping, ordered and mutually exclusive (replaces D3; Blocker 2)

The first matching rule wins. `now` is server time.

| # | Condition | `subscriptionStatus` | `renewsAt` | `endsAt` |
|---|---|---|---|---|
| 1 | `ended_at` set, or status in `canceled`, `unpaid`, `incomplete_expired` | `ended` | null | `ended_at ?? ends_at ?? null` |
| 2 | `ends_at` set, or `cancel_at_period_end` (including during a trial) | `canceled` | null | `ends_at ?? current_period_end` |
| 3 | status `past_due` | `past_due` | null | null |
| 4 | status `trialing` | `trialing` | `trial_end ?? current_period_end` (first charge) | null |
| 5 | status `active`, and `current_period_end > now` | `active` | `current_period_end` | null |
| 6 | anything else (`incomplete`, `paused`, pause scheduled, active with a period end already past, missing dates) | null | null | null |

Rule 6 leaves the snapshot unknown: the app and email show the fallback text and nothing promises a renewal. The mapping is display only (D8 unchanged).

### X4. Bounded enrichment off the request path (replaces D6; Blocker 3)

- Activate and validate read **only the DB** (link plus snapshot) on the request path. There are no Polar calls there and no added latency.
- When data is missing or stale, the request returns what it has (or nulls) and schedules a **background refresh**:
  - no link and `next_lookup_at` passed → link lookup (X1), then `subscriptions.get(id)`;
  - link present but no snapshot, or `synced_at` older than 24 h, or `current_period_end` passed → `subscriptions.get(id)`.
- Background refresh limits:
  - its own Polar client with a 3 s per-call timeout;
  - at most 3 grant-list pages;
  - no retries or sleeps;
  - in-process coalescing per key id (one in-flight job);
  - runs on a forked ORM unit of work (`em.fork()`), so a failed flush cannot affect license or email writes.
- On failure (timeout, 403 scope, 429, 5xx, DB error) → set `lookup_failed_at`, and `next_lookup_at` = now + 1 h (or `retryAfter` when larger). Log only a static category: `renewal refresh failed: timeout|scope|rate_limit|upstream|db|ambiguous`. No ids, emails, SDK bodies or error messages are logged.
- The next validate (app start or Refresh) picks up the refreshed data. This 24 h staleness rule doubles as reconciliation for missed webhooks, and it is server side, not app polling.

### X5. Copy (Should-fix 2)

- **Shared presentation, app:** `src/lib/license/renewal.ts` exports pure `renewalPresentation(state, now)` → `{ label, value, detail?, tone }`. Both `LicenseKeySettings.tsx` and `LicenseDialog.tsx` render the label and value from it, so "Expires at: Renews on …" cannot occur.
- Precedence: a dated `expires_at` (a real key expiry) → `Expires at` + date + `(in N days)` / `(expired N days ago)` as today. Otherwise, by `subscription_status`:

| status | label | value |
|---|---|---|
| `active` | Renews on | `<date>` (in N days) |
| `trialing` | Trial ends | `<date>`, then renews |
| `canceled` | Ends on | `<date>` (in N days) |
| `past_due` | Payment | Past due — update your payment method |
| `ended` | Ended on | `<date>`, or "Ended" with no date |
| null / unknown / invalid or past date where a future one is expected | Renewal | Renews with your subscription |

- **Email:** a separate `renewal?: { status, renewsAt, endsAt }` on `LicenseEmailInput`; `expiresAt` is not repurposed. HTML and text use the same table, minus `(in N days)`. The grant webhook and admin resend both read the X1/X2 data from the DB, and resend schedules no background work. A null renewal shows the existing fallback.
- Tests:
  - every row of both tables;
  - timezone boundaries, today, past, invalid and null dates;
  - a dated key that also has subscription fields (the key expiry wins);
  - neither "one-time" nor "subscription" is inferred from `expires_at` alone.

### X6. App lifecycle (Should-fix 3)

- The three fields are added to every `LicenseState` constructor (`inactive`, legacy conversion, tests).
- `normalize_api_state` takes them from the payload only. Absent or null → cleared, never inherited. This covers the validate-404 body (`inactive`/`revoked`, no renewal fields).
- The existing carry-over of `activation_token` on a null payload token is documented and not changed.
- TS: `subscription_status?: "active" | "trialing" | "past_due" | "canceled" | "ended" | null`, `renews_at?: string | null`, `ends_at?: string | null`.
- Rust tests:
  - response → commit → reload;
  - active → 404 clears the fields;
  - an old backend (fields absent);
  - explicit nulls;
  - switching keys;
  - deactivate and clear;
  - a network failure keeps the previous snapshot;
  - a past `renews_at` / `ends_at` and any `subscription_status` leave `paid_license`, `pro_access` and `pro_access_until` unchanged.

### X7. Manage subscription (Should-fix 4)

- Shown in both screens, in the active license panel only, when `DISTRIBUTION_FEATURES.externalPurchase`. It opens `LICENSE_PORTAL_URL` through `openExternalUrl`.
- An active license is not taken as proof of a subscription. The portal handles both cases.
- Limitation, recorded: after a revocation the panel is no longer active. Those users reach the same portal through the existing "Lost license key?" button (Direct).
- The App Store flavor shows no button. The Rust allowlist is unchanged and still denies `polar.sh`.
- Tests:
  - the button calls `openExternalUrl` with the portal URL;
  - no button and no call on the App Store flavor;
  - an opening error is handled;
  - the native URL denial test stays.

### X8. Errors and privacy (Should-fix 5)

- Renewal reads run outside the email send `try/catch`, so a renewal failure never ends up in `email_error`.
- The email catch keeps its current behaviour.
- Tests:
  - sentinel customer data (email, key, ids) never appears in captured logs or stored error columns;
  - a mismatched key or customer gives no link;
  - all eleven events reach the snapshot writer and never touch `License` or email;
  - signed invalid and unknown events are still handled as today.

### X9. Migration, rollout and verification (Should-fix 6, Nice-to-have 2)

- **Migration:** `src/migrations/Migration20261020000000AddPolarSubscriptions.ts` creates `polar_license_links`, `polar_subscriptions` and the index `idx_polar_subscriptions_customer`. Both entities are registered in `entities`. It is additive, so existing delivery rows and email fields are untouched.
- **Migration tests (`test/migrations.pg.test.ts`):**
  - fresh database;
  - upgrade from `Migration20261019000000AddTrials` with seeded deliveries preserved;
  - legacy baseline;
  - a second run is a no-op;
  - empty schema diff.
- **Postgres race tests:** concurrent webhook and API upserts on separate connections, reversed delivery, equal and null versions.
- **Rollout:**
  1. Deploy the backend (schema plus handlers). Old apps ignore the new fields; rollback is to redeploy the old backend, which ignores the new tables (no destructive down migration).
  2. Enable `subscription.*` events on the Polar endpoints (sandbox, then production).
  3. Gap: subscriptions changed between the deploy and step 2 are reconciled by the 24 h stale refresh and the link lookup on the next validate, so no separate backfill job is needed.
  4. Release the app.
  - The human checks the production token scopes (`benefits:read`, `subscriptions:read`) and takes a DB backup before step 1.
- **Verification:**
  - backend: lint, prettier, tsc, vitest, plus Postgres including the race tests;
  - app: `cargo test` for the default and the `app-store` feature, `cargo clippy`, `npm run build` and `npm run build:appstore`, `npm run test:run`, and a UI check of both screens in Direct and App Store builds;
  - synthetic SDK-shaped fixtures for cancel → uncancel → cycle and past_due → revoked (no live data).
- Low-cardinality metrics (Nice-to-have 1) are skipped: there is no backend metrics pipeline, and the X4 static log categories cover detection.

### Revision 2 phase plan

1. **Phase 1, backend** (`feat/subscription-renewal` from `feat/polar-sdk-1`): X1, X2, X3 mapping module, X4, X5 email, X8, X9 migration and tests.
2. **Phase 2, app** (`feat/subscription-renewal` from `feat/pro-gating`): X5 presentation, X6, X7, tests for both flavors.

## Revision 3 (addresses Codex Plan re-check, 2026-10-19)

**Supersession.** Revision 3 is the authoritative design. It replaces X1–X5, X8 and X9's rollout/reconciliation text, the original "Deploy Order And Setup" section, and Phase 1 steps 1–8, Phase 2 step 4 and the Revision 2 phase plan.

Kept unchanged:
- D1 (backend is the source of truth), D2 field names, D7, D8 (out of scope);
- X6 (Rust lifecycle) and X7 (Manage subscription);
- Compatibility And Security.

The baseline fallback commit (Revision 2 header) happens only when the user asks for it.

**Main simplification:** there is **no background job**. Revision 2's fire-and-forget refresh caused most of the re-check findings (B1 truncation persistence, S1 cooldown state, S2 runner lifecycle, S4 email hydration). Renewal enrichment is now a bounded, **synchronous**, failure-isolated step inside the request that needs it, with a hard total deadline.

### Y1. Enrichment budget and isolation (replaces X4; S1, S2, N1)

- `src/services/polar-renewal.ts` exposes `resolveRenewal(ctx, deadlineMs = 2500)`.
  - It uses its own Polar client, and gives each call `timeout = remaining budget` (seconds, minimum 0.2). There are no retries and no sleeps.
  - The whole function sits in one `try/catch` that returns `null`. The catch logs only `renewal: <category>` (`timeout|scope|rate_limit|upstream|db|conflict|truncated`), mapped from error classes. Raw errors, ids, emails and SDK bodies never reach `console`, `reportError`, Express or process handlers.
  - DB reads and writes inside it run on `em.fork()`, so a failed flush cannot affect the caller's unit of work.
- **Activate:** called after the activation and DB upserts succeed, so a seat is never lost to enrichment. Worst case it adds 2.5 s, which is well inside the app's 15 s attempt / 30 s operation budget. The license response is returned even when enrichment returns `null`.
- **Validate:** called only on the success path (not the Polar-404 branch).
  - A fresh snapshot (`reconciled_at` < 24 h, and `current_period_end` in the future or a terminal state) is a pure DB read with no Polar call.
  - Otherwise Polar is called within the budget.
  - Validate runs only at app start and on Refresh, so a re-query on every miss is acceptable. No negative cache is stored, which removes S1's unresolved-row state.
- **N1 is resolved:** the first Refresh after a change already shows the new data. There is no two-refresh UX.
- **S2 is resolved by design:** no task outlives the request, and the shutdown path is unchanged.

### Y2. Exact link (replaces X1; B1)

- Table `polar_license_links`, PK `license_key_id`. Columns `grant_id`, `customer_id`, `benefit_id`, `subscription_id` (nullable = confirmed no subscription), `source` (`webhook|lookup`), `created_at`, `updated_at`. All columns except `subscription_id` are NOT NULL. Rows are written only for **conclusive** results.
- **Webhook writer:** grant events with a `license_keys` benefit and `properties.license_key_id`. This runs first in the grant case, before any email exit. The grant → key relation is 1:1 and `subscription_id` / `customer_id` are fixed for a grant, so the write is an insert, or an update only when the stored row has `source = lookup`.
  - If a webhook row already exists with a **different** `grant_id`, `subscription_id` or `customer_id`, the row is deleted and `conflict` is logged. The next validate re-resolves; unknown is shown meanwhile. One single statement: `INSERT … ON CONFLICT (license_key_id) DO UPDATE … WHERE polar_license_links.source = 'lookup' OR (same identity)`, followed by a conflict check.
- **Lookup** (validate/activate only, no row): `benefitGrants.list({ organization_id, customer_id, limit: 100, page: 1 })`, with no `is_granted` filter.
  - `pagination.max_page > 1` → `truncated`: nothing persisted, unknown returned. This is one page only, with no partial-scan conclusions.
  - Matches must have `benefit.type == "license_keys"`, `properties.license_key_id ==` the trusted key id (`validated.id` / `activation.license_key.id`), `customer_id ==` the trusted `customer_id`, and `benefit_id ==` the trusted key's `benefit_id`.
  - Exactly one match → insert with `source = lookup` (`ON CONFLICT DO NOTHING`, so a racing webhook row wins). Zero or several matches → unknown, nothing persisted.
- **Read-time checks:** the cached link's `customer_id` and `benefit_id` must equal the trusted key fields. A fetched subscription's `id` and `customer_id` must equal the link. Any mismatch → `conflict`, the link is deleted and `null` returned.
- Tests:
  - conflict on page 1;
  - truncated (`max_page = 2`);
  - mismatched customer or benefit;
  - subscription/customer mismatch on read;
  - a lookup racing a webhook (both orders, separate Postgres connections);
  - reversed grant events;
  - a webhook replacing a lookup row;
  - a conflicting webhook deleting the row.

### Y3. Snapshot writer (replaces X2; B2)

- `polar_subscriptions`, PK `id`. Columns:
  - `customer_id`, `product_id`, `status`;
  - `current_period_end`, `cancel_at_period_end`, `pause_at_period_end`, `ends_at`, `ended_at`, `trial_end`;
  - `version_ms` (bigint, epoch ms from `modified_at ?? created_at`; NULL when unparseable);
  - `delivered_at`, `reconciled_at` (set only by an API fetch, the authoritative source; a webhook delivery bumps only `delivered_at`), `created_at`.
- `version_ms` is a bigint, not a datetime, so there are no driver datetime mappings to get wrong. Postgres and SQLite bind the same integer.
- One writer, `upsertSubscriptionSnapshot(sub, origin)`, parameterised through `em.getConnection().execute`:

  ```sql
  INSERT ... ON CONFLICT (id) DO UPDATE SET <display fields>, version_ms = excluded.version_ms, <origin timestamp>
  WHERE polar_subscriptions.version_ms IS NULL
     OR (excluded.version_ms IS NOT NULL AND excluded.version_ms > polar_subscriptions.version_ms)
     OR (excluded.version_ms = polar_subscriptions.version_ms AND <display fields equal>)
  ```

  - Null → valid: replaced. Valid → null: kept.
  - Equal and identical: idempotent, and only the origin timestamp is bumped.
  - Equal but conflicting (rare: two different payloads in the same millisecond): the row is kept, and `reconciled_at` is set to NULL, which forces an API fetch on the next validate (Y1). There is no event ranking.
- All eleven `subscription.*` events call it with `origin = webhook`; `subscriptions.get` calls it with `origin = api`.
- Tests on SQLite and on Postgres (separate connections):
  - null → valid, valid → null;
  - equal identical, equal conflicting;
  - offset timestamps normalised;
  - a duplicate delivery does not refresh `reconciled_at`;
  - a webhook and an API write racing.

### Y4. Display mapping (replaces X3; B3)

The first matching rule wins.

| # | Condition | `subscriptionStatus` | `renewsAt` | `endsAt` |
|---|---|---|---|---|
| 1 | `ended_at` set, or status in `canceled`, `unpaid`, `incomplete_expired` | `ended` | — | `ended_at ?? ends_at` |
| 2 | status in `paused`, `incomplete`, or `pause_at_period_end` | `paused` | — | — |
| 3 | `ends_at` set, or `cancel_at_period_end` | `canceled` | — | `ends_at ?? current_period_end` |
| 4 | status `past_due` | `past_due` | — | — |
| 5 | status `trialing` | `trialing` | `trial_end ?? current_period_end` (first payment) | — |
| 6 | status `active`, `current_period_end > now` | `active` | `current_period_end` | — |
| 7 | anything else, or any required date missing or unparseable | null | — | — |

- `subscriptionStatus` adds `paused` to D2's union.
- `subscription.canceled` is an event, so only the stored fields decide.
- A cross-product test covers: terminal × (`ends_at`, `cancel_at_period_end`, `pause`), paused/incomplete × `ends_at`, trialing × cancel, active × past period, and malformed dates.

### Y5. Copy (replaces X5; S3)

App (`src/lib/license/renewal.ts` `renewalPresentation(state, now)`, used by both screens) and email (HTML and text) share this table:

| Case | Label | Value |
|---|---|---|
| Key has a valid `expires_at` | Expires at | `<date>`, then `(in N days)`, `(today)` or `(expired N days ago)` |
| Key `expires_at` unparseable | Expires at | Unknown |
| `active` | Renews on | `<date>` (in N days / today) |
| `trialing` | First payment | `<date>` (in N days / today) |
| `canceled` | Ends on | `<date>` (in N days / today) |
| `past_due` | Payment | Past due. Update your payment method |
| `paused` | Status | Paused |
| `ended` with date | Ended on | `<date>` |
| `ended` without date | Status | Ended |
| null (no info) | Renewal | Renews with your subscription (the user-approved fallback, used only when nothing is known) |

- A known non-renewing state never reaches the fallback row.
- An expected-future date that is past (for example a `renews_at` before `now` in a stale app state) → `Renewal: Renews with your subscription`.
- Email has no `(in N days)`, and dates are UTC "October 19, 2027".

### Y6. Email hydration (replaces the email part of X5; S4)

- Grant webhook: the link is written first (Y2), then the email path calls `resolveRenewal` with the 2.5 s budget. If the link has a `subscription_id` and the snapshot is missing or stale, that call does a `subscriptions.get`. This happens **before** claiming the email, so the claim/sent/error fields are untouched by enrichment.
- Grant email and admin resend both already call `licenseKeys.get(license_key_id)` (`backend:src/services/polar-service.ts:114-120`). Its `customer_id` and `benefit_id` are the trusted identity for Y2, so pre-feature keys without a link take the Y2 lookup on resend too.
- A `null` result → fallback row. The email still sends.
- Tests:
  - grant before the subscription event (hydrated by the API);
  - the subscription event before the grant (DB hit);
  - a pre-feature resend;
  - a missed cancellation (stale → API);
  - an enrichment failure (sends with the fallback; `email_error` not touched).

### Y7. Privacy containment (replaces X8; S2 part)

- Every renewal failure stays inside Y1's catch, so no raw error can reach `app.ts:123-125` or `server.ts:61-63`.
- Sentinel tests inject an SDK error whose message holds an email, a key and ids, then capture `console.*`, `reportError` and the stored error columns, and assert that none contain them.
- Subscription events never change `License` or send email (one test for each of the eleven events).

### Y8. Migration, fixtures, rollout (replaces X9 rollout; S5)

- **Migration:** `src/migrations/Migration20261020000000AddPolarSubscriptions.ts`, appended to `src/migrations/index.ts`.
  - `polar_license_links` and `polar_subscriptions`, with the index `idx_polar_subscriptions_customer`.
  - Both entities are added to `entities`.
  - Migration tests as in X9.
- **Fixtures:** `createPolarMock` gains `benefitGrants.list` and `subscriptions.get`. Fixtures gain `customer_id`, `benefit_id` and `organization_id`, with SDK-shaped `{ items, pagination: { total_count, max_page } }`.
- **Rollout (human steps; nothing done during planning):**
  1. Check API version 2026-10 and the scopes `benefits:read` + `subscriptions:read` on the sandbox and production tokens and webhook endpoints.
  2. Back up the DB.
  3. Deploy the backend. The migration is transactional and all-or-nothing (`src/db/orm.ts:22-28`), and the old backend ignores the new tables on rollback.
  4. Enable `subscription.*` events on both endpoints.
  5. Release the app.
- **Reconciliation:**
  - Keys are enriched on their next validate, or on the next email or resend.
  - A key whose owner never opens the app stays unenriched. That is acceptable for display data.
  - There is no backfill job.

### Revision 3 phase plan

1. **Phase 1, backend:** Y1–Y4 mapping, Y5 email copy, Y6, Y7, Y8.
2. **Phase 2, app:** Y5 presentation, X6, X7, adding `paused` to the TS union and the Rust tests. Tests run for both flavors.

## Revision 4 (addresses Codex Plan re-check 2, 2026-10-19)

**Supersession.** Revision 4 amends Revision 3. It replaces Y2's write/conflict rules, Y3's upsert predicate, Y4 rows 2 and 3, Y5's paused/past-date rows, Y6's claim placement, and Y1's budget sentences. Everything else in Revision 3 stands.

The approach removes the race-prone parts instead of specifying them further: there is no conflict deletion, no display-field comparison and no equal-version reconciliation.

### Z1. Deadline (replaces Y1 budget text; B1)

- `resolveRenewal(ctx)` receives `requestStartedAt`. The budget is `min(2500 ms, 12000 ms − elapsed)`; if 300 ms or less remains, no enrichment step runs and `null` is returned. 12 s keeps at least 3 s of headroom under the app's 15 s per-attempt limit (`app:src-tauri/src/license.rs:25-28`).
- Each Polar call gets `timeout = remaining / 1000` seconds, never rounded up. When the remaining time drops below 300 ms, the next step is skipped.
- **Response deadline = `min(requestStartedAt + 12 s, now + 2.5 s)`**, enforced by **bounded detachment with owned completion**. This supersedes Y1's "no task outlives the request":
  - The caller awaits `Promise.race([work, deadlineTimer])`. On timeout it returns `null` (fallback copy) and the response goes out on time.
  - `work` is the owned resolver promise. It keeps a terminal `.catch` that maps any error to a static category (`renewal: timeout|db|…`) and a `.finally` that clears the timer, so a late completion or rejection is always handled and never becomes an unhandled rejection or a raw log.
  - Steps inside `work` check the deadline before starting. No new Polar call or DB statement starts once the deadline has passed. Polar calls also get `timeout = remaining / 1000` s, never rounded up.
  - DB work is at most six single-row primary-key statements on the fork: link read, insert, winner re-read, snapshot read, upsert, winner re-read. Every write is an idempotent `INSERT … ON CONFLICT`, so a statement that finishes after the response cannot leave inconsistent state.
  - The work is display enrichment only, so no job system is involved. Shutdown is unchanged: `getOrm().close()` waits for checked-out connections (pg-pool drains), so a hung detached statement can hold close until the existing 10 s shutdown timer forces `process.exit(1)` (`backend:src/server.ts:9-20,44-54`). Completion during shutdown is not promised; the writes are atomic and idempotent, so the next request re-runs them whether or not they finished.
- Precise guarantee, replacing "a seat is never lost" / "well inside":
  - enrichment never delays a response past 12 s from request start (plus timer jitter);
  - it runs after the activation is persisted;
  - if the mandatory Polar calls alone exceed the app limit, that is today's behaviour and is unchanged.
- **N1 correction:** a Refresh shows new data when the snapshot is stale (older than 24 h, or the period end has passed) or when a webhook already updated it. A missed webhook inside the 24 h window shows on a Refresh after that window. This is accepted.
- Tests (fake timers, deferred mocks):
  - 11.8 s elapsed (≤ 300 ms left) → no call;
  - a lookup then get that would overrun the budget is cut off after the first step;
  - a Polar call hanging past the deadline → response at the deadline with fallback, and the later rejection is caught and categorised;
  - a DB statement held past the deadline → response at the deadline with fallback; when the statement resolves later the row is consistent and nothing else is logged;
  - a slow (11.8 s) mandatory activate gets no enrichment and still responds;
  - no unhandled rejection is recorded in any case (`process.on("unhandledRejection")` spy).

### Z2. Link writes: first exact writer wins, never deleted (replaces Y2 write and conflict rules; B2)

- Polar grants map 1:1 to license keys, and a grant's `subscription_id`, `customer_id` and `benefit_id` never change. Both writers (the grant webhook and the exact lookup) therefore write the same identity.
- Columns: `license_key_id` (PK), `grant_id`, `customer_id`, `benefit_id`, `subscription_id` (nullable), `created_at`. The `source` column is dropped.
- Both writers use `INSERT … ON CONFLICT (license_key_id) DO NOTHING`, then **re-read** the stored row and use only that winning row.
- Read-time check on every use: the stored `customer_id` and `benefit_id` equal the trusted key fields. A fetched subscription's `id` must equal the stored `subscription_id`, and its `customer_id` must equal the stored `customer_id`.
  - Mismatch → `null` (fallback copy) and the log line `renewal: conflict`.
  - **Nothing is deleted or rewritten**, so there are no compare-and-delete races. A real conflict would mean corrupt Polar data; it stays visible in logs, is safe (fallback only), and an operator can remove the row by hand.
- A webhook whose identity differs from the stored row logs `renewal: conflict` and leaves the row as is.
- Tests (SQLite, plus Postgres on separate connections):
  - a lookup racing a webhook in both orders: one row, both callers return the winning row's renewal;
  - a stored row with a different benefit or customer: unknown, row kept;
  - an A→B→A conflicting delivery: the first row is kept, conflict logged twice;
  - a lookup insert losing to a webhook: the winner is used.

### Z3. Snapshot writes: API authoritative, webhooks strictly newer (replaces Y3 predicate; B3)

- `version_ms` is a bigint (unchanged). Two predicates, both null-safe and with no display-field comparison:
  - **webhook:** `WHERE stored.version_ms IS NULL OR (excluded.version_ms IS NOT NULL AND excluded.version_ms > stored.version_ms)`, then `delivered_at` is set. An equal-version webhook (a redelivery) is ignored.
  - **API** (`subscriptions.get`): `WHERE stored.version_ms IS NULL OR excluded.version_ms IS NULL OR excluded.version_ms >= stored.version_ms`, then `reconciled_at` is set.
    - An API fetch reflects Polar's current state at read time, so it wins ties.
    - An API response older than a webhook that landed meanwhile is rejected, so the newer webhook survives.
    - An API result with no version wins (it is authoritative), and a later webhook with a version then replaces it under the first predicate.
- After the upsert the resolver **re-reads** the row and maps whatever is stored. A rejected API write does not set `reconciled_at`, so the next stale check fetches again.
- Equal-version conflicting payloads resolve deterministically: the API wins, and an equal-version webhook never overwrites.
- Display timestamps (`current_period_end`, `ends_at`, `ended_at`, `trial_end`) are stored as bigint epoch ms as well (`*_ms`). Both drivers then bind plain integers and no datetime mapping is involved.
- Tests on both databases:
  - null → valid, valid → null (webhook ignored, API applied);
  - an equal-version webhook is ignored;
  - an equal-version API write is applied;
  - webhook → API → duplicate webhook keeps the API data;
  - an older API response racing a newer webhook keeps the webhook data;
  - `reconciled_at` is unchanged on a rejected API write.

### Z4. Mapping and copy fixes (replaces Y4 rows 2–3 and Y5 paused/past rows; S2)

Revised Y4 order (the first match wins):

| # | Condition | `subscriptionStatus` | date |
|---|---|---|---|
| 1 | terminal (as Y4 row 1), or `cancel_at_period_end`/`ends_at` with the end date already past | `ended` | `endsAt = ended_at ?? ends_at ?? current_period_end` |
| 2 | status `paused` | `paused` | — |
| 3 | `pause_at_period_end` | `pausing` | `endsAt = current_period_end` |
| 4 | status `incomplete` | `incomplete` | — |
| 5 | `ends_at` set or `cancel_at_period_end` | `canceled` | `endsAt = ends_at ?? current_period_end` |
| 6–8 | Y4 rows 4–6 (`past_due`, `trialing`, `active`) | unchanged | unchanged |
| 9 | anything else | null | — |

Copy additions:

| Status | Label | Value |
|---|---|---|
| `pausing` | Pauses on | `<date>` |
| `paused` | Status | Paused |
| `incomplete` | Status | Payment pending |

- A required date that is missing or unparseable keeps the known status, with no date: for example "Status: Canceled", "Status: Ends at period end" and "Status: Renews automatically".
- The fallback "Renews with your subscription" appears **only** when `subscriptionStatus` is null.
- In the app, a past `renews_at` on a stale `active` state shows "Status: Renews automatically", not a past date.
- `subscriptionStatus` union: `active | trialing | past_due | canceled | pausing | paused | incomplete | ended`.
- Tests for every row and each missing-date variant, on both screens and in HTML and text email.

### Z5. Webhook failure boundaries (S1)

- **Grant events:** the link write is wrapped in its own `try/catch`. On failure the code logs `renewal: db` and **continues** the mandatory email/revocation flow unchanged. The link is optional, and a later validate does an exact lookup.
- **`subscription.*` events:** a snapshot-write failure throws `AppError(503, "RENEWAL_SYNC_FAILED")` with no cause attached, so Polar retries. The original error is mapped to a category and logged as `renewal: db`, and it never reaches `app.ts:123-125`.
- Sentinel tests: injected DB and SDK errors with an email, key and ids in the message, for the link insert, snapshot upsert and resolver, captured across `console.*`, `reportError` and the stored error columns.

### Z6. Email placement (replaces Y6 claim placement; S3)

- The existing order in `sendLicenseEmailForGrant` is kept: claim, `licenseKeys.get`, send (`backend:src/services/polar-service.ts:107-139`).
- `resolveRenewal` is inserted **after** `licenseKeys.get` and before the send, inside the claim, and with its own catch (Z1/Y1). Its failure yields `null`, never reaches the email catch, and never writes `email_error`.
- The claim TTL (5 min) is far above the 2.5 s budget.
- Mandatory failures (key get, send) keep today's `LICENSE_EMAIL_FAILED` recording, retry and claim release. A successful send still clears `email_error`, as it does today. "Not touched" means not touched by enrichment.
- Tests:
  - an enrichment failure sends with the fallback, and a previous `email_error` follows today's rules;
  - concurrent grant and resend: only the claim winner sends;
  - a key-get failure keeps today's behaviour.

## Plan Review

Review date: 2026-10-19. Read-only inspection of both working trees and the installed SDK; no network calls, token inspection, application edits, or runtime tests. `app:` paths below are relative to this repository; `backend:` paths are relative to `/Users/lamtung/projects/startup/politedb/politedb-backend`. Line references to this plan refer to the draft above this section. SDK evidence uses the **2026-10** entry point, which exports `models-P8aaHkKR` and `index-CgqeU9bV` (`backend:node_modules/@polar-sh/sdk/dist/2026-10/index.d.mts:1-4`). Existing uncommitted changes in both repositories were inspected and left intact.

### Blocker

1. **D4 cannot guarantee that renewal belongs to the caller's key.** Choosing the customer's configured-product subscription with the latest period end can attach another subscription to this key, including a one-time key belonging to a customer who also subscribes. Product filtering and a single candidate do not prove ownership. `active: true` also cannot serve as a complete historical resolver for ended/unpaid keys. This contradicts the key-specific privacy contract. Evidence: `app:.agent/plans/subscription-renewal.md:56,107,125`; `backend:node_modules/@polar-sh/sdk/dist/2026-10/services/subscriptions.d.mts:4-22` exposes a paginated customer/product search, not a license-key join.

   **Required:** Prefer the webhook's exact grant link; for older keys, use `polar.benefitGrants.list({ customer_id, organization_id, page, limit })`, match the license-key benefit and **exact** `properties.license_key_id`, then fetch `subscriptions.get(grant.subscription_id)`. Do not restrict discovery to currently granted benefits if historical links are needed. Check customer identity against the trusted validate/activate result and subscription, and organization/benefit consistency; unresolved/conflicting links return unknown, never a guessed subscription. Paginate within the D6 budget. The SDK exposes `BenefitGrant.subscription_id`, `customer_id`, `benefit_id`, and license-key properties (`backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:2642-2710,3180-3188`). Listing requires **`benefits:read`** (or write), subscription reads require **`subscriptions:read`** (or write): `backend:node_modules/@polar-sh/sdk/dist/2026-10/services/benefit_grants.d.mts:4-24`; `backend:node_modules/@polar-sh/sdk/dist/2026-10/services/subscriptions.d.mts:24-34`. Existing benefit reads do not establish the token's actual scopes; list these deployment requirements without claiming live verification.

   `customers.getState(id)` is another SDK endpoint, requiring `customers:read` (or write), but **not a better exact join**: it returns active subscriptions and granted benefits, while `CustomerStateBenefitGrant` has no `subscription_id`. Matching a benefit shared by multiple subscriptions is ambiguous. Evidence: `backend:node_modules/@polar-sh/sdk/dist/2026-10/services/customers/index.mjs:282-305`; `backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:9743-9775,10108-10114`. Avoid adding this broader customer-data fetch unless needed.

2. **D3 merges terminal nonpayment with recoverable delinquency and ignores explicit termination signals.** The installed SDK says `subscription.past_due` is recoverable, but `subscription.revoked` means immediate loss of access, including exhausted retries where status becomes `unpaid`. Mapping both to “Payment past due” with a renewal date is misleading. `ended_at` means actual end; `ends_at` means scheduled end; `cancel_at_period_end` alone is not the only information to inspect. Evidence: `app:.agent/plans/subscription-renewal.md:21,50-55`; `backend:node_modules/@polar-sh/sdk/dist/index-CgqeU9bV.d.mts:2572-2578,2651-2655`; `backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:19319-19361`.

   **Required:** Define ordered, mutually exclusive display rules: actual termination / terminal `canceled`, `unpaid`, `incomplete_expired` must not advertise renewal; scheduled end (`ends_at`, including cancellation during trial) must not advertise renewal; recoverable `past_due` must not claim `current_period_end` is a promised payment-retry date; only an eligible auto-renewing active subscription gets the renewal label. Define trial wording (`trial_end`/first charge versus renewal), and paused/scheduled-pause wording or an explicit unknown fallback that does not promise renewal. Preserve unknown for unsupported combinations rather than inventing dates. `revoked` is an **event**, not a SubscriptionStatus enum member; do not add it as a raw SDK status or make event name alone override a newer snapshot. Cancellation event is not proof of termination (`backend:node_modules/@polar-sh/sdk/dist/index-CgqeU9bV.d.mts:2457-2479`; status enum at `backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:303`). Keep all of these rules display-only; D8 remains out of scope.

3. **D6 does not isolate latency or post-activation side effects.** Catching a lookup failure is insufficient: the shared Polar client allows **15 seconds per request**, and an exact fallback may need several requests/pages. App requests have a **15-second attempt / 30-second operation** budget. An optional lookup can therefore time out an otherwise successful validate, or time out after activation already consumed a seat. Evidence: `backend:src/libs/polar.ts:4-5,17-23`; `backend:src/services/polar-license-key.ts:424-443`; `app:src-tauri/src/license.rs:19-28,933-938`; `app:.agent/plans/subscription-renewal.md:58,69,72`.

   **Required:** Specify a small total renewal-enrichment budget, per-call SDK timeout overrides, bounded pagination, no foreground retry/sleep, request coalescing, and cooldown/negative caching for absent links, missing scope and failures. Handle 429 `retryAfter` without delaying license responses; prefer a separate enrichment budget/client so mandatory license calls keep their settings. `RequestOptions.timeout` and `PolarRateLimitError.retryAfter` exist (`backend:node_modules/@polar-sh/sdk/dist/base-C7LedWf8.d.mts:15-18,34-38`). Isolate cache write failures too, using an independent ORM unit of work so a caught failed flush cannot poison later license/email writes. Test a hanging fallback, partial lookup failure, DB write failure, repeated misses and 429, asserting successful license response within the enrichment deadline and unchanged activation/email side effects.

4. **The proposed cache does not specify durable exact links or recovery from missed updates.** Phase 1 caches subscriptions, but older keys have no delivery/grant row linking them to that cache. Merely storing the subscription cannot make the next key lookup a cache hit. Once a subscription row exists, D1 never refreshes it: missed cancellation/renewal webhooks leave an apparently authoritative date forever. A new app calling an old backend and a stale backend snapshot are different cases. Evidence: `app:.agent/plans/subscription-renewal.md:48,56,64-69,124`; `backend:src/db/entities.ts:33-43`; `backend:src/services/polar-license-delivery.ts:8-37` requires grant id/customer email and stores email-delivery state.

   **Required:** Define where fallback-derived **key → grant → subscription** identity persists, including keys without an email delivery and grants with `subscription_id = null`. Do not fabricate delivery/email records or overwrite sent/claim/error fields merely to cache identity. Define link cardinality/conflict handling. Add a bounded backend stale-refresh/reconciliation policy and freshness metadata; use exact `subscriptions.get(id)` when link exists but snapshot is absent/stale. This is server-side display freshness, not periodic app validation or offline grace. Test cache hit without another discovery call, exact-link precedence, and missed webhook recovery.

### Should-fix

1. **D5 needs an atomic ordering contract, including fallback writes.** “Only newer” does not prevent two concurrent requests from reading the same version and committing in reverse order. SDK `modified_at` is nullable; compare parsed instants using `modified_at ?? created_at`, not timestamp strings or backend receipt time. Specify duplicate/equal timestamp behavior, missing/invalid timestamp handling, and conflict/reconciliation behavior rather than arbitrary event-type ranking. Apply conditional insert/update to webhook **and API** snapshots; an old API response must not overwrite a newer webhook. Grant-link writes also need protection from delayed `created` events erasing a newer key/link. Evidence: `app:.agent/plans/subscription-renewal.md:57,68,71`; `backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:19269-19281`; `backend:src/services/polar-license-delivery.ts:15-37` currently uses read/mutate/flush and assigns absent ids to null. Add independent-connection Postgres races, duplicate insert, reversed delivery, equal/null timestamp and API/webhook race tests; serial SQLite tests alone cannot validate this contract.

2. **Specify shared UI and email copy for every mapped state.** Phase 2 says “D3 status text” without defining ended, trialing, malformed date, unknown status, past dates or scheduled end without a date. Current expiry row wrappers differ between Settings and dialog; decide whether the shared component owns the label or returns shared presentation data, so “Expires at: Renews on …” cannot appear. Keep real key-expiry precedence. Email must carry a separate renewal DTO through `LicenseEmailInput`, not repurpose `expiresAt`, and render the same canceled/ended/past-due distinctions in HTML **and text**, including admin resend. Otherwise cancellation resends revert to “Renews with your subscription.” Evidence: `app:.agent/plans/subscription-renewal.md:49,73,91`; `app:src/components/settings/LicenseKeySettings.tsx:150-172`; `app:src/components/modal/LicenseDialog.tsx:187-203`; `backend:src/services/license-email.ts:1-10,58-77,142-144`; `backend:src/services/polar-service.ts:114-132,198-219`. Test timezone boundaries, today/past/invalid dates, null dates and dated keys with subscription fields. Do not infer “one-time” solely from a non-null expiry, nor subscription ownership solely from null expiry.

3. **App persistence approach is compatible, but lifecycle/404 regression coverage is incomplete.** Optional Rust fields with defaults, camelCase API aliases, snake_case state serialization and unchanged state version fit existing version-1 loading. Also initialize fields in `LicenseState::inactive`, all explicit state constructors and legacy conversion paths. TS fields should accept `string | null`, with a narrowed status union if useful. On the backend validate **Polar-404** path, the HTTP success body contains `inactive`/`revoked` and no renewal fields; `normalize_api_state` must clear all three rather than inherit them. It currently preserves previous activation token when the payload token is null; document this existing behavior without expanding scope to fix it. Evidence: `backend:src/services/polar-license-key.ts:458-477`; `app:src-tauri/src/license.rs:228-259,596-604,795-815,1090-1102`; `app:src/lib/tauri/license.ts:25-38`. Add end-to-end Rust response→commit→reload tests for active→404, old backend, explicit nulls, switching keys, deactivate/clear, and network failure retaining the previous snapshot. Prove `subscription_status`, past `renews_at` **and** past `ends_at` never change entitlement/pro_access_until; retain existing expiry/trial/race tests. D8 needs no change.

4. **Manage button policy is sound; baseline StoreKit claim is premature.** Direct-only `externalPurchase` plus the fixed portal URL and Rust URL enforcement matches existing policy. However D7 says “MAS uses StoreKit”; current Rust explicitly keeps MAS ungated **until IAP exists**. Correct this baseline without adding IAP work. Clarify whether button appears in both screens and whether inactive/revoked subscription owners can still manage payment after validation removes the active license panel. If deliberately active-only, record that limitation; do not treat an active perpetual license as confirmed subscription ownership. Evidence: `app:.agent/plans/subscription-renewal.md:59,92`; `app:src-tauri/src/distribution.rs:38-44,53-55,143-149`; `app:src/components/settings/LicenseKeySettings.tsx:66,134-135,180-196`; `app:src/components/modal/LicenseDialog.tsx:228-245`; `app:src/lib/license/proAccess.ts:27-28`. Test real openExternalUrl invocation, no call/button in MAS, opening errors, and retained native denial of the portal URL. Do not weaken the allowlist.

5. **Persist links independently of email delivery and keep renewal failures out of email error persistence.** Today's handler returns early when email is missing and routes grant persistence through email orchestration. An old/sent email or disabled mail must not prevent link synchronization; persist the grant identity before those exits. Keep lookup errors out of the broad send-email catch, which currently persists `error.message`; classify errors using an allowlisted static category rather than serializing SDK responses, customer state, grant payloads, raw Error objects/messages or arbitrary names. Evidence: `backend:src/services/polar-service.ts:135-138,143-175,277-285`; `backend:src/services/polar-license-delivery.ts:86-96`; `app:.agent/plans/subscription-renewal.md:58,71,107`. Add log/error-storage capture tests with sensitive sentinel data, cross-customer/mismatched-key tests and signed invalid/unknown webhook tests. Verify all eleven subscription event variants route to the same snapshot updater and never mutate `License.status` or send a license email. The draft's eleven-event set and listed Subscription fields match the installed SDK (`backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:343,19269-19369`); migrated has extra top-level provider metadata, still `data: Subscription` (`backend:node_modules/@polar-sh/sdk/dist/index-CgqeU9bV.d.mts:2537-2570`).

6. **Complete migration and rollout details.** Correct paths to **`src/migrations/index.ts`** and `src/db/orm.ts`; register the new schema in the exported `entities` array or runtime/SQLite tests will not know it exists. Specify nullable Polar timestamps, timestamp precision sufficient for D5, indexes and upgrade data preservation; a key-id index alone is not a uniqueness/cardinality policy. Evidence: `backend:src/migrations/index.ts:6-22`; `backend:src/db/entities.ts:111-129,149`; `backend:test/helpers.ts:7-12`; `backend:test/migrations.pg.test.ts:58-89,106-115`. Test fresh/previous/legacy upgrade, existing delivery email fields retained, migration second run and empty schema diff. Update mocks with customer ids and exact-grant pagination, not only subscriptions (`backend:test/helpers.ts:33-44,64-74`).

   Current deploy order enables subscription events while old backend acknowledges and ignores them, potentially losing updates. Deploy additive schema/handler first, enable events next, then explicitly reconcile/backfill the gap before app rollout. Include sandbox and production API version/scopes, migration failure/backup procedure, and rollback compatibility (old backend may ignore display tables without destructive down migration). Evidence: `app:.agent/plans/subscription-renewal.md:97-102`; `backend:src/services/polar-service.ts:324-329,343-356`; `backend:src/db/orm.ts:22-26`. Keep sandbox redelivery/token changes as future human steps, not actions during this review. Verification should exercise both app distribution builds and actual UI layouts, plus Postgres races; default-feature cargo tests alone do not prove MAS wiring.

### Nice-to-have

1. **Add low-cardinality operational visibility for renewal freshness.** Static counters for cache hit/miss, timeout, scope failure, rate limit and stale snapshot help detect silent perpetual fallback without logging customer/key/subscription identifiers. Evidence: `app:.agent/plans/subscription-renewal.md:58,123-124`. Keep metrics optional and consistent with current telemetry/privacy policy.

2. **Make the review/verification handoff reproducible.** Record base commits and pre-existing dirty files for both phases; include exact commands and results after implementation. Store SDK fixture payloads for cancel→uncancel→cycle and past_due→revoked, using local synthetic data. Evidence: `app:.agent/plans/subscription-renewal.md:13-14,44,74-84,113-119`; `app:.agent/WORKFLOW.md:34-38`. No live subscription semantics or production scope was verified here.

**Readiness: NOT READY.** Resolve exact key ownership, terminal/scheduled status mapping, bounded enrichment failures, and durable/fresh caching before approval. Then incorporate ordering, lifecycle, email, migration and rollout tests above. The additive display-only architecture is viable; entitlement and D8 stay unchanged.

### Plan re-check (Codex)

Re-check date: 2026-10-19. Read `AGENTS.md`, the referenced RTK instructions, and `.agent/WORKFLOW.md`; inspected both working trees and installed Polar **2026-10** SDK/MikroORM sources without network calls, token inspection, runtime tests, application edits, or commits. Only this subsection is added. Verified HEADs: app `9d7cf53`, backend `c0a50f4`; the fallback-related dirty files match Revision 2's recorded baseline (app also has untracked plan/launch files). “Resolved” below means resolved **in the plan**, not implemented or runtime-verified. X1–X9 supersede the earlier decisions/steps as stated; D8 stays out of scope. `plan:` means this file; `app:` and `backend:` retain the roots above.

#### Previous findings

| Previous finding | Result | Evidence and remaining gap |
|---|---|---|
| Blocker 1 — exact key ownership | **Partially resolved** | X1 removes subscription guessing and uses supported `benefitGrants.list` parameters, historical grants, exact `properties.license_key_id`, and trusted `customer_id`; scopes are correctly listed (`plan:136-149`; `backend:node_modules/@polar-sh/sdk/dist/2026-10/services/benefit_grants.d.mts:4-16`; `backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:2672-2710,3180-3188`). Exhaustive-search/truncation rules, fetched-subscription identity validation, and conflicting webhook-link precedence remain unspecified; see B1. |
| Blocker 2 — terminal/scheduled semantics | **Partially resolved** | X3 separates terminal `unpaid` from `past_due`, checks `ended_at` and scheduled `ends_at`, removes a retry-date promise, and keeps `revoked` an event (`plan:163-179`). Scheduled pause still falls through to active renewal, and unknown copy still promises renewal; see B3/S3. |
| Blocker 3 — latency and side-effect isolation | **Partially resolved** | X4 removes optional upstream calls from foreground enrichment, provides a separate 3-second client, a page cap, no retries, coalescing and `em.fork()` (`plan:183-194`). These are compatible with the installed SDK's timeout in **seconds** and ORM fork boundary (`backend:node_modules/@polar-sh/sdk/dist/base-C7LedWf8.d.mts:25-38`; `backend:node_modules/@mikro-orm/sql/SqlEntityManager.d.ts:36-65`). Foreground cache failures, negative-cache representation, cooldown enforcement, shutdown, and deterministic tests remain; see S1/S2. |
| Blocker 4 — durable links/freshness | **Partially resolved** | Independent key-PK links and `synced_at`/24-hour exact-id refresh solve the main architecture gap without fabricating email records (`plan:136-147,153-162,184-194`; existing email-owned entity: `backend:src/db/entities.ts:33-43`). Null-subscription rows, misses without a link row, permanent bad/conflicting links, and freshness on duplicate deliveries are not yet safe; see B1/B2/S1. |
| Should-fix 1 — atomic ordering | **Partially resolved** | X2 makes API and webhook writes share one conditional SQL writer and requires independent-connection Postgres races (`plan:159-164,264`). SQL shape is viable on both engines, but its null behavior contradicts the stated policy; `>=` accepts divergent ties, and links have no version/CAS contract; see B1/B2. |
| Should-fix 2 — shared copy/email | **Partially resolved** | X5 specifies shared app presentation, real key-expiry precedence, a separate email DTO, both email formats/admin resend, and boundary tests (`plan:198-215`). This addresses the existing different wrappers and expiry-only email API (`app:src/components/settings/LicenseKeySettings.tsx:150-172`; `app:src/components/modal/LicenseDialog.tsx:187-203`; `backend:src/services/license-email.ts:1-10,142-144`). Unknown/paused, first-charge and undated-ended wording remain inconsistent; cache-only email hydration is incomplete; see S3/S4. |
| Should-fix 3 — Rust lifecycle/404 | **Resolved** | Original Phase 2 preserves aliases, optional/defaulted fields and state version; X6 adds every constructor, payload-only clearing, token-carryover documentation and response→commit→reload/key-switch/clear/network/entitlement tests (`plan:88-95,219-231`). Matches `app:src-tauri/src/license.rs:228-259,795-815,1090-1102` and the backend HTTP-success Polar-404 body at `backend:src/services/polar-license-key.ts:458-477`. Retain existing expiry/trial/race coverage during implementation. |
| Should-fix 4 — Manage scope/MAS baseline | **Resolved** | D7 now correctly says MAS remains ungated until IAP; X7 explicitly covers both screens, active-panel scope, perpetual-license ambiguity, inactive owners' existing portal route, opening errors, Direct/MAS tests and native denial (`plan:59,235-243`). Matches `app:src-tauri/src/distribution.rs:38-55`, `app:src/components/settings/LicenseKeySettings.tsx:55-66,97-120`, and `app:src/components/modal/LicenseDialog.tsx:228-245`. No IAP expansion needed. |
| Should-fix 5 — email-independent links/privacy | **Partially resolved** | X1 persists links before email exits; X2/X8 specify all eleven subscription events, no entitlement/email effects, static categories and sentinel capture tests (`plan:142,163-164,193,247-253`). This fixes the intended path around today's exits/catch (`backend:src/services/polar-service.ts:135-175,264-329`). Merely moving renewal I/O outside the email catch does not catch its failures: generic Express/process sinks log raw errors; see S2. Existing unrelated email-error behavior can remain unchanged. |
| Should-fix 6 — migrations/rollout/verification | **Partially resolved** | X9 adds entity registration, additive schema, fresh/previous/legacy/no-op/diff tests, Postgres races, backend-first rollout, backup, compatible rollback and both app flavors (`plan:257-274`). Baseline correctly identifies explicit migration registration (`plan:33`; `backend:src/migrations/index.ts:6-22`; `backend:src/db/orm.ts:22-39`). Recovery claims depend on unresolved refresh/email behavior; exact-grant mocks/customer fixtures and SDK version checks for both environments should be explicit; see S4/S5. |
| Nice-to-have 1 — operational visibility | **Open (explicitly deferred)** | X9 intentionally skips metrics and substitutes static failure categories (`plan:193,275`). Acceptable non-blocking decision; failure logs do not measure cache freshness/hit rate. |
| Nice-to-have 2 — reproducible handoff | **Resolved** | Base commits/dirty task files are recorded and match inspection (`plan:130`); existing exact command list plus X9's two-flavor/race verification and synthetic transition fixtures establish a reproducible implementation handoff (`plan:113-119,264,271-274`). Record actual results after implementation, without treating this read-only re-check as test execution. |

#### Remaining / newly exposed Blockers

1. **B1 — Finish the exact-link contract before treating a cached row as authoritative.** X1's query and exact key/customer match are correct, but “exactly one” cannot be established from a partial scan. The SDK returns `{ items, pagination: { total_count, max_page } }`, not an array; page defaults to 1 (`backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:13507-13515,17050-17058`; `backend:node_modules/@polar-sh/sdk/dist/2026-10/services/benefit_grants.mjs:19-30,52-60`). With X4's three-page cap (`plan:189`), define incomplete traversal as unresolved even if one candidate was seen, and never persist a conclusive no-link/null-subscription result from a truncated search. Validate the fetched subscription's `id` and `customer_id` against the link and trusted license result, plus organization/benefit consistency against the key; persist the benefit identity or document how that check is recovered (`plan:136-147`; trusted identity fields: `backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:21697-21717`; subscription identity: same file `19279-19281,19363-19369`). Apply the checks on cached reads as well as discovery. Finally, source preference is not ordering: two webhook rows can still replace different non-null subscriptions/customers in either arrival order, and a lookup racing a webhook needs an atomic source guard. Define immutable identity/conflict handling or grant-version conditional writes; conflicting identities return unknown and reconcile. Do not permanently mask a newer conflicting grant just because the old subscription id was non-null. Test second/later-page conflicts, page-cap exhaustion, subscription/customer mismatch, lookup/webhook races and reversed grant events.

2. **B2 — X2's SQL does not implement its null/tie/freshness policy yet.** `excluded.polar_version_at >= stored.polar_version_at` evaluates to unknown when either side is null. A first invalid-version row accepted under `plan:161` can therefore never be repaired by a later valid snapshot. Define an explicit nullable version representation and predicate: valid incoming versions may replace unknown stored versions; invalid incoming versions never overwrite a known row. The single-statement `ON CONFLICT … DO UPDATE … WHERE` approach itself is compatible; the remaining portability work is binding/serialization and null semantics, not a claim that SQLite lacks conditional upserts. Installed MikroORM exposes parameterized `em.execute` and dialect-aware Kysely (`backend:node_modules/@mikro-orm/sql/SqlEntityManager.d.ts:36-72`); Postgres datetime maps to `timestamptz`, while SQLite maps to `datetime` and converts `Date` values to numeric epoch milliseconds (`backend:node_modules/@mikro-orm/sql/dialects/postgresql/BasePostgreSqlPlatform.js:74-79`; `backend:node_modules/@mikro-orm/sql/dialects/sqlite/SqlitePlatform.js:32-37,80-90`). Specify how the chosen writer uses those mappings or explicit dialect bindings; avoid mixing raw ISO strings with numeric SQLite timestamps.

   `>=` makes identical duplicate payloads idempotent, **not divergent equal-version payloads**. An older API response or delayed webhook with the same parsed millisecond can overwrite a cancellation/renewal and be marked fresh (`plan:156,159-162`). Millisecond normalization can also collapse distinct finer-grained timestamps; the SDK declares strings, not guaranteed millisecond uniqueness (`backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:19271-19277`). Define the accepted precision and a deterministic equal-version conflict policy (e.g. detect differing display fields, retain unknown/conflict and request authoritative reconciliation); no arbitrary event ranking. Separate last delivery from last authoritative reconciliation: duplicate webhooks must not continually bump `synced_at` and suppress the promised missed-update refresh. Add null→valid, valid→null, equal-identical, equal-conflicting, offset/precision and duplicate-delivery freshness tests on SQLite and Postgres.

3. **B3 — X3 promises renewal for scheduled pauses.** Rule 5 matches `status = active` plus a future period end before rule 6's “pause scheduled”; X2 does not even store `pause_at_period_end` (`plan:155,176-177`). Polar explicitly provides that boolean (`backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:19351-19361`). Persist it and test it before any active/trial renewal promise, with neutral pause/unknown presentation. Guard unsupported states before broad schedule rules where needed: `paused`/`incomplete` plus `ends_at` currently matches rule 2, contradicting the claimed rule-6 fallback (`plan:173-177`). Write a cross-product table for terminal, scheduled end, delinquent, trial, paused/scheduled-pause and malformed dates. Preserve actual termination precedence; event `subscription.canceled` is not by itself terminal (SDK: `backend:node_modules/@polar-sh/sdk/dist/index-CgqeU9bV.d.mts:2457-2479`). D8 remains untouched.

#### Remaining / newly exposed Should-fix

1. **S1 — Make refresh state representable and enforce cooldown for every path.** X1 says zero/conflicting matches store nothing but set negative-cache columns on that same link row (`plan:136-146`); no row exists to hold those columns, and no policy makes unresolved `grant_id`/customer/source fields nullable. Use explicit unresolved/resolved states or a separate bounded cooldown store; distinguish unresolved from a confirmed grant with `subscription_id = null`. The latter is a valid no-subscription result, not a call to `subscriptions.get(null)`. X4 applies `next_lookup_at` only to missing-link discovery; linked stale/missing/past-period snapshots bypass it (`plan:185-193`). Gate all refreshes, including repeated 404/403/429/DB failures and successful refresh of an ended subscription whose period stays in the past. Treat `retryAfter` as finite seconds converted to an absolute deadline (`backend:node_modules/@polar-sh/sdk/dist/base-C7LedWf8.d.mts:15-18`), and contain failures while recording failure state. Coalescing is process-local only; document expected multiple-instance behavior and bound/clean maps. Inject clock/client/store; tests must await an exported refresh promise/drain hook, never sleep or assume response completion means the job finished. Test repeated misses, absent scopes, 429, confirmed null links, expired periods, DB-write failure and cleanup after rejection.

2. **S2 — Specify background ownership, failure containment and lifecycle.** Render deployment here runs a long-lived Node Express process (`backend:package.json:6-10`; `backend:README.md:293-306`), so returning an HTTP response does not inherently cancel work. It also does not guarantee completion: current shutdown waits only for HTTP connections, closes ORM and exits; its budget is 10 seconds (`backend:src/server.ts:9-20,44-54`). Three 3-second list calls plus one 3-second subscription call already total up to 12 seconds before DB work (`plan:188-192`). Define a tracked best-effort runner with a whole-job deadline, terminal catch/finally, no new jobs during shutdown, and bounded drain/cancel before ORM closure, or explicitly accept drop-on-restart with reliable next-request retry. A durable queue is not required for display enrichment. `em.fork()` provides isolation, not task lifetime or exception handling. Foreground cache reads still add DB I/O and may fail after activation consumed a seat; X4's “no Polar calls” must mean **no additional enrichment calls**, since required activation/validation calls remain (`backend:src/services/polar-license-key.ts:417-443,450-457`). Catch optional read/scheduling failures and return nulls without changing mandatory calls or email claims. Moving renewal I/O outside the email catch alone is insufficient (`plan:247`): raw errors otherwise reach `backend:src/app.ts:123-125` or `backend:src/server.ts:61-63`, leaking SDK/DB details despite static-category intent. Include failure-recording and runner-cleanup failures in the sanitized boundary. Test response latency/seat effects with a deferred hanging refresh, completion after response, shutdown/drop-and-retry, no unhandled rejection, and sentinel errors through all sinks.

3. **S3 — Resolve copy contradictions without erasing known status.** `plan:179` says unknown promises no renewal, but `plan:208` explicitly says “Renews with your subscription,” also for paused/incomplete/expired expected dates; that is not neutral. Preserve the user-approved existing fallback for genuinely unavailable renewal information if required, but do not route a **known** paused/unsupported/nonrenewing state into a renewal assertion. Specify neutral wording or an explicit additional display state. Trial first charge is not a renewal (`plan:175,204`); use “First payment on …”/equivalent rather than “then renews.” A known ended subscription without a date should read “Status: Ended” or similar, not “Ended on: Ended” (`plan:207`). Specify today/zero-day wording and invalid real-expiry behavior. Apply identical decisions to both app screens and HTML/text email, with focused tests.

4. **S4 — Cache-only emails have an unresolved hydration/order gap.** X1 persists only identity on grant events; X2 subscription webhooks supply snapshots; X4 refresh is triggered by activate/validate; X5 says grant email and resend read DB only and resend schedules no work (`plan:142,163,184-186,210`). There is no ordering guarantee that a subscription event precedes the grant email. An existing customer's resend after rollout can also remain fallback indefinitely until they validate or a later subscription event arrives. X9's on-next-validate reconciliation is therefore eventual app refresh, not a complete email backfill (`plan:268`). Define what happens when a trusted subscription link exists but its snapshot is missing/stale at send time: a bounded failure-isolated hydration before sending, deferred email enrichment under the existing claim/retry policy, or an explicit approved limitation. Do not overwrite sent/claim/error fields just to refresh display data. Test grant-before-subscription, subscription-before-grant, pre-feature resend with no app validate, missed cancellation and enrichment failure. Existing send/claim/resend entry points are `backend:src/services/polar-service.ts:107-139,143-184,198-219`.

5. **S5 — Close verification/rollout details and precedence wording.** Explicitly add the new migration to `src/migrations/index.ts`, extend `createPolarMock` with `benefitGrants.list` and subscription get, and add trusted customer/organization/benefit ids plus SDK-shaped pagination to fixtures (`backend:test/helpers.ts:33-44,64-74`; `backend:src/migrations/index.ts:6-22`). Require sanitized negative-cache/background failures and exact-link races, not just snapshot races. Confirm sandbox **and** production endpoint API version/scopes as human deployment checks; no token contents need recording. Existing migration transactions already provide all-or-nothing failure behavior (`backend:src/db/orm.ts:22-28`). State that on-demand reconciliation can require a second validate and cannot refresh emails/unvisited keys by itself; do not describe step 3 as an unconditional completed backfill. X9's build scripts and Rust feature names do exist (`app:package.json:12-13`; `app:src-tauri/Cargo.toml:109-113`). Finally, widen the supersession notice: `plan:132` only replaces D3–D6/Phase 1, while X5 also changes Phase 2's component design, X9 reverses Deploy Order, and the proposed separate baseline commit at `plan:130` still requires a human request (`plan:14`; `.agent/WORKFLOW.md:48`). Make the revised rules unambiguous without committing during this review.

#### Nice-to-have

1. **N1 — Explicitly accept the two-refresh UX.** X4's first Refresh returns cached/null data, and only a later Refresh shows enrichment (`plan:184,194`; app validates only on start/Refresh, `plan:42`). Document this in acceptance criteria; consider a neutral pending hint if desired. No app polling or D8 change is required.

**Readiness: NOT READY.** X6 and X7 resolve their earlier plan findings; the exact-link direction, shared presentation and isolated background design are viable. Resolve B1–B3 and specify S1–S5 before approval so Claude can implement one coherent, testable contract. No live Polar/Render behavior, production scopes, SQL execution, build or runtime tests were verified in this read-only re-check.


### Plan re-check 2 (Codex)

Review date: 2026-10-19. Revision 3 (Y1–Y8) is authoritative; earlier superseded designs are not approval requirements. Local read-only inspection of both codebases, the installed Polar **2026-10** SDK and MikroORM **7.2.5**; only this plan edited. No network calls, token inspection, application changes, commits, builds, SQL execution or runtime tests. `plan:` references use the line numbers before this subsection; `app:` and `backend:` retain the meanings above. D8 remains out of scope.

#### Re-check findings disposition

| Finding from Plan re-check | Disposition | Evidence / remaining work |
|---|---|---|
| B1 — exact-link completeness, identity and races | **Partially resolved** | Y2 rejects `max_page > 1`, matches exact key/customer/benefit, adds cached identity checks and gives lookup `ON CONFLICT DO NOTHING` (`plan:311-327`). This matches the installed list response/iterator (`backend:node_modules/@polar-sh/sdk/dist/2026-10/services/benefit_grants.mjs:19-30,52-60`) and trusted key identity fields (`backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:21709-21735`). Conflict deletion and post-insert winner handling remain underspecified; see B2 below. |
| B2 — nullable versions, ties, SQL portability and freshness | **Partially resolved** | Y3's integer version and explicit stored-null branch repair null→valid; valid→null is rejected. Separating `delivered_at` from API-only `reconciled_at` fixes duplicate-webhook freshness (`plan:331-355`). Nullable display equality, equal-version API reconciliation and atomic conflict invalidation remain unresolved; see B3 below. Integer versions alone also do not serialize the other date columns. |
| B3 — pause and mapping rule order | **Resolved** | Y3 stores `pause_at_period_end`; Y4 tests terminal first, then paused/incomplete/scheduled pause, then cancellation and renewable states, with cross-product coverage (`plan:333,359-373`). These fields exist in the 2026-10 model (`backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:19314-19361`). A canceled event does not itself determine terminal status. Presentation details remain under S2 below. |
| S1 — unresolved cache state, cooldown and bounded runner state | **Resolved** | No negative-cache row or background/in-flight map remains. Y1/Y2 deliberately allow one-page lookup on each miss and persist only conclusive links; null subscription is explicitly confirmed no-subscription (`plan:300-306,311-318`). No cooldown or distributed coalescing is needed for the stated scope. Hard deadline still needs B1 below. |
| S2 — ownership, failure containment and lifecycle | **Partially resolved** | Request-owned synchronous work removes the background drain/lifetime requirement. Fork isolation is real: MikroORM defaults to `clear = true`, `useContext = false`, and does not inherit a transaction unless requested (`backend:node_modules/@mikro-orm/core/EntityManager.js:1974-2004`); existing `getEm()` already forks (`backend:src/db/orm.ts:62-64`). Y1 catches resolver failures, but does not enforce its whole-function deadline or cover the separate webhook writers; see B1/S1 below. |
| S3 — copy contradictions | **Partially resolved** | Y5 fixes first-payment wording, ended-without-date, malformed real expiry and today wording, and shares app/email decisions (`plan:375-394`). Known `incomplete`, scheduled pause and expired end-date cases still produce misleading status/fallback copy; see S2 below. |
| S4 — email hydration/order gap | **Partially resolved** | Y6 adds bounded hydration for both grant mail and pre-feature resend, removing dependence on prior app validation (`plan:396-406`). Current key fetch happens after an acquired claim, whereas Y6 requires its trusted identity before claiming; specify the rearrangement and failure behavior, see S3 below (`backend:src/services/polar-service.ts:107-139`). |
| S5 — verification, rollout and precedence | **Resolved** | Y8 explicitly registers migration/entities, extends mocks/identity/pagination fixtures, checks both environments and keeps backup/backend-first/compatible rollback/no backfill (`plan:414-430`). X9 migration and verification requirements are retained (`plan:257-264,271-274`), matching explicit migration registration and pinned schema tests (`backend:src/migrations/index.ts:6-22`; `backend:test/migrations.pg.test.ts:57-69,106-114`). Revision 3 clearly supersedes original deploy/phase rules and makes the baseline commit conditional on a user request (`plan:284-291,432-435`). Runtime verification remains implementation work. |
| N1 — two-refresh UX | **Partially resolved** | Synchronous successful enrichment can populate the current response, so there is no background completion to await. However, Y1's fresh-cache path deliberately makes no API call; “first Refresh after a change already shows the new data” is false for a missed webhook within the 24 h freshness window, or timeout/truncation (`plan:303-307`). State the conditional acceptance criterion; no polling or entitlement change needed. |

#### Remaining / newly exposed Blockers

1. **B1 — Specify an enforceable total deadline, including DB work, and account for the existing request budget.** `plan:298-301` specifies only per-Polar-call timeouts. A 0.2 s minimum exceeds the remaining budget when less than 200 ms remains; DB reads, pool acquisition and writes have no bound. Stop before starting work when budget is exhausted, never round a timeout above the remaining allowance, and propagate a whole-operation deadline through DB operations as well as SDK calls. The SDK supports per-call timeout in seconds and uses `AbortSignal.timeout` for fetch (`backend:node_modules/@polar-sh/sdk/dist/base-C7LedWf8.d.mts:29-36`; `backend:node_modules/@polar-sh/sdk/dist/base-Cir88A-B.mjs:87-110`), but that does not cancel DB work. Installed MikroORM exposes fork-level cancellation through **`em.execute`**, while Y3 chooses **`em.getConnection().execute`**, which needs cancellation passed explicitly (`backend:node_modules/@mikro-orm/sql/SqlEntityManager.d.ts:60-72`; `backend:node_modules/@mikro-orm/sql/AbstractSqlConnection.js:259-269`). Specify cancellation/cleanup behavior for in-flight queries; a bare `Promise.race` must not leave uncontrolled writes after the resolver returns.

   Running enrichment after seat persistence does not guarantee the app receives that seat's token. The app's **15 s limit covers the entire HTTP attempt**, not an extra 15 s available for enrichment; 30 s is an outer limit, not a retry allowance after that timeout (`app:src-tauri/src/license.rs:25-28,933-958,960-965`). The backend already permits 15 s per mandatory Polar call (`backend:src/libs/polar.ts:5-6,24-28`), and activation makes several such calls before enrichment (`backend:src/services/polar-license-key.ts:412-443`). For example, an otherwise successful 13 s activation plus 2.5 s enrichment times out after the seat was consumed. Define an additive latency budget relative to request start (skip/shorten enrichment when mandatory work leaves insufficient app-response headroom), without redesigning existing activation behavior. Replace “a seat is never lost” / “well inside” with this precise guarantee. Test deferred DB work, exhausted/<200 ms budget, sequential lookup→get, and a slow-but-successful mandatory activation/validate; fallback must return within the intended response budget.

2. **B2 — Make link conflict cleanup conditional and consume the persisted winner.** Y2's upsert and subsequent conflict check/delete are separate operations (`plan:312-319`). Example: A observes a conflicting webhook row, B removes/reconciles it and installs a valid row, then A deletes B's row by key. Read-time mismatch deletion has the same race. Specify an atomic transaction/locking strategy or compare-and-delete against the exact observed identity/version; include `benefit_id` in identity comparisons. The SQL's `source = lookup OR same identity` also allows *any* webhook identity to replace a lookup row, so read-time trusted checks must run on the actual winning row before returning data.

   After lookup `ON CONFLICT DO NOTHING`, re-read the winning row and validate it; never continue with the discarded lookup candidate. Define the result when the winning row disappears or conflicts again: unknown, without unbounded retry. Mere deletion does not retain a conflict marker, so an older webhook can subsequently insert the old identity again; either explicitly accept re-resolution with full read-time checks or define a bounded conflict policy. Tests must assert returned identity/unknown, not just final inserts: lookup/webhook races in both orders, deletion racing replacement, differing benefit identities and conflicting A→B→A deliveries. The new tables have no existing implementation to supply these semantics; current delivery writes are unrelated email state (`backend:src/services/polar-license-delivery.ts:9-45`).

3. **B3 — Finish null-safe equal-version reconciliation and its atomic update rules.** Y3 leaves `<display fields equal>` undefined (`plan:339-349`). Typical snapshots have null `ends_at`, `ended_at` and `trial_end` (`backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:19314-19349`). Comparing these with `=` yields SQL unknown even for identical payloads; the equal-version branch then does not update `reconciled_at`. Specify null-safe equality for every nullable compared field, e.g. `(a = b OR (a IS NULL AND b IS NULL))`, or equivalent tested dialect expressions. Compare normalized stored values. Bigint fixes version ordering, but other timestamps still require consistent schema/bindings on both drivers; SQLite's Date conversion is separate (`backend:node_modules/@mikro-orm/sql/dialects/sqlite/SqlitePlatform.js:80-90`).

   More fundamentally, equal-version conflicting **API** data is kept out forever: webhook snapshot A, authoritative get B with the same millisecond, keep A and clear `reconciled_at`, then every get B repeats that conflict. A renewal/cancellation remains wrong indefinitely despite successful authoritative reads. Define how an API result resolves an equal-version conflict (with appropriate protection against a delayed equal-version webhook), or return unknown until a defined reconciliation can resolve it. Do not claim the API resolved the conflict while returning A. Define the conflict-invalidating write atomically too: a late conflict check must not clear reconciliation for a newer snapshot installed concurrently. State what a rejected older API response does to `reconciled_at` and which snapshot the resolver returns after a race. Tests: nullable equal-identical refresh; equal-conflicting webhook→API→duplicate webhook; conflict invalidation racing a newer version; older API racing newer webhook. Existing planned equal/race tests should assert these outcomes on both databases.

#### Remaining / newly exposed Should-fix

1. **S1 — Extend the sanitized failure boundary to webhook link/snapshot writes.** Y7 says every renewal failure is inside Y1, but grant links and eleven subscription-event writes execute separately before email exits (`plan:312-313,350,408-412`). Their exceptions never enter `resolveRenewal`. A DB error there can reach the generic raw-error/reporting sink (`backend:src/app.ts:123-125`), or block the grant's existing email/revocation flow (`backend:src/services/polar-service.ts:264-329`). Specify a small renewal boundary for **each entry point**, with static category mapping and deliberate webhook acknowledgement/retry policy. Optional link enrichment must not prevent the mandatory grant action. Retriable snapshot-write failure may use a sanitized retryable error, without forwarding the original DB/SDK error. Add sentinel failures for webhook insert, conflict check/delete and snapshot conflict handling, not only SDK errors inside the resolver. Keep unrelated existing error handling outside scope.

2. **S2 — Avoid describing incomplete/scheduled pause as already paused, and retain known end status.** Y4 maps both `status = incomplete` and active `pause_at_period_end` to `paused`; Y5 renders both `Status: Paused` (`plan:364,389`). The SDK distinguishes a future pause flag from an actual pause (`backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:19351-19361`); an incomplete subscription has not become paused either. Choose accurate neutral presentation for those known states, using only the minimal display contract needed. Also scope Y5's past-future-date fallback: an already-past `ends_at` on known `canceled` must not become “Renews with your subscription” (`plan:386,392-394`). Preserve the known cancellation/end information with suitable past-date wording. Missing/unparseable required-date checks should preserve known status where possible; Y4's final rule must not contradict Y5's “only when nothing is known” promise. Cover these cases in both screens and HTML/text mail. No billing or entitlement expansion required.

3. **S3 — Specify pre-claim trusted-key retrieval without regressing claim/failure behavior.** Current `sendLicenseEmailForGrant` acquires the atomic claim **before** `licenseKeys.get`, then records fetch/send failures and releases the claim in its catch (`backend:src/services/polar-service.ts:107-139`; claim guard: `backend:src/services/polar-license-delivery.ts:66-99`). Y6 requires resolver hydration before claiming, but resolver needs the identity from that same get (`plan:398-400`). State whether get moves before claim, is duplicated, or stays after claim with the hydration placement adjusted. If moved, preserve retriable `LICENSE_EMAIL_FAILED` handling/recording for mandatory get failure, reuse the fetched key for sending, and still honor the final atomic claim result before sending. Concurrent requests may hydrate, but only the claim winner sends; failed optional hydration still permits sending. Add tests for concurrent grant/resend claims, mandatory get failure before claim, successful retry, and enrichment failure with a previous `email_error`. “email_error not touched” must mean **by enrichment**; normal successful send currently clears it (`backend:src/services/polar-license-delivery.ts:102-111`).

#### Nice-to-have

No new scope requested. Existing metrics deferral remains acceptable. Correct N1's unconditional first-Refresh sentence as noted above; retain the deliberate 24 h cache policy and D8 exclusion.

**Readiness: NOT READY.** Revision 3 substantially simplifies ownership, lookup completeness, fixtures and rollout. Resolve B1–B3 and specify S1–S3 so implementation has one correct, testable deadline, conflict, reconciliation and email contract. No application implementation or runtime verification performed.


### Plan re-check 3 (Codex)

Review date: 2026-10-19. Revision 4 amends Revision 3 under its stated supersession. Read-only verification against both repositories, installed Polar 2026-10 SDK and MikroORM 7.2.5; only this plan changed. No network calls, application changes, commits, SQL execution, builds or runtime tests. `plan:` denotes this file; `app:` denotes this repository; `backend:` denotes `/Users/lamtung/projects/startup/politedb/politedb-backend`. Line references precede this appended subsection.

#### Re-check-2 findings disposition

The identifiers below refer to the **Remaining / newly exposed** findings in Plan re-check 2, rather than the older findings repeated in its disposition table.

| Finding | Disposition | Evidence |
|---|---|---|
| B1 — enforceable total deadline and existing request budget | **Partially resolved** | Z1 supplies request-start-relative headroom, removes the 200 ms minimum, and skips near-exhausted work (`plan:445-456`). This accounts for the app's whole-attempt 15 s timeout (`app:src-tauri/src/license.rs:25-28,947-958`) and mandatory activation work before enrichment (`backend:src/services/polar-license-key.ts:417-443`). However, waiting for unbounded DB work cannot enforce the stated cap; see retained B1 below. |
| B2 — link conflict cleanup and persisted winner | **Resolved** | Both writers insert without replacement, re-read the winner, validate trusted customer/benefit and fetched subscription identity, and never delete (`plan:461-472`). Trusted key fields exist in the installed SDK (`backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:21713-21733`); the retained exact one-page lookup uses supported list filters and checks pagination (`plan:314-318`; `backend:node_modules/@polar-sh/sdk/dist/2026-10/services/benefit_grants.mjs:19-30,52-60`). No mutable conflict invalidation remains. Persistent conflicts degrading to fallback without auto-repair are accepted. |
| B3 — null-safe equal-version reconciliation and atomic updates | **Resolved** | Z3 eliminates nullable display comparisons and the separate invalidation write. API wins equal versions, equal webhooks cannot overwrite it, older versioned API results are rejected, and the resolver reads the persisted winner (`plan:476-491`). Display dates also become integer epoch values. Explicit no-version API precedence is accepted; tests distinguish it from webhook precedence. These predicates require no dialect-specific nullable equality or datetime binding. SQL execution and integer entity/schema mappings still require the planned implementation tests on both databases. |
| S1 — sanitized webhook failure boundaries | **Resolved** | Z5 isolates optional grant-link failures while preserving mandatory actions, and converts subscription-write failures to a static retryable AppError (`plan:523-525`). This matches separate email/revocation branches (`backend:src/services/polar-service.ts:264-312`). The two-argument constructor is valid (`backend:src/errors.ts:8-16`), and AppError exits before raw reporting (`backend:src/app.ts:97-103,123-125`). Sentinel coverage includes webhook writers as well as the resolver. |
| S2 — accurate incomplete/pause/end presentation | **Resolved** | Z4 distinguishes actual pause, scheduled pause and incomplete payment; past cancellation ends become ended; missing dates retain known status; stale app renewal dates get neutral copy (`plan:499-519`). The SDK distinguishes pause scheduling from actual pause and exposes separate end timestamps (`backend:node_modules/@polar-sh/sdk/dist/models-P8aaHkKR.d.mts:19327-19361`). Both screens and HTML/text mail are explicitly covered. |
| S3 — trusted-key retrieval and email claim order | **Resolved** | Z6 keeps claim → key get → optional enrichment → send, with mandatory failure recording/release unchanged (`plan:529-536`). This fits the current order (`backend:src/services/polar-service.ts:107-139`), atomic claim (`backend:src/services/polar-license-delivery.ts:60-75`), and normal sent/failed cleanup (`backend:src/services/polar-license-delivery.ts:78-96`). No pre-claim get or duplicate fetch is needed. Optional enrichment cannot populate email_error. Its claimed time bound depends on B1. |
| N1 — conditional first-Refresh acceptance | **Resolved** | Z1 explicitly accepts missed webhooks inside the 24 h cache window and conditions immediate visibility on stale data or an already-applied webhook (`plan:452`). No polling, grace-window or entitlement expansion is required. |

Earlier findings already closed in re-check 2 remain closed: no background runner/negative-cache state was reintroduced; X6/X7 lifecycle and distribution rules remain retained (`plan:284-291`); migration/entity/mock registration and backend-first rollout remain specified (`plan:414-430`), matching explicit migration registration and pinned schema tests (`backend:src/migrations/index.ts:6-22`; `backend:test/migrations.pg.test.ts:57-69,106-114`).

#### Retained Blocker

1. **B1 — Z1 still cannot implement or test its hard response deadline as written.** `plan:447` allows an in-flight DB statement to finish without a timeout and forbids abandonment, while `plan:449` promises enrichment never delays the response beyond 12 s. A statement started at 11.5 s can wait on a pool/lock beyond the app's 15 s timeout; idempotence protects data, not response latency. Installed connection execution awaits connection availability and query execution without an automatic resolver deadline (`backend:node_modules/@mikro-orm/sql/AbstractSqlConnection.js:259-268`). Fork isolation does not supply that deadline. MikroORM exposes explicit cancellation via `em.execute`/fork options (`backend:node_modules/@mikro-orm/sql/SqlEntityManager.d.ts:60-72`), but the retained connection-level call does not inherit those automatically.

   Specify one coherent implementation contract for the existing cap: bound DB acquisition/execution and cleanup, or explicitly define bounded response detachment with owned, caught completion for the already-idempotent statement. The latter must explicitly supersede Y1's “no task outlives the request” promise; a bare unowned race remains insufficient. No new job system or scope growth is needed. Also correct the associated acceptance contradictions: link read → insert → winner read and snapshot read → upsert → winner read exceed “at most two statements” (`plan:447,463,482`); 11 s elapsed leaves 1 s under the stated formula, so it does not automatically skip enrichment (`plan:445,456`); “write completing after return” requires a defined detach mechanism, which the current waiting rule excludes (`plan:447,457`). Test a DB wait crossing the cap and assert response timing plus safe completion/cancellation, rather than only final DB state.

#### New findings

No new Blocker, Should-fix or Nice-to-have beyond retained B1. The first-writer conflict policy, API tie precedence, 24 h visibility trade-off and D8 exclusion are accepted as documented.

**Readiness: NOT READY.** B2–B3, S1–S3 and N1 are resolved. Finish B1's internally consistent DB/deadline and acceptance contract before approval. Runtime correctness remains subject to the implementation's planned verification.


### Plan re-check 4 (Codex)

Review date: 2026-10-20. Read `AGENTS.md` and `.agent/WORKFLOW.md`; re-checked the rewritten Revision 4 Z1 against local backend source and installed Polar SDK/MikroORM/PostgreSQL pool implementation. Only this plan file edited. No network calls, application changes, commits, SQL execution, builds or runtime tests. `plan:` denotes this file; `app:` denotes this repository; `backend:` denotes `/Users/lamtung/projects/startup/politedb/politedb-backend`. References precede this subsection.

#### Retained B1 disposition

**B1 — Resolved.** Z1 now chooses the bounded response-detachment option explicitly permitted by re-check 3 (`plan:712-714`): the caller races an owned resolver promise against the absolute deadline; the resolver retains terminal sanitized error handling and timer cleanup, and starts no further step after expiry (`plan:445-450`). An already-issued query may finish after fallback, but it no longer holds the response open. This supplies the missing deadline even though connection execution itself awaits acquisition/execution without a resolver timeout (`backend:node_modules/@mikro-orm/sql/AbstractSqlConnection.js:259-268`). Catch/finally must belong to the handled promise chain used as `work`, as specified, rather than create an ignored rejecting side chain. The backend's raw unhandled-rejection sink makes the planned late-rejection coverage meaningful (`backend:src/server.ts:61-64`).

Z1 explicitly supersedes Y1's no-task-outlives-request rule, corrects the maximum to six PK statements, and relies on the retained first-writer link insert and version-guarded snapshot upsert for safe late writes (`plan:447-451,468-472,478-486`). The 11.8 s example correctly leaves only 200 ms and skips enrichment. The request-relative cap and existing mandatory-work caveat remain consistent with the app's 15 s whole-attempt limit and activation persistence before enrichment (`plan:445,453-463`; `app:src-tauri/src/license.rs:25-28,947-958`; `backend:src/services/polar-license-key.ts:417-443`). Deferred Polar/DB mocks now explicitly test timely fallback, late completion/rejection and no unhandled rejection (`plan:458-464`). These are implementation acceptance tests, not results verified in this review.

#### New findings

- **Blockers: none.** No new correctness, security, privacy or testability blocker identified. Accepted conflict policy, API tie precedence, 24 h cache visibility and D8 exclusion remain closed. Bounded detachment itself is the explicitly accepted B1 remedy; no cancellation subsystem, job runner or expanded scope requested.
- **Should-fix S1 — Correct the shutdown explanation (non-blocking).** `plan:452` says existing ORM close cuts off a running detached statement. It actually drains: `getOrm().close()` is awaited after HTTP close (`backend:src/server.ts:11-20,44-54`); MikroORM delegates close to the driver, SQL connection destroys Kysely, and PostgreSQL driver awaits `pool.end()` (`backend:node_modules/@mikro-orm/core/MikroORM.js:158-161`; `backend:node_modules/@mikro-orm/sql/AbstractSqlConnection.js:59-63`; `backend:node_modules/kysely/dist/dialect/postgres/postgres-driver.js:73-77`). The installed pool removes idle clients and waits for checked-out clients, rather than cancelling their active queries (`backend:node_modules/pg-pool/index.js:127-144,488-498`). A hung query can therefore hold close until the existing 10 s shutdown timer forces `process.exit(1)` (`backend:src/server.ts:9,44-49`). Replace the cancellation claim with that existing drain/forced-exit behavior; do not promise detached completion during shutdown. Atomic idempotent writes permit retry on a later request whether completion occurred or not. This wording correction requires no backend shutdown change and does not invalidate the response deadline or safe late-write contract.
- **Nice-to-have: none.**

**Readiness: READY.** Retained B1 is resolved; no blockers remain. S1 is a non-blocking correction to the explanation of existing shutdown behavior. Plan remains DRAFT pending human approval; implementation and its planned runtime verification remain Claude's work.
