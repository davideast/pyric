# Hosted capacity diagnosis — 2026-09-17

The default browser workload overloads primarily in the runtime chip's event
processing, not SQLite. Do the browser history fix first. Separately, Firestore
undo retains every completed write and needs an explicit retention contract.
The original investigation below changed no production behavior. The subsequent
incremental-processing implementation and verification are recorded in
[the implementation checkpoint](hosted-chip-incremental-verification.md).

## Reproduction and comparison

Reference machine: Apple M3 Pro, 18 GiB, Node 22.15.0; checkout `1ac597ff` plus
the previously verified, uncommitted auth/parser/fixture corrections. Disposable
projects used real Chromium SDK calls over WebSocket to the real Node host and
SQLite backend. The existing durability behavior and admission budgets stayed
unchanged.

The unmodified 60-second baseline reproduced the failure: 11,982 offered,
10,891 completed, 1,091 refused by the **browser harness**, zero service errors,
358.5 ms acknowledgment p95. The harness permits at most 64 pending SDK calls;
these refusals are not host admission refusals.

The diagnostic then ran two 30-second loads, each followed by drain, five seconds
idle and forced GC. The only product configuration changed in the comparison
was disabling the runtime chip through its existing HTML metadata option.

| Configuration | Cycle | Completed | Harness refusals | Ack p95 | Peak pending |
|---|---:|---:|---:|---:|---:|
| Chip on | 1 | 5,974 | 13 | 223.6 ms | 64 |
| Chip on | 2 | 4,620 | 1,377 | 416.7 ms | 64 |
| Chip off | 1 | 6,000 | 0 | 2.6 ms | 5 |
| Chip off | 2 | 6,000 | 0 | 2.9 ms | 8 |

All four cycles had zero service errors. Chip-off drain took 0.9 ms per cycle.
The corrected harness asserts chip presence/absence in the DOM. An earlier
attempt to disable it missed the fixture's implicit HTML head; that run was
identified as chip-on replication and excluded from this comparison.

[Machine-readable measurements](hosted-capacity-diagnosis-results.json) contain
phase boundaries, timings and CPU-profile summaries. These diagnostic runs are
not a substitute for the frozen three-run gate or continuous 200/sec acceptance.

## Dominant cost

In the chip-on profile, Node was idle for 64.4 of 77.8 sampled seconds (83%,
including startup and explicit idle periods). Host operation execution averaged
1.05 / 0.94 ms across the two load phases. Snapshot/serialization/hashing averaged
0.43 / 0.44 ms; SQLite transactions averaged 0.088 / 0.074 ms. Browser execution,
in contrast, occupied most of the profile and grew more expensive with history.

Minified browser frames were resolved against the served bundle source:

- `listener-mode.ts` appends every batch to its `events` array and calls
  `recompute()`. That array has no retention bound. `recompute()` invokes
  `incidentsFromEvents(events)` and `listenerOutlines(events, ...)` over the
  entire history. The mode is initialized even when the chip is collapsed.
- `listener-incidents.ts` creates a new `monitorFirebaseActivity` for every
  recomputation. The monitor replays every historical event. Its eviction helper
  alone accounts for 16.8 seconds of browser self time; the monitor's event
  processing adds another 6.1 seconds. This is repeated historical work, not
  expensive processing of just the new write.
- The active-listener fold accounts for 9.4 seconds. Traffic request projection
  accounts for 7.4 seconds, with further time in context copying/freezing.
  `chip-traffic.ts` invalidates its request cache on every relevant event, and
  `chip.ts` renders the collapsed chip on those changes, reading the history
  again through its signals.

The chip-disabled comparison retains the real host, durable writes and the
application's document listener. It demonstrates that Node can serve this
specific load; it does not justify removing the chip from acceptance testing.
Full-state persistence scans remain a scaling concern at larger datasets, but
are not the first fix for this observed overload.

## Retained memory

The chip-off run isolates host retention more clearly:

| Boundary | Live JS heap after GC | Undo entries | Observation entries |
|---|---:|---:|---:|
| Before load | 60.6 MiB | 0 | 5 |
| After 6,000 writes | 72.1 MiB | 6,000 | 4,894 |
| After 12,000 writes | 78.4 MiB | 12,000 | 4,894 |
| Clear undo, then GC | 66.9 MiB | 0 | 4,894 |
| Clear observations, then GC | 60.4 MiB | 0 | 0 |

Clearing was a destructive attribution probe in the disposable host **after**
all workload measurements, never a proposed production cleanup. History owners
were tracked through WeakRefs. The observation owner stays just below its
8 MiB encoded-data cap; the encoded size is not its live JS heap size. Undo
continues growing despite only 100 current documents, and removing both owners
returns live heap approximately to baseline. This identifies the sustained host
heap growth in this workload; it is not a full RSS/native-memory attribution.

At both drains the host queue and observation active-request map were empty.
Without forced GC, heap at the two idle boundaries was 104.1 / 95.8 MiB: some
memory was temporary and remained until collection. RSS moved independently,
so neither peak RSS nor forced-GC results prove the normal memory gate passes.
Browser history has a separate unbounded owner in `listener-mode.ts`; its byte
retention has not been measured here.

## Next implementation, in order

1. **Make chip event processing incremental.** Keep the activity monitor alive
   across batches; update listener state and Traffic projections from incoming
   events. Coalesce visual refreshes while still ingesting every event. Stop
   rebuilding historical projections for each collapsed-chip notification.
   Preserve initial-history hydration, reset/reconnect boundaries, incident
   semantics, service filtering and active listener state. Give retained browser
   history an explicit bound and gap semantics rather than silently dropping it.
2. **Prove the default configuration.** Add focused regressions showing that N
   new events do not replay the accumulated history N times, including retention
   rollover and collapsed/open transitions. Rerun the original 60-second 200/sec
   workload with the chip enabled, then the frozen 50/sec gate. Require actual
   offered/completed/refused/error counts; do not trade away durability or raise
   pending limits.
3. **Address undo retention separately.** Agree on count/byte bounds or durable
   history, and make the available undo horizon visible. Add undo/redo boundary
   tests before imposing a limit. Then rerun the separate slow-reader memory
   acceptance test. This profile does not resolve that test.

A global host admission budget may still be warranted for multiple consumers,
but this single-consumer overload provides no evidence that raising or replacing
host queues would solve it. No SQLite redesign is needed to start the first fix.

## Reproduce and cleanup

See [diagnostic commands and instrumentation](../scripts/diagnostics/README.md).
Probes are loaded only by the diagnostic entry point and never modify source or
built output. CPU profiles and captured browser bundle sources remain under
`/tmp`; the compact evidence above is retained in the repository. Every test host
and browser launched for this investigation exited, and disposable projects
were removed. Existing user servers were left running.
