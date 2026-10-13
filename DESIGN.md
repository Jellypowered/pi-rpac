# RPAC for Pi — Design

**RPAC = Refine → Plan → Act → Consolidate.** A native Pi extension that turns a task into
approved requirements, an approved plan, incrementally executed and verified tasks, and a
honest completion report — with durable, human-readable, **per-workflow** project state, real
concurrency control, and mechanically enforced read-only refine/plan phases.

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

**Not ported:** tracker/ticket fetching, PR-sized groups, vendor session-launch commands,
hardening as a separate fresh-agent run (folded into `/rpac handoff` + consolidate), separate
DECISIONS file (folded into the per-workflow `log.md`).

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
  REFINE/PLAN read-only gate mechanical (see §2.4).
- `pi.on("before_agent_start", ...)` returning `{message: {customType, content, display:
  false}}` — tiny per-turn phase context (see §2.5).
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
│   ├── schema.ts         # v2 state/index types, validation, task-graph checks (pure)
│   ├── machine.ts        # phase transitions + outcome guards (pure)
│   ├── store.ts          # .pi/rpac IO: index, per-workflow dirs, v1 migration, quarantine
│   ├── lock.ts           # atomic wx lock + ACT lease, stale takeover, pid liveness (pure)
│   ├── gating.ts         # REFINE/PLAN read-only gate: allowlists, fail-closed bash (pure)
│   ├── git.ts            # baseline capture + divergence detection (excludes .pi/)
│   ├── prompts.ts        # phase directives + tiny per-turn phase context
│   ├── paths.ts          # v2 layout resolution, workflow-id validation
│   └── util.ts           # sha256, atomicWriteFile (fsync file+dir), nowIso (pure)
├── skills/               # model-facing behavioral detail, lazily loaded
│   ├── rpac-refine/SKILL.md
│   ├── rpac-plan/SKILL.md
│   ├── rpac-act/SKILL.md
│   └── rpac-consolidate/SKILL.md
└── test/                 # node:test: unit + mock-API e2e + real-Pi RPC e2e; smoke/
```

**Layering:** `lib/` is pure TypeScript (node builtins only) → unit-testable with plain node.
`extensions/rpac.ts` is the only file that touches Pi APIs.

### 2.1 State — v2 per-workflow layout (project root = git root, else cwd)

```
<repo>/.pi/rpac/
├── state.json        # index (versioned): { version: 2, active: id|null, workflows: {id: summary} }
├── <workflow-id>/    # one directory per workflow (w-xxxxxxxx), kept forever
│   ├── workflow.json #   machine state (versioned, human-readable)
│   ├── requirements.md
│   ├── plan.md
│   ├── log.md        #   append-only, bounded (trim at 600 → keep 500)
│   ├── report.md
│   └── handoff.md
├── quarantine/       # corrupt files, preserved + surfaced as notes
├── .lock             # state write lock: {token, pid, createdAt, refreshedAt?, ...}
└── .act-lease        # ACT execution lease: {token, pid, createdAt, workflowId, taskId}
```

Machine state (`workflow.json`) carries: id, task, phase, `approvals {requirements, plan,
sequential}`, current `tasks [{id, title, dependsOn?, status, verification?, deliverables?,
issues?, acceptedException?}]`, bounded `taskHistory` for completed evidence from superseded plans,
artifact refs + sha256, git baseline, checkpoints, bounded event log (last 50), and `paused`.

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
- **Version-1 migration**: a legacy shared layout (`.pi/rpac/workflow.json` + shared
  artifacts) is migrated on first locked load — artifacts move into the workflow directory,
  legacy archives are recovered, the move is recorded in the workflow log and index notes.
- State is scoped per project root (no cross-repo leakage). RPAC's own `.pi/rpac/` churn is
  excluded from git-divergence reports.

### 2.2 Concurrency — real exclusion, not advisory

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

### 2.3 Machine — phases and honest task outcomes

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

### 2.4 REFINE/PLAN read-only gate (mechanical, fail-closed)

While the active phase is `refine` or `plan`, a `tool_call` event handler intercepts model
tool calls **before execution** (`lib/gating.ts`):

- Built-in `write`/`edit`: allowed **only** for the single phase artifact (`requirements.md`
  in refine, `plan.md` in plan), matched exactly against the resolved workflow path. Custom
  mutation tools (including an unrecognized `apply_patch`) are blocked rather than guessed safe.
- `bash`/`powershell`: fail-closed against conservative read-only command forms. Every segment
  of a pipeline/list must be allowed; redirection and mutation-capable variants such as
  `find -delete/-exec`, `git remote add`, output-file options, interpreters, package managers,
  and network clients are blocked.
- Known inspection tools (`read`, `grep`, `find`, `ls`), `codemode`, and the non-mutating
  `ask_user_question` tool pass; nested tool calls made by `codemode` are gated independently.
  Any other custom tool is blocked. ACT and
  consolidate run under normal Pi permissions.
- The gate reads state lock-less (`peekActive`) so it adds no latency and never takes tool
  execution down with it (errors are swallowed; blocking decisions are the only output).

### 2.5 Context efficiency & session integration

- **Per-turn context** (`before_agent_start`): a 3–4 line `[RPAC] phase=…` block with the
  exact artifact paths, current task, and the tool action to call. It is omitted entirely
  when there is no workflow, the workflow is terminal, or it is paused — idle turns cost
  nothing.
- **Phase directives** (via `sendUserMessage(followUp)`): short (≤ ~10 lines), name the
  phase, task, absolute artifact path, skill to read, and the tool action. Behavioral detail
  lives in the four skills (loaded on demand) — per-turn token cost stays near zero.
- **Footer + widget** (`ctx.ui.setStatus` / `setWidget`): compact status always when a
  workflow exists; task checklist only during `act`/`consolidate`.
- **`session_start`**: one locked load → report migration/quarantine notes, refresh footer.
  Disk state is the source of truth, so nothing needs session-local persistence.
- **`tool_call` / tool execution**: refresh the ACT lease while held (activity heartbeat).
- **`agent_end`**: release the ACT lease; mark a leftover `in_progress` task
  `interrupted` (honest outcome) and log it.
- **`session_shutdown`**: release the lease, clear UI.
- **Compaction-safe by construction**: everything durable is on disk.
- **`/rpac handoff`**: writes a self-contained `handoff.md` (task, phase, tasks with
  verification, decisions/deviations, continuation instructions) and — TUI only,
  user-confirmed — starts a fresh session via `ctx.newSession` seeded with it. Non-TUI prints
  the manual fallback (`/rpac resume <id>` in a new session). No autonomous session spawning.

### 2.6 Stale detection (`/rpac status`, `/rpac resume`, on `act`)

- Requirements/plan sha256 mismatch since approval and registered task-deliverable mismatch or
  deletion → stale warning.
- Git HEAD moved since baseline / baseline-dirty files changed / new uncommitted files →
  divergence warning. `.pi/` paths are excluded (RPAC's own state churn is expected and
  summarized separately).
- Drift is **reported, never auto-resolved**.

## 3. Test strategy

| Area | How |
|---|---|
| schema validation / v1 acceptance + migration target shape / index validation / task-graph checks | unit (`node --test` on `.ts`) |
| phase transitions, outcome guards (done/failed/blocked/interrupted), accept, repair tasks, sequential stop | unit against `machine.ts` |
| per-workflow store: create/switch/list, bounded log, index rebuild, v1 migration, quarantine | unit in temp dirs |
| lock: contention, re-entrancy, stale takeover, lease | unit **with spawned child processes** racing (exactly-one-winner assertions) |
| REFINE/PLAN gate: artifact allowlist, fail-closed bash, phase disengagement | unit against `gating.ts` |
| baseline / divergence incl. `.pi/` exclusion | unit in temp git repos |
| command + tool interface | e2e: load the real `extensions/rpac.ts` factory against a mock `ExtensionAPI`, drive the full interface — two-task non-sequential ACT, failed/unavailable/blocked/interrupted outcomes, sequential stop, headless refusals (`--yes`/`--force`), repair flow, stale notes, handoff (TUI + non-TUI), reload/resume, second-workflow preservation, project isolation + subdir root, corrupt quarantine, v1 migration |
| **real Pi binary** | e2e RPC: `pi --mode rpc --no-session --extension …` against a stateful mock OpenAI-compatible model; one complete workflow (refine→plan→act→consolidate→done) with real `write`/`bash` tool calls, real confirm dialogs, real on-disk state, lease release, and a no-commits assertion. Skipped without `pi`/git. |
| extension loading in installed Pi | smoke script: `pi -e ./extensions/rpac.ts --print "/rpac start …"` in an isolated temp repo, asserting the v2 layout |

No test is reported passing unless executed and green.
