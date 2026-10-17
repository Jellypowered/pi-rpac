# RPAC Historical Workflow Audit

## Executive summary

This audit examined every RPAC workflow found below `/stuff/Source` and correlated the persisted workflow evidence with the matching Pi session logs. Six workflows were found: five completed and one was explicitly aborted after requirements approval. The completed workflows finished 25 tasks, including one consolidation-created repair task. No historical workflow directory was modified.

The principal finding is usability, not a fail-open security defect. Historical gate denials were safe: no denied mutation was allowed, and no evidence showed a bypass of the exact-artifact or report-only boundaries. However, older gates rejected many legitimate inspections and returned generic advice that did not identify the rejected segment. The current implementation already accepts 25 of the 48 historical denials (23 shell calls plus two question-tool calls). A small remaining set supports three low-risk changes: quote-aware output-redirection detection, exact allowance of three read-only command forms (`git check-ignore`, `git stash list`, and `node -v`), and actionable rejection diagnostics. Unknown interpreters, `rg`, general `sed`/`awk`, substitutions, arbitrary redirection, and non-exact approved checks remain fail-closed.

At initial report creation, implementation and regression verification were pending. They are now complete; the final section records the resulting changes and checks.

## Scope and method

### Filesystem scope

Seven RPAC roots exist:

- `/stuff/Source/.pi/rpac`
- `/stuff/Source/azerothcore-wotlk/.pi/rpac`
- `/stuff/Source/azerothcore-wotlk/modules/mod-playerbots/.pi/rpac`
- `/stuff/Source/azerothcore-wotlk/modules/mod-random-enchants/.pi/rpac`
- `/stuff/Source/azerothcore-wotlk/modules/mod-wowmin-telemetry/.pi/rpac`
- `/stuff/Source/pi-rpac/.pi/rpac`
- `/stuff/Source/wowmin/.pi/rpac`

Only six `w-*` workflow directories were present. Empty/administrative roots were not counted as workflows. Three files under `/stuff/Source/azerothcore-wotlk/modules/mod-playerbots/.pi/rpac/quarantine/` are quarantined index snapshots, not workflow directories; they were inspected only to classify them and were not treated as runs. No duplicate workflow ID or symlinked workflow path was found.

### Evidence used

For each workflow, the audit read `workflow.json`, `log.md`, requirements, plan, task/review artifacts, and completion report where present. Matching Pi JSONL sessions under `/root/.pi/agent/sessions/` supplied tool calls and actual gate responses. Aggregate denial counts below count a blocked tool invocation once. Shell pattern groups are disjoint and use the dominant reason for each invocation, even when a compound command contained more than one unsupported segment.

Historical behavior is kept distinct from current behavior. Commands were compared with the current `lib/gating.ts`; the old denial itself is not assumed to describe today's gate.

Limitations:

- Session logs are execution telemetry, not immutable RPAC workflow artifacts. They were used to explain denials but were not changed.
- User pauses cannot be distinguished reliably from interface friction merely from elapsed timestamps.
- This is an audit of the six retained workflows, not a claim about deleted runs or activity outside the retained session logs.
- Successful task verification is evidence reported by the historical runs; this audit did not recreate every external project environment.

## Workflow inventory and outcomes

| Workflow | Persisted path | Kind / scope | Outcome | Tasks | Notable evidence |
|---|---|---:|---:|---:|---|
| `w-9f4154fd` | `/stuff/Source/azerothcore-wotlk/modules/mod-playerbots/.pi/rpac/w-9f4154fd/` | implementation | done | 4/4 | Performance investigation completed with one documented plan deviation; see `log.md` and `report.md`. |
| `w-89a431eb` | `/stuff/Source/azerothcore-wotlk/modules/mod-wowmin-telemetry/.pi/rpac/w-89a431eb/` | legacy implementation used report-only | done | 5/5 | Review findings persisted in `findings.md`, `review-report.md`, and `report.md`; source remained unchanged. |
| `w-b0f059a7` | `/stuff/Source/pi-rpac/.pi/rpac/w-b0f059a7/` | implementation | done | 6/6 | Five planned tasks plus consolidation repair task 6; see `log.md` and `report.md`. |
| `w-b7664473` | `/stuff/Source/wowmin/.pi/rpac/w-b7664473/` | legacy implementation used report-only | done | 6/6 | Full PR audit, 190 tests reported passing, no tracked source modification; see `notes/`, `log.md`, and `report.md`. |
| `w-9ccce2bf` | `/stuff/Source/wowmin/.pi/rpac/w-9ccce2bf/` | review, current mode, four manifest items | done | 4/4 | Exact manifest coverage, four batch artifacts, report-only gate, and explicit unavailable/failed observations; see `review-manifest.json`, `review-batch-*.md`, `review-report.md`, and `log.md`. |
| `w-30f11c44` | `/stuff/Source/wowmin/.pi/rpac/w-30f11c44/` | review, current mode, empty scope | aborted | 0/0 | Valid zero-item manifest, requirements approved, then explicit user abort; see `review-manifest.json`, `requirements.md`, and `log.md`. |

Aggregate outcomes:

- 6 retained workflows: 5 done, 1 explicitly aborted, 0 persisted as failed.
- 25 completed tasks across completed workflows; 1 was a repair task created from consolidation.
- 2 older report-only audits used implementation workflows before dedicated review workflows existed.
- 2 dedicated review workflows later exercised exact manifests and report-only gating.

## Command-denial analysis

### Totals

The session evidence contains 48 RPAC gate denials across all six workflows:

| Workflow | REFINE | PLAN | ACT | Total |
|---|---:|---:|---:|---:|
| `w-9f4154fd` | 6 | 1 | 0 | 7 |
| `w-89a431eb` | 15 | 0 | 0 | 15 |
| `w-b0f059a7` | 0 | 2 | 0 | 2 |
| `w-b7664473` | 10 | 0 | 0 | 10 |
| `w-9ccce2bf` | 1 | 1 | 10 | 12 |
| `w-30f11c44` | 2 | 0 | 0 | 2 |
| **Total** | **34** | **4** | **10** | **48** |

By tool: 43 shell calls, 2 question-tool calls, 2 edits of earlier review batches, and 1 premature review-report write.

The current implementation accepts 25 of the 48 historical calls:

- 23 shell inspections rejected by older gates are now accepted because compound read-only segments, `git -C`, benign pipelines, and safe `/dev/null` suppression are parsed segment-by-segment.
- Both historical `ask_user_question` calls are now accepted as a known read-only tool.

The remaining 23 calls stay blocked by the current implementation before this audit's changes: 20 shell calls plus the two prior-batch edits and one premature report write.

### Unique blocked-command patterns

The 43 shell denials reduce to 11 disjoint pattern groups:

| Pattern | Count | Workflows | Current pre-audit behavior | Assessment |
|---|---:|---|---|---|
| Legacy gate rejected otherwise allowed compound/git/grep/find/ls inspection | 23 | `w-89a431eb` (14), `w-b7664473` (9) | Allowed | Already corrected. Examples and retries are visible in each workflow's `log.md` and matching session. |
| `rg` inspection | 5 | `w-9f4154fd` (3), `w-b0f059a7` (2) | Blocked | Retain fail-closed: a general `rg` allowance must account for `--pre` and configuration-driven executors. Use `grep`/`find`/`read`. |
| Numeric `sed -n` reads | 4 | `w-9f4154fd` (2), `w-9ccce2bf` (1), `w-30f11c44` (1) | Blocked | Retain fail-closed for general `sed`: scripts support writes and command execution. The direct `read` tool is safer. |
| Embedded Python or shell loop for JSON inspection | 2 | `w-9f4154fd`, `w-9ccce2bf` | Blocked | Correct denial; arbitrary interpreters cannot be proven read-only from command name. |
| `awk` inspection | 1 | `w-9f4154fd` | Blocked | Correct denial; `awk` can execute commands and write files. |
| `git check-ignore` inspection | 1 | `w-9ccce2bf` | Blocked | Low-risk false negative; exact read-only subcommand can be allowed. |
| Quoted grep patterns containing `>>`/`&` | 2 | `w-9ccce2bf` | Blocked | False positives: quoted pattern text was mistaken for output redirection. Fix quote-aware redirection detection. |
| Approved check changed by `cd` prefix or output pipeline | 2 | `w-9ccce2bf` | Blocked | Correct denial. Review checks are approved by exact command text; wrappers and pipelines change semantics. |
| `node -v` | 1 | `w-9ccce2bf` | Blocked (`node --version` allowed) | Safe alias omission; allow exact version form. |
| Redirecting a Git blob to `/tmp` | 1 | `w-9ccce2bf` | Blocked | Correct denial. Arbitrary output writes remain prohibited even under `/tmp`. |
| `git stash list` within an inspection list | 1 | `w-30f11c44` | Blocked | Exact read-only form can be allowed while all mutating stash forms remain denied. |

The five non-shell denials form three groups:

| Pattern | Count | Workflows | Assessment |
|---|---:|---|---|
| Question tool treated as unknown | 2 | `w-89a431eb`, `w-b7664473` | Already corrected in current `READ_ONLY_TOOLS`; historical models defaulted scope instead of asking. |
| Editing completed review-batch artifacts | 2 | `w-9ccce2bf` | Correct denial. Immutable batch evidence was preserved; corrections were carried forward in a later ledger. |
| Writing `review-report.md` before CONSOLIDATE | 1 | `w-9ccce2bf` | Correct denial. The report became writable only after phase transition. |

### Retry behavior and message quality

Repeated equivalent attempts occurred in at least four workflows:

- `w-9f4154fd` retried `rg` three times and then switched tools; evidence: `/stuff/Source/azerothcore-wotlk/modules/mod-playerbots/.pi/rpac/w-9f4154fd/log.md` plus its matching session.
- `w-89a431eb` made 14 denied shell inspections while reconstructing Git scope, including repeated status/branch/merge-base calls; evidence: `/stuff/Source/azerothcore-wotlk/modules/mod-wowmin-telemetry/.pi/rpac/w-89a431eb/log.md` plus its matching session.
- `w-b7664473` made nine denied inspection calls before proceeding; evidence: `/stuff/Source/wowmin/.pi/rpac/w-b7664473/log.md` plus its matching session.
- `w-9ccce2bf` made two grep attempts whose quoted patterns contained shell-looking `>>`/`&` text; evidence: `/stuff/Source/wowmin/.pi/rpac/w-9ccce2bf/log.md` plus its matching session.

The historical message usually said to use `grep/find/git status/git diff`, even when the attempted compound command already contained those commands. That advice did not identify which segment was unknown or whether the cause was destructive syntax, unsupported substitution, or exact-check mismatch. The current parser fixed most of the older false negatives, but the generic rejection reason still obscures the failing segment. This is evidence for diagnostic improvement, not for weakening the deny policy.

## Workflow and lifecycle failures

### Recoveries that worked as designed

1. **Interrupted ACT lease failed closed.** In `/stuff/Source/pi-rpac/.pi/rpac/w-b0f059a7/log.md`, task 2 initially could not be completed after execution interruption because the ACT lease was absent. A later user ACT/resume cycle restored the lease, and the task completed. This prevented an unleased completion rather than losing progress.

2. **Consolidation found a real defect and reopened ACT.** `/stuff/Source/pi-rpac/.pi/rpac/w-b0f059a7/log.md` records `back_to_act`, creation of repair task 6, exclusion-aware fingerprint fixes, fresh verification, and successful consolidation. This is positive evidence for the repair path.

3. **Stale deliverables were surfaced.** The same workflow warned about deliverables after interruption rather than silently trusting stale hashes; see `/stuff/Source/pi-rpac/.pi/rpac/w-b0f059a7/log.md` and `report.md`.

4. **Review artifact boundaries held.** `/stuff/Source/wowmin/.pi/rpac/w-9ccce2bf/log.md` and the session show that edits to batches 1 and 2 and the premature final report write were blocked. The review completed by recording corrections in a later immutable batch and writing the final report only in CONSOLIDATE.

5. **Empty review scope was auditable and abortable.** `/stuff/Source/wowmin/.pi/rpac/w-30f11c44/review-manifest.json` contains a valid zero-item scope. `/stuff/Source/wowmin/.pi/rpac/w-30f11c44/log.md` records requirements approval followed by explicit abort, not a crash or implicit completion.

### Friction without enough evidence for code changes

1. **Repeated finalization/status polling.** `/stuff/Source/wowmin/.pi/rpac/w-30f11c44/log.md` and its session show one requirements finalization awaiting approval, repeated status checks, a second `refine_complete`, approval, and then abort. The state machine remained correct. The evidence does not distinguish UI/user timing from an implementation defect, so no lifecycle change is justified.

2. **Redundant `task_start` calls.** The sessions corresponding to `/stuff/Source/azerothcore-wotlk/modules/mod-wowmin-telemetry/.pi/rpac/w-89a431eb/log.md` and `/stuff/Source/wowmin/.pi/rpac/w-b7664473/log.md` attempted to start tasks already put in progress by the ACT directive. RPAC rejected both and the runs recovered. Current skill instructions explicitly say the directed ACT task is already started; no state-machine relaxation is warranted.

3. **Approved but unusable check.** `/stuff/Source/wowmin/.pi/rpac/w-9ccce2bf/review-batch-1.md` records `npm run check:exports` exiting with usage error because required arguments were absent. It was correctly classified as an observation, not a passing acceptance check. Generic pre-validation cannot safely infer arbitrary script arguments, so this remains a planning-quality issue rather than an automatic gate change.

4. **Legacy report-only workflows lacked mechanical ACT protection.** `/stuff/Source/azerothcore-wotlk/modules/mod-wowmin-telemetry/.pi/rpac/w-89a431eb/` and `/stuff/Source/wowmin/.pi/rpac/w-b7664473/` relied on instructions while represented as implementation workflows. Their reports say no source was changed. The later dedicated review workflow exercised by `/stuff/Source/wowmin/.pi/rpac/w-9ccce2bf/` closes that historical design gap with exact report-only gating.

## Findings and decisions

### F-1 — Generic denial diagnostics caused avoidable retries

**Severity:** medium usability; no demonstrated security impact.

**Evidence:** all six workflow sessions contain denials, with concentrated retries in `/stuff/Source/azerothcore-wotlk/modules/mod-wowmin-telemetry/.pi/rpac/w-89a431eb/` and `/stuff/Source/wowmin/.pi/rpac/w-b7664473/`. Generic guidance named commands that were already present in blocked compounds.

**Decision:** report the first rejected segment and distinguish unsupported shell syntax, a blocked mutating/redirection operation, and an unknown command. Continue to fail closed.

### F-2 — Quoted redirection text is misclassified

**Severity:** low usability.

**Evidence:** two ACT denials in `/stuff/Source/wowmin/.pi/rpac/w-9ccce2bf/` came from grep patterns containing literal `>>`/`&` text.

**Decision:** make output-redirection detection shell-quote/escape aware. Add adversarial tests proving real `>`, `>>`, `&>`, substitutions, and mutations remain blocked.

### F-3 — Three exact read-only forms are unnecessarily absent

**Severity:** low usability.

**Evidence:** `git check-ignore` in `/stuff/Source/wowmin/.pi/rpac/w-9ccce2bf/`, `git stash list` in `/stuff/Source/wowmin/.pi/rpac/w-30f11c44/`, and `node -v` in `/stuff/Source/wowmin/.pi/rpac/w-9ccce2bf/` were denied.

**Decision:** allow only those exact read-only forms. Keep `git stash` mutation forms, unknown Git subcommands, and arbitrary Node execution blocked.

### F-4 — Remaining denied inspection shortcuts should stay denied

**Severity:** security boundary / intentional limitation.

**Evidence:** repeated `rg`, `sed`, `awk`, Python, loops, output writes, and modified approved checks across `/stuff/Source/azerothcore-wotlk/modules/mod-playerbots/.pi/rpac/w-9f4154fd/`, `/stuff/Source/pi-rpac/.pi/rpac/w-b0f059a7/`, and `/stuff/Source/wowmin/.pi/rpac/w-9ccce2bf/`.

**Decision:** do not broaden the allowlist. `rg --pre`, general `sed`/`awk`, interpreters, and shell substitutions can execute or write; exact review-check matching is deliberate. Better diagnostics and direct inspection tools are the safe remedy.

### F-5 — No evidence supports weakening artifact or lifecycle gates

**Severity:** informational.

**Evidence:** immutable review batches and phase report boundaries held in `/stuff/Source/wowmin/.pi/rpac/w-9ccce2bf/`; ACT lease and consolidation repair behavior held in `/stuff/Source/pi-rpac/.pi/rpac/w-b0f059a7/`; the empty review was explicitly aborted in `/stuff/Source/wowmin/.pi/rpac/w-30f11c44/`.

**Decision:** preserve exact artifact paths, report-only review restrictions, approval gates, ACT leases, stale-deliverable checks, and consolidation repair semantics.

## Implemented low-risk improvements

The implementation stayed within the evidence-backed scope:

1. `lib/gating.ts` now detects output-redirection operators only outside quoted/escaped shell text. Literal `>`/`>>` in grep patterns no longer cause a denial. Safe suppression remains limited to the exact `/dev/null` token or an exact file descriptor; adversarial prefixes such as `/dev/null.log` and `/dev/null/../output` remain blocked.
2. The allowlist now admits `git check-ignore`, exact `git stash list`, and exact runtime version/help forms including `node -v`. Mutating stash forms, stash-list options not explicitly reviewed, and Node evaluation remain blocked.
3. Shell denial messages now identify the first rejected segment and classify unsupported shell syntax, output redirection, mutating operations, or unknown commands. Review denials also remind callers that approved checks must match exactly.
4. `test/unit/gating.test.ts` adds positive historical-pattern coverage and adversarial coverage for stash mutations, extra Node arguments, genuine redirects, `/dev/null` lookalikes, substitutions, exact approved-check mismatches, and compound-command diagnostics.

A replay classification of the 43 historical shell denials now accepts 28 and blocks 15. Including the two already-supported question-tool calls, 30 of the original 48 denied invocations would now pass. The remaining 18 are the 15 intentionally blocked shell calls plus two immutable-batch edits and one premature report write.

Explicit non-goals were preserved: general `rg`, `sed`, `awk`, Python/Node scripts, command/process substitution, arbitrary output redirection, non-exact review checks, and additional writable artifacts were not enabled.

## Verification results

All checks passed against the final changes:

- Focused gate suite: `node --test test/unit/gating.test.ts` — 18/18 tests passed.
- Full suite: `npm test` — 160 tests passed, 0 failed, including the eight-subtest real-Pi suite.
- TypeScript: `npm run typecheck` — passed with no diagnostics.
- Installed-package smoke: `npm run smoke` — passed; packaged ordinary/review dispatch and Git/content invariants verified.
- Whitespace: `git diff --check` — passed.
- Historical replay classifier: 48 denials recovered from sessions; 43 shell calls; post-change result 28 allowed and 15 still blocked.

Final repository status contains only the intended uncommitted paths:

- `RPAC-HISTORICAL-AUDIT.md` (new)
- `lib/gating.ts` (modified)
- `test/unit/gating.test.ts` (modified)

No historical `.pi/rpac/<workflow-id>` evidence was modified. No commit or push was made.
