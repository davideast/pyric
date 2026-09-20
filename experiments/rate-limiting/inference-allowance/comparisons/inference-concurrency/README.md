# Local inference concurrency protection — 2026-09-19

> Public findings only. Original data, manifests and source snapshots are in the
> [private evidence archive](../../../../EVIDENCE.md).

The local experiment supports holding a separate execution reservation until the
provider operation settles. An HTTP response deadline or disconnected client is
not sufficient evidence that inference has stopped. This is a single-process
correctness result using Pyric and an observable fake provider, not a production
capacity or real-provider cancellation result.

## Evidence

Primary capture: [b4b8a9af-13c9-4e27-b582-971c46284c3b](../../results/b4b8a9af-13c9-4e27-b582-971c46284c3b/).
Executed source revision: `ddf20925`. Nine cases, 65 offered inference requests,
102 assertions: 101 passed and one deliberately failed negative-control bound.
The experiment assessment passed with no missing coverage. Every case drained
its reservations; no client transport errors were observed. The two deliberate
client disconnects are recorded separately from responses/errors.

The capture retains normalized events, complete source, workload, transaction
observations, timing/resource summaries, assertions, and integrity hashes. This
HTTP suite does not export before/after database snapshots; its assertions rely
on recorded operations and outcomes. Streaming receipt acknowledgements use extra loopback HTTP requests that
are not counted as inference requests; process resource observations include
that instrumentation. Clocks are joined only within a process. Provider joins
use invocation attempt and instance IDs, not user-supplied request IDs.

An earlier capture,
[21304238-d3cf-4688-84cb-36ee8d8efffb](../../results/21304238-d3cf-4688-84cb-36ee8d8efffb/),
is retained unchanged. Its inherited top-level `workload.inference` label says
`fake-immediate`, although its scenario configuration and source correctly show
the delayed lifecycle provider. The primary capture fixes that provenance label.
Do not treat these as source-identical paired runs; their implementation hashes
differ. Observed decisions were the same.

## Observations

| Case | Observed result |
| --- | --- |
| Admission-only control | All six calls completed; six providers overlapped, violating the proposed limit of two. |
| Per-user execution guard | One overlapping request rejected; three completed, including another user and later recovery. At most one provider call per user. |
| Per-instance execution guard | Two completed, four rejected; peak provider calls and reservations both two. Rejected attempts performed no database transaction. |
| Streaming | All three chunks received in order; server observed receipt acknowledgement before settlement. Overlapping request rejected; subsequent work recovered. |
| Timeout, cancellation ignored | Client received a timeout around the configured 200-ms deadline. Work settled another 449 ms after the gateway response; retry remained blocked while it ran. |
| Disconnect, cancellation ignored | Disconnect after the first chunk requested cancellation but work continued for another 443 ms after the gateway outcome. Capacity stayed reserved. |
| Cancellation confirmed | Fake provider confirmed cancellation after its configured delay; work settled 201 ms after the gateway outcome. Capacity released only on settlement. |
| Provider failure and duplicate retry | Original outcome unknown; duplicate did not dispatch again; new request completed. No automatic refund or retry. |
| Short sustained arrivals | Alice: four completed, 20 rejected. Bob and Carol: all six completed. Peak provider calls three; final reservations zero. |

The sustained case offers Alice 24 requests over 1.84 seconds. It is not a soak
test. Measurements are observations of this fixture and local environment, not
latency budgets or throughput claims for Firestore/Cloud Run.

## Interpretation and next boundary

The progression is **transactional allowance enforcement → admission concurrency
control/load shedding → inference execution concurrency control**. The new gate
reserves execution capacity before allowance work, so rejected attempts cannot
consume quota. Reservations include admission time; actual provider calls are
measured independently. This sacrifices some utilization to avoid spending an
allowance on a request that has no execution capacity.

Timeouts bound client waiting but do not prove provider cancellation. Releasing a
slot on timeout would permit replacement work while the old inference is still
running. The observed residual work demonstrates why settlement must own release.
A real adapter must not equate a rejected local fetch with confirmed remote
termination unless the provider contract supports that conclusion.

The next comparison can run the same fake-provider workloads on Cloud Run with
Firestore, preserving workload and implementation hashes and recording runtime
configuration. Real AI Logic streaming and cancellation need a separate bounded
contract experiment before claiming this protects actual provider execution.
Multi-instance limits/fairness, process death and restart, never-settling work,
streaming backpressure, and long-duration resource stability remain untested.
A never-settling operation conservatively holds capacity until process exit.

## Reproduce

From the repository root:

```sh
bun experiments/rate-limiting/inference-allowance/run.mjs verify experiments/rate-limiting/inference-allowance/results/b4b8a9af-13c9-4e27-b582-971c46284c3b
bun experiments/rate-limiting/inference-allowance/run.mjs replay experiments/rate-limiting/inference-allowance/results/b4b8a9af-13c9-4e27-b582-971c46284c3b --out /tmp/inference-replays
bun experiments/rate-limiting/inference-allowance/run.mjs run --config experiments/rate-limiting/inference-allowance/config/inference-concurrency.json --out /tmp/inference-results
bun test experiments
```

Validation: 41 experiment tests passed (283 assertions); the final metadata
regression also passed (five assertions). Scoped TypeScript checking passed.
Standards/spec reviews were completed and their evidence-quality findings fixed.
Nothing was deployed or pushed, and no real AI requests were made.
