# Experiment: automatic recovery under competing owners

## Goal and uncertainty

Determine whether independent recovery workers can restore usable execution capacity
when gateways disappear, without redispatching uncertain work, refunding it incorrectly,
or freeing slots for inference that may still be running. Measure safety and recovery
progress separately. An algorithm that never releases anything can be safe and still
be unusable; an algorithm that releases on lease expiry can appear live but be unsafe.

**Status: build brief only. This directory currently contains only this README.**
Use the [shared build and evidence contract](../README.md#common-implementation-contract-for-all-four-briefs).
The proposed paths and CLI below are not implemented. Begin with local Pyric and a
separate provider oracle; stop before every Cloud Run deployment for explicit approval.

Hypothesis: fenced recovery ownership plus authoritative provider reconciliation
can safely recover observable terminal work, while unobservable work must remain
quarantined. There may be no algorithm that restores all capacity under a provider
contract that exposes neither termination nor a trustworthy upper lifetime bound.
Record that impossibility for the tested contract instead of hiding it with a timer.

## Dependencies and previous results

Read [the original distributed suite](../distributed-capacity/README.md),
[local results](../distributed-capacity/RESULTS.md), and
[hosted results](../distributed-capacity/hosted/RESULTS.md). The local suite killed
actual gateway subprocesses while the database and oracle survived. The hosted
suite used explicit commands/logical time, observed three process identities, and
ended with three unknown reservations holding all capacity. Neither implemented
an autonomous reconciler or killed a Cloud Run process.

Reuse [capacity transitions](../distributed-capacity/architecture/capacity.mjs),
[process control](../distributed-capacity/adapters/pyric-cluster.mjs),
[oracle](../distributed-capacity/services/provider.mjs) and
[transaction instrumentation](../inference-allowance/adapters/store.mjs).
Inspect the existing `crash-before-dispatch`, `crash-during-inference`,
`completion-before-record`, `recovery-race`, `stale-owner`, `provider-unobservable`
and `unsafe-expiry` scenario modules before designing equivalent schedules.

Consume the [provider capability profile](../provider-contract/README.md) and
[integrated charge/refund state machine](../integrated-admission/README.md) once
available. If they are not built yet, create the local recovery scaffold with the
existing capacity policy and versioned fixture capabilities, label integration as
pending, and do not claim end-to-end allowance recovery. Do not block all local
work waiting for an unsupported real-provider operation-status API.

## Scope and architecture to implement

```text
automatic-recovery/
  architecture/reconcile.mjs           # Decisions from state + evidence, no hidden oracle
  architecture/recovery-claim.mjs      # Atomic ownership/lease/fence checks
  services/recovery-worker.mjs         # Bounded due-work scan and reconciliation loop
  services/gateway-worker.mjs          # Dispatch/heartbeat using shared state machine
  services/provider-oracle.mjs         # Independent lifetime, status and fault controls
  adapters/pyric-cluster.mjs            # Multiple actual Node processes, public SDK
  adapters/firestore-admin.mjs         # Same policy on native hosted transactions
  fixtures/contracts.mjs               # Observable/late/absent evidence profiles
  scenarios/*.mjs                     # Crash/restart/race/clock/dependency schedules
  harness/runner.mjs                   # Barriers, process control, evidence journal
  analysis/assess.mjs                  # Separate safety, liveness and completeness
  config/local.json
  config/hosted.example.json
  tests/*.test.ts
  capture-definition.mjs
  execute.mjs
  run.mjs
  results/<runId>/...
```

Root data at `automaticRecoveryExperiments/{runId}/cases/{caseId}`. Start with the
integrated request/quota/capacity records and add only recovery fields needed to
claim and schedule work: `nextCheckAt`, reconciliation attempt count, last evidence
reference and stable quarantine reason. Persist any scheduling state required to
survive worker restart. Never rely on in-memory ownership as the authoritative lock.

Use bounded queries for due nonterminal records, stable ordering and a cursor.
Declare/index the query shape, pagination and scan limit; record candidates scanned,
claimed, skipped and deferred. Query results are candidates, not ownership: re-read
current state inside a transaction before takeover. Do not process a stale query
snapshot as if it were an exclusive claim. Ensure repeated scans do not starve
later pages when earlier candidates remain permanently unknown.

Every gateway/recovery-worker process incarnation gets a new owner ID. Fences are
monotonic per request. Heartbeats, dispatch, refunds and settlement validate current
ownership/fence/state in the same transaction as their mutation. Provider calls
remain outside transactions. If an external observation arrives after ownership
changed, re-check before applying it; retaining an observation does not grant an old
worker permission to mutate state. Duplicate terminal observations must settle once.

## Recovery decision contract

| Saved state / new evidence | Required action |
| --- | --- |
| Terminal or pre-dispatch-cancelled | No further debit, refund, dispatch or release; reconcile idempotently. |
| Reserved, no dispatch intent | Claim only after valid takeover conditions, then resume or cancel/refund using the integrated policy. |
| Dispatch intent, provider state absent/unavailable | Retain slot and debit; mark uncertainty, do not blindly resend. |
| Provider reports running | Retain capacity; schedule another bounded observation. |
| Authoritative completion/cancellation | Commit terminal state and release once; charge/refund follows the explicit integrated policy. |
| A stop request was accepted, no termination confirmation | Retain capacity; record pending cancellation rather than cancelled work. |
| Provider supports documented idempotent re-dispatch | Separate enabled capability variant, with retained original provider key and independently checked semantics. |
| Lease elapsed / TTL deleted / HTTP timed out | Ownership may change if permitted; none of these alone proves provider termination. |

Do not add a default “release after N minutes” escape hatch. If a provider offers
a documented hard execution lifetime, test it as a separate capability with its
exact start boundary and clock/transport uncertainty; do not invent that contract.
Unresolved work ends as an explicit quarantine result with an inspectable reason.

## Build in this sequence

1. Use TDD at the public runner/HTTP/SDK boundaries to reproduce the old manual
   takeover cases. Preserve their assertions before adding scheduling.
2. Add one recovery worker that automatically discovers a dead gateway's reserved
   work and finishes it using the fixture; the scenario controller may kill a
   process and change provider state, but may not call takeover/reconcile for it.
3. Add a second independent recovery worker and races at claim, observation and
   settlement. Use actual process IDs and barriers; no in-process owner-name test
   can substitute for process lifecycle tests.
4. Add bounded retry/backoff, scan pagination and persistent scheduling. The retry
   budget bounds API/DB work; exhausting it quarantines/defer work, never frees a slot.
5. Separate reconciliation policy from the scheduling driver. Local tests can run
   a loop; hosted execution needs an explicit supported lifecycle such as bounded
   authenticated sweep requests. Do not depend on an unobserved background timer
   continuing after Cloud Run request CPU has stopped.
6. Add deterministic clock-offset/fault profiles and then a separate wall-clock
   profile. Reuse native Firestore retries and capture actual attempts. Freeze time
   per command where the correctness profile requires it, including callback retries.
7. Capture/replay and analyse the local suite. Prepare a hosted fake-provider plan
   that can prove the named process was actually killed/replaced, then stop for
   deployment approval. A fabricated expired timestamp is not hosted crash evidence.
8. After authorised hosted execution, collect final state and correlated logs even
   when recovery is incomplete. No live inference is necessary for this first phase.

## Required scenarios

| Scenario | Safety requirement | Progress requirement |
| --- | --- | --- |
| Death after reservation | No second debit/reservation | New owner automatically resumes or safely cancels undispatched work. |
| Death after intent before observed start | No blind resend or release | Explicit quarantine when outcome cannot be resolved. |
| Death while provider runs | Remote work remains counted | Once terminal evidence becomes available, release within a predeclared scan/retry bound. |
| Provider completes while gateway is dead | Single terminal settlement | Recovery discovers and applies existing terminal evidence. |
| Two recovery workers claim together | One fence increment/winner | Loser moves on instead of blocking unrelated candidates. |
| Recovery worker dies after claim | No duplicate provider side effect | Another worker resumes after ownership expiry. |
| Stale observation arrives after takeover | Old owner cannot mutate/refund/release | Current owner can use valid evidence through a fresh state check. |
| Settlement commits, response lost | No double decrement/refund | Repeated reconciliation recognises saved terminal state. |
| Stop acknowledged but not confirmed | Capacity retained | Later confirmation releases it; absent confirmation stays unresolved. |
| Provider status transiently unavailable | No guessed termination | Retry within budget; recover when status returns. |
| Provider forever unobservable | No bound violation | Report unresolved/quarantined, not a false liveness pass. |
| Reconciler backlog spans pages | No duplicate settlement | Observable later-page work progresses despite early unknown records. |
| Clock offsets and renew/takeover races | Stale owners cannot cross database fences | Report early/late takeovers and delay; do not claim solved distributed time. |
| Expiry-only release control | Oracle detects excess active work | Required local negative-control failure remains visible. |

Use separate required assessments for safety, conditional liveness and evidence
completeness. State the observation/scan budgets before each run. An eligible
observable terminal job missing its declared recovery bound fails liveness; a job
whose provider never exposes an outcome is a contract limitation, not silently
removed from the denominator. Track both populations.

## Evidence and comparisons

Capture the common artifacts plus worker lifecycle events, due-query pages,
claim attempts, lease renewals, fences, provider evidence references, scheduled
and actual retry times, quarantine reasons and before/after ledger snapshots.
The oracle must record actual running work independently of the reservation count;
otherwise the unsafe expiry control cannot be detected. Record gateway deaths,
worker deaths, restart IDs and whether the database/oracle survived.

Report time from injected failure to candidate discovery, claim, terminal evidence
and release where comparable clocks permit. Also report outstanding slot age,
quarantined share, recovery attempts, starvation across scan pages, native retry
counts and any safety violation. Never report a zero recovery time for unresolved
work. Keep censored outcomes and actual evidence delays.

Run a **manual versus automatic recovery variant comparison** using the same policy,
fixture and fault schedule. Manual recovery is the existing control, not a throughput
competitor. Assert identical safety and terminal accounting where both have evidence;
measure the automatic variant's discovery/progress separately. Then pair the automatic
variant across Pyric and hosted Firestore. Do not compare the original 100-ms local
leases to a 30-second hosted lease as if the workloads were identical.

Use real-provider capability profiles from the first experiment for a later contract
exercise. Do not call a fixture result proof that AI Logic supports reconciliation.
The current hosted service's operator-controlled `provider-finish` is not a real
external terminal signal or an autonomous recovery implementation.

## Proposed commands — implement before using

```sh
bun test experiments/rate-limiting/automatic-recovery/tests
bun experiments/rate-limiting/automatic-recovery/run.mjs run --config experiments/rate-limiting/automatic-recovery/config/local.json --out /tmp/automatic-recovery
bun experiments/rate-limiting/automatic-recovery/run.mjs verify CAPTURE
bun experiments/rate-limiting/automatic-recovery/run.mjs replay CAPTURE --out /tmp/recovery-replay
bun experiments/rate-limiting/automatic-recovery/run.mjs analyze CAPTURE
bun experiments/rate-limiting/automatic-recovery/run.mjs compare MANUAL_CAPTURE AUTOMATIC_CAPTURE --mode variant --out /tmp/recovery-variant.json
bun experiments/rate-limiting/automatic-recovery/run.mjs preflight --config /tmp/recovery-hosted.json
# Only after hosted execution authorisation and a separately approved deployment:
bun experiments/rate-limiting/automatic-recovery/run.mjs run --config /tmp/recovery-hosted.json --allow-production --out /tmp/recovery-hosted
bun experiments/rate-limiting/automatic-recovery/run.mjs baseline HOSTED_CAPTURE --out /tmp/recovery-baseline
bun experiments/rate-limiting/automatic-recovery/run.mjs compare PYRIC_CAPTURE HOSTED_CAPTURE --mode backend --out /tmp/recovery-comparison.json
```

The first hosted plan must bound gateway requests, sweep commands, provider probes,
scan pages, total duration and native attempts separately. Default to no more than
200 total control/gateway commands, maxAttempts 8 per native transaction, fake
inference and at most two recovery workers. Unknown jobs stop being probed when
the run budget is exhausted but keep their reservations. Do not silently enlarge
a budget or reset old run state to obtain a passing outcome.

## Completion criteria

A complete local milestone demonstrates autonomous discovery (no manual reconcile
from scenario code), competing real worker processes, required safety and conditional
liveness checks, a detected unsafe control, and verifiable source-inclusive replay.
Hosted completion additionally requires actual evidence for each claimed process
fault; unsupported faults remain gaps. Preserve negative or inconclusive results.

The output must answer: which failures recover automatically, what evidence is
required, how long recovery took under the stated schedule, which work remains
stranded, and whether the safe bound ever broke. Do not expand this into a general
scheduler, monitoring console, production rollout or operational playbook.
