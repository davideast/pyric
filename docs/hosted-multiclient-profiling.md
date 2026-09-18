# Hosted multi-client profiling — 2026-09-17

The first implementation target is **incremental persistence change detection**.
The host repeatedly encodes and checksums the entire current dataset, then hashes
all persistence records to discover that approximately two records changed.
SQLite transaction time was a small part of the measured cost. No production
behaviour, durability setting, queue limit, or acceptance threshold was changed.

These are short diagnostics against candidate `687bcca3`, using Node 22.15.0,
Chromium, and an Apple M3 Pro with 18 GiB RAM. They do not close sustained
acceptance, cross-platform verification, or the separate memory/history gates.

## Runs

Runs were sequential. A and B used a 30-second warm-up and 60-second measurement,
followed by bounded drain, final listener/data checks, browser disposal, and the
existing 65-second session-expiration check. Four browsers offered 100 writes/sec
in total against the same 1,000 writable 1-KiB documents with 80 listeners.
Capture, the runtime UI, history and the stalled observer remained enabled.

| Run | Change | Measurement succeeded / scheduled | Skipped before SDK call | Worst client/window p95 |
| --- | --- | --- | --- | --- |
| A | Counters only | 4,563 / 6,000 | 1,437 | 3,770.6 ms |
| B | Detailed timers and CPU profile | 4,480 / 6,000 | 1,520 | 3,879.0 ms |
| C | B plus 3,000 untouched documents | Measurement not reached | See warm-up below | Measurement not reached |

A and B had zero service errors and zero pending calls after drain. Completed
counts differed by 1.8%, and worst-window p95 by 2.9%. That pair suggests profiling
did not radically change the symptom; it is not a statistical estimate of
instrumentation overhead. Browser scheduling lateness stayed below 6 ms in both.
The host averaged approximately 0.97 and 0.98 CPU cores respectively during
measurement. Event-loop maximum delays were 942 ms and 1,611 ms.

C exceeded the unchanged ten-second drain limit during warm-up and stopped.
Its four browser reports counted 3,000 scheduled writes, 939 started, 913
succeeded, zero service errors, 2,061 skipped, and 26 still pending at the reporting
cutoff. The accounting identities held. Clients were affected unevenly; three
reported worst-window p95 above 32 seconds. This is evidence of severe overload,
not a completed 60-second comparison. The timeout was not increased and the run
was not retried. C did not reach CPU sampling, which starts at measurement.

## Attribution

B recorded 4,480 persistence flushes during measurement and its final pending
writes. The CPU profile covers approximately 62.55 seconds including that drain.

| Stage | Total duration | Average per flush |
| --- | --- | --- |
| Current-state snapshot | 1.15 s | 0.257 ms |
| Serialization, including document encoding and bucket checksums | 30.88 s | 6.893 ms |
| Record hashing and removal detection | 15.88 s | 3.545 ms |
| SQLite write transaction | 1.98 s | 0.442 ms |

Each flush examined 251 records and changed 1.984 on average. Records are buckets,
not individual documents. Queue waits are separate, overlapping wall-clock
measurements: the persistence queue averaged 0.0023 ms; the per-client host queue
averaged 300 ms over 4,496 queued messages. That queue starts at hosted enqueue,
so it does not include all socket/event-loop waiting before message admission.

The sampled inclusive time inside `realFlush` was 78.1%. Its descendants include
serialization, checksumming, hashing, and persistence; inclusive percentages must
not be added to their children. The largest self-time frames were
`encodeStateDocument` (18.7%), `checksumDocs` (15.2%), and `hashRecord` (14.7%).
These are CPU sampling attributions, not a breakdown of every request's latency.
Transaction timing includes the transaction body and commit; it does not isolate
filesystem synchronization or prove a general SQLite throughput ceiling.

For the dataset comparison, subtracting each run's first warm-up sample from its
last excludes initial seeding. B and C have different warm-up/drain lengths, so
compare cost per flush rather than total duration:

| Per-flush warm-up average | B: 1,000 documents | C: 4,000 documents |
| --- | --- | --- |
| Serialization | 6.556 ms | 25.801 ms |
| Hashing | 3.697 ms | 13.453 ms |
| Serialization + hashing | 10.254 ms | 39.254 ms |
| SQLite write transaction | 0.432 ms | 0.524 ms |
| Records examined | 251 | 257 |
| Records changed | 2 | 2 |

Approximately four times the resident document data produced 3.8 times the
serialization/hash cost, despite the unchanged write targets, listeners and
changed-record count. Bucket occupancy barely changed; the bytes inside those
buckets grew. This supports removing repeated whole-state work before attempting
a worker migration or database replacement. It does not prove that this change
alone will satisfy every acceptance gate.

## Harness changes

- Explicit scheduled, started, succeeded, failed, skipped-at-pending-limit and
  still-pending counts. Both accounting identities are checked throughout each
  browser loop and after drain.
- Ten-second windows group calls by scheduled start time and retain counts,
  completion latency, browser scheduling lateness, and peak pending calls.
  Latencies exclude skipped writes; count checks prevent missing work passing.
- Diagnostic-only configuration for warm-up, measurement, rate and untouched
  documents. Acceptance settings remain fixed.
- Phase acknowledgements ensure CPU sampling starts before measurement work and
  finishes before final inspection. Numeric aggregate probes record queue waits,
  snapshot, serialization/hash, record counts, transactions and host CPU use.
- Exact-match loader anchors fail if a built module changed. Probes transform
  modules in memory; source and built package files are not edited.
- The existing 1.5-GiB host-RSS safety ceiling remains. Short runs additionally
  stop at 512 MiB of temporary database files. Safety samples are timer-driven,
  not an assertion about every transient peak.
- Diagnostic completion is separate from acceptance. After C exposed misleading
  zero-work output for an unreached phase, reporting was corrected to preserve
  warm-up counts and report measurement as absent. A missing CPU profile is
  likewise explicit; empty latency windows cannot count as passing.

The post-run reporting correction was verified against the recorded A/B/C
browser results, including C's 913 successes and 26 pending calls. JavaScript
syntax and detailed probe anchors were checked. The workloads were not rerun
for this reporting-only correction. The measured harness snapshot is retained
with the evidence. Precise reply-to-browser attribution was not added: the
current same-process measurements and CPU profile already identify the first
implementation target without introducing cross-clock timing assumptions.

## Cleanup and evidence

A and B ended with zero subscriptions, empty operation reservations, and only
the baseline three pipes and two server handles before host exit. Post-disposal
host RSS was approximately 126 and 125 MiB. C aborted before that full lifecycle
check; its browser was closed and host stopped through the failure cleanup path.
All three hosts exited with code zero. The harness returned success for completed
diagnostics A/B and failure for incomplete C. No diagnostic hosts or headless
browser workers remained in the final process inventory.

Temporary databases were removed, including approximately 133 MiB for A and
130 MiB for B. No safety ceiling was reached. The first sandboxed launch failed
on serve-cache permissions before serving; the permitted rerun supplied A.

Local evidence, intentionally ignored by Git:

- [A results](../ignored/hosted-profile-2026-09-17/pyric-profile-A.json)
- [B results](../ignored/hosted-profile-2026-09-17/pyric-profile-B.json)
- [B CPU profile](../ignored/hosted-profile-2026-09-17/pyric-profile-B.json.cpuprofile)
- [C incomplete results](../ignored/hosted-profile-2026-09-17/pyric-profile-C.json)
- [Measured harness](../ignored/hosted-profile-2026-09-17/measured-harness/hosted-multiclient-acceptance.mjs)

The preserved raw C file has the old zero measurement summary and an uncreated
CPU-profile path; its warm-up windows are the evidence used above. It was not
rewritten to make it resemble output from the corrected reporter.

## Reproduce

From the repository root with built packages and Node 22.15+:

```sh
PYRIC_MULTICLIENT_DIAGNOSTIC=1 PYRIC_MULTICLIENT_OUTPUT=/tmp/pyric-profile-A.json node scripts/hosted-multiclient-acceptance.mjs
PYRIC_MULTICLIENT_DIAGNOSTIC=1 PYRIC_MULTICLIENT_PROFILE=1 PYRIC_MULTICLIENT_OUTPUT=/tmp/pyric-profile-B.json node scripts/hosted-multiclient-acceptance.mjs
PYRIC_MULTICLIENT_DIAGNOSTIC=1 PYRIC_MULTICLIENT_PROFILE=1 PYRIC_MULTICLIENT_COLD_DOCUMENTS=3000 PYRIC_MULTICLIENT_OUTPUT=/tmp/pyric-profile-C.json node scripts/hosted-multiclient-acceptance.mjs
```

Optional diagnostic overrides are `PYRIC_MULTICLIENT_WARMUP_SECONDS`,
`PYRIC_MULTICLIENT_SECONDS`, and `PYRIC_MULTICLIENT_RATE` (aggregate rate).
Do not use short diagnostic completion to claim milestone acceptance.

## Next implementation

Update: [incremental persistence is implemented and verified with short workloads](hosted-incremental-persistence.md).
The original recommendation below records the scope that guided that change.

Track changed Firestore buckets and service state at the mutation boundary, so
ordinary flushes encode and hash only affected records. Preserve the shared
persistence contract and durable acknowledgment, with coverage for deletion,
reset/import, service registration, failure/retry, and changes arriving during
an in-progress flush. Keep full snapshots for operations that actually require
them. Reuse the same short workload to verify improvement before rerunning the
15-minute acceptance workload. Capture starvation and the separate memory/history
failures remain open.
