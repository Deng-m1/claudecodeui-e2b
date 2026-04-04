# Session Bridge Regression Plan

## Goal

Verify that session creation, resume, switching, reconnect, permission handling, history loading, and git workflow behavior stay correctly scoped by `sessionId` across:

- local providers: Claude, Codex, Cursor, Gemini
- E2B runtime
- same-project multi-session usage
- read-only regression on the current repo
- write-path regression only in isolated clones or E2B sandboxes

## Safety Policy

### Allowed on the current repo

- session creation
- session switching
- session resume
- reconnect and refresh
- permission flow checks
- history loading checks
- abort checks
- non-destructive provider startup validation
- non-destructive build/typecheck/preflight reads

### Not allowed on the current repo

- creating or editing files through the provider
- branch creation
- commit
- push
- PR creation
- merge flows that mutate the current working tree

### Allowed only in an isolated clone or E2B sandbox

- file creation
- file edits
- branch creation
- commit
- push
- PR creation
- merge and fetch validation
- multi-session same-branch write contention checks

## Test Environments

1. Current local repo, read-only
2. Isolated local clone under `/tmp` or another disposable path
3. E2B sandbox bound to the target project

## Execution Order

1. Preflight
2. Core session semantics
3. Permission routing
4. Reconnect and history
5. Local provider regression
6. E2B runtime regression
7. Write-path regression in isolated clone or E2B sandbox
8. Final report

## Preflight Commands

```bash
bash skills/test/scripts/preflight.sh --repo .
python skills/test/scripts/print_case_matrix.py --format markdown
python skills/test/scripts/report_template.py > /tmp/session-bridge-report.md
```

## Coverage Matrix

| ID | Env | Write Path | Purpose |
| --- | --- | --- | --- |
| CORE-01 | current repo | no | New session returns a stable session id and UI binds it once |
| CORE-02 | current repo | no | Switch away before first reply and verify first stream does not bleed |
| CORE-03 | current repo | no | Two sessions in the same project stream independently |
| CORE-04 | current repo | no | Resume one session while another remains active in background |
| CORE-05 | current repo | no | Abort only the targeted session |
| CORE-06 | current repo | no | Delete an old session and confirm new session does not reuse stale id |
| PERM-01 | current repo | no | Permission banner appears only for the matching session |
| PERM-02 | current repo | no | Permission decision after switching resumes only the owning session |
| RECON-01 | current repo | no | Browser refresh rebinds active local provider output to the same session |
| RECON-02 | current repo | no | Browser refresh while background session is running does not redirect output |
| HIST-01 | current repo | no | Reloaded history is transcript-like and not fragmented raw chunks |
| LOCAL-CLA-01 | current repo | no | Claude local: new, resume, switch, refresh |
| LOCAL-COD-01 | current repo | no | Codex local: new, resume, switch, refresh |
| LOCAL-CUR-01 | current repo | no | Cursor local: new, resume, switch, refresh |
| LOCAL-GEM-01 | current repo | no | Gemini local: new, resume, switch, refresh |
| E2B-01 | e2b sandbox | no | Same project, same sandbox, multiple sessions stay isolated |
| E2B-02 | e2b sandbox | no | Background E2B session keeps streaming while another session is viewed |
| E2B-03 | e2b sandbox | no | E2B permission routing stays scoped to the correct session |
| ISO-01 | isolated clone | yes | New branch, create file, commit, push, PR |
| ISO-02 | isolated clone | yes | Merge PR, fetch, verify new branch and file appear |
| ISO-03 | isolated clone or e2b | yes | Two sessions write on the same branch and commits remain on that branch |

## Detailed Cases

### CORE-01: New session binds one stable id

Steps:

1. Open a project with no selected session.
2. Send a simple read-only prompt such as `summarize the repo layout without editing files`.
3. Observe the first `session_created` transition.
4. Confirm the route, visible session, and incoming messages all point to the same created session.

Pass criteria:

- only one session id becomes active
- the first assistant stream and completion land in that session
- no messages appear in any previously viewed session

### CORE-02: Switch before first reply

Steps:

1. Start a new session A.
2. Before the first assistant delta appears, switch to session B or project chat root.
3. Wait for A to produce output.
4. Return to A.

Pass criteria:

- session B does not show A's stream, loading state, or permission state
- A contains its own output when revisited

### CORE-03: Two active sessions in one project

Steps:

1. Start session A with a longer read-only prompt.
2. Start session B in the same project with another longer read-only prompt.
3. Alternate between A and B while both run.

Pass criteria:

- each stream stays in its own session
- loading and abort controls reflect the viewed session only
- history for A and B remains separate after completion

### CORE-04: Resume one session while another is active

Steps:

1. Start A and let it continue running.
2. Switch to B and send a follow-up that resumes B.
3. Switch back and forth until both complete.

Pass criteria:

- resuming B does not append to A
- switching views does not change which session receives live events

### CORE-05: Abort only the target session

Steps:

1. Start A and B.
2. Abort A while B remains active.
3. Continue watching B.

Pass criteria:

- A ends with an aborted completion
- B continues normally
- B's loading, permission, and history are untouched

### CORE-06: Delete old session, create new session

Steps:

1. Delete an old completed session from the sidebar.
2. Start a fresh new session in the same project.

Pass criteria:

- the new session gets a fresh id
- no history from the deleted session reappears

### PERM-01: Permission banner scoping

Steps:

1. Trigger a provider action that requires permission in session A.
2. While the request is pending, view session B.

Pass criteria:

- B does not show A's permission banner
- the pending request is visible only when viewing A

### PERM-02: Permission decision after switching

Steps:

1. Trigger a permission request in A.
2. Switch away.
3. Return to A and approve or reject.

Pass criteria:

- only A resumes or fails
- the request disappears after resolution
- no unrelated session state changes

### RECON-01: Refresh while viewed session is active

Steps:

1. Start A.
2. Refresh the browser while A is still running.
3. Re-open A if needed.

Pass criteria:

- subsequent output still lands in A
- no replacement writer points to another active session

### RECON-02: Refresh while background session is active

Steps:

1. Start A.
2. Switch to B while A keeps running.
3. Refresh the browser from B.
4. Re-open A after reconnect.

Pass criteria:

- A's output is preserved and remains attached to A
- B does not inherit A's live stream

### HIST-01: Transcript reload quality

Steps:

1. Complete a session with several streamed deltas and at least one tool or status event.
2. Reload the page.
3. Re-open the same session.

Pass criteria:

- history reads as a coherent transcript
- streamed text is coalesced
- duplicate fragments or raw event-chunk noise are absent

### LOCAL Provider Cases

Run `LOCAL-CLA-01`, `LOCAL-COD-01`, `LOCAL-CUR-01`, and `LOCAL-GEM-01` with the same structure:

1. Start a new session.
2. Send one read-only prompt.
3. Send a second prompt that resumes the same session.
4. Switch to another session mid-stream.
5. Refresh once while the provider is active.

Pass criteria:

- new versus resume behavior is correct
- switching does not mix messages
- reconnect preserves the original session route

### E2B-01: Same sandbox, multiple sessions

Steps:

1. Open one E2B project.
2. Start session A and session B in that same project.
3. Use only read-only prompts first.

Pass criteria:

- both sessions share the project sandbox/workspace but keep separate chat histories
- switching sessions does not redirect live output

### E2B-02: Background E2B session while another is viewed

Steps:

1. Start A in E2B and let it continue.
2. Switch to B and continue B.

Pass criteria:

- A and B remain isolated in UI state
- background A continues correctly in the sandbox

### E2B-03: E2B permission routing

Steps:

1. Trigger an E2B permission request in A.
2. View B.
3. Return to A and respond.

Pass criteria:

- permission ownership stays with A
- B does not display A's request

### ISO-01: Isolated clone write-path flow

Environment:

- isolated local clone or disposable E2B sandbox only

Steps:

1. Create a disposable clone with `bash skills/test/scripts/prepare_isolated_clone.sh --source .`.
2. In the isolated target, start a new session on `main`.
3. Ask the provider to create `xxx-helloworld`.
4. Create a new branch.
5. Commit and push.
6. Open a PR.

Pass criteria:

- file is created only in the isolated target
- branch and commit land on the intended branch
- PR targets `main`

### ISO-02: Merge then fetch

Steps:

1. Merge the PR from ISO-01.
2. Fetch in the same isolated target.
3. Verify branch visibility and file presence.

Pass criteria:

- merged branch is visible after fetch
- merged file exists in the expected branch state

### ISO-03: Same branch, two sessions

Steps:

1. Use the same isolated target.
2. Start session A and session B against the same branch.
3. Make two sequential edits and commits.

Pass criteria:

- commits stay on the same intended branch
- no session writes accidentally jump to a different branch or detached state

## Suggested Evidence Format

For each case, capture:

- case id
- provider
- runtime
- viewed session id
- actual target session id
- result: pass, fail, blocked
- notes with exact mismatch if failed

## Exit Criteria

The regression is fully covered only when:

- all read-only current-repo cases pass
- each local provider passes its local case
- all targeted E2B cases pass
- isolated write-path flow passes without touching the current repo working tree
