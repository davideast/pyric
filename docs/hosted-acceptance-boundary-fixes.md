# Node-host acceptance boundary fixes — 2026-09-17

This closes the Storage import race, observation-history count accounting, and
large-payload slow-reader issues identified after the
[continuous-capture run](hosted-capture-delivery.md). The sustained-run result is
recorded below separately from focused regression evidence.

## Storage import ordering

An upload can already be queued while its bytes are still being read. A listing
cannot see that object yet. Import previously listed and deleted existing
objects, allowing this invisible upload to commit afterward and reappear after
restart.

Import now invokes the bucket's existing backend reset before restoring its
objects. The Node backend serializes that reset behind pending writes. This
reuses the existing queue, preserves bucket scope, and also works with the
SharedWorker backend. It does not add cross-service atomic import semantics.

The existing regression failed before the change: after an acknowledged empty
import and a forced host crash/restart, `files/shared.txt` remained. It passes
with the fix. Five import/reset browser checks pass, including SharedWorker
import, reload, and a subsequent SDK upload. Another 64 focused full-state,
checkpoint, promotion, and multi-bucket tests pass.

## History count and byte accounting

Active requests and listeners must remain available when older observations are
evicted. Previously these live records were appended to the snapshot without
reserving capacity, so a history filled to its count limit could exceed that
limit when live registrations were added back.

Retained entries and live-only entries now share count and byte accounting.
Reservations change when a request starts/settles or a listener attaches,
is evicted from retained history, or closes. Encoded sizes are cached per entry;
updates do not rescan all live records. Live state is preserved.

Three new tests failed before the fix: listener count, pending-request pruning,
and live-state byte accounting. Nine retention tests pass, including parity
with `Buffer` removed. Another 48 worker/Traffic tests pass. Existing late-reader
browser checks pass for both limits and verify subsequent live delivery:

- Count: 10,001 records (10,000 records plus one gap marker), 6,497,565 bytes.
- Bytes: 12 records, 7,876,322 bytes.

This bounds retained history while reserving room for current live state. It
does not impose a global admission limit on live requests/listeners. If live
state alone exceeds the budget, it remains available rather than being silently
evicted. This workload does not establish a global bound for that case.

## Slow readers and allocation pressure

The pre-fix large-payload test exceeded its 192 MiB RSS-growth ceiling. History
stayed near 8 MiB and the socket backlog stayed near its 24 MiB ceiling, while
profiling showed substantial JSON/string allocation churn. This was evidence
of heap pressure, not proof of an ever-growing retained history.

Node output now queues UTF-8 buffers with `binary: false`, allowing queued
bytes to reside outside V8's string heap while preserving WebSocket text
frames. Frame-size and backlog limits are unchanged. No forced garbage
collection is used.

Three uninstrumented fresh-host runs passed all six slow-reader cycles:

| Metric | Existing ceiling | Worst observed |
| --- | --- | --- |
| RSS growth from each host baseline | < 192 MiB | 138.35 MiB |
| Write p95 | < 1,000 ms | 121.4 ms |
| Maximum write latency | < 2,000 ms | 326.2 ms |
| Reader refusal | Code 1013 and expected reason | All six cycles |

The separate exact UTF-8 frame-boundary browser test passes and now explicitly
asserts text frames. CLI and library type checking pass. Allocation-profile
runs informed the fix but are not included in acceptance results.

## Harness corrections

The old sustained harness paused the reader throughout the entire run. Although
the host refused it, the reader could not consume the close frame before the
WebSocket library's 30-second close-handshake timeout; it eventually reported
1006. A read-only probe now identifies the actual server refusal by that
reader's TCP port. Only then does the harness resume it to consume the close
frame. Acceptance requires both the matching refusal and the actual client
1013 code/reason. Healthy clients continue the workload.

The 1-KiB write workload reaches the 8 MiB history bound before the 10,000-record
bound. A separate small-event phase now runs after timed measurement and final
listener checks. It requires exactly 10,001 snapshot records, a gap marker, and
an encoded size within 8 MiB. Measurement retention accounting also includes
live-only reservations. Neither check was dropped or its limit relaxed.

The preliminary 60-second diagnostic completed all 6,000 measurement writes,
with zero failures, refusals, or pending work; all checks except the intentionally
false full-duration check passed. Its count phase returned 10,001 records in
6,607,221 bytes. This short run is not sustained acceptance evidence.

## Sustained verification

The full run passed **all 14 checks** (`accepted: true`, exit code zero):

| Measurement | Required | Observed |
| --- | --- | --- |
| Measurement writes | 90,000 | **90,000** |
| Refusals / service errors / pending after drain | Zero | **0 / 0 / 0** |
| Worst client/10-second-window p95 | < 500 ms | **437.6 ms** |
| Worst client/10-second-window p99 | < 2,000 ms | **767 ms** |
| Maximum capture delay | ≤ 2,000 ms | **1,482 ms** |
| Count-boundary snapshot | 10,001 records, ≤ 8 MiB | **10,001; 6,617,697 bytes** |
| Stalled-reader close | 1013 and expected reason | **Passed** |
| Final dataset | 1,000 documents | **1,000** |
| Final listener values | No mismatches/errors | **All four clients passed** |
| Durable journal | Healthy, no unrecorded events | **Passed** |
| Subscription cleanup | Zero remaining | **Passed** |

Warm-up separately completed all 12,000 writes. Each client received 2,060
listener deliveries. Peak all-phase host RSS was 543.08 MiB; final sampled RSS
was 162.59 MiB. This sustained workload uses 1-KiB documents; the separate
large-payload memory evidence is the six-cycle result above.

The host exited normally after the 65-second session-expiration check. Final
operation reservations were empty, and resources returned to three pipes and
two server handles before shutdown. Temporary data (about 1.68 GiB) was removed.
A process inventory found no remaining diagnostic host or headless browser
workers. No safety abort occurred. Harness and measured-artifact SHA-256 hashes
matched before and after the run.

This closes the four specific local acceptance gaps for the tested
macOS/Chromium workload. It does not establish the broader release matrix or
real-upstream live-mode guarantees.

## Reproduction and local evidence

With packages built, from the repository root using Node 22.15+:

```sh
node node_modules/@playwright/test/cli.js test host-import-persistence.pw.ts host-reset-persistence.pw.ts section-five-history.pw.ts outbound-response-boundary.pw.ts --config packages/cli/test/e2e/hosted/playwright.config.ts
node node_modules/@playwright/test/cli.js test section-five-slow-client.pw.ts --repeat-each=3 --config packages/cli/test/e2e/hosted/playwright.config.ts
PYRIC_MULTICLIENT_OUTPUT=/tmp/pyric-acceptance-fixes-full.json node scripts/hosted-multiclient-acceptance.mjs
```

Run browser/stress commands serially to avoid contaminating memory and latency
measurements. Local logs, raw results, and artifact hashes are preserved under
`ignored/hosted-acceptance-fixes-2026-09-17/`; this document is the reviewable
summary. SharedWorker remains supported. These checks do not replace supported
platform/package/browser matrices or real-upstream live-mode acceptance.
