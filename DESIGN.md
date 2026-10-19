# RPAC for Pi — Design

**RPAC = Refine → Plan → Act → Consolidate.** A native Pi extension that turns a task into
approved requirements, an approved plan, incrementally executed and verified tasks, and an
honest completion report — with durable, human-readable, **per-workflow** project state, real
concurrency control, mechanically enforced planning gates, and a distinct manifest-backed,
report-only review workflow.

## 1. Grounding (what was examined)

**Reference toolkit** (`eai-org/agent-toolkit`, MIT, © 2026 "Engineering in the age of AI"):
RPAC there is a set of manually-invoked Markdown skills (`refine-ticket`,
`create-implementation-plan`, `split-plan-tasks`, `execute-plan-tasks`, `harden-artifact`,
`handover`, `prepare-prompt`) plus ticket-fetching infrastructure. Phase handoffs are
copy-pasteable CLI launch commands into fresh agent sessions; artifacts are
`*.REQUIREMENTS.md` / `*.PLAN.md` files with checkbox task sections and a separate decisions
log.

Useful concepts **reused** (adapted, attributed in README — no code copied):
- "what, not how" split; requirements/plan must be self-contained for a **fresh session**.
- Never guess: code-answerable questions are resolved by reading code; genuine ambiguity is
  asked one question at a time, with a recommended answer. Blocking vs non-blocking
  uncertainty separated.
- Artifacts carry *verified codebase facts* (pinned to a commit) and an *overrides/deviations*
  section; deviations are logged the moment they are settled.
- One task per execution cycle; a task completes only after verification ran. Failing or
  unavailable acceptance checks make the task **failed**, not done; non-blocking observations
  preserve audit findings without conflating subject failure with workflow failure. No scope
  expansion, never commit/push automatically.
- Consolidation/handover writes a self-contained summary for a reviewer/next session holding
  nothing but the diff.

**Review source material.** The bundled `rpac-review` skill is separately adapted from the
MIT-licensed upstream `self-review` and `fresh-eyes-review` skills. Their exact-snapshot,
complete-coverage, fresh-eyes, and evidence-backed finding discipline is preserved, while
product-specific assumptions and interactive fix/disposition loops are replaced by portable
repository-policy discovery, bounded local-model batches, adversarial validation, and a strict
report-only boundary. The exact upstream license is adjacent to that skill.

**Not ported:** tracker/ticket fetching, PR-sized groups, vendor session-launch commands,
hardening as a separate fresh-agent run (folded into `/rpac handoff` + consolidate), separate
DECISIONS file (folded into the per-workflow `log.md`), or automatic review fixes.

**Decision: clean native implementation, selective reuse of concepts.** The toolkit targets a
skill-only agent with manual session launching; Pi provides a stateful extension API
(commands, tools, events, dialogs, session replacement). Porting its skills verbatim would
duplicate Pi's native mechanisms and lose approval/state enforcement.

**Pi 1.1.0 API facts verified against `dist/.../types.d.ts` + docs:**
- `pi.registerCommand(name, {description, handler(args, ctx), getArgumentCompletions})` — one
  command; subcommands parsed from the `args` string (single `/rpac` namespace).
- `pi.registerTool({...})` — TypeBox schema; `execute(toolCallId, params, signal, onUpdate,
  ctx)`. Tool context (`ExtensionToolContext`) has `ui`, `cwd`, `mode`, `hasUI`, `isIdle()`;
  the tool runs `executionMode: "sequential"` and is `exposure: "model-only"`.
- `pi.sendUserMessage(text, {deliverAs: "followUp"})` — queues phase directives as the next
  model run.
- `ctx.ui`: `notify`, `confirm`, `setStatus(key, text)`, `setWidget(key, lines)`. Guard with
  `ctx.hasUI` / `ctx.mode === "tui"` (handoff's `ctx.newSession` is TUI-only; non-TUI gets a
  manual-fallback message).
- `pi.on("tool_call", (event, ctx) => { block?: true, reason? })` — the hook that makes the
  planning/review read-only gates mechanical (see §2.5).
- `pi.on("context", ...)` runs before each model invocation, transforming request-local conversation
  messages while Pi restores its system/tool messages. A `custom` message converts to user-role
  content, not a system instruction. Used for dynamically resolved communication preferences.
  Verified against development Pi 1.1.0 and installed Pi 1.3.0 declarations, runner and message conversion.
- Runtime phase/style guidance uses `context` rather than a persisted `before_agent_start` message
  (see §2.6). It is refreshed on tool continuations and placed before the latest real user turn.
- `pi.on("agent_end" | "session_start" | "session_shutdown", ...)` — lifecycle for lease
  release and honest interruption recording (see §2.5).
- `ctx.newSession({withSession})` — explicit fresh-session handoff.
- Node 22.22 strips TS types natively → tests run with `node --test` on `.ts` files, zero
  runtime deps. `typebox` and `@earendil-works/pi-coding-agent` are host-provided
  (peerDependencies) — devDependencies only for local type-check/tests.

## 2. Architecture

```
pi-rpac/
├── package.json          # pi manifest + pi-package keyword; peer: pi-coding-agent, typebox
├── extensions/rpac.ts    # entry: /rpac command, rpac tool, events (gate/lease/context), UI
├── lib/
│   ├── schema.ts         # v3 workflow-kind/review state, validation, task graphs (pure)
│   ├── machine.ts        # phase transitions + outcome guards (pure)
│   ├── store.ts          # .pi/rpac IO: index, per-workflow dirs, v1 migration, quarantine
│   ├── lock.ts           # atomic wx lock + ACT lease, stale takeover, pid liveness (pure)
│   ├── gating.ts         # planning + all-phase report-only review gates (pure)
│   ├── shell.ts          # literal shell segments/words; no evaluation
│   ├── review-plan.ts    # explicit written/registered assignment agreement
│   ├── execution.ts      # screened host consent, input hashes, native evidence policy
│   ├── git.ts            # ordinary baseline/divergence detection (excludes .pi/)
│   ├── review.ts         # byte-safe Git snapshots, manifests, fingerprints, drift (pure)
│   ├── pr.ts             # GitHub PR review: gh resolution, safe checkout, base...head scope (pure)
│   ├── styles.ts         # versioned presentation preferences, registry, parser, request contract
│   ├── presentation.ts   # human progress/error/approval summaries (no state mutations)
│   ├── prompts.ts        # phase directives + tiny per-turn phase context
│   ├── paths.ts          # v3 layout/artifact resolution, workflow-id validation
│   └── util.ts           # sha256, atomicWriteFile (fsync file+dir), nowIso (pure)
├── skills/               # model-facing behavioral detail, lazily loaded
│   ├── rpac-refine/SKILL.md
│   ├── rpac-plan/SKILL.md
│   ├── rpac-act/SKILL.md
│   ├── rpac-consolidate/SKILL.md
│   └── rpac-review/      # adapted SKILL.md + preserved upstream MIT LICENSE
└── test/                 # node:test: unit + mock-API e2e + real-Pi RPC e2e; smoke/
```

**Layering:** `lib/` is pure TypeScript (node builtins only) → unit-testable with plain node.
`extensions/rpac.ts` is the only file that touches Pi APIs.

### 2.1 State — versioned per-workflow layout (project root = git root, else cwd)

Ordinary workflows and the index remain v3. PR previews carrying the new execution policy use
workflow v4 so older v3 engines reject them without losing the shared index/active pointer.
`review.execution` has its own v1 profile (screening, setup/output declarations, consent and runs).
Existing saved workflows/artifacts are not rewritten en masse.

```
<repo>/.pi/rpac/
├── state.json        # index (versioned): { version: 3, active: id|null, workflows: {id: summary} }
├── <workflow-id>/    # one directory per workflow (w-xxxxxxxx), kept forever
│   ├── workflow.json #   machine state (versioned, human-readable)
│   ├── requirements.md
│   ├── plan.md
│   ├── log.md        #   append-only, bounded (trim at 600 → keep 500)
│   ├── report.md             # implementation workflow
│   ├── review-manifest.json  # review workflow: deterministic scope
│   ├── review-batch-<id>.md  # review workflow: hashed task evidence
│   ├── review-report.md      # review workflow: final hashed deliverable
│   ├── host-approval-*.json  # optional PR host consent: immutable, hashed evidence
│   ├── review-check-*.log   # optional native setup/check stdout + stderr + outcome
│   └── handoff.md
├── quarantine/       # corrupt files, preserved + surfaced as notes
├── .lock             # state write lock: {token, pid, createdAt, refreshedAt?, ...}
└── .act-lease        # ACT execution lease: {token, pid, createdAt, workflowId, taskId}
```

Machine state (`workflow.json`) carries: id, task, phase, `approvals {requirements, plan,
sequential}`, current `tasks [{id, title, dependsOn?, status, verification?, deliverables?,
issues?, acceptedException?}]`, bounded `taskHistory` for completed evidence from superseded plans,
artifact refs + sha256, git baseline, checkpoints, bounded event log (last 50), `paused`, and a
`workflowKind` discriminator. Review state additionally carries mode, HEAD/unborn identity,
manifest/fingerprint, exact scope/planned/covered/uncovered item IDs, approved checks, exclusions,
and persisted drift. A **PR review** (`review.mode: "pr"`) additionally carries a `pr` metadata
block: PR number/URL/title/body, repository, state, cross-repository flag, the pinned base and head
refs/SHAs, the original branch/HEAD/dirty list captured before checkout, the checkout strategy
(`in-place` | `worktree`) and location, and the checkout timestamp. Validation rejects the PR mode
without a well-formed `pr` block (and vice-versa), and requires 40/64-hex base/head commit SHAs.

Rules:
- **Atomic writes**: tmp file + `fsync(file)` + rename + `fsync(dir)`; on failure the tmp is
  unlinked. Every mutation is load → mutate → save under the write lock.
- **Many workflows, one active.** `state.json` holds the active pointer and a summary per
  workflow. Starting a new workflow moves the pointer; the old directory is untouched and
  resumable (`/rpac resume <id>`).
- **Never overwrite user-modified artifacts**: sha256 mismatch → detect, warn (stale note),
  re-baseline on explicit approval.
- **Corruption is quarantined, not crash-looped**: invalid JSON / failed validation on
  `state.json` or a `workflow.json` → file moved to `quarantine/`, index rebuilt from the
  workflow directories, a note surfaced on the next `status`. Wrong-project or
  newer-version states are rejected with a note, never mis-parsed.
- **Version migration**: versions 1 and 2 default to the ordinary implementation kind and migrate
  to v3 without losing task/artifact history. A legacy v1 shared layout (`.pi/rpac/workflow.json`
  + shared artifacts) is moved into its workflow directory and recorded. Unknown future versions
  are rejected so review metadata cannot be silently discarded.
- State is scoped per project root (no cross-repo leakage). RPAC's own `.pi/rpac/` churn is
  excluded from git-divergence reports.

### 2.2 Review snapshot model

`lib/review.ts` invokes Git with argument arrays and consumes NUL-delimited output as bytes. Raw
pathname identity is retained as base64; display UTF-8 is never authoritative. Canonical sorted
JSON and SHA-256 bind the mode, HEAD/unborn baseline, applicable staged/unstaged patches, and every
manifest layer. `.git`, `.pi/rpac/**` and the exact `.pi/rpac-style.json` presentation preference file are
unconditional exclusions. Preferences must not introduce review drift merely by switching voice.

- `current` records the union of staged, unstaged, and non-ignored untracked paths with separate
  HEAD/index/worktree identities, including staged edits canceled on disk.
- `staged` records exact index blobs/modes against HEAD or the empty tree. Disk-only edits and
  untracked files do not affect identity or drift; unresolved index conflicts are rejected.
- `full` records all tracked plus non-ignored untracked paths as currently present and explicit
  tracked deletions; it is not a branch comparison.

Manifest items include stable IDs, raw/display paths, rename origins, change/conflict markers, and
per-layer state/mode/kind/object/hash/size/binary/large/link metadata. Symlinks and gitlinks are
items rather than traversal roots. Explicit exclusions must match exact in-scope paths and retain a
reason. Stable double-capture detects concurrent changes before persistence.

Before review ACT/resume/consolidation and again at completion, a fresh selected-mode snapshot is
compared to the original. Added/removed/changed IDs are persisted as drift, affected coverage is
invalidated, and an honest incomplete report remains possible; the system never upgrades partial
coverage to complete or silently changes scope.

### 2.2b PR review (`mode: "pr"`) — GitHub pull requests

`/rpac preview <pr-number>` reviews a GitHub PR in a separate worktree rather than switching the
local work tree. `/rpac start preview <number>` remains compatible with legacy checkout selection. It reuses
the exact review lifecycle (phases, approvals, leases, report-only gates, manifest/coverage,
drift, evidence batches, `review-report.md`) with PR-specific prompts and a distinct scope source.
`lib/pr.ts` is pure and drives `gh` through an injectable `GhRunner` interface so tests run against
a mock CLI (no network, no real GitHub).

- **Metadata resolution** (`gh pr view --json ...`): number, URL, title, body, state, base/head
  refs + SHAs, head-repository owner, and the cross-repository (fork) flag. A missing/unreadable PR,
  non-integer number, or invalid SHA is a clean error before any state is written.
- **Safe checkout.** The dedicated preview command always selects a separate worktree, including
  from a clean main tree. The legacy entry point retains `assessPrCheckout` selection:
  - **in-place** (clean tree): `gh pr checkout` fetches the PR head ref and the work tree is checked
    out **detached onto the exact head SHA**. The original branch/HEAD/dirty list is recorded first
    so nothing is lost.
  - **worktree** (dedicated command, or dirty legacy tree): a `git worktree` is created at a deterministic sibling path
    (or a generated eight-hex suffix when that missing path is still registered), fetched to the
    head ref, and checked out detached there — the main work tree is left byte-for-byte
    untouched. `/rpac pr-cleanup` removes only that worktree after checking its Git registration,
    common repository, administrative ownership record, pinned HEAD, and clean status including
    ignored/untracked files. Symlinked paths, hidden index flags, and unowned/legacy directories
    are refused. Removal uses ordinary `git worktree remove`, never force or filesystem fallback.
    Missing registered directories are not automatically pruned: their index/reflog/ownership and
    locks may still matter. A fresh preview chooses an unused sibling instead. Validation and
    cleanup use the recorded canonical-or-generated path, not a recomputed default; common-repo,
    registration, ownership, HEAD and cleanliness checks still apply.
  - Objects and the merge-base diff are preflighted before checkout. The checkout's actual HEAD
    is asserted equal to the resolved head SHA before the workflow is persisted. Native PR Git
    calls/baselines/status suppress `core.hooksPath` and `core.fsmonitor`; gh receives final Git
    environment overrides too (legacy inline `GIT_CONFIG_PARAMETERS` are not inherited there).
    Installed credential/transport/content-filter helpers remain trusted host tooling. Raw shell
    classification does not isolate arbitrary configured Git plugins or branch-relative drivers.
- **Scope = `base...head`.** `capturePrSnapshot` diffs the pinned base and head commits by object
  (not by work tree), producing the same manifest-item shape as `review.ts` but with `base` and `pr`
  content layers. `base` is read from the unique merge-base, NOT the base tip. Byte-keyed `ls-tree`
  maps and the shared blob reader preserve raw path identities, modes, symlinks, and gitlinks.
  Added/modified/deleted/renamed files are all represented; fork PRs work because the head is
  fetched via the base repository's PR ref. Both commits must exist locally or the start fails cleanly.
- **Untrusted input, report-only outcome.** The PR is someone else's diff. Model source/Git writes
  remain gated in every phase. Screened host setup/check execution requires separate consent
  (below); it is not permission to fix the PR. Native checkout preparation/freshness uses only
  `gh --version`, `gh auth status`, `gh pr view`, `gh pr checkout --detach`, and Git fetch. No `gh pr
  review/merge/close/create`, no `api` mutation, no posting of findings to GitHub. The report is
  advisory.
- **Drift / force-push.** Base and head SHAs are pinned at start. On ACT/resume/consolidate the
  base/head and repository identity are re-resolved via `gh pr view`. Changed refs, retargets,
  freshness failures, and dirty/missing/wrong-HEAD checkouts invalidate all coverage and persist
  drift, even for empty scopes. The reviewed commit is **not** silently switched.
- **Verification execution.** Every PR check includes a canonical shell-quoted `cd -- '<checkout>' && `
  prefix as part of the exact user-approved command. The gate refuses unqualified checks,
  directory-switch suffixes, and PowerShell execution of POSIX checks; it also validates the
  checkout before dispatch. Direct `gh` and known Git-state mutations stay blocked even if
  listed in a plan. Raw shell can inspect; executable PR recipes must use the native host lane.
- **Screened host lane** (`lib/execution.ts`, bounded recipes in `lib/gating.ts`). `plan_complete.reviewExecution`
  supplies exact `setupCommands`, relative untracked `generatedPaths` and `screening`
  (`summary`, inspected `files`, `risks`, `recommendation`). SHA-256 binds inspected file bytes.
  Plan-time validation rejects unsupported recipes, missing npm metadata/lockfiles/scripts and
  explicit assigned-ID blocks that disagree with registered `reviewItemIds` (`lib/review-plan.ts`).
  A `do-not-run` recommendation cannot be approved. `/rpac approve execution` is distinct from
  plan approval, needs `--yes` headlessly, and writes a hashed consent artifact with commands,
  screening, identities and risks. The digest binds the profile version, plan, scope, PR/head,
  commands, inspected hashes and output directories. It is revalidated before every dispatch.
  `rpac review_check` requires this runtime's ACT lease and an in-progress task; only it launches
  the registered code. Setup initially supports constrained `npm ci`. Checks use bounded
  npm/npx/node/pytest/Cargo/Go/make recipes, not arbitrary shell evaluation. Each command has a
  600-second timeout; full output/launcher/environment hints/exit status are saved before a real
  observation is returned. Successful setup is reused. A persisted running result after a crash
  blocks replay. Failure/cancellation/unavailability remain evidence; task completion must include
  actual execution observations and explicitly mark planned but unrun runtime checks unavailable.
- **No sandbox claim.** Worktrees share Git administration. Consented code has the user's host
  access, including credentials, filesystem, services and networking. Screening is an assessment,
  not proof. No Docker is required or provisioned. Setup networking is expected; check execution
  sets offline dependency-manager hints but cannot enforce a network boundary. Explicit generated
  directories tolerate untracked outputs without ignoring tracked changes; cleanup still refuses
  generated/ignored/untracked data rather than deleting it. Host-code side effects are not rolled back.
- **Failure/concurrency.** Objects and the full diff are preflighted before checkout. Safety is
  reassessed after acquiring the control lease; fetch errors cannot reuse stale refs. In-place
  failures restore the original branch/commit only when safe without forcing; otherwise they
  preserve work and print manual recovery details. Cleanup revalidates the active workflow after
  confirmation. Existing ordinary review/approval/lease machinery remains shared.

### 2.3 Concurrency — real exclusion, not advisory

`lib/lock.ts` implements a filesystem lock with the guarantees an advisory lock doesn't have:

- **Atomic create**: `openSync(path, "wx")` — exactly one process can create the lock file;
  contention is detected by `EEXIST`, never by read-then-write.
- **Reference-counted re-entrancy** per process (owner token → depth) so nested
  `updateActive` calls don't deadlock themselves.
- **Stale takeover with a single winner**: a lock whose holder pid is dead (and old enough)
  is moved aside with `renameSync(lock, lock.stale-<token>)`. `rename` of a missing source
  fails with `ENOENT`, so exactly one contender can perform the move and then win the
  `wx` create; losers block on the winner's fresh lock. Dead-pid liveness is checked with a
  signal-0 probe.
- **ACT execution lease** (`.act-lease`): atomically acquired *before* task state changes or an
  ACT directive from `/rpac act` or ACT-phase `/rpac resume`; acquisition failure dispatches
  nothing. It is refreshed on tool activity, released on `agent_end`/`session_shutdown`, and
  bound to the active workflow/task for model task mutations. Replacement, switching, pause,
  abort, and cleanup take a short control lease and therefore refuse while ACT is live. Takeover
  requires a provably dead holder pid, so age alone never displaces a live executor.
  The extension also tracks which runtime acquired ACT: a second runtime in the same process
  cannot borrow the lease for native execution/task mutations/ledger writes or release/interrupt
  the owner's run via its own `agent_end` or `session_shutdown` hook.

Consequences, tested with real child processes: two racers on one lock → exactly one winner;
two racers on one stale lock → exactly one taker; N writers doing load-mutate-save under the
lock → no lost updates.

### 2.4 Machine — workflow kinds, phases, and honest task outcomes

```
idle → refine ─(req approved)→ plan ─(plan approved)→ act ─→ consolidate ─→ done
        ↑ any phase may → aborted; pause/resume is an overlay, not a phase
        act ⇄ (back_to_act: creates a concrete "Repair: <reason>" task)
        consolidate → (back_to_plan: invalidates approval; revised plan archives done evidence)
```

Task statuses: `pending → in_progress → done | failed | blocked | interrupted`.

- `task_done` **requires ≥1 acceptance check** and passes only when every acceptance check is
  `pass`; a failing/unavailable acceptance check leaves the task `failed`. Observation checks
  preserve actual audit outcomes without deciding task success. Optional task `deliverables` are
  hashed, persisted, and included in stale checks/status/handoff. `task_fail` records an explicit
  failure; `task_block`/`task_unblock` manage
  prerequisite blocks (a blocked task cannot be started).
- A model run that ends with a task still `in_progress` (the `agent_end` event) marks it
  `interrupted` — an honest outcome distinct from failure; `interrupted` (and `failed`,
  `in_progress`) tasks can be re-started with `/rpac act <id>`.
- `failed` is a **user decision point**: fix and re-run, or `/rpac accept <id> <reason>`
  records a documented exception (task → `done`, `acceptedException` stored).
- Task graph: `plan_complete` registers `tasks [{title, dependsOn?}]`; validation rejects
  out-of-range references, self-dependencies, and cycles. `task_start` honors dependencies.
- **Sequential mode** (user-approved): only a verified pass permits `task_start` for the next
  ready task within the same lease. One-task mode and fail/blocked/interrupted outcomes reject
  continuation mechanically until the user starts a new `/rpac act` cycle.
- Approvals are **user-only**: UI confirm dialog when `hasUI`, else `/rpac approve <what>`
  (headless). Thin (under-specified) requirements cannot be finalized **or** approved.
- Gates enforced in **both** the command handlers and the `rpac` tool (defense in depth).

Review workflows reuse the same phases, approvals, leases, interruption outcomes, switching,
pause/abort, history, and handoff. Their additional machine invariants are:

- `review_scope` can recapture exact exclusions only in REFINE/PLAN and invalidates a stale plan.
- `plan_complete` receives `reviewItemIds` and `reviewChecks`; every manifest ID must be assigned
  exactly once across tasks. Empty scope is valid, but a real task/validation ledger still exists.
- A done coverage task adds only its assigned IDs to covered state. Accepting a failed review task
  does not manufacture coverage. Every review task requires its deterministic batch artifact as
  the sole hashed deliverable.
- Subject defects are `observation` failures plus a separate passing acceptance check that the
  review evidence itself is complete.
- Review consolidation hashes `review-report.md` as the report artifact and appends it to the final
  task deliverables. `back_to_act` is forbidden; fixes use a new ordinary workflow. Incomplete/drift
  reports may finish honestly, but persisted state remains incomplete.

### 2.5 Planning and review gates (mechanical, fail-closed)

A `tool_call` event handler intercepts model calls **before execution** (`lib/gating.ts`). Ordinary
workflows are gated in REFINE/PLAN; review workflows are gated in every non-terminal phase:

- Built-in `write`/`edit`: allowed **only** for the single phase artifact (`requirements.md`
  in refine, `plan.md` in plan), matched exactly against the resolved workflow path. Custom
  mutation tools (including an unrecognized `apply_patch`) are blocked rather than guessed safe.
- `bash`/`powershell`: fail-closed against conservative read-only command forms. Every segment
  of a pipeline/list must be allowed; redirection and mutation-capable variants such as
  `find -delete/-exec`, `git remote add`, output-file options, interpreters, package managers,
  and network clients are blocked.
- Known inspection tools (`read`, `grep`, `find`, `ls`), session-local `todo`, `codemode`, and the non-mutating
  `ask_user_question` tool pass; nested calls made by `codemode` are gated independently. Any
  other custom tool is blocked. Ordinary ACT/consolidate use normal Pi permissions.
- Review writes are limited by phase to `requirements.md`, `plan.md`, the current
  `review-batch-<id>.md`, or `review-report.md`. This blocks source, sibling-repository, and wrong
  artifact writes throughout review execution.
- Review shell inspection validates literal segments and executable words rather than treating
  quoted search data as commands. Safe `rg`, numeric-range `sed -n`, Git metadata/listing and
  validated `&&`/pipeline compositions work; dangerous options, substitutions, environment
  overrides, redirects and unknown forms fail closed. PR host recipes require the separately
  consented native lane; plan approval cannot override the raw-shell gate.
- The gate reads state lock-less (`peekActive`) so it adds no latency. If RPAC state exists but
  cannot be validated, mutation tools fail closed rather than running without policy.

### 2.6 Context efficiency & session integration

- **Request-local context** (`context`): one RPAC-owned hidden custom message combines installed
  runtime guidance and presentation preference before the latest real user turn, never after tool
  results. It refreshes actual task/lease state before every invocation. Old RPAC style/context
  messages are removed defensively, while other messages retain order. No message is appended to
  durable session history. Paused/terminal/missing workflows inject nothing. Sequential guidance
  requires the previous owned task to have passed and another task to be ready; failures and
  interruptions stop task work rather than inviting unauthorized inspection or ledger writes.
- **Phase directives** (via `sendUserMessage(followUp)`): short, workflow-kind-specific messages
  name the phase, exact artifact, skill, manifest/task IDs where relevant, and tool action.
  Behavioral detail lives in five skills (including `rpac-review`) loaded on demand.
- **Footer + widget** (`ctx.ui.setStatus` / `setWidget`): compact status always when a
  workflow exists; task checklist only during `act`/`consolidate`.
- **`session_start`**: one locked load → report migration/quarantine notes, refresh footer.
  Disk state is the source of truth, so nothing needs session-local persistence.
- **`tool_call` / tool execution**: refresh the ACT lease while held (activity heartbeat).
- **`agent_end`**: release the ACT lease; mark a leftover `in_progress` task
  `interrupted` (honest outcome) and log it.
- **`session_shutdown`**: release the lease, clear UI.
- **Compaction-safe by construction**: everything durable is on disk.
- **`/rpac handoff`**: writes a self-contained `handoff.md` (kind/mode, phase, manifest/coverage
  for reviews, tasks with verification, decisions/deviations, continuation instructions) and — TUI only,
  user-confirmed — starts a fresh session via `ctx.newSession` seeded with it. Non-TUI prints
  the manual fallback (`/rpac resume <id>` in a new session). No autonomous session spawning.

### 2.7 Stale and drift detection

- Requirements/plan sha256 mismatch since approval and registered task-deliverable mismatch or
  deletion → stale warning.
- Git HEAD moved since baseline / baseline-dirty files changed / new uncommitted files →
  divergence warning. `.pi/` paths are excluded (RPAC's own state churn is expected and
  summarized separately).
- Review fingerprint drift at ACT/resume/consolidate/completion → affected IDs lose coverage and
  added/removed/changed IDs remain persisted as uncovered.
- **PR head drift**: a PR force-push (re-resolved head ≠ pinned head) invalidates all coverage and
  is persisted/surfaced; the reviewed commit is never silently switched.
- Drift is **reported, never auto-resolved**; incomplete review completion does not erase it.

### 2.8 Communication is separate from workflow policy

**Two layers.** `styles.ts` and `presentation.ts` affect human explanations only. `schema.ts`,
`machine.ts`, `store.ts`, approvals, artifact hashes, manifest identity, evidence ledgers and
verification results remain authoritative and structurally unchanged. Machine result messages and
logs remain exact; the UI can add a shorter explanation. New requirements/plans/reports use their
existing Context/Summary/Verdict/Outcome openings for an evidence-derived plain-language summary.
No historical artifact is rewritten. No style selection is persisted in a workflow record.

**Preference files and resolution.** Personal `<getAgentDir()>/rpac-style.json` and project-root
`.pi/rpac-style.json` use `{version: 1, style?: identifier, styles?: definitions}`. Project selection
wins over personal selection, then Natural. Bare `/rpac style <id>` writes the project override;
`--global`, `--project` and `--reset-project` are strictly parsed, including duplicate/conflicting
flag refusal. Reset removes only the selection, retaining custom definitions. Commands are available
without an active workflow and do not dispatch a model turn or call a workflow transition.
Completions use the most recent command/session root, initially Pi's process cwd, since Pi's
completion callback supplies only the argument prefix, not an extension context.

Built-ins have six distinct voice instructions and milestone variants. Custom styles affect
model-generated communication only: deterministic milestone notifications use the Natural fallback
in `progressMessage`, and status uses shared plain-language wording. No custom milestone schema,
output templating or notification-rewriting model call is introduced. Custom styles are validated
text records (name, description, instructions, optional examples), merged into the registry without
allowing built-in replacement. Project/global custom collisions warn and retain the global definition.
Global selections cannot depend on project-only definitions. Unknown selections fall back with a
warning. Missing files are normal; malformed/unsupported files fall back and are preserved. A write
refuses malformed target config rather than discarding it. Files use the existing atomic/fsync writer;
configuration is reread, not cached. Writes do not merge simultaneous external edits transactionally.
No new dependencies, services, watchers or model calls are introduced.

Validation bounds: file 64 KiB; 32 styles per file; identifier 48 characters; name 80; description
240; instructions 1,600; examples at most 3 × 240. Exact allowed keys, non-empty text, reserved IDs,
control characters, symlinked files and symlinked write directories are checked. Identifiers never
become file paths. No custom imports, file references, templates or executable configuration exist.

**Supported Pi hooks, not rendered-output rewriting.** A single `context` hook reads actual disk
workflow/lease state and preferences before *each* model invocation, including tool continuations.
This replaces the stale persisted `before_agent_start` task pointer. It supplies one hidden request-local
`rpac-style` custom message only for non-paused, non-terminal workflows. Pi converts it to user-role
content. It never returns `systemPrompt`, changes structured system-prompt sections, uses
`context_with_system`, changes tool declarations or transforms assistant output. Existing messages and
other extensions' messages are preserved; prior RPAC-owned style/phase pointers are removed defensively.
Guidance is explicitly installed runtime policy rather than PR content; it is applied silently, and
its placement does not masquerade as a fresh user request after each tool result.
The message is not appended to session history, so compaction and handoff cannot accumulate stale
style instructions. Disk resumption supplies the current voice. Unreadable state means no style
injection; the existing tool gate continues to fail closed. Preference warnings are deduplicated per
runtime; `/rpac style` always exposes current warnings.

The fixed instruction contract limits the preference to human-facing wording, prioritizes higher
instructions and explicit user requests, preserves exact evidence/schemas/tools, requires failures
and limitations to remain visible, and encourages meaningful milestones rather than chatter. Custom
instructions/examples are JSON-encoded untrusted presentation data with explicit rejection of
operational requests. This cannot guarantee that an arbitrary model resists every textual injection;
it does not grant any new capability or remove mechanical gates. Tests assert policy separation and
actual enforced refusals, not that a model's subjective tone is proven safe or polished.

**Review metadata isolation.** `isReviewMetadataPath` excludes only the dedicated preference file
in addition to existing internal RPAC paths. It is deliberately separate from `isInternalRpacPath`,
which remains the stricter checkout/removal cleanliness predicate. Only in-place evidence checks at
the recorded project root may disregard the preference change; preparation and cleanup do not.
Rename pairs must have both paths allowed, so a source-to-metadata rename is still contamination.
Snapshots also retain a source renamed into preference metadata as a reviewed source deletion;
excluding the destination must not hide shipping-file changes. The new preference-path match uses
exact bytes, not backslash normalization that could hide an unrelated POSIX filename.
The preference file remains untrusted presentation metadata, not reviewed shipping code. Existing
manifests and artifacts are not migrated or rewritten; if a pre-feature manifest explicitly included
this newly reserved metadata path, scope recapture/replanning may be necessary.

**Human-facing surface inventory and treatment:**

| Surface | Presentation / evidence boundary |
|---|---|
| `/rpac`, `status`, `help` | A shared command path selects two independently composed views, not a filtered technical dump. Default: conversational phase/progress, counts of failed/blocked/interrupted work and failed/unavailable checks, accepted exceptions, stale/project-change warnings and supported next steps. Review task completion is explicitly separate from saved item coverage and drift; even a terminal workflow cannot imply a complete assessment. No routine workflow IDs, hashes, internal approval flags or metadata paths. Recovery notices and necessary PR restoration commands are exceptions. `status --details` retains exact task/approval states, checks, full artifact/Git/review identities, uncovered IDs, approved review checks, events, paths and PR restoration/cleanup guidance (also for terminal workflows). Technical uses this view by default. Neither view changes state or re-verifies the snapshot. |
| `start`, `refine`, `plan`, `act`, `consolidate`, `resume` | Plain milestone explanations; six voices where useful. Workflow IDs remain in resume/list and detailed status when needed to select saved work, not every announcement. ACT results/logs remain exact. |
| Review/PR preview | Explicit report-only boundaries, scope counts and checkout strategy; original PR identities and metadata remain saved. |
| Approval dialogs and headless notifications | Explain what requirements/plan approval permits and that users may decline; exact artifact pointer and existing confirmation mechanism retained. Sequential/force/replacement warnings remain explicit. |
| Command/tool errors | Small `humanError` helper adds understandable context/recovery without deleting the original diagnostic. Model tool results also retain `details.diagnostic`; no exception class name is displayed. Unknown cases recommend inspecting status, not a guessed mutating recovery command. |
| Blocked tools / unreadable state | Existing gate decides; presentation may explain the refusal but cannot authorize execution. Exact gate reason remains in the explanation. |
| Pause, abort, accept, cleanup, PR cleanup, handoff | Existing clear messages and warnings retained; cleanup clarifies that source files/preferences were not removed. No extra dialogs. |
| Footer, task widget, list | Compact familiar phase/task indicators and saved-workflow IDs retained; no per-tool progress narration. |
| Model responses / questions / completion summaries | Request-local communication contract, including terminology guidance, meaningful milestones, exact actionable commands and honest review limitations. Finalized output is not rewritten. |
| Phase directives and lazy skills | Operational instructions remain precise, independent of voice; only document-opening summary guidance was clarified. |

## 3. Test strategy

| Area | How |
|---|---|
| schema validation / v1-v2 migration to v3 / workflow-kind and review-shape validation / task graphs | unit (`node --test` on `.ts`) |
| phase transitions, outcome guards (done/failed/blocked/interrupted), accept, repair tasks, sequential stop | unit against `machine.ts` |
| per-workflow store: create/switch/list, bounded log, index rebuild, v1 migration, quarantine | unit in temp dirs |
| lock: contention, re-entrancy, stale takeover, lease | unit **with spawned child processes** racing (exactly-one-winner assertions) |
| planning/review gates: exact artifacts, sibling/source blocking, approved-check equality, destructive override, unknown tools | unit against `gating.ts` |
| ordinary baseline/divergence incl. `.pi/` exclusion | unit in temp git repos |
| review snapshots | temp Git fixtures: current/staged/full, empty/unborn, index/worktree layering, deletion/rename/mode, odd bytes, binary/large, symlink, gitlink, conflict, exclusion, deterministic drift |
| PR review (`lib/pr.ts`) | temp origin+clone fixtures exposing `refs/pull/N/head`: metadata normalization, `parseNameStatus`, `base...head` snapshot layers, exclusions, in-place vs. worktree checkout (dirty tree preserved), `pr-cleanup`, `verifyGitObjects`, SHA validation, deterministic drift |
| PR review (e2e) | mock `gh` on PATH (no network/GitHub): command parsing, invalid numbers, missing/unauthenticated gh, non-git/missing remote, fork PRs, dirty-tree worktree + main-tree preservation, existing-workflow safeguards, force-push drift invalidation, resume after restart, report-only gate, and an assertion that no mutating `gh` command is ever attempted |
| communication configuration | unit: six voices, strict parser/completions, custom registry, global/project precedence/reset, fresh reads, malformed recovery, bounds, links, declarative-only schema and adversarial instruction contract |
| conversational status | real extension handlers: bare/status consistency, Natural active/incomplete work, failed/blocked/interrupted tasks, paused/done/aborted states, exceptions and unavailable/observation checks, incomplete/drifting/terminal reviews, PR restoration/cleanup, stale evidence, full details/Technical, no-active recovery and documented custom fallback |
| communication lifecycle | mock-Pi: immediate switching, unchanged workflow/artifact bytes, fresh runtime/session/handoff, empty post-compaction context, active phases vs paused/done/aborted/unreadable state, deduplicated warnings, approvals and failed verification remain enforced |
| communication in installed Pi | real RPC provider requests: commands select all six built-ins; one user-level preference per active invocation/tool continuation, immediate Technical → Chill switching, system prompt retained, no stale history and no style after terminal completion |
| review preference isolation | current/staged/full snapshots unchanged by metadata edits; in-place PR lifecycle switching does not invalidate approval/evidence; strict cleanup predicates and source rename refusal retained |
| command + tool interface | mock-Pi e2e: ordinary regressions plus review parsing/modes/empty scope, exclusions, approvals, exact assignment, interruption/resume, report-only gates, drift invalidation/incomplete report, conflict rejection, status/list, replacement safeguards |
| package resources | frontmatter/action/artifact checks, exact embedded upstream license, both source links, and no product-specific assumptions; no sibling checkout dependency |
| **real Pi binary** | RPC loads a copied package outside the checkout, dispatches the bundled skill and `/rpac review`, drives an ordinary full workflow, and verifies HEAD/index/reviewed content remain unchanged. Skipped only without `pi`/git. |
| installed-Pi smoke | copies the package, uses `-ne -e <copy>`, dispatches ordinary start + current review, finds skill/license, and verifies HEAD/index/content invariants |

No test is reported passing unless executed and green.
