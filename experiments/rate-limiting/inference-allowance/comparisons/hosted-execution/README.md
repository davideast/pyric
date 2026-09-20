# Inference execution protection: Pyric vs Cloud Run + Firestore

> Public findings only. Original data, manifests and source snapshots are in the
> [private evidence archive](../../../../EVIDENCE.md).

Measured 2026-09-19. Both environments enforced the execution limits. The hosted
run also exposed a transport difference: closing the client connection did not
notify the Cloud Run container. Provider cancellation never started in those two
cases. Holding capacity until provider settlement remained safe.

This is a bounded correctness/lifecycle experiment with fake inference, not a
production capacity certification or a test of actual AI Logic cancellation.

## Evidence and deployment

- [Paired Pyric baseline — private archive](../../../../EVIDENCE.md): all 147 expectations matched, including the deliberately violated admission-only capacity bound.
- [Cloud Run + Firestore measurement — private archive](../../../../EVIDENCE.md): 145 of 147 expectations matched; complete evidence, two behavioral differences.
- [Machine-readable comparison — private archive](../../../../EVIDENCE.md): verified manifests, matching architecture and workload hashes, observations for every case.
- [Deployment record — private archive](../../../../EVIDENCE.md): exact packaged source, image digest, successful smoke checks and adjacent actual service configuration.

Active private revision: `allowance-overload-00003-n5h`, `digame-mas`, `us-east4`.
Database: `allowance-experiments`, Native, pessimistic concurrency. Backend run:
`cloudrun-d5919161-ff7c-49cd-82ab-959a2a9fa30b`. Deployed source SHA-256:
`29c48aa0e3cb882fcacaed85d95f47487aaf097a9c05cbb205cf392f89479675`.
Implementation commit: `d3ad6756`.

Deployment remains IAM protected (unauthenticated smoke returned 403). It uses
one configured maximum instance, concurrency 80, one CPU, 512 MiB, a 10-second
Cloud Run timeout, and CPU allocation outside requests. Actual observations came
from one instance throughout. Synthetic actor headers are restricted to the
experiment operator; this is not a production end-user authentication design.

Each environment sent 65 inference requests across nine cases. Each captured all
65 server starts, responses and settlements, with contiguous server event
sequences and matching invocation IDs. Two client disconnects are recorded
separately from their absent HTTP responses. Source, raw observations, workload,
environment and assessment are retained together; hosted evidence also includes
raw Cloud Logging and initial/final Firestore snapshots. Hosted receipts grew
from one deployment-smoke receipt to 35, matching 34 measured admissions.

The earlier development baseline
[7fbfbfe6-718b-46d4-9acf-7f697217bfd5 — private archive](../../../../EVIDENCE.md)
is retained unchanged. It preceded the shared HTTP handler and strengthened
completeness checks, so it is not the paired baseline used for conclusions.

## Observed behavior

| Case | Pyric | Cloud Run + Firestore |
| --- | --- | --- |
| Admission-only control | Six providers overlapped | Six providers overlapped |
| Instance execution limit of two | Two completed; four rejected before DB work | Same |
| User execution limit of one | Same-user overlap rejected; other user and recovery completed | Same |
| Streaming | All three chunks delivered; receipt acknowledged before settlement; overlapping work rejected | Same |
| Server inference timeout, ignored cancellation | Slot held about 450 ms after gateway timeout response | Slot held about 449 ms after gateway timeout response |
| Client disconnect, ignored cancellation | Provider received cancellation request and ran to completion | Container received no disconnect/cancellation request; provider ran to completion |
| Client disconnect, confirming provider | Cancellation requested and confirmed; held provider lasted about 360 ms | Cancellation never requested, so no confirmation; held provider lasted about 601 ms |
| Provider error and duplicate retry | One failed invocation; duplicate did not invoke again; new request recovered | Same |
| Short sustained arrivals | Busy user: four complete, 20 rejected. Other users: six complete | Busy user: three complete, 21 rejected. Other users: six complete |

All guarded cases respected configured provider-concurrency bounds and ended
with zero execution reservations. No capacity-rejected attempt performed a
Firestore transaction. The admission-only negative control deliberately exceeded
the proposed execution limit; treating that expected failure as a regression
would invert the experiment's meaning.

The two hosted assertion failures are `cancellation ignored` and `cancellation
confirmed`, both in disconnect-triggered scenarios. They do not demonstrate a
broken provider cancellation adapter: no abort reached that adapter. The timeout
scenario still initiated cancellation from the server as intended.

There is no hosted post-disconnect gateway-response interval to compare directly:
the gateway did not recognize the disconnect and returned only after work ended.
A zero-sample post-response summary therefore does not mean work stopped when
the phone disconnected. Full provider duration and absent cancellation events
show what happened. We do not subtract client timestamps from server timestamps.

The sustained fixture offers 24 busy-user requests over 1.84 seconds. Time from
server request start to provider dispatch was median 1.70 ms locally versus
81.38 ms hosted (hosted range 60.74–98.79 ms). Execution reservations cover that
admission work as well as inference. The longer observed occupancy explains why
fewer requests fit in this particular arrival schedule; it is not evidence of
unfairness or a fixed production throughput ceiling. All six other-user calls
completed in both runs. Client scheduling lag remained below 4.1 ms.

## What changes in our understanding

The progression remains transactional allowance enforcement → admission
concurrency control/load shedding → inference execution concurrency control.
These protect different resources. The third layer passed its concurrency
safety checks against real Firestore and Cloud Run in this single-instance run.

Socket closure is not a reliable cancellation protocol behind Cloud Run's
HTTP/1.1 proxy. This agrees with [Google's documented behavior](https://docs.cloud.google.com/run/docs/troubleshooting).
A server deadline can initiate abort independently. If explicit user cancellation
is required, test an application cancellation operation keyed to the admitted
request, and verify the real provider's cancellation/settlement contract. Until
then, keep the slot reserved; aborting a local fetch alone does not prove remote
inference ended.

For Pyric, the evidence supports its transaction/accounting behavior in these
fixtures. The differences are the hosting transport and real database latency,
not a demonstrated Firestore state-semantic defect. Preserve this hosted fixture
as a transport conformance check. Future local exercises can explicitly simulate
a proxy that does not forward disconnects, without claiming that ordinary
loopback HTTP is Cloud Run-equivalent.

Still untested: actual AI Logic streaming/cancellation, multiple service instances,
global provider budgets, fairness under sustained saturation, instance death and
restart, never-settling providers, slow-consumer backpressure and long-duration
memory stability. No real AI calls were made. Do not infer universal production
readiness from this run.

## Reproduce the comparison

From the repository root:

```sh
node experiments/rate-limiting/inference-allowance/analysis/compare-execution.mjs \
  experiments/rate-limiting/inference-allowance/deployment/measurements/623ea0fd-6d2c-4223-b967-7c70fba29355 \
  experiments/rate-limiting/inference-allowance/deployment/measurements/f81abaf2-5bb9-410a-b018-0f4aa6bf638b
```

The command verifies all manifest hashes, complete evidence, and matching workload
and architecture hashes before comparing observations. It refuses incompatible
or incomplete captures. See [deployment instructions](../../deployment/CLOUD-RUN.md)
for a new run; deploy a fresh namespace instead of resetting these records.

Validation: 43 experiment tests passed with 299 assertions, scoped TypeScript
checking passed, and standards/spec reviews were resolved before deployment.
The hosted run's two behavioral differences remain failed assertions in its
immutable evidence; no expectation was relaxed after observing the outcome.
