# Private Cloud Run deployment

This packages the shared capacity architecture for `capacity-recovery` in
`digame-mas`, `us-east4`, using the existing named Firestore database
`allowance-experiments`. It leaves `allowance-overload` unchanged. **Every Cloud Run
deployment requires explicit user approval.** Preparation and tests are local;
running `deploy.mjs` is the deployment action.

```sh
node experiments/rate-limiting/distributed-capacity/deployment/prepare.mjs
bun test experiments/rate-limiting/distributed-capacity/tests/hosted.test.ts
node experiments/rate-limiting/distributed-capacity/deployment/deploy.mjs \
  "$HOME/Documents/digame-mas-65fca8fd3136.json" \
  "$HOME/Documents/digame-mas.json"
```

The deployment copies an explicit source allowlist and the existing pinned Express
5.2.1 / Firebase Admin 13.10.0 lockfile. Package name and start command are adapted;
dependency versions and integrity hashes are preserved. Credentials and application
data never enter the build context. Runtime uses its attached service account's
Application Default Credentials. Database metadata must match Native/Standard,
`us-east4`, pessimistic concurrency before deployment can proceed.

Cloud Run IAM remains required. The script refuses public IAM bindings, unrelated
services with the same name, or a conflicting experiment log sink. It adds
`pyric-capacity-recovery` to route this service and Firestore logs to the existing
`pyric-experiments` bucket; previous sinks and IAM policies are preserved. It does
not deploy Security Rules: the gateway uses the Admin SDK/IAM, with isolated
synthetic data under `capacityExperiments/{deploymentRunId}/cases/{caseId}`.

Configured resources: zero minimum / three maximum instances, concurrency eight,
one CPU, 512 MiB and a 30-second request timeout. CPU is request-based because no
background loop is needed. Configured maximum instances is not proof of the exact
number of live gateway instances or a strict global execution bound; the capacity
ledger provides that experiment's bound. See Google's [maximum instance guidance](https://docs.cloud.google.com/run/docs/configuring/max-instances).

## Command API

`GET /health` reports source hash, revision, actual process instance ID, backend,
limits and supported commands. `POST /cases/{caseId}/commands` accepts a JSON body
with `operation`, synthetic `uid` (`alice`, `bob`, `carol`, `dave`) and `requestId`.
Only `deployment-smoke`, `capacity-shared`, and `recovery` namespaces are accepted.

Operations are `reserve`, `start`, `resume`, `intent`, `takeover`, `renew`,
`reconcile`, `provider-finish`, `inspect`, and `smoke`. Resume/intent/renew/reconcile
require the previously returned positive `fence`. `provider-finish` takes an
`outcome` of `completed` or `cancelled`. `inspect` returns only the selected case.
`smoke` is restricted to `deployment-smoke` and runs one reservation through
dispatch, fixture completion and settlement. It never invokes a real model.

Gateway identity comes from the serving process, never a requested owner. Requests
may reach different Cloud Run instances; a command that needs the old owner can
fail with `stale-owner`. The workload controller must observe instance IDs,
preserve those outcomes, and not assume session affinity. There is no crash API,
automatic recovery loop, lease-expiry capacity release or remote process killer.

The operator can supply `logicalTimeMs` between 1,000 and 1,000,000,000 for controlled
ordering tests. Otherwise a wall-clock sample is used. Time is frozen per command,
including retries. Do not mix clock domains for one reservation; this facility is
not a production clock/skew solution. Limits are three globally, two per user and
a 30-second ownership lease. The 250-command ceiling is per process lifetime, not
a durable global budget across restarts. No real inference means no model charges.

## Provider fixture and evidence

The hosted fake provider stores logical running/completed/cancelled jobs in its own
Firestore documents, separate from capacity reservations. This lets state survive
gateway replacement. It is a **durable state-machine fixture**, not an independently
running AI request or an independent external oracle. Duplicate starts fail loudly.
Only an explicit trusted operator command supplies terminal provider evidence.
These semantics must be called out when comparing to the local in-memory oracle.

Structured stdout includes run/case/request/attempt IDs, process/instance identity,
sequence, revision and source hash. Tokens and prompts are never logged. Smoke
uses an explicit trace ID to correlate Cloud Run's HTTP log. The shared collector
now supports the `capacityExperiments` document namespace without selecting records
from the previous allowance experiment. Audit entries remain case-scoped and are
not an SDK call count or an attribution to individual inference attempts.

After deployment, export the completed smoke's logs without issuing another
request or deploying again:

```sh
node experiments/rate-limiting/distributed-capacity/deployment/capture-smoke.mjs \
  DEPLOYMENT_RECORD_DIRECTORY "$HOME/Documents/digame-mas-65fca8fd3136.json"
```

This retains compressed redacted application/HTTP/audit entries, collection limits,
coverage gaps, exact collector source and hashes under a new `logs-*` directory.
It waits up to 90 seconds for ingestion and never interprets absent logs as proof
that an operation did not happen. Deployment success alone is not logging proof.

For an explicitly diagnosed routing/window gap, `--include-default-logs` also
queries this project's `_Default` bucket and pads the client window by two seconds
on each side. The exact views and expanded window are recorded, while the original
deployment report and previous exports remain unchanged. Request/run/revision
filters still apply. This is evidence recovery, not proof the dedicated sink
captured the original traffic.

`records/{deploymentRunId}` retains exact deployed source, per-file hashes, image
digest, health and functional-smoke result. The deploy script performs an
unauthenticated rejection check, authenticated health/provenance check and one
Firestore-backed fake completion. It does not run the distributed experiment.
The deployment smoke alone does not establish that the 14 local cases ran on Cloud
Run, multiple instances were observed, or production recovery/throughput is ready.
The separate [hosted workload](../hosted/README.md) and [results](../hosted/RESULTS.md)
record the subsequent nine supported/adapted scenarios and remaining gaps.

Google's [source deployment documentation](https://docs.cloud.google.com/run/docs/deploying-source-code)
describes the build and service identities. Use the same deployer/build and runtime
accounts as the previous experiment. No credential JSON is copied to artifacts.

The first deployed revision and its evidence are documented in
[DEPLOYED.md](DEPLOYED.md).
