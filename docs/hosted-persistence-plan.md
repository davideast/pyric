# Node-hosted persistence implementation

Status: implementation started; no release claims until every gate passes.

## Decisions

- One SQLite database at `.pyric/state/hosted/state.sqlite`, raw Storage BLOBs,
  existing structured service codecs. Node implementation only; the driver
  interface permits a future Bun adapter. SharedWorker and in-process MCP
  persistence stay unchanged.
- No legacy JSON check, importer, fallback, or dual writes. Existing JSON files
  remain untouched. A fresh hosted store starts empty unless explicitly seeded.
- Fail closed on malformed application records and unsupported or corrupt
  databases. A salvage command ships in this same PR series before hosted mode
  is announced; it is not deferred beyond release.
- Keep the existing 8 MiB hosted Storage limit. No transaction splitting, ORM,
  service-engine rewrite, speculative async worker, or streaming expansion.

## Ordered gates

0. Baseline: fix the workload/environment; measure sustained browser writes,
   SQLite WAL/FULL commits, startup, throughput, errors, memory, and event-loop
   delay. Freeze acknowledgment budgets from durable commit cost plus request
   overhead, including queueing. Keep the JSON baseline's event-loop ceiling
   separately; JSON write-and-rename is not an fsync durability baseline.
1. Foundation: Node driver, database format, validation and transactions. Prove
   reopen, rollback, bytes, version refusal and failed-start cleanup in actual
   Node subprocesses orchestrated by Bun. Reject hosted Bun with a clear message.
2. Structured state: atomic updates/deletes, stable namespace, full service
   restoration and fail-closed validation. Failure cannot advance saved hashes.
3. Storage: early backend injection, BLOB/metadata atomicity, bucket isolation,
   prefix semantics, generations, restart and limits. Other writes never scan
   or encode stored object bytes.
4. Integration: CLI/Vite lifecycle, seeds, snapshots, inspection, diagnostics,
   degraded chip/Studio status, shutdown and archive/fresh. Record startup time.
   Preserve the ownership lock's immediate rejection and test Windows retries.
5. Recovery: `pyric sandbox salvage --source <hosted-directory> --out <new-directory>`.
   Preserve source bytes; operate on a copy; produce independently validated
   output plus recovery/exclusion report. No automatic activation or empty
   replacement masquerading as successful recovery.
6. Acceptance: packaged Node/Vite, SharedWorker regression, interrupted commits,
   frozen performance gates, Orbit restart/file checks, and salvage walkthrough.

Each slice starts with a behavioral test at the agreed interface. Use focused
checks during work, required broader checks at the end. Bound/clean up all test
processes. Never claim the separate slow-client memory issue is resolved here.

## Step 0 metric definitions (accepted review wording)

- Event-loop delay: like-for-like, keep the baseline ceiling as written.
- Acknowledgment latency: an absolute budget frozen before implementation, derived from measured fsync cost on the reference machine plus existing request overhead, not from the JSON baseline.
- Throughput and error counts: as written, so dropped work cannot mask a pass.

The concrete frozen values and reference workload are in
[hosted-persistence-baseline.md](hosted-persistence-baseline.md).

## Recovery and release

Normal startup does not salvage implicitly. Physical corruption can remain
unrecoverable; report this and preserve all files. Healthy archives checkpoint
before close; damaged archives retain the closed directory including sidecars
even when checkpointing fails. Logical exports use a consistent read transaction.
Fresh affects hosted state only and preserves an archive before replacement.

The support contract must explicitly describe the Bun standalone limitation,
separate stores between runtime modes, unsupported network storage, best-effort
synced-directory warnings, and recovery commands. Manual instructions include
exact commands and expected results. Report automated, manual and skipped checks
separately. Salvage is a release gate.

## Implementation checkpoint

The SQLite owner, structured adapter, raw Storage backend, archive/fresh,
snapshots, diagnostics, and explicit salvage are implemented. Focused Node,
browser, SharedWorker, Vite and installed-package checks have passed. Step 6 is
**still open**: the stronger MCP retention tests and disposable Orbit recovery
walkthrough now pass. Native Windows checks and final combined acceptance remain. See [verification evidence and remaining work](hosted-persistence-verification.md).
