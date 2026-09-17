# Hosted capacity diagnosis

Run from a built checkout with Node 22.15 or newer:

```sh
PYRIC_BASELINE_OUTPUT=/tmp/capacity-chip-on.json node scripts/diagnostics/hosted-capacity.mjs
PYRIC_CAPACITY_CHIP=off PYRIC_BASELINE_OUTPUT=/tmp/capacity-chip-off.json node scripts/diagnostics/hosted-capacity.mjs
```

Each run uses one disposable project, one Node host and one Chromium context. It
performs two 30-second loads at 200 writes/sec, drains pending requests, waits
five seconds, then measures again after diagnostic GC. The workload rotates
100 documents with 256-byte padding and allows at most 64 pending SDK calls.
`PYRIC_BASELINE_RATE` and `PYRIC_BASELINE_DURATION_MS` override the load. The
browser asserts that the requested chip configuration actually took effect.

The loader adds timing probes in memory; source files and built artifacts are
not modified. Exact replacement anchors fail if the implementation changes.
It records host queue wait, execution, snapshot/serialization/hashing, SQLite
transactions, history counts, process memory and event-loop delay. Timings are
capped at 50,000 samples per interval; samples are emitted once per second.
Weak references prevent the diagnostic registry from keeping owners alive.

After both loads, the diagnostic clears undo and observation history in the
**disposable host only**, then runs GC to help attribute retained memory. This
is not an application cleanup policy. Normal idle measurements precede forced
GC; neither forced GC nor chip-disabled performance establishes an acceptance
pass for the default product.

The output includes offered/completed/refused/error counts. Overload is an
expected diagnostic result, not an exit-code failure. CPU profiles and served
browser bundles are written beside the JSON report for resolving minified
frames. The process watchdog and `finally` cleanup stop the host, close the
browser, and delete the disposable project. User project data is never used.

The frozen acceptance workload remains `scripts/hosted-persistence-baseline.mjs`.
This instrumented comparison does not replace it.
