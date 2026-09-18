# Incremental persistence verification — 2026-09-17

Ordinary persistence flushes now encode and hash only affected Firestore buckets.
The implementation shares the existing sandbox foundation across Node and
SharedWorker hosts. It adds no worker, database format, or durability setting.

## Implementation and limits

`LocalState` reports successful mutations at the same boundary that advances
document versions. The environment and sandbox forward these notifications
independently of retained observation events. Reset replaces the environment but
keeps the persistence subscription alive.

The persistence controller keeps bucket membership as document paths, without a
second encoded document store. Each flush captures the dirty buckets before
awaiting its backend commit. Writes arriving during that await belong to the next
flush. Failed commits restore the captured dirty buckets for retry. Baseline
hashes advance only after success. Reset, import and clear request a full
reconciliation, which also removes obsolete persisted buckets.

Subscribed services are snapshotted after a change notification and cached as
detached values. Services without subscriptions retain snapshot-on-every-flush
behavior. Registration, unregistration and full state replacement invalidate the
appropriate cache. Service metadata still occupies the existing shared record;
this is not per-record RTDB persistence. Firestore still encodes every document
in an affected bucket, including unchanged documents that share that bucket.

## TDD and correctness evidence

Two public persistence tests failed before implementation and passed afterward:
an unrelated Firestore document was unnecessarily encoded again, and an unchanged
subscribed service was unnecessarily snapshotted again. Tests use a real encoded
Bytes value, the public service registry and fresh sandboxes reading persisted
state. Commit control and failure injection occur at the persistence backend.

- Seven new tests pass, covering selective encoding, service invalidation,
  writes during commit, failed-commit retry with deletion, reset/import,
  clear-and-flush, and SDK batch/transaction persistence.
- 115 existing library persistence tests pass, covering Auth, RTDB, Storage,
  Messaging, multiple apps, chunk encoding and the controller.
- 33 Node SQLite and worker persistence tests pass, including durable
  acknowledgment, commit failures, abrupt termination and Undo/redo history.
- Library compilation, CLI typechecking and the new test file's strict
  typecheck pass.
- Targeted browser verification: 12 pass, one existing failure below. Passing
  checks include SDK/MCP/CLI durability, fail-closed startup, reset overlapping a
  Storage upload, SharedWorker reset persistence and cross-browser writes.

### Existing Storage import race

`host-import-persistence.pw.ts` fails when an empty checkpoint is imported while
an upload is paused before producing its bytes. The pending object is absent
from the import's existing-object listing, so it is not removed. Resuming the
upload leaves `files/shared.txt` present after restart, where the test expects
an empty listing.

The same failure was reproduced with unchanged HEAD versions of all four
modified existing runtime modules substituted through a temporary Node loader.
The worktree and built modules were not reverted. This is an existing blocker,
not a passing import check; resolving the Storage lifecycle race remains separate
from incremental change tracking.

## Acceptance scope

Update: after the separate capture scheduling fix, the
[full 90,000-write workload](hosted-capture-delivery.md) passed throughput,
latency and capture freshness. Its overall acceptance status remains red for
the documented history-count coverage and stalled-reader close-code checks.
The paragraphs below retain the scope of the original short diagnostics.

The short diagnostics do not replace the 15-minute acceptance workload. Capture
delivery under continuous traffic, the previously failing large-payload memory
gate and history-count boundary remain open. No acceptance threshold, pending
limit, or durability requirement was relaxed.

## Short workload results

Sequential runs used Node 22.15.0 and Chromium on the same Apple M3 Pro as the
[baseline profiling](hosted-multiclient-profiling.md): 30 seconds of warm-up,
60 seconds of measurement, four clients offering 100 total writes/second,
1,000 writable 1-KiB documents and 80 listeners. Capture, runtime UI, durable
history and the stalled observer stayed enabled.

| Run | Completed / scheduled | Harness refusals | Worst interval/client p95 | p99 |
| --- | --- | --- | --- | --- |
| Previous control | 4,563 / 6,000 | 1,437 | 3,770.6 ms | — |
| Incremental control | 6,000 / 6,000 | 0 | 17.3 ms | 42.7 ms |
| Incremental, plus 3,000 untouched documents and profiling | 6,000 / 6,000 | 0 | 17.8 ms | 45.0 ms |

Both new runs also completed all 3,000 warm-up writes, with zero service errors
and zero pending calls after drain. The previous larger-dataset run did not get
past warm-up. These are individual short runs, not a statistical latency claim.

The larger incremental run measured 6,000 flushes: serialization averaged
0.220 ms, record hashing 0.084 ms and SQLite transactions 0.522 ms. Each flush
examined and changed exactly two records. No whole-state snapshot was invoked
in that measurement phase. The previous profiled 1,000-document run averaged
6.893 ms serialization, 3.545 ms hashing and 251 examined records; its larger
dataset averaged 39.254 ms combined serialization/hash during warm-up. These
comparisons have different dataset or phase conditions; the raw results preserve
those distinctions rather than presenting an identical-load speedup ratio.

Measured host CPU use averaged 0.35 cores in the new control and 0.39 in the
larger profiled run, versus 0.97 in the previous control. Maximum sampled
measurement event-loop delays were 52.8 and 47.2 ms, versus 942 ms previously.
The larger CPU profile spent approximately 61% idle. Serialization is no longer
the dominant cost at this offered rate.

Capture deadlines still failed at approximately 90 seconds. The short runs did
not exercise the history count limit, and their strict stalled-observer
close-code checks remained false. Listener delivery, fixed dataset, journal
health, operation bounds and subscription release passed. The full sustained
acceptance run was not repeated while these separate gaps remain open.

## Cleanup and evidence

Both harnesses completed cleanup and hosts exited with code zero. Final samples
showed zero subscriptions, empty operation reservations and only the baseline
three pipes and two server handles. Host RSS settled to approximately 124 and
138 MiB before exit. A final process inventory found no owned diagnostic host
or browser processes. Temporary databases were removed.

Local evidence is retained in the ignored directory
`ignored/hosted-incremental-2026-09-17/`: both JSON results and logs, the larger
run's CPU profile, test logs, unchanged-code import reproduction log, a snapshot
of the measured harness, and measured built-module hashes. The final source-only
cleanup changed constructor formatting, a `readonly` modifier and documentation;
it did not alter measured runtime behavior.
