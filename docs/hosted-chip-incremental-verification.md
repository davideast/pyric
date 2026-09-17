# Incremental runtime-chip processing

The chip now consumes listener and incident events incrementally and reuses
Traffic projections for retained events. No worker, scheduling delay, history
limit, undo limit, or durability change was introduced.

Implementation base: `b5fb30008c421dad617f06fb370c961af03d804c` plus this change
(uncommitted when measured). Measurements use Node 22.15.0 on an Apple M3 Pro with 18 GiB
RAM. Source digests accompany the measured results.

## Behavior and design

- The existing active-listener fold now supports both a snapshot reader and a
  persistent state object. The chip uses that same implementation for incoming
  batches, retaining current listener state instead of the complete raw history.
- The activity monitor lives for the chip's lifetime. Hydration and later events
  pass through the same fold; duplicate-event and session-boundary behavior
  continues to come from the existing monitor. A supplied custom historical
  incident reader still receives its complete history as before.
- Traffic caches projections only for its current retained snapshot. Evicted
  events leave the cache; replacing an event when evidence expires invalidates
  its projection. Pending/completed operations, omission counts and pinned
  details keep their existing semantics.
- Reading Traffic still enumerates its retained rows, and rendering still uses
  current listeners and SDK activity. This change eliminates repeated historical
  decoding and listener/incident replay; it does not make every UI operation
  constant-time. The measured workload does not require an additional worker or
  render coalescing.
- Browser verification exposed a pre-existing synchronous-hydration startup
  error: Traffic's callback read `tab` before initialization. The mounted guard
  now returns before reading view state during hydration.

## Performance results

The final default-chip workload completed all 12,000 writes at 200/sec, with
zero service errors and zero harness refusals. Acknowledgment p95 fell from
358.5 ms in the reproduced pre-fix run to **3.0 ms**. Peak pending calls fell
from the harness ceiling of 64 to 3. Durability and queue budgets were unchanged.

| Workload | Completed/offered | Errors/refusals | Ack p95 | Worst host 10-second loop p95 |
|---|---:|---:|---:|---:|
| 200/sec, 60 s | 12,000/12,000 | 0/0 | 3.0 ms | 2.648063 ms |
| 50/sec, run 1 | 3,000/3,000 | 0/0 | 5.6 ms | 3.655679 ms |
| 50/sec, run 2 | 3,000/3,000 | 0/0 | 5.4 ms | 3.307519 ms |
| 50/sec, run 3 | 3,000/3,000 | 0/0 | 5.4 ms | 3.692543 ms |

All three frozen 50/sec runs pass the original 25 ms acknowledgment and
4.382719 ms event-loop ceilings. The 200/sec run's largest sampled host RSS was
412.4 MiB; this is not a continuous peak or the separate memory acceptance test.
The workload cycles over 100 Firestore documents with 256-byte padding and a
maximum of 64 outstanding calls. It does not establish multi-client capacity
or capacity for larger datasets. [Raw measurements and source digests](hosted-chip-incremental-results.json).

## Verification boundaries

The final focused selection passed **242 tests, 1,328 assertions, in 8.03 s**.
Pyric and CLI TypeScript builds passed. Changed-code-form reported zero issues
across 11 changed TypeScript files; whitespace checks passed.

The regression tests first demonstrated historical event reprocessing, then
passed after implementation. Coverage includes hydrated attachments followed by
live duplicate-listener incidents, immutable prior snapshots, detach, session
boundaries, duplicate deliveries, evidence expiry, pending operations during
retention eviction, and synchronous chip hydration. Existing controls retain
service filtering, pause/resume, request details, Overview and Flow behavior.

Real browser checks passed for in-page and SharedWorker SDK reads/listeners,
Flow treatments, Overview badges, compact layout, source grouping and denial
links: 13 cases in `sdk-flow.pw.ts`. Hosted listener reconnection and SharedWorker
AI Traffic (live completion, noisy history, pause/resume, filtering and late
Studio access) also passed: 2 cases in 7.5 seconds.

The Flow suite is **not** wholly green: its in-page signed-in project-denial
scenario still displays the earlier ownership request while expecting the role
scenario's `editor` text. It fails at `sdk-flow.pw.ts:303`. Replacing the four
incremental chip modules with their HEAD versions, while retaining only the
startup guard, reproduces the same failure. Sources were restored immediately
after this comparison. The corresponding worker scenario was not run after the
suite's first-failure stop. This unrelated selection/fixture issue remains open.

The full hosted browser suite and full monorepo suite were not run. This is
agent-operated verification, not a manual device sign-off. Undo retention and
the separate slow-reader memory acceptance test remain open.

## Reproduce

Build once, then run the targeted checks from the worktree root:

```sh
bun x tsc -p packages/pyric/tsconfig.json
bun x tsc -p packages/cli/tsconfig.json
bun test packages/cli/test/serve/runtime/chip*.test.ts \
  packages/cli/test/serve/runtime/listener*.test.ts \
  packages/pyric/test/sandbox/active-listeners.test.ts \
  packages/pyric/test/sandbox/event-history-retention.test.ts \
  packages/pyric/test/firestore/sandbox/activity-monitor.test.ts
E2E_BASE=http://127.0.0.1:1 node node_modules/@playwright/test/cli.js test \
  sdk-flow.pw.ts --config packages/cli/test/e2e/playwright.config.ts \
  --grep-invert 'signed-in project denials' --workers 1 --max-failures 1
node node_modules/@playwright/test/cli.js test \
  worker-ai-traffic.pw.ts reconnect-listener.pw.ts \
  --config packages/cli/test/e2e/hosted/playwright.config.ts \
  --workers 1 --max-failures 1
PYRIC_BASELINE_RUNS=1 PYRIC_BASELINE_RATE=200 \
  PYRIC_BASELINE_OUTPUT=/tmp/pyric-chip-200.json \
  node scripts/hosted-persistence-baseline.mjs
PYRIC_BASELINE_RUNS=3 PYRIC_BASELINE_RATE=50 \
  PYRIC_BASELINE_OUTPUT=/tmp/pyric-chip-50.json \
  node scripts/hosted-persistence-baseline.mjs
```

Use Node 22.15 or later. Each benchmark run defaults to 60 seconds. Run workloads
sequentially without competing builds or tests. The Flow fixture owns its server;
`E2E_BASE` disables the unrelated shared test server. The explicit exclusion is
the known failing scenario described above, not evidence that it passes.


All benchmark and browser-test hosts exited. Process inspection found no
remaining matching workload or fixture processes. Existing user servers were
left running.
