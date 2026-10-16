---
name: rpac-review
description: Run a manifest-backed, report-only RPAC review of current, staged, or full Git scope with complete coverage and adversarial finding validation.
disable-model-invocation: true
license: MIT
metadata:
  version: "1.0"
  adapted-from-self-review-version: "0.14"
  adapted-from-fresh-eyes-review-version: "1.3"
---

# RPAC review

This bundled skill adapts Engineering in the age of AI's MIT-licensed
[self-review](https://github.com/eai-org/agent-toolkit/blob/main/skills/self-review/SKILL.md) and
[fresh-eyes-review](https://github.com/eai-org/agent-toolkit/blob/main/skills/fresh-eyes-review/SKILL.md).
The upstream copyright and license are preserved in [LICENSE](LICENSE). It is self-contained: no upstream or global
review skill is needed at runtime.

Use this skill only inside a workflow started by `/rpac review [current|staged|full]`. The extension owns scope capture,
fingerprints, approvals, coverage state, drift checks, and write gates. The review is **report-only**: never edit reviewed
files, related repositories, Git/index/remote state, or package/tool installations. Write only the exact RPAC artifact
named by the active directive. Proposed fixes become a separate ordinary `/rpac start <task>` workflow.

## 1. REFINE — ground the review

Read the persisted `review-manifest.json` first. Treat item IDs and `pathBase64` as authoritative; `path` is display-only.
State the selected mode exactly:

- `current` — the union of staged, unstaged, and non-ignored untracked content. Index and worktree are distinct layers;
  staged edits canceled on disk still count.
- `staged` — exact index content against HEAD (or the empty tree when unborn). Never substitute working-tree bytes or
  treat disk-only context as staged evidence.
- `full` — all tracked paths as currently present plus non-ignored untracked paths, with tracked missing paths recorded
  as deletions. This is repository health, not a branch comparison.

An empty scope is a valid auditable no-op; never broaden it automatically. Do not follow symlinks outside the repository
or recursively audit gitlinks/submodules. For binary, large, unavailable, conflicted, or unusually encoded paths, record
the inspection method and any missing coverage rather than guessing. Conflicts are not resolved or certified silently.

Discover applicable repository policy before choosing review dimensions. Inspect local files such as `AGENTS.md`,
`CONTRIBUTING*`, README/build/test docs, language manifests, CI configuration, ownership/security guidance, and policy
files that actually exist. Label outside-snapshot policy or dependency material as **context**, not reviewed content.
Determine intent from the user's request and local evidence; label absent ticket/PR metadata **unavailable** and do not
fetch it. Record the source and a SHA-256 hash of any supplied submission metadata so later claims remain bound to it.
For a full review, repository correctness, safety, and documented-policy compliance are sufficient intent.

Select only dimensions supported by repository evidence and the scoped content. Possibilities include correctness and
invariants; lifecycle/error handling; security/trust boundaries; concurrency/ownership/lifetime; performance/resource
bounds; compatibility/API/configuration; optional feature paths; tests/docs/licenses; and mirrored/counterpart paths.
This is not a generic checklist: omit irrelevant dimensions and explain briefly why selected ones apply.
For current/full conflicts, ask the user whether to stop, report the conflicted content as incomplete, or explicitly
redefine scope; never choose a resolution. Exact staged reviews with conflicts are rejected before REFINE.

Record exact intentional exclusions as `{path, reason}`. Intended-to-ship files are not scratch by default; never silently
exclude an ambiguous path. Call `rpac` action `review_scope` with the complete exclusion list, even when empty, so the
manifest is recaptured and persisted. Name only repository-documented, non-destructive checks. Do not run them yet.
Write the review requirements artifact with intent, mode semantics, policy sources, selected dimensions, exclusions,
allowed checks, unavailable context, and completion criteria. Then call `refine_complete`; only the user approves it.

## 2. PLAN — make coverage executable

Re-read the approved requirements and current manifest; do not trust memory. Build small, coherent batches that a local
model can finish without losing evidence. Group by subsystem/call path or policy concern, not arbitrary sampling. Every
manifest item ID must be assigned exactly once across review batches. Keep related implementation, tests, configuration,
documentation, and mirrored/optional counterparts together when practical. Large files may form their own batch.

After coverage batches, add a separate dependent task for adversarial validation and coverage finalization. It normally
has no item IDs. Its job is to challenge every candidate finding, remove unsupported claims, reconcile cross-batch
counterparts, and verify the ledger—not to sample the scope again.

For each task, state assigned IDs, relevant context/call paths, evidence expected, done-when condition, and dependencies.
List exact safe project checks disclosed during REFINE. Write only `plan.md`, then call:

```text
rpac(action="plan_complete",
     tasks=[{title, dependsOn?, reviewItemIds?}, ...],
     reviewChecks=["exact command", ...])
```

Use `reviewItemIds` only for manifest-backed coverage tasks. Do not alter commands after approval; a different command
requires replanning and user approval.

## 3. ACT — inspect one bounded batch

The directive's task is already in progress. Read `workflow.json`, the manifest, requirements, plan, prior batch evidence,
and only the context needed for this batch. On resume, verify existing evidence before continuing. Never call
`task_start` for the task already named by the directive.

Inspect every assigned item completely—no sampling or extrapolation. Respect layers:

- For `staged`, use index blobs/modes (for example, safe argument-array equivalents of `git show :path`) and HEAD history
  for deletions. Disk bytes are context only.
- For `current`, compare and label HEAD/index/worktree evidence separately when they differ; inspect untracked bytes.
- For `full`, inspect each present worktree item and record tracked deletions, links, gitlinks, binary/large handling.

Follow relevant call paths and validate counterparts far enough to establish concrete impact, but do not claim those
context files were fully reviewed unless they are assigned manifest items. Existing patterns are clues, not proof.

Maintain the named `review-batch-<id>.md` as a durable evidence ledger. For each assigned ID record:

- path/layer and what was inspected;
- applicable policy/invariant and relevant call paths/counterparts;
- evidence with labels: **fact**, **inference**, **user claim**, or **unavailable**;
- checks run with exact command, version when relevant, exit status, and actual result;
- candidate finding IDs, or an explicit evidence-based “no candidate” result;
- uncovered content or uncertainty.

Run only read-only inspection commands or exact checks approved with the plan. Checks may generate caches/output; do not
hide that—scope drift will expose shipping-file changes. Never configure, install, fetch, build, or contact a remote
unless the exact non-destructive command was approved and permitted by the gate. A failed subject check is evidence, not
proof that the review task failed.

A candidate finding must contain:

1. stable finding ID, location and exact snapshot layer;
2. violated invariant or documented rule;
3. concrete failure scenario and impact;
4. severity and confidence;
5. evidence, with fact/inference boundaries and unavailable dependencies;
6. minimal fix direction (not an implementation).

Reject taste, praise, vague risk, unsupported speculation, broad redesign, and duplicate symptoms. Zero findings is
valid. If isolation/fresh subagents are unavailable, perform the pass in this session and record exactly:
`same-context review; weaker independence`. Never invent reviewer/model provenance.

Finish only when all assigned IDs have ledger evidence. Call `task_done` with the batch artifact as the sole deliverable,
a passing acceptance check that batch coverage/evidence is complete, and subject failures as `kind: "observation"`.
Missing evidence is an acceptance failure. In sequential mode, call `task_start` only after `task_done` succeeds.

## 4. Adversarial validation task

Re-open the exact evidence for every candidate. Try to disprove it using repository policy, guards, callers, tests,
configuration, platform behavior, and relevant counterpart paths. Confirm location/layer, invariant, reachability,
impact, severity, confidence, and minimal fix direction. Merge duplicates and mark rejected candidates with the concrete
reason; do not silently delete them. Distinguish “not reproduced” from “disproved.”

Audit the ledger mechanically: every planned manifest ID appears once, every batch artifact exists, exclusions are
recorded, checks have actual outcomes, and drift/unavailable material is explicit. Fresh-context validation is preferred
when available. Otherwise repeat the same-context caveat; a second pass is still required.

Write only this task's batch artifact. Complete it with a passing acceptance check only when candidate validation and the
coverage audit are recorded. Findings remain observations; this workflow does not fix or disposition them.

## 5. CONSOLIDATE — report honestly

Read state, manifest, requirements, plan, all batch artifacts, and the audit log. The extension rechecks the selected
snapshot before dispatch and again at completion. Reconcile its persisted coverage/drift state; never erase or reinterpret
it. Changed, removed, or added items remain uncovered unless the review was explicitly replanned and executed.

Write only `review-report.md` using this compact structure:

```markdown
# Review report

## Outcome
Reviewed mode/snapshot/fingerprint; finding counts by severity; **scrutiny, not approval**.

## Scope and coverage
HEAD or unborn; index/worktree label; fingerprint; included/covered/uncovered counts; exact exclusions; metadata hash/availability; drift.

## Findings
- F-… — severity/confidence — `path:location` [layer]
  Invariant/rule; concrete impact; evidence; minimal fix direction.

## Verification
Exact checks and actual pass/fail/unavailable outcomes; what snapshot each covered.

## Limitations
Actual harness/model identity (or unknown); same-context caveat; unavailable context/tools; unreadable content; conflicts; failed checks; drift; uncovered IDs.

## Follow-up
Fixes require a separate ordinary RPAC workflow; no fixes were applied here.
```

A failed/unavailable required check, same-context execution, conflict, missing dependency, drift, or incomplete coverage
must be prominent. Never call the result clean, defect-free, secure, compatible, approved, certified, or merge-ready
when any such limitation exists. Even a complete zero-finding review is bounded evidence, not proof of absence.

Call `consolidate_complete` only after the report matches persisted evidence. `back_to_act` is forbidden because reviews
are report-only. Use `back_to_plan` only when the review process/coverage itself must be replanned, never to create a fix.
End with the report path, finding counts, uncovered/drift status, check outcomes, and the separate-workflow follow-up.

## Completion checklist

Before claiming the review workflow complete, verify all are true or explicitly reported incomplete:

- selected mode, HEAD/unborn state, fingerprint, index/worktree distinction, and exclusions are stated;
- every manifest ID is covered exactly once or listed as uncovered with a reason;
- every batch has a persisted evidence ledger and hashed deliverable;
- every candidate received adversarial validation; rejected candidates retain reasons;
- applicable call paths and counterpart/optional paths were checked without inflating scope claims;
- exact approved checks have honest outcomes and snapshot labels;
- drift, conflicts, binary/large/unreadable content, unavailable context, and same-context limits are visible;
- findings contain location, rule/invariant, impact, severity, confidence, evidence, and minimal fix direction;
- no reviewed file, Git/index/remote state, related repository, or tool installation was modified;
- the report says scrutiny is not approval and directs fixes to a separate ordinary RPAC workflow.
