# Experiment: fair allocation under contention

## Goal and uncertainty

Determine whether a noisy user or long-running workload can monopolise execution
capacity, whether a fair allocation policy improves other users' progress, and
whether the Firestore coordination records become the limiting resource. This is
an allocation/contended-ledger experiment with controlled fake work, not an LLM
benchmark or a proposal to add a queue merely because queues are familiar.

**Status: build brief only. This directory currently contains only this README.**
Follow the [shared build and evidence contract](../README.md#common-implementation-contract-for-all-four-briefs).
All code paths, profiles and commands below are proposed. Build locally first;
stop before Cloud Run deployment and obtain explicit approval for each deployment.

The hypothesis is conditional: bounded per-user scheduling may reduce starvation
at a coordination/utilisation cost; the existing per-user cap may already be good
enough for some workloads. Establish the trade-off rather than presupposing that a
more complicated scheduler or sharded ledger wins.

## Prior experiments and comparison boundaries

- [First allowance comparison](../inference-allowance/comparisons/first-hosted/README.md):
  correct allowance accounting coexisted with timeouts and delayed native settlement.
  Safety alone did not establish progress for other users.
- [Execution protection comparison](../inference-allowance/comparisons/hosted-execution/README.md):
  short hosted arrivals protected Bob/Carol while Alice was rejected more often.
  This was not a sustained fairness or saturation experiment.
- [Distributed hosted results](../distributed-capacity/hosted/RESULTS.md): 16 starts
  competed for three slots, with at most two per user; 15 extra hosted transaction
  attempts appeared. These mixed 106-command timings are not a capacity benchmark.
- [Integrated admission](../integrated-admission/README.md): use its stable admission,
  idempotency and accounting contract for all allocation variants. If unavailable,
  build only the arrival/oracle scaffold; do not claim integrated allowance behaviour.
- [Automatic recovery](../automatic-recovery/README.md): unknown jobs retain capacity.
  Keep that safety rule unchanged when comparing fairness policies.

Reuse native transaction instrumentation, the separate HTTP arrival generator
pattern from the allowance experiment, public Pyric setup, source capture and the
log collector. Inspect the existing `http-*` and `execution-*` scenario files,
`harness/` arrival scheduling and `analysis/http-summary.mjs` rather than writing
an uninstrumented loop that waits for each response before sending the next request.

## Variants: change one mechanism at a time

Implement these three labelled variants with the same global capacity, per-user
cap, allowance policy, fake provider durations, payload distribution and seed:

1. **Immediate admission baseline:** existing first-arrival transactional capacity
   reservation; reject busy work without queueing. This may be the best simple choice.
2. **Bounded FIFO:** durable bounded queue, global FIFO selection and the same
   per-user execution cap. This separates the effect of queueing from fairness.
3. **Bounded per-user round robin:** same queue budget and accounting, but choose
   among backlogged users in round-robin order. Start with equal user weights.

Declare the gateway admission limits and hold them fixed across variants. Record
admission-guard rejections separately from queue overflow and execution-busy
outcomes; do not disable the existing overload gate to make a scheduler look busy.

For queued variants use the same global queue limit and per-user queue limit. Both
limits must be enforced at enqueue, not only in the client. A concrete initial
fixture is 24 pending jobs globally and 8 per user, with execution capacity 3 and
per-user running capacity 2. Keep queued and executing counts separate. No queued
job consumes execution capacity or allowance until it is admitted to execution;
validate user/category/payload and bind the request ID when enqueuing. Expired or
cancelled queued work must not later dispatch. When execution admission discovers
quota exhaustion, persist a terminal denied outcome and remove the queue obligation.

An immediate rejection is a legitimate baseline outcome, not a missing queued job.
Use one logical-request denominator across variants and record queue admission,
execution admission and completion as separate outcomes. Suppress client retries
in the first profiles so retry behaviour cannot obscure allocation effects.

The queue selector must coordinate multiple gateways through Firestore. Querying a
candidate is not a claim; recheck it in an atomic transaction before marking it
selected. Persist the cursor/selection state required for the declared ordering.
Make tie-breaking deterministic, preserve native transaction retries and record
selection reads/writes. A per-process round robin is not distributed fairness.

Keep the original global capacity counter in all three variants first. **Do not
simultaneously shard the counter, change allowance rules, increase capacity and
introduce round robin.** If evidence identifies the counter as a bottleneck, propose
and separately version a follow-up allocation-storage variant, preserving a strict
capacity bound. A distributed approximate counter is not a drop-in safety gate.
Weighted token-cost fairness and priority classes are deferred until equal-weight
results identify a need and costs can be measured rather than guessed.

## Proposed implementation layout

```text
fair-allocation/
  architecture/immediate.mjs           # Existing admission policy adapter
  architecture/fifo.mjs                # Bounded enqueue and global FIFO selection
  architecture/round-robin.mjs         # Same queue + distributed user rotation
  architecture/queue.mjs               # Shared idempotent queue lifecycle
  services/gateway.mjs                 # Enqueue/reject, status and stop endpoints
  services/dispatcher.mjs              # Selection, execution admission, dispatch
  services/provider-oracle.mjs         # Fixed/seeded fake durations and actual overlap
  harness/arrivals.mjs                 # Open-loop schedule, independent of responses
  harness/runner.mjs                   # Variant/cohort execution and hard budgets
  fixtures/workloads.mjs               # Versioned users, offers, durations and limits
  adapters/pyric.mjs
  adapters/firestore-admin.mjs
  scenarios/*.mjs
  analysis/metrics.mjs                 # User/cohort distributions and denominators
  analysis/assess.mjs                  # Invariants, coverage, schedule fidelity
  config/local.json
  config/hosted.example.json
  tests/*.test.ts
  capture-definition.mjs
  execute.mjs
  run.mjs
  results/<runId>/...
```

Use `fairAllocationExperiments/{runId}/cases/{caseId}` with requests, quotas,
capacity, user counters, bounded queue entries and scheduling cursor documents.
Persist only state needed by the tested mechanism. Retain query/index definitions,
transaction read/write counts and the exact ordering contract as captured source.
No analytics warehouse, separate broker or production UI is needed for this pilot.

## Build sequence

1. Reproduce immediate admission with the new runner and verify the old capacity
   invariants through the public HTTP/Pyric boundary before adding queueing.
2. Build an independent arrival process. Emit planned and actual send times even
   if previous requests are pending. Bound its outstanding sockets and report a
   missed arrival as generator saturation; never silently delay offers and call
   the resulting lower load the planned workload.
3. Implement FIFO and its bounded/cancellable/idempotent queue lifecycle. Define
   enqueue ordering at the committed selector contract, not the client's timestamp.
   Add TDD cases for duplicate enqueue, changed payload, queue overflow, expiry,
   cancellation, racing selectors and native retry.
4. Implement round robin by changing selection only. The baseline/FIFO/round-robin
   variants share the integrated admission state machine and provider fixture.
5. Add cohort metrics and negative controls before collecting comparative data.
   Use an intentionally unbounded/no-user-cap local fixture to demonstrate that
   overlap/starvation measurements can reveal the designated failure.
6. Collect deterministic correctness runs, then a separate wall-clock profile with
   sustained scheduled arrivals. Use seeded fake durations; measure actual provider
   occupancy independently of reservations.
7. Run local comparisons with 10 declared seeds per profile/variant where practical.
   Preserve every run, including generator saturation and assertion failures. Do
   not select only the fastest run or silently trim the warm-up after seeing results.
8. Prepare a hosted fake-provider plan, declare the total experiment budget across
   variants/repetitions, and stop for deployment approval. Run one small paired
   hosted profile first; larger sweeps need an explicitly accepted budget.

## Workloads to specify exactly

Start with global execution capacity 3 and per-user running capacity 2. Use generous
but identical allowances in the capacity/fairness profiles so quota exhaustion does
not explain every rejection; add a separately named low-allowance interaction case.
Use the same complete offer list, logical IDs and provider duration assignment
across variants. Record the absolute/relative schedule and its hash.

| Workload | Purpose and required observations |
| --- | --- |
| Balanced backlogged users | Check equal-weight rotation, useful throughput, bounds and completion shares. |
| One noisy, two quiet users | Measure quiet users' admission/completion opportunity, rejects and wait tails while the noisy user remains backlogged. |
| Short and long operations | Determine whether long work monopolises slots and how selection affects short-job progress; keep duration assignments fixed. |
| Distinct-user burst | Separate global ledger contention from one user's quota-document contention. |
| Duplicate offer storm | Same logical key from multiple gateways must not occupy multiple queue positions or dispatch twice. |
| Queue overload | Enforce global/per-user pending limits; rejected jobs create no unbounded retained work. |
| Queue cancellation and expiry | Race selection against stop/expiry; at most one transition grants dispatch. |
| Unknown running work | Retain its slot; fairness must not release it to improve a latency statistic. |
| Selector restart / competing selectors | Durable ordering/ownership avoids double dispatch and permanent cursor starvation. |
| Allowance exhaustion interaction | Denied queued jobs are accounted for and do not indefinitely block eligible users. |

A concrete first wall-clock noisy-user profile offers Alice 5 requests/second for
20 seconds and Bob/Carol 1 request/second each over the same interval: 140 total
requests, with fake duration 200 ms. Add a distinct duration-mix profile using a
precomputed seeded list of 200-ms and 1,000-ms jobs. Run the balanced/burst cases
as separate profiles. These fixture choices make a bounded pilot; they are not a
model of production traffic or real LLM latency. Record whether overload actually
occurred; if it did not, do not claim the profile established overload fairness.

## Metrics and independent checks

Enforce in every variant: global/per-user active bounds, bounded pending queue,
unique logical execution, consistent allowance accounting, no release of unknown
work, and no dispatch after an effective queued cancellation/expiry. Use the
separate provider oracle to measure running work, not just database counters.

Record offered, sent, queue-admitted, execution-admitted, completed, quota-denied,
capacity-rejected, queue-rejected, expired, cancelled, failed and unresolved counts
per UID and workload cohort. Also retain per-request queue wait, end-to-end time,
provider service time, transaction invocations/attempts, read/write observations,
selection work, occupancy over time and oldest waiting age.

Report p50/p95/max only with their exact population and sample size. Rejected jobs
have no execution wait; unresolved queued jobs have a censored lower bound, not a
zero duration. Include completion by a fixed observation horizon, so a variant
cannot appear fair by excluding every request it rejected. Avoid coordinated
omission: slow responses must not reduce offered arrivals unnoticed.

For continuously backlogged equal-weight users, compute service/completion shares
and Jain's index with the exact cohort and formula recorded. Do not mix quiet
low-demand users into that index and call lower raw throughput unfairness. For
quiet users, report fulfilled eligible demand, rejection frequency and wait tails.
Define eligibility from declared policy rather than retroactively excluding a user
whose work was expensive to serve. Present utilisation/throughput alongside fairness.

Transaction retry counts alone do not prove which document caused contention.
Correlate measured transaction paths, native outcomes and latency; use a separately
controlled follow-up before assigning causation to the shared global counter.
No fixed production capacity/latency claim follows from a 20-second pilot.

## Comparisons and acceptance

- **Technique comparison:** immediate vs FIFO vs round robin, identical offers,
  provider schedule, budgets and safety checks. Policy-selection code differs by
  design; mark hashes different and compare only declared dimensions.
- **Backend comparison:** one variant at a time on Pyric and Firestore using the
  same archived implementation/profile. Pair decisions and invariant checks;
  separately report hosted latency/retries. Different timer/jitter behaviour is
  evidence, not something to smooth away to force matching admissions.
- **Historical comparison:** explain how the new workload extends the older 16-start
  capacity case and short execution workload. Their older latency figures are
  context, not interchangeable measurements or statistically matched baselines.

Predeclare safety assertions and workload-specific fairness questions. Do not invent
one universal acceptable p95 or fairness threshold after observing data. It is a
successful experiment if complete evidence shows the simple baseline is sufficient,
round robin helps at a cost, or no variant meets the desired target. Algorithm
readiness and experiment completeness are separate verdicts.

## Proposed commands — not executable until built

```sh
bun test experiments/rate-limiting/fair-allocation/tests
bun experiments/rate-limiting/fair-allocation/run.mjs run --config experiments/rate-limiting/fair-allocation/config/local.json --out /tmp/fair-allocation
bun experiments/rate-limiting/fair-allocation/run.mjs verify CAPTURE
bun experiments/rate-limiting/fair-allocation/run.mjs analyze CAPTURE
bun experiments/rate-limiting/fair-allocation/run.mjs replay CAPTURE --out /tmp/fair-replay
bun experiments/rate-limiting/fair-allocation/run.mjs compare BASELINE_CAPTURE ROUND_ROBIN_CAPTURE --mode variant --out /tmp/fair-variant.json
bun experiments/rate-limiting/fair-allocation/run.mjs preflight --config /tmp/fair-hosted.json
# Only after hosted workload authorisation and separately approved deployment:
bun experiments/rate-limiting/fair-allocation/run.mjs run --config /tmp/fair-hosted.json --allow-production --out /tmp/fair-hosted
bun experiments/rate-limiting/fair-allocation/run.mjs baseline HOSTED_CAPTURE --out /tmp/fair-baseline
bun experiments/rate-limiting/fair-allocation/run.mjs compare PYRIC_CAPTURE HOSTED_CAPTURE --mode backend --out /tmp/fair-backend.json
```

Initially cap each hosted profile at 200 offered inference requests, global fake
execution concurrency 3, native maxAttempts 8, and an explicitly bounded number of
selector sweeps/status polls plus total duration. Approval must cover the sum across
all variants/repetitions, not an ambiguous “200 requests” repeated indefinitely.
Use fresh run/case namespaces; avoid overlapping comparison runs that would create
uncontrolled project-level contention. Record unrelated traffic if observed.

Deliver source-inclusive captures, a comparison table with uncertainty/denominators,
and a recommendation limited to the measured envelope. Make a follow-up proposal
for ledger partitioning or weighted fairness only if the data exposes that need.
Do not expand this into autoscaling configuration, dashboards or a rollout project.
