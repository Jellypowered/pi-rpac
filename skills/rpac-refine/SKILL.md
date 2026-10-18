---
name: rpac-refine
description: RPAC refine phase — turn a raw task into a self-contained requirements document (<state-dir>/requirements.md). Use only when the RPAC refine directive (from /rpac start or /rpac refine) is active.
---

# RPAC · Refine

Produce a self-contained requirements document: the **what**, verified against the codebase.
Never the *how*. Analysis only — **do not modify any source file**. The only file you write is
`<state-dir>/requirements.md` — the directive names the exact absolute path (`<state-dir>` is
`.pi/rpac/<workflow-id>/`). REFINE is **mechanically read-only**: the extension blocks
application write/edit tool calls and mutating shell commands; only the requirements artifact
and read-only inspection (grep/find/git status/…) work.

## Verify before concluding

Every requirement is checked against the actual code, config, and docs:

- Anything determinable by reading the code is resolved by reading the code — **never ask the
  user** what the code already answers.
- Treat "this probably works like X" as a question, not a fact. Keep distinct: "I confirmed X",
  "the task claims X", "I assume X" — the latter two never become the first without evidence.
- Before declaring something missing or unhandled, search the codebase for the concept under
  other names. "Not found under the name used" is not "not present".
- Verify both sides of an integration: if a requirement relies on another component behaving a
  certain way, open that component and confirm.
- Requirements about states such as enabled/disabled, started/stopped, authenticated/unauthenticated,
  or connected/disconnected cover both initial state and transitions. Inspect reload/reconfiguration,
  teardown, stale-state cleanup, and re-entry paths rather than proving only the startup default.
- If the task says "reuse X" / "X already exists", find what is behind X and anchor the
  requirement on the smallest extension. Reuse-vs-build-new is a **blocking** question for the
  user when the code cannot settle it — never a silent default.

## Questions (only genuine ambiguity)

- One question at a time, each with your recommended answer.
- Separate **blocking** (implementation cannot proceed) from **non-blocking** (a reasonable
  default exists). Blocking items are resolved before writing the file; non-blocking ones go
  under Open questions with your tentative answer.

## Output: `<state-dir>/requirements.md`

Must stand alone for a **fresh session** with no memory of this conversation. No "as
discussed" or "see above".

```markdown
# Requirements — <task>

## Context
1–3 plain-language sentences: what this work is, what's in scope, what's out. Keep the detailed facts and criteria below.

## Verified codebase facts
Facts confirmed while validating (where relevant code lives, data shapes, existing analogues),
pinned to the commit (`git rev-parse --short HEAD`, noting a dirty tree). What is true *today* —
never how to change it. May be empty.

## Requirements
Deduplicated functional requirements, each self-contained, citing file paths/identifiers inline.

## Constraints & conventions
Project rules that bind the implementation (from AGENTS.md / docs / code conventions).

## Overrides
Every deviation from the original task wording: what it said/omitted, the resulting
requirement, and why (code evidence or user decision). May be empty.

## Open questions
Non-blocking ambiguities, each with a tentative answer. Blocking questions never appear here.

## Acceptance criteria
Flat, verifiable checklist (AC-1, AC-2, …) the implementation must satisfy.
```

## Boundaries

- No implementation plan, no "how".
- No source changes; only `requirements.md` is written (both are enforced by the extension,
  not just by this skill).
- When the requirements are ready, call the `rpac` tool with action `refine_complete` and stop.
  The user approves (dialog, or `/rpac plan` / `/rpac approve requirements`). Do not ask for
  approval yourself.
