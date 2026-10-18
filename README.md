# pi-rpac — RPAC workflow for Pi

**RPAC = Refine → Plan → Act → Consolidate.** A native [Pi](https://pi.dev) extension that turns a
task into **approved requirements**, an **approved plan**, **incrementally executed and verified
tasks**, and an **honest completion report** — with durable, human-readable, per-project state and
explicit, user-gated phase transitions.

It is a *workflow state machine*, not a second agent runtime. It drives the model Pi is already
configured with (including local OpenAI-compatible models) and coexists with your normal Pi setup.
Alongside implementation workflows, it provides a manifest-backed, report-only self-review workflow
for exact current, staged, or full Git scope.

```
 ┌────────┐  approve  ┌─────┐  approve  ┌──────────────────────────┐  report  ┌──────┐
 │ REFINE │ ────────► │ PLAN│ ────────► │ ACT (one task per run)   │ ───────► │ DONE │
 │ what?  │  (user)   │ how?│  (user)   │ verify each task         │ (model)  │      │
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
- **Manifest-backed self-review.** `/rpac review [current|staged|full]` captures a deterministic,
  byte-safe Git snapshot, assigns every item to bounded evidence batches, validates candidate
  findings adversarially, detects drift, and writes `review-report.md`. Review execution is
  mechanically report-only in every phase; fixes require a separate ordinary RPAC workflow.
- **GitHub PR review.** `/rpac start preview <pr-number>` resolves a pull request with the `gh`
  CLI, safely checks out its exact head (in-place when the work tree is clean, or an isolated
  `git worktree` when it is dirty), and runs the same approval-gated, report-only review lifecycle
  against the PR's `base...head` diff. It treats the PR as untrusted input, never posts/merges/
  comments on GitHub, detects force-push drift, and preserves your local work. A fork (cross-repo)
  PR is reviewed from its head commit. `/rpac pr-cleanup` removes an isolated worktree when you
  are done.
- **Local-model reliability.** Review manifests, exact item assignments, per-batch evidence ledgers,
  no-sampling rules, persisted coverage, observation checks, and explicit same-context limitations
  keep long reviews resumable without pretending incomplete work is clean.
- **Fresh-session handoff.** `/rpac handoff` writes a self-contained `handoff.md` and (in TUI)
  starts a fresh session seeded with it — an explicit, user-triggered continuation.

---

## Requirements

- **Pi** `@earendil-works/pi-coding-agent` **1.1.0** or newer (tested against 1.1.0).
- **Node.js** 22.6+ (type-stripping is used to run the TypeScript extension and tests directly;
  no build step needed).
- **git** available on `PATH` (used for baselines, divergence, and review snapshots). Ordinary
  `/rpac start` workflows still work in a non-git directory with baseline features disabled;
  `/rpac review` requires a Git work tree.
- **GitHub PR review only:** the [`gh` CLI](https://cli.github.com/) on `PATH`, authenticated
  (`gh auth status`), and a repository with a remote pointing at the PR's GitHub host. `gh` is
  used for metadata and an explicitly authorized local detached checkout. RPAC never publishes
  a GitHub review, comment, merge, or other remote mutation.
- Any model configured in Pi, including local models over OpenAI-compatible endpoints. No hosted
  model or new provider is required.

Host-provided packages `@earendil-works/pi-coding-agent` and `typebox` are declared as
`peerDependencies` and are supplied by Pi at runtime — you don't install them for the extension
to run.

---

## Installation

RPAC is a standard **Pi package** (a directory with a `pi` manifest exposing `extensions/` and
`skills/`). Pi's native installer handles all of these. You do **not** install it with
`npm install -g`; `pi install` records the package in Pi's settings and loads both the extension
and its skills.

### Does it work with my existing Pi extensions?

Yes. A personal RPAC install is added alongside the extensions, skills, prompts, and themes you
already use; it does not replace them or create a separate Pi environment. RPAC is dormant until
you run `/rpac start` in a project, and its workflow state remains local to that project's git
root.

Two practical caveats:

- Another extension must not claim the same `/rpac` command or `rpac` tool name.
- Ordinary workflows block mutating and unknown tools in **REFINE** and **PLAN**. Review workflows
  remain report-only through **ACT** and **CONSOLIDATE** too: only the exact current review artifact,
  known inspection tools, and user-approved non-destructive checks are allowed. Other extensions
  remain loaded, but their tools may be refused by these fail-closed gates.

If RPAC appears in both personal and project settings, Pi identifies equivalent package sources
and avoids loading duplicate copies. A project declaration can override/filter the personal one.

### From a local checkout (development)

First clone this repository somewhere permanent. Then, in your regular shell—not inside an
interactive Pi session—register that directory as a personal Pi package:

```bash
git clone https://github.com/Jellypowered/pi-rpac.git /stuff/Source/pi-rpac
pi install /stuff/Source/pi-rpac
pi list                 # confirms "pi-rpac" is configured
```

`pi install ./` is only shorthand for the same command when your shell's current directory is the
checkout. You do not need to start interactive Pi there; `cd /path/to/pi-rpac` merely makes `./`
resolve to that directory. After installation, start Pi in the project where you actually want to
work:

```bash
cd /path/to/your-project
pi
```

Pi records the checkout's absolute path in your personal settings; it does not copy the package.
Keep the checkout in place. Edits or `git pull` updates to `extensions/`, `lib/`, or `skills/` are
picked up after `/reload` or a Pi restart.

### User-level ("global") install

In Pi, a global install is called a **personal** or **user-level** install. Install without
`--local`; this adds RPAC to `~/.pi/agent/settings.json` and makes it available in every project:

```bash
pi install git:github.com/Jellypowered/pi-rpac
pi list
```

After release tags are available, pin one when you need reproducible installs, for example
`git:github.com/Jellypowered/pi-rpac@<tag>`. If the package is published to npm, the equivalent
will be `pi install npm:pi-rpac@<version>`; this is a Pi package install, not `npm install -g`.

A personal install does not create workflows in every repository. It only makes `/rpac`
available; workflow state is created when you explicitly run `/rpac start`.

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
   --skill /path/to/pi-rpac/skills/rpac-consolidate \
   --skill /path/to/pi-rpac/skills/rpac-review
```

Installation never overwrites your existing Pi configuration; it only appends a package
declaration. Run `pi config` (Tab switches personal/project scope) to enable or disable the
individual resources.

---

## Configuration

RPAC has **no required configuration**. Workflow behavior is driven by your repository
(AGENTS.md, project docs, test toolchain). Communication preferences are optional:
Timing constants are fixed in `lib/lock.ts`: a dead state-lock holder is reclaimed immediately,
and an ordinary state lock older than **30 s** is recoverable (`LOCK_STALE_MS_DEFAULT`) because
those critical sections are synchronous and short. The ACT execution lease is taken over only
when its holder process is provably dead; age alone never displaces a live ACT executor.

There is no separate provider/model configuration — RPAC uses whatever model Pi is running.

### Communication styles

Styles change **how RPAC explains its work**, not what it may do. Approvals, permissions,
security gates, failed checks and saved technical evidence stay the same.

| Identifier | Voice |
|---|---|
| `natural` (default) | Friendly, professional, conversational plain English. |
| `chill` | Relaxed, casual and concise; no jokes about serious failures. |
| `critical-natural` | Direct and skeptical; confirmed problems are distinct from suspicions. |
| `teacher` | Patient explanations of unfamiliar ideas and why important steps matter. |
| `technical` | Precise engineering terms and relevant commands and diagnostics. |
| `eli5` | Short sentences and familiar words, without childish language. |

```text
/rpac style                         # effective style, source, and available names
/rpac style teacher --global        # your personal default
/rpac style technical --project     # this project's override
/rpac style chill                   # shorthand for --project
/rpac style --reset-project         # remove the override; inherit your personal default
/rpac status --details              # technical evidence, regardless of style
```

**Precedence:** project override → personal default → Natural. Changing the personal default
leaves project overrides in place. Flags may appear before or after the name; unknown flags and
conflicting scopes are rejected. Tab completion offers built-in/custom identifiers and flags
where Pi supports it.

**Files:** preferences use version-1 JSON, separate from workflow records:

- Personal: `<agent-dir>/rpac-style.json`, normally `~/.pi/agent/rpac-style.json`.
  RPAC uses Pi's exported `getAgentDir()`, including `PI_CODING_AGENT_DIR` overrides.
- Project: `<project-root>/.pi/rpac-style.json`. The root is the Git root, or the current
  directory outside Git, just like workflow state.

The next relevant model request uses the current preference without restarting work, changing
approvals or rewriting old reports. Words already streaming cannot change retroactively.
Preferences survive restarts, reloads, session changes, compaction, resumption and handoffs.
Style commands work without a workflow, but personality instructions apply **only during an
active RPAC workflow**—not while paused, completed or aborted. Normal conversations without
an active workflow are unchanged. Resumption uses the current preference, not a historical copy.

### Custom styles

Edit either preference file. For example, to register and select a personal custom style:

```json
{
  "version": 1,
  "style": "concise-reviewer",
  "styles": {
    "concise-reviewer": {
      "name": "Concise Reviewer",
      "description": "Short, direct, evidence-focused explanations.",
      "instructions": "Use short paragraphs, prioritize confirmed issues, explain risks plainly, and avoid unnecessary commentary.",
      "examples": ["Two confirmed issues need attention before we continue."]
    }
  }
}
```

Then use `/rpac style concise-reviewer --global` (or `--project` for a project selection).
`style` and `styles` are optional; `version: 1` is required. A global default can select only
built-ins or globally defined custom styles; projects can also select project definitions.
Built-in identifiers cannot be redefined. Project definitions duplicating global identifiers
are ignored with a warning, never silently substituted.

To **update** a voice, edit its instructions; the next request uses the change without `/reload`.
To **remove** it, choose another style (or remove its `style` selection), then delete its entry
from `styles`. Resetting the project override preserves definitions. Unavailable selections
fall back to the next valid preference with a warning.

Identifiers are lowercase letters/numbers separated by single hyphens, start with a letter and
have at most 48 characters; reserved identifiers are rejected. Each file allows 32 custom styles
and 64 KiB total. Limits: name 80 characters, description 240, instructions 1,600; optional
examples are at most three strings of 240 characters each. Unknown fields, unsupported versions,
control characters and malformed values are rejected. Configuration is **text only**—no scripts,
imports or file references. Treat repository-supplied style text as untrusted presentation data,
never authorization to run commands or change policy.

Writes are atomic. Malformed files are preserved, not overwritten; RPAC explains which file to
fix or move aside and uses the next valid layer. Symlinked files and write directories are
refused. Fix invalid files before retrying a save or reset. `/rpac style` shows warnings;
active requests also surface them once per extension runtime, not on every tool call.

### Progress, approvals and technical evidence

RPAC explains meaningful milestones, complications and next steps instead of narrating every
tool. Approval dialogs explain what you are agreeing to and point to the document. You can
decline and ask for changes; approval remains user-only. Errors keep useful diagnostics and
give recovery guidance where the current state supports it. Failures and limitations stay visible.

`/rpac status` begins with progress and next-step guidance. `/rpac status --details` shows the
technical status, recorded checks, Git baseline, recent events and artifact pointers. Technical
style also keeps detailed status by default. Full identities, exact check details and historical
records remain in `.pi/rpac/<workflow-id>/workflow.json`, `log.md`, requirements, plans, reports
and review ledgers. New documents have a readable opening without replacing required sections.
Historical artifacts are never restyled.

The exact `.pi/rpac-style.json` file is excluded from local and PR review scope, so changing
voice does not invalidate review coverage. In-place PR evidence checks also disregard this
metadata-only change. Checkout preparation and worktree removal retain their strict cleanliness
rules; no source-file or source-rename exception is added.

**Limitations:** the model controls its wording. RPAC supplies concise, request-local, user-level
preferences, not a replacement system prompt or an output-rewriting filter. Higher-priority
instructions and explicit user requests take precedence. Custom text cannot configure tools,
workflow policy or permissions; existing mechanical gates remain authoritative. This is not a
general prompt-injection sandbox. Some models may follow a voice imperfectly. Deterministic
messages vary at useful milestones, not every diagnostic. Passing tests proves instruction
contracts and gates, not conversational quality for every model. See the
[six-style comparison and manual checklist](test/manual/styles.md).

---

## Quick start: your first RPAC workflow

You interact with RPAC through `/rpac` commands in a normal interactive Pi session. You do not
invoke the `rpac` model tool or load the phase skills yourself—RPAC directs the model and the
model records progress automatically.

This example fixes a small bug from start to finish:

1. **Open the project in Pi.**

   ```bash
   cd /path/to/your-project
   pi
   ```

2. **Describe the outcome you want.** Be specific about the behavior, not the implementation.

   ```text
   /rpac start Fix the settings form so an invalid port shows an inline error instead of submitting
   ```

   RPAC creates `.pi/rpac/<workflow-id>/`, captures the current git baseline, and asks the model
   to inspect the repository. The model may ask clarifying questions, then writes
   `requirements.md`. No application code can be changed in this phase.

3. **Review the requirements and move to planning.** Answer any questions, inspect the artifact
   path shown by `/rpac status`, then run:

   ```text
   /rpac plan
   ```

   Approve the requirements in the dialog (or use `/rpac approve requirements` without a TUI).
   The model creates `plan.md` and a concrete task list. Review it and approve the plan when
   prompted; the headless equivalent is `/rpac approve plan`.

4. **Execute the plan.**

   ```text
   /rpac act
   ```

   By default this executes and verifies one task, then stops so you can inspect the result. Run
   `/rpac act` again for each remaining task. Use `/rpac status` at any point to see what is done,
   pending, blocked, or failed. For a trusted plan, `/rpac act --sequential` can run all ready
   tasks after a separate confirmation.

5. **Verify the whole change and get the report.**

   ```text
   /rpac consolidate
   ```

   The model checks the implementation against the approved requirements, reviews the diff, runs
   final checks, and writes `report.md`. Read the report and inspect the code before committing;
   RPAC never commits or publishes changes.

The everyday loop is therefore:

```text
/rpac start <goal>  →  answer questions  →  /rpac plan  →  approve plan
                    →  /rpac act (repeat) →  /rpac consolidate
```

If you close Pi midway, return to the same repository and run `/rpac status`, then `/rpac resume`.
Use `/rpac list` and `/rpac resume <id>` when the repository contains multiple saved workflows.

---

## Self-review workflow

Start a local review from the repository you want to inspect:

```text
/rpac review          # current (default): staged + unstaged + non-ignored untracked
/rpac review staged   # exact index bytes only; disk-only changes are excluded
/rpac review full     # every tracked + non-ignored untracked path in the worktree
```

`current` preserves separate HEAD/index/worktree identities, so staged content later changed or
canceled on disk is still represented. `staged` reads index blobs and never substitutes working-tree
bytes. `full` is a repository-health review rather than a branch diff. Empty current/staged scopes
remain valid auditable no-ops. Unborn branches, deletions, renames, modes, symlinks, gitlinks,
binary/large content, unusual path bytes, and conflicts are represented explicitly; unresolved
index conflicts reject `staged` review.

The lifecycle remains approval-gated: REFINE discovers repository policy, intent, exact exclusions,
and safe checks; PLAN assigns every manifest ID exactly once to bounded batches and adds adversarial
validation; repeated ACT runs write hashed `review-batch-<id>.md` evidence; CONSOLIDATE writes
`review-report.md`. `/rpac status`, `list`, `resume`, `pause`, `abort`, and `handoff` work for reviews
as they do for implementation workflows.

Review execution cannot modify reviewed files, Git/index/remote state, sibling repositories, or
install tools. Only exact review artifacts and user-approved non-destructive checks are allowed.
Snapshot drift invalidates affected coverage and must remain visible. Failed/unavailable checks,
uncovered items, conflicts, and `same-context review; weaker independence` prevent a clean or
approval claim. A review report records scrutiny—not merge readiness, security certification, or
proof that no defects exist. To implement a finding, start a separate ordinary `/rpac start ...`
workflow; the review never fixes its subject.

### Reviewing a GitHub pull request

Besides reviewing your local work tree, RPAC can review a **GitHub pull request** directly:

```text
/rpac start preview <pr-number>     # resolve the PR with gh, check it out, and start a review
```

The command:

1. **Resolves the PR** with `gh pr view` (number, title, body, base and head refs/SHAs, whether it
   is a fork/cross-repo PR). The repository must have a remote pointing at the PR's GitHub host.
2. **Safely checks out the PR head** so the diff is reviewable locally:
   - **in-place** when your work tree is clean — the PR is checked out detached onto the exact
     head SHA (your original branch + HEAD are recorded so nothing is lost).
   - **worktree** when your work tree is dirty — an isolated `git worktree` is created alongside,
     so your uncommitted changes stay untouched. Clean it up later with `/rpac pr-cleanup`.
3. **Captures the PR scope** as a deterministic `base...head` manifest (added / modified / deleted
   / renamed files, with `base` = the **merge-base** and `pr` = the pinned head). Git modes,
   symlinks, gitlinks, binary content, and raw filename bytes retain their identities. Fork PR
   heads are fetched via the base repository's PR ref; the remote must match that repository
   and host, not merely be named `origin`.
4. **Runs the normal review lifecycle** — REFINE → PLAN → ACT → CONSOLIDATE — with PR-specific
   prompts. The PR is treated as **untrusted input**: you are reviewing someone else's diff, not
   editing it.

Because it is a review workflow, execution stays **report-only**: it cannot modify the reviewed
files, change Git/index/remote state, or run a mutating `gh` command. It writes
`review-report.md` with **advisory** findings — it does not post a review, comment, merge, or
approve the PR on GitHub.

**Verification directory.** Every approved PR check must include its recorded checkout directory
in the exact command, for example `cd -- '/absolute/pr-checkout' && npm test`. RPAC rejects
unqualified checks, different prefixes, and subsequent shell directory switches. The same prefix
is required for in-place checkouts. Existing PR plans without it must be replanned. Missing,
modified, or wrong-HEAD checkouts cannot supply approved verification evidence. Approved scripts
are still executable code, not sandboxed by RPAC: inspect them and use external isolation when needed.

**Drift / force-push.** Both base and head identities are pinned. Advances, force-pushes, base
retargets, unavailable remote freshness, and checkout contamination invalidate coverage and remain
visible, including for empty scopes. RPAC never silently switches commits. Start a fresh
`/rpac start preview <pr-number>` to review a changed target.

**Restoring your tree.** After an in-place checkout your work tree is at the PR head. Return to
your original branch with plain Git (the recorded branch/HEAD is shown in `/rpac status`), or
`/rpac abort` and re-checkout as needed. A worktree-strategy checkout is removed with
`/rpac pr-cleanup`, which leaves your main tree exactly as it was. Cleanup requires a registered,
RPAC-owned worktree at the recorded head and refuses tracked changes, untracked/ignored files,
symlinks, or hidden index flags. It never forces removal or recursively deletes a fallback path.
Legacy worktrees without an ownership record require manual inspection; RPAC refuses to remove them. Cleanup leaves the local `refs/rpac/pr/<number>` fetch ref and fetched objects in the main repository; RPAC does not delete a ref whose ownership cannot be proven. Inspect and remove that ref manually only after confirming its current SHA and that no other workflow uses it.

---

## Usage — command reference

Everything lives under a single command: `/rpac`. Type `/rpac` with no argument (or `/rpac
status`, `/rpac help`) to see the current state and available actions.

| Command | What it does |
|---|---|
| `/rpac` | Show current workflow state and available actions. |
| `/rpac style [name] [--global\|--project]` | Show styles or save a preference (project scope by default). |
| `/rpac style --reset-project` | Remove the project override and inherit the personal default. |
| `/rpac status --details` | Show detailed technical evidence in any style. |
| `/rpac start [--yes] <task>` | Start a new implementation workflow. A non-terminal active workflow becomes a *saved* (resumable) workflow rather than being destroyed; headless replacement requires `--yes`. Captures a git baseline and issues the **refine** directive. |
| `/rpac review [current\|staged\|full]` | Start an approval-gated, report-only review (default: `current`). Requires a Git work tree; unsupported modes/options/base syntax are rejected. Uses the same active-workflow save/confirm safeguards as `start`. |
| `/rpac start preview <pr-number>` | Start a report-only **GitHub PR review**: resolve the PR with `gh`, safely check out its head (in-place if the tree is clean, isolated worktree if dirty), capture the `base...head` scope, and issue the PR **refine** directive. Requires `gh` (authenticated), a Git work tree, and a remote pointing at the PR's GitHub host. Never posts/merges/comments on GitHub. |
| `/rpac pr-cleanup` | Remove the isolated `git worktree` used by a worktree-strategy PR review. Refuses dirty, ignored/untracked, unowned, changed-HEAD, or unexpected locations. For in-place checkouts, prints non-forcing restore instructions instead. Your main tree is never modified. |
| `/rpac refine [notes]` | (Re)issue the workflow-kind-specific refine directive. |
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
never grant it). Actions: `status`, `review_scope`, `refine_complete`, `plan_complete`, `task_start`,
`task_done` (requires `verification`; a task is `done` only when all **acceptance** checks pass;
`observation` checks record audit findings without deciding task success; optional `deliverables`
are hashed and tracked), `task_fail`, `task_block`, `task_unblock`, `decision`, `deviation`,
`checkpoint`, `consolidate_complete`, `back_to_plan`, and `back_to_act`. Review planning adds
`reviewItemIds` and `reviewChecks`; review batches require their exact hashed evidence artifact.
`back_to_act` creates implementation repair work only and is forbidden for report-only reviews.

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
│   │                 #   verification, observations, hashed deliverables, issues, exceptions), superseded taskHistory,
│   │                 #   artifact refs (sha256), git baseline, checkpoints, bounded event log
│   ├── requirements.md
│   ├── plan.md
│   ├── log.md        #   append-only decisions, deviations, checkpoints (bounded)
│   ├── report.md              # ordinary implementation completion report
│   ├── review-manifest.json   # review only: deterministic scope + layer identities
│   ├── review-batch-<id>.md   # review only: per-task evidence ledger
│   ├── review-report.md       # review only: final report + limitations
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

  Omit that rule to version-control workflow state for team handoff. Workflow writes stay inside `.pi/rpac/`; optional communication
  preferences use the separate files described under Configuration.

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

State is versioned (`version: 3` in each `workflow.json` and `state.json`). Versions 1 and 2 load
as ordinary implementation workflows and migrate to the current shape; the legacy version-1
shared layout is moved into a workflow directory with the migration recorded in its log. Version 3
adds the workflow kind and durable review snapshot/coverage/check metadata. A version newer than
the current one is rejected rather than silently discarding review state; corrupt files are
quarantined under `.pi/rpac/quarantine/` and reported, never crash-looped.

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
isolation, workflow switching, migration, corruption quarantine, all review modes, interruption,
drift, conflict rejection, and report-only gates. `test/e2e/realpi.test.ts` copies the package
outside the checkout and runs it through the **actual installed Pi binary** in RPC mode against a
stateful mock OpenAI-compatible model (real tools/dialogs/state), verifies the bundled review
skill/license, dispatches `/rpac review`, and checks HEAD/index/content invariants.
`test/smoke/smoke.sh` repeats copied-package start/review and mutation invariants in installed Pi.
The real-Pi e2e is skipped automatically when `pi` is not on `PATH`.

**Layout:** see [DESIGN.md](DESIGN.md) for the architecture, API grounding, and test strategy.

- `extensions/rpac.ts` — the only file that touches Pi APIs (command, tool, events, UI).
- `lib/` — `schema` (state types/validation), `machine` (transitions + guards), `store`
  (atomic writes + lock), `git` (baseline/divergence), `review` (byte-safe Git snapshots),
  `gating` (ordinary planning + report-only review gates), `prompts` (phase directives), `paths`,
  `util`.
- `skills/` — `rpac-refine`, `rpac-plan`, `rpac-act`, `rpac-consolidate`, and the bundled
  `rpac-review` adaptation with its adjacent upstream MIT license (lazily-loaded behavioral detail).

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

**`/rpac review` rejects the directory or mode** — Review supports only `current`, `staged`, and
`full` and requires a Git work tree. Branch/base/PR syntax and extra options are intentionally not
accepted. Resolve unmerged index entries before an exact `staged` review.

**A review reports drift/uncovered items** — The selected Git snapshot changed after capture.
Affected coverage is invalidated rather than silently reused. Replan/review the delta or finish with
an explicitly incomplete `review-report.md`; do not treat it as clean. Review fixes belong in a
separate `/rpac start` workflow.

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

**Task outcomes are honest.** A task is `done` only when every recorded acceptance check
passed. Failing or unavailable acceptance checks make it `failed` (with the issues recorded);
non-blocking `observation` checks preserve actual audit/review outcomes; a run that
ends mid-task leaves it `interrupted`; prerequisites that cannot be met make it `blocked`.
`failed` is a user decision point: fix and re-run, or record a documented exception
(`/rpac accept <id> <reason>`). In sequential mode, anything that is not a verified acceptance
pass stops the run; non-blocking observations do not.

**Limitations, by design:**
- **No autonomous session spawning.** `/rpac handoff` starts a fresh session only when *you*
  trigger it (TUI). There are no background agents.
- **Approvals are user actions.** The model can finish and request, but a human approves
  requirements, the plan, and sequential mode. The model can never self-approve.
- **Ordinary REFINE and PLAN are mechanically read-only.** The extension permits only the exact
  phase artifact, conservative inspection, and known read-only tools. Ordinary ACT returns to
  normal Pi permissions.
- **Review is mechanically report-only throughout.** Review ACT/CONSOLIDATE can write only the
  current batch/report artifact and run exact approved non-destructive checks. Semantic review is
  still model work: complete ledgers and adversarial validation improve reliability but cannot
  prove a repository defect-free.
- **No auto commit/push/merge/publish.** Consolidation reports; you decide.
- **Snapshots are boundary checks, not continuous monitors.** Ordinary divergence and exact review
  drift are checked at lifecycle boundaries and completion, never auto-resolved. RPAC's own
  `.pi/rpac/` churn is excluded.
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
  Copyright (c) 2026 Engineering in the age of AI. For these ordinary RPAC phase behaviors, only
  concepts were adapted; no toolkit phase files are bundled. The review derivative below is a
  separate, explicitly bundled adaptation with its own preserved adjacent license.
- The bundled [`rpac-review`](skills/rpac-review/SKILL.md) skill is an adapted derivative of
  Engineering in the age of AI's MIT-licensed
  [`self-review`](https://github.com/eai-org/agent-toolkit/blob/main/skills/self-review/SKILL.md)
  and
  [`fresh-eyes-review`](https://github.com/eai-org/agent-toolkit/blob/main/skills/fresh-eyes-review/SKILL.md).
  Its exact upstream license and `Copyright (c) 2026 Engineering in the age of AI` are preserved
  adjacent to the skill at [`skills/rpac-review/LICENSE`](skills/rpac-review/LICENSE). The bundled
  adaptation is self-contained; no upstream/global review skill is required at runtime.
- This project is released under the **MIT License** (see [LICENSE](LICENSE)).
