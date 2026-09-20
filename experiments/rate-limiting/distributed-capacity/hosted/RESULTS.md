# Hosted distributed capacity run — 2026-09-20

The nine supported/adapted HTTP scenarios passed all 46 assertions against the
existing `capacity-recovery-00001-k5l` revision and real Firestore
`digame-mas / allowance-experiments`. No deployment, IAM/rules changes, or real AI
calls were performed. The provider was an operator-controlled durable fixture.

- [Hosted result — private archive](../../../EVIDENCE.md)
- [Paired HTTP/Pyric result — private archive](../../../EVIDENCE.md)
- [Verified comparison — private archive](../../../EVIDENCE.md)
- [Hosted log coverage — private archive](../../../EVIDENCE.md)

Both captures retain exact controller source, requests/responses, final documents,
assertions and artifact hashes. The hosted capture also retains the exact deployed
source, image digest and provenance. The analysis verified every capture hash and
all nine deployed source hashes, recomputed the aggregate source hash, and found
byte-identical workload, capacity policy, HTTP dispatcher, provider fixture and
transaction adapter across the two environments. All 46 actual/expected assertion
values match. Local dependency binaries are not archived; this is semantic
comparison, not proof of identical runtime/dependency environments.

## Findings

| Check | Hosted observation |
| --- | --- |
| Shared capacity | 16 simultaneous starts admitted 3 and returned busy for 13; no user held more than 2 slots. |
| Duplicate requests | Eight requests with one key produced one start, seven duplicate responses and one capacity debit. |
| Renewal | Extending the lease prevented premature takeover. |
| Abandoned reservation | Expired undispatched work acquired fence 2 and resumed once. No gateway process was killed. |
| Running takeover / stale fence | Running work kept its slot; old-fence dispatch, renewal and reconciliation were rejected. |
| Recovery race | Eight takeover requests produced one winner, seven live-lease rejections and a single fence increment. |
| Completion | Confirmed completion released capacity once; duplicate settlement and duplicate starts did not release or dispatch again. |
| Cancellation | Provider-confirmed cancellation likewise released capacity once. |
| Uncertain dispatch | Three unresolved dispatch intents retained all three slots, had zero observed provider jobs, and blocked new work. |

Three distinct gateway process IDs served commands. This demonstrates the shared
ledger handled requests across multiple processes in this run. It does not prove
that each takeover crossed processes or establish an autoscaling capacity limit.

Ten fixture start attempts were recorded. Final state was identical: the normal
case contained nine completed and one cancelled reservation with zero occupied
slots; the uncertainty case retained three `unknown` reservations and three occupied
slots. These synthetic records are deliberately preserved, not silently reset.

## Measured differences

| Measurement | Paired HTTP/Pyric | Cloud Run + Firestore |
| --- | ---: | ---: |
| HTTP commands | 106 | 106 |
| Assertions passed | 46 | 46 |
| Observed gateway processes | 1 | 3 |
| Transaction invocations | 115 | 115 |
| Native transaction callback attempts | 115 | 130 |
| Additional transaction attempts | 0 | 15 |
| Whole client workload window | 69 ms | 16,448 ms |
| Command latency median | 0.45 ms | 135 ms |
| Command latency p95 | 9.68 ms | 3,728 ms |
| Command latency maximum | 10.55 ms | 3,908 ms |

Those client latencies mix reads, writes, contention bursts, duplicate requests and
expected rejections. They include network/service effects and possibly cold starts;
they are not isolated Firestore latency or a steady-state throughput benchmark.
No extra owner-routing retries were needed. No transport failures occurred.
Firestore exercised 15 extra native callback attempts that this paired Pyric run
did not. The original process/IPC Pyric suite did exercise retries under its own
schedule; zero here does not imply Pyric never retries.

Pyric and Firestore agreed on these decisions and final states. This supports
using Pyric for fast semantic iteration, while confirming that real retry and
latency behavior needs hosted measurement. No Pyric implementation change is
justified by this run alone.

## Logging and capture integrity

The dedicated bucket yielded 1,109 application entries, 106 trace-matched HTTP
entries and 446 case-scoped Firestore audit entries. All 106 dispatched commands
had an application start and settlement; no declared request/trace coverage gaps
remained. The collector used a recorded two-second margin around the client window
and bounded ingestion polling. Audit entries are not inference counts, and these
checks do not prove universal log completeness.

Post-run review found controller defects in *failure paths*: a rejected concurrent
response could previously end collection early, and a failed final read could be
excluded from the success decision. Both are fixed and covered by local regressions.
The archived run remains unchanged. It had zero transport failures, complete final
snapshots, and every completed attempt inside its recorded window, so those defects
do not invalidate this result. Source-integrity validation now also runs before
future dispatches; this run's source was independently verified afterward.

## Coverage limits and next step

This is the complete workload supported by the deployed command surface, **not all
14 original local fault-injection cases replayed on Cloud Run**. Four lack hosted
controls: lost commit acknowledgment, malformed-state injection, hidden provider
status, and the unsafe expiry-only negative control. Local process-crash cases
were adapted to abandoned reservations and explicit logical-clock takeover; no
Cloud Run process was terminated. The stale-owner and running-recovery checks were
combined. Provider terminal state was supplied explicitly by the operator.

The result supports the safety rule: **expired ownership is permission to recover,
not proof that remote inference stopped**. It also exposes the availability cost:
unknown work can occupy all capacity indefinitely. Automatic recovery, real
provider reconciliation/cancellation, clock skew, fairness, sustained contention,
allowance accounting and a production authentication boundary remain unvalidated.
The next hosted fault-injection phase requires changes to the deployed service and
therefore another explicit deployment approval.

Local verification after the controller corrections passed 92 tests across the
observability, inference-allowance and distributed-capacity suites (595 assertions),
plus scoped JavaScript typechecking and whitespace checks. The saved artifacts,
including decompressed log streams, passed a credential-pattern scan.
