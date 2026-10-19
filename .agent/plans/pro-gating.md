# Pro Feature Gating

## Status

APPROVED (Revision 5). Decisions D1–D8, D2b, D2c, D2d and D9 are settled. **Revision 5 overrides Revisions 2–4 where they differ.** Codex re-review of Revision 5: **READY**. **APPROVED by the user on 2026-10-19** ("tôi duyệt, làm phase 1 đi"). Phase 1 IMPLEMENTED and committed (Codex: VERIFIED WITH LIMITATIONS after 2 rounds). Phase 2 (backend) committed on `politedb-backend` branch `feat/trial-endpoint` (Codex: VERIFIED WITH LIMITATIONS after 2 rounds; not deployed). Phase 3 committed (Codex: VERIFIED WITH LIMITATIONS after 2 rounds). Claude /security-review on 2026-10-19: no findings at confidence 8 or higher (app `origin/main...cb3c2ed`, backend `origin/main...8b1290b`). Next: backend push/deploy with TRUST_PROXY and smoke checks, then release (D9).

## Task

- ID: pro-gating
- **Request (user, 2026-10-19):** the feature list below. When the trial ends, only the Pro features lock ("hết trial thì chỉ khóa tính năng pro").
- **Decisions (user, 2026-10-19):** D1 Free, D2 trial stored on the backend, D3 App Store not handled now, D4 no lock, D5 fall back to chat plus a hint, D6 raw EXPLAIN stays free, D7 only SVG export is Pro, D8 badges for everyone.
- **Branch:** `feat/pro-gating` (worktree `politedb-app-pro-gating`). It already holds `99a5f22` "feat(license): gate Pro features behind a license or trial". That commit is unpushed, written in another session before these decisions, and based on main before PR #62. It merges cleanly onto current `origin/main` (`57de05f`).
- **Second repo:** D2 needs a change in `politedb-backend`.
- **Workflow:**
  1. Codex plan critique.
  2. User approval.
  3. Implement.
  4. Codex review, once per repo.
  5. Claude `/security-review` (license-sensitive scope).
- No commit/push unless requested.

## Product scope (from the user)

**Free:**
- all engines; unlimited connections and tabs;
- SQL editor, history, snippets; grid and structure editing;
- SSH, SSL, keychain;
- export CSV/JSON/SQL, import CSV; safety modes;
- DBeaver/TablePlus import;
- basic AI chat (BYO key or Ollama).

**Pro:**
1. Backup/restore.
2. AI agent mode.
3. Visual query analyzer (EXPLAIN view plus suggestions).
4. Health inspector (PostgreSQL).
5. ER diagram export to SVG.
6. Column masking on export.

## Baseline: what `99a5f22` already does

- **Rust (`license.rs`):**
  - `LicenseState` gains `plan` (the license API's normalized tier, `"pro"`/`"free"`) and `pro_access`.
  - `finalize_state` and `license_state_save` recompute `pro_access` and never trust it from input: active license (unless `plan == "free"`) or a running local trial.
  - `Distribution::gates_pro_features()` is false for the App Store, which keeps everything unlocked there.
- **Frontend:**
  - `src/lib/license/proAccess.ts` provides `ProFeature`, `hasProAccess`, `PRO_REQUIRED` and `proRequiredError`.
  - `useProGate().requirePro(feature)` plus `stores/proUpgrade.ts` and `ProUpgradeDialogHost` give one upgrade dialog (enter key / pricing), mounted in `layout/index.tsx`.
  - `ProBadge` marks the gated entry points.
- **Gates:**
  - Backup/restore, **including SQL dump import** (`useDatabaseBackup.ts`).
  - The **whole Explain** button (`useSqlRunner.ts`, `SqlEditorToolbar.tsx`).
  - The health inspector (`MenuBar.tsx`).
  - **All ER diagram export** (`DiagramGeneratorDialog.tsx`).
  - Masking, in both the dialog and `runStreamingExport.ts`.
- **Missing:** the AI agent gate, since the agent was not on main yet.

## Changes needed to match the decisions

### A. Entitlement (D1, D2, D3)

**A1. D1, unknown plan → Free.** Pro needs a positive paid signal. Replace the "active unless plan is free" rule:
- `status == "active"` (after `apply_local_expiry`) **and** either:
  - `plan` equals `"pro"` (case-insensitive, trimmed), or
  - `plan` is absent (older servers) **and** `plan_name`, normalized (trimmed, lowercase, trailing `plan` removed), is `pro` or `ultimate`.
- Anything else is Free: an empty or unknown `plan_name`, or any other `plan` value.
- Use one Rust function and test it with the same table as `planFromLicensePlanName` in `src/lib/politedbBackend/ai.ts`. That function moves to `src/lib/license/proAccess.ts` and keeps sending `"ultimate"` to the AI gateway.

**A2. D2, trial on the backend.** The server records the first trial start per `(product, device_id)` and is the source of the trial window.

- **Backend (`politedb-backend`):**
  - Endpoint: `POST /api/v1/trial`, with body `{ product, device: { device_id, device_name, platform, arch } }`. It reuses the zod `deviceSchema` from `polar-license-key.ts` and `licenseRateLimit`.
  - Logic: find or create the row by `(product, device_id)`. The first call sets `trialStartedAt = now` and `trialExpiresAt = now + 14 days`. Later calls return the stored row unchanged and update `lastSeenAt`.
  - Concurrent inserts: catch the unique-constraint violation and re-read the row.
  - Response: `{ trialStartedAt, trialExpiresAt, now }` in epoch ms (camelCase, like the other responses). `now` is server time, so the app can refuse a far-off local clock.
  - Business errors use `AppError` and never return 404.
  - Storage: a `Trial` entity in `src/db/entities.ts` (id, product, device_id, device_name, platform, arch, trial_started_at, trial_expires_at, created_at, last_seen_at), unique on `(product, device_id)`.
  - Migration `Migration20261019…AddTrials`: SQL from `npm run db:diff`, registered in `src/migrations/index.ts`, with a Postgres migration test case.
  - Tests (`test/trial.test.ts`, `setupTestOrm`):
    - first call creates the row and a repeat call returns the same start;
    - a different product gets its own row;
    - expiry, using `vi.setSystemTime`;
    - invalid payload → 400;
    - the concurrent-create path.
- **App (Rust, `license.rs`):**
  - New `license_trial_sync`, called by the license store's `load` on the Direct flavor only. It posts to the same base and fallback URL candidates used for the other license actions (action `trial`).
  - On success it stores the server window in `trial_started_at` / `trial_expires_at` and sets a new `trial_source: "server"`. The server window always replaces the local one.
  - **Offline or first launch without a server answer:** keep a provisional local window so that a first launch offline still works.
    - The provisional trial counts as Pro for at most 14 days from its local start.
    - On the next successful sync, the server window replaces it.
  - **Deleting the local file** now only restores a provisional window. The next sync gets back the server's original start, so the trial cannot be extended past the server's expiry while the app is online.
  - **Clock check:** if the server `now` differs from local time by more than 24 hours, the trial counts as expired until the clock is fixed. This blocks winding the clock back while online.
  - No new secret and no signature in this revision; see Risks.
- **App (frontend):** `useLicenseStore.load` calls the sync after loading, without blocking the UI. The upgrade dialog and the settings keep the "Free trial ends on…" text.

**A3. D3, App Store not handled now.** Keep `99a5f22`'s behavior: the App Store flavor gates nothing (`gates_pro_features() == false`) and does not call the trial endpoint. StoreKit is a separate plan.

### B. Per-feature changes

1. **Backup/restore (D4, no lock on SQL import).**
   - Gate only the database-level **Backup** and **Restore** actions in the MenuBar (`onBackupDatabase`, `onRestoreDatabase`).
   - Remove the gate from `onImportSqlDump`, the table-level "From SQL Dump…" (`LeftNavItemsPane.tsx:298`, `MainTableDataPane.tsx:138`, `ConnectionScreen.tsx:624`). It stays free, like CSV import.
2. **AI agent (D5).** Add the gate, since the agent is now on main.
   - **Frontend:** in `useAiAssistantSubmit.ts`, the agent branch is taken only when `hasProAccess()` is true. Without Pro, the turn goes to the legacy assistant exactly like the existing unsupported-engine fallback: history filtered by `withoutData`, and no data-access consent card.
   - **Hint:** the panel shows one dismissible line under the answer, e.g. "Agent mode (looks up your schema and runs read-only queries) is a Pro feature. Upgrade". Upgrade opens the shared dialog.
     - It appears at most once per chat.
     - Dismissal is stored per viewer in `localStorage`, wrapped in try/catch.
   - **Backend:**
     - `ai_agent_start` checks `pro_access` from the finalized license state first and fails with `AI_AGENT_PRO_REQUIRED` before any provider or database work.
     - `ai_agent_data_access_grant` gets the same check.
     - The code is **not** added to `FALLBACK_CODES`. The UI gate normally prevents the call, so the error is shown with fixed EN/VI copy only when the state is stale or was edited.
   - **Feature id:** add `"ai-agent"` to `ProFeature` and `PRO_FEATURE_LABELS`.
3. **Query analyzer (D6, raw EXPLAIN stays free).**
   - Remove the gate from the Explain button and from `startExplain`, so Explain runs for everyone.
   - In `SqlResultsPane`, a Free user sees the raw EXPLAIN result in the normal result grid. The `QueryAnalyzer` panel (visual plan tree, Recommendations, Markdown/JSON report export) shows a locked state with a Pro badge and Upgrade instead of rendering.
   - The gate sits around the analyzer render and the report-export handlers.
4. **Health inspector:** unchanged from `99a5f22`.
5. **ER diagram (D7):**
   - Remove the gate from PNG export. Copy Mermaid stays free.
   - Add **Export as SVG**: `buildDiagramSvg` → save dialog (`.svg`) → `writeFile`. It is gated as `"er-diagram-export"`, with the label changed to "ER diagram export to SVG".
6. **Masking:** unchanged from `99a5f22`, in both the dialog and the pipeline.

### C. Badges (D8)

Show `ProBadge` on every gated entry point for all tiers, Free, trial and Pro alike:
- the Backup/Restore buttons;
- the health inspector menu item;
- the "Export as SVG" button;
- the masking controls;
- the analyzer panel header.

Check that `99a5f22` does not hide the badges for Pro users.

### D. Trial end

When the trial ends, only the Pro features lock. `TrialExpiredOverlay` (unmounted, with copy that says everything locks) is deleted.

## Tests

- **Rust:**
  - **Entitlement table:**
    - active with `plan` pro or free;
    - active, `plan` absent, `plan_name` Pro / "Ultimate" / " Pro plan " / "Polar License" / empty;
    - expired, invalid, error;
    - provisional trial within and beyond 14 days;
    - server trial in the future and in the past;
    - clock skew over 24 h;
    - App Store flavor.
  - **Trial sync:** the server window replaces the local one, and an offline sync keeps the provisional window. Parsing is tested with mocked HTTP using the existing loopback fixture pattern.
  - **Agent:** `ai_agent_start` and `ai_agent_data_access_grant` return `AI_AGENT_PRO_REQUIRED` for Free before any network or database access.
- **Backend:** `test/trial.test.ts` as above, plus the Postgres migration test.
- **Frontend:**
  - Agent without Pro: legacy path with filtered history, no `aiAgentStart` call, and the hint shown once and dismissible.
  - Agent with Pro or trial: unchanged.
  - Explain for Free shows the raw grid, the analyzer is locked, and report export is blocked.
  - PNG export is free; SVG export is gated, and with Pro it writes a valid `<svg>`.
  - SQL dump import is free; database Backup/Restore are gated.
  - Badges are present for Pro too.
  - The `planFromLicensePlanName` table is shared with the Rust rule.
- **Regression:** the existing suites for backup, export, diagram, health inspector, analyzer and agent pass with Pro mocked in.

## Files (expected)

- **politedb-app:**
  - `src-tauri/src/license.rs`, `commands/license.rs`, `main.rs` (trial sync command);
  - `commands/ai_agent.rs`, `commands/ai_agent_data.rs`;
  - `src/lib/license/proAccess.ts`, `src/lib/politedbBackend/ai.ts`, `src/stores/license.ts`, `src/lib/tauri/license.ts` / `commands.ts`;
  - `useAiAssistantSubmit.ts`, `AiAssistantPanel.tsx` (hint);
  - `SqlResultsPane.tsx` / `QueryAnalyzer.tsx`, `useSqlRunner.ts`, `SqlEditorToolbar.tsx`;
  - `DiagramGeneratorDialog.tsx`;
  - `useDatabaseBackup.ts`, `MenuBar.tsx`;
  - `src/screens/main/TrialExpiredOverlay.tsx` (deleted);
  - `FEATURE_MAP.md`.
- **politedb-backend:**
  - `src/routes/license.ts`, new `src/services/trial-service.ts`;
  - `src/db/entities.ts`, a new migration, `src/migrations/index.ts`;
  - `test/trial.test.ts`, `test/migrations.pg.test.ts`;
  - README (endpoint docs).

## Phases

- **Phase 1 (app):**
  1. Rebase `feat/pro-gating` onto `origin/main`.
  2. A1 (paid-plan rule) and the B changes 1, 3, 5.
  3. The AI agent gate (B2): frontend, backend and hint.
  4. Badges (C) and the overlay removal (D).
  - The trial stays local in this phase.
- **Phase 2 (backend):** the trial endpoint, entity, migration and tests, deployed before Phase 3 ships.
- **Phase 3 (app):** trial sync (A2), the clock check and the provisional window.

Each app phase is verified with `cargo test` in both flavors, clippy, Vitest, `npm run build`, and a look at the gated screens in the app.

The backend phase is verified with `npm test`, `npm run build`, and the Postgres migration test when `TEST_POSTGRES_URL` is available.

## Risks

- **Client-side enforcement.** Except for the agent command, gates live in the client. A license file edited while offline, or a modified webview, bypasses them. The server trial stops simple trial resets while online, not a modified client.
  - A follow-up could sign entitlements with Ed25519 on the backend and verify them offline in the app.
- **The device id is client-supplied and unauthenticated.** Sending a different id gets a new server trial. That takes a modified client, which is acceptable for v1.
- **Rate limiting on Render is off until `TRUST_PROXY` is set** (backend README). The trial endpoint inherits this. Setting `TRUST_PROXY` is a deploy step for the user.
- **The AI gateway trusts the client's `x-user-plan`.** That is out of scope here; it lives in a separate service.
- **Current Free users lose features after their trial:** the agent, backup/restore, the health inspector, masking and the analyzer view. This is intended, with no grandfathering.
- **Deploy order:** the backend must be live before the app ships Phase 3. Until then the app keeps the provisional local trial, so nothing breaks if the endpoint is missing (a 404 is treated as offline).

## Revision 3 (answers the Codex critique of Revision 2)

**New user decision D2b (2026-10-19): a trial needs the server.** A trial starts only after the server answers. There is no provisional local trial.
- A device that has never reached the server is **Free**; the free features work as usual.
- Once a server window is known, it is kept, and it is honoured offline until it expires.
- This replaces the "provisional local window" in A2 and removes the first-contact extension.

### R1. One entitlement model (findings 1, 4, 7)

**Rust `LicenseState`.** Credentials stay as they are. A separate `trial: Option<ServerTrial>` holds:

| field | meaning |
|---|---|
| `started_at`, `expires_at` | the server's window, in server epoch ms |
| `clock_offset_ms` | `server_now − local_now`, measured at the last successful sync |
| `synced_at` | local ms of the last successful sync |
| `high_water_ms` | the largest local time ever observed, updated on every finalize |

- **Legacy fields.** `trial_started_at` / `trial_expires_at` stay readable for migration only (R2). They never grant access.
- **`paid_license(state)`.** True when status is `active` after `apply_local_expiry`, **and** one of:
  - if `plan` is present and non-blank: `plan.trim().eq_ignore_ascii_case("pro")`;
  - otherwise: the normalized `plan_name` is `pro` or `ultimate` (trimmed, lowercase, one trailing `plan` word removed).
  Unknown, blank or conflicting values give **Free**, so `{plan:"free", plan_name:"Ultimate"}` is Free and `{plan:"pro", plan_name:"Polar License"}` is Pro.
- **`plan` handling.** Activate and refresh responses set `plan` from the response **without** carrying a previous value forward. A response that omits it means an older server, and the `plan_name` rule applies.
- **`trial_active(state, local_now)`.** The trial must exist and, using `effective_now = local_now + clock_offset_ms`:
  - `started_at <= effective_now < expires_at`, and
  - `local_now >= high_water_ms − 24 h` (a clock wound back by more than a day loses only the **trial**);
  - the window must be well formed: start before expiry, at most 31 days long.
  A clock that is fixed recovers on its own once local time passes the high-water mark again, or at the next sync, which re-measures the offset. Paid access never depends on any of this.
- **Finalize.** `pro_access = !gates_pro_features || paid_license || trial_active`. Finalize also sets `pro_access_until: Option<i64>`, in local ms: when the current access ends, from the paid `expires_at` or the trial's `expires_at − clock_offset_ms`. It is `None` when unlimited or not applicable.
  - The same function runs on load, save and every gate check: frontend state, `ai_agent_start` and the grant.
  - Nothing is trusted from input: `pro_access` and `pro_access_until` are always recomputed.
- **Shared fixture table.** `src/lib/license/entitlement.fixtures.json` lists `{status, plan, plan_name, expected_paid}`, covering:
  - case, whitespace and the `plan` suffix boundary (`"Pro plan"` yes, `"Pro plans"` no);
  - conflicting tier and name, unknown tiers;
  - an expired Ultimate license.
  The Rust test (`include_str!`) and Vitest both use it. The TS `isPaidLicense(state)` mirrors `paid_license`.
- **AI gateway tier.**
  - `x-user-plan` is `"ultimate"` only when `isPaidLicense` (status, tier and name); trials still send `"free"`, as today.
  - An expired Ultimate license now sends `"free"` instead of `"ultimate"`, which fixes a leak.
  - The gateway label stays `"ultimate"`.
- **Frontend access check.**
  - `hasProAccess(state, now = Date.now())` is true only when `state.pro_access` holds and `now < pro_access_until` (if set).
  - `useLicenseStore` sets a timer for `pro_access_until` (clamped to 24 h and re-armed), and reloads on `focus`, `visibilitychange` and `online`.
  - **Every action guard reads the store at action time** (`useLicenseStore.getState()`), not a value captured at render.
  - Work that already started (an export in progress, a running backup) completes, with its cleanup and safety behavior unchanged. New actions are refused.

### R2. Trial lifecycle and merge (findings 2, 5)

- **One merge rule, `merge_trial(current_on_disk, incoming)`, used by every path.**
  - Activate, refresh, deactivate, clear and save carry `trial` from the **current on-disk state**.
  - Only trial sync writes `trial`.
  - `normalize_api_state` and `LicenseState::inactive` never create a trial. The current `previous = None` path in activate (`license.rs:644`) can therefore no longer start one.
- **Legacy migration.**
  - On the first sync, the app sends any legacy local `trial_started_at` as `legacyStartedAt`.
  - The server uses it **only when creating** the row: start = `min(now, legacyStartedAt)`, ignored if before 2026-01-01 or in the future. A client can only shorten its own trial.
  - Users who are mid-trial keep their remaining days, and someone who already used up a local trial does not get a new one.
  - After a successful sync the legacy fields are cleared.
- **Sync triggers and retries.**
  - `license_trial_sync` runs:
    - after the store's `load`;
    - on `online`, on `focus` (at most once per 10 min);
    - every 6 h while open.
  - Failures back off (30 s, 2 min, 10 min, capped).
  - **Every failure keeps the known server window:** offline, 404, 429, 5xx, a malformed response, or a window that fails validation. Only a validated response replaces it.
- **Sync status (non-sensitive).** `trial_sync: { state: "verified" | "pending" | "unavailable", last_ok_at }` is shown in License settings ("Trial verified", "Couldn't reach the license server"), so a missing route cannot pass for server enforcement.
- **App Store.** `license_trial_sync` returns early in Rust (`Distribution::supports_local_trial()` is false) even if invoked directly. Finalize strips `trial` there, as today.
- **Honest limits** (replacing the Revision 2 claims):
  - Deleting the local file now gives **Free** until the next sync, which restores the original server window. Nothing is granted optimistically.
  - The remaining bypasses are a modified client or a different `device_id`, which are accepted v1 limits.

### R3. Concurrency (finding 3)

- **Rust.**
  - A process-wide `tokio::sync::Mutex` (`LICENSE_STATE_LOCK`) guards every read-merge-write of the license file.
  - HTTP runs **outside** the lock. Afterwards the action re-reads disk under the lock and writes only the fields it owns: credential fields for activate, refresh and deactivate; `trial` for trial sync.
  - **Stale responses.** A refresh or validate response is dropped (no write) if the on-disk `license_key`/`activation_token` changed while it was in flight.
- **Frontend.**
  - `useLicenseStore` tags each publish with a monotonic sequence and ignores older completions.
  - Every action publishes the state returned from Rust after the merge, never one it assembled itself.
- **Tests (deterministic, delayed responses):**
  - sync against activate, refresh, deactivate and another sync, in both completion orders;
  - each checks both the file on disk and the store.

### R4. Agent consent cards (finding 6)

- In `AiAssistantPanel`, the Allow handler on a data-access card (including cards saved during a trial and reopened later) first checks `hasProAccess` at click time. Without Pro it opens the upgrade dialog and does **not** call `aiAgentDataAccessGrant`.
- Allow requests already in flight are invalidated on entitlement loss, using the existing generation guard plus a license-generation check.
- After an upgrade there is no automatic grant or retry; the user clicks Allow again.
- `AI_AGENT_PRO_REQUIRED` gets fixed EN/VI copy in this handler and in `formatAssistantRequestError`, placed **before** the generic `AI_AGENT_` branch.
- Consent revoke and status stay available to everyone.
- Every Free path keeps `withoutData` filtering and the provenance marking.
- **Tests (`AiAssistantPanel.allow.test.tsx`):**
  - a reopened historical card while Free;
  - a downgrade while a grant is pending;
  - a context change;
  - an upgrade followed by an explicit Allow.

### R5. Backend hardening (finding 8)

- **Insert.** Insert with `onConflict(['product','device_id']).ignore()`, using the MikroORM query builder (Postgres `ON CONFLICT DO NOTHING`), then read the row through a **fresh** forked entity manager. The winning row's dates are never overwritten. This avoids reusing a failed flush.
- **Validation.**
  - Move `deviceSchema` to `src/validation/device.ts` and use it from both services.
  - Bound lengths: `device_id` ≤ 128, `device_name` ≤ 256, `platform`/`arch` ≤ 32.
  - `product` is trimmed, lowercased, and must be in `TRIAL_PRODUCTS` (env, default `politedb`). Anything else returns 400 `TRIAL_PRODUCT_UNSUPPORTED`.
  - `legacyStartedAt` is optional, an integer within bounds.
- **Errors and privacy.**
  - Database failures in the trial service become `AppError(503, "TRIAL_UNAVAILABLE")` with no details.
  - Nothing logs or reports the payload, device id or name, keys, or SQL parameters. Log and report spies assert this for both the duplicate path and unexpected failures.
  - Verify that the generic handler (`app.ts:115-117`) logs only the code for an `AppError`.
- **Registration.** `TrialSchema` is added to the `entities` list.
- **Tests.**
  - The SQLite unit tests above.
  - **Required before deploy approval:** a real Postgres parallel-create test with separate entity managers (`TEST_POSTGRES_URL`) and the migration test. If they cannot be run, the limitation must be recorded explicitly.

### R6. Health inspector and analyzer (findings 9, 10)

- **Health inspector.**
  - `DbHealthInspectorDialog` renders the shared locked state when `hasProAccess` is false.
  - `useDbHealthInspector` checks access before each collect or refresh, and on loss invalidates pending reads (via a request generation), so no further inspector queries run.
  - The ordinary connection health check in the MenuBar is unchanged.
- **Analyzer.**
  - In `SqlResultsPane`, the direct and streaming Explain paths (`:393-410`) and the analyzer-versus-grid choice (`:467-480`) become:
    - with Pro: the analyzer, as today;
    - Free: the **normal result grid with the raw plan rows**, plus a slim banner "Visual analyzer and recommendations are Pro".
  - Restored or previous Explain runs and tier changes re-evaluate the same way. Errors and ordinary query results are unchanged.
  - Markdown and JSON report export are both gated at their handlers, and the privacy confirmation (`QueryAnalyzer.tsx:139-165`) is kept.
- **Diagram.** `buildDiagramSvg` stays ungated, because PNG export uses it. Only the new "Export as SVG" action is gated.

### R7. Tests: Free and lifecycle (finding 10)

Revision 2's "regression with Pro mocked in" stays, and a **Free matrix** is added.

**Free can still:**
- export to CSV, JSON and SQL;
- export with every column set to Keep, passed through unmasked;
- select columns without turning masking on;
- import a SQL dump through all three callers;
- export PNG and copy Mermaid;
- run raw Explain in both modes;
- use basic chat.

**Free is blocked from:**
- Backup and Restore;
- the analyzer view and its reports;
- SVG export;
- masking;
- the inspector;
- the agent and its consent grant.

**A masking policy saved during Pro**, then a downgrade: the export fails with a clear upgrade error, and there is no unmasked fallback.

**Lifecycle:**
- the trial expires while the window is open (timer, focus), with several consumers;
- a paid license expires the same way.

**App Store:** agent, grant and SVG are unlocked, and no trial request is sent.

**Unchanged:** the existing Pro analyzer and consent tests are kept.

### R8. Release (finding 11)

- **Phase 1 can ship on its own.** It keeps today's local trial behavior; the trial changes arrive with Phase 3.
- **Phase 2, before deploy approval:**
  - the Postgres concurrency and migration evidence (R5);
  - `TRUST_PROXY` set on Render so rate limiting is on (a user deploy step);
  - a smoke check of the deployed `POST /api/v1/trial`: units in ms, idempotent across two calls, 400 on a bad product.
- **Phase 3 ships only after Phase 2 is live.** With D2b, an app that cannot reach the endpoint makes new users Free, so the deploy order is a hard gate.
- **Rollback.** The `trials` table and its rows are kept; the app's last known windows keep working offline.

### R9. Copy and badges (finding 12)

- **Upgrade dialog.**
  - `ProUpgradeDialogHost` lists all six features, built from `PRO_FEATURE_LABELS`, with "AI agent mode" added and the label "ER diagram export to SVG".
  - The dialog has no hard-coded list.
- **Badges (D8), shown to every tier:**
  - Backup and Restore;
  - the health inspector item;
  - "Export as SVG";
  - the masking controls;
  - the analyzer banner and header;
  - the agent hint line;
  - the Allow button on a data-access card.
- **Badges removed** from PNG export and from the Explain button, which are now free.
- **MenuBar** uses the badge component instead of the conditional title suffix (`MenuBar.tsx:307`).
- **Agent hint.** The dismissal key `politedb.ai.agentProHint.dismissed` is a device-level boolean. It holds no license, device or chat data. "Once per chat" is tracked in memory only.

### Revision 3 phase plan

1. **Phase 1 (app):**
   - rebase;
   - R1, except the server-trial fields. In this phase only, `trial_active` keeps using the legacy local `trial_expires_at` (today's behavior, with the high-water rule); Phase 3 switches it to `trial` and stops honouring the legacy fields;
   - the B gates with R4, R6 and R9;
   - the expiry timer;
   - the Free matrix (R7).
2. **Phase 2 (backend):** the trial endpoint with R5.
3. **Phase 3 (app):** server trial (R1 trial fields, R2, R3), sync status, and the legacy migration.

## Revision 4 (answers the Codex re-review of Revision 3)

**New user decisions (2026-10-19):**
- **D2c: no clock-rollback protection.** The trial is checked against the local clock, exactly like paid `expires_at`. The license file is unsigned and editable (an accepted v1 limit), so protecting the clock adds little.
  - This drops `clock_offset_ms`, `high_water_ms`, the 24 h skew rule and the server `now` field from R1, R2 and R3.
  - Closes **B1**.
- **D2d: legacy local trials keep their remaining days** (R2's migration, made robust below). Closes **B3**.
- **D9: one release.** Phases 1 and 3 are implementation and review boundaries only. The app ships once Phases 1 and 3 are both done and the Phase 2 backend is live. No build ships with local-only trials. Closes **B4**; replaces R8's "Phase 1 can ship on its own".

### V1. Entitlement (replaces the R1 rules; closes S1, S4)

- **`ServerTrial` holds only** `{ started_at, expires_at, synced_at }` (epoch ms).
  - Valid: integers, `started_at < expires_at`, and `expires_at − started_at <= 31 days`.
  - It is immutable except through trial sync.
- **`trial_active(state, now)`:** `trial` is present (Phase 3) and `started_at <= now < expires_at`.
- **`paid_active(state, now)`:** status is `active`, `expires_at` is absent or in the future (`apply_local_expiry` already flips a past expiry to `expired`), and `paid_tier(state)` holds.
- **`paid_tier(state)`, exact rule:**
  - `plan` absent or null → use `plan_name`: trim, lowercase, remove one trailing ` plan` word, then require `pro` or `ultimate`.
  - `plan` present (any string) → `plan.trim().eq_ignore_ascii_case("pro")`. So `""`, whitespace and unknown values are **not** paid.
  - **Response-owned:** activate and refresh responses set **both** `plan` and `plan_name` from the response, and neither is carried forward from previous state. A response that omits both gives not-paid. The settings display falls back to "Free plan".
- **`pro_access`** = `!gates_pro_features || paid_active || trial_active`.
- **`pro_access_until`:**
  - Collect every grant that is currently eligible: paid (its `expires_at`, or unlimited when absent) and the trial (its `expires_at`).
  - If any eligible grant is unlimited → `None`. Otherwise → the **latest** end among the eligible grants. If none is eligible → `pro_access = false` and `pro_access_until = None`.
  - **Tests:**
    - paid ending before the trial, and the trial ending before paid;
    - unlimited paid plus a trial;
    - trial only;
    - paid only;
    - neither.
- **Shared fixtures (`entitlement.fixtures.json`):** each case is `{ status, plan?, plan_name?, expires_at?, trial?, now, distribution, expected: { paid, pro_access, pro_access_until } }`.
  - It includes:
    - active with a past `expires_at`;
    - a missing or malformed `expires_at`;
    - `plan` set to `""`, `"  "`, `"PRO"` or `"enterprise"`;
    - conflicting `plan` and `plan_name`;
    - the `"Pro plan"` / `"Pro plans"` boundary.
  - Rust (`include_str!`) and Vitest both run it **on the normalized state shape** that the app actually stores.
- **Frontend.** The front end trusts the native `pro_access` and `pro_access_until`, and expires locally at `pro_access_until` (timer clamped to 24 h, re-armed). Both sides use the same local clock and the same deadline, so they cannot diverge, apart from timer granularity. Action guards read the store at action time (as in R1).

### V2. Serialized license operations (replaces R3; closes B2, S2)

- **Operation lock.** All mutating license operations run **one at a time, end to end**: activate, refresh/validate, deactivate, clear, save and trial sync.
  - Each holds a process-wide async `LICENSE_OP_LOCK` (tokio `Mutex`) for its whole duration, including HTTP.
  - HTTP requests already have bounded timeouts. Operations are rare and user-driven, plus background sync.
  - Each operation reads disk **after** acquiring the lock, so no operation can act on a stale snapshot. A deactivate always targets the credentials on disk at that moment; it cannot erase a newer activation.
- **File lock.** Disk access goes through `read_state()` / `write_state()`, guarded by a short synchronous `std::sync::Mutex` (`LICENSE_FILE_LOCK`) with no `await` inside.
  - Read-only paths take only this lock: load, gate checks in `ai_agent_start` and `ai_agent_data_access_grant`, and status.
  - Locked operations call the same private helpers and never the public commands, so no lock is taken twice.
  - `license_state_load`, `license_state_save` and `license_state_clear` become `async` Tauri commands (same names and payloads). Nothing calls `blocking_lock()`.
- **Revision.** `LicenseState.revision: u64` is incremented by every `write_state()`, and every command returns the state it wrote or read.
  - `useLicenseStore` publishes a state only when `revision > publishedRevision`. Equal revisions are ignored.
  - The rule applies to every publication: actions, background refresh, trial sync, error paths (which return the current state and its revision) and direct loads.
  - Busy and error flags are separate from the published state and are cleared per request.
- **Trial sync ordering.** Responses are applied under the operation lock in the order the lock is acquired. A sync never overwrites a server window with an older `synced_at` (checked under the lock).
- **Tests.** Delayed and blocked mock responses (a test-only hook in the HTTP layer) cover:
  - deactivate(A) queued behind activate(B);
  - two activations;
  - clear then reactivate with the same key;
  - refresh against deactivate;
  - activate against sync, in both start orders;
  - a stale frontend publication arriving after a newer one.
  Each asserts the credentials, trial and revision on disk, and the store state.

### V3. Legacy trial migration (replaces the R2 migration; closes B3)

- **`legacy_trial_started_at: Option<i64>`** is a migration-only field.
  - **Set once, on load:** if it is absent, no server `trial` exists, and the decoded legacy `trial_started_at` exists, it is copied. Decoding uses the existing `normalize_unix_timestamp_millis` (seconds become ms), and an old state version is migrated, not reset.
  - **Carried by every path:** activate, refresh, deactivate, clear, save and load take it from the **on-disk** state under the lock. It is never set from activation time, `inactive()`, or any caller-supplied state.
  - **Cleared** in the same `write_state()` that stores a validated server window.
- **First sync.**
  - The first sync sends `legacyStartedAt` when the field is present.
  - The server uses it only when **creating** the row: `start = min(now, legacyStartedAt)`, `expires = start + 14 days`. A row that already exists is returned unchanged.
  - Values before 2026-01-01 or in the future are ignored: that device gets a normal fresh trial. This is a documented outcome, and no such local trials are expected.
- **Outcomes:**
  - a mid-trial legacy user keeps the remaining days;
  - an exhausted legacy user receives an already-expired window, so stays Free;
  - a new install with no legacy data is Free until the server confirms a trial.
- **Tests:** active and exhausted legacy windows through activate → refresh → clear/deactivate → reload → a failed or malformed sync → a successful delayed sync. Each asserts the request body sent and that the server dates win.

### V4. Sync scheduler (replaces the R2 triggers; closes S3)

- **One single-flight scheduler** in `useLicenseStore`: `requestTrialSync(reason)`, Direct flavor only. It is triggered by load, `focus`, `online`, and a 6 h interval while open.
  - If a sync is in flight, the request is a no-op.
  - Before `nextAttemptAt`, the request is a no-op, except `online`, which may run when the last failure was a network error.
- **Results:**
  - **Success:** clear the backoff, store the window, and set status `verified`.
  - **Network error, 5xx or a malformed response:** back off 30 s → 2 min → 10 min → 30 min (cap).
  - **429:** use `Retry-After` (at least 60 s), otherwise the backoff.
  - **400:** stop retrying until the next app launch, status `unavailable`.
  - **404:** treated like a network error.
- **The known window is kept on every failure.**
- **Expiry reload is separate.** It is a local re-read at `pro_access_until` and does not touch the backoff.
- **Cleanup:** the interval and timers are disposed when the store unsubscribes or reloads.
- **Tests:**
  - focus/online bursts make only one request;
  - an expiry reload during a backoff;
  - offline → online without restart;
  - 404, 429 with `Retry-After`, 400, and a malformed payload;
  - the known window is kept throughout.
- **App Store:** the Rust command returns early, as in R2.

### V5. Trial presentation (closes S6)

`LicenseDialog.tsx` and `LicenseKeySettings.tsx` render from the server `trial` and the derived state, not from `trial_expires_at`:
- "Free trial: N days left (ends DATE)";
- "Free trial ended on DATE";
- "Free trial not activated yet. Connect to the internet to start it" (never verified);
- a muted sync line, "Couldn't reach the license server", when the status is `unavailable` or a backoff is running.

Both files are in the Phase 3 file list. Tests cover a successful migration, an offline known window, and a launch that never contacted the server.

### V6. Backend specifics (amends R5; closes S5, N1)

- **Insert path:**
  - `qb.insert({...}).onConflict(['product','deviceId']).ignore()`, using the entity property names;
  - execute and await the autocommitted insert;
  - read the row with a **fresh** forked entity manager;
  - then update only `lastSeenAt` (and the device name, platform and arch).
  - The winning dates are never taken from the insert's result.
- **Error handling.** Trial database failures are wrapped as `AppError(503, "TRIAL_UNAVAILABLE")`. That reaches `app.ts:89-95`, which returns an `AppError` without logging or reporting.
  - Tests assert that neither the raw DB exception nor the payload or device data reaches `console.error` or the reporter (`:115-117`).
  - No new logging is added.
- **Response:** `{ trialStartedAt, trialExpiresAt }` only (no `now`, per D2c).
- **Release blocker:** the separate-manager Postgres parallel-create test and the fresh/existing-schema migration test must run before deploy approval. If they cannot run, that is recorded as a blocker, not waived.

### V7. Agent badge (closes N2)

The AI panel header shows a persistent "Agent" chip with `ProBadge` for every tier.
- **Pro and trial:** it is informational, with tooltip "Agent mode is on".
- **Free:** clicking it opens the upgrade dialog.

The fallback hint (B2) and the consent-card Allow badge (R9) stay as specified. The hint's once-per-chat and dismissal behavior are separate from the chip.

### Revision 4 phase plan (replaces earlier phase plans)

1. **Phase 1 (app, not shipped alone):**
   - rebase;
   - V1 (with the legacy local trial still active **inside this unreleased build only**);
   - V2 (lock, async commands, revision);
   - the B gates with R4, R6 and R9 plus V7;
   - the Free matrix (R7);
   - lifecycle tests.
2. **Phase 2 (backend):** the trial endpoint with R5 and V6; deploy after the Postgres evidence and `TRUST_PROXY`.
3. **Phase 3 (app):** server trial (V1 trial), V3 migration, V4 scheduler, V5 presentation, and stop honouring the legacy local window.

**Release** happens after Phase 3 is reviewed and the Phase 2 endpoint passes the R8 smoke checks.

## Revision 5 (answers the Codex re-review of Revision 4)

### W1. Bounded license HTTP (closes B1)

- **Timeouts.** One license HTTP client with explicit timeouts:
  - connect 5 s;
  - 15 s per attempt, covering the send and reading the whole body;
  - **one total deadline of 30 s per operation** across all fallback URL candidates. It is enforced with `tokio::time::timeout` around the whole HTTP phase.
  - The body read is capped at 64 KiB.
- **On timeout or any failure:**
  - the operation returns a structured `LicenseOpError { kind: Timeout | Network | Http { status, retry_after_ms } | Malformed | Invalid }`, with no raw body or URL;
  - it writes nothing, so credentials and trial stay as they are;
  - it releases `LICENSE_OP_LOCK` when its scope ends.
- **Waiting for the lock.** An operation waits for the async lock **without** holding `LICENSE_FILE_LOCK`. The file lock is taken only inside `read_state()` / `write_state()`, and never across an `await`.
- **Tests:**
  - a mock that accepts a connection and never finishes its body → timeout within the deadline;
  - a queued clear and a queued activation then complete;
  - a read-only gate (`ai_agent_start` entitlement read) stays responsive throughout;
  - a 4-candidate fallback stays within the 30 s total.

### W2. Snapshot sequence for publication (closes B2)

- **Two counters:**
  - `revision` (durable; incremented by every write) orders disk mutations, as in V2.
  - `snapshot_seq` (process-wide `AtomicU64`, not persisted) is assigned **inside `LICENSE_FILE_LOCK`** to every finalized snapshot returned to the frontend, whether from a read or a write. Every command returns `{ state, snapshot_seq }`.
- **The store** publishes only when `snapshot_seq > lastPublishedSeq`.
  - `lastPublishedSeq` starts at 0, and the first sequence issued is 1.
  - Error results carry the current snapshot and its sequence, so they can publish too.
- **Why this works:**
  - An expiry re-read with no disk change still gets a new, higher sequence and publishes `pro_access=false`.
  - A delayed load taken before expiry has a lower sequence, so it cannot overwrite the newer one.
- **Load stays read-only** (no write on load), except for the atomic legacy capture in W4.
- **Tests:**
  - expiry with no disk mutation and no HTTP → subscribers notified, pending consent grants invalidated, actions denied;
  - a delayed pre-expiry load delivered after a post-expiry load → ignored;
  - a first state at revision 0 (legacy file);
  - error publications.

### W3. Scheduler cadence and transport (closes S1)

- **Minimum cadence.**
  - After a success, `nextAttemptAt = now + 6 h`.
  - A focus-triggered sync also needs at least 10 min since the last attempt.
  - The 6 h interval and failure retries both schedule **one wake-up timer** at `nextAttemptAt`, owned by the scheduler.
- **Scheduler lifetime.** The scheduler is created once per app session (a module singleton started by the first `load`). It is independent of state reloads, so expiry re-reads never cancel it. It is disposed only on window unload and in tests.
- **Typed result.** `license_trial_sync` returns `{ snapshot, outcome: Ok | Failed { kind, status?, retry_after_ms? } }`. The native side parses `Retry-After` (seconds or HTTP date) from the response headers.
- **Permanent 400.** A 400 suppresses sync until process restart; the flag lives in the scheduler singleton.
- **Tests:**
  - repeated focus after a success → no request;
  - a retry fires with no events;
  - repeated expiry or load during a backoff keeps the timer;
  - a 429 with `Retry-After: 120` → the next attempt is 120 s later;
  - 400 suppression survives store reloads.

### W4. Legacy capture on every first read (closes S2)

- **One decoder.** `read_state()` is the only disk decoder, used by load **and** by every mutation entry (activate, refresh, deactivate, clear, save, sync). After decoding (including old-version and seconds-to-ms migration), it derives:
  - `legacy_trial_started_at = existing value, or legacy trial_started_at`, only when **no** server `trial` exists and `legacy_retired` is false.
- **Persisting the capture:**
  - If that capture changed the state, a **mutation** persists it inside its own `write_state()`.
  - A **load** persists it once with a minimal `write_state()` (the only write a load does), under the file mutex, without taking the operation lock.
  - Capture is idempotent, so a load racing a mutation converges.
- **Retiring the legacy fields:**
  - On the first validated server window, one `write_state()` stores `trial` and sets `legacy_retired = true`, clearing `legacy_trial_started_at`, `trial_started_at` and `trial_expires_at`.
  - Retired fields are never recaptured.
  - The server `trial` is preserved by every save and clear.
- **Tests:**
  - activate or clear before the first load (the legacy start survives and is sent on sync);
  - a concurrent load and mutation;
  - a restart before the first successful sync;
  - sync → clear → reload (the trial is kept, no recapture);
  - an old-version file with seconds.

### W5. Expiry and timestamp domains (closes S3)

- **Paid `expires_at`** is parsed once in `normalize_api_state` from RFC 3339 to epoch ms and stored as `expires_at_ms: Option<i64>`, keeping the raw string for display.
  - absent or null → unlimited;
  - **present but unparseable → paid grant ineligible** (`paid_active = false`). Any valid trial still counts.
  - `apply_local_expiry` uses `expires_at_ms`. Exact equality with `now` counts as expired (`now >= expires_at` → expired).
- **Server trial timestamps** must be integers in `[2026-01-01, 2100-01-01)` in ms. The window arithmetic uses `checked_sub` / `checked_add`, and an overflow is treated as invalid. The backend uses the same bounds, plus `Number.isSafeInteger`, for `legacyStartedAt` and the computed expiry.
- **Injected time.** `finalize_state(state, distribution, now)` takes `now`, and all real `Utc::now()` calls move to the command boundary. Fixtures pass `now` explicitly.
- **Fixtures** have concrete expected values for:
  - expiry equal to `now`;
  - null, missing and malformed expiry;
  - both union orders;
  - an invalid trial (start ≥ expiry, longer than 31 days, out of range);
  - raw-response normalization (`expiresAt` ISO string → `expires_at_ms`), alongside the normalized-state cases.

### W6. Distribution bypass first (closes S4)

Finalize evaluates `!gates_pro_features()` **first**: `{ pro_access: true, pro_access_until: None }`, before the paid/trial union, which runs only for Direct.

Fixtures cover:
- App Store with no grant;
- App Store with an expired paid license;
- App Store with trial fields present (stripped, still Pro).

### W7. Chip copy (closes N1)

- **Pro and trial:** the agent chip tooltip reads "Agent mode is included with Pro". There is no claim that it is running; the provider, model or engine fallback stays as it is.
- **Free:** "Agent mode is a Pro feature", and clicking opens the upgrade dialog.

**Implementation notes from the Codex re-review of Revision 5:**
- **Atomic capture.** The load's read, capture and minimal write happen in **one** `LICENSE_FILE_LOCK` critical section, using unlocked private helpers. The concurrent load/mutation test pauses at that boundary and asserts that credentials and the server trial survive.
- **Expiry representation.** A malformed expiry stays distinct from an absent one across save and reload: store `expires_at_valid: bool` (or check that the raw field is present) next to `expires_at_ms`. Test reloading a malformed expiry together with a valid trial.

Phase plan unchanged from Revision 4. W1, W2, W5 and W6 belong to Phase 1. W3 and W4 belong to Phase 3, except that W4's decoder and capture land in Phase 1 together with V2.

## Phase 1 — Implementation evidence (Claude, 2026-10-19)

The branch was rebased onto `origin/main` (`57de05f`); `99a5f22` is now `983f40e`. The changes below are uncommitted on top of it.

**Rust (`src-tauri/src/license.rs`, `commands/license.rs`, `commands/ai_agent.rs`, `commands/ai_agent_data.rs`):**
- **Entitlement (V1, W5, W6).**
  - `paid_tier` follows the exact V1 rule: `plan` decides when present, otherwise `plan_name` pro/ultimate with an optional ` plan` suffix.
  - `paid_expiry` distinguishes Unlimited, At and Invalid. It is derived from the raw `expires_at` on every read, so a malformed expiry stays ineligible across reload.
  - `entitlement()` evaluates the distribution bypass first, then the union of paid access and the running trial; `pro_access_until` is the latest end.
  - `finalize_state(state, distribution, now)` takes `now` explicitly.
  - Derived fields `pro_access`, `pro_access_until` and `paid_license` are always recomputed.
  - Activate and refresh take `plan` and `plan_name` from the response only.
- **Serialization (V2, W1).**
  - `license_op_lock()` (an async mutex) is held end to end by save, clear, activate, refresh and deactivate. Each operation re-reads disk inside the `LICENSE_FILE_LOCK` section that writes.
  - The file lock is never held across an `await`.
  - HTTP: connect 5 s, 15 s per attempt, 30 s in total across fallback candidates (`tokio::time::timeout`), body capped at 64 KiB.
  - Errors are a structured `LicenseOpError { kind, status, retryAfterMs, message, state }` with no raw body or URL. The error carries the current snapshot.
  - All license commands are `async`.
- **Snapshots (W2).** `revision` is incremented on every write. `snapshot_seq` is a process-wide counter assigned inside the file lock to every returned snapshot, so an expiry re-read gets a new number without a write.
- **Legacy capture (W4).**
  - `read_state_locked` is the single decoder. It captures `legacy_trial_started_at`, unless the trial is retired, and persists the capture atomically in the same file-lock section.
  - Every mutation carries the trial and legacy fields from disk (`carry_device_fields`), so caller-supplied state cannot change them.
- **Fresh state.** A fresh state's local trial starts at the same `now` used to evaluate it (`inactive_at`). Before this fix, the first load of a new install briefly reported no trial.
- **Agent gate (B2).** `ai_agent_start` and `ai_agent_data_access_grant` call `license::require_pro(&app, "AI_AGENT_PRO_REQUIRED")` before any provider or database work. An unreadable license file counts as locked.

**Frontend:**
- **Core.**
  - `stores/license.ts` publishes only snapshots with a higher `snapshot_seq`, including those carried by errors.
  - It re-reads at `pro_access_until` (timer clamped to 24 h) and on focus, `visibilitychange` and `online`.
  - `hasProAccessNow()` reads the store at action time, and `useProGate().requirePro` uses it.
  - `hasProAccess` also ends access locally at `pro_access_until`.
  - The AI gateway tier comes from the native `paid_license`: `gatewayPlan()` replaces `planFromLicensePlanName`.
- **AI agent (B2, R4, V7).**
  - `useAiAssistantSubmit` runs the agent only with Pro (checked at send time). Otherwise the turn goes to basic chat with `withoutData` history, and `onAgentProLocked` fires.
  - `AiAssistantPanel` shows the `AgentProHint` once per chat. Dismissal is stored under the device key `politedb.ai.agentProHint.dismissed`.
  - The consent card's Allow checks Pro at click time; without Pro it opens the upgrade dialog.
  - `AI_AGENT_PRO_REQUIRED` from the grant also opens the upgrade dialog.
  - `hasPro` is part of the Allow generation, and resubmission rechecks access.
  - EN/VI copy for `AI_AGENT_PRO_REQUIRED` is placed before the generic `AI_AGENT_` branch.
  - `AgentModeChip` (all tiers) sits in the composer toolbar when connected.
  - The Allow button carries a Pro badge (`aria-hidden`, so the button is still named "Allow").
- **Backup (B1, D4).** Database Backup and Restore stay gated; `onImportSqlDump` (table-level) is free.
- **Analyzer (B3, R6).**
  - The Explain button and `startExplain` are no longer gated.
  - Free users get the raw grid plus a banner (direct, streamed and restored runs; errors and ordinary results unchanged).
  - With Pro, the analyzer renders as before. Both report exports are gated at their handler, and the privacy confirmation is unchanged.
- **Health inspector (R6).**
  - The dialog renders a locked state without Pro.
  - `useDbHealthInspector` checks access before each collect or refresh, and clears pending collections on loss: abort plus generation, so late results are dropped.
- **Diagram (B5, D7).** PNG export and Copy Mermaid are free. A new "Export as SVG" action is gated (`buildDiagramSvg` → save dialog → `writeTextFile`).
- **Badges and copy (R9, D8).**
  - Badges for every tier:
    - `ProIcon` corner badges on the Backup, Restore and Health Inspector toolbar icons (titles "(Pro)");
    - SVG export;
    - a masking note in the export dialog;
    - the analyzer header and banner;
    - the agent chip and hint;
    - the Allow button.
  - Badges were removed from PNG and Explain.
  - The upgrade dialog lists all six features from `PRO_FEATURES` and `PRO_FEATURE_LABELS` ("AI agent mode", "ER diagram export to SVG").
- **Cleanup (D).** `TrialExpiredOverlay.tsx` is deleted, and `FEATURE_MAP.md` is updated.

**Deviation (recorded):** V1 planned a shared JSON fixture table used by both Rust and TypeScript. The frontend instead trusts the native `paid_license`, `pro_access` and `pro_access_until` and computes no entitlement itself, so there is nothing to keep in parity. The fixture table therefore lives only in Rust (`paid_tier_needs_a_positive_paid_signal` and the entitlement tests). The gateway test covers `gatewayPlan`.

**Tests added or updated:**
- **Rust (`license::tests`, 24):**
  - the `paid_tier` table;
  - activity and expiry, including equality and malformed values;
  - the union in both orders, unlimited plus trial, and neither;
  - the App Store bypass;
  - recomputed derived fields;
  - fresh state written once and snapshot order across an expiry re-read without a write;
  - a malformed expiry across save and reload;
  - legacy capture before any mutation, with caller state unable to replace it, and retirement;
  - `Retry-After` parsing;
  - `pro_gate`;
  - with a loopback server:
    - a queued deactivate targets the newer activation;
    - two activations apply in lock order;
    - a stalled body times out and releases the lock, while a queued clear completes and reads stay fast;
    - four fallback candidates share one deadline;
    - typed 429 with `Retry-After`, and a malformed response without the raw body.
- **Frontend:**
  - `stores/license.test.ts`: publication order, an error carrying a snapshot, an expiry re-read without a restart, and denial at the deadline;
  - `useDatabaseBackup.pro.test.ts`: Free backup and restore are blocked, SQL dump import is free, Pro runs, and access is checked at action time;
  - `useAiAssistantSubmit.agent.test.ts`: Pro by default, plus the Free legacy path with filtered history and the hint, no hint for unsupported engines, and an action-time check;
  - `AiAssistantPanel.allow.test.tsx`: a reopened card while Free, a downgrade during the grant, a backend refusal, an upgrade followed by an explicit Allow, and the hint once plus dismissal;
  - `formatAssistantRequestError` EN/VI;
  - analyzer: `SqlResultsPane` and `QueryAnalyzer` tests (Free grid plus banner for direct and streamed runs, tier flips, errors and ordinary runs, gated exports, badge);
  - inspector: the hook, the dialog and real-hook `.pro` tests (zero queries for Free, a downgrade while open, a late result dropped);
  - `DiagramGeneratorDialog.test.tsx`: PNG free, SVG gated, SVG written with Pro, cancel;
  - the gateway tier.

**Verification:**
- **Rust:**
  - `cargo test --locked`: 419 passed / 15 ignored, the same with `--features app-store`.
  - `cargo clippy --locked --all-targets`: 8 warnings (default) and 9 (app-store), the baseline.
- **Frontend:**
  - `tsc` clean; Prettier clean on the changed files.
  - Vitest: 134 files / 794 tests, with one failure: `politedbBackend/ai.test.ts` "does not duplicate /api". That failure is environmental, because this worktree has no `.env` and so no `VITE_POLITEDB_API_BASE`. It also fails on the unchanged base. With the variable set, that file passes.
  - `npm run build` passes.
- **Not done:** the app was not run, so the gated screens have not been checked by eye. Every gate is covered by component tests.

### Fixes for Codex review "pro-gating Phase 1" (Claude, 2026-10-19)

`.agent/REVIEW.md`: CHANGES REQUIRED, with two P1 and two P2 findings. All four are fixed.

1. **P1, expiry normalization.**
   - The response now decides `expires_at`. It is never inherited from `previous`. A null or missing value means unlimited, and a blank value stays present.
   - `paid_expiry` treats only an absent value as unlimited. A blank or malformed value is invalid.
   - Tests:
     - `the_response_decides_the_expiry`: null after an expired deadline gives an unlimited, active, paid license; `""`, whitespace and `soon` stay present and are never paid; a future deadline is used as given.
     - `invalid_paid_expiry_keeps_a_valid_trial_across_reload`.
2. **P1, durable write.**
   - `write_state_locked` uses `storage::json_replace_private`, which keeps the previous file if the replacement fails. The file is owner-only (0600) because it holds the license key.
   - Test `a_failed_write_keeps_the_previous_file` (unix): a read-only directory makes the write fail. The key, revision and trial start survive, and the file mode is 0600.
3. **P2, state versions.**
   - The decoder now migrates older versions in place. `with_device` sets the current version, and the file is written once, keeping the credentials and the original trial start.
   - A newer version returns a storage error and leaves the file untouched.
   - Only version 1 has ever shipped, so this guards future changes.
   - Tests:
     - `an_older_version_is_migrated_not_reset`: load, clear or commit as the first operation, then a restart. An exhausted trial stays exhausted and is captured as legacy.
     - `a_newer_version_is_left_untouched`.
4. **P2, App Store gate.**
   - `pro_gate(distribution, load, code)` passes ungated flavors before any license I/O. The Direct flavor still fails closed.
   - The test asserts that the App Store flavor never calls the loader.

**Coverage gaps closed** (Rust, with loopback):
- `clear_then_reactivate_with_the_same_key`;
- `a_refresh_queued_behind_a_deactivate_sees_no_license` (the validate request carries no credentials);
- after a timeout, a queued activation runs instead of being blocked.

**Frontend (`stores/license.test.ts`):**
- a timer re-read notifies several subscribers;
- a focus event triggers a re-read.

**Verification:**
- **Rust:**
  - `cargo test --locked`: 426 passed / 15 ignored, the same with `--features app-store`.
  - `license::tests`: 31.
  - Clippy: 8 warnings (default) and 9 (app-store), the baseline.
- **Frontend:**
  - Vitest with `VITE_POLITEDB_API_BASE=http://localhost:4000/api`: 134 files / 796 tests passed.
  - `tsc` and `npm run build` pass.
  - `git diff --check` is clean.

## Phase 2 — Implementation evidence (Claude, 2026-10-19)

**Repo:** `politedb-backend`, new branch `feat/trial-endpoint`, created from the local, unpushed `feat/license-plan-tier` (`31c2c37`, which adds the `plan` field the app relies on). Uncommitted.

- **Endpoint.** `POST /api/v1/trial` (`src/routes/license.ts`) uses `licenseRateLimit`. It takes `{ product, device, legacyStartedAt? }` and returns `{ trialStartedAt, trialExpiresAt }` in epoch ms. There is no `now` field, per D2c.
- **Service (`src/services/trial-service.ts`):**
  - **Product.** It is trimmed and lowercased, then must be in `TRIAL_PRODUCTS` (env, default `politedb`). Anything else returns `400 TRIAL_PRODUCT_UNSUPPORTED`.
  - **Device.** `src/validation/device.ts` is now shared with the license endpoints and bounds the fields: `device_id` ≤ 128, `device_name` ≤ 256, `platform` and `arch` ≤ 32.
  - **`legacyStartedAt`.** It must be an integer. When it is a safe integer between 2026-01-01 and now, it becomes the start of a **new** row (`newTrialStart`); otherwise it is ignored.
  - **Insert.** A query-builder insert with `onConflict(['product','deviceId']).ignore()`. The row is then read through a fresh forked entity manager, and only `lastSeenAt` and the device name, platform and arch are updated. The winning dates never change.
  - **Errors.** Any database failure becomes `AppError(503, "TRIAL_UNAVAILABLE")`. That path returns early in `app.ts` and is neither logged nor reported.
- **Storage.**
  - The `Trial` entity (`trials` table) is registered in `entities`, with a unique constraint on `(product, device_id)`.
  - Migration `Migration20261019000000AddTrials`: its SQL came from `npm run db:diff`, run against a throwaway Postgres migrated to the previous schema. It is registered in `src/migrations/index.ts`.
- **Docs.** The README documents the endpoint, `TRIAL_PRODUCTS` and the error codes.
- **Tests:**
  - `test/trial.test.ts`, on SQLite, 14 tests:
    - the first request creates the row and later requests return it unchanged, with metadata updated;
    - an expired window is kept;
    - one row per normalized product and device;
    - the legacy start is used only on create;
    - an exhausted legacy trial is already expired;
    - legacy bounds;
    - five racing requests make one row;
    - over HTTP: ms units, an unknown product, a 400 for each of four invalid payloads;
    - a database failure gives a fixed 503 that contains no device id, with no `console.error` and no report.
  - `test/migrations.pg.test.ts`, on Postgres:
    - the expected migration list now includes the trials migration;
    - **new:** an upgrade from the previous schema adds `trials` with no remaining diff;
    - **new:** 12 first requests racing on separate connections make one row, with identical dates for every caller and later reads unchanged.
- **Verification:**
  - With `TEST_POSTGRES_URL` set to the throwaway `politedb-smoke-pg` container: 6 files / 77 tests passed, including the Postgres concurrency and migration cases. This is the evidence R8 requires before deploy.
  - `npm run build` passes.
  - The temporary diff database was dropped.
- **Deploy prerequisites (user):**
  - Set `TRUST_PROXY` to a hop count on Render, so rate limiting is on (see README "Docker and Render").
  - After deploy, smoke-check `POST /api/v1/trial`: ms units, the same answer on two calls, and a 400 on a bad product.
  - Phase 3 must not ship before this is live (D9).

### Fixes for Codex review "pro-gating Phase 2" (Claude, 2026-10-19)

Codex returned CHANGES REQUIRED with two P2 findings. Both are fixed.

1. **P2: device-name length.**
   - **Problem:** the schema accepted 256 characters while the columns are `varchar(255)`. The trial and activation inserts failed on Postgres.
   - **Fix:** `device_name` is now limited to **255**, matching the existing `varchar(255)` columns in `trials` and `activations`. This is a deliberate change from R5's "≤ 256", which was an arbitrary number: matching the columns avoids a migration of `activations`.
   - **Tests:**
     - HTTP: 255 characters accepted, 256 rejected.
     - Postgres: a 255-character name stored on both the first and a repeated request.
2. **P2: timestamp domain.**
   - **Fix:** `newTrialWindow` checks the server `now`, the legacy candidate and the computed expiry against `[2026-01-01, 2100-01-01)` with safe integers. A legacy date outside the domain is ignored, as approved. When no valid window can be produced, the endpoint returns `503 TRIAL_UNAVAILABLE`, never 404.
   - **Tests:** exact lower and upper bounds, an expiry crossing the upper bound, and a server clock out of range (no row written).

**Coverage gaps closed:**
- every caller of a race with **different** legacy starts gets the winner's dates;
- a second allowed product gets its own trial;
- a failure after the insert (fresh-manager read) returns a fixed 503, with no `console.error` and no report;
- the shared device bounds now reject a 129-character `device_id` on `validate` before Polar is called. This tightening is intended and is documented in the README.

**Verification:**
- 6 files / 86 tests pass with `TEST_POSTGRES_URL` set to the throwaway Postgres.
- `tsc` is clean, and `git diff --check` is clean.

## Phase 3 — Implementation evidence (Claude, 2026-10-19)

**App, branch `feat/pro-gating`, uncommitted.**

**Rust (`src-tauri/src/license.rs`, `commands/license.rs`, `main.rs`):**
- **Server trial (V1, D2b):**
  - `LicenseState.trial: Option<ServerTrial { started_at, expires_at, synced_at }>` is the only trial that unlocks Pro.
  - `ServerTrial::is_valid` requires `[2026-01-01, 2100-01-01)`, a start before the end and a length of at most 31 days (checked subtraction). An invalid stored window never unlocks.
  - `LicenseState::inactive` no longer creates a local trial, so a fresh install is Free until the server answers.
  - The legacy `trial_started_at` / `trial_expires_at` never grant access; they only migrate.
  - The App Store policy also strips `trial`.
- **Sync (A2, V2, V3, W1):**
  - New command `license_trial_sync(apiBase, product)` → `trial_sync_at`. On the App Store it returns the current state with no request.
  - It holds the operation lock and posts `{ product, device, legacyStartedAt? }` to the `trial` action through the shared fallback candidates and HTTP limits.
  - The response must parse and pass `is_valid`; otherwise the error is `Malformed`.
  - On success one file-lock write stores `trial`, sets `legacy_retired`, and clears `legacy_trial_started_at`, `trial_started_at` and `trial_expires_at`.
  - Every failure writes nothing and returns the current snapshot.
  - Legacy capture now also stops once a server trial exists.
  - `carry_device_fields` carries `trial`, so activate, refresh, save and clear keep it.
- **Shared POST.** `post_license_api` is now generic over the request and returns the body of the first successful response. License actions parse it into `LicenseApiResponse`; the trial action parses `TrialResponse`. The 404, HTML and "Cannot POST" route fallback and the typed errors are unchanged.

**Frontend:**
- **Wrappers.** `licenseTrialSync` wrapper and `CMD.licenseTrialSync`. `ServerTrial` and `LicenseState.trial` types. `DistributionFeatures.serverTrial` is true only for Direct.
- **Scheduler (`stores/license.ts`, V4, W3).** A module singleton:
  - **Triggers:** load, focus or visibility (at most once per 10 min), online, and its own wake-up timer.
  - **Single-flight:** one request at a time.
  - **Success:** the next attempt is in 6 h; status `verified` with `lastOkAt`.
  - **Failure:** backoff of 30 s → 2 min → 10 min → 30 min.
    - 429: `max(Retry-After, 60 s)`.
    - 400: syncing stops until the app restarts.
    - Network, timeout or 404: an `online` event retries at once.
  - **Known window:** a failure publishes the snapshot the error carries, so the stored window stays.
  - **Lifetime:** the scheduler is independent of license re-reads, so an expiry re-read never cancels it.
  - The API base is read at call time (`licenseApiBase()`).
- **Presentation (V5).** `TrialStatusNote` / `trialNote` is used by `LicenseDialog` and `LicenseKeySettings`:
  - "Free trial: N days left (ends DATE)";
  - "Free trial ended on DATE";
  - "Free trial not activated yet. Connect to the internet to start it";
  - a muted "Couldn't reach the license server." when the status is `unavailable`;
  - nothing for an active license or for the App Store.

**Tests:**
- **Rust (`license::tests`, 37):**
  - `a_trial_kept_on_the_device_never_unlocks_pro` and `server_trial_windows_are_validated` (bounds, 31 days, overflow, invalid stored window);
  - with loopback:
    - a sync stores the window, sends the legacy start once, retires the legacy fields in the same write, and keeps the trial across clear and reload;
    - a failed sync keeps the known window for 500, 429, 400, malformed, a 60-day window and offline, and attaches the snapshot each time;
    - the App Store makes no request;
    - sync and activation in both orders keep each other's fields.
  - The earlier tests now use server trials: a fresh install is Free, the expiry re-read uses a server window, and legacy files are migration-only.
- **Frontend:**
  - `stores/license.trialSync.test.ts` (8): a sync on load then 6 h later; focus and online after a success do nothing; single-flight; backoff retries with no event; an immediate retry on online after a network failure; 429 `Retry-After`; 400 suppression that survives reloads; a failure keeps the known trial; the retry timer survives a re-read.
  - `TrialStatusNote.test.ts` (5).

**Verification:**
- **Rust:**
  - `cargo test --locked`: 432 passed / 15 ignored, the same with `--features app-store`.
  - Clippy: 8 (default) and 9 (app-store), the baseline.
- **Frontend:**
  - Vitest with `VITE_POLITEDB_API_BASE=http://localhost:4000/api`: 136 files / 809 tests passed.
  - `tsc`, Prettier and `npm run build` pass.
  - `git diff --check` is clean.
- **Not done:**
  - The app was not run against a deployed backend, because the backend is not deployed.
  - There was no live end-to-end sync.

### Fixes for Codex review "pro-gating Phase 3" (Claude, 2026-10-19)

Codex returned CHANGES REQUIRED with three P2 findings. All three are fixed.

1. **P2: a malformed deactivation reply cleared credentials.**
   - **Fix:** `deactivate_at` now parses the 2xx reply (`parse_api_payload`) before clearing anything, and attaches the current snapshot on failure.
   - **Test:** `a_malformed_deactivation_reply_clears_nothing`. Plain text and an empty 200 reply leave the file bytes, credentials, paid flag and trial untouched. A valid reply clears the credentials and keeps the running server trial.
2. **P2: a long `Retry-After` overflowed the timer.**
   - **Fix:** `scheduleTrialSyncWake` caps each wait at 24 h and keeps the absolute deadline. A wake that comes before the deadline only re-arms the timer. The server's delay is never shortened.
   - **Test:** a 30-day `Retry-After` causes no request through 29 days of intermediate wakes, then one retry once the deadline passes, without any event.
3. **P2: the trial line was hidden for an active license that is not paid.**
   - **Fix:** `trialNote` hides only when `paid_license` is true. Both `LicenseDialog` and `LicenseKeySettings` also render the note in their active-license branch.
   - **Tests:**
     - `trialNote` with an active free license: running, ended, and absent with offline feedback; it is suppressed for a paid license even while offline.
     - The new rendered test `LicenseKeySettings.trial.test.tsx`, for the active-free running trial, offline with no trial, and paid-hidden cases.

**Coverage gaps closed:**
- **Trial route fallback:** `the_trial_route_is_found_after_a_missing_prefixed_route` covers a 404 on `/api/v1/licenses/trial` followed by success on `/api/v1/trial`.
- **Legacy lifecycle:** `a_legacy_trial_survives_every_operation_until_the_server_accepts_it` runs the full V3/W4 matrix on one file:
  - an exhausted legacy file;
  - activate → refresh → deactivate → reload;
  - a 503 sync, a malformed sync, then a delayed successful sync.
  It checks that every trial request carries the original `legacyStartedAt`, that the field survives each failure, and that the server window uses that start, so the trial stays exhausted. It also checks that the legacy fields are retired.

**Verification:**
- **Rust:** `cargo test --locked` gives 435 passed / 15 ignored, the same with `--features app-store`. `license::tests`: 40. Clippy: 8 and 9, the baseline.
- **Frontend:** Vitest with `VITE_POLITEDB_API_BASE` set: 137 files / 814 tests passed. `tsc`, Prettier and the build pass.
- `git diff --check` is clean.

### UI adjustments after local testing (user, 2026-10-19)

- **Toolbar badges removed:** the corner "Pro" badges on the Backup, Restore and Health Inspector toolbar icons are gone ("bỏ mấy chữ pro này ở đây đi"). This is a deliberate exception to D8 for these icon-only buttons. Their tooltips still say "(Pro)", and the gates are unchanged.
- **Assistant mode:** the "Agent · Pro" chip (V7) is replaced by an Agent / Manual mode picker at the bottom left of the composer.
  - **Choice:** stored per device in `politedb.ai.mode`; Agent is the default.
  - **Manual:** always answers with basic chat, and shows no upgrade hint.
  - **Without Pro:** the picker shows Manual. Choosing Agent opens the upgrade dialog. The hint still appears when the stored mode is Agent.
- **Diagram panel and JSON export:** the "Database Structure" panel was removed (taking "Copy Mermaid" with it) and replaced by a free JSON export. The export menu now sits in the diagram canvas, with the export logic in `useDiagramExport`.
- **Export menu:** the ER diagram's "Export as PNG" and "Export as SVG" buttons are now one "Export as..." menu that opens upwards. The SVG entry carries the Pro badge; PNG stays free.

### Fixes for Codex review "pro-gating UI follow-ups" (Claude, 2026-10-19)

Codex returned CHANGES REQUIRED with three P2 findings. All three are fixed.

1. **P2: Manual could run the agent when storage failed.**
   - **Fix:** `assistantMode.ts` now holds one authoritative session value. It is initialized from storage and persisted on a best-effort basis, with `subscribeAssistantMode`. The picker, the panel (`useAssistantMode`) and submission (`getAssistantMode`) all read that value.
   - **Test:** with `setItem` throwing, choosing Manual makes both `getAssistantMode()` and the trigger read Manual.
2. **P2: an Agent hint stayed visible after switching to Manual.**
   - **Fix:** the panel renders the hint only while the session mode is Agent.
   - **Test:** a rendered panel regression covers hint shown → Manual chosen → hint gone.
3. **P2: the picker's accessibility.**
   - **Fix:**
     - The trigger is named "Assistant mode: <current>" and has `aria-expanded` and `aria-controls`.
     - The menu has `role="menu"`, and its items are `menuitemradio` with `aria-checked`.
     - Opening the menu focuses the selected mode. The arrow keys and Home/End move between items, and Escape closes the menu and returns focus to the trigger.
   - **Tests:** roles and states, focus on open, arrow wrap-around, Escape with focus restoration.

**Coverage gaps closed:**
- **`Checkbox.test.tsx`:** an accepted change in both directions; a refused change from both initial states; an uncontrolled checkbox; the indeterminate state with the disabled attribute. jsdom dispatches clicks on disabled inputs, so the disabled-click case is left to browsers.
- **`system-dialog/index.test.ts` (`chooseDialog`):**
  - the button shape for yes/no/cancel and for ok/cancel;
  - custom label mapping and the standard Yes/Ok/No/Cancel results;
  - close and unknown results map to cancel;
  - "No" from an ok/cancel dialog is never treated as a choice;
  - the browser `window.confirm` fallback.

**Verification:** Vitest passes 142 files / 840 tests; `tsc`, the build and Prettier pass.

**Round 2 (Codex: accessibility P2 partially resolved).**
- **Problem:** initial focus ran before the app Popover mounted its content.
- **Fix:** the selected mode is focused from the menu's mount ref, and also on open, which covers reopening during the close transition.
- **Tests:** `AssistantModePicker.popover.test.tsx` keeps the real app `Popover` and mocks only `react-tiny-popover`. It covers focus on mount, arrow keys, Escape with focus return, reopening after a full close, and reopening during the close transition. A mutation check confirmed the test catches the bug: dropping the mount ref fails it.

**Still manual:** a real Popover layout, a screen reader, and the native dialog's close and Escape on each OS.

## Plan Review

(empty)

### Codex critique — Revision 2

Reviewed `99a5f22` using `git diff origin/main...HEAD`, with `origin/main` at `57de05f` (PR #62). Agent evidence below explicitly refers to `origin/main`, because those files are absent from this branch. Inspected the sibling backend read-only, including routes, license service, entities, migrations and tests. No implementation or runtime checks performed for this plan critique. D1–D8 remain settled; findings concern implementation contracts and coverage.

#### Blocking — fix before approval

1. **Access does not expire in a running app.** Evidence: `src/hooks/useProGate.ts:13-30` only recalculates when the store changes; `src/lib/license/proAccess.ts:35-41` trusts the cached boolean; `src/stores/license.ts:53-69` loads/refreshes without an expiry scheduler. A trial can end while Backup, SVG, masking and analyzer remain unlocked indefinitely. Fresh Rust checks would deny the agent while TS still allows it. **Fix:** define one authoritative entitlement refresh mechanism with expiry scheduling and resume/focus handling, publish finalized state to all consumers, and make action guards consult current state rather than a captured boolean. Include paid-license expiry too. Test time crossing expiry with the window left open, multiple consumers, and no restart. Define whether already-started work completes; preserve export cleanup and destructive-operation safety.

2. **Activation, refresh and clear can erase authoritative trial provenance or restart the trial.** Evidence: `src-tauri/src/license.rs:644` normalizes activation with `previous = None`, and `:437-448` creates a new trial when previous state is absent. `:460-523` reconstructs the full state; `:408-410` preserves only trial dates on clear. Adding `trial_source` only to sync does not preserve it through these paths. After activating then deactivating, an expired server trial can become a fresh local trial. **Fix:** specify a trial substate merge used by activate, validate/refresh, clear/deactivate, save and load; preserve server dates, source and clock metadata independently of license credentials, and never create a replacement provisional trial for a known server trial. Legacy state without a source must have an explicit migration rule that preserves its original local dates. Test expired server trial → activate → refresh → deactivate/clear → reload, including failures and App Store sanitization.

3. **Background sync has no concurrency/merge contract.** Evidence: `src/stores/license.ts:58-65` publishes background refresh after setting `busy = false`; `:75-119` can concurrently activate/deactivate. Rust refresh snapshots state before awaiting HTTP (`src-tauri/src/license.rs:653-673`), while save writes a complete object (`:391-399`). A new trial sync can overwrite a newer activation, or refresh can overwrite a newly received server trial; frontend completions can publish older state even if disk is correct. Atomic file replacement does not prevent these lost updates. **Fix:** fetch outside a short license-state lock, then re-read and merge only action-owned fields under that lock; reject stale credential responses using a generation/identity check. Serialize or version frontend publication too. Add deterministic delayed-response tests for sync versus activate, refresh, deactivate and another sync, checking both disk and store results.

4. **The clock-skew rule cannot survive finalization as specified.** Evidence: plan `:87-92` persists only dates and source, but `src-tauri/src/license.rs:173-195` recomputes access solely from local time and expiry on every load/save. A sync-time `pro_access = false` would be recomputed to true by the next agent command/load; copying server `now` and comparing it forever would instead reject a healthy clock a day later. A rollback after a successful sync also has no defined handling. **Fix:** specify persisted clock evidence, how elapsed time advances, how skew invalidates only trial eligibility, and how clock correction clears that condition without changing the original window. Use the same eligibility function in finalization and all gates; preserve valid paid access when only trial clock validation fails. Test >24 h, exactly 24 h, correction, restart, offline load after server sync, future-start/malformed windows and rollback after sync.

5. **“Next successful sync” has no retry path, and deletion protection overclaims current behavior.** Evidence: plan `:86-94` syncs only on store load and explicitly publishes provisional access first; `:91` claims deletion cannot extend access online. Deleting the file and launching grants access before the asynchronous server response even online; launching offline then reconnecting has no specified sync trigger, so an expired server trial can remain provisional for that entire session. Also, a device first used provisionally for 14 days can receive another 14 days when the server first sees it. **Fix:** explicitly document that unavoidable first-contact extension under the chosen API, and distinguish provisional bootstrap from confirmed entitlement. Add bounded retries/reconnect/resume sync, retain a known server window on every failure, and prevent repeated provisional grants once server expiry is known. If immediate provisional access remains intentional, state that online startup has a bounded optimistic interval instead of claiming complete reset prevention. Test deleted local state against an existing expired server row, offline → online without restart, failed sync of a known server trial, 404/429/5xx/malformed responses, and delayed first server contact. Do not silently expand the chosen 14-day provisional allowance.

6. **Persisted consent cards remain an ungated frontend entry point.** Evidence on `origin/main`: `src/components/ai-assistant/AiAssistantPanel.tsx:555-582` directly calls `aiAgentDataAccessGrant` from existing chat cards, outside the agent branch in `hooks/useAiAssistantSubmit.ts:372-376`. Its error handler at `:566-569` maps a new Pro denial to generic permission-save failure. B2 prevents new cards but does not handle cards saved during a trial, or downgrade while Allow is pending. **Fix:** gate/hide or replace existing Allow actions for Free with the shared upgrade flow, invalidate pending Allow generations on entitlement loss, and handle `AI_AGENT_PRO_REQUIRED` with fixed copy in this handler as well as the submit error formatter (before its generic `AI_AGENT_` branch at `hooks/useAiAssistantSubmit.ts:120`). Preserve consent revoke/status access and never grant or retry automatically after upgrade. Extend `AiAssistantPanel.allow.test.tsx` for reopened historical cards, downgrade during grant, and context changes. Keep `withoutData` filtering on every Free legacy path (`hooks/useAiAssistantSubmit.ts:340-345`), and preserve its provenance marking.

#### Should-fix

7. **D1 parity needs the entire entitlement input, not just a plan-name function.** Evidence: `src/lib/politedbBackend/ai.ts:159-178` derives gateway tier from only `plan_name`, regardless of status, expiry or explicit `plan`; backend responses contain authoritative `plan` (`../politedb-backend/src/services/polar-license-key.ts:130-139`, `:160-169`). Moving that function cannot make an active `{ plan: "free", plan_name: "Ultimate" }` agree with Rust, nor recognize `{ plan: "pro", plan_name: "Polar License" }`. `src-tauri/src/license.rs:521` also carries forward a previous plan when a response omits it. **Fix:** define paid-plan classification separately from trial-inclusive feature access and gateway transport labels. Feed status, explicit tier and normalized legacy name into equivalent Rust/TS contracts; define absent/null/empty tier behavior and prevent cached explicit tiers from defeating an authoritative response downgrade. State whether gateway quota includes trials; do not accidentally change it through a helper move. Shared fixture cases should cover conflicting tier/name, unknown/whitespace tiers, case, suffix boundaries, expired Ultimate, and active Pro with an arbitrary display name.

8. **Unique-conflict recovery and privacy need concrete backend requirements.** Evidence: plan `:74` says catch and re-read, but `../politedb-backend/src/db/orm.ts:58-59` provides a forked entity manager and `test/helpers.ts:8-12` uses SQLite; this does not prove a failed Postgres flush/transaction can safely be reused. Unexpected errors reach raw `console.error` and error reporting (`../politedb-backend/src/app.ts:115-117`), which can expose SQL parameters/device identifiers from database exceptions. **Fix:** use a conflict-safe insert or roll back and re-read through a clean entity manager; catch only the expected composite unique conflict and preserve the winning dates. Sanitize trial database failures to fixed codes before generic logging/reporting, with no payload, device id/name, key or SQL parameters. Add real Postgres parallel-create tests using separate managers and log/report spies for duplicate and unexpected failures. Register `TrialSchema` in `entities` (`src/db/entities.ts:117-121` in the backend). Export or move the shared device schema, currently private (`src/services/polar-license-key.ts:11`), into a narrow validation module. Bound public input lengths and define product normalization/allowed products so whitespace aliases and arbitrary product strings do not quietly create new trial namespaces.

9. **Health inspector stays usable after entitlement loss while open.** Evidence: plan `:117` leaves the MenuBar-only gate unchanged (`src/screens/connection/workspace/MenuBar.tsx:805-807`), but `src/hooks/useDbHealthInspector.ts:42-71` refreshes without checking entitlement and the dialog remains mounted at `src/screens/connection/ConnectionScreen.tsx:941`. Once corrected expiry publication lands, an already-open inspector can still refresh. **Fix:** guard collection/refresh and the rendered dialog on current entitlement, cancel or invalidate pending reads on loss, and show the shared locked state. Preserve ordinary connection health checks in MenuBar. Test open inspector → trial expiry/downgrade → refresh, with zero additional inspector queries.

10. **Verification needs Free and lifecycle coverage, not only Pro mocks.** Evidence: plan `:160` runs regression suites with Pro mocked in, which hides Free regressions. `src/components/editor/SqlResultsPane.tsx:393-410` has direct and streaming Explain paths; `:467-480` currently chooses analyzer instead of grid, so simply replacing the analyzer with a lock loses raw output. **Fix:** explicitly test raw grid plus locked analyzer affordance for both modes, restored/previous Explain runs and tier changes; keep non-plan/error/ordinary-query results unchanged. Gate both Markdown and JSON handlers while preserving the privacy confirmation (`QueryAnalyzer.tsx:139-165`) and baseline import behind the render boundary. Test Free CSV/JSON/SQL export, all-Keep passthrough and column selection versus actual masking (`runStreamingExport.ts:92-107`), masking-policy persistence across downgrade with a clear upgrade error and no raw-data fallback, SQL dump import through all three callers, PNG and Mermaid, and App Store agent/grant/SVG with no trial request. The identified production analyzer render is only `SqlResultsPane`; diagram SVG generation is also used internally by PNG (`DiagramGeneratorDialog.tsx:110`), so do not gate the shared `buildDiagramSvg` helper. Preserve existing Pro analyzer and consent tests too.

11. **Deploy order is right but release readiness is underspecified.** Evidence: plan `:182-203` permits Phase 1 with local trials and treats missing Phase 3 endpoint as offline; backend migration tests are optional. Backend route mounting already makes `/trial` in `licenseRouter` resolve to `/api/v1/trial` (`../politedb-backend/src/routes/index.ts:10`, `src/app.ts:77`); the app's existing candidates cover it (`src-tauri/src/license.rs:587-621`). **Fix:** keep phases as implementation/review boundaries, state whether Phase 1 may ship independently, and require migration plus real Postgres concurrency evidence before backend deploy approval (record an explicit limitation if unavailable). Verify deployed trial endpoint's units/idempotency and proxy/rate-limit configuration before Phase 3 release, not merely backend process health. Keep 404 compatibility, but surface non-sensitive sync status so a broken route does not masquerade indefinitely as successful server enforcement. Specify rollback retaining trial rows/windows. Add Rust-layer App Store early return even for direct `license_trial_sync` invocation, not only the frontend flavor guard. Plan rebase belongs to implementation, not this critique; no rebase performed.

#### Nits

12. **Update shared upgrade copy and complete badge inventory.** Evidence: `src/components/license/ProUpgradeDialogHost.tsx:18-23` hard-codes five features, omits the agent and calls all ER export Pro. MenuBar currently uses a conditional title suffix (`src/screens/connection/workspace/MenuBar.tsx:307`) rather than unconditional badges; PNG/Explain have Free-only badges (`DiagramGeneratorDialog.tsx:256`, `SqlEditorToolbar.tsx:79`). **Fix:** add agent to dialog highlights, use the SVG-specific label, remove badges from Free PNG/Explain, and enumerate an agent badge location consistent with D8 (the plan's badge list currently omits it). Define “per viewer” for the dismissal key without embedding raw device/license identifiers or chat content in storage/telemetry.

D1's positive paid signal and D3's App Store bypass are appropriate as decisions; preserve existing flavor restrictions rather than treating “all engines” as permission to remove them. UI-only enforcement and unsigned client state are explicitly accepted v1 limitations, not additional approval blockers. The blocking findings above reproduce through normal lifecycle/state paths and do not require modifying the client.

**Verdict: NOT READY.** Resolve blocking contracts and add their regression cases before approval.

### Codex re-review — Revision 3

Reviewed Revision 3 as authoritative over Revision 2. Confirmed this worktree is `feat/pro-gating` at `99a5f22`; compared `origin/main...HEAD` with `origin/main` at `57de05fae9c5d1b0b7cc6adf52094a895d8c8fc1`. Paths below refer to this worktree unless prefixed `origin/main:` or `../politedb-backend/`. Agent commands and consent UI were inspected on `origin/main`, where the agent exists. Backend inspected read-only. This is a plan review, not verification of implemented fixes.

#### Disposition of Revision 2 findings

“Resolved” below means the implementation contract is now specified; application code still needs implementation and regression verification.

| Prior finding | Disposition | Revision 3 contract and current-code evidence |
|---|---|---|
| 1. Running-app expiry | **Partially resolved** | R1 adds a shared deadline, timer, focus/resume reload, action-time reads, and lets started work finish; R7 adds trial and paid expiry coverage. This addresses the missing scheduler in `src/stores/license.ts:53-69` and captured access in `src/hooks/useProGate.ts:13-30`. Clock rollback and combining paid/trial deadlines still need B1/S1 below. |
| 2. Trial provenance across lifecycle | **Partially resolved** | R2 preserves the server substate independently of credentials and removes trial creation from normalization/inactive. That fixes the intended replacement of `src-tauri/src/license.rs:437-458,644-645`. Legacy provenance is not included in the merge contract; see B3. |
| 3. Concurrent sync/credentials/publication | **Partially resolved** | R3 correctly separates HTTP from locked disk merging and specifies delayed-response tests. Identity checks cover refresh, but not stale deactivate/activate; frontend sequence ordering is underspecified. Existing destructive completion path is `src-tauri/src/license.rs:676-696`; unversioned publications are `src/stores/license.ts:60-65,75-119`. See B2/S2. |
| 4. Persisted clock policy | **Not resolved** | R1 supplies persisted offset/high-water evidence, but its recovery claim does not follow from its predicate, and cached frontend access does not evaluate rollback. Current common finalizer is `src-tauri/src/license.rs:173-201`. See B1. |
| 5. Provisional bootstrap/retry/reset claims | **Resolved for Phase 3; release exception unresolved** | D2b removes optimistic local grants; R2 specifies reconnect/focus/periodic retries, retains known windows on all failures, and exposes status. This replaces the startup-only pattern at `src/stores/license.ts:53-69`. Phase 1 still grants new local trials, and retry triggers need one throttle; see B4/S3. |
| 6. Historical consent cards | **Resolved in plan** | R4 covers click-time gating, pending-generation invalidation, explicit re-click after upgrade, fixed errors, status/revoke preservation and filtered history. Correct integration sites verified at `origin/main:src/components/ai-assistant/AiAssistantPanel.tsx:555-582`, `origin/main:src/components/ai-assistant/hooks/useAiAssistantSubmit.ts:120,340-345,372-376`, and `origin/main:src-tauri/src/commands/ai_agent_data.rs:224-248`. |
| 7. Paid classification/gateway parity | **Partially resolved** | R1 separates paid access from trials and gateway labels and removes cached `plan` fallback. This addresses `src/lib/politedbBackend/ai.ts:159-178` and authoritative backend tiers at `../politedb-backend/src/services/polar-license-key.ts:130-139,160-169`. Blank-tier behavior, cached display-name fallback and fixture expiry inputs remain ambiguous; see S4. |
| 8. Backend conflict recovery/privacy | **Resolved in plan, with implementation notes** | R5 replaces failed-flush recovery with conflict-safe insert plus fresh read, registers the entity, bounds/normalizes input, sanitizes DB errors and requires Postgres evidence. Relevant current boundaries: `../politedb-backend/src/db/orm.ts:45-59`, `src/db/entities.ts:117-121`, `src/services/polar-license-key.ts:11-16` (the latter two also in the backend). SQLite feasibility checked below; see S5/N1. |
| 9. Open inspector after downgrade | **Resolved in plan** | R6 guards the dialog and each collect/refresh and invalidates pending work, covering `src/hooks/useDbHealthInspector.ts:42-75`. Preserve ordinary connection checks and exercise open → expiry → refresh with no new inspector queries. |
| 10. Free/lifecycle regression matrix | **Resolved in plan** | R6/R7 explicitly retain raw rows for direct/streaming/restored Explain and ordinary/error results, gate both report formats, preserve privacy confirmation, keep PNG/Mermaid and imports Free, and test all-Keep versus masking plus downgrade failure. Integration verified at `src/components/editor/SqlResultsPane.tsx:393-410,467-480`, `src/components/editor/query-analyzer/QueryAnalyzer.tsx:139-165`, `src/lib/export-pipeline/runStreamingExport.ts:92-107`, `src/components/modal/DiagramGeneratorDialog.tsx:98-110`. Keep these tests alongside the new state/clock tests below. |
| 11. Release/deploy readiness | **Partially resolved** | R8 requires Postgres concurrency/migration evidence, proxy configuration, endpoint smoke tests, backend-first Phase 3 and retained rows; R2 adds the native App Store early return. Current route composition is `../politedb-backend/src/app.ts:77` plus `src/routes/index.ts:10` (backend), rate-limit switch is `../politedb-backend/src/middleware/rate-limit.ts:5-12,31-32`. Phase 1/D2b conflict remains B4. |
| 12. Copy/badge inventory | **Resolved in plan, minor clarification** | R9 replaces hard-coded highlights, adds agent/SVG copy, removes PNG/Explain badges and defines a non-sensitive dismissal key. Current sites are `src/components/license/ProUpgradeDialogHost.tsx:18-24`, `src/screens/connection/workspace/MenuBar.tsx:307-308`, `src/components/modal/DiagramGeneratorDialog.tsx:256`. Agent badge visibility across tiers needs N2. |

#### Blocking — fix before approval

**B1. Clock correction cannot recover as promised, and frontend/native eligibility can diverge.** Plan evidence: `.agent/plans/pro-gating.md:215-233,246-248,254-256`. Let server time be T, local clock T+7 days at sync: offset = −7 days and high-water = T+7 days. Correct local time to T. Even a successful resync setting offset to zero leaves `local_now < high_water − 24 h`, so the valid trial stays locked for roughly six days. Updating the “largest local time ever observed” cannot fix this. Also, after any >24 h backward clock change while the app remains foregrounded, TS checks only cached `pro_access` and the expiry deadline; it can keep allowing UI actions while Rust's fresh finalizer rejects the agent. This repeats prior finding 4 through ordinary clock correction, without editing state.

**Fix:** define a trusted clock baseline/epoch and its recovery transition. A validated fresh server sample must atomically re-anchor the offset and the rollback baseline; ordinary finalization may advance that baseline but must not restore an older snapshot. Distinguish the immutable server window from mutable clock evidence: “only sync writes trial” currently conflicts with “every finalize updates high-water.” Specify frontend rollback handling too (shared eligibility evidence or a bounded native revalidation/clock-change detector), and define whether initial >24 h skew is compensated or denied, since Revision 2's skew test is otherwise contradictory. Test fast clock → correction → successful resync, slow clock → correction, rollback just below/at/above 24 h, offline restart, foreground clock changes without focus events, and paid access unaffected by trial clock denial. Use checked timestamp arithmetic and validate finite/integer response fields.

**B2. Locked field merging does not order credential intents or frontend snapshots.** Plan evidence: `.agent/plans/pro-gating.md:278-287`. Current deactivate snapshots credentials, awaits HTTP, then unconditionally clears whatever is now on disk (`src-tauri/src/license.rs:681-696`). Under R3, deactivate(A) can still finish after activate(B) and erase B: only refresh/validate responses have an identity check. Two activations can similarly complete in reverse order. Matching key/token alone also misses clear → reactivation of the same identity. Separately, a frontend sequence assigned at request start can discard a later authoritative merge: slow activation starts first; newer trial sync commits/publishes inactive+trial; activation then commits paid+trial, but its older request number is ignored, leaving the store behind disk. Assigning a number only at JS publication instead accepts delayed stale snapshots. Neither interpretation supplies the required ordering.

**Fix:** define credential-operation generations, reserved under the same lock, covering activate, refresh/validate, deactivate and clear; reject superseded results before any credential mutation. Return a state revision assigned at the actual locked merge/read, and publish by that authoritative revision (or serialize all mutations and reload authoritative state after completion). Include error/busy publications and direct loads. Order overlapping trial sync clock samples so an older response cannot undo a newer re-anchor. Add delayed tests for deactivate(A) versus activate(B), two activations, clear/reactivate with the same identity, refresh versus deactivate, and activation versus sync where request order differs from commit and delivery order. Assert credential state, trial state, disk revision and frontend state.

**B3. Legacy migration provenance can still disappear before first successful sync.** Plan evidence: `.agent/plans/pro-gating.md:254-262`. R2 preserves only `trial`, which is absent for legacy installations. It does not preserve the original legacy dates through activate/refresh/deactivate/clear/save while sync is pending or failing. Existing normalization reconstructs dates (`src-tauri/src/license.rs:457-458,514-515`), activation supplies no previous state (`:644`), and clear starts from a newly constructed inactive state (`:406-410`). Removing local-trial creation alone makes missing values disappear rather than protecting the original migration start. An expired legacy installation can activate/clear before first successful sync, then send no `legacyStartedAt` and receive a fresh server trial, contradicting R2's no-renewal claim. This matters even with the proposed server-substate merge implemented correctly.

**Fix:** preserve a separate migration-only original start (and any required legacy expiry evidence) from the authoritative disk state across every credential/save/load path until an acknowledged valid server row is persisted; never initialize or replace it from activation time or caller snapshots. Define old-version/seconds-to-ms decoding without resetting state (`src-tauri/src/license.rs:378-385,238-254`), and an explicit outcome for pre-2026/future legacy dates rather than claiming all exhausted trials are preserved when R2 ignores those dates. Atomically clear migration evidence only with the validated server window. Test active and exhausted legacy windows through activate → refresh → clear/deactivate → reload, failed/malformed sync, and delayed first sync; verify the actual request and winning server dates. A new installation with no legacy state remains Free until server confirmation.

**B4. Independently shipping Phase 1 contradicts D2b, and its clock state is undefined.** Plan evidence: `.agent/plans/pro-gating.md:205-209,367,394-401`. D2b says no server answer means Free, but R8 explicitly allows shipping Phase 1 with local trials. Its phase plan additionally requires a high-water rule while excluding the server-trial fields that contain `high_water_ms`. Current fresh-state creation really grants a new local window (`src-tauri/src/license.rs:110-114,134-135`), so this is observable product behavior, not merely an internal phase boundary. R3's lifecycle concurrency fixes are also deferred until Phase 3 despite Phase 1 changing the common entitlement model.

**Fix:** keep Phase 1 as an implementation/review boundary and gate app release on Phase 3 plus the live Phase 2 endpoint, unless the user explicitly approves a temporary exception to D2b. Alternatively implement server-required startup entitlement in the first shippable app phase. Place common lock/generation/finalization foundations in the first phase that changes their callers. If a non-shipping intermediate phase retains local trials, specify where its clock metadata lives and test that intermediate build; do not describe it as satisfying D2b.

#### Should-fix

**S1. Define the deadline for the union of paid and trial access.** `.agent/plans/pro-gating.md:234` says “from the paid expiry or the trial expiry,” but access is an OR. A paid license expiring tomorrow must not lock features while its trial has seven days left, nor may an expiring trial lock a still-paid user. Specify the maximum end among currently eligible finite grants; any eligible unlimited grant means no deadline. When neither is eligible, access is false. Test both expiry orders, unlimited paid plus trial, and trial denied by clock policy. The TS guard at plan `:247` otherwise makes a wrong chosen deadline an immediate denial.

**S2. Make the lock usable from the current synchronous API without nesting.** `.agent/plans/pro-gating.md:279` selects an async mutex, but `src-tauri/src/commands/license.rs:13-25` exposes synchronous load/save/clear; those same functions are called from async activation/refresh/deactivate (`src-tauri/src/license.rs:645,653,673,681,696`). Specify async propagation through all callers, including the new gate in the synchronous `origin/main:src-tauri/src/commands/ai_agent_data.rs:224-229`, or use a short synchronous disk mutex with no await inside its critical section. Factor unlocked helpers so a locked mutation cannot call a public helper that re-acquires the same lock. Do not bridge async callers with `blocking_lock()`.

**S3. Unify sync triggers and backoff.** Plan `:248` reloads on every focus/online event; `:265` syncs after every load, bypassing `:266`'s focus throttle. Define one single-flight scheduler shared by load/focus/online/interval/retry, with next-attempt time, success reset, retry cancellation, and disposal. Clarify retry policy for permanent 400 responses versus 429/5xx and whether `Retry-After` applies. Test event bursts, an expiry reload during failed-sync backoff, offline → online without restart, missing route and malformed payload; preserve known windows throughout. The old store's `busy` flag is insufficient because background refresh runs after it is cleared (`src/stores/license.ts:58-65`).

**S4. Finish the paid-input contract rather than just clearing `plan`.** Plan `:225-227` both permits fallback for a blank tier and says blank values are Free. Choose one exact rule for absent/null versus present-empty/whitespace/unknown and put it in fixtures. `normalize_api_state` also carries `plan_name` forward (`src-tauri/src/license.rs:481-484`): a response omitting both fields can still inherit an old “Ultimate” after the cached explicit tier is cleared. Define response-owned paid-classification fields together, so missing display name cannot revive a stale paid classification. Add `expires_at` and evaluation time to the shared fixture contract (`.agent/plans/pro-gating.md:237` currently lists neither), including status=active with a past expiry, missing expiry and malformed expiry, and verify Rust/TS parity on actual normalized inputs.

**S5. Keep the SQL fix, tighten its verification contract.** Installed backend versions are MikroORM 7.2.5 (`../politedb-backend/package.json:23-25,39`). I ran a disposable **in-memory SQLite** probe using those installed packages: inserting twice with `onConflict(['product','device_id']).ignore()` produced affected row counts 1 then 0; a fresh manager found one row with the first insert's id. No backend files or external DB were written. Thus no demonstrated SQLite incompatibility or need to revert to exception recovery. This is not a trial-service test or proof of Postgres concurrency. Prefer typed entity property names such as `['product','deviceId']` when using the existing camelCase entity convention (`../politedb-backend/src/db/entities.ts:19-25,74-86`): installed `QueryBuilder.d.ts:679` types conflict fields as entity paths, while `QueryBuilder.js:673-684` maps those paths to column names and accepts raw names at runtime. Explicitly execute the insert, await autocommit before the fresh read, then update only last-seen metadata; never derive winning dates from a losing insert's return value. Retain SQLite service tests plus mandatory separate-manager Postgres parallel-create and fresh/existing-schema migration tests (`../politedb-backend/test/helpers.ts:8-12`, `test/migrations.pg.test.ts:54-84`). Unavailable Postgres evidence is a release blocker to record, not a waived deploy check. [MikroORM query-builder documentation](https://github.com/mikro-orm/mikro-orm/blob/master/docs/docs/query-builder.md) also documents conflict-ignore; fetched through Context7.

**S6. Migrate trial presentation alongside entitlement.** R2 clears legacy dates, but both `src/components/modal/LicenseDialog.tsx:52-56,157-168` and `src/components/settings/LicenseKeySettings.tsx:58-65` still render exclusively from `trial_expires_at` and local wall time. Add both to Phase 3's explicit file/acceptance list. Render the server window plus derived eligibility/sync state, distinguish never-verified Free from expired trial and clock-unavailable trial, and avoid reporting a clock-denied trial as healthy merely because its date is in the future. Cover successful migration, offline-known window and never-contacted startup.

#### Nits

**N1. Correct the AppError logging reference.** R5 (`.agent/plans/pro-gating.md:314`) points at the raw-error branch and says it logs an AppError code. Actual `../politedb-backend/src/app.ts:89-95` returns AppError without logging/reporting anything; `:115-117` logs/reports unknown exceptions. Preserve the early return and assert that sanitized trial DB failures reach it, with neither raw DB exception nor sensitive details reaching either sink. No new logging is needed.

**N2. Place an agent badge where paid users can actually see it.** R9 says badges show to every tier (`.agent/plans/pro-gating.md:380-387`), but B2's fallback hint is shown without Pro and consent cards are conditional. Identify a persistent agent affordance/header for the badge, or explicitly specify the hint's badge-bearing presentation for Pro too without displaying upgrade copy to paid users. Keep the once-per-chat/dismissal behavior separate.

**Verification limits:** no application implementation, build, full test suite, Postgres migration/concurrency run, rebase, commit, or backend modification. The only runtime check was the isolated SQLite API probe above. Preserve D1–D8 and D2b; unsigned state and client-supplied device id remain accepted v1 limits, not additional findings.

**Verdict: NOT READY.** Resolve B1–B4 and make the remaining implementation contracts explicit before approval.


### Codex re-review — Revision 4

Reviewed Revision 4 as authoritative where it overrides earlier text. Confirmed `feat/pro-gating` at `99a5f22`, with `origin/main` at `57de05fae9c5d1b0b7cc6adf52094a895d8c8fc1`; inspected the agent on `origin/main` and `../politedb-backend` read-only. References below describe existing code and proposed contracts, not implemented fixes. D1–D8, D2b, D2c, D2d and D9 remain settled; unsigned state and client device identity are accepted v1 limits.

#### Disposition of every Revision 3 finding

| Finding | Disposition | Evidence and remaining work |
|---|---|---|
| B1 — clock recovery/parity | **Resolved by D2c** | Plan `:405-408,414-417,441` removes offset/high-water/skew enforcement. Existing native clock boundary is `src-tauri/src/license.rs:173-177,204-229`. No rollback protection requested. Publication correctness is a separate issue below. |
| B2 — credential/publication ordering | **Partially resolved** | Plan `:445-465` serializes credential operations and assigns write revisions, replacing the stale completion paths at `src-tauri/src/license.rs:644-645,653-673,681-696` and unversioned store publications at `src/stores/license.ts:60-65,75-119`. Serialization is viable, but timeout and read-publication contracts need B1/B2 below. |
| B3 — legacy provenance | **Resolved in intent; lifecycle clarification needed** | Plan `:469-481` preserves a migration-only original start, migrates old versions/seconds, retains it across credentials/failures and clears it atomically with the server window. This addresses `src-tauri/src/license.rs:238-254,378-387,406-410,457-458,514-515`. S2 below specifies initialization and cleanup around the new read-only path. D2d and the explicitly documented out-of-range outcome remain accepted. |
| B4 — independent Phase 1 release | **Resolved by D9** | Plan `:410,539-549` makes Phase 1 unreleased and requires Phase 3 plus the live backend. This explicitly replaces `:367`; no separate local-trial release remains. |
| S1 — paid/trial union | **Resolved for Direct; App Store edge needs clarification** | Plan `:423-432` selects the latest eligible finite deadline or unlimited access. This replaces the single cached boolean at `src-tauri/src/license.rs:183-201` and supplies both expiry-order tests. See S4 for the unconditional distribution grant. |
| S2 — lock/async integration | **Resolved structurally** | Plan `:449-452` separates short synchronous file reads from async operation serialization, prohibits nested public helpers and `blocking_lock`, and converts command wrappers currently synchronous at `src-tauri/src/commands/license.rs:13-25`. The synchronous grant at `origin/main:src-tauri/src/commands/ai_agent_data.rs:224-248` can use the private synchronous reader; it need not await the operation lock. Existing async credential callers at `src-tauri/src/license.rs:645,653,673,681,696` must switch to private helpers. Timeout/lazy-migration details remain below. |
| S3 — scheduler/backoff | **Partially resolved** | Plan `:485-503` unifies triggers, single-flight, failure classes, expiry reads and cleanup, addressing the independent background refresh at `src/stores/license.ts:53-69`. Success cadence, timer ownership and structured native errors still need S1 below. |
| S4 — paid inputs/fixtures | **Mostly resolved** | Plan `:418-440` distinguishes absent/null from present blank tiers and makes both classification fields response-owned, fixing cached name/tier fallback at `src-tauri/src/license.rs:481-484,521`. Actual backend responses carry `plan`, `planName` and nullable RFC3339 `expiresAt` (`../politedb-backend/src/services/polar-license-key.ts:130-140,160-169`). Malformed-expiry normalization still needs S3. |
| S5 — conflict-safe backend verification | **Resolved in plan** | Plan `:517-527` specifies entity property names, awaited insert, fresh manager, metadata-only updates and mandatory Postgres evidence. Matches camelCase mapping at `../politedb-backend/src/db/entities.ts:74-93`, fresh forks at `../politedb-backend/src/db/orm.ts:58-59`, SQLite test setup at `../politedb-backend/test/helpers.ts:8-12` and fresh/existing-schema migration cases at `../politedb-backend/test/migrations.pg.test.ts:54-84`. Entity registration remains required by R5 (`:315`; backend list currently `src/db/entities.ts:117-121`). No new ORM API probe performed. |
| S6 — trial presentation | **Resolved in plan** | Plan `:507-513,547` explicitly migrates both consumers from legacy dates, with never-verified, expired and offline-known states. Existing consumers verified at `src/components/modal/LicenseDialog.tsx:52-56,157-168` and `src/components/settings/LicenseKeySettings.tsx:58-65`. Clock-denied copy is correctly dropped under D2c. |
| N1 — AppError reference | **Resolved** | Plan `:523-525` now points to the actual early return at `../politedb-backend/src/app.ts:89-95`; unknown exceptions reach sinks at `:115-117`. Sanitization and sink-spy requirements remain explicit. |
| N2 — all-tier agent badge | **Resolved in plan** | Plan `:531-535` gives every tier a persistent header chip, independent of hint/card visibility. Existing conditional Allow integration is `origin/main:src/components/ai-assistant/AiAssistantPanel.tsx:555-582`. Tooltip accuracy needs only N1 below. |

#### Blocking — fix before approval

**B1. End-to-end operation locking relies on timeouts that are not configured.** Plan `:446-447` asserts HTTP already has bounded timeouts. Actual `src-tauri/src/license.rs:538-548` constructs `reqwest::Client::new()` and awaits send without an explicit deadline; body reading at `:551-554` is also unbounded by application code. URL fallback can try four candidates (`:618-621`). A stalled response can therefore retain `LICENSE_OP_LOCK`, preventing activation, refresh, deactivate, clear, save and trial sync indefinitely. Read-only gates remaining responsive does not unblock credential management.

**Fix:** retain serialization, but specify an explicit total operation deadline covering send, body consumption and all fallback candidates, plus optional shorter per-attempt/connect limits. Timeout must release the operation lock, preserve current credentials/trial and return a structured failure. Queue waiting must not hold the synchronous file mutex. Add a mock that accepts a connection and never completes its body; verify timeout, then a queued clear/activation completes and a read-only gate remains responsive throughout. No need to return to the more complex generation design.

**B2. Write-only revisions plus strict greater-than publication discard time-derived state changes.** Plan `:450,453-455` makes load read-only, increments revision only on writes and ignores equal revisions; `:495` explicitly uses a local re-read at expiry. Example: publish trial-active revision 8; at its deadline load finalizes `pro_access=false` with revision 8, which the store discards. `hasProAccess` can still refuse an action using its deadline, but subscribed UI, pending-consent invalidation and displayed status do not receive the new state. Current finalization changes status/message/access (`src-tauri/src/license.rs:173-201,204-232`), and current load persists that result (`:377-388`). Making it read-only changes this invariant. Returning equal-revision current state on error has the same problem.

**Fix:** distinguish durable mutation ordering from snapshot publication ordering. For example, assign a process-wide snapshot sequence under the file mutex on every finalized read/write, publish by that sequence, and retain a separate durable revision; initialize the frontend watermark below the first valid sequence. Alternatively persist/revision every changed finalized snapshot under a clearly specified atomic transaction. Do not simply accept all equal revisions: delayed pre-expiry snapshots could then restore stale state. Test expiry with no disk mutation or HTTP, delayed pre-expiry load delivered after post-expiry load, initial legacy revision zero, and error publications; assert subscriber notifications and pending-grant invalidation as well as action denial.

#### Should-fix

**S1. Finish scheduler cadence and error transport.** Plan `:487-489` never sets `nextAttemptAt` on success, so every subsequent focus can sync again; the old ten-minute focus throttle (`:266`) was replaced. Backoff durations alone do not explicitly require a wake-up at `nextAttemptAt`, and disposing timers on every reload (`:496`) can cancel the retry or six-hour timer during an expiry read. Native failures currently become plain strings, discarding HTTP status and `Retry-After` (`src-tauri/src/license.rs:550-565`; wrappers return `Result<LicenseState, String>` at `src-tauri/src/commands/license.rs:29-54`). **Fix:** define success/focus minimum cadence, one scheduled retry wake-up, scheduler lifetime independent of expiry/load reads, and a typed trial-sync result carrying failure kind/status/retry delay without raw payloads. Keep permanent-400 suppression across reloads until process restart. Test repeated focus after success, retry firing without events, repeated expiry/load during backoff, and 429 header transport. Existing backend limiter really emits 429 with standard headers (`../politedb-backend/src/middleware/rate-limit.ts:21-27,31-32`).

**S2. Make legacy capture atomic before any mutation, and retire both legacy representations.** Plan `:470` says capture only “on load”, while `:450` says load is read-only. Existing load writes migrated/default state (`src-tauri/src/license.rs:378-387`); clear reads raw disk and reconstructs state (`:402-414`); activate currently never loads it (`:625-645`). An activation/clear invoked before store load must not discard the sole old `trial_started_at` before capture. **Fix:** a shared disk decoder must derive migration evidence on every first read, including mutation entry paths; persist it atomically with the operation under the file mutex, without requiring startup ordering or reacquiring the operation lock. On successful sync clear `legacy_trial_started_at` **and** old `trial_started_at`/`trial_expires_at` in the same write, preserve the server trial on all saves/clears, and prohibit recapture from retired fields. Add mutation-before-first-load, concurrent load/mutation, restart before first successful sync, and sync → clear → reload tests. This tightens D2d implementation, without changing its outcome.

**S3. Specify malformed expiry and timestamp domains before sharing fixtures.** Plan `:418,433-440` includes malformed `expires_at` but gives no expected normalization outcome. Existing parsing leaves an active malformed expiry untouched (`src-tauri/src/license.rs:221-225`), whereas V1 says only absent/future expiry qualifies. TS currently types it as a string (`src/lib/tauri/license.ts:31`). **Fix:** distinguish absent/null unlimited from present-invalid; make present-invalid ineligible for the paid grant while retaining any valid trial, define RFC3339 parsing to epoch ms once, and include raw-response normalization tests alongside normalized fixtures. Give fixtures concrete expected values for exact expiry equality, null/missing/malformed dates, both union orders, and invalid trial bounds. Validate server timestamps as safe integers within a shared representable epoch range and use checked subtraction/addition for the 31-day window and legacy start +14 days (`:415,475`), rather than relying on integer deserialization alone. Rust's real `now` calls (`src-tauri/src/license.rs:177,208`) must be replaced/passed through one supplied evaluation time in fixture tests.

**S4. Treat the distribution bypass as an unlimited grant before the empty-union rule.** Plan `:423` grants App Store access unconditionally, but `:426` says no eligible paid/trial grants means `pro_access=false`. Existing bypass is explicit at `src-tauri/src/license.rs:183-185` and `src/lib/license/proAccess.ts:39-40`. **Fix:** finalize ungated distributions first as `{pro_access:true, pro_access_until:None}`, then evaluate paid/trial union only for Direct. Include App Store with neither grant and with an expired paid license in shared fixtures. This implements settled D3/R7, not a new distribution decision.

#### Nits

**N1. Use entitlement-accurate chip copy.** Plan `:532` says “Agent mode is on” for every Pro/trial user, but agent availability also depends on provider/model/engine capability (`origin/main:src-tauri/src/commands/ai_agent.rs:75-97`); the existing submit fallback remains intentional. Prefer “Agent mode included with Pro” or derive an actual running/available state. Keep the all-tier badge unchanged.

**Verification limits:** static plan/code review only. No implementation, rebase, build/test suite, Postgres run, deploy or commit. Backend read only. Only this subsection appended; earlier plan/reviews retained. Postgres concurrency/migration and live smoke evidence remain release gates, not reasons to reopen settled product decisions.

**Verdict: NOT READY.** Resolve B1–B2 and finish the listed implementation contracts before approval.


### Codex re-review — Revision 5

Reviewed on 2026-10-19 against `feat/pro-gating` at `99a5f22`, the local `origin/main` AI-agent sources, and read-only backend sources. Revision 5 takes precedence over Revisions 2–4. D1–D8, D2b, D2c, D2d and D9 remain settled; unsigned state and client-supplied device identity remain accepted v1 limits. This is plan readiness, not implementation verification or release approval.

#### Revision 4 findings

| Finding | Result | File:line evidence |
|---|---|---|
| B1 — bounded operation locking | **Resolved in plan** | `.agent/plans/pro-gating.md:555-569` replaces the unbounded request/body path at `src-tauri/src/license.rs:538-554` and four-candidate fallback at `src-tauri/src/license.rs:618-621` with 5 s connect, 15 s whole-attempt, 30 s aggregate HTTP deadlines, a 64 KiB body cap, sanitized typed failures and scope-based operation-lock release. Stalled-body, queued-operation, responsive-gate and fallback-budget tests directly cover the failure. |
| B2 — time-derived snapshot publication | **Resolved in plan** | `.agent/plans/pro-gating.md:573-587` separates durable write revision from process-wide snapshot sequence, assigns the sequence under the file mutex for reads/writes/errors, and publishes strictly newer snapshots. Thus an expiry read publishes without a disk mutation and a delayed pre-expiry read cannot replace it. Tests include subscriber notification and pending-consent invalidation. This replaces unversioned publications at `src/stores/license.ts:60-65,75-119` while preserving time-derived finalization currently at `src-tauri/src/license.rs:173-201,204-232`. |
| S1 — scheduler cadence and error transport | **Resolved in plan** | `.agent/plans/pro-gating.md:591-603` sets a six-hour success deadline, ten-minute focus minimum, one deadline wake-up, session-owned scheduler independent of reloads, typed sync outcomes, parsed Retry-After and persistent session-level 400 suppression. Tests cover event-free retries and reloads during backoff. This addresses string-only errors at `src-tauri/src/license.rs:550-565` and `src-tauri/src/commands/license.rs:29-54`; backend limiter configuration is `../politedb-backend/src/middleware/rate-limit.ts:21-32`. |
| S2 — first-read legacy capture and retirement | **Resolved in plan** | `.agent/plans/pro-gating.md:607-622` makes all entry paths use one decoder, captures before mutation regardless of startup ordering, permits atomic capture on load, and retires all three legacy fields together with the validated server window. Save/clear preserve that window; tests cover mutation before load, concurrency, restart and sync → clear → reload. These replace the divergent current load/clear/activation paths at `src-tauri/src/license.rs:378-387,402-414,625-645`. |
| S3 — expiry normalization and timestamp domains | **Resolved in plan** | `.agent/plans/pro-gating.md:626-637` explicitly distinguishes absent/null unlimited expiry from malformed ineligible expiry, retains valid trial eligibility, defines RFC3339-to-ms normalization and equality-as-expired, bounds trial timestamps, requires checked arithmetic and safe backend integers, and injects one evaluation time. Raw-response and normalized-state fixtures are required. This closes the permissive malformed-date return at `src-tauri/src/license.rs:221-225` and matches backend ISO/null responses at `../politedb-backend/src/services/polar-license-key.ts:139,169`. |
| S4 — unconditional distribution bypass | **Resolved in plan** | `.agent/plans/pro-gating.md:639-646` evaluates the unlimited distribution grant before the Direct-only union and includes no-grant, expired-paid and stripped-trial App Store fixtures. This preserves the existing early bypass at `src-tauri/src/license.rs:183-185`. |
| N1 — entitlement-accurate chip copy | **Resolved in plan** | `.agent/plans/pro-gating.md:648-651` uses “Agent mode is included with Pro” and preserves provider/model/engine fallback, avoiding a running/availability claim. Capability checks remain visible at `origin/main:src-tauri/src/commands/ai_agent.rs:75-97`. |

#### Nonblocking implementation cautions

- **Atomic capture:** `.agent/plans/pro-gating.md:609-612` must mean one file-lock critical section covering the load's read, capture and minimal write, using unlocked private helpers. Idempotence alone does not prevent an old decoded snapshot overwriting a mutation if the lock is released between read and write. The specified concurrent-load/mutation test should pause at that boundary and assert credentials and server trial survive. This clarifies the existing atomic-capture requirement, not a new blocker.
- **Expiry representation:** `.agent/plans/pro-gating.md:626-629` must preserve malformed versus absent expiry across save/reload; `expires_at_ms: None` alone cannot distinguish them. Use the retained raw-field presence or an explicit validity discriminator, and test reload of malformed expiry plus a valid trial. The required outcome is already explicit; no product decision remains open.

No new concrete blocking issue found. Implementation must still supply the planned regression evidence; Postgres concurrency/migration, deployment smoke checks and the separate security review remain required before release.

**Verdict: READY.**
