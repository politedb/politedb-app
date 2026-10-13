# Dual-agent workflow (Claude + Codex)

The human talks to **Claude** or **Codex**. Agents hand off through this repo’s `.agent/` files — do not require the human to re-paste the task between tools.

Core rule: **the agent that wrote the code does not review it.** Claude implements; Codex reviews. Plans are drafted by one agent and critiqued by the other before approval.

## Roles

| Agent      | Owns                                                                                                                                                           | Must not                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Claude** | Draft `.agent/PLAN.md` (requirements, decisions, phases); implement an `APPROVED` plan; fix `CHANGES REQUIRED` findings; record progress/evidence in `PLAN.md` | Write `.agent/REVIEW.md`; mark its own work `VERIFIED`; change approved requirements without the human |
| **Codex**  | Critique a `DRAFT` plan (add a `## Plan Review` section to `PLAN.md`); review implementation diffs and fill `.agent/REVIEW.md`                                 | Implement application code unless the human explicitly overrides this split                            |

Both agents always read `AGENTS.md` first, then this file.

Either agent may draft the plan when the human asks; the other one critiques it. The implementer is still Claude unless the human says otherwise.

## Status contracts

### `.agent/PLAN.md`

Allowed status values (exactly one in the Status section):

- `DRAFT` — planning only; **no code changes** for the planned task
- `APPROVED` — the human approved and no `TBD` decision remains; Claude may implement
- `IMPLEMENTED` — Claude finished the approved scope (or the phase named in the plan) with verification recorded in the plan

Never treat `TBD` placeholders as permission to change code.

### `.agent/REVIEW.md`

Allowed task-report statuses:

- `NOT REVIEWED`
- `CHANGES REQUIRED` — Claude must fix P0/P1 (and approved P2s)
- `VERIFIED` / `VERIFIED WITH LIMITATIONS`

## Happy path

1. **Human** asks either agent to plan a task.
2. **Planner** inspects the repo and fills `.agent/PLAN.md` (goal, decisions, files, phases, verification). Open product decisions are listed as `TBD` and asked to the human. Status stays `DRAFT`.
3. **Other agent** critiques the plan (missing risks, wrong assumptions, unsafe scope) in a `## Plan Review` section.
4. **Human** resolves decisions and approves → planner sets Status to `APPROVED`.
5. **Claude** implements on the branch named in the plan (default `type/short-kebab`), one phase per branch/PR for multi-phase plans. Minimal diffs, verification from the plan, evidence recorded in `PLAN.md`, Status `IMPLEMENTED` for the finished phase.
6. **Codex** reviews the task-owned diff and fills `.agent/REVIEW.md`.
7. If `CHANGES REQUIRED`, **Claude** fixes P0/P1, re-verifies, and Codex re-reviews.
8. Security-sensitive scope (keychain, SSH, profile import/export, license/IAP, data migration, destructive DB actions) gets a second pass with Claude's `/security-review` after Codex's review.
9. Commit only when the human asks. Never push/merge/rebase/amend/PR unless requested.

## Handoff prompts for the human

Short prompts are enough because context lives in `.agent/`:

| Step          | Agent  | Prompt                     |
| ------------- | ------ | -------------------------- |
| Plan          | Claude | `soạn plan cho <task>`     |
| Critique plan | Codex  | `phản biện .agent/PLAN.md` |
| Implement     | Claude | `implement phase <n>`      |
| Review        | Codex  | `review phase <n>`         |
| Fix review    | Claude | `fix .agent/REVIEW.md`     |

## Parallel work

- Never run both agents in the same working tree at the same time.
- Use `git worktree` so Claude can implement phase N while Codex reviews phase N-1 in a separate checkout.
- One task plan at a time in `PLAN.md` unless the human says otherwise.
- When the human approves a second concurrent plan, it lives in `.agent/plans/<task-id>.md` with the same status contract; its reviews are appended to `.agent/REVIEW.md` under a heading naming that plan.

## Invariants

- Preserve unrelated working-tree changes
- No destructive DB writes without authorization
- Prefer existing architecture in `AGENTS.md`
- Never commit secrets, certificates, provisioning profiles or keys into this repo
