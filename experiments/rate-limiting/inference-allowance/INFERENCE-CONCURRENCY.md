# Inference concurrency protection: local pilot

Scope: extend the existing public HTTP experiment runner, Pyric Admin transaction
adapter and source-inclusive capture/replay workflow. These are the previously
approved test seams. No Cloud Run deployment or paid model calls in this milestone.
Baseline for review: commit 3888377f. Historical captures stay unchanged.

Hypothesis: separate per-user/per-instance execution reservations, held until the
provider operation settles, bound active inference even after HTTP timeout or
client disconnect. Admission-only control does not provide that bound.

Reserve execution capacity after identity/request validation but before allowance
transactions, so a capacity rejection cannot debit quota. This conservatively
includes admission time in reserved execution capacity. Track reservations and
actual provider operations separately. Release on settlement, never merely on a
response, timeout, abort signal, or first streaming chunk. Preserve existing
conservative dispatch receipts; do not refund ambiguous outcomes or promise an
exactly-once provider result.

Validate through real Node/Express HTTP and observable fake-provider events:
- Admission-only negative control exceeds the proposed execution limit.
- Per-user and aggregate execution limits reject excess work before Firestore.
- Streaming retains capacity through the final chunk/settlement. The client
  acknowledges received chunks over a separate loopback HTTP request; the server
  must observe the first acknowledgement before provider settlement. Complete
  streams must deliver every expected chunk in order. This avoids comparing
  timestamps from separate processes.
- Execution deadlines and disconnected clients request provider cancellation;
  ignored cancellation retains capacity until eventual settlement.
- Confirmed cancellation and provider errors release capacity; subsequent work
  succeeds. Duplicate retries never invoke the provider again.
- Sustained arrivals preserve bounded concurrency, other-user progress and final
  drain; collect client/server timing, memory and event-loop observations.
- All captures retain code, workload, environment, events, checks and limitations;
  incomplete coverage fails. Legacy admission tests and replay continue to pass.
  Provider lifetime joins use gateway attempt and instance IDs, not the
  user-supplied request ID, which may repeat across users.

This is per-process protection, not distributed fairness or a global semaphore.
Fake cancellation completion is an adapter contract; real-provider cancellation
must be verified separately. A provider that never settles holds its slot until
process exit; response deadlines do not safely reclaim that work.
