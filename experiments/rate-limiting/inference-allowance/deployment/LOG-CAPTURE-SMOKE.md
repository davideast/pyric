# Workload log capture smoke

On 20 September 2026 (UTC), one synthetic inference request completed against
`digame-mas` / `allowance-experiments`, using the existing private Cloud Run
revision `allowance-overload-00004-rsc`. No service deployment, logging/IAM change,
real AI inference, or overload workload was performed.

The workload run is
[0ba0c073-ac84-4fb4-bfa7-d08b3ce14372 — private archive](../../../EVIDENCE.md).
Its exact window was `2026-09-20T02:56:27.514Z` through
`2026-09-20T02:56:31.275Z`. The synthetic user was `eve`; the request received
HTTP 200 / `completed`. The service drained before the window closed.

## Corrected capture

Use the [deduplicated export report — private archive](../../../EVIDENCE.md)
for log counts. It queried the same fixed window without issuing another
inference request. Four paginated polling passes took 18.786 seconds and ended
after the expected evidence arrived and the ingestion view stayed quiet.

| Stream | Unique entries | Correlation |
| --- | ---: | --- |
| Application | 27 | 21 matched the request; 6 matched the experiment case |
| Cloud Run HTTP | 1 | Exact client trace ID |
| Firestore Data Access | 5 | Exact experiment document scope; 3 BatchGetDocuments and 2 Commit entries |

One application request start, one matching settlement and the expected HTTP
trace were observed. There were no missing requested IDs or trace IDs. Collection
was complete within the stated queries and limits. This does not establish that
all possible logs were delivered: later arrivals and pathless database audit
entries remain outside that claim. Audit entries are not a billing or SDK-call
counter, and are not attributed to individual inference attempts.

The [export manifest — private archive](../../../EVIDENCE.md) verifies
16 artifacts, including compressed redacted entries and the collector source.
The original workload manifest verifies 126 artifacts, including the deployed
server source and client source. Both manifests were checked after capture.
The entry scan found no prompts, document field bodies, caller IPs, private keys
or bearer-token-shaped values. Operational IDs and experiment paths remain.

## Collector defect caught by the smoke

The first collector hashed JSON with its original property order. Google returned
the same log entry with different object-key order on later polls. This inflated
the initial report to 348 application, 12 HTTP and 29 audit rows. Those counts
are invalid and must not be used for experiment analysis.

The [initial capture — private archive](../../../EVIDENCE.md)
is preserved unchanged with its original source. The corrected collector uses
canonicalised provider identity (log name, insert ID, timestamp and resource),
with a canonical content fallback when no insert ID exists. HTTP coverage checks
each expected trace ID rather than counting matching rows, so duplicates cannot
hide a missing request. Both defects have regression tests.

The repair is in the evidence collector, not Pyric or the measured allowance
algorithm. This smoke verifies the export path; it adds no production capacity,
rate-limit correctness or scalability claim.
