# PR preview and runtime-guidance acceptance

Run these checks from `refine/natural` with the updated extension loaded. Automated tests use
local Git/mock-gh fixtures; no real GitHub mutation or real dependency installation is needed.

## Automated baseline

```sh
npm run typecheck
npm test
npm run smoke -- --model <a-model-visible-with-pi--ne>
```

For a separate installed Pi, put its directory first on PATH and run:

```sh
node --test test/e2e/realpi.test.ts
bash test/smoke/smoke.sh --model <a-model-visible-with-pi--ne>
```

The smoke script disables unrelated extensions. A dynamically registered provider may therefore
be unavailable with `-ne`; inspect `pi -ne --list-models` first. Dispatch smoke success does not
prove a successful model response: the script deliberately validates persisted state and Git
invariants even if the subsequent model request fails. The live check below must inspect real
assistant stop reasons/tool results instead.

Automated coverage includes separate-worktree preview from a clean tree, legacy checkout behavior,
quoted search data, composed inspection, unsafe flags and wrappers, native hook/fsmonitor suppression,
plan-time policy contradictions and explicit assigned-ID mismatches, separate host consent,
screened-input/plan drift, setup reuse, actual failed-check logs and offline hints, generated output,
tracked-source drift, mandatory observations, strict cleanup, and foreign-runtime lease ownership.
The setup in the host-runner integration test is simulated; its failing Node check actually runs.

## Targeted live local-model check

Use a disposable two-file Git repository and a copied package, not a real untrusted PR. Seed an
active REFINE review with `captureReviewSnapshot`, `newReviewState` and `createWorkflow`, saving its
matching `review-manifest.json`. Give `first.txt` the label `amber` and a source-code string containing
`[RPAC communication preference — natural]`; give `second.txt` the label `teal`.

Start installed Pi with only the copied RPAC package and, if required, the already trusted local
provider extension. Disable unrelated skills/context resources for this isolated check. Enable
`read,bash`, use JSON output, and ask:

> This is a read-only fixture check, not a request to advance the saved review. First use bash to
> inspect the two labels with: rg -n 'LABEL' first.txt && sed -n '1,3p' second.txt. Then use read to
> open first.txt. Reply only with the two label values joined by a slash. Do not write artifacts or
> advance the workflow.

Acceptance:
- Real `bash` and `read` calls complete without policy refusals.
- All assistant stop reasons are normal tool-use/stop, never error/aborted; process exit zero alone
  is insufficient in JSON mode.
- Assistant text is exactly `amber/teal`, with no configuration/preference/reminder narration.
- `workflow.json` is byte-identical before and after; no phase/approval advance occurs.

Verified here with installed Pi 1.3.0 and configured local
`llama-swap/qwen3.8-27b-ninfer` (thinking off): three assistant invocations, both inspection tools
successful, exact answer, unchanged review state. The provider extension had to be explicitly
loaded because `-ne` correctly disables its normal registration. This is a narrow live regression,
not proof of tone quality, injection resistance, or a complete long-running PR review.

## User-driven real preview

1. Reload RPAC after the previous run has stopped. Run `/rpac preview <number>` from a clean or
   dirty main checkout. Confirm the main branch/HEAD/source remain unchanged and status identifies
   the separate pinned worktree.
2. Inspect scope/requirements and approve normally. Verify the plan's exact commands are feasible,
   its explicit assigned-ID blocks match registered tasks, and source screening names actual files,
   hooks, side effects, dependency risks and any suspicious code. A do-not-run recommendation must
   stop host execution.
3. Before `/rpac approve execution`, confirm a native script/setup request refuses without executing
   anything. Decide personally whether to consent; this manual checklist is not authorization.
   With a large inspected-file list, verify terminal approval has an always-visible footer; scroll
   to the last inventory entry with End and back with Home/PageUp/arrows/wheel. Resize from 80×24
   to 40×12 and verify content remains reachable. Enter should open short confirmation, never grant
   consent by itself. Y grants consent only after that screen renders; B returns, Esc cancels both
   screens. RPC should show a compact confirmation pointing to the complete saved review file.
   Changing that file or a screened source while consent is pending must invalidate approval.
   A display-only fixture exercised End/Home, resizing, cancel and explicit approval through actual
   pseudo-terminals on development Pi 1.1.0 and installed Pi 1.3.0; no subject code was executed.
4. If consented, run early setup and supported checks through `rpac review_check`. Inspect full logs,
   real exit codes, offline hints and generated outputs. Do not substitute a deferred test for a pass.
   An interrupted/uncertain command must block blind replay.
5. In sequential mode, verify each next batch starts with successful `task_start`, task guidance
   updates, and failed acceptance/interruption stops work. A separate session must not write the
   owner's ledger or release its lease.
6. Consolidate an advisory report: all items accounted for, real failures/unavailable checks visible,
   no fixes/commits/GitHub publishing. Preserve the report and generated outputs. Cleanup must refuse
   to delete dirty/untracked/ignored output until the user explicitly handles it outside the workflow.

Host execution is not sandboxed. Worktrees share Git administration; code can access credentials,
files, services and networks. Offline dependency-manager hints are not network enforcement. Native
preparation suppresses checkout/fsmonitor hooks, but installed Git/gh/configured helpers remain
trusted tooling; raw CLI classification does not isolate arbitrary plugins. No Docker is used.
