# Capacity recovery deployment

Deployed with explicit approval on 2026-09-20 UTC:

- Service: `capacity-recovery`, project `digame-mas`, region `us-east4`.
- Revision: `capacity-recovery-00001-k5l`, serving 100% of service traffic.
- Private URL: https://capacity-recovery-77eiz5rbyq-uk.a.run.app
- Firestore: `allowance-experiments`, Native / Standard, pessimistic concurrency.
- Inference: durable simulated provider state; no real model calls.
- Configured instances: minimum zero, maximum three; HTTP concurrency eight.

[Deployment report — private archive](../../../EVIDENCE.md),
[actual service configuration — private archive](../../../EVIDENCE.md)
and [exact packaged source — private archive](../../../EVIDENCE.md)
are retained together. The report includes the resolved image digest. No credentials
or dependency binaries are in the capture. The previous `allowance-overload`
service was not redeployed or reconfigured.

## Verification

Unauthenticated health returned 403; authenticated health returned 200 with the
expected source hash, run ID and revision. One synthetic `alice` smoke command
returned 200 / completed after reserving capacity, recording dispatch, creating
and completing the fake provider operation, and settling capacity through real
Firestore transactions. No distributed workload or real inference was run.

Before deployment, 87 relevant local regressions passed, the packaged Node service
started with the correct provenance, and scoped JavaScript typechecking passed.
After the collector correction below, all 32 observability tests passed again.
There was one Cloud Run deployment in this task; further deployments need approval.

## Log evidence and the initial gap

The [initial export — private archive](../../../EVIDENCE.md)
queried only the dedicated `pyric-experiments` bucket using the exact client smoke
window. It retained 15 Firestore audit entries, but no application or HTTP entries.
That incomplete result remains unchanged.

Read-only diagnosis found the application logs in the project's default log
storage. It also found the final server log at `18:23:40.995194Z`, about one
millisecond after the client's `18:23:40.994Z` end timestamp. Those are two distinct
evidence boundaries: routing to the new bucket, and clock/window precision.

The [recovery export — private archive](../../../EVIDENCE.md)
explicitly queried both known buckets and used a recorded two-second allowance on
each side of the original window. It retained 36 application entries, one HTTP
entry matching the client's exact trace, and 15 Firestore audit entries. There
was one matching request start and one settlement, with no declared coverage gaps.
No additional inference request was sent to recover these logs.

A separate [logging canary — private archive](../../../EVIDENCE.md)
then created, read and deleted its own isolated test document. Its start and
completion appeared in the dedicated bucket, establishing that this routing worked
at that later time. The first-smoke routing gap is consistent with delayed sink
activation, but these observations do not prove its exact cause or retroactively
make the initial export complete. No sink error entries were found during diagnosis.

Both exports include collector source and artifact hashes. Redaction retains
operational identifiers and synthetic paths while omitting credentials, document
bodies and caller IPs. Audit entries are case-scoped evidence, not an inference
attempt counter. Bounded ingestion does not prove universal log completeness.

A subsequent approved [hosted workload](../hosted/RESULTS.md) completed nine
supported/adapted scenarios and compared them with a paired Pyric run. This deployment smoke does not establish that
multiple Cloud Run instances ran, that gateway crashes were recovered in Cloud Run,
or that the architecture is production-ready.
