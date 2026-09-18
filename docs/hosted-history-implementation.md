# Durable hosted history implementation

Implemented on top of `8f12407a`, September 17, 2026. The scope is all
host-observed activity, internal Firestore undo/redo, and backup-only exports.
SQLite remains authoritative. Cache eviction and export rotation never delete
history. See [the contract](hosted-history-contract.md) for limits and commands.

## Acceptance ledger

- [x] Atomic state/history transactions and schema-1 migration in real Node.
- [x] Bounded hosted engine history; exact undo/redo after eviction and restart.
- [x] All-service observation capture, bounded batching and explicit health.
- [x] Paginated inspection and authenticated live/offline CLI access.
- [x] Verified, restartable 64 MiB / 60 second rotating exports.
- [x] Salvage, startup validation, shutdown and crash boundaries.
- [x] Focused regressions and SharedWorker parity.
- [x] Frozen 50/sec gate, 200/sec with/without exports, memory gate.
- [x] Final review, recorded limitations and owned-process cleanup.

## Behavioral verification

The final real-Node SQLite run passed **23/23 in 10.56 seconds**, including the
final failure-accounting checks and the snapshot fixture from the package cwd.
The suite covers the existing persistence contract and
history additions. It exercises atomic rollback, schema migration, restart,
1,100 writes and 1,050 undos across cache eviction, redo invalidation, exact
batch/transaction results, reset boundaries, all six service event sources,
live HTTP authentication, project identity, offline ownership, CLI export and
verification, and process termination around archive fsync/rename boundaries.

Recovery regressions cover corrupt history payloads, malformed store identity,
and undo indexes referring to excluded journal rows. Salvage reports exclusions,
resets the active undo chain, preserves the original and reopens the repaired
copy before reporting success. Pagination rejects future high-water marks.
The common value codec preserves typed values, special numbers and literal
marker-shaped maps, including a decoder run without the Node Buffer global.

The disposable Orbit checkpoint passed: David and Alice signed in through two
independent browser contexts, shared a message, retained it after reload, and
inspected/exported/verified history through actual CLI subprocesses. This is
automated browser evidence; it does not claim a new manual user observation.
The test removes its own project, contexts and Vite server. The combined final
browser run passed all three tests in 10.5 seconds: Orbit, hosted listener
reconnection with the original identity, and independent SharedWorker AI
inspection before/after noise and from a later Studio.

Core regression run: **7,605 passed, 9 skipped, zero failures**, 38.82 seconds.
A regression in redo diagnostic text was corrected to retain the existing
message. An older rules test was corrected to pass its required `null` auth
argument. No rules evaluator behavior or conformance registry rows changed.

The initial full CLI run took 128.84 seconds: 3,800 passed, 18 skipped, 8 failed.
One failure was a cwd-dependent path in the existing SQLite snapshot fixture;
that fixture now uses the same built-artifact import mechanism as its peers and
passes in the final focused run from the package cwd.
The seven remaining failures were resolved in the follow-up CLI acceptance pass:

| Test | Resolution |
| --- | --- |
| Published dependency closure | Allow only the exact live adapter Firebase import edges; packed consumers prove application-owned SDK resolution and SDK-free sandbox operation. |
| Sandbox tool inventory | Include the already registered `messaging_deliveries` tool. |
| Sandbox help surface | Permit existing diagnostics and sessions subcommands while retaining the prohibition on bare `serve`. |
| `can-i-use` lazy help | Resolve SQLite with `process.getBuiltinModule` after Node admission, avoiding Bun loader resolution of an unused static import. Node ownership reuses that adapter; Bun ownership retains its existing adapter. |
| Fresh guardrail wording | Expect the existing `--hosted` alternative; still reject `--fresh` without either persistence option. |
| Composite-filter error text | Report empty composites and non-filter children explicitly before query execution in both transports. |
| Worker export inventory | Retain and document `getHostedFirestore` and `readHostedTarget`, which Studio and Playground consume. |

The follow-up full CLI run passed **3,808 tests, 18 skipped, zero failures** in
127.90 seconds, including the real-Node SQLite suite. CLI typechecking passed.
Four focused browser checks passed in 12.8 seconds: query validation and healthy
listeners in hosted and SharedWorker modes, plus Studio's Node-hosted connection
and restart recovery with SharedWorker available and unavailable.

Two isolated npm installations passed the packed-resolution smoke: one consumer
with Firebase and Vite, and one without Firebase. Exact import exceptions cover
live adapters only; no Firebase runtime dependency was added. The smoke also
verifies that live adapters resolve the consumer's SDK. Review corrected its
expected path normalization for Windows; this run was on macOS and does not
claim Windows execution.

## Performance and memory

Use the unchanged [frozen gates](hosted-persistence-baseline.md): 25 ms
acknowledgment p95, 4.382719 ms worst ten-second event-loop p95 at 50 writes/sec,
all offered operations completed, zero errors and zero harness refusals.
The separate slow-reader RSS-growth ceiling stays at 192 MiB.

The three 50/sec runs completed **9,000/9,000** writes, with zero errors or
refusals. Acknowledgment p95: **5.7 / 5.9 / 5.8 ms**. Worst ten-second
event-loop p95: **4.081663 / 4.073471 / 4.093951 ms**.
Raw measurements are in [hosted-history-verification.json](hosted-history-verification.json).
The final failure-counter/failed-read-queue corrections were covered by targeted
regressions after load testing; load tests were not repeated for those error-path
changes.

At 200 writes/sec, both 60-second runs completed all 12,000 operations with zero
errors or refusals. Acknowledgment p95 was 3.5 ms without export and 7.1 ms with
continuous export. The latter verified 72,008 journal records in two segments.

The unchanged slow-reader browser test passed twice, two cycles per test.
**Later acceptance:** the [2026-09-17 multi-client verification](hosted-multiclient-verification.md)
re-ran that test and measured 269.3 MiB growth against the same 192 MiB limit.
The memory gate is open again; the passing measurements below are historical.
Measured RSS growth was 32.1, 134.4, 58.8 and 79.2 MiB. Healthy-client p95 was
95.2–99.1 ms; the stalled reader was disconnected at the existing backlog limit.
Earlier failing measurements prompted removal of duplicate undo payload storage;
the final compiled runs passed without forcing garbage collection or relaxing
the memory ceiling. RSS is runtime-dependent; this evidence is a bounded workload,
not a claim that total host RAM is independent of current database size.

Startup probe: 100 current documents, 256-byte padding, three warm-process
samples at each history size. It measures database/index opening, current-state
validation and `createHostedRuntime` readiness separately; it excludes CLI process
launch, bundling and browser navigation.

| Prior writes | Journal records before probe | Host ready | Current-state validation | Undo cache on open |
| --- | ---: | --- | --- | --- |
| 100 | 401 | 3.5–6.3 ms | 1.0–2.7 ms | 0 entries / 0 bytes |
| 1,000 | 4,001 | 4.0–4.8 ms | 0.5–1.1 ms | 0 entries / 0 bytes |
| 10,000 | 40,001 | 24.6–26.3 ms | 0.6–1.2 ms | 0 entries / 0 bytes |

Startup checks undo indexes, so its cost grows with index size. Historical
payloads are not decoded into the cache during startup. These observations do
not introduce a new startup SLA.

## Reproduce focused checks

Run from the repository root with Node 22.15+ on PATH and built core/CLI packages:

```sh
bun x tsc -p packages/pyric/tsconfig.json
bun x tsc -p packages/cli/tsconfig.json
PYRIC_TEST_NODE="$(command -v node)" bun test packages/cli/test/serve/hosted-sqlite.test.ts
node node_modules/@playwright/test/cli.js test history-orbit.pw.ts worker-ai-traffic.pw.ts reconnect-listener.pw.ts --config packages/cli/test/e2e/hosted/playwright.config.ts
node node_modules/@playwright/test/cli.js test section-five-slow-client.pw.ts --repeat-each=2 --config packages/cli/test/e2e/hosted/playwright.config.ts
node node_modules/@playwright/test/cli.js test query-structure.pw.ts section-six-studio.pw.ts --grep 'validates query structure|Studio observes' --config packages/cli/test/e2e/hosted/playwright.config.ts
PYRIC_BASELINE_RATE=50 PYRIC_BASELINE_RUNS=3 node scripts/hosted-persistence-baseline.mjs
PYRIC_BASELINE_RATE=200 PYRIC_BASELINE_RUNS=1 node scripts/hosted-persistence-baseline.mjs
PYRIC_BASELINE_RATE=200 PYRIC_BASELINE_RUNS=1 PYRIC_BASELINE_EXPORT=1 node scripts/hosted-persistence-baseline.mjs
node scripts/hosted-history-startup.mjs
```

Run load measurements sequentially. Every harness owns and closes its hosts,
browsers and disposable directories. The implementation keeps Node-only hosted
persistence, the existing SharedWorker path, and the existing internal undo API.
There is no new undo UI, automatic pruning, automatic archive deletion or general
replay/restore tool. Durable history and exports may contain application data;
keep backup destinations private. Export is optional and SQLite disk growth is
intentional until a separate retention policy is designed.

## Review

Independent specification and standards reviews found and prompted fixes for
archive-chain verification, bounded undo-link bookkeeping, persisted identity
validation, retained engine inspection, and salvage of excluded undo records.
Focused regression tests cover those fixes. The shared codec and schema are
reused across disk, HTTP and archive validation; no extra export-state table or
second copy of durable undo payloads remains.

The CLI acceptance follow-up received independent specification and standards
reviews. No unresolved findings remain after the packaging path normalization fix.

Both package typechecks pass, the changed-code-form check reports zero issues,
and `git diff --check` passes. Final process inspection found no matching owned
test hosts or fixture processes. The remaining directory from the first failed
Orbit attempt was inspected and removed; existing user servers were left running.
