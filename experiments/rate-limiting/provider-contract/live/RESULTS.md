# Real-service provider-contract results

The bounded run used **Firebase AI Logic with `gemini-3.5-flash-lite` and real
Firestore**, from a local controller. All four selected cases matched their
expected observations. There were three model dispatches, no inference retries,
and no Cloud Run deployment.

| Case | Observation | Firestore accounting |
| --- | --- | --- |
| Normal response | HTTP 200, terminal generation marker, complete response | One dispatch, one release |
| Normal stream | HTTP 200, terminal marker, consumed stream | One dispatch, one release |
| Abort before dispatch | No provider request | No dispatch or reservation |
| Abort after first nonterminal chunk | HTTP 200, partial output, local abort; no authoritative terminal observation | One dispatch; reservation stays occupied |

Final accounting was **3 dispatch charges, 2 releases, 1 retained reservation**.
A fresh Admin SDK process independently read the same Firestore state: two completed
request records, one unknown request, and no pre-dispatch-abort request record.
The synthetic Firebase Auth user was deleted successfully. No IAM bindings, Firebase
Auth settings, Firestore rules or deployed services were changed.

The complete calls each reported 18 prompt tokens and 60 generated tokens (78 total).
The interrupted call's last observed metadata reported 18 prompt tokens and 15
output tokens. That is partial response metadata, **not its final token usage or
billing**. Neither a local abort nor deleting the synthetic test identity establishes
that provider execution stopped.

Measured controller case durations were about 1.86 seconds for the response,
1.66 seconds for the stream, 0.17 seconds for the pre-dispatch abort, and 0.98 seconds
for abort after a chunk. These include local/Firestore work and are one observation
per case, not provider latency estimates or performance benchmarks.

## What changed from the Pyric experiment

The controlled fixture could expose provider state after transport disappeared.
That let it demonstrate that an unsafe release admits overlapping execution and
that a later authoritative terminal observation can release capacity safely.

In the real run, no independent provider execution oracle or supported generation
status lookup was available. Normal terminal responses released their reservations;
the interrupted call stayed unknown. **The safe accounting behavior carried over,
but the fixture's eventual reconciliation capability did not.** We cannot claim that
the real aborted operation continued running or stopped: neither was observed.

The practical finding is that this generation interface supports conservative
admission but does not establish automatic capacity recovery after interruption.
Unknown reservations can consume capacity indefinitely. Redispatching that logical
request, resetting its reservation, or expiring it solely by elapsed time would
introduce risk this experiment has not justified.

The current runner is sequential. It does not test concurrent Cloud Run replicas,
a browser's downstream connection, real-provider cancellation endpoints, idempotent
redispatch, or hosted recovery. Those remain distinct, unexecuted cases. A hosted
follow-up requires explicit Cloud Run deployment approval.

## Evidence and the failed prerequisite attempt

Successful run: `c3e62ca0-1e25-4e42-be91-153a420deca8`.
Its source-inclusive capture verifies and refuses replay. The capture retains the
exact code actually executed, even if later tooling changes.

An earlier capture, `e9235bb5-f004-465d-b95c-cfbb34178f2f`, failed during Firestore
budget initialization because the deployment account had read permission but no
entity create/update permission. It made **zero AI calls**. The successful run used
the existing Firebase Admin service account with those permissions. Preflight now
checks the required IAM permissions before starting. Both captures are retained;
the failed attempt is not represented as a completed behavioral experiment.

The separate audit supplement contains **26 matching Firestore Data Access log
entries**, with no pagination truncation or collection errors. Correlation is by
the exact run document namespace, not individual inference attempts. Exported
entries exclude document fields, credentials, caller identity and IPs. The collector
polled for 30 seconds; this does not prove every log entry arrived. Cloud Run request
logs are inapplicable because no Cloud Run service handled this run.

See `evidence.json` for the private archive locator and digest. Raw captures include
project/app identifiers and stay outside Git; only code and this sanitized summary
belong in the branch. Credentials, prompts and generated output are excluded even
from the private archive. No real-service replay is enabled.
