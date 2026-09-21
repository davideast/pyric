# Local provider-contract findings

The complete controlled run exercised **16 cases and 35 declared checks**. All
matched their expected outcome, including one intentionally unsafe control. Its
capture verified, and executing the copied source again produced a compatible
result. No real AI calls, Firestore service calls or Cloud Run deployment occurred.

## What the run shows

| Situation | Observed result |
| --- | --- |
| Transport dropped while work continued | Safe gateway retained one reservation for one running provider job; a later observable completion released it. |
| Stop acknowledged, cancellation not yet confirmed | Capacity stayed occupied. Confirmed cancellation subsequently released it once. An outsider stop was denied by the gateway's synthetic owner check. |
| Gateway killed with SIGKILL | The independent provider process continued. A replacement gateway queried the saved operation ID without dispatching again. |
| Missing, inaccessible or unsupported lookup | Each safe case retained one unresolved reservation. Unsupported stop did not fabricate confirmation. |
| Unsafe transport-only release | A second request started: **two provider jobs ran against a one-slot limit**. |
| Conservative admission with unsupported lookup | The second request was rejected; one provider job remained running against one retained slot. |
| Completion and stop in either order | The first terminal outcome stayed stable; no reservation released twice. |
| Fixture-supported duplicate key | Two dispatch attempts were charged; the deduplicating fixture ran one provider job. This says nothing about AI Logic idempotency. |
| Abort before dispatch | Zero dispatch charges, attempts or reservations. |

Across the run there were 17 synthetic dispatch attempts and 17 dispatch charges,
3 stop acknowledgments, 3 cancellation observations, 11 completion observations
and 4 unsupported observations. Observation counts include repeated status queries;
they are **not distinct job totals**. Three safe reservations remained occupied at case
end. After local output draining, the unsafe control held zero slots while its
two provider jobs still ran. Each local fixture was then killed
as explicit test cleanup; that is not a permissible way to clear a real reservation.

The prepared AI Logic HTTP adapter also passed loopback tests for complete JSON,
complete SSE with fragmented delimiters, incomplete output, unrecognized finish
reasons, HTTP errors, pre-dispatch abort, exhausted budgets and output redaction.
These establish adapter behavior against controlled responses, not real provider
cancellation or reconciliation capabilities.

## Difference from the earlier experiments

The provider-lifecycle experiment established that output and execution can end at
different times. Distributed capacity added durable reservations and real gateway
process death, but hosted terminal state was supplied by the operator. This slice
makes the **source and strength of terminal evidence** explicit and starts mapping
it to an inspected real provider interface. The fixtures demonstrate the conditional
policy; they do not establish that AI Logic supplies the condition after interruption.

The inspected AI Logic generation surface provides output, usage when returned,
and client transport abort. It does not expose the operation cancellation/status
methods this adapter would need to resolve an interrupted call. Deduplicated dispatch
is unverified. These are interface-scoped findings, not claims about provider internals.
See `fixtures/capabilities.mjs` for the inspected SDK hash, official references and
scope, and `fixtures/contract-profile.mjs` for the conservative integration policy.

The resulting tradeoff remains: **retaining unknown work protects the capacity
limit but can prevent progress indefinitely**. Treating a local timeout as completion
restores progress by risking overlapping execution. A live investigation must
measure what actually happens without silently choosing that risk.

## Evidence and reproducibility

The normalized capture contains `result.json`, `assessment.json`, `summary.json`,
`events.ndjson`, `provider-observations.ndjson`, `capabilities.json`,
`contract-profile.json`, `environment.json`, `attempts.ndjson`, `snapshots.json`,
workload/rules, and exact source beside
a SHA-256 manifest. The local run and replay IDs are:

- Run: `1e4c8218-2eca-41c4-b743-08e916b06571`
- Replay: `2ad51c55-ed20-4432-acac-dd6669a73606`

Captures are retained outside Git under `/private/tmp/provider-contract-evidence`
and `/private/tmp/provider-contract-replays` on the execution machine. These are
local temporary paths, not a durable shared archive. No private bucket upload was
performed. Public findings contain synthetic aggregates only. Dependencies are not
bundled; capture verification includes hashes/provenance and replay needs the
compatible workspace dependencies and built Pyric package.

Gateway control ingress uses IPC; the first-chunk disconnect case uses a real
downstream HTTP stream and records client receipt and gateway awareness. Provider
traffic uses loopback HTTP, and
Pyric Admin transactions run in the controller. The oracle lives in a different
process and its control channel is never supplied to the gateway. The gateway's
owner identity is a synthetic fixture input, not verified Firebase Authentication.
No Firestore latency, contention, rules-enforcement, Cloud Run disconnect or real
billing conclusion follows from this run. `compare` is a local same-source check;
live contract comparison is deferred with deployment and inference.
