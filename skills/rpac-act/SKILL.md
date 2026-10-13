---
name: rpac-act
description: RPAC act phase — execute one approved plan task from <state-dir>/plan.md — verify assumptions, implement minimally, run checks, report honestly. Use only when an RPAC act directive (from /rpac act) is active.
---

# RPAC · Act

One task per execution cycle (unless sequential mode was approved). `/rpac act` has already
started the task named in the directive and marked it `in_progress`; do **not** call `task_start`
for that current task. Implement it, verify it, report it, stop. In sequential mode, call
`task_start` only after `task_done` succeeds, to advance to the next ready task. The plan
(`<state-dir>/plan.md`) is the contract; the state
(`<state-dir>/workflow.json`) tracks progress. Task outcomes are explicit:
`pending → in_progress → done | failed | blocked`; a run that ends mid-task leaves it
`interrupted`. A task is `done` only when every recorded **acceptance** check passed; audit
observations preserve subject failures without turning a successfully completed review into a failed task.

## Before touching code

1. Read the plan (summary, conventions, the task and its dependencies, acceptance criteria).
2. Re-verify the task's assumptions against the current code — the plan is a snapshot and the
   tree may have moved. If a step the plan calls for is contradicted by the codebase, **stop
   and report the blocker** (`rpac` action `task_block` with the reason); do not improvise around it.
3. If resuming an interrupted task, inspect what is already done (git diff, partial edits) and
   continue from there — never redo completed work blindly.

## Implement

- **Scope is the task's steps, nothing else**: no later-task work, no drive-by refactors.
- Preserve existing uncommitted changes in the working tree; never overwrite unrelated work.
- What the code settles, settle by reading it; what it doesn't, ask the user (one question,
  with your recommendation).
- Record every settled deviation from the plan the moment it is settled: `rpac` action
  `deviation` (it is appended to `<state-dir>/log.md`).

## Verify (mandatory)

Run the task's *Done when* check, then the validation the project's governing docs name
(failing that, the toolchain's lint / tests / build). If nothing is runnable, say so rather
than inventing a command. Fix what this task broke; a failure that predates the task or lands
outside its scope is **reported, never fixed silently**.

A task is done when its **acceptance** checks pass. **A failing or unavailable acceptance check
does not complete the task** — it stays failed (resumable) until the problem is fixed and the
checks pass, or the user explicitly accepts a documented exception (`/rpac accept <id> <reason>`).
Never mark a task complete because code was generated.

For audits and reviews, distinguish completing the review from what the reviewed subject did:
a command that exposes an existing defect is an `observation` with its actual result (for example,
`clang-format`: `fail`), plus a separate acceptance check that the result was accurately captured
in the deliverable. Observation failures remain visible but do not fail the review task.

## Close

Call `rpac` action `task_done` with:

- `task`: the task id
- `verification`: every check run, each
  `{name, kind?: acceptance|observation, result: pass|fail|unavailable, detail?}` — including
  failures and unavailable checks; `kind` defaults to `acceptance`, and at least one acceptance
  check is required
- `deviations`: any deviations made (also recorded via the `deviation` action)
- `deliverables`: every file this task intentionally produced (project-relative or absolute),
  including reports under `<state-dir>`; RPAC hashes them and detects later changes or deletion

Outcomes:

- all acceptance checks pass → the task becomes `done`; observation failures stay recorded.
- any acceptance check fails/unavailable → the task becomes `failed` (not done). Then either fix and
  re-run (`/rpac act <id>` — failed tasks are restartable) or use `task_fail` with the reason
  when the task cannot be completed at all. If sequential mode is on, a failed/blocked task
  stops the run.

Then stop and wait for the next `/rpac act` — unless sequential mode is on, in which case
continue with the next ready task **only after the current task is verified done**. When no
tasks remain, tell the user to run `/rpac consolidate`.

## Boundaries

- Never commit, push, merge, or open PRs.
- Never expand scope silently.
- Do not edit the plan's task list; progress lives in workflow state.
