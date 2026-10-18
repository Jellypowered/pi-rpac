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
- `pi.on("before_agent_start", ...)` returning `{message: {customType, content, display:
  false}}` — tiny per-turn phase context (see §2.6).
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
│   ├── git.ts            # ordinary baseline/divergence detection (excludes .pi/)
│   ├── review.ts         # byte-safe Git snapshots, manifests, fingerprints, drift (pure)
│   ├── pr.ts             # GitHub PR review: gh resolution, safe checkout, base...head scope (pure)
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

### 2.1 State — v3 per-workflow layout (project root = git root, else cwd)

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
manifest layer. `.git` and `.pi/rpac/**` are unconditional exclusions.

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

`/rpac start preview <pr-number>` reviews a GitHub PR rather than the local work tree. It reuses
the exact review lifecycle (phases, approvals, leases, report-only gates, manifest/coverage,
drift, evidence batches, `review-report.md`) with PR-specific prompts and a distinct scope source.
`lib/pr.ts` is pure and drives `gh` through an injectable `GhRunner` interface so tests run against
a mock CLI (no network, no real GitHub).

- **Metadata resolution** (`gh pr view --json ...`): number, URL, title, body, state, base/head
  refs + SHAs, head-repository owner, and the cross-repository (fork) flag. A missing/unreadable PR,
  non-integer number, or invalid SHA is a clean error before any state is written.
- **Safe checkout.** The PR head must be reviewable locally. `assessPrCheckout` inspects the work
  tree:
  - **in-place** (clean tree): `gh pr checkout` fetches the PR head ref and the work tree is checked
    out **detached onto the exact head SHA**. The original branch/HEAD/dirty list is recorded first
    so nothing is lost.
  - **worktree** (dirty tree): a `git worktree` is created at a deterministic sibling path, fetched
    to the head ref, and checked out detached there — the main work tree is left byte-for-byte
    untouched. `/rpac pr-cleanup` removes only that worktree.
  - After either path the head object is verified present locally (`git cat-file`), and the
    checkout's actual HEAD is asserted equal to the resolved head SHA before the snapshot runs.
- **Scope = `base...head`.** `capturePrSnapshot` diffs the pinned base and head commits by object
  (not by work tree), producing the same manifest-item shape as `review.ts` but with `base` and `pr`
  content layers. Added/modified/deleted/renamed files are all represented; fork PRs work because
  the head is fetched by object. Both commits must exist locally or the start fails cleanly.
- **Untrusted input, report-only.** The PR is someone else's diff. Execution stays mechanically
  report-only in every phase (the all-phase review gate), and `gh` is used **read-only**: only
  `--version`, `auth status`, `pr view`, and `pr checkout`/fetch are ever invoked. No `gh pr
  review/merge/close/create`, no `api` mutation, no posting of findings to GitHub. The report is
  advisory.
- **Drift / force-push.** Base and head SHAs are pinned at start. On ACT/resume/consolidate the
  head is re-resolved via `gh pr view`; if it differs from the pinned head, the PR was force-pushed:
  all coverage is invalidated, the mismatch is persisted as drift and surfaced, and the reviewed
  commit is **not** silently switched. Reviewing a new head requires aborting and starting fresh.

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
- Known inspection tools (`read`, `grep`, `find`, `ls`), `codemode`, and the non-mutating
  `ask_user_question` tool pass; nested calls made by `codemode` are gated independently. Any
  other custom tool is blocked. Ordinary ACT/consolidate use normal Pi permissions.
- Review writes are limited by phase to `requirements.md`, `plan.md`, the current
  `review-batch-<id>.md`, or `review-report.md`. This blocks source, sibling-repository, and wrong
  artifact writes throughout review execution.
- Review shell use is read-only inspection plus exact command strings stored as `approvedChecks`
  with the user-approved plan. A destructive denylist still wins over approval; package installs,
  Git/remote mutations, output redirection, and unknown commands fail closed.
- The gate reads state lock-less (`peekActive`) so it adds no latency. If RPAC state exists but
  cannot be validated, mutation tools fail closed rather than running without policy.

### 2.6 Context efficiency & session integration

- **Per-turn context** (`before_agent_start`): a 3–4 line `[RPAC] phase=…` block with the
  exact artifact paths, current task, and the tool action to call. It is omitted entirely
  when there is no workflow, the workflow is terminal, or it is paused — idle turns cost
  nothing.
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
| command + tool interface | mock-Pi e2e: ordinary regressions plus review parsing/modes/empty scope, exclusions, approvals, exact assignment, interruption/resume, report-only gates, drift invalidation/incomplete report, conflict rejection, status/list, replacement safeguards |
| package resources | frontmatter/action/artifact checks, exact embedded upstream license, both source links, and no product-specific assumptions; no sibling checkout dependency |
| **real Pi binary** | RPC loads a copied package outside the checkout, dispatches the bundled skill and `/rpac review`, drives an ordinary full workflow, and verifies HEAD/index/reviewed content remain unchanged. Skipped only without `pi`/git. |
| installed-Pi smoke | copies the package, uses `-ne -e <copy>`, dispatches ordinary start + current review, finds skill/license, and verifies HEAD/index/content invariants |

No test is reported passing unless executed and green.
