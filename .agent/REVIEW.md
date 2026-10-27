# Status

VERIFIED WITH LIMITATIONS

Latest review: round 2, `63e43f8..ac784ad`; see appended follow-up review below.

Reviewed `main..HEAD` on `feat/home-polish`: `26c79ab`, `b93f2d4`, `8f71baa`, against the three human-approved Home UI/UX batches. No application source modified.

# Findings

No actionable correctness or security regression found in the reviewed diff. Rendered UI and native-runtime behavior remain unverified as detailed below.

- **Destructive actions:** connection, group and keychain deletion retain confirmation, name the item and supply a title and Delete action. Group wording correctly distinguishes deleting the group from deleting its connections.
- **Unsaved work:** `src/screens/main/deleteConnection.ts:23` refuses deletion when an existing tab is dirty. After confirmation, lines 49–53 use `requestCloseConnectionTab` and re-read the authoritative screen store before deleting. A tab retained by the close/unsaved-changes flow prevents profile deletion. The existing close path uses the same `connectionTabHasChanges` predicate; no force-close bypass was introduced.
- **Opening connections:** `src/lib/tabs/openProfileTab.ts:25` selects the last-created matching tab; card Open, double-click and Enter use this switch-or-open path. Explicit Open in New Tab retains new-tab creation. Header + menu and History opening still call the original new-tab helper, preserving their existing behavior.
- **Sorting and state:** `src/screens/main/MainScreen.tsx:183` derives each profile’s latest timestamp from History; `sortConnections` retains pinned order, puts never-opened profiles last by name, and receives the same timestamps for search. Existing sort identifiers/defaults remain intact. Home sort state lives in the session-only `mainView` store, so this change introduces no persisted-sort migration requirement.
- **Adjacent workflows/accessibility:** inspected pinning, group assignment/deletion, card edit/duplicate/export, keychain deletion, keyboard event guards, menu focus/state labels, group pressed states and empty/search actions. Dark styling also relies on existing global palette remaps in `src/styles.css`; lack of local dark classes alone is not a defect.

# Verification

- `npm run build` — **PASS** (TypeScript and production Vite build). Warnings: browser externalization of `node:zlib`, ineffective dynamic imports and large chunks; no build errors.
- `npm run test:run` — **PASS**, **262 files / 1,960 tests**. Includes changed card/section/group/keychain/deletion/sorting/tab-helper tests and existing header, History, menu-keyboard, Home-state and profile-sharing coverage.
- **Test limits:** card layout tests assert DOM/classes, not browser geometry. Deletion tests mock the dirty predicate and close operation; they cover cancellation, dirty-tab refusal, closing-before-delete and retained-tab refusal, but do not exercise a real native confirmation or the full unsaved-changes dialog integration. No new failure was observed; these are verification gaps.
- **UI/runtime limits:** attempted `npm run dev -- --host 127.0.0.1`; sandbox rejected listening on port 1420 with `EPERM`. Isolated browser verification also failed: bundled Chromium was absent, and installed Chrome exited with `SIGABRT` under the sandbox. Therefore whole-chip hiding/name priority at narrow widths, hover/focus geometry, dark-mode appearance, native dialog presentation and interactive unsaved-changes handling require a desktop smoke check before release. No successful visual inspection is claimed.
- Working tree: only `.agent/REVIEW.md` intentionally changed. Unrelated untracked `.claude/launch.json` preserved. No commits, source fixes or destructive operations performed.


## Re-review (round 2): follow-up commits

**Status: VERIFIED WITH LIMITATIONS**

Reviewed `63e43f8..ac784ad` (`a02d7c8`, `ac784ad`) on `feat/home-polish`, as requested by the human. No source code changed.

### Findings and behavior checks

No actionable regression introduced by these two commits found.

- **Independent searches:** `src/stores/mainView.ts:55` merges only the requested navigation entry; `src/screens/main/MainScreen.tsx:101` selects the active page's query with an empty fallback. Connections filtering (`MainScreen.tsx:198`), Credentials (`MainScreen.tsx:581`, `KeychainSection.tsx:327`) and History (`MainScreen.tsx:529`, `ConnectionLogsSection.tsx:105`) receive that query. Repository-wide reader search found no remaining consumer of the removed store `searchQuery` field; other same-named props/local state are unrelated.
- **Clear and Show:** `src/screens/main/MainScreen.tsx:558` clears only the active Connections query. At `MainScreen.tsx:532`, Show in connections explicitly clears the Connections query before navigation, preserving History and Credentials queries and History filters.
- **Existing limitation, not introduced here:** `src/screens/main/MainScreen.tsx:532` retains `selectedGroupId`; the group predicate at `MainScreen.tsx:208` can still hide the target. Reproduction: choose a group excluding connection B, go to History, then Show in connections for B. Clearing search alone cannot reveal B. If Show must always reveal its target, clear the group or select an applicable group in a separate fix.
- **History filters/restoration:** `src/screens/main/ConnectionLogsSection.tsx:67` retains independent status/profile state, combines text and profile filters before status counts/filtering, and falls back to All when a stored profile filter disappears. `src/layout/index.tsx:87` unmounts Home when visiting a connection; `src/stores/mainView.ts:52` remains a module-level session store, so searches and existing view/filter/scroll state survive remount. No persistent-state migration is needed.
- **Credentials copy/platform:** `src/screens/main/KeychainSection.tsx:448` renders the storage note once outside group/empty rendering. `KeychainSection.tsx:52` recognizes case-normalized Mac/Win platform strings and otherwise uses the generic system-keychain label; no backend storage changes. `KeychainSection.tsx:74` uses trimmed-search state to distinguish No matching keys / Try a different keyword from No keys yet / explanatory copy. No platform-routing defect found by inspection.

### Verification and limits

- `npm run build` — **PASS**. Existing-style warnings: browser externalization of `node:zlib`, ineffective dynamic imports, large chunks.
- `npm run test:run -- src/stores/mainView.test.ts src/screens/main src/utils/connectionLog.test.ts src/lib/tabs/openProfileTab.test.ts` — **PASS**, **11 files / 70 tests**.
- `npm run test:run` — **PASS**, **262 files / 1,962 tests**, including connection sorting/search, scroll memory, and all existing frontend coverage.
- New tests verify two stored page queries remain separate and the storage note appears once across multiple groups. Coverage gaps: no MainScreen interaction/remount test for all three searches, Clear/Show isolation, no platform-string matrix, and no new Credentials empty-state assertions. Existing section tests cover Connections empty actions and History status/profile filtering; passing unit tests do not prove native webview/platform behavior.
- No browser or desktop visual smoke check performed in this round. Native macOS/Windows platform values, rendered note placement, and actual connection-tab round trips remain runtime verification limits; earlier review's UI limitations still apply.
- Only `.agent/REVIEW.md` intentionally modified; untracked `.claude/launch.json` preserved. No source fixes or commits.
