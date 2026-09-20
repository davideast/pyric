# First hosted Firestore comparison

> Public findings only. Original data, manifests and source snapshots are in the
> [private evidence archive](../../../../EVIDENCE.md).

Two hosted runs used `digame-mas/allowance-experiments`, Firestore Native,
Standard edition, `us-east4`, pessimistic concurrency, Firebase Admin 13.10.0.
The gateway and SDK ran on the development machine; this is not a Cloud Run test.
Each hosted run had a 150-request ceiling and submitted 102 requests across nine
scenarios. All inference was fake. No Auth configuration or Security Rules changed.
The records remain in their isolated run namespaces for inspection.

Each hosted run has a Pyric baseline executed from exactly the same archived
source, selected case order, policy, controlled clock, and request ceiling. Both
pairs pass integrity and compatibility checks. Compatibility does not imply equal
behavior or production timing parity.

| Burst outcome | Firestore: burst first | Pyric baseline | Firestore: refill first | Pyric baseline |
| --- | ---: | ---: | ---: | ---: |
| Alice completed / 50 | 0 | 5 | 5 | 5 |
| Alice quota exhausted | 0 | 45 | 42 | 45 |
| Alice timed out | 50 | 0 | 3 | 0 |
| Alice charged | 1 | 5 | 5 | 5 |
| Bob completed / 5 | 0 | 5 | 5 | 5 |
| Bob timed out | 5 | 0 | 0 | 0 |
| Bob charged | 0 | 5 | 5 | 5 |
| Callback retries, both users | 0 | 245 | 54 | 245 |

All four bursts stayed within each user's five-credit allowance. In the first
hosted run, both progress checks failed: all 55 requests returned at approximately
two seconds, but the last underlying transaction settled about 27.4 seconds after
the burst began. One debit committed, with its acknowledgement arriving after the
gateway deadline; no inference dispatched. A timed-out reply did not mean the
transaction was canceled or its debit rolled back.

In the second hosted run, the sequential refill scenario ran before the burst.
All 43 checks passed. Alice still had three timeouts; the final underlying burst
work settled about 2.42 seconds after the burst began. Bob completed all five
requests. The two progress checks are availability observations, separate from
the allowance and dispatch-safety checks. Passing them does not mean zero timeouts.

The first run's other eight scenarios passed, including duplicate requests,
category/user isolation, malformed-state rejection and injected lost acknowledgements.
Fault cases remain synthetic even when their transactions use hosted Firestore.

## What this supports

Transactional allowance accounting behaved safely in these workloads. Pyric is
useful for exercising that accounting and fault behavior, but these measurements
show that its retries and request completion behavior cannot stand in for the
hosted service. A gateway response deadline alone does not bound retained SDK
work. Startup/order is a plausible contributor to the first failure; one trial of
each order cannot isolate cold connection setup from transient network/service
conditions. Do not infer unlimited-flood isolation or production capacity here.

The next experiment should repeat both orders, record client/channel startup,
and compare bounded per-user admission concurrency with the same workload. Keep
timeouts and residual work in the reports. Do not lengthen deadlines merely to
turn the checks green, or refund timed-out requests without reconciling receipts.
Run the same experiment from Cloud Run before assessing cross-user service impact.

## Evidence

- [Burst-first hosted capture](../../results/f9053384-2444-4253-ae9f-0604f0a3ebb0/findings.md)
  and [matching Pyric baseline](../../results/54acf293-edf8-4bcd-9a5b-b0e806f3c8dd/findings.md).
- [Refill-first hosted capture](../../results/6a2532d5-17c1-44f1-be6d-54766a46ecf3/findings.md)
  and [matching Pyric baseline](../../results/e5df5b1a-b952-4557-8efe-41ac62057ee5/findings.md).
- [Burst-first comparison — private archive](../../../../EVIDENCE.md) and [refill-first comparison — private archive](../../../../EVIDENCE.md)
  retain normalized outcomes and environment metadata. Source is included in each
  capture; no Git history lookup is required.

The safety envelope is unchanged: Admin SDK bypasses Rules; the host admission
code enforces allowances. These runs do not verify client Rules, real Firebase
Auth, deployed AI Logic route coverage, actual model calls, billing, or throughput.
