# Dual-agent workflow (Codex + Grok Bot)

Single entry point for the human: talk to **Codex** _or_ **Grok Bot**. Agents hand off through this repo’s `.agent/` files — do not require the human to re-paste the task between tools.

## Roles

| Agent                 | Owns                                                                                                      | Must not                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Codex**             | Fill / update `.agent/PLAN.md`, mark approval with the user, fill `.agent/REVIEW.md` after implementation | Implement application code unless the user explicitly overrides this split        |
| **Grok Bot (Beaver)** | Implement and fix code from an approved plan / review findings                                            | Redesign the plan; edit `.agent/PLAN.md` requirements; push/merge/PR unless asked |

Both agents always read `AGENTS.md` first, then this file.

## Status contracts

### `.agent/PLAN.md`

Allowed status values (exactly one in the Status section):

- `DRAFT` — planning only; **no code changes** for the planned task
- `APPROVED` — user approved; Grok Bot may implement
- `IMPLEMENTED` — Grok Bot finished the approved scope (verification recorded in the plan)

Never treat `TBD` placeholders as permission to change code.

### `.agent/REVIEW.md`

Allowed task-report statuses:

- `NOT REVIEWED`
- `CHANGES REQUIRED` — Grok Bot must fix P0/P1 (and approved P2s)
- `VERIFIED` / `VERIFIED WITH LIMITATIONS`

## Happy path

1. **Human** describes the task in Codex _or_ asks Grok Bot to start planning (Grok Bot then leaves plan drafting to Codex / asks the human to approve in Codex).
2. **Codex** inspects the repo, fills `.agent/PLAN.md` (goal, requirements, files, steps, verification). Status stays `DRAFT` until the human explicitly approves.
3. **Human** approves → **Codex** sets Status to `APPROVED`.
4. **Grok Bot** notices `APPROVED` on the next poll (or optional Implement PLAN webhook) and implements: branch `type/short-kebab` per plan, minimal diffs, run verification from the plan, update progress/evidence only in `PLAN.md`, set Status to `IMPLEMENTED` when done. Then notify the human.
5. **Codex** reviews the task-owned diff, fills `.agent/REVIEW.md`.
6. If Status is `CHANGES REQUIRED`, Grok Bot picks it up on the next poll (or optional Fix REVIEW webhook), fixes P0/P1, re-verifies, then Codex re-reviews.
7. Commit only when the human asks. Never push/merge/rebase/amend/PR unless requested.

## Primary handoff (no copy/paste)

Grok Bot polls `.agent/PLAN.md` and `.agent/REVIEW.md` about every **5 minutes** on weekdays 09:00–18:00 Asia/Saigon:

- If plan Status is `APPROVED` and work is not already in flight → implement
- If review Status is `CHANGES REQUIRED` → fix
- Otherwise → stay silent (no chatter)

**Codex does not need webhook URLs.** After the human approves, set Status to `APPROVED` and wait for Grok Bot (usually under 5 minutes during work hours). Same for `CHANGES REQUIRED` after review.

Idempotency: do not restart a finished `IMPLEMENTED` plan unless Status returns to `APPROVED` after a new approval, or review demands fixes.

### Optional: instant webhook wake

Webhooks still exist for faster wake (Implement PLAN / Fix REVIEW routines). They are optional. Prefer the poll above unless you already keep the URL/key in local env.

## Entry points for the human

### Only Codex

1. Describe the task → get `PLAN.md` to `APPROVED`
2. Wait for Grok Bot (poll ~5 min in work hours); optional webhook for instant wake
3. When Grok Bot reports done → review → `REVIEW.md`
4. If `CHANGES REQUIRED` → wait for Grok Bot fix (same poll / optional webhook)

### Only Grok Bot

1. If `.agent/PLAN.md` is already `APPROVED` → say “implement the plan” (or wait for webhook/cron)
2. If plan is `DRAFT` / `TBD` → Grok Bot will not invent requirements; ask you to finish approval in Codex (or paste an approved plan into `PLAN.md` yourself)
3. After `IMPLEMENTED`, ask Codex to review (Grok Bot can self-check but Codex owns `REVIEW.md`)

## Signal cheat sheet (Codex)

After setting `PLAN.md` → `APPROVED`:

```bash
# Replace URL and key from Grok Bot routine panel (Implement PLAN)
curl -sS -X POST "$GROK_IMPLEMENT_PLAN_WEBHOOK_URL" \
  -H "Authorization: Bearer $GROK_IMPLEMENT_PLAN_WEBHOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"implement","repo":"politedb-app"}'
```

After setting `REVIEW.md` → `CHANGES REQUIRED`:

```bash
curl -sS -X POST "$GROK_FIX_REVIEW_WEBHOOK_URL" \
  -H "Authorization: Bearer $GROK_FIX_REVIEW_WEBHOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"fix","repo":"politedb-app"}'
```

Store URL/key in your local shell env or Codex config — never commit secrets into this repo.

## Invariants

- One task plan at a time in `PLAN.md` unless the human says otherwise
- Preserve unrelated working-tree changes
- No destructive DB writes without authorization
- Prefer existing architecture in `AGENTS.md`
