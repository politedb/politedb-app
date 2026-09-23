# Implementation Review

> Review contract and task report for Grok or another coding agent.
> Read `AGENTS.md`, the user request, and `.agent/PLAN.md` first.
> NOT REVIEWED by default. A template or passing tests alone do not prove correctness.

## Review Procedure

1. Identify the task branch, base commit, and exact diff. Include task-owned new files.
   Do not assume all working-tree changes belong to this task.
2. Compare the implementation with the approved plan and acceptance criteria.
3. Trace changed behavior through callers, shared state, persistence, and engine
   boundaries. Read relevant unchanged code; do not review the diff in isolation.
4. Check the categories below. Report reproducible or evidence-backed issues,
   not speculative style preferences. State assumptions when runtime evidence is missing.
5. Run relevant checks from the plan. Record commands, outcomes, and skipped checks.
   Distinguish pre-existing failures from regressions using evidence.
6. Fix in-scope findings, add focused regression coverage, rerun affected checks,
   and review the new diff for adjacent regressions. Record deferred issues explicitly.
7. Report findings first, ordered by severity. Never promise that no bugs exist.
   Use "No actionable findings in reviewed scope" when appropriate.

## Checklist

- Correctness: acceptance criteria, edge cases, null/empty/error states, ordering,
  cancellation, retries, stale async responses, and cleanup.
- State: one authoritative representation; no duplicate mutations, lost updates,
  stale caches, or disagreement between rendered and persisted data.
- Editing: create, edit, delete, save, reload, filter, sort, selection, and undo
  where supported. Preserve confirmations, transactions, and rollback behavior.
- Database: dialect compatibility, identifier quoting, parameterization, permissions,
  composite keys, result decoding, and connections/tunnels released appropriately.
- Performance: bounded rendering and memory; no N+1 metadata queries, unbounded
  concurrency, repeated full scans, expensive render work, or listener/timer leaks.
  For large-data changes, verify representative scale rather than tiny fixtures only.
- UI: preserve requested layout; shared DOM/canvas/editor colors, readable text,
  focus/edit/selection states, keyboard navigation, scroll reachability, both themes.
- Architecture: cohesive modules, typed contracts, existing adapters and helpers,
  no scattered engine conditionals, unnecessary dependencies, or speculative abstractions.
- Security: no secrets or customer data in logs, telemetry, fixtures, or commits;
  input validation and existing authorization/safety boundaries remain intact.
- Tests: reported regression and adjacent workflows covered; assertions verify behavior,
  not merely an implementation detail. Mocks must reflect actual backend result shapes.
- Portability: macOS/Windows/Linux and native-versus-browser assumptions documented.
  Do not claim platform verification from source inspection alone.
- Scope: no unrelated changes, broad formatting churn, generated output, or changed
  tests merely to hide failures. Do not alter the approved plan to excuse missing behavior.

## Severity

- P0: critical, immediate data loss/security/outage risk; block delivery.
- P1: serious broken workflow, security issue, or substantial regression; block delivery.
- P2: material correctness/performance/compatibility issue; fix or obtain explicit deferral.
- P3: minor actionable improvement; document without disguising preference as a bug.

Each finding needs: severity, file and line, triggering conditions, impact,
evidence, and a concrete fix direction. Do not include secrets or customer SQL.

## Task Report

Status: NOT REVIEWED

Allowed statuses: NOT REVIEWED, CHANGES REQUIRED, VERIFIED, VERIFIED WITH LIMITATIONS.
Use VERIFIED WITH LIMITATIONS when relevant checks cannot run; state the residual risk.
Unresolved P0/P1 findings or unapproved P2 deferrals require CHANGES REQUIRED.

### Scope

- Task / approved plan: TBD
- Branch / base commit / reviewed revision: TBD
- Files and workflows inspected: TBD

### Findings

TBD. Replace with numbered findings or "No actionable findings in reviewed scope."

### Verification

| Check                     | Command or procedure | Result / evidence |
| ------------------------- | -------------------- | ----------------- |
| Build/type check          | TBD                  | NOT RUN           |
| Regression tests          | TBD                  | NOT RUN           |
| Lint                      | TBD                  | NOT RUN           |
| UI/native/platform checks | TBD                  | NOT RUN           |

### Fixes And Re-review

- Finding, fix, regression coverage, and recheck result: TBD
- Explicitly deferred findings and approval: TBD

### Remaining Risks

- Unverified assumptions, unavailable environments, and follow-up checks: TBD

### Verdict

TBD. Summarize readiness based on evidence, not confidence alone.
