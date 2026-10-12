# pi-rpac — RPAC workflow for Pi

**RPAC = Refine → Plan → Act → Consolidate.** A native [Pi](https://pi.dev) extension that turns a
task into **approved requirements**, an **approved plan**, **incrementally executed and verified
tasks**, and an **honest completion report** — with durable, human-readable, per-project state and
explicit, user-gated phase transitions.

It is a *workflow state machine*, not a second agent runtime. It drives the model Pi is already
configured with (including local OpenAI-compatible models) and coexists with your normal Pi setup.

```
 ┌────────┐  approve  ┌─────┐  approve  ┌──────────────────────────┐  report  ┌──────┐
 │ REFINE │ ────────► │ PLAN│ ────────► │ ACT (one task per run)   │ ───────► │ DONE │
 │ what?  │  (user)   │ how? │  (user)  │ verify each task         │ (model)  │      │
 └────────┘           └─────┘           │ pause/abort/back-to-plan │          └──────┘
                                        └──────────────────────────┘
```

---

## Features

- **Native Pi integration** — one `/rpac` command namespace, one model-facing `rpac` tool, a
  compact footer status + task widget. No daemon, no web service, no new provider config.
- **Explicit phase transitions with user approval gates.** The model can *finish* an artifact and
  *request* approval, but only the user approves (via a dialog, or `/rpac approve` in headless
  mode). Gating is enforced in **both** the command handlers and the tool (defense in depth).
- **Durable, human-readable, per-workflow state** under `.pi/rpac/<workflow-id>/` (versioned
  JSON + Markdown). Survives context compaction, Pi restarts, session switching, interruptions,
  and extension reloads. Many saved workflows coexist; one is active at a time
  (`/rpac list`, `/rpac resume <id>`). Version-1 state migrates automatically; corrupt files are
  quarantined and reported, never crash-looped.
- **Real concurrency control.** Every state mutation is serialized through an atomic
  write-lock (`openSync(path, "wx")`), and each ACT task runs under an **execution lease** that
  refuses a second executor (same session or another process) until the run ends. Stale-lock
  recovery uses a short exclusive takeover guard and revalidates ownership before replacement.
- **Enforced read-only REFINE/PLAN.** During refine/plan the extension blocks model tool calls
  that would touch the application (artifact-only writes, fail-closed read-only bash allowlist)
  — the gate is mechanical, not a prompt suggestion.
- **Honest task outcomes.** A task is `done` only when every recorded check passed; failing or
  unavailable checks make it `failed`, an ended run leaves it `interrupted`, and unmet
  prerequisites make it `blocked`. `failed` is a user decision: fix and re-run, or record a
  documented exception (`/rpac accept`). Consolidation must actively search for and report
  genuine problems rather than assuming success.
- **Safety.** No auto commit/push/merge. Existing uncommitted work is preserved. Stale
  requirements/plan and git divergence are *detected and reported*, never auto-resolved. One
  repo's workflow never leaks into another (state is bound to the git root).
- **Context-efficient.** Active workflows inject only a tiny phase/task pointer each turn. Phase
  instructions are short follow-up messages; behavioral detail lives in lazily-loaded skills;
  full artifacts remain on disk rather than being injected into context; status lives in the
  footer.
- **Fresh-session handoff.** `/rpac handoff` writes a self-contained `handoff.md` and (in TUI)
  starts a fresh session seeded with it — an explicit, user-triggered continuation.

---

## Requirements

- **Pi** `@earendil-works/pi-coding-agent` **1.1.0** or newer (tested against 1.1.0).
- **Node.js** 22.6+ (type-stripping is used to run the TypeScript extension and tests directly;
  no build step needed).
- **git** available on `PATH` (used for the baseline and divergence checks). RPAC still works in a
  non-git directory, but baseline/divergence features are disabled.
- Any model configured in Pi, including local models over OpenAI-compatible endpoints. No hosted
  model or new provider is required.

Host-provided packages `@earendil-works/pi-coding-agent` and `typebox` are declared as
`peerDependencies` and are supplied by Pi at runtime — you don't install them for the extension
to run.

---

## Installation

RPAC is a standard **Pi package** (a directory with a `pi` manifest exposing `extensions/` and
`skills/`). Pi's native installer handles all of these.

### From a local directory (development)

From a checkout of this repo:

```bash
cd /path/to/pi-rpac
pi install ./          # local packages are loaded by path, not copied
pi list                # confirms "pi-rpac" is configured
```

Because a local path is not copied, edits to `extensions/` or `lib/` are picked up on the next
`/reload` or Pi restart.

### User-level install from git

Once the package is published, install its git source without `--local` to add it to your user
settings (`~/.pi/agent/settings.json`) and make it available in every project:

```bash
# Replace OWNER and the version with the published repository and release.
pi install git:github.com/OWNER/pi-rpac@v1
```

Until then, use the local-checkout instructions above.

### Project-level install

Add `--local` / `-l` to write the declaration to `.pi/settings.json` in the *current* project
(loaded only after project trust is granted):

```bash
cd /path/to/your-project
pi install --local /path/to/pi-rpac
```

### Development-mode loading (one-off, no settings change)

Load the extension directly for a single invocation:

```bash
pi --extension /path/to/pi-rpac/extensions/rpac.ts
```

To also load the skills for that run:

```bash
pi --extension /path/to/pi-rpac/extensions/rpac.ts \
   --skill /path/to/pi-rpac/skills/rpac-refine \
   --skill /path/to/pi-rpac/skills/rpac-plan \
   --skill /path/to/pi-rpac/skills/rpac-act \
   --skill /path/to/pi-rpac/skills/rpac-consolidate
```

Installation never overwrites your existing Pi configuration; it only appends a package
declaration. Run `pi config` (Tab switches personal/project scope) to enable or disable the
individual resources.

---

## Configuration

RPAC has **no required configuration** and intentionally reads no `conf` file — behavior is
driven by your repository (AGENTS.md, project docs, test toolchain).
Timing constants are fixed in `lib/lock.ts`: a dead state-lock holder is reclaimed immediately,
and an ordinary state lock older than **30 s** is recoverable (`LOCK_STALE_MS_DEFAULT`) because
those critical sections are synchronous and short. The ACT execution lease is taken over only
when its holder process is provably dead; age alone never displaces a live ACT executor.

There is no separate provider/model configuration — RPAC uses whatever model Pi is running.

---

## Usage — command reference

Everything lives under a single command: `/rpac`. Type `/rpac` with no argument (or `/rpac
status`, `/rpac help`) to see the current state and available actions.

| Command | What it does |
|---|---|
| `/rpac` | Show current workflow state and available actions. |
| `/rpac start [--yes] <task>` | Start a new workflow. A non-terminal active workflow becomes a *saved* (resumable) workflow rather than being destroyed; headless replacement requires `--yes`. Captures a git baseline and issues the **refine** directive. |
| `/rpac refine [notes]` | (Re)issue the refine directive. |
| `/rpac plan [notes]` | Ensure the requirements are approved (dialog), then issue the **plan** directive. |
| `/rpac act [--sequential] [task #]` | Start executing a task under the ACT execution lease. `--sequential` (or `/rpac approve sequential`) lets the model continue through ready tasks in one run. One task per run by default. |
| `/rpac consolidate [--force]` | Issue the **consolidate** directive (verify + report). `--force` (headless) / confirm (TUI) required while tasks are unfinished. |
| `/rpac approve requirements\|plan\|sequential` | Explicitly grant an approval. Thin requirements are refused; plan approval requires the exact finalized artifact hash. The headless fallback when no dialog UI is available. |
| `/rpac status` | Full state: phase, approvals, tasks, artifacts, git baseline/divergence, ACT lease, recent events. |
| `/rpac list` | List all saved workflows (`*` = active) with phase and resumability. |
| `/rpac resume [id]` | Run stale checks, clear a pause, and re-issue the directive for the current phase. ACT resume acquires the execution lease. Pass a workflow `id` to switch to a saved workflow when no ACT run is live. |
| `/rpac accept <task-id> <reason>` | Record a **documented exception**: a failed task becomes `done` with the reason attached. User-only, requires a reason. |
| `/rpac pause` | Pause further execution (tool actions and `act` are blocked until resume). |
| `/rpac abort [--yes] [reason]` | Stop the workflow safely (confirms; `--yes` headless). All files are preserved; no code is reverted. |
| `/rpac handoff` | Write `handoff.md`; in TUI, start a fresh session seeded with it. Non-TUI prints the manual fallback. |
| `/rpac cleanup [--yes]` | Remove **all** RPAC state under `.pi/rpac/` (confirms; `--yes` headless). Code changes are never touched. |

### The model-facing `rpac` tool

The model calls a single `rpac` tool to record phase milestones (it can **request** approval but
never grant it). Actions: `status`, `refine_complete`, `plan_complete`, `task_start`,
`task_done` (requires `verification`; a task is `done` only when **all** checks pass — failing
checks make it `failed`), `task_fail`, `task_block`, `task_unblock`, `decision`, `deviation`,
`checkpoint`, `consolidate_complete`, `back_to_plan`, `back_to_act` (creates a concrete `Repair:`
task).

### Terminal UI

- **Footer status** (always, when a workflow exists): `◆ act 2/5`, with `⏸` when paused and
  `·req?` / `·plan?` when an approval is outstanding.
- **Task widget** (only during `act`/`consolidate`): a compact checklist (`✓ done`, `▶ active`,
  `⊘ blocked`, `· pending`).

While a workflow is active, RPAC injects only a tiny phase/task pointer; full artifacts stay on disk.

---

## A complete example workflow

Work in any git repository:

```
> /rpac start Add retry with backoff to the HTTP fetcher
```
RPAC records the task under `.pi/rpac/<workflow-id>/`, captures the git baseline, and asks the
model to **refine** the task into `<workflow-id>/requirements.md` (inspecting the code, asking
only what the code can't answer).

```
> /rpac plan          # review requirements.md, approve (dialog) → PLAN phase
```
The model writes `<workflow-id>/plan.md` with a small `## Tasks` list and calls
`rpac(action="plan_complete")` with the task list. You approve the plan (dialog or
`/rpac approve plan`).

```
> /rpac act           # execute task 1; verify it; the model calls task_done with its checks
> /rpac act           # task 2 … (one task per run by default)
> /rpac act --sequential   # or, after approving, let it run through the ready tasks
```
After each task the model must run the applicable checks and report them; failures and
unavailable checks are recorded as issues.

```
> /rpac consolidate   # verify against requirements, review the git diff, run final checks
```
The model writes `<workflow-id>/report.md` (acceptance-criteria verdict, changes, deviations,
verification results, remaining limitations) and calls `consolidate_complete` → **done**.

```
> /rpac status        # review the report and state
> /rpac handoff       # (optional) package for a fresh session
```

You review the report and the diff, then commit/publish at your own discretion — RPAC never does
this for you. If a check fails, the task is **failed** (not done): fix it and re-run, or record a
documented exception with `/rpac accept <id> <reason>`. If consolidation reveals a real problem,
the model calls `back_to_act` (a concrete `Repair:` task is created and executed under `/rpac
act`) or `back_to_plan` if the plan itself was wrong. A revised plan starts conservatively with
pending tasks, while completed-task verification from the superseded plan remains in
`taskHistory` for audit.

---

## Where state is stored

All workflow state is under the target repository's git root, one directory **per workflow**:

```
<repo>/.pi/rpac/
├── state.json        # index (versioned): active workflow id + summary of every saved workflow
├── <workflow-id>/    # one directory per workflow (w-xxxxxxxx)
│   ├── workflow.json #   machine state (versioned): phase, approvals, tasks (status,
│   │                 #   verification, issues, exceptions), superseded taskHistory,
│   │                 #   artifact refs (sha256), git baseline, checkpoints, bounded event log
│   ├── requirements.md
│   ├── plan.md
│   ├── log.md        #   append-only decisions, deviations, checkpoints (bounded)
│   ├── report.md
│   └── handoff.md
├── quarantine/       # corrupt files, never crash-looped (surfaced as notes)
├── .lock             # atomic write lock {token, pid, createdAt} (transient)
└── .act-lease        # ACT execution lease {token, pid, workflowId, taskId} (transient)
```

Every workflow started with `/rpac start` keeps its own directory forever; `/rpac list` shows
them all and `/rpac resume <id>` switches the active pointer back to any of them. Starting a new
workflow never destroys an old one.

- **Back up:** copy the whole `.pi/rpac/` directory. It is plain, human-readable text.
- **Remove safely:** delete `.pi/rpac/` (or `/rpac cleanup`). This only removes RPAC's own
  workflow state — it never touches your source files. The command may retain an empty
  `.pi/rpac/` lock directory to keep cleanup race-free. `/rpac abort` stops a workflow *without*
  deleting workflow data.
- **Git:** state is scoped to the git root. To keep it out of version control, add this to the
  target repository's `.gitignore`:

  ```gitignore
  .pi/rpac/
  ```

  Omit that rule to version-control workflow state for team handoff. RPAC writes only inside
  `.pi/rpac/`.

State is a *recoverable source of truth*, not a substitute for checking the repo: on
`/rpac resume` and `/rpac act`, RPAC re-hashes the artifacts and compares the git tree against the
baseline, and reports any drift.

---

## Updating

```bash
pi update --extensions      # reconcile installed package sources
# or, for a local/git source, update the checkout then:
pi update pi-rpac
/reload                       # in a running session, to pick up code changes
```

State is versioned (`version: 2` in each `workflow.json`, `version: 2` in `state.json`).
Version-1 (shared-layout) state from an earlier RPAC is **migrated automatically on first use** —
artifacts move into the workflow's directory and the move is recorded in the workflow log. A
version newer than the current one is rejected with a clear error rather than silently
mis-parsed; corrupt files are quarantined (under `.pi/rpac/quarantine/`) and reported, never
crash-looped.

---

## Uninstalling

```bash
pi remove pi-rpac            # or pi remove <the source you installed from>
```

This removes the package declaration and stops loading the extension/skills. It does **not**
touch any `.pi/rpac/` workflow state in your projects — remove those separately if you want them
gone (see "Where state is stored").

---

## Development

```bash
npm install          # dev dependencies (typescript, @types/node, typebox, pi types)
npm test             # unit + mock-Pi e2e + real-Pi RPC e2e
npm run test:unit
npm run test:e2e
npm run typecheck    # tsc --noEmit
npm run smoke        # load the extension in the *installed* Pi and verify /rpac dispatches
```

The library under `lib/` is pure TypeScript (Node builtins only) and is unit-tested directly,
including the lock: two real child processes race for the same lock (exactly one winner) and for
the takeover of the same stale lock (exactly one winner). `test/e2e/workflow.test.ts` loads the
real `extensions/rpac.ts` factory against a mock `ExtensionAPI` and drives the full command +
tool interface — two-task non-sequential ACT, failed/unavailable/blocked/interrupted outcomes,
sequential stop, headless refusals, the repair flow, stale detection, handoff, project
isolation, workflow switching, v1 migration, and corruption quarantine. `test/e2e/realpi.test.ts`
runs ONE complete workflow through the **actual installed Pi binary** in RPC mode against a
stateful mock OpenAI-compatible model (real `write`/`bash` tool calls, real confirm dialogs,
real on-disk state). `test/smoke/smoke.sh` verifies loading against the installed Pi.
The real-Pi e2e is skipped automatically when `pi` is not on `PATH`.

**Layout:** see [DESIGN.md](DESIGN.md) for the architecture, API grounding, and test strategy.

- `extensions/rpac.ts` — the only file that touches Pi APIs (command, tool, events, UI).
- `lib/` — `schema` (state types/validation), `machine` (transitions + guards), `store`
  (atomic writes + lock), `git` (baseline/divergence), `prompts` (phase directives), `paths`,
  `util`.
- `skills/` — `rpac-refine`, `rpac-plan`, `rpac-act`, `rpac-consolidate` (lazily-loaded,
  model-facing behavioral detail).

---

## Troubleshooting

**`/rpac` does nothing / "no active workflow"** — No workflow exists in *this* repository yet.
Run `/rpac start <task>`. Note that state is per-repo; starting Pi from a different directory or
subrepo that isn't under the same git root will show no workflow.

**"RPAC state is locked by another process"** — Another Pi process (or a crashed one) holds
`.pi/rpac/.lock`. A dead holder is reclaimed automatically; an over-age ordinary state lock is
also recoverable because state critical sections are synchronous and short. Recovery is
serialized by a short exclusive takeover guard, and ownership is revalidated before the stale
lock is replaced. The ACT lease (`.pi/rpac/.act-lease`) is released at the end of each model run
and on session shutdown. ACT takeover requires a provably
dead holder pid—a live executor is never displaced merely because its timestamp is old.

**"unsupported workflow state version"** — The `workflow.json` was written by a newer RPAC
version. Don't edit it by hand across versions; restore from your backup or start fresh
(`/rpac start`). **Corrupt** files (invalid JSON, failed validation) are moved to
`.pi/rpac/quarantine/` and reported as a note on the next `/rpac status` — the rest of the
state keeps working. **"…was quarantined"** means exactly this; the quarantined file is preserved
for inspection. **Note: migration …** means version-1 state was migrated into the per-workflow
layout on first use.

**"… requires approved requirements / plan"** — An approval gate is outstanding. Approve with the
dialog or `/rpac approve requirements` / `/rpac approve plan`. The model cannot self-approve.

**A task shows `⊘ blocked`** — The model hit a prerequisite the codebase contradicted or that
isn't met. Read the blocker in `.pi/rpac/<workflow-id>/log.md`, resolve it, then have the model call
`task_unblock` and run `/rpac act` again.

**`turn_end could not resolve the persisted assistant entry ID` (in `--print`/headless runs)** —
A known Pi-core quirk when an extension issues a follow-up user message in non-interactive mode
(reproduces with any extension that calls `sendUserMessage`, including a trivial one). It is not
an RPAC bug; the on-disk state is still written correctly. It does not occur in normal interactive
TUI use.

**The footer status is missing** — RPAC only shows it in modes with a UI. In `--print`/JSON mode
there's no footer; use `/rpac status` to read state.

**Skills not being followed** — Skills are advertised by name/description and loaded on demand. If
the model doesn't load one, force it with `/skill:rpac-plan` (or the relevant `rpac-*` skill).

---

## Design decisions & limitations

**Why a native extension rather than porting the reference skills.** RPAC's reference
implementation (the `eai-org/agent-toolkit` skills, MIT) targets a skill-only agent where phases
are hand-invoked and handoff is a copy-paste launch command. Pi provides a stateful extension API
(commands, tools, events, dialogs, session replacement), so RPAC is implemented natively: a state
machine with enforced approval gates, durable state, and a compact UI. The toolkit's *behavioral
concepts* (what-not-how refinement, verify-against-the-codebase, one-question-at-a-time,
self-contained fresh-session artifacts, one-task-per-run with mandatory verification, honest
consolidation) are adapted here — see Attribution.

**Task outcomes are honest.** A task is `done` only when every recorded verification check
passed. Failing or unavailable checks make it `failed` (with the issues recorded); a run that
ends mid-task leaves it `interrupted`; prerequisites that cannot be met make it `blocked`.
`failed` is a user decision point: fix and re-run, or record a documented exception
(`/rpac accept <id> <reason>`). In sequential mode, anything that is not a verified pass stops
the run.

**Limitations, by design:**
- **No autonomous session spawning.** `/rpac handoff` starts a fresh session only when *you*
  trigger it (TUI). There are no background agents.
- **Approvals are user actions.** The model can finish and request, but a human approves
  requirements, the plan, and sequential mode. The model can never self-approve.
- **REFINE and PLAN are mechanically read-only.** While the phase is `refine` or `plan`, the
  extension allows `write`/`edit` only for the exact phase artifact, restricts shell commands
  to conservative read-only forms, permits known inspection tools plus nested-call-gated
  `codemode`, and blocks unknown custom tools. ACT is under normal Pi permissions.
- **No auto commit/push/merge/publish.** Consolidation reports; you decide.
- **Baseline is a snapshot, not a monitor.** Drift (changed artifacts, moved git HEAD, new
  uncommitted files) is checked at `status`/`resume`/`act` boundaries, never auto-resolved.
  RPAC's own `.pi/rpac/` churn is excluded from the divergence report.
- **One active workflow, many saved.** A repo has one *active* workflow at a time; all others
  stay resumable (`/rpac list`, `/rpac resume <id>`).

**Context efficiency:** per-turn cost is a tiny phase/task pointer plus footer status. Phase
directives are short; detail is in skills loaded only when the task calls for them.

---

## Attribution & license

- The **architecture, code, tests, and documentation** in this repository are original.
- **Behavioral constraints** for the refine/plan/act/consolidate phases are adapted from the
  `refine-ticket`, `create-implementation-plan`, `split-plan-tasks`, `execute-plan-tasks`,
  `harden-artifact`, `handover`, and `prepare-prompt` skills of
  [eai-org/agent-toolkit](https://github.com/eai-org/agent-toolkit), MIT License,
  Copyright (c) 2026 Engineering in the age of AI. Only concepts were adapted; no code was copied,
  and no files from that toolkit are bundled.
- This project is released under the **MIT License** (see [LICENSE](LICENSE)).
