# Sustained multi-client acceptance — 2026-09-17

Latest result: the subsequent [acceptance boundary fixes](hosted-acceptance-boundary-fixes.md)
close the count, stalled-reader, large-payload RSS, and Storage import gaps;
the new full 90,000-write run passes all 14 checks. The results below remain
the historical record of this earlier run.

Follow-up: [incremental persistence and bounded capture scheduling](hosted-capture-delivery.md)
completed all 90,000 writes with zero refusals, worst-window p95 276 ms and
maximum capture delay 1,409 ms. Overall acceptance remains open for the
documented boundary checks. The original failed-run evidence follows unchanged.

**Gate 6B fails.** The full two-minute warm-up and 15-minute measurement ran
against candidate `687bcca3`, followed by drain, listener checks, browser disposal
and 65 seconds for interrupted-session expiration. No production code or
acceptance thresholds changed. This is automated Chromium evidence on macOS,
not a manual or cross-platform sign-off.

## Workload and result

Four isolated browser contexts used the real Firebase-shaped SDK over the Node
host's WebSocket transport. Each held 20 document listeners and offered 25 writes
per second. All writes replaced members of a fixed 1,000-document dataset; each
document's JSON was exactly 1,024 bytes. Capture was enabled. A fifth event-stream
consumer stopped reading after attachment and stayed paused throughout the load.
The default runtime UI was not disabled. No forced garbage collection was used.

The browser harness allows 64 pending operations per client and counts refusals
explicitly. This is a harness safety bound, separate from the host's 256-operation
admission limit. Missing work never counts as a latency pass.

| Measurement phase | Required | Observed |
| --- | --- | --- |
| Writes | 90,000 completed | **62,599 completed; 27,401 harness refusals** |
| Service errors | Zero | Zero |
| Response latency | p95 < 500 ms; p99 < 2,000 ms | **Worst client/10-second-window p95 4,250.7 ms; p99 4,430.4 ms** |
| Capture age | At most 2 seconds | **1,025.544 seconds**, including warm-up |
| Current documents | Fixed at 1,000 | 1,000 after the workload |
| Live listeners | 80, delivering correctly | 80 remained registered; each client received 1,452 deliveries; final values matched fresh reads |
| Retained observation entries/bytes | 10,000 entries / 8 MiB | Sampled maximum 2,227 entries / 8,388,141 bytes, with explicit history-limit gaps |
| Durable history | Healthy, no unrecorded events | Healthy throughout; zero unrecorded events |
| Operation reservations | At most 256 / 24 MiB per owner | Observed high-water marks 55 operations / 111,657 bytes |

Latency values are the worst of the per-client, ten-second windows, not an
invented pooled percentile. The warm-up separately completed 8,870 of 12,000
offered writes. The final durable undo count includes 10 seeding batches,
warm-up writes and measurement writes: 71,479.

## Memory and cleanup

During measurement, sampled host RSS peaked at 369.1 MiB. Its first-minute range
was 326.2–368.3 MiB; the last-minute range was 315.8–361.0 MiB. RSS briefly peaked
at 431.3 MiB during drain/inspection, then fell to 123.5 MiB after disposal.
This shows no increasing RSS trend in this workload; it is not proof of a
general memory bound or closure of the separate large-payload memory gate.

After disposal, application subscriptions and operation reservations were zero.
Host resources returned to the three diagnostic/stdio pipes and two listening
servers present at baseline; no client TCP sockets remained. The host then
exited with code zero. Its browser and driver also exited, and the disposable
project, including approximately 1,202 MiB of SQLite files, was removed.

Read-only measurement hooks collect numeric reservation high-water marks,
weak references to observation owners, capture timing and host resources. They
modify module text only while loading the disposable host; source and built
artifacts on disk are unchanged. Samples are timer-driven and can be delayed by
host work; they do not establish every transient allocation's bound.

## Additional boundary checks

Both unchanged supplemental browser tests failed; neither was retried:

- `section-five-history.pw.ts`, count case: the delivered history contained
  **10,002 events**, against the existing maximum of 10,001 including the gap.
  Encoded size was 6,498,074 bytes. The sustained workload reaches the byte
  limit before the count limit, so it cannot cover this boundary by itself.
  Source inspection shows that `EventHistory.snapshot()` appends active listener
  records outside the retained-entry array. That is a candidate explanation for
  the extra record; the test failure requires resolving the count contract,
  not merely increasing the assertion.
- `section-five-slow-client.pw.ts`: the first cycle grew host RSS by
  **282,427,392 bytes (269.3 MiB)**, exceeding the unchanged 192 MiB ceiling.
  Its latency passed: p95 94.5 ms, maximum 114.3 ms. The stalled reader received
  close code **1013** and the expected 24 MiB backlog reason. The second cycle
  was not reached because the memory assertion failed.

The sustained run's socket high-water mark was 25,162,755 bytes, below 24 MiB.
When resumed after the entire run, that client reported abnormal closure 1006,
so the runner's strict close-code check remained false. The installed WebSocket
library destroys a connection when its 30-second close handshake expires; a
reader paused for 17 minutes cannot reliably observe that handshake. The short
test independently confirms the intended 1013 refusal. This does not establish
the separate proposed per-consumer observation queue/control-channel contract.

The new RSS failure reopens the memory gate despite the earlier passing history
verification. The earlier passes remain historical evidence; they do not
override this failure.

## Next work

1. Reproduce and attribute the large-payload RSS failure without relaxing the
   192 MiB limit, while resolving the history-count accounting mismatch.
2. Profile the host under this multi-client dataset. A read-only process sample
   showed approximately 96% of one CPU core in the Node host. The persistence
   controller still snapshots, serializes and hashes the current dataset on each
   flush; that is an investigation target, not a proven attribution from this
   run. The earlier 100-document/256-byte benchmark does not establish this
   1,000-document/1-KiB, 80-listener capacity.
3. Replace capture's debounce-only scheduling with bounded delivery that meets
   the two-second deadline under continuous traffic. `applyServeInit` resets its
   400 ms timer on every event; this run recorded one capture before continuous
   traffic and the next only after traffic stopped. Durable SQLite history and
   the replay capture are separate outputs.

## Reproduce and evidence

Use Node 22.15+ with built Pyric and CLI packages, from the repository root:

```sh
PYRIC_MULTICLIENT_OUTPUT=/tmp/pyric-multiclient-acceptance.json node scripts/hosted-multiclient-acceptance.mjs
node node_modules/@playwright/test/cli.js test section-five-history.pw.ts section-five-slow-client.pw.ts --grep 'count-bounded|stalled event reader' --config packages/cli/test/e2e/hosted/playwright.config.ts
```

`PYRIC_MULTICLIENT_SMOKE=1` selects a five-second warm-up and 15-second load;
it is explicitly not acceptance evidence. A smoke run validated setup before
the full run. A 1.5 GiB host-RSS safety abort protects the machine and makes the
run incomplete; it is not an acceptance threshold. It was not reached.

[Recorded results](hosted-multiclient-results.json) contain the complete host
samples, per-client latency windows, cleanup evidence and failed checks.
The workload's exit code was 1 because acceptance failed; the host itself
shut down normally. Supplemental output is retained locally at
`/tmp/pyric-multiclient-boundaries.log`.

The harness and measured artifacts were hashed before and after the full run
and matched. Recorded SHA-256 identities:

```text
dce972d67856f25a215c3ce14bccc1a02ad22dc145c83a86db2fa45e1b68212a  scripts/hosted-multiclient-acceptance.mjs
f202729a2291081fe946c84b08fddbed18a3c8531424269a06315f8ed510e09e  scripts/diagnostics/multiclient-host.mjs
fa3301aa97c7bc65523085f6ff5eb1d934567cbd809f719d5d65743dc782ab6a  scripts/diagnostics/multiclient-loader.mjs
65f350c448eec99407df0b03070ef15090d102003c482a0a2faf11b3124c1846  packages/cli/dist/serve/hosted/runtime.js
dea25e2997264ad3fabd1d5f5126470a8674caecb34c6e6a0ec6a9205b32692e  packages/cli/dist/serve/worker/serve-init.js
5762d5d5be3eb7f14303ce234f3e95a8baaabbfc37837cd9125c318cd2e9cffd  packages/pyric/dist/sandbox/internal/event-history.js
```
