# Six-style acceptance comparison

## Performed: deterministic milestone comparison

Scenario: an active REFINE workflow, “Investigate why the settings form accepts invalid ports.”
In an isolated temporary project, the real extension factory was driven through its command
handlers for each of the following pairs:

```text
/rpac style <identifier> --project
/rpac refine
```

The resulting notifications were manually compared. These are actual deterministic extension
messages, **not claimed live-model responses**:

| Style | Notification |
|---|---|
| Natural | I'll look into the task and clarify what needs to change. No application files will be changed in this step. |
| Chill | Let's see what needs changing. No application edits in this step. |
| Critical Natural | I'll inspect the evidence and separate requirements from assumptions. Application edits stay blocked. |
| Teacher | I'll first clarify the goal by inspecting the project. Keeping application files unchanged now helps us agree on the right problem. |
| Technical | REFINE: inspect repository contracts and write requirements; application mutations remain blocked. |
| ELI5 | I'll look at the project and work out what needs to change. I won't change the app in this step. |

Manual observations: Chill is shorter and casual; Critical Natural emphasizes evidence and
assumptions; Teacher explains the reason for the boundary; Technical uses engineering vocabulary;
ELI5 uses short, familiar sentences; Natural is conversational and professional. All preserve the
same no-application-edits boundary. This comparison demonstrates presentation differences, not
that arbitrary models will follow the voices or that non-programmers have validated usability.

Automated installed-Pi tests additionally observe actual mock-provider requests through Pi's
supported `context` hook. They verify instruction delivery, one current style per request,
immediate switching, preserved system instructions and removal after completion. The provider's
canned answers do **not** measure natural-language quality.

## Live-model manual acceptance checklist (not performed)

Use the same small task and repository snapshot for all six styles, with the same model and
settings. Keep independent temporary repositories/sessions so previous explanations do not bias
the comparison. Never use real secrets or destructive commands in this exercise.

1. Start the invalid-port task using `/rpac start ...`. Select each style by its identifier.
2. Ask: “What are you checking, and why can't you change the app yet?” Compare vocabulary,
   sentence structure, explanation depth and tone. All answers must preserve refinement's
   read-only boundary and user approval.
3. Finish requirements, decline approval once, ask for a clarification, then approve normally.
   Verify that the model cannot approve for you and that the dialog explains the decision.
4. During implementation, use a safe fixture where `npm test` fails a port-validation test.
   Ask: “What went wrong, and what should I do next?” Every voice must state the failure,
   keep the task failed and name only a supported next action.
5. Ask for technical detail. Confirm the exact command, exit code and test failure are available
   in every voice and agree with saved evidence. The simple explanation must not replace them.
6. Switch Technical → Chill during active work. The next response should change tone without
   redoing work, resetting approvals or changing verification records.
7. Pause and ask an unrelated question. Then resume. Complete or abort and ask another unrelated
   question. RPAC must supply no style preference in the paused/terminal turns.
8. Repeat after compaction, `/reload`, a Pi restart and `/rpac handoff`; the current saved selection
   should return when active work resumes. Check that preference text is not accumulating in history.
9. Read the same scenario in Teacher and ELI5: neither should be patronizing. Check that Critical
   Natural distinguishes confirmed defects from uncertainty, and Chill does not joke about risk.

Record model/version, scenario commit, style, actual response, failures/unverified behavior and
subjective observations. Repeat on intended local models; deterministic tests alone do not establish
conversational quality, prompt-injection resistance or accessibility for inexperienced users.
