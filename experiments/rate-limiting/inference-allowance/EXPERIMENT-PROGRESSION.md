# From per-user allowance to protected inference execution

This series began with a practical question: can a Node/Express gateway use
Firestore as its only shared coordination store to enforce per-user LLM request
allowances without one user's burst overwhelming the service?

The evidence supports that architecture as a foundation, with three distinct
protections working together:

**Transactional allowance enforcement → admission concurrency control and load shedding → inference execution concurrency control.**

Each stage addresses a failure the previous stage leaves possible. They are
additive layers, not competing rate-limiting algorithms. An allowance can remain
correct while requests time out. A server can protect its database while allowing
too many long-running model calls. A client can disconnect while its inference
continues to consume capacity.

The experiments used Pyric for inexpensive local iteration, then real Firestore
and Cloud Run to measure which conclusions survived those environments. All
inference was simulated. No stage yet verifies real AI Logic execution, billing,
or cancellation.

**The terminology matters.**

| Technique | Question it answers | Resource or invariant protected | What rejection means |
| --- | --- | --- | --- |
| Cooldown check | Has enough time passed since the last operation? | Minimum spacing between eligible writes | Too soon |
| Transactional token bucket | Does this user have credit for another request? | Per-user/category allowance | Allowance exhausted; 429 in this gateway |
| Admission concurrency control | Can this process undertake another allowance/dispatch check now? | Outstanding database admission work | Temporarily busy; 503 |
| Inference execution concurrency control | Can this process reserve capacity for another inference? | Reserved execution capacity and active provider work | Temporarily busy; 503 |
| Deadline | How long should the gateway wait before returning a timeout? | Waiting time, subject to runtime scheduling | Timed out; underlying work may remain |
| Idempotency receipt and dispatch claim | Has this logical request already been admitted or claimed for execution? | Duplicate charging and redispatch | Duplicate or conflict; not necessarily a saved answer |

“Overload experiment” names a workload and the condition being studied. The
technique it exercises is **concurrency-based admission control with immediate
load shedding**. Likewise, “inference protection” is specifically **execution
concurrency control with release on provider settlement**.

**The starting point: a cooldown was useful, but answered a narrower question.**

The initial discussion examined `cooldownElapsed` from the Rules Standard Library.
Its implementation compares `request.time` with a stored timestamp plus a duration.
It uses a strict comparison: an operation at the exact boundary is still too soon.
The intended update pattern also requires a server timestamp on the same write,
so the caller cannot choose a misleading last-operation time.

That is a minimum-spacing policy. It does not itself provide a refillable balance,
separate chat and agent budgets, or a burst allowance. The subsequent experiment
therefore moved to a token bucket. The cooldown discussion was not a measured
Rules-only version of the hosted LLM gateway. [Timing implementation](../../../packages/pyric/src/rules/modules/stdlib/timing.rules).

This distinction also corrects a recurring description of the work: the measured
allowance mechanism was **gateway-owned transactional code using the Admin SDK**.
It was not Firestore Security Rules enforcing the LLM allowance. Server libraries
bypass those Rules and use IAM; the gateway is responsible for applying the policy.
[Firebase documentation](https://firebase.google.com/docs/firestore/security/rules-conditions).

**Stage one: make allowance accounting correct under concurrency.**

The original shared-state design was one quota document per UID, containing
separate chat and agent token buckets. The fixture gives chat five initial credits
and a refill rate of ten per minute; agent gets two initial credits and one per
minute. Refill is calculated lazily when a new request arrives, capped at bucket
capacity. No background refill worker is necessary.

A token bucket permits bursts and a sustained refill rate. It is not a strict
“no more than N requests in every rolling minute” policy. That is a product
semantics decision, not an implementation detail. Each admission currently costs
one credit regardless of model, token count, or inference duration. Model-based
keying remains deferred. Chat and agent balances are logically independent, but
share a UID's quota document and therefore its transaction contention.

The critical operation reads the quota and UID-scoped request receipt in one
transaction, then atomically writes the debit and receipt. A second transaction
claims dispatch. The provider call happens outside both transactions, so a retried
transaction callback cannot itself invoke inference again.

A deliberately unsafe separate-read/separate-write control demonstrated why the
transaction matters. With five credits and fifty simultaneous requests, that
control admitted fifty. The transactional version admitted five and denied
forty-five. The retained initial suite covered 17 cases and 386 requests, including
refill, category/user isolation, duplicates, malformed state and uncertain outcomes.
Its expected negative control stayed failed. [Initial accounting evidence](results/3cf50396-d041-4776-b536-3b15a03593cc/findings.md).

Receipts also exposed a trade-off that persists through the entire series. Once a
dispatch reservation commits, a duplicate cannot simply invoke the provider again.
This favours avoiding duplicate execution over automatic recovery. A crash or
uncertain acknowledgement can consume allowance without delivering an answer.
A duplicate result is not evidence that a response is available. There is no
exactly-once provider guarantee, automatic refund, or result cache in this pilot.

**The first hosted comparison separated correctness from availability.**

Two direct-call runs placed the gateway on the development machine and used real
Firestore in `digame-mas/allowance-experiments`. Each had an exact-source Pyric
baseline. Neither hosted run was a Cloud Run deployment.

The striking result was that allowance safety held even when progress was poor:

| Fifty-request Alice burst plus five Bob requests | First hosted run: burst first | Second hosted run: sequential refill case first |
| --- | ---: | ---: |
| Alice completed | 0 | 5 |
| Alice quota denials | 0 | 42 |
| Alice timeouts | 50 | 3 |
| Bob completed | 0 | 5 |
| Bob timeouts | 5 | 0 |
| Last underlying burst work settled | About 27.4 seconds from burst start | About 2.42 seconds from burst start |

In the first run, all fifty-five calls returned at roughly the two-second gateway
deadline. One debit nevertheless committed, with acknowledgement arriving after
the deadline; no inference dispatched. Returning a timeout had neither cancelled
the database work nor rolled back that debit.

The Pyric baselines completed five requests for each user without those timeouts.
They also produced different callback retry counts. Real Firestore and Pyric
agreed on the allowance bound, but not on contention timing or availability.
[Paired hosted allowance evidence](comparisons/first-hosted/README.md).

This did not establish that Alice's document locked Bob's document, nor that a
particular cold-start effect caused the first result. There was only one run of
each ordering. Startup, connection and service conditions were not isolated.
Firestore documents that server-library latency and contention interact, which
makes placement relevant, but does not identify the cause of this particular run.
[Firestore contention documentation](https://firebase.google.com/docs/firestore/transaction-data-contention).

The conclusion was narrower and more useful: **correct accounting does not bound
the work spent checking that accounting**. Separate user documents do not isolate
all the gateway, SDK, networking and database resources used to reach them.

**Stage two: reject excess admission work before it reaches Firestore.**

The next technique added per-user and per-process concurrency gates. A request
must obtain an admission slot before database work. When slots are full, the
gateway returns a busy response immediately; it does not create a waiting queue.

The combined fixture allows two outstanding admissions per UID and sixteen per
instance. These are simultaneous-operation limits, not requests-per-second limits.
A slot becomes reusable when the protected work settles. The admission slot is
released before inference starts. Timed-out database work retains its slot until
it settles, preventing a timeout from silently allowing replacement work on top
of an operation that is still running.

The local HTTP suite used real Node/Express HTTP, a separate load-generator
process and Pyric transactions. Its controlled burst deliberately injected a
600-ms read delay. It produced this comparison:

| Local fifty-request Alice burst plus six other-user probes | No admission guard | Two per UID | Two per UID and sixteen per instance |
| --- | ---: | ---: | ---: |
| Peak Alice admission work | 50 | 2 | 2 |
| Requests rejected before database work | 0 | 48 | 48 |
| Total transaction callback attempts, including other users | 116 | 17 | 17 |
| Other-user completions | 6 | 6 | 6 |

The allowance was still five credits in every variant. The guard reduced the cost
of facing the burst; it did not increase the allowance. The attempt counts are
instrumented SDK observations, not billable read/write counts. All other-user
probes also completed in the unguarded local case, so this result alone did not
prove that unguarded production traffic was safe or unsafe.

A twenty-user case filled sixteen instance slots and rejected four requests.
Injected timeout/disconnect cases confirmed that pending work retained user and
instance slots until settlement, and later requests recovered. These were
controlled lifecycle tests, not observations of production Firestore delays.
[Local HTTP evidence](results/85a0edd1-b8a3-47f9-ad75-5aed664fba6b/findings.md).

**Cloud Run then demonstrated admission shedding against real Firestore.**

The first hosted HTTP observation sent 88 requests through one private Cloud Run
instance. It used immediate fake inference and no injected 600-ms database delay.
All eighteen checks passed.

Alice's fifty-request burst produced three completions and forty-seven capacity
rejections. All six other-user probes completed. Twenty distinct users produced
sixteen completions and four capacity rejections. Every capacity-rejected request
performed zero transaction attempts. The run also exercised category allowance,
duplicate requests, invalid synthetic actors and recovery.

Three Alice completions did not violate a two-slot limit: a later request arrived
after an earlier slot was released. Concurrency limits restrict overlap, not the
total completions in a burst. [Hosted admission evidence](deployment/measurements/ade4c25b-c830-4b1f-afff-3a1c1983cb7e/findings.md).

This hosted observation and the earlier local HTTP suite were not identical
experiments. Their schedules, delay injection and clocks differed. We can compare
which invariants held, but cannot honestly attribute their latency or completion
count differences solely to Pyric versus Firestore.

The remaining gap was downstream: immediate fake inference hid how many slow
provider calls could accumulate after admission slots were released.

**Stage three: retain execution capacity for the provider's whole lifetime.**

The next technique introduced separate per-user and per-instance execution
reservations. The gateway reserves this capacity before entering the allowance
transactions, so a capacity rejection cannot consume a credit. This is conservative:
the reservation covers admission time as well as inference, while telemetry counts
actual provider calls separately.

The essential lifecycle is:

```text
Validate identity and request
        |
Check admission capacity and reserve execution capacity
        |
Transactional allowance debit and receipt
        |
Transactional dispatch claim
        |
Release admission capacity
        |
Run inference / stream chunks
        |
Provider operation settles
        |
Release execution capacity
```

Branches that never invoke the provider release their reservation when their
work settles. Once inference begins, the first chunk, a gateway timeout, or a
client disconnect does not by itself release execution capacity.

The admission-only negative control made the gap observable: six slow provider
calls ran simultaneously even though each request's admission phase was short.
With an instance execution limit of two, only two ran and four were rejected
before database work. Separate cases exercised per-user protection, streaming,
ignored cancellation, confirmed cancellation, provider failure, duplicate retry,
recovery and short sustained arrivals. [Initial local execution findings](comparisons/inference-concurrency/README.md).

**The latest hosted comparison matched architecture and workload.**

Before deploying this stage, the harness was strengthened to run the same hosted
router and load client locally against Pyric. The paired runs verify matching
architecture and workload hashes. Both offered 65 requests across nine cases.
The differences in backend, transport and runtime remain deliberate; matching
code does not make performance equivalent.

| Observation | Paired Pyric run | Cloud Run + Firestore |
| --- | --- | --- |
| Admission-only negative control | Six providers overlapped | Six providers overlapped |
| Execution limit of two | Two completed, four rejected | Same |
| Streaming | Three chunks delivered; overlap rejected | Same |
| Server timeout with cancellation ignored | Slot held about 450 ms after gateway timeout | About 449 ms |
| Disconnect with a cancellation-confirming provider | Abort reached provider; held call ended around 360 ms | No abort reached provider; held call lasted around 601 ms |
| Provider failure and duplicate retry | No second dispatch; new request recovered | Same |
| Busy user's short sustained workload | Four completed, twenty rejected | Three completed, twenty-one rejected |
| Other users in that workload | All six completed | All six completed |

All guarded cases respected their execution limits and drained reservations. The
local run matched all 147 expectations; the hosted run matched 145. The two
unmatched expectations concerned disconnect-triggered cancellation. Evidence was
complete; they were behavioural differences, not missing logs.

In Cloud Run, closing the client socket did not notify the HTTP/1.1 container.
Consequently neither disconnect scenario initiated provider cancellation. This
matches Google's documented transport behaviour. The server's own inference
deadline still initiated cancellation in the timeout case.
[Cloud Run documentation](https://docs.cloud.google.com/run/docs/troubleshooting).

The guard stayed safe because it waited for provider settlement. However, a UI
“stop” action implemented only by closing the HTTP connection would not stop the
work in this deployment. Explicit application cancellation and real-provider
cancellation semantics need separate validation.

The sustained fixture was short: twenty-four busy-user arrivals over 1.84 seconds.
Median server-start-to-provider-dispatch time was 1.70 ms locally and 81.38 ms
hosted. Reservations include that interval, so the hosted result is consistent
with fewer opportunities to reuse a slot in the same schedule. It is not a
production throughput estimate. [Full paired execution evidence](comparisons/hosted-execution/README.md).

**What the series establishes about the original proposal.**

Firestore has been sufficient as the only shared coordination store for the
transactional allowance tested here. Node/Express process-local gates have bounded
admission and inference concurrency in the observed single-instance workloads.
The evidence has not established a need for Redis, a queue, or a different quota
store for this scope.

The original quota-document idea by itself is insufficient for the whole problem.
It limits spending but leaves the gateway free to undertake many concurrent checks
and, after those checks, many concurrent provider calls. Relying on contention
as the throttle exposes latency and uncertain-outcome problems demonstrated by
the early hosted run.

Combining all three layers is the tested improvement. It still is not universal
production readiness. The allowance is shared through Firestore, but the
concurrency gates live in each process. Multiple replicas can each admit work up
to their own limits. This experiment neither establishes a fleet-wide provider
budget nor proves fairness under a many-user flood. The gates also run after
identity validation and do not protect every ingress/authentication resource.

Current receipts favour duplicate prevention over automatic recovery. They do
not expire in this pilot. Introducing expiry would change the deduplication
window. Counting requests also does not yet control model-token cost or dollar
spend. All production inference paths must actually use the enforced gateway;
direct provider access and Firebase end-user authentication were not tested.

**What Pyric taught us, and what production taught us about Pyric.**

Pyric rapidly exposed the unsafe read/write design and let us repeat accounting,
failure and slot-lifecycle experiments without paid inference. It was valuable
for proving that the harness could detect an intentional violation before we
trusted a passing variant.

Hosted testing then supplied two different kinds of information. Real Firestore
showed that safe transactions can have materially different retry and completion
behaviour. Cloud Run showed that the deployment transport can suppress a signal
that ordinary loopback HTTP delivers. The first concerns database execution and
latency; the second is a hosting characteristic, not a demonstrated defect in
Pyric's Firestore state semantics.

The useful response is to retain those distinctions in fixtures and reports. A
local proxy-mode fixture could deliberately suppress disconnect propagation.
Hosted contention observations should remain evidence about that backend, not
numbers a simulator is made to reproduce with a single arbitrary sleep. Further
production comparisons should distinguish correctness, progress and capacity.

**The next progression should follow the unresolved boundary.**

| Next experiment | Technique to examine | Evidence it should produce |
| --- | --- | --- |
| Real AI Logic streaming and cancellation | Provider-lifecycle enforcement and explicit request cancellation | What stops local waiting, what stops remote inference, and when capacity may safely be released |
| Multiple Cloud Run instances | Distributed concurrency admission, if a global bound is required | Fleet-wide active-work bounds, lease/restart failure behaviour and shared allowance correctness |
| Many-user sustained pressure | Fair scheduling, backpressure or additional load shedding | Completion and rejection distribution, queueing if introduced, latency tails, memory and event-loop stability |
| Crash and ambiguous-outcome recovery | Durable request state and idempotent reconciliation | Whether work can be resumed or reconciled without duplicate inference or unjustified refunds |
| Real usage and model pricing | Cost-aware allowance reservation and settlement | How estimated and actual usage affect budgets without overspending |

These are proposed experiments, not guarantees already supplied by the current
implementation. A distributed lease or queue should be selected for a measured
requirement, with its own failure cases, rather than assumed to be the inevitable
next infrastructure purchase.

The most durable lesson is to name the resource being protected and the event
that proves it is free again. A balance protects credit. An admission slot protects
database work. An execution slot protects provider work. A timeout describes how
long we waited; it does not establish that any of those resources have been released.
