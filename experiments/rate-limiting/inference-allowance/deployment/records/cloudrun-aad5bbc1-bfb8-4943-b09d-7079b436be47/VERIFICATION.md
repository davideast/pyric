# Observability deployment and verification

> Public findings only. Original data, manifests and source snapshots are in the
> [private evidence archive](../../../../../EVIDENCE.md).

Deployed revision: `allowance-overload-00004-rsc`

Service: https://allowance-overload-77eiz5rbyq-uk.a.run.app

Source hash: `bd40056a64195b6b05410456b348961ec0df907a37650d349c9ff22e94ca0997`

The service retains IAM authentication, the execution workload, one maximum instance, 1 CPU, 512 MiB, concurrency 80 and a 10-second request timeout. The synthetic deployment smoke returned HTTP 200; unauthenticated access returned 403. No real model inference was used.

Preflight `07cd1d9d-7fec-4481-acc0-53b16524421e` passed at 2026-09-20T02:09:33.306Z. Application completion, HTTP 200, Firestore read and Firestore write witnesses arrived in the dedicated 90-day log bucket. The canary document was deleted. Raw witness entries are retained in observability-report.json.

Inherited audit policies remain unverified because the operator cannot inspect ancestor IAM policies. The passing preflight demonstrates delivery for this canary, runtime identity and deployed revision; it does not certify every future request or optional Auth, RTDB or AI Logic telemetry. No workload experiment was run beyond the synthetic deployment smoke and this canary.
