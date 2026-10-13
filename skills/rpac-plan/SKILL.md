---
name: rpac-plan
description: RPAC plan phase — turn approved requirements into an executable implementation plan (<state-dir>/plan.md) with a small task list. Use only when the RPAC plan directive (from /rpac plan) is active.
---

# RPAC · Plan

Planning only — **no code changes, no execution**. You produce one document, `<state-dir>/plan.md`
(the directive names the exact absolute path), that is the contract for the execution phase.
The approved requirements
(`<state-dir>/requirements.md`) define scope: do not redefine it, but **flag** any gap, ambiguity,
or inconsistency you find there — surface it, never paper over it. PLAN is **mechanically
read-only**: the extension blocks application write/edit calls and mutating shell commands;
only the plan artifact and read-only inspection work.

## Steps

1. **Read the requirements** end to end. Note anything they gate on (missing data, upstream
   work, environment assumptions).
2. **Verify against the actual codebase.** Open the files the requirements cite and confirm the
   references still hold. If the requirements carry verified codebase facts, use them to avoid
   re-discovery, aware the code may have moved (`git diff <pinned-commit>..HEAD -- <cited paths>`
   makes the check cheap). Verify any gating claims independently — stale gating is a common
   failure mode.
3. **Work out the approach.** Design the *how*: what to reuse vs introduce, where each change
   goes, and an order that avoids broken intermediate states. Track dependencies between tasks.
   For enabled/disabled, started/stopped, authenticated/unauthenticated, or connected/disconnected
   behavior, cover transitions, reload/reconfiguration, cleanup, and re-entry—not only startup
   defaults. Where more than one reasonable approach exists and the code cannot settle it, ask the
   user — one question at a time, with your recommendation.
4. **Write the plan** — only once no open question remains.

## Size

A handful of meaningful tasks (usually 3–7). Each task leaves the project building and its
existing tests passing. Do not write dozens of microscopic steps, and do not write giant
plans for trivial changes — a one-file fix is a one-task plan.

## Output: `<state-dir>/plan.md`

Self-contained: a fresh session reading **only this file** can execute it.

```markdown
# Plan — <task>

## Summary
1–3 sentences: what this implements and the overall shape of the change.

## Conventions
Cross-cutting rules that bind every task (naming, strings, test approach, lint/build commands).

## Tasks
- [ ] **1. <imperative title>**
  - Where: concrete file paths / identifiers
  - Approach: prose; cite prior art with path (line numbers are hints — they drift)
  - Depends on: (task numbers, or "none")
  - Done when: the concrete check (command to run, behavior to observe)
- [ ] **2. …**

## Acceptance criteria
Numbered checklist copied from the requirements AC, each mapped to the task(s) that satisfy it
(e.g. "AC-3 → task 2").

## Risks & compatibility
Known risks, migration/compatibility concerns, and anything needing manual verification.
```

Rules:

- Step 1 must never be open-ended discovery — discovery happened above.
- Every task is self-contained (readable without scrolling back).
- Snippets: only when prose is genuinely more ambiguous than code; keep under ~10 lines.

## Boundary actions

- No source changes. The only file you write is `plan.md` (enforced by the extension).
- Never guess: code-settleable → read the code; not settleable → ask.
- When the plan is on disk and no open question remains, call the `rpac` tool with
  `action: "plan_complete"` and `tasks: [{title, dependsOn?}]` matching the `## Tasks` list.
  Dependencies are task numbers (1-based, in list order) and must form a valid acyclic graph —
  cycles and unknown references are rejected. The user approves via dialog or
  `/rpac approve plan`. Do not approve it yourself.
