# Hosted blocker assessment — 2026-09-14

Candidate: `4249b996` on `hosted-live-mode`. No production or test changes.
This investigation ran existing tests against disposable projects using fresh
CLI output, Node 22.15.0 and headless Chromium. Independent browser contexts
are not a Safari/Firefox compatibility claim. The manual demo was untouched.

**No current product failure was reproduced in the selected checks.** This is
enough to proceed with manual verification of the normal workflows. It does not
establish completion of every requirement in the existing Section 1 goal.

## What works in this investigation

| User action | Current result |
| --- | --- |
| Open two browser contexts and write a shared document | Pass; the other listener receives the write. |
| Start with delayed, failed or incorrectly selected hosted initialization | Pass; wait or fail explicitly without creating a fallback store. The five-second initialization deadline passes. |
| Lose the host connection | Pass; calls report unavailability while the app remains registered; repeated unsubscribe works. |
| Restart the host on the same project and port | Pass; the existing page recovers and new writes reach both pages. |
| Interrupt recovery a second time or deliver stale socket events | Pass; recovery retains one active document listener and stale events do not corrupt it. |
| Delete the app during attachment or recovery | Pass; unsent work settles, its socket closes, and recovery does not revive the deleted app. |
| Use default SharedWorker or genuine in-page mode | Pass for selected SDK/queue and in-page control-refusal scenarios. |
| Start competing hosts, terminate a host, or correct a failed startup | Pass; one owner is admitted and the project can be reopened. |
| Close an in-process MCP owner | Pass; project ownership is released. |
| Refresh revoked claims in hosted, SharedWorker and in-page modes | All three existing reload scenarios pass, including the initial tenant-protected write and later denied write. |

Results: 17 workflow cases in 36.0 seconds, six ownership cases in 11.6 seconds,
and three claim-refresh cases in 6.1 seconds. All 26 executed browser scenarios
passed with zero retries, skips or flaky results. Thirty existing lifecycle
regressions passed across three files. Strict CLI and hosted-fixture typechecks
passed. The first identity selector collected no tests; it is retained as a
selection error, not a product failure. The corrected selector collected all three.

## What is not an established blocker

- **Repeated close:** the internal runtime's early return is a source concern,
  but both the public bridge mount and CLI cleanup share their closing promise.
  No public repeated-close failure has been reproduced. Do not fix the internal
  method just because it looked suspicious in isolation.
- **SharedWorker MCP caller isolation:** caller-ID forwarding still needs a real
  MCP reproduction. Passing raw SharedWorker client-isolation tests does not
  establish MCP execution isolation, but source inspection alone is not a failure.
- **Old in-page identity failure:** the existing claim-refresh scenario now
  passes across all three runtimes. Do not present the old denied-write report as
  a current reproduced blocker. The current test does not directly assert the
  `IdTokenResult.claims.firebase.tenant` field, so it also does not prove that the
  old token-shape concern is resolved. Full identity acceptance belongs to Section 2.

## What still prevents declaring the current goal complete

These are missing acceptance evidence, not demonstrated normal-workflow failures:

1. **Stop while work is still running.** Show what happens to an accepted SDK,
   MCP or CLI call when the host stops, including a client whose cleanup has
   already begun. It must finish or explicitly cancel under the contract; shutdown
   must release its ownership afterward. Existing caller-disconnect tests and idle
   restart tests do not establish this combination. Routine fixture `stop()` can
   force-kill a process after five seconds, so successful fixture teardown alone
   cannot close this requirement.
2. **Lose connectivity without receiving a socket-close event.** Closed-socket
   recovery passes. The declared heartbeat/liveness behavior, reconnect timing,
   and full interrupted-session resource release still need their specific proof.
3. **Interrupt startup at an allocating stage.** Particular failed starts pass;
   stopping during initialization and releasing late work across the startup
   stages remains unverified.
4. **Finish the existing protocol acceptance inventory.** Required message fields,
   recursive query/value input paths, and the remaining per-owner admission/release
   cases still lack complete mapped evidence. This investigation did not run an
   exhaustive malformed-input campaign or convert uncovered cases into presumed bugs.

The original requirements are explicit in gates 2C, 3A–3C, 3E and U6 and in
Section 1 R1/R2/R4/R5/L1–L4. They cannot be silently removed. The eight-hour run
mostly strengthened message-size and queue bounds; normal workflow coverage was
already substantial. That explains why many fixes accumulated without closing
the broader goal.

**Recommended next action:** perform the short manual two-browser journey now.
For the next automated implementation task, investigate only item 1: shutdown
with accepted work still running, followed by reopening the same disposable
project. Report a reproduced failure or passing characterization before choosing
another task. Do not restart the unchanged broad autonomous goal.

Reports and exact command selections are retained under
`ignored/blocker-investigation-2026-09-14/`. No code fixes, new tests, PRs or
releases were made. This assessment is a workflow/blocker investigation, not the
combined Section 1 acceptance run.
