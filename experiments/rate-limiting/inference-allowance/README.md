# Inference allowance experiments

A server-owned token bucket using Firestore as the only shared coordination
store. Local experiments run through Pyric's public Admin-shaped sandbox API.
This is an extracted architecture, not a change to Kin or an AI deployment.

[Set up hosted observability](OBSERVABILITY.md) with the Node-only
`setup-observability.mjs check|plan|apply|preflight` workflow. It preserves existing
project settings, verifies log delivery separately, and records coverage with runs.

[Read the experiment progression and technique comparison](EXPERIMENT-PROGRESSION.md)
for the evidence behind allowance, admission protection and execution protection.

[Provider lifecycle and cancellation](PROVIDER-LIFECYCLE.md) adds a local Pyric
experiment separating transport termination, confirmed provider outcomes and
unknown operations that retain capacity. Hosted execution is deliberately deferred.

## Contract and current scope

Each authenticated UID has one quota document containing separate chat and agent
buckets. Every inference call costs one admission. Chat starts with 5 credits and
refills 10/minute; agent starts with 2 and refills 1/minute. This is a token bucket,
not a strict rolling-window quota. Model-specific policy selection is deferred.

Time is injected at the gateway, never accepted from the request. Each credit is
60,000 integer units; an integer refill-per-minute value is units per millisecond.
Backward clock movement grants no credit. Forward clock skew remains a trusted
clock limitation, not a solved distributed-clock problem. Controlled-clock cases
use the same clock on every simulated gateway; production capacity tests must
use and record real clocks.

Admission reads the UID-scoped receipt and quota in one transaction. A new
admission atomically debits the bucket and creates its receipt. Denials do not
write. A second short transaction claims dispatch. Inference is always outside
transactions; callback retries cannot make a provider call. Receipts bind the
request ID to category/model/prompt hash. They are not deleted or expired in this
pilot. Deleting receipts would end the deduplication guarantee.

Dispatch reservations are intentionally conservative: after a reservation is
committed, a retry never dispatches it again. A crash can therefore consume an
allowance without producing inference. A duplicate response means the request
already has a dispatch reservation, **not** that a response is available. Provider
failures and ambiguous commits do not automatically refund or retry. There is no
exactly-once provider guarantee and no result cache. Future recovery must preserve
this distinction.

The optional gateway guard limits pending admission work per UID per instance.
It is not a global concurrency limit, and it releases before inference begins.
The authoritative shared allowance remains transactional. No client hold document,
client cooperation, distributed lease, or Redis is used.

## Structure and responsibilities

```text
architecture/   bucket arithmetic, admission transaction, gateway, unsafe control
adapters/       instrumented native transaction seam, Pyric, Firestore Admin,
                offline production preflight
services/       observable fake inference; prepared AI Logic REST transport
fixtures/       versioned policies and workload configuration
scenarios/      accounting, contention, authorization, overload, recovery
harness/        runner, recorder, controlled clock, faults, arrival scheduler
analysis/       required-coverage assessment and cohort summaries
config/         local and explicit production example configurations
deployment/    client-deny Rules for the isolated experiment namespace
tests/         public-runner/capture/transport boundary regression tests
results/       immutable source-inclusive captures (including failed candidates)
```

`harness/runner.mjs` is the programmatic entry. `runExperiment({cases})` returns
normalized evidence. Cases run in fresh sandboxes; the two gateway instances in
`multi-gateway` intentionally share one sandbox. `adapters/store.mjs` calls native
SDK `runTransaction` and records callback attempt IDs. It does not fake retries
or production locks. `unsafe-admission.mjs` deliberately races a separate read
and write; never deploy it.

The scenario registry declares required check names. Assessment cannot pass with
missing cases/checks. The unsafe control's failed `allowance respected` invariant
must remain false; reproducing that failure is an expected experiment outcome.
Unknown scenarios fail before execution.

## Local commands

From the repository root, with workspace dependencies and Pyric built:

```sh
bun test experiments/rate-limiting/inference-allowance/tests
bun experiments/rate-limiting/inference-allowance/run.mjs run --out /tmp/allowance-results
bun experiments/rate-limiting/inference-allowance/run.mjs run --case burst-50 --out /tmp/allowance-results
bun experiments/rate-limiting/inference-allowance/run.mjs verify RUN_DIRECTORY
bun experiments/rate-limiting/inference-allowance/run.mjs analyze RUN_DIRECTORY
bun experiments/rate-limiting/inference-allowance/run.mjs compare RUN_A RUN_B --out /tmp/comparison.json
bun experiments/rate-limiting/inference-allowance/run.mjs baseline RUN_DIRECTORY --out /tmp/allowance-baselines
bun experiments/rate-limiting/inference-allowance/run.mjs replay RUN_DIRECTORY --out /tmp/allowance-replays
```

Run exit 0 means expected evidence; 1 means unexpected/incomplete evidence; 2
means usage/configuration/integrity failure. A saved failed experiment is useful
evidence. Production replay is disabled; use a fresh explicit production run.

## Evidence and analysis

Every CLI run executes a copied source tree and retains:

```text
results/<run-id>/
  source/experiments/...  # exact executed architecture, scenarios and adapters
  manifest.json          # hashes, Git context, lock hash, parent replay ID
  input.json             # nonsecret run configuration (when supplied)
  workload.json          # clock, policies, selected cases
  events.ndjson          # incremental raw events, even before run completion
  result.json            # cases, assertions, requests, transactions, admissions,
                         # inferences, observations, and all events
  assessment.json        # required coverage and expected negative-control checks
  summary.json           # counts, latency by case/UID/outcome, outstanding work
  environment.json       # backend/SDK/build provenance and explicit limitations
  firestore.rules        # synthetic namespace policy
  findings.md            # checks with observed/expected values and limitations
```

`requestId` is the logical request; `attemptId` identifies each gateway invocation;
`invocationId` identifies an SDK transaction; `attempt` counts callback executions.
Every event has run/case IDs and local sequence. `elapsedMs` is the recorder's
process-monotonic timestamp, not a distributed wall clock. Request durations are
measured within a single gateway process. Staged writes are not committed writes.
A transaction acknowledgement is distinct from an application response; injected
lost acknowledgements are explicitly scenario-controlled.

Use `assessment.json` first, then inspect failed assertions in `findings.md` and
join their case/request IDs into `events.ndjson`. `summary.json` separates denial,
failure, completion, and timeout latencies by user. It never drops timeout results
from the report, counts unknown billing as null, and does not convert operation
counts into money. Fault delays are included in the named fault scenarios and
are not Firestore latency observations.

Compare only matching implementation, Rules, workload and selected-case hashes.
The comparator never labels local and hosted timings performance-comparable.
Dependencies are fingerprinted but not bundled. Replay uses installed dependencies,
so inspect environment hashes before claiming the environment is identical.

## Hosted comparison and AI deployment preparation

`adapters/firestore-admin.mjs` is a real Admin SDK adapter. It uses Application
Default Credentials, requires a named project and dedicated named database, and
writes only under `allowanceExperiments/<run-id>/cases/<case-id>`. It uses the same
admission implementation as Pyric. The example selection runs fake inference and
controlled-clock correctness cases, not a capacity benchmark. The source includes
this adapter; the first hosted observations are linked below.

Copy `config/firestore.example.json` outside the source capture directories and
set a test project/database you have provisioned. ADC is supplied separately.
Do not put credentials in the JSON. This command validates configuration offline:

```sh
bun experiments/rate-limiting/inference-allowance/run.mjs preflight --config /tmp/allowance-firestore.json
```

Offline validation returns `ready: false`; it does not imply that ADC works.
An explicit read-only probe authenticates with ADC and fetches database metadata:

```sh
bun experiments/rate-limiting/inference-allowance/run.mjs preflight --config /tmp/allowance-firestore.json --probe
```

The probe verifies Native mode and records location, edition and concurrency mode.
It performs no document writes, Rules deployment, or database creation. A successful
probe does not establish document write permission or deployed Rules correctness.
Emulator environment overrides are rejected for hosted runs.

After supervising the target and permissions, explicitly authorize a database run:

```sh
bun experiments/rate-limiting/inference-allowance/run.mjs run --config /tmp/allowance-firestore.json --allow-production --out /tmp/allowance-hosted
```

This sends no paid inference. Records are retained for inspection; cleanup is a
separate supervised operation, scoped by run ID. No automatic database deletion,
Rules deployment or global Auth changes occur. Client Rules tests are unsupported
on this adapter until independently authenticated client actors are supplied;
they cannot silently count as passed. Production max-attempt and timeout behavior
is native to its SDK and is not claimed identical to Pyric.

Hosted configurations must explicitly select supported cases and set
`limits.maxRequests` (at most 200). This ceiling applies across both gateway
instances and all cases, before a new gateway request starts. Reaching it marks
the case incomplete/error instead of silently omitting excess requests. It bounds
request submissions, not billing: native retries and fixture operations add reads
and writes. The CLI has a separate 60-second child-process deadline.

`portable-burst` sends 50 requests from Alice and 5 from Bob across two gateway
instances. It checks allowance conservation and dispatch uniqueness, while
recording completion, rejection, failure, timeout, charge, and retry counts. It
requires each user to make some progress, but does not require a particular retry
count or assume every unadmitted request receives a quota denial.

Use `baseline HOSTED_CAPTURE` to run the exact archived source and selected workload
against Pyric. The new input explicitly selects local mode, inherits the request
ceiling, and records parent lineage and the input override. It never opens the
hosted adapter. `compare` first verifies both captures, then retains environment
metadata and observed outcomes alongside invariant decisions. Compatible means
matching source/workload and complete coverage; it does not mean equal behavior.

A failed or timed-out child process now finalizes an explicitly incomplete capture
from partial events and available environment metadata. Its manifest and archived
source remain verifiable, and a local baseline can still run. Incomplete coverage
cannot pass assessment or comparison. The finalizer never connects to Firestore.
Unacknowledged native writes may still have committed; it does not infer rollback
from a killed process. Older captures without recovery support retain their prior
behavior. See the [database metadata API](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases)
for the recorded settings.

`config/production.example.json` and `services/ai-logic.mjs` prepare a nonstreaming
AI Logic integration. That transport requires per-user Firebase Auth and App Check
credentials and a mandatory **shared server-enforced dispatch-budget callback**.
It does not retry provider calls. Its wire format follows the installed Firebase
SDK; only fixture transport tests run locally. A real model smoke test remains
unperformed. Secrets and prompt/response bodies are excluded from observations.

The production-integration CLI profile is deliberately **preflight-only** in this
milestone: there is no deployed gateway wrapper, remote trace collector, or verified
route enforcement. Preflight reports those gaps, rather than accepting a URL as
proof of enforcement. Before enabling paid runs, connect the adapter to a deployed
gateway, record its source/policy revision and database concurrency mode, verify
identity and category selection, exercise direct-call bypass, and collect matching
service traces. Bound the deployed service's dispatches, not only the load generator.

AI Logic blocking hooks are an alternative deployment boundary for the same
admission code, but currently cover only `generateContent`; streaming and Live API
bypass the hooks. A hook-only deployment must not be described as protecting all
AI routes. See the official [hook documentation](https://firebase.google.com/docs/ai-logic/pre-and-post-request-scripts).
The Admin adapter bypasses Firestore Rules; the gateway's admission code is the
policy enforcement boundary.

## Acceptance for this local milestone

- Retain the unsafe overspending control and a passing transactional 50-request case.
- Exercise refill/clock boundaries, initialization, categories/users, multiple
  gateways, duplicates, malformed state, auth failures, overload and fault recovery.
- Capture executed source and evidence, verify/replay it, and preserve older
  multiplayer capture compatibility.
- Prepare explicit production configuration/adapter boundaries without deployment
  or paid inference. Clearly report remaining production capabilities as unverified.

Hosted Firestore observations are recorded below. A later milestone measures
repeated workloads and Cloud Run impact on normal users. No local timing result establishes protection from unlimited floods.

## Recorded local results

The [completed capture](results/3cf50396-d041-4776-b536-3b15a03593cc/findings.md)
contains 17 scenarios, 386 requests, and 69 checks: 68 passing invariants plus the
expected failing invariant in the unsafe control. Snapshot verification and replay
passed with matching implementation, Rules, and workload fingerprints.

- A simultaneous burst of 50 requests admitted 5 and denied 45. Native transaction
  retries occurred; the final chat balance was zero.
- The unsafe separate-read/write control dispatched all 50 requests against the
  same capacity of 5, demonstrating that the harness detects overspending.
- Duplicate requests, two gateway instances, independent users/categories,
  timeouts, lost acknowledgements, provider failures, and malformed state produced
  the expected decisions. Other-user requests completed in the local flood cases.
- These observations establish the tested accounting behavior. They do not measure
  production locks, billing, unlimited-flood isolation, or Cloud Run capacity.

The [earlier failed capture](results/2ae8baea-f35c-40b4-8431-9c645f813676/findings.md)
preserves a real implementation bug: a null bucket was incorrectly treated as a
new bucket and replenished. The current implementation rejects it. That historical
capture predates the Rules-loading and clock-provenance corrections; use the
completed capture for current provenance and comparison.

Verification: `bun test experiments` passed 19 tests with 94 assertions, including
existing multiplayer captures. Production preflight remained `ready: false` with
network access disabled. No hosted database or inference request was performed.

## First hosted comparison

[Results and interpretation](comparisons/first-hosted/README.md) retain two hosted
runs and their exact-source Pyric baselines. The first hosted burst hit every
request deadline; a second run with sequential work before the burst completed
five admissions per user, with three remaining Alice requests timing out. Both
preserved the allowance invariant. These are workload observations, not a
production capacity claim.

The hosted-comparison milestone passed 25 tests with 125 assertions, including
multiplayer replay compatibility. Scoped TypeScript checking passes. Metadata
preflight was exercised against the named database; actual AI Logic inference
and a deployed gateway remain unverified.

## HTTP overload pilot (local Node + Express)

This suite adds a real HTTP boundary to the allowance experiment. The controller
starts a fresh **Node** Express server and a separate **Node** load generator for
each case. Only workload requests cross HTTP; startup, trace collection and orderly
drain use IPC. Each server owns a fresh Pyric sandbox and one admission gateway.
Inference is immediate, fake, and free. Nothing is deployed or sent to Firebase.

```sh
bun install --frozen-lockfile
# Requires built Pyric exports and Node on PATH (verified with Node 22.18.0).
bun experiments/rate-limiting/inference-allowance/run.mjs run \
  --config experiments/rate-limiting/inference-allowance/config/http-overload.json \
  --out experiments/rate-limiting/inference-allowance/results

bun experiments/rate-limiting/inference-allowance/run.mjs analyze <capture-directory>
bun experiments/rate-limiting/inference-allowance/run.mjs verify <capture-directory>
bun experiments/rate-limiting/inference-allowance/run.mjs replay <capture-directory>
bun test experiments/rate-limiting/inference-allowance/tests/http-overload.test.ts
```

The eight cases send **218 requests**, below a preflight ceiling of 250:

| Case | Offered workload | Admission guard | Injected delay |
| --- | --- | --- | --- |
| `http-normal` | Six requests, Bob/Carol | None | None |
| `http-unguarded` | Alice burst of 50 + six Bob/Carol probes | None | Alice's first transaction read waits 600 ms |
| `http-user-guard` | Same burst and probes | Two per UID | Same |
| `http-combined-guard` | Same burst and probes | Two per UID, sixteen per instance | Same |
| `http-instance-guard` | Twenty distinct users simultaneously | Two per UID, sixteen per instance | Each first read waits 600 ms |
| `http-timeout-drain` | Two held requests, six probes, retry, recovery | Two per UID, sixteen per instance | Two Alice commit acknowledgements held for 1,200 ms; admission deadline 200 ms |
| `http-disconnect-drain` | Same; Alice disconnects at 50 ms | Same | Same |
| `http-instance-drain` | Alice/Dave disconnect; Eve retries then recovers | Two per UID, two per instance | Same delayed settlement; proves the instance counter stays occupied |

Normal burst admission deadlines are 2,000 ms. The admission clock is fixed, so
lazy refill does not blur this short overload experiment. The timeout cases send
a retry at 400 ms and recovery at 1,500 ms. The harness asserts the observed event
ordering; it does not infer settlement from the planned timer offsets. An injected
after-commit delay is **not** a claim that Firestore committed after a deadline.

`architecture/gateway.mjs` applies both guards after fixture authentication and
request validation, before database work. There is no waiting admission queue.
A full guard returns HTTP 503 with `reason: user_capacity` or `instance_capacity`;
quota exhaustion returns 429; admission deadline returns 504. Capacity is retained
until underlying work settles even when the HTTP response times out or the client
disconnects. A slot is released before inference begins: this pilot bounds
**admission/database work**, not concurrent long-running inference or all sockets.

Code ownership:

- `scenarios/http-overload.mjs`: versioned schedules, delays, required checks.
- `services/http-server.mjs`: loopback-only Express endpoint, synthetic identities,
  public Pyric Admin store, HTTP outcomes, resource sampling, graceful drain.
- `harness/http-load-generator.mjs`: open-loop HTTP arrivals in a separate process;
  fresh sockets, no response-dependent scheduling, explicit disconnects and client
  transport failures. Scheduler lag is measured so generator delay is visible.
- `harness/http-runner.mjs`: process lifecycle, 15-second case deadline, request
  ceiling, observations and checks. Children exit if their controller disconnects;
  the controller kills and reaps remaining children on failure.
- `analysis/http-summary.mjs`: per-user/outcome client latency, scheduler lag,
  peak admission counts, transaction attempts, post-response settlement time,
  sampled RSS, CPU usage, event-loop utilization and delay.

`events.ndjson` retains client and server observations. Every child event carries
its role, PID, local sequence and local monotonic elapsed time. The outer sequence
and elapsed time reflect **controller receipt**, not a synchronized remote clock.
Join client attempts via `clientAttemptId`/`requestId`, then join gateway and
transaction observations via `attemptId`. Never subtract clocks across processes.
CPU and memory include instrumentation; RSS is sampled every 50 ms, not an exact
peak. Transaction attempts and staged writes are not billable-operation counts.

The existing capture machinery archives the executed source beside normalized
results, workload, Rules, summaries, dependency lock hash, Pyric build hash, and
manifest. Replay uses archived source with current installed dependencies and
records their provenance; it does not archive dependency binaries. Incomplete
runs cannot pass assessment or comparison. HTTP cases are opt-in; the previous
direct-call suite and historical captures keep their behavior.

Passing these cases establishes bounded local admission under the named workloads.
It does not establish a production RPS ceiling, infinite-flood isolation, actual
Firebase authentication overhead, Firestore lock behavior, Cloud Run autoscaling,
or a global multi-instance semaphore. Those require the next hosted experiments.

### First recorded HTTP run

Capture [`85a0edd1-b8a3-47f9-ad75-5aed664fba6b`](results/85a0edd1-b8a3-47f9-ad75-5aed664fba6b/findings.md)
ran the eight cases above: **218 requests, 68 passing checks**, zero unexpected
client transport errors. Four intentional disconnects are retained separately.
Source and artifact integrity verification passed. The captured implementation
comes from local commit `05e669f3`; both HTTP processes used Node 22.18.0 and the
server used Express 5.2.1.

| Burst mode | Peak Alice admission work | Rejected before DB | Total transaction attempts, including normal users | Bob/Carol completions |
| --- | ---: | ---: | ---: | ---: |
| Unguarded | 50 | 0 | 116 | 6/6 |
| Two per UID | 2 | 48 | 17 | 6/6 |
| Two per UID + sixteen per instance | 2 | 48 | 17 | 6/6 |

The unguarded case still enforced the allowance: five Alice inferences completed,
while forty-five exhausted quota. The admission guard reduces concurrent database
work rather than increasing the allowance. The separate twenty-user burst reached
sixteen occupied instance slots and rejected four requests before database work.

In each delayed-settlement case, work remained alive for approximately one second
after the 200-ms gateway response deadline. Retried requests were rejected during
that interval and succeeded after settlement, including Eve's request while Alice
and Dave occupied the instance. No expired request dispatched inference. These
are measured consequences of the named injected delays, not Firestore latency.

All normal-user probes completed even without a guard in this local run. The run
therefore demonstrates reduced admission work and correct slot ownership; it does
**not** demonstrate that an unguarded production server protects normal users.
Three responses per normal user per case are too few to characterize latency tails.

Validation: `bun test experiments` passed **34 tests / 198 assertions**, including
historical multiplayer captures, HTTP replay, missing Node, and controller death
with partial evidence. Scoped TypeScript checking and both review axes passed.

## Cloud Run deployment

The private combined-guard service is deployed in `digame-mas` / `us-east4`. See
[deployment/CLOUD-RUN.md](deployment/CLOUD-RUN.md), including credential-free
packaging, pinned dependencies, named Firestore targeting, and an authenticated
smoke check. On 2026-09-19, unauthenticated access returned 403 and an authenticated
request completed real Firestore admission with fake inference. Exact source and
deployment evidence are retained alongside the deployment docs. A subsequent
[bounded hosted observation](deployment/measurements/ade4c25b-c830-4b1f-afff-3a1c1983cb7e/findings.md)
sent 88 requests and passed all 18 checks, including pre-Firestore capacity
rejection and other-user completion. The full hosted fault/control matrix remains
separate work.

## Inference concurrency protection (local)

The next stage reserves execution capacity separately from admission capacity.
`architecture/gateway.mjs` accepts `maxExecutionPerUid`, `maxExecution`, and
`inferenceTimeoutMs`. Limits default to unlimited and inference deadlines default
to disabled, preserving existing callers. Reserving before Firestore means an
`execution_busy` rejection (503) cannot consume allowance. Reservations include
admission time; actual provider activity is measured separately. Slots release
when provider work settles, not at first chunk, response timeout or disconnect.
Inference timeouts return 504 (or a terminal NDJSON outcome after stream headers).
Cancelled client responses are internal 499 outcomes when no socket remains.
No automatic refunds or provider retries were added.

```sh
bun experiments/rate-limiting/inference-allowance/run.mjs run \
  --config experiments/rate-limiting/inference-allowance/config/inference-concurrency.json \
  --out experiments/rate-limiting/inference-allowance/results
bun test experiments/rate-limiting/inference-allowance/tests/inference-concurrency.test.ts
```

Nine cases, 65 offered requests, cover an admission-only negative control, user
and instance execution bounds, real chunked HTTP streaming, inference timeout,
disconnect with ignored cancellation, delayed cancellation confirmation, provider
failure with duplicate retry, and a short sustained-arrival workload. The provider
is a host-controlled observable fake (`services/lifecycle-inference.mjs`); database
operations use the existing public Pyric Admin seam. Execution assertions are in
`analysis/execution-checks.mjs`; summaries include provider/slot peaks, cancellation,
stream chunks, post-response settlement, and existing process resource samples.
The negative control must violate the proposed execution limit for assessment to
pass. Captures retain the entire source and are replayed with the existing tools.

[Scope and hypothesis](INFERENCE-CONCURRENCY.md) define the intended guarantees.
The experiment does not measure real-provider cancellation, distributed/global
concurrency, production capacity, streaming consumer backpressure, or forced
process termination. A never-settling provider retains its slot; the harness's
case deadline reports incompleteness rather than assuming cancellation. The
existing Cloud Run deployment still runs its archived admission-only revision.
