# First hosted combined-guard observation

> Public findings only. Original data, manifests and source snapshots are in the
> [private evidence archive](../../../../../EVIDENCE.md).

On 2026-09-19, 88 HTTPS requests exercised revision `allowance-overload-00002-86s`
in `digame-mas`, `us-east4`, using the real `allowance-experiments` Firestore
database and immediate fake inference. All 18 recorded checks passed. This is a
bounded, warm, single-instance observation, not a capacity certification.

## Results

| Phase | Requests | Outcome | Client latency |
| --- | ---: | --- | --- |
| Normal baseline | 6 | 6 completed | median 278 ms; maximum 404 ms |
| Alice burst, with other users | 50 + 6 | Alice: 3 completed, 47 user-capacity rejections; others: 6 completed | other users median 171 ms, maximum 250 ms |
| Twenty distinct users | 20 | 16 completed; 4 instance-capacity rejections | completed median 255 ms, maximum 297 ms |
| Recovery after seven-second pause | 1 | completed | 236 ms |
| Separate agent allowance | 3 | 2 completed, then quota exhausted | exhausted response 91 ms |
| Retry successful request ID | 1 | duplicate, no second inference | 196 ms |
| Invalid synthetic actor | 1 | rejected before admission | 34 ms |

Totals: 34 completed, 51 capacity rejections, 1 quota exhaustion, 1 duplicate,
1 invalid actor. No client transport errors or transaction failures. One extra
transaction attempt was observed: 72 attempts across 71 transaction invocations.
All 88 server starts, responses and work settlements were captured. The 34 fake
inference dispatches match the completed responses. New receipt count matches
admitted decisions, and saved quota balances remain within policy bounds.

All traffic used one recorded server instance. Outstanding admission peaked at
2 per user and 16 per instance. All 51 capacity rejections had zero transaction
attempts, demonstrating that overload shedding happened before Firestore.
Alice's longest successful response took 808 ms from the client and 768 ms inside
the server; its admission transaction retried once.

## What this says about the original problem

For this workload, a Node/Express gateway plus Firestore enforced both allowance
and bounded admission. Alice's burst did not prevent the six other-user requests
from completing. The local guard avoided sending 47 of her requests into
Firestore, instead of relying on Firestore contention to throttle her.

The instance guard deliberately rejected four distinct users when all 16 slots
were occupied. This is useful bounded load shedding, not a guarantee that every
well-behaved user succeeds under a distributed flood. It is also separate from a
quota denial: a busy response means retry later, not that the allowance is spent.

Recovery shows a subsequent request succeeds after work settles; it does not
prove lazy refill on its own, because Alice had credit remaining. The separate
agent case demonstrates two available agent credits and rejection of the third.
Quota correctness under sustained elapsed-time refill remains covered by the
other allowance experiments, not inferred from this recovery request.

## Comparison with local Pyric evidence

The local combined-guard case in capture `85a0edd1-b8a3-47f9-ad75-5aed664fba6b`
rejected 48 Alice requests and completed 2. This run rejected 47 and completed 3.
The server trace explains the difference: `burst-48` arrived after `burst-0`
settled, freeing a slot. Peak concurrency still never exceeded two. The local
case injected a 600 ms read delay; this hosted case injected no delay. This is
not evidence of a Pyric/Firestore semantic divergence.

The twenty-user result matched the local outcome (16 completed, 4 rejected),
but the timing environments differ. The hosted baseline's latency was higher
than other-user latency during the burst; six samples, sequential phase order,
and connection/cache warming do not support claiming the burst improved latency.

Do not run the existing strict local/production comparison against this capture:
the workload, clock, fault injection and configuration are not identical.

## Evidence and limits

- `result.json`: schema-version-2 normalized client/server observations and checks.
- `events.ndjson`: the same events in line format. Collector `elapsedMs` records
  collection time; use server `localElapsedMs` only within the same `instanceId`
  for server durations/order, and client `durationMs` for round trips. Never
  subtract a client clock from a server clock.
- `cloud-logging.json`: original Cloud Logging entries, preserving insert IDs,
  timestamps and backend run IDs. No tokens or key material are captured.
- `initial-state.json`, `final-state.json`: synthetic quota and admission records.
  The deployed namespace was reused; initial state is retained, not assumed empty.
- `workload.json`: all 88 requested operations, phases and planned timings.
- `environment.json`, `health-after.json`, `deployment-report.json`: target,
  effective configuration, revision and deployed image/source provenance.
- `source/`: exact client runner executed; `server-source/`: exact deployed source
  and lockfile, verified against live health's source hash before sending traffic.
- `manifest.json`: SHA-256 and byte length for each retained artifact.

The configured guard bounds admission work only and releases its slot before
inference; this run used immediate fake inference. It does not bound concurrent
long-running LLM calls. There is no measurement here of sustained saturation,
Express memory/event-loop pressure, cold starts, autoscaling across instances,
Firebase end-user token verification cost, disconnect/timeout drain faults, or
unguarded hosted traffic. Local limits are per instance, not distributed limits.

The next useful experiment is sustained offered load with resource telemetry and
a deliberately slow fake inference stage, preserving these admission limits and
measuring whether a separate inference concurrency budget is needed.
