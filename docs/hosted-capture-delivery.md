# Capture delivery under continuous traffic — 2026-09-17

Latest result: the subsequent [acceptance boundary fixes](hosted-acceptance-boundary-fixes.md)
close the count, stalled-reader, large-payload RSS, and Storage import gaps;
the new full 90,000-write run passes all 14 checks. The results below remain
the historical record of this earlier run.

Capture now schedules from the first pending event instead of waiting for a
quiet period. Continuous writes no longer postpone capture indefinitely.

The shared worker initialization path keeps one scheduled timer and one active
POST. Events during that POST coalesce into the next capture, built from current
state after the previous POST finishes. Explicit reset flushes wait for older
POSTs before publishing the cleared state, preventing an older capture from
overwriting a newer reset. Disposal cancels scheduled work and prevents a
completed POST from scheduling another capture.

The existing 400 ms setting and capture format remain unchanged. The scheduling
window is bounded; transport delays and an unresponsive capture server can still
delay delivery. This does not make capture a durable acknowledgment boundary or
change the SQLite journal's separate durability contract.

## Focused verification

- TDD: continuous-write test failed with zero captures before the scheduling
  change; it passes afterward.
- TDD: the reset-ordering test observed two overlapping POSTs before
  serialization; it passes afterward. An empty fixture initially omitted the
  Firestore section, so the test explicitly supplies Firestore rules before
  checking the empty post-reset document set.
- A regression test verifies changes during a slow POST are included in the
  next capture and disposal stops the pending follow-up.
- 54 worker-init, reset and capture-store tests pass.
- CLI compilation and strict checking of the modified test file pass. Two old
  test contexts gained the required instance ID, and an existing fetch stub now
  implements its typed preconnect method instead of casting away the mismatch.
- Three browser tests pass: hosted, SharedWorker and in-page capture retain
  bounded observation history and verification refuses incomplete history.
- The initial browser smoke run completed all 1,500 measurement writes, with
  zero harness refusals or service errors; maximum capture delay was 1,480 ms,
  worst-window p95 was 39.7 ms and p99 was 71.7 ms. Cleanup completed.

## Full sustained workload

The full run uses the unchanged two-minute warm-up and 15-minute measurement:
four browser clients, 100 writes/second total, 1,000 fixed writable 1-KiB
documents, 80 listeners, capture and runtime UI enabled, plus a stalled observer.
The implementation includes the preceding incremental persistence change.
No production edits or threshold changes are made during the measured run.

| Measurement | Required | Observed |
| --- | --- | --- |
| Completed writes | 90,000 | **90,000** |
| Harness refusals / service errors / pending after drain | Zero | **0 / 0 / 0** |
| Worst client/10-second-window p95 | < 500 ms | **276 ms** |
| Worst client/10-second-window p99 | < 2,000 ms | **493.3 ms** |
| Maximum capture delay | ≤ 2,000 ms | **1,409 ms** |
| Final document count | 1,000 | **1,000** |
| Listener delivery | Correct final values | **All four clients: 2,060 deliveries, zero mismatches/errors** |
| Durable journal | Healthy, no unrecorded events | **Passed** |
| Subscription release | Zero remaining | **Passed** |

Warm-up separately completed all 12,000 writes without errors or refusals.
Every measured latency window passed. This run closes the demonstrated
throughput/latency and continuous-capture failures for this macOS/Chromium
workload; it is not a cross-platform or complete milestone sign-off.

Host CPU averaged approximately 0.48 cores during measurement. Sampled host RSS
ranged from 179.8 to 502.5 MiB during measurement; the first-minute range was
219.7–502.5 MiB and the last-minute range was 236.9–466.8 MiB. The all-phase
peak was 519.7 MiB, settling to approximately 103 MiB after disposal. This does
not establish the separate large-payload memory bound.

### Checks still open

The harness's overall `accepted` result remains false, and its exit code was 1:

- `historyCountLimitReached`: this dataset hits the 8 MiB byte bound first;
  measured retained entries peaked at 2,230. It does not exercise the count
  boundary. The previously failing supplemental count test remains unresolved.
- `stalledObserverRefused`: the reader deliberately paused throughout the load
  reported close code 1006, rather than the required 1013. The existing
  [verification report](hosted-multiclient-verification.md) documents the
  close-handshake timeout and the separate short test's 1013 evidence. This
  check was not removed or reclassified as passing.
- The previously failing large-payload RSS test and Storage import/upload race
  are separate open issues; neither was rerun or changed in this slice.

All other checks in this sustained run passed. SharedWorker remains supported;
this change applies through the common worker initialization path.

## Cleanup, evidence and reproduction

The host exited with code zero after the 65-second session-expiration check.
Final resources returned to three pipes and two server handles, with zero
subscriptions and empty operation reservations. Temporary data, approximately
1.67 GiB before removal, was deleted. A final process inventory found no
diagnostic host or headless browser workers. No safety abort occurred.

Local raw results, logs, TDD failures, browser checks, typecheck results and
measured artifact hashes are preserved under
`ignored/hosted-capture-2026-09-17/`. The measured harness and runtime artifacts
had identical SHA-256 hashes before and after the run. The summary here is the
reviewable record; ignored evidence remains local.

From the repository root with built packages and Node 22.15+:

```sh
bun test packages/cli/test/serve/worker/serve-init.test.ts packages/cli/test/serve/worker/reset-all-op.test.ts packages/cli/test/serve/capture-store.test.ts
node node_modules/@playwright/test/cli.js test section-five-capture.pw.ts --config packages/cli/test/e2e/hosted/playwright.config.ts
PYRIC_MULTICLIENT_OUTPUT=/tmp/pyric-capture-acceptance.json node scripts/hosted-multiclient-acceptance.mjs
```
