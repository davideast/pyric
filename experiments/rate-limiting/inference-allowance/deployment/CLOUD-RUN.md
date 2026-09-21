# Cloud Run experiment deployment

Prepared service: `allowance-overload`, project `digame-mas`, region `us-east4`.
It uses the real named Firestore database `allowance-experiments` and fake inference.
The local Pyric HTTP suite remains unchanged.

Initial admission revision: `allowance-overload-00002-86s` (2026-09-19).
Current private execution-workload revision: `allowance-overload-00003-n5h`.
See the [paired execution findings](../comparisons/hosted-execution/README.md).
Service URL: https://allowance-overload-77eiz5rbyq-uk.a.run.app

The deployed smoke check passed: unauthenticated health returned 403,
authenticated health returned 200 with matching source/run/revision, and a fake
inference request completed with HTTP 200 after real Firestore admission.
This is a deployment smoke result, not a hosted overload/capacity measurement.

[Successful deployment evidence — private archive](../../../EVIDENCE.md)
includes the resolved image digest and an adjacent exact source snapshot with
per-file hashes. [First revision evidence — private archive](../../../EVIDENCE.md)
records the health-route failure before any inference was attempted.
Google intercepts `/healthz` before the container; the service and smoke now use
`/health`. See [reserved Cloud Run paths](https://docs.cloud.google.com/run/docs/known-issues#reserved_url_paths).
The local public-HTTP regression failed on `/health` before the fix and passed
afterward (two tests, nineteen assertions); actual hosted smoke verified routing.

## Required identities and permissions

Deployer/build: `803835021738-compute@developer.gserviceaccount.com`.
Runtime: `firebase-adminsdk-fbsvc@digame-mas.iam.gserviceaccount.com`.
Both keys stay local. Runtime credentials come from the attached identity.

For the prepared source deployment, grant:

- Cloud Run Source Developer (`roles/run.sourceDeveloper`) on `digame-mas`.
- Service Usage Consumer (`roles/serviceusage.serviceUsageConsumer`) on `digame-mas`.
- Service Account User (`roles/iam.serviceAccountUser`) on the attached build/runtime
  accounts, to the deploying account.
- Cloud Run Builder (`roles/run.builder`) on `digame-mas` to the selected build account.
- Cloud Run Invoker (`roles/run.invoker`) on `allowance-overload` for the account
  that will invoke the private service during smoke tests and measurements.

The runtime account also needs Firestore document read/write access to the named
database. Existing access was verified previously by the hosted allowance runs;
the deployment command rechecks database metadata. Cloud Run, Cloud Build and
Artifact Registry APIs must be enabled by an administrator if not already enabled.
The scripts do not grant IAM roles or disable authentication.

See Google's [source deployment roles](https://cloud.google.com/run/docs/deploying-source-code)
and [custom build service account](https://cloud.google.com/run/docs/configuring/services/build-service-account)
documentation.

## Prepare and deploy

From the repository root:

```sh
node experiments/rate-limiting/inference-allowance/deployment/prepare-cloudrun.mjs
node experiments/rate-limiting/inference-allowance/deployment/deploy-cloudrun.mjs \
  "$HOME/Documents/digame-mas-65fca8fd3136.json" \
  "$HOME/Documents/digame-mas.json"
```

Preparation copies only an explicit allowlist of harness code, a standalone npm
lockfile, Dockerfile, and hashed provenance into a new temporary directory. It
never copies credentials, `.env` files, app data, experiment captures, or the repo's
node_modules. Cloud Build builds this small directory. Runtime uses Application
Default Credentials from its attached service account, never the JSON key.

The script checks the named Native/Standard/pessimistic database in `us-east4`,
refuses to reuse a service with public IAM bindings, and deploys with the invoker
IAM check enabled (new services are private by default),
zero minimum/one maximum configured instances, concurrency 80, one CPU, 512 MiB,
and a 10-second HTTP timeout. Admission limits remain two per user and sixteen
per instance with a two-second admission deadline. Instance-based CPU allocation
allows underlying work to settle after an HTTP response; idle instance time can
be billable until scale-down. See [Cloud Run billing settings](https://cloud.google.com/run/docs/configuring/billing-settings).

A fresh run ID isolates records under:

```
allowanceExperiments/{runId}/cases/cloudrun-combined-guard/
  quotas/{hashedUid}
  admissions/{hashedUidAndRequestId}
```

`GET /health` returns backend, source hashes, revision, run ID and admission limits.
`POST /infer/chat` or `/infer/agent` accepts the existing request body. The private
experiment operator selects a **synthetic actor** using `X-Experiment-User`:
`alice`, `bob`, `carol`, `dave`, `eve`, or `user0` through `user19`.
This is not end-user Firebase Auth; never make this experiment service public.
Cloud Run IAM authenticates the operator. Use an audience-bound Cloud Run identity
token in the Authorization header; do not print or retain it in experiment traces.

The startup provenance and structured stdout events include source hash, Cloud Run
revision, run ID, instance ID, event sequence and process-local monotonic timing.
No request Authorization header, model prompt, or credential is logged. The
250-request ceiling is **per process lifetime**, not a durable global budget across
restarts or revisions. Fake inference guarantees no model charges.

This prepares a combined-guard hosted smoke target. It does not yet implement the
remote multi-case load generator, exported Cloud Logging capture, or a normalized
hosted overload comparison. The deployment command runs authenticated health/inference and unauthenticated
rejection smoke checks against the actual URL, verifies its source/run/revision,
and records the outcome. An unsuccessful smoke is reported as incomplete.

## Local preparation verification

The standalone npm lockfile installs with `npm ci`. The packaged service started
under Node 22.18.0, served health with the expected source hash and named database,
and drained cleanly; that startup check made no Firestore writes or inference
requests. Public HTTP behavior is tested with Pyric, including invalid synthetic
actors, capacity retention after timeout, and successful other-user requests.
The Docker engine on this machine was unavailable. Cloud Build subsequently built
the container, and the actual Cloud Run smoke passed as recorded above. The Node base image is version-tagged, not digest
pinned; successful deployment records the resolved application image digest from
the Cloud Run revision so source equality is not mistaken for image equality.

## Run the bounded hosted observation

```sh
node experiments/rate-limiting/inference-allowance/deployment/run-cloudrun.mjs run \
  experiments/rate-limiting/inference-allowance/deployment/records/cloudrun-44696d01-04d3-4a78-8a35-ef5e08892753 \
  "$HOME/Documents/digame-mas-65fca8fd3136.json" \
  "$HOME/Documents/digame-mas.json"
```

This sends 88 fake-inference requests to the existing private service, reads
synthetic Firestore state, and exports matching Cloud Logging events. It changes
neither deployment configuration nor IAM. The operator needs log-read access;
the runtime key needs read access to `allowance-experiments`. Both stay outside
the capture. Exact client source is copied before execution and deployed source
hashes are verified against health. The output directory is printed immediately;
partial results remain there on failure. Credentials and dependency binaries are
not retained. The collector waits for all server work to settle before assessing.

The assertions expect enough starting credit for baseline users and two unused
agent credits for Eve. A second immediate run reuses changed quota state and may
fail these checks legitimately. For a fresh cohort, deploy a fresh isolated run,
retain its deployment report/source, and pass that new record directory. Do not
reset a live quota document to make a failed check pass. The 250-request ceiling
is per process and not a durable cross-instance experiment budget.

The first run's [findings](measurements/ade4c25b-c830-4b1f-afff-3a1c1983cb7e/findings.md)
and [summary — private archive](../../../EVIDENCE.md) report
88 responses, all 18 checks passed, and complete server traces. This narrower
observation does not implement the full local fault-injection/control matrix.
`deployment/measurements` uses its own manifest kind; the existing `run.mjs verify`
and strict paired-run comparison apply to the earlier capture format, not this
hosted observation. Verify each manifest entry's bytes and SHA-256 independently.

## Inference execution workload

The `--execution` deployment option selects the nine fixed lifecycle scenarios.
It uses the same private service and resource limits but a fresh run namespace.
The default remains the original admission workload. Preparation includes only
allowlisted source/dependencies; no credentials are packaged.

```sh
node experiments/rate-limiting/inference-allowance/deployment/deploy-cloudrun.mjs \
  "$HOME/Documents/digame-mas-65fca8fd3136.json" \
  "$HOME/Documents/digame-mas.json" --execution
node experiments/rate-limiting/inference-allowance/deployment/run-execution.mjs local
node experiments/rate-limiting/inference-allowance/deployment/run-execution.mjs run \
  DEPLOYMENT_RECORD_DIRECTORY \
  "$HOME/Documents/digame-mas-65fca8fd3136.json" \
  "$HOME/Documents/digame-mas.json"
```

Retain the prepared directory's contents under `DEPLOYMENT_RECORD_DIRECTORY/source`
and its deployment report at `DEPLOYMENT_RECORD_DIRECTORY/deployment-report.json`
before measurement. The runner verifies every packaged file against that report
and the live service. Its client source is copied and executed from the capture.
The deployed request/stream lifecycle, gateway, schedules, provider and policy
hashes must match the measurement source. The local mode uses the same router
and client with Pyric. Compare `workloadHash` and `architectureHash` before comparing
observations; timing is not claimed equivalent across environments.

There are 65 inference requests per measurement, plus authenticated health,
drain and streaming acknowledgement requests. Each case has separate quota and
receipt collections. Admission uses the same controlled clock as the local
workload; provider delays are explicit fixture settings. Firestore transactions
remain real Admin SDK transactions. The deployment smoke uses Dave, whose quota
is isolated from all measurement actors. Reused test namespaces are rejected.

The manifest kind is `inference-execution-measurement`. `status: complete` means
collection finished, not that every hypothesis passed: consult `assessment.json`
for `evidenceComplete`, `successfulExperiment`, and `issues`. Missing request or
provider lifecycle evidence, sequence gaps, and multiple instances make the
capture incomplete. Behavioral differences retain the same local expectations
as failed assertions. No blanket production-readiness claim follows from a pass.

The runner journals observations as received, retains raw Cloud Logging, and
attempts final server/state collection even after client failure. It has an outer
four-minute ceiling. A forced kill can leave only the partial event journal and
an incomplete manifest. Source snapshots exclude keys and dependency binaries.

In particular, Cloud Run HTTP/1.1 client disconnects need not reach the container.
This experiment does not synthesize an application cancellation message to hide
that transport difference. See [Cloud Run troubleshooting](https://docs.cloud.google.com/run/docs/troubleshooting).
