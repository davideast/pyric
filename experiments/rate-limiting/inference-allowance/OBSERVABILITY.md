# Set up experiment observability

Use this Node.js command to inspect a Firebase/GCP project, prepare a reviewable
logging plan, apply it, and verify evidence delivery. It does not deploy the
experiment, create a database, change Security Rules, or invoke an AI model.
No Python installation or gcloud subprocess is required by the setup tool.

Install this repository's dependencies first. Use Node 22.18+ (the same runtime
as the hosted harness). Firebase Admin, already a dependency, supplies tokens.

## Check and plan

From the repository root:

```sh
node experiments/rate-limiting/inference-allowance/setup-observability.mjs check \
  --project YOUR_PROJECT --database YOUR_DATABASE \
  --service YOUR_CLOUD_RUN_SERVICE --region YOUR_REGION \
  --collector serviceAccount:COLLECTOR_EMAIL \
  --credentials /absolute/path/to/inspector-key.json \
  --collector-credentials /absolute/path/to/collector-key.json \
  --out /tmp/observability-check
```

Omit credential flags to use Application Default Credentials (ADC). For a local
user, `gcloud auth application-default login` is one way to configure ADC; in a
Google environment, use the attached identity. `--collector` is the principal to
which the reviewed plan would grant log access. The permission probe and preflight
use the collector credential, or the caller credential when omitted. Service
account files are checked against the declared collector. ADC uses Google's token
introspection endpoint to verify the principal. A mismatch is rejected; an
unresolved principal is reported as unknown and blocks apply/preflight. Use an
explicit service-account file if ADC cannot be identified. Tokens and key files
are never copied into reports.

Use the same target/credential arguments with `plan` instead of `check`:

```sh
node experiments/rate-limiting/inference-allowance/setup-observability.mjs plan \
  --project YOUR_PROJECT --database YOUR_DATABASE \
  --service YOUR_CLOUD_RUN_SERVICE --region YOUR_REGION \
  --collector serviceAccount:COLLECTOR_EMAIL \
  --credentials /absolute/path/to/inspector-key.json \
  --collector-credentials /absolute/path/to/collector-key.json \
  --out /tmp/observability-plan
```

Read `observability-plan.json` and `plan-observability-report.json`. Both modes
make only read-only Google API calls (some inspection APIs use HTTP POST).
`forbidden` means **cannot inspect**, not disabled. Missing permissions and
unresolved inherited exemptions block apply; the tool never removes exemptions.

The plan is derived from `observability.json`, a versioned experiment requirements
manifest. Shared setup code lives in `experiments/shared/observability/`:

| File | Responsibility |
| --- | --- |
| `cli.mjs` | Node command, inputs, credential selection, local reports |
| `google-api.mjs` | ADC/service-account tokens, bounded Google REST calls |
| `requirements.mjs` | Validated target, resource names, sink scope, version/hash |
| `inspection.mjs` | Configuration and permission evidence, inherited policies |
| `planning.mjs` | Additive plan, freshness checks, apply and partial progress |
| `preflight.mjs` | Invoke canary and independently observe log witnesses |
| `run-report.mjs` | Attach coverage to a run; optional preflight requirement |

## What the plan changes

- Adds missing `ADMIN_READ`, `DATA_READ`, and `DATA_WRITE` categories for
  `datastore.googleapis.com`. This affects Firestore across the project, not just
  the selected database, and can increase logging charges.
- Preserves existing IAM bindings, conditions, audit settings and exemptions.
  Uses the policy `etag`; a conflicting IAM write fails rather than overwrites.
- Explicitly grants the selected collector `roles/logging.privateLogViewer` and
  `roles/logging.viewAccessor` at project scope. These grants appear in the plan.
  The latter supports reading the dedicated bucket's `_AllLogs` view.
- Creates a `pyric-experiments` log bucket and `pyric-<service>` sink. The sink
  collects this Cloud Run service's logs and Firestore audit events across the
  project. Existing sinks, exclusions and destinations are not rewritten.
- Requires at least the manifest's 90 days of retention. `--retention DAYS` may
  increase this minimum. Existing buckets are never updated: short retention or
  an inactive bucket requires manual resolution and a new plan. The bucket API
  has no conditional update to prevent overwriting a concurrent retention change.
  A longer existing retention period is preserved. `--location LOCATION` selects
  the new bucket's location; it defaults to `global` and cannot be moved later.
- Reports conflicting existing sinks and locked buckets for manual resolution.
  Unreadable ancestor policies produce warnings; they do not block additive
  project setup. Known relevant exemptions still block, even when another
  ancestor is unreadable. Ancestor intercepting sinks and IAM deny policies are
  not exhaustively analysed; end-to-end preflight is required.

The caller needs read access to the project IAM policy, service, database, sink
and bucket. Ancestor IAM access is optional; no organization-wide role is needed
to perform project setup. The plan lists missing mutation permissions. Typical
operations require `resourcemanager.projects.setIamPolicy`,
`logging.buckets.create` and `logging.sinks.create`. Use a project
administrator to apply; runtime identities do not need configuration privileges.

## Apply the reviewed plan

```sh
node experiments/rate-limiting/inference-allowance/setup-observability.mjs apply \
  --plan /tmp/observability-plan/observability-plan.json \
  --credentials /absolute/path/to/inspector-key.json \
  --collector-credentials /absolute/path/to/collector-key.json \
  --out /tmp/observability-applied
```

Apply re-reads configuration and regenerates the actions. A changed target,
policy, relevant configuration, requirements version, or edited action list
requires a new plan before any mutations. Reapplying a fulfilled plan is a no-op.
Firestore's automatically advancing `earliestVersionTime` and its database etag
are excluded from this comparison; database identity and configuration are still
checked, and the full observed metadata stays in the report. The project IAM
etag is always retained and enforced on policy writes.
Changes across Google services are not atomic: `apply-progress.json` and
`apply-result.json` retain completed actions if a later step fails. Re-plan after
a partial failure. Do not reuse old IAM policy files to undo changes.

`projectConfigurationReady` means the observed configuration is sufficient to
attempt preflight. `configurationReady` additionally requires readable ancestor
audit policies. When ancestor access is denied, `apply` can finish successfully
while `check` still exits 1 and reports this specific uncertainty. Neither field
claims log delivery: `evidenceComplete` stays false until preflight observes all
required witnesses. A passing preflight retains unreadable ancestors as unknown;
it does not certify every inherited policy or every future request.

## Preflight: verify logs actually arrive

Deploy a version of the experiment that includes
`services/observability-preflight.mjs` before using this step. Setup never deploys
it for you. Existing deployments without the endpoint return an incomplete report.
The endpoint remains behind the experiment service's Cloud Run IAM protection;
do not make the experiment service public.

For a private service, obtain an ID token for that service's URI using your
normal Cloud Run invoker credentials, and save it to a private file. For example,
when service-account impersonation is authorised:

```sh
gcloud auth print-identity-token \
  --impersonate-service-account=INVOKER_EMAIL \
  --audiences=YOUR_CLOUD_RUN_URI > /tmp/experiment-id-token
chmod 600 /tmp/experiment-id-token
```

Then run `preflight` with the same target/credential arguments as `check`, plus:

```text
--identity-token-file /tmp/experiment-id-token
--timeout-ms 120000
--out /tmp/observability-preflight
```

The endpoint transactionally creates one unique
`observabilityPreflight/<UUID>` document in the selected database, reads it,
then deletes it. It emits a completion event. No allowance records or provider
calls are touched. Existing documents are never overwritten or deleted on a
canary ID collision. If the process crashes, the report records the exact path
of a potentially orphaned canary; automatic TTL configuration is not assumed.

The collector queries the **dedicated bucket**, waiting for four independent
witnesses: application completion, HTTP 200, Firestore read and Firestore write.
Database evidence must contain the exact canary document name and no error status.
A successful HTTP response alone cannot pass. The report preserves bounded raw
witness entries, timestamps, identities, requirements hash and setup version.
Missing evidence, denied access, absent endpoint or timeout remains incomplete.
This is a delivery check, not a claim that every workload event will be captured.

## Attach evidence to experiment runs

All new standard captures and hosted measurement runs save an
`observability-report.json`. Local Pyric runs say `not-applicable`; a hosted run
without supplied evidence says `not-checked`. Historical captures are unchanged.

To require a recent preflight before a hosted run:

```sh
export PYRIC_OBSERVABILITY_REPORT=/tmp/observability-preflight/observability-report.json
export PYRIC_REQUIRE_OBSERVABILITY_PREFLIGHT=1
# Now run the existing experiment command.
```

The report must match the project, database, service and region (when applicable), manifest
and setup version, and be at most one hour old. The snapshot is retained with the
run. It describes pre-run coverage, not the completeness of a later log export.
Existing workloads continue to run without this opt-in gate, with their coverage
honestly labelled. Setup does not backfill missing historical logs, add trace
spans, or implement metrics export. Workload log export is described below.

## Optional services

`--optional auth,rtdb` adds Identity Platform user activity logging and RTDB audit
categories. Auth uses a field-mask PATCH that preserves other configuration.
RTDB audit events and Auth activity events are included in the dedicated sink.
These configuration checks do not simulate sign-in or RTDB operations; the four
preflight witnesses cover only Cloud Run and Firestore.

`--optional ai` reports a manual requirement with a Firebase console link. No
undocumented AI monitoring API is assumed. That report remains incomplete and
cannot be applied automatically; configure AI monitoring separately and run the
base setup for Cloud Run/Firestore. AI sampling, SDK support, prompt retention and
provider-specific telemetry still need verification before a real-inference run.
No upgrade to Identity Platform or paid AI service is performed automatically.

## Exit codes and verification

- `0`: configuration ready, an applicable plan written, or apply/preflight passed.
- `1`: blockers, partial apply or incomplete evidence; inspect saved reports.
- `2`: invalid input, stale/tampered plan or an unrecoverable command failure.

```sh
bun test experiments/shared/observability/tests \
  experiments/rate-limiting/inference-allowance/tests/observability-preflight.test.ts
node experiments/rate-limiting/inference-allowance/setup-observability.mjs --help
```

Tests use a stateful Google REST boundary fixture and a real local HTTP endpoint
backed by Pyric's public Admin sandbox API. They do not call Google or change a
cloud project. Hosted preflight remains a separately authorised operator action.

References: [audit configuration](https://docs.cloud.google.com/logging/docs/audit/configure-data-access),
[Firestore audit logging](https://docs.cloud.google.com/firestore/native/docs/audit-logging),
[log buckets](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/projects.locations.buckets/create),
[Identity Platform activity](https://docs.cloud.google.com/identity-platform/docs/activity-logging),
[AI Logic monitoring](https://firebase.google.com/docs/ai-logic/monitoring).

## Capture workload logs locally

`deployment/run-execution.mjs run …` and `deployment/run-cloudrun.mjs run …`
now export logs after the client process finishes, including failed runs. This is
separate from the preflight and from the workload assessment. Local Pyric runs do
not query Cloud Logging. No logging setup or deployment changes occur during export.

Each hosted measurement retains:

```text
measurements/<measurement-id>/
├── result.json                 # measured behaviour, never changed by capture
├── deployment-report.json      # backend run ID, revision and source hash
├── log-window.json             # fixed UTC bounds, including workload drain
├── source/                     # client and collector source snapshot
├── server-source/              # verified deployed source snapshot
├── logs/
│   ├── capture-report.json     # queries, counts, pagination, gaps and hashes
│   ├── collector-source/       # exact collector source snapshot
│   ├── manifest.json           # independent export hashes
│   ├── application.ndjson.gz
│   ├── http-request.ndjson.gz
│   └── firestore-audit.ndjson.gz
└── manifest.json               # hashes of the measurement artifacts
```

Each compressed NDJSON row has `{ correlation, entry }`. `entry` retains provider
metadata in its original structure, filtered by a versioned field allowlist;
these are **redacted entries**, not byte-for-byte raw logs. We exclude document
contents, arbitrary application payloads, query strings, caller IPs and credentials.
Keep production exports private even with these exclusions: synthetic user IDs,
experiment document paths and operational metadata remain.

The collector queries the configured `pyric-experiments` `_AllLogs` view. It paginates every
pass, deduplicates entries, unions successive passes and waits up to 90 seconds
for ingestion. Once expected observations arrive, it requires 15 seconds without
new entries. Limits are 100 pages per stream per pass and 50,000 retained entries
per stream; reaching either limit records a partial capture. API failures preserve
other streams and record their HTTP status without serialising credential-bearing
SDK errors. An interrupted initialisation is labelled failed/unknown.

`collectionStatus: collected` means all issued queries were paginated successfully.
`coverage.status: observed` means the requested application starts/settlements and
trace-correlated HTTP requests were observed, with Firestore audit evidence present.
Neither proves universal log completeness. Inspect `coverage.gaps`, stream errors,
truncation and the report's limitations before comparing experiments.

Application events use backend run, case and request IDs. New hosted clients send
unique Cloud Trace IDs for HTTP correlation. Older HTTP logs matched only by time,
revision and endpoint are **candidates**, not definite request matches. Firestore
logs use exact experiment document paths and are labelled **case scope**, not exact
request matches. Database-only audit entries without document paths are excluded;
so are mixed operations touching unrelated documents. Audit counts are not SDK
operation counts, inference counts, or billing measurements.

For a separately authorised, one-request fake-inference smoke against the existing
private execution service (writes isolated experiment allowance/receipt records):

```sh
node experiments/rate-limiting/inference-allowance/deployment/run-log-smoke.mjs \
  DEPLOYMENT_RECORD COLLECTOR_KEY
```

This does not deploy, call a paid AI model, or run the overload workload. The
collector identity needs invocation permission for the smoke and Logging access
for the export. The runtime identity still performs Firestore writes.

To retry ingestion or re-export an older window, use a **new directory outside the
sealed measurement**. Existing exports are never overwritten, including on failure.

```sh
node experiments/rate-limiting/inference-allowance/deployment/capture-logs.mjs \
  MEASUREMENT_DIRECTORY COLLECTOR_KEY NEW_EXPORT_DIRECTORY
```

The original measurement must contain `result.json`, `deployment-report.json`
and `log-window.json`. Every export includes its own hashed collector source,
report and compressed entries, with a separate `manifest.json`. No Git lookup is
needed to inspect its implementation. The export uses the bucket location in the
matching observability snapshot, when supplied; otherwise it explicitly records
that it assumed the setup default (`global`). Source dependencies remain external.
The standalone command exits nonzero for partial collection or coverage gaps;
automatic collection reports those separately without rewriting workload outcomes.
