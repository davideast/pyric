# AI gateway architecture experiments

Build evidence about an AI gateway that enforces user allowances, survives bursts,
limits concurrent inference, and recovers unfinished work without double dispatch
or premature capacity release. These are extracted architecture experiments, not
changes to Kin and not a production deployment plan.

## Completed experiments ([full 9-experiment synthesis](PROGRESSION.md))

| Experiment | Read first | Established boundary |
| --- | --- | --- |
| Allowance accounting | [Inference allowance](inference-allowance/README.md), [first Firestore comparison](inference-allowance/comparisons/first-hosted/README.md) | Native transactional token buckets and request receipts; response deadlines can precede native transaction settlement. |
| Gateway admission and execution protection | [Progression](inference-allowance/EXPERIMENT-PROGRESSION.md), [hosted execution comparison](inference-allowance/comparisons/hosted-execution/README.md) | Local and hosted HTTP workloads; Cloud Run did not propagate the tested client disconnects to the container. |
| Provider lifecycle accounting | [Lifecycle guide](inference-allowance/PROVIDER-LIFECYCLE.md), [local findings](inference-allowance/comparisons/provider-lifecycle/README.md) | Separates output transport from provider termination, using a scripted provider; unknown outcomes retain slots. |
| Distributed capacity | [Local harness](distributed-capacity/README.md), [hosted findings](distributed-capacity/hosted/RESULTS.md) | Transactions, leases, fences and explicit reconciliation; nine hosted/adapted cases matched 46 checks against Pyric across three gateway process identities. |
| Real-provider contract validation | [Local + live results](provider-contract/RESULTS.md), [live AI Logic run](provider-contract/live/RESULTS.md) | 16 local fixture cases (35 checks) and 4 live Firebase AI Logic (`gemini-3.5-flash-lite`) cases; normal completions provide authoritative evidence (`finishReason`, `usageMetadata`), while interrupted streams leave remote state unobservable and require slot retention. |
| Integrated admission and accounting | [Local harness](integrated-admission/README.md), [hosted findings](integrated-admission/hosted/RESULTS.md) | Atomic allowance debit + capacity reservation in a single Firestore transaction with pre-dispatch refund vs. post-dispatch retention; 18 local multi-process cases (44 assertions) and 12 hosted Cloud Run + Native Firestore cases (38/38 assertions matching Pyric). |
| Autonomous recovery and reconciliation | [Local harness](automatic-recovery/README.md), [hosted findings](automatic-recovery/hosted/RESULTS.md) | Cursor-paginated `(nextCheckAt ASC, requestId ASC)` lease sweeps, fenced `claimExpired()` takeover, and an 8-row `reconcile()` decision engine with explicit quarantine (`provider-unobservable`); 14 local cases (33 assertions) and 13 hosted Cloud Run + Native Firestore cases (31/31 assertions matching Pyric). |
| Fair allocation under contention | [Local harness](fair-allocation/README.md), [hosted findings](fair-allocation/hosted/RESULTS.md) | Bounded queue residency (`QUEUE_LIMITS`: 24 global, 8 per-user) decoupled from active execution slot reservation (`LIMITS`: 3 global, 2 per-user), comparing `immediate`, `fifo`, and transactional `round-robin` cursor rotation; 11 local cases (27 assertions) and 10 hosted Cloud Run + Native Firestore cases (18/18 assertions matching Pyric). |

## Experiment dependency sequence

1. [Real-provider cancellation and reconciliation](provider-contract/README.md):
   establishes what actual provider evidence is available after interruption.
2. [Integrated admission and accounting under failure](integrated-admission/README.md):
   joins allowance, execution capacity and dispatch into a recoverable state machine.
3. [Automatic recovery under competing owners](automatic-recovery/README.md):
   runs recovery automatically without guessing that unknown work has stopped.
4. [Fair allocation under contention](fair-allocation/README.md): compares allocation
   policies (`immediate`, `fifo`, `round-robin`), noisy-neighbor fairness, and shared-ledger contention.

## Common implementation contract for all four briefs

### Public seams and source reuse

Use `initializeSandbox` from `pyric/sandbox` and `getAdminFirestore` from
`pyric/sandbox/admin-firestore` for local trusted-gateway transactions. Use the
native Firestore Admin SDK for hosted database work. The Admin API bypasses client
Security Rules in both environments: these experiments do not prove end-user Rules.
Use native transaction retries; do not replace them with a custom optimistic store.

Read and reuse these modules where the semantics fit:

- [Instrumented store](inference-allowance/adapters/store.mjs): native transaction
  invocation/attempt IDs, staged writes and acknowledgements.
- [Allowance arithmetic](inference-allowance/architecture/bucket.mjs) and
  [admission](inference-allowance/architecture/admission.mjs): integer units,
  lazy refill, UID-bound receipts and payload binding.
- [Capacity policy](distributed-capacity/architecture/capacity.mjs): reservations,
  owner/fence/lease validation and terminal settlement.
- [Process/IPC adapter](distributed-capacity/adapters/pyric-cluster.mjs): real local
  gateway processes sharing public Pyric operations.
- [Evidence capture](../shared/evidence/capture.mjs) and
  [comparison](../shared/evidence/compare.mjs): source-inclusive captures and coverage.
- [Hosted source verification](distributed-capacity/hosted/evidence.mjs) and
  [paired analysis](distributed-capacity/hosted/analyze.mjs): verify actual deployed
  files and shared implementation equivalence before claiming backend parity.
- [Log collector](../shared/observability/log-capture.mjs),
  [scope](../shared/observability/log-scope.mjs), and
  [redaction](../shared/observability/log-redaction.mjs).

Do not import `hosted/run.mjs` as a library: it executes on import. Existing hosted
commands have fixed namespaces and a process-lifetime budget; they are not a
reusable target for these experiments. Preserve their data and code. Extract a
shared helper only when two concrete consumers need identical semantics, and
retain regression coverage for the existing consumer. Do not silently change an
old scenario or weaken its assertions to accommodate a new experiment.

### Capture format and identifiers

Give each experiment its own `capture-definition.mjs`, `execute.mjs`, `run.mjs`,
scenario registry and versioned workload contract. Use this proposed common shape;
reuse existing normalised names rather than creating synonyms:

```text
results/<runId>/
  source/experiments/...     # Exact executed harness, architecture and adapters
  manifest.json              # Artifact hashes, implementation/workload hashes, lineage
  input.json                 # Sanitised explicit configuration; never credentials
  workload.json              # Cases, required checks, policy, limits, clock, seed
  environment.json           # Runtime/SDK/build fingerprints and backend metadata
  events.ndjson              # Incremental intent, observation and fault journal
  attempts.ndjson            # Every dispatched HTTP attempt and its outcome
  snapshots.json             # Before/after accounting state, where applicable
  result.json                # Cases, actual/expected assertions and observations
  assessment.json            # Completeness, invariant verdicts, expected controls
  summary.json               # Metrics with populations, units and unknowns
  findings.md                # Interpretation, limits and links to raw evidence
  logs/                      # Hosted application/HTTP/audit exports + capture report
```

Each event needs `schemaVersion`, `experimentId`, `runId`, `caseId`, `requestId`
(logical request), `attemptId` (gateway invocation), `kind`, `instanceId`,
`localSequence`, `timestamp` and `localElapsedMs` where available. Transaction
observations add `invocationId` and callback `attempt`. Provider observations add
`providerOperationId`, its origin and evidence class; unavailable IDs are `null`.
Use explicit `parentRunId`, `pairedRunId`, `variantId`, `workloadVersion`,
`fixtureVersion`, `implementationHash`, `workloadHash` and `policyHash` in metadata.
Do not use a user-supplied request ID as a provider operation ID or transaction ID.

Separate facts: planned arrival, actual dispatch, staged database write, native
commit acknowledgement, gateway response, transport closure, provider terminal
evidence, reservation release, and fixture-only oracle state. Missing usage,
remote state or billing must be `null`/`unknown`, never zero or invented success.
No prompt bodies, generated text, Firebase tokens, App Check tokens, private keys,
service-account files or caller IPs belong in captures. Use synthetic inputs and
hashes/lengths for payload correlation. Credentials stay outside captured trees.

### Execution, failure and comparison rules

1. Copy the explicit source allowlist **before execution and execute that copy**.
   Include transitive experiment imports, policy sources, adapters, fixture and
   assessment code. Record package/lock/build hashes and runtime versions. Do not
   archive the whole application or dependency binaries. Avoid the previous hosted
   controller's weaker capture-working-files-and-then-run-them approach.
2. Predeclare selected cases, exact required check names, expected negative-control
   failures and unsupported capabilities. Missing, duplicate or unknown coverage
   cannot produce a successful assessment. A discovered unsupported provider
   feature is a capability result, not a passed behavioural test of that feature.
3. Journal intent before dispatch and outcomes incrementally. Await all dispatched
   attempts with `Promise.allSettled` before final snapshots/window closure; one
   rejected promise must not abandon the evidence from the rest of the batch.
4. A controller deadline ends local waiting, not remote work. Preserve unacknowledged
   operations as unknown and the run as incomplete; perform bounded read-only
   collection when possible. The offline finaliser must not reconnect or mutate
   the backend. A missing required final snapshot prevents a complete verdict.
5. Capture process-monotonic durations locally. Do not subtract timestamps from
   different processes without a declared clock model. Logical-clock correctness
   and wall-clock performance are distinct profiles; record both planned and
   actual fault/arrival times. Timer plans alone do not prove event ordering.
6. Keep original/failed captures immutable. Replay verifies hashes and creates a
   fresh local namespace; hosted replay is disabled. No script cleans or reuses a
   prior run automatically. Source and data remain available together without Git
   history tracing. Hash verification is integrity checking, not authenticity.
7. Distinguish **paired backend comparisons** (same policy, workload, fixture and
   shared implementation) from **variant comparisons** (one declared technique
   changed). Reject unsupported pairings; never claim parity from unrelated old
   captures or label different techniques source-identical. Keep the same required
   safety checks across variants. Explain every excluded case.
8. Local/hosted latency and retry counts are observations, not interchangeable
   performance estimates. Report timeouts, rejections, incomplete attempts and
   right-censored waits, not only successful requests. A passing safety check does
   not imply availability or production readiness.

The proposed CLI for each brief must implement `run`, `preflight`, `verify`,
`analyze`, `baseline`, `replay` and `compare`. Exit 0 means complete evidence matching
predeclared expectations (including labelled negative controls), 1 means an
unexpected/incomplete run, and 2 means usage/configuration/integrity failure.
`preflight` is read-only; it never deploys, sends inference, or silently enables
services. Separate collection completeness from behavioural findings in reports.

### Proposed configuration contract

Use one explicit, versioned JSON input per run. The implementing agent should use
these field names consistently across the four new CLIs; each experiment validates
its own case/variant registry. This example is a proposed local input, not a file
that an existing runner can consume:

```json
{
  "schemaVersion": 1,
  "experimentId": "integrated-admission",
  "variantId": "atomic-admission",
  "backend": { "kind": "pyric" },
  "execution": { "kind": "local-processes", "gatewayCount": 2 },
  "provider": { "kind": "fixture", "profile": "observable-terminal" },
  "clock": { "kind": "logical", "initialMs": 1000 },
  "seed": 17,
  "cases": ["normal", "duplicate-admission", "commit-ack-lost"],
  "policyVersion": "integrated-v1",
  "limits": {
    "maxRequests": 200,
    "maxCommands": 400,
    "maxDurationMs": 60000,
    "maxTransactionAttempts": 8
  }
}
```

For a hosted input, require backend project, named database, region and expected
database mode/concurrency; execution needs service URL, revision, image/source hash
and gateway-resource metadata. For real inference, require provider/API/SDK/model
identity, output limit, total dispatch budget and concurrency limit. Credential
**references** may be supplied separately; never put tokens or key JSON into input.
Do not infer defaults from a developer's active gcloud project or Firebase config.

Reject unknown experiment/case/variant names, duplicate cases, nonpositive or
unbounded budgets, emulator overrides on hosted profiles, and unsupported adapter
combinations before writes. Separate local-process crash support from logical
lease-takeover support in preflight output. Fail closed when a profile requests
real inference without both its explicit configuration and opt-in flag.

Each case declares its worst-case scheduled command count including status polls,
recovery operations and inspections. Preflight sums the selected cases and rejects
a profile that cannot fit its command budget; do not silently omit cases. A suite
that needs multiple bounded runs gets an explicit partition plan and run lineage.
Native retries add database operations beyond the command count; report and bound
those separately. Wall-clock profiles have distinct duration budgets and must not
inherit a too-short correctness-run timeout unnoticed.

### Hosted and real-provider boundaries

Use Pyric first. Then prepare a paired hosted profile with fake inference before
introducing real-provider uncertainty. The provider-contract brief is the explicit
exception: its final question necessarily requires separately authorised real AI.

The known test target is project `digame-mas`, named Firestore database
`allowance-experiments`, region `us-east4`; verify its metadata at run time rather
than assuming it is unchanged. Use isolated roots named by each brief and a fresh
UUID run ID. Use Application Default Credentials or an explicitly supplied key
outside the repository; never hardcode a developer's home-directory path.

**Every Cloud Run deployment requires explicit user approval.** Stop after local
implementation/testing and preparation of a concrete deployment manifest until
approval arrives. Prior service deployments are not standing deployment permission.
Document exact service/revision/image/source, CPU/request lifecycle, concurrency,
instance limits, request ceilings and any fault endpoints before asking. Do not
modify `allowance-overload` or `capacity-recovery`, their original run documents,
Auth configuration, Rules, project quotas or IAM merely to run a new scenario.

The current log-scope allowlist accepts `allowanceExperiments` and
`capacityExperiments`. Add a new brief's exact namespace through the shared module
with tests for both permitted scope and cross-run exclusion; do not disable scope
checking or capture the whole project's logs. Reuse the Node-only
[observability setup](inference-allowance/OBSERVABILITY.md) rather than inventing
another logging configuration tool. This is evidence infrastructure for an
experiment, not a requirement to build a new monitoring product.

Real AI needs a separately approved exact model, provider/API, invocation/output
budgets and target. Enforce the invocation budget at the trusted dispatch boundary
across all gateway instances; the load-generator count alone is insufficient.
Bound request submissions, native attempts, test duration and fixture workloads
separately. Keep fake inference as the default. A successful setup/preflight is
not authorisation to make paid requests.
