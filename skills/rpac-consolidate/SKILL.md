---
name: rpac-consolidate
description: RPAC consolidate phase — verify the finished implementation against the requirements, review the git diff, run final checks, and write an honest completion report (<state-dir>/report.md). Use only when the RPAC consolidate directive (from /rpac consolidate) is active.
---

# RPAC · Consolidate

Verify and preserve the outcome. Your job is to find **genuine problems**, not to declare
success.

## Steps

1. **Compare against the requirements.** Walk every acceptance criterion in
   `<state-dir>/requirements.md` and check it against the actual result — by running it, reading
   the code, or inspecting behavior. Mark each: met / not met / unverifiable (and why).
2. **Review the actual diff.** `git diff` (plus `git status` for untracked) against the
   baseline recorded in `<state-dir>/workflow.json`. Anything in the diff that no plan task called
   for is flagged as scope drift.
3. **Run final verification.** The project's governing checks (build/lint/test) — the same
   ones the act phase used, plus anything the requirements' AC names as manual.
4. **Cross-check the decisions log.** Read `<state-dir>/log.md`: every deviation and decision
   should be visible in the diff or the code. Anything missing is a finding.
5. **Audit produced reports.** When a task's deliverable is itself a review, audit, or findings
   report, verify its internal claims before declaring success: recalculate severity/status counts;
   ensure every summary item maps to one detailed item and every detailed item has one classification;
   verify introduced/pre-existing/environmental/non-issue labels against the baseline; and ensure the
   completion report agrees with the primary deliverable. Contradictions are genuine problems.
6. **Write the report** to `<state-dir>/report.md` (structure below).

## Report: `<state-dir>/report.md`

```markdown
# Completion report — <task>

## Verdict
Complete / Complete with issues / Incomplete — one line, then a short plain-language summary derived from the evidence. Do not omit failures or replace the detailed sections below.

## Acceptance criteria
- AC-1: met — <how verified>
- AC-2: not met — <what's missing>
- …

## Changes
Files touched, grouped by plan task. Notable implementation decisions and why.

## Deviations from the plan
From <state-dir>/log.md, each with its justification.

## Verification results
Every check run, with results. Failures and unavailable checks included, each with why it
stands.

## Remaining limitations & follow-ups
Known gaps, manual steps the user must perform, suggested next tasks.
```

## Boundaries

- Never commit, push, or publish.
- If verification reveals a genuine problem: say so in the report, then **call the `rpac` tool
  with action `back_to_act`** (pass the problem as `text`). It creates a concrete *repair task*
  that `/rpac act` can execute and returns the workflow to the act phase. If the plan itself was
  wrong, use `back_to_plan` instead (completed tasks keep their evidence; plan approval is
  reset). After fixing the problem (with verification), re-consolidate.
- When the report is written and the outcome is sound, call `rpac` action `consolidate_complete`.
- For continuing in a fresh session, the user can run `/rpac handoff`.
