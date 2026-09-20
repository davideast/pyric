# Hosted inference execution comparison

Baseline for implementation review: `7c308a7f`. User authorized deploying and
running the fixed inference workload against Cloud Run and Firestore.

Reuse the nine local execution scenarios, gateway, provider lifecycle simulator,
allowance policy, and lifecycle assertions. Keep controlled allowance time so
refill is not a workload difference. Use the existing private `allowance-overload`
service and dedicated `digame-mas/allowance-experiments` database, with a fresh
backend run ID and separate records per case. Do not grant IAM, make the service
public, or use real inference. Preserve its one-instance configuration and
existing resource limits. Record actual instances and reject multi-instance
measurements as evidence for a single-process bound.

Execute the same hosted router and network load client locally against Pyric as
a paired baseline. Normalize server/client events without subtracting clocks
across processes. Retain executed client source, deployed source and digest,
workload/architecture hashes, environment, raw logs, and assertions. Retain
Firestore state before and after; local adapter state export is not provided.
Refuse to re-run in a used namespace rather than deleting/resetting records.
Deployment smoke uses Dave in the user-guard case; measurement never uses Dave.

Collect all 65 request starts, responses and settlements. Assess streamed receipt
using acknowledgement events and retain disconnect differences as failed local
expectations. Cloud Run's HTTP/1.1 proxy does not promise to deliver client
socket disconnects to the container. A complete measurement may contain failed
hypotheses; incomplete captures must never be reported as successful evidence.

Use existing approved public HTTP, Pyric sandbox, package preparation and capture
seams for tests. Run the complete experiment tests, typecheck, standards/spec
review, then deploy, smoke, measure, verify manifests and write interpretation.
Keep all work and evidence committed locally; no push.
