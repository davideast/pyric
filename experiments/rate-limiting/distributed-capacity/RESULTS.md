# First local distributed-capacity run

Captured on 2026-09-20 UTC with Pyric `0.1.0-alpha.23` and separate Node gateway
processes. No hosted service was contacted or deployed.

- [Original capture — private archive](../../EVIDENCE.md)
- [Replay of its archived source — private archive](../../EVIDENCE.md)
- [Original event log — private archive](../../EVIDENCE.md)
- [Original source and evidence manifest — private archive](../../EVIDENCE.md)

Both captures completed 14 cases and 56 assertions: 54 passed, and two capacity
assertions failed exactly as required by the deliberately unsafe control. Both
archives passed integrity verification and their comparison found no semantic
compatibility mismatches. They used the same source snapshot and built Pyric
package fingerprint. Each recorded 906 events and 134 native transaction attempts
across 89 invocations. These counts describe these runs, not a latency guarantee.

Harness verification also passed: 92 tests across the observability, allowance,
HTTP/lifecycle, multiplayer and new recovery suites, with no failures. The new
JavaScript entry points and imported shared helpers passed scoped TypeScript
`checkJs`. Review-driven regressions cover cleanup after evidence recording fails,
adapter-only changes invalidating comparisons and duplicate dispatch visibility.

| Question | Observation |
| --- | --- |
| Can gateways share one capacity limit? | Three gateways racing 16 requests admitted three; the observed peak was three globally and two for one user. |
| Can two gateways duplicate one request? | They produced one provider start attempt and one capacity debit. |
| Can a new owner recover undispatched work? | It advanced the fence to two, dispatched once and released the slot after confirmed completion. |
| Does gateway death stop remote work? | No. The fixture kept running; its slot remained occupied and blocked another request. |
| Can completion be recovered after losing the owner? | Confirmed completion settled once, even with concurrent settlement and a duplicate request. |
| Does a lost commit acknowledgement erase the reservation? | No. The retry found the durable reservation without a second debit or provider dispatch. |
| Can stale owners mutate the ledger? | Dispatch, renewal and settlement were rejected after takeover. |
| Can two recovery owners win? | One succeeded, one saw a live lease, and the fence advanced once. |
| What if the provider outcome is unknown? | Capacity remained occupied. A later confirmed terminal observation released it. |
| Is expiry alone a safe release condition? | No. The negative control ran two remote jobs for the same user against both global and per-user limits of one. |

The expiry result follows from the event ordering: the first provider job remained
running, its reservation expired and was released, then a second job started. A
faster or more realistic database would not make lease expiry terminate that
first job. A hosted comparison is still needed to check Firestore transaction,
contention and timing behavior; the local result does not establish those.

The safe design trades availability for a defensible bound: unknown work holds a
slot. The intent-with-no-observable-job case intentionally ends with one occupied
slot and zero oracle jobs. Without an authoritative provider outcome, automatically
freeing it could also free a slot for work that really is still running. This run
does not solve indefinite quarantine, implement a background recovery service or
establish that AI Logic provides the required reconciliation signals.

All fixtures and executed source are preserved beside the evidence. The database
and provider controller survived gateway crashes; controller restart, durable
database recovery, production security, allowance charging and throughput remain
outside this result. See [the harness guide](README.md) for commands and scope.

The next step is a separately approved hosted comparison using bounded fake
inference and correlated log capture. **Every Cloud Run deployment requires
explicit approval.**
