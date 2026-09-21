# Experiment: integrated admission and accounting under failure

## Goal and uncertainty

Determine whether one request can atomically acquire an allowance and execution
capacity, dispatch conservatively, and settle or refund according to an explicit
policy despite retries, crashes and lost acknowledgments. Existing experiments
validate these mechanisms in isolation; they do not establish the composed flow.

**Status: build brief only. This directory currently contains only this README.**
Follow the [shared build and evidence contract](../README.md#common-implementation-contract-for-all-four-briefs).
The files and CLI below are proposed. Build and collect local evidence first;
Cloud Run deployment and live-model requests require separate explicit approval.

Primary hypothesis: a transactional admission receipt that binds the payload,
allowance debit and capacity reservation can prevent partial admission and duplicate
accounting; database transactions still cannot atomically commit a remote AI call.
Unknown post-dispatch outcomes therefore remain charged and retain capacity unless
authoritative provider evidence permits settlement. This experiment uses fake
inference; it does not need paid AI to test accounting correctness.

## Baselines to inspect before implementation

- [Allowance contract](../inference-allowance/README.md) and
  [first hosted results](../inference-allowance/comparisons/first-hosted/README.md):
  a request timed out while its debit later committed. Never refund based on the
  caller's deadline or assume an unacknowledged transaction rolled back.
- [Admission implementation](../inference-allowance/architecture/admission.mjs):
  receipt/payload binding and lazy integer-unit refill.
- [Bucket arithmetic](../inference-allowance/architecture/bucket.mjs): reuse it;
  do not rewrite refill arithmetic inside the new gateway.
- [Capacity policy](../distributed-capacity/architecture/capacity.mjs) and
  [hosted findings](../distributed-capacity/hosted/RESULTS.md): 46 matching checks,
  distinct remote processes, 15 extra hosted native attempts, unknown slots retained.
- [Lifecycle findings](../inference-allowance/comparisons/provider-lifecycle/README.md):
  transport and remote termination are distinct. Existing conservative charging
  is an explicit policy, not automatically a bug this experiment must refund.
- [Provider contract brief](../provider-contract/README.md): consume verified
  capability profiles when available, otherwise use clearly labelled fixtures.

## Fix the pilot policy before writing scenarios

Use the existing chat/agent token-bucket parameters from the allowance fixture as
the baseline. Copy the exact version into the new workload; do not infer a strict
rolling-window quota from a token bucket. Keep global capacity 3 and per-user
capacity 2 for the first integrated profile. Model identity binds the receipt but
does not create a new model-indexed quota policy in this pilot.

The logical key is `(runId, caseId, authenticatedUid, requestId)`. Bind category,
model and a synthetic prompt hash to it. A duplicate with a different payload is a
conflict; a valid duplicate must return saved state without another debit or dispatch.
Check an existing receipt before evaluating capacity/quota for a new request.

Choose this explicit charge/refund contract for the first variant:

1. A busy or quota-denied new request consumes neither allowance nor a slot.
2. An accepted request reserves capacity and debits one allowance atomically.
3. A definitively cancelled **pre-dispatch** reservation may refund exactly once
   and release capacity in one transaction, after fencing any worker that could
   otherwise dispatch it. There must be no recorded dispatch intent.
4. Once dispatch intent is committed, keep the debit. Provider error, timeout,
   missing output and client cancellation are not refund evidence in this variant.
5. Confirmed provider completion/cancellation releases capacity once; it does not
   refund the allowance. Unknown outcomes keep capacity and the debit.
6. Refund uses the existing lazy-refill policy at the recorded refund time and
   caps balance at bucket capacity. Record credited units and saturation loss;
   `debits - refunds` alone cannot reconstruct a refilling, capped bucket balance.

This is a tested business-policy choice, not the only valid product policy. Store
its revision in captures. A later refund policy is a separate variant, not an edit
to this one's expected values.

## Build these files

```text
integrated-admission/
  architecture/admission.mjs           # Single native transaction over quota/slots/receipt
  architecture/transitions.mjs         # Intent, terminal settlement, fenced refund
  architecture/firestore.rules         # Synthetic ledger denies direct clients
  adapters/pyric.mjs                   # Public Admin sandbox API
  adapters/firestore-admin.mjs          # Native named database, same algorithm
  services/gateway.mjs                 # No provider call inside a transaction
  fixtures/policy.mjs                  # Exact accounting contract and integer units
  fixtures/provider.mjs                # Declared contract profiles + separate oracle
  scenarios/*.mjs                     # Versioned barrier-based fault cases
  harness/runner.mjs                   # Isolated cases, process and HTTP control
  analysis/model.mjs                   # Independent expected-state/accounting model
  analysis/assess.mjs                  # Required coverage + state/event checks
  config/local.json
  config/hosted.example.json           # Fake inference; production opt-in disabled
  tests/*.test.ts
  capture-definition.mjs
  execute.mjs
  run.mjs
  results/<runId>/...
```

Use `integratedAdmissionExperiments/{runId}/cases/{caseId}`. Under each case keep
`quotas/{uidHash}`, `requests/{requestKey}`, `capacity/global`, `users/{uidHash}`
and `provider/{operationKey}` where the fixture needs durable state. Request records
carry payload hash, policy version, debit/refund state, execution state, owner,
fence, lease, provider key and authoritative terminal evidence when available.
Use explicit state transitions; avoid independent booleans that allow contradictory
states such as refunded and dispatchable. Do not deploy client Rules automatically.

All reads in each Firestore transaction precede all writes. Read the receipt,
quota and capacity counters; either commit the complete admission or none of it.
Refactor only the minimum reusable transaction-level helpers if the old public
functions each start their own transaction. Calling `admit()` and `reserve()` in
sequence is not atomic integration. Preserve old implementations as baselines.

Provider calls occur after a durable dispatch-intent transition and outside native
transaction callbacks. Retried callbacks must never invoke a model. A transaction
cannot guarantee exactly-once provider execution across the database/API boundary;
report conservative stranded work when the provider cannot safely deduplicate.

## Build order and required cases

Implement a tracer bullet first: public gateway request → atomic admission → fake
provider completion → single settlement, with final database and oracle checks.
Then add one failure seam at a time using public SDK/HTTP operations. Do not replace
Firestore transaction logic with a fake store. A fault shim may hold/drop an
acknowledgment **after a real commit**; label that as an injected acknowledgment fault.

| Case | Required check |
| --- | --- |
| Normal chat and agent | One debit, one slot, one dispatch, one release per accepted request; independent buckets. |
| Capacity full with quota available | Busy response; no new debit or receipt permitting dispatch. |
| Quota empty with capacity available | Denial; no occupied slot. |
| Two gateways race same key | One admission and dispatch; other observes saved state. |
| Duplicate key / changed payload | Conflict; original state unchanged. |
| Native callback retry | One committed debit and capacity increment; no provider side effects inside retries. |
| Crash before admission commit | No committed admission, or explicit unknown if the fault cannot establish pre-commit ordering. |
| Commit succeeds, acknowledgment lost | Retry discovers the complete admission; no second debit or slot. |
| Pre-dispatch stop races dispatch claim | Exactly one wins; a refunded request cannot later acquire dispatch permission. |
| Repeated/concurrent refund | At most one refund and release; never negative counters or balance above capacity. |
| Refund after refill/saturation | Independent worked examples verify clamping and recorded saturation loss. |
| Crash after intent, before observed provider start | Keep debit and reservation; no blind resend without documented provider deduplication. |
| Provider accepts, response lost | Original work may continue; no automatic refund or duplicate invocation. |
| Confirmed terminal event, settlement acknowledgment lost | Retry settles idempotently; no double capacity decrement. |
| Stale owner after takeover | Cannot dispatch, refund or settle using an old fence. |
| Malformed state / cross-user key | Fail closed; no silently replenished buckets or adopted foreign receipt. |
| Split-admission negative control | Locally inject failure between independent allowance/capacity commits and detect partial admission. |

For the negative control, choose a schedule that violates a predeclared invariant,
not a mere request failure. Keep its failed raw assertion visible and classify the
control as expected. Never deploy the unsafe variant or use it for real inference.

## Independent accounting and evidence

Use the common schema plus before/after documents and an independently specified
expected-state model. The model takes the declared policy and observed committed
transitions; it must not import the implementation under test to calculate its
expected answer. Include literal worked examples for refill and refund boundaries.
Do not treat staged transaction writes as committed events.

Required invariants: no duplicate committed debit/refund; no capacity without an
accounted admission except explicitly named uncertainty; no admitted record with
only half its reservation; counters equal nonterminal reservations; settled/refunded
records never dispatch again; no provider start beyond its unique dispatch grant;
unknown remote work never frees capacity based solely on time or transport state.
Validate provider starts with the separate fixture oracle, not only receipt counts.

Persist debit/refund units, saturation loss, charged-but-undispatched work, held
unknown slots, provider starts, conflicts, busy/denial outcomes, native invocations
and attempts, and every incomplete acknowledgment. Preserve allowances and execution
capacity as separate quantities. Record observation limits instead of asserting a
false conservation equation when refill, saturation or missing evidence intervenes.

## Comparison plan

First run the old allowance and capacity public suites unchanged. Then run the new
integrated profile against Pyric and a fresh hosted fake-provider target using the
same captured algorithm, policy and schedule. Compare invariants and final state;
retain latency/retry differences separately. Old standalone captures establish
context, not source-identical parity with the composed algorithm.

Add a variant comparison between split and atomic admission with the same fixture,
limits, fault schedule and independent oracle. The split variant's expected partial
admission demonstrates that the harness can detect the composition error. Record
the different implementation hashes explicitly. Do not relax the invariant for the
atomic variant because hosted retries make the test slow.

## Proposed run contract — not implemented yet

```sh
bun test experiments/rate-limiting/integrated-admission/tests
bun experiments/rate-limiting/integrated-admission/run.mjs run --config experiments/rate-limiting/integrated-admission/config/local.json --out /tmp/integrated-admission
bun experiments/rate-limiting/integrated-admission/run.mjs verify CAPTURE
bun experiments/rate-limiting/integrated-admission/run.mjs analyze CAPTURE
bun experiments/rate-limiting/integrated-admission/run.mjs replay CAPTURE --out /tmp/integrated-replay
bun experiments/rate-limiting/integrated-admission/run.mjs preflight --config /tmp/integrated-hosted.json
# Only after hosted run authorisation; deployment is a separate approval:
bun experiments/rate-limiting/integrated-admission/run.mjs run --config /tmp/integrated-hosted.json --allow-production --out /tmp/integrated-hosted
bun experiments/rate-limiting/integrated-admission/run.mjs baseline HOSTED_CAPTURE --out /tmp/integrated-baseline
bun experiments/rate-limiting/integrated-admission/run.mjs compare PYRIC_CAPTURE HOSTED_CAPTURE --mode backend --out /tmp/integrated-comparison.json
```

The first hosted profile must use fake inference, at most 200 offered gateway
requests, native transaction maxAttempts 8, a separately declared total command
budget and a finite controller deadline. Count cancellation/recovery/inspection
commands separately from inference requests. Unsupported hosted fault controls are
unexecuted checks, not green results. Implement per-run namespaces rather than
reusing the already populated capacity-recovery command cases.

## Completion and handoff

Complete means the safe variant passes its required checks, the unsafe control
fails its intended invariant, native retries cannot create provider side effects,
all results verify/replay, and paired evidence distinguishes safety from progress.
A partial hosted run remains partial. Publish no production-readiness claim.

Hand the state machine, explicit charge/refund contract, independent model and
captured outcomes to [automatic recovery](../automatic-recovery/README.md) and
[fair allocation](../fair-allocation/README.md). Do not add background scheduling,
queues or unrelated UI to finish this experiment.
