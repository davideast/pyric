# Distributed execution capacity and recovery

This local experiment asks whether gateway processes sharing a Firestore-shaped
ledger can bound active inference, survive gateway crashes, fence stale owners,
and recover without assuming that an expired lease stops remote work.

**Cloud Run deployments require explicit user approval.** The local harness uses
no cloud credentials or real inference. A separate [private deployment target](deployment/README.md)
exposes the architecture through HTTP with native Firestore transactions. It does
not automatically run a workload. The [hosted controller](hosted/README.md) and
[first paired results](hosted/RESULTS.md) now cover nine supported/adapted HTTP
scenarios; the complete original local fault suite is not hosted yet.

## What this adds to the progression

Allowances bound how often a user may start work. Gateway admission bounds local
request pressure. Execution slots bound simultaneous inference. Provider lifecycle
checks distinguish a locally finished request from remotely finished work. This
experiment moves execution slots into a shared transactional ledger and asks what
happens when the gateway that owns a slot disappears.

The hypothesis is that atomic global/per-user reservations plus fenced ownership
can preserve capacity bounds across gateway crashes, provided uncertain remote
work keeps its reservation. Lease expiry permits an ownership change; it is never
evidence that remote inference stopped. The unsafe control deliberately breaks
that rule so the oracle must detect excess running work.

## Run locally

From the repository root, with its dependencies installed, built Pyric exports
available through `node_modules`, and Node plus Bun on `PATH`:

```sh
bun test experiments/rate-limiting/distributed-capacity/tests
bun experiments/rate-limiting/distributed-capacity/run.mjs run --out experiments/rate-limiting/distributed-capacity/results
bun experiments/rate-limiting/distributed-capacity/run.mjs run --case unsafe-expiry --out /tmp/capacity-control
bun experiments/rate-limiting/distributed-capacity/run.mjs verify CAPTURE_DIRECTORY
bun experiments/rate-limiting/distributed-capacity/run.mjs analyze CAPTURE_DIRECTORY
bun experiments/rate-limiting/distributed-capacity/run.mjs replay CAPTURE_DIRECTORY --out /tmp/capacity-replay
bun experiments/rate-limiting/distributed-capacity/run.mjs compare ORIGINAL_DIRECTORY REPLAY_DIRECTORY
```

The CLI executes a copied source bundle, not the working files. Every run has an
isolated sandbox and document root. It forks actual Node processes for gateways;
the parent owns the shared Pyric instance and a separately observed fake provider.
No credentials, Firebase project, inference charges, HTTP listener or cloud setup
are needed. A failed/incomplete case makes the assessment fail. Two *declared*
bound violations in `unsafe-expiry` are required control results, not a green claim
about that algorithm. Interrupted capture recovery preserves missing checks as
incomplete. The outer capture watchdog is 60 seconds; it does not release slots.

## Code and data

```text
distributed-capacity/
├── architecture/
│   ├── capacity.mjs          # Atomic reservations, owner/fence/lease, settlement
│   ├── unsafe-expiry.mjs     # Deliberately wrong expiry-only release control
│   └── firestore.rules      # Deny clients; trusted gateway uses Admin SDK
├── adapters/pyric-cluster.mjs # Shared SDK store, native retry callbacks, process lifecycle
├── services/
│   ├── gateway-worker.mjs   # Separate Node gateway process, no HTTP framework
│   ├── store-client.mjs     # IPC transaction callbacks execute inside each gateway
│   ├── rpc-message.mjs      # Local IPC envelope guard
│   └── provider.mjs         # Independent running-work oracle; survives gateway death
├── scenarios/*.mjs          # One workload/fault schedule and required checks per file
├── harness/
│   ├── scenarios.mjs        # Case registry
│   └── run-cases.mjs        # Programmatic entry point and normalized observations
├── analysis/assess.mjs      # Coverage checks, expected outcomes, summaries/comparison
├── tests/                  # Public harness and capture regressions
├── capture-definition.mjs   # Source/dependency capture and implementation hash
├── execute.mjs              # Executes archive, streams evidence, finalizes artifacts
├── run.mjs                  # Run/replay/verify/analyze/compare CLI
└── results/<run-id>/
    ├── source/experiments/  # Exact executed architecture and harness, including adapters
    ├── manifest.json        # File hashes, parent replay ID, dependency provenance
    ├── input.json           # Selected profile and cases
    ├── workload.json        # Limits, required assertions, fault model
    ├── events.ndjson        # Native attempts, staged writes, acknowledgements, faults
    ├── result.json          # Cases, assertions, final documents, provider oracle
    ├── summary.json         # Per-case counts, peaks, final active capacity
    ├── assessment.json      # Completeness and expected-outcome verdict
    ├── environment.json     # Engine/build fingerprints and explicit limitations
    ├── firestore.rules      # Executed client Rules
    └── findings.md          # Interpretation and evidence pointers
```

The adapter reuses `inference-allowance/adapters/store.mjs` for transaction
instrumentation and `shared/evidence/` for capture/verification. The implementation
hash includes those executed dependencies, including the IPC adapter. Installed
packages remain external: their fingerprints identify them but do not reconstruct
them. Replay uses current installed packages and records those fingerprints.
Only replay trusted bundles. Hashes detect changed files, not author authenticity.

The document root is `capacityExperiments/{runId}/cases/{caseId}`:

- `capacity/global`: active reservation count.
- `users/{uid}`: active reservations for that user.
- `requests/{hash(uid, requestId)}`: UID, request ID, owner, increasing fence,
  lease deadline, provider key and state.

Admission reads the request and both counters before writing them atomically.
Reservation precedes a durable dispatch intent, which precedes the external call.
There is no transaction spanning the database and provider. A crash in that gap
produces uncertainty, not a guessed success or automatic retry. A takeover of
`reserved` work can dispatch; a takeover of dispatched work must reconcile.
Only confirmed `completed` or `cancelled` observations decrement both counters.
Repeating settlement is idempotent. Terminal records are retained, without TTL.

Each native SDK transaction retry invokes the gateway callback again through IPC.
The adapter does not replace SDK transactions with a custom retry implementation.
Owners, UIDs, time and provider observations are controlled test fixtures. Fences
protect database mutations; they cannot stop an already-issued provider request.

## Required cases

| Case | Required observation |
| --- | --- |
| concurrent | Three gateways admit exactly three operations, at most two per user |
| duplicate-admission | Two gateways racing one request dispatch exactly once |
| crash-before-dispatch | New owner advances the fence and resumes the reservation |
| crash-during-inference | Running orphan keeps its slot until confirmed completion |
| completion-before-record | Recover confirmed completion; settle once, no redispatch |
| dispatch-uncertain | Intent without observable provider state retains capacity |
| commit-ack-lost | Database commit survives gateway acknowledgement loss; retry does not debit twice |
| recovery-race | Concurrent takeover elects one new owner |
| stale-owner | Old owner cannot dispatch, renew or settle after takeover |
| lease-renewal | Renewed lease prevents premature takeover |
| provider-unobservable | Hidden running operation stays quarantined until confirmed terminal |
| confirmed-cancellation | Provider-confirmed cancellation releases the slot |
| invalid-state | Malformed identities/counters/reservations fail closed; clients cannot edit ledger |
| unsafe-expiry | Expiry-only release permits two remote jobs against a limit of one |

Provider start **attempts** are counted independently of unique jobs. Repeated
dispatch of a key fails the fixture loudly; it does not silently deduplicate and
mask a gateway bug. `summary.json` separates transaction invocations from native
attempts. `result.json` retains actual/expected values and provider observations;
`events.ndjson` supplies sequence, run/case IDs and timestamps for diagnosis.

## Comparison and production limits

Comparison requires matching schema, workload, Rules and executable implementation
hashes, complete required cases and valid assessments. It compares decisions only;
it always reports `performanceComparable: false`. Inspect environment/build
fingerprints separately before claiming identical dependencies. The logical clock
is shared, advanced at awaited barriers and frozen per command: these are controlled
ordering experiments, not wall-clock throughput, clock skew or lease-drift tests.

Pyric lives in one controller process; only gateways are killed. This validates
gateway recovery while the shared database and oracle survive, not durable
database restart. The single global counter is deliberately simple and may become
a contention bottleneck in hosted Firestore. No autoscaling, fairness, retry storm,
allowance debit/refund, Auth verification or production IAM boundary is tested.
Provider keys are unique within each isolated case; a shared real provider would
also need an application/environment namespace and verified provider support.

The fake provider exposes completion/cancellation and deliberately hideable status.
This is not evidence that AI Logic exposes such a reconciliation API. Unknown work
can retain a slot indefinitely: safety is shown for these schedules, but eventual
availability is not solved. TTL deletion, lease expiry and HTTP disconnection must
not be treated as proof of remote termination. Recovery is explicitly driven by
the harness; no automatic reaper or reconciliation service is implemented.

The first hosted phase has a separate Firestore/Cloud Run adapter, correlated
log capture and a bounded workload observed across three gateway processes. See
[its results](hosted/RESULTS.md) for semantic matches and remaining fault-coverage
gaps. Extending hosted fault controls requires explicit deployment approval.
A real-provider run additionally needs a documented termination/reconciliation
contract; the fixture is not evidence that AI Logic provides one.
