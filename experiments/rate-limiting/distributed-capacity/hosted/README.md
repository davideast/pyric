# Hosted workload controller

Runs nine supported capacity/recovery schedules against the existing private
command service. It never deploys, changes IAM/rules, calls an AI model, or clears
existing experiment records. See [measured results and limits](RESULTS.md).

```sh
# Paired baseline with the same HTTP dispatcher, fixture and policy over Pyric:
bun experiments/rate-limiting/distributed-capacity/hosted/run.mjs --local

# Approved hosted workload (gcloud on PATH, or GCLOUD_BIN=/path/to/gcloud):
node experiments/rate-limiting/distributed-capacity/hosted/run.mjs \
  experiments/rate-limiting/distributed-capacity/deployment/records/DEPLOYMENT_RUN_ID \
  /path/to/service-account.json

# Read-only comparison; a new analysis directory preserves previous analyses:
node experiments/rate-limiting/distributed-capacity/hosted/analyze.mjs \
  LOCAL_CAPTURE_DIRECTORY HOSTED_CAPTURE_DIRECTORY
```

The service has fixed `capacity-shared` and `recovery` namespaces for its deployment
run. A workload refuses populated namespaces, so **do not rerun against the already
used deployment expecting a clean trial**. It will retain a preflight failure,
not reset evidence. Repeated hosted trials require a separately approved service
change to support independent run namespaces, or a new approved deployment run.

`workload.mjs` defines the schedules and normalized assertions. `run.mjs` provides
HTTP transport, per-command traces, 40-second response deadlines, a 200-command
client ceiling, source capture, local server lifecycle and bounded log export.
Lost HTTP responses are uncertain outcomes; mutating commands are never blindly
retried. All dispatched responses settle before failed batches are finalized.
Routing failures are recorded and may acquire a new lease/fence in logical time;
these are bounded recovery transitions rather than hidden transport retries.

The gateway has its own 250-command *per-process* lifetime ceiling. Health must
report at most 40 prior commands before this workload starts, but one health
response cannot prove the remaining budget of every other process. A 503 or other
unexpected response makes the workload incomplete and remains visible in evidence.

`evidence.mjs` verifies the archive's file and aggregate hashes against deployment
metadata before commands are sent, and requires current local policy/HTTP/provider/
transaction source to match the deployed source. `analyze.mjs` independently checks
capture manifests, verifies deployed provenance, compares the archived source and
actual/expected values, and reports latency/retry observations without treating
local timing as a production forecast.

Each `results/<measurement-id>/` retains:

- `environment.json`: target, revision, source hash and reported runtime metadata.
- `source/`: captured controller and shared implementation/collector code.
- `deployed-source/`, `deployment-report.json`: actual deployment artifact (hosted).
- `dispatch.ndjson`, `attempts.ndjson`: outbound intent and completed HTTP evidence.
- `result.json`: scenario verdicts, assertions, coverage gaps and final state.
- `server-events.json` locally, or `logs/` with compressed redacted cloud streams.
- `manifest.json`: SHA-256 hashes for all retained artifacts.

The run captures working source rather than executing a copied bundle. Avoid
concurrent edits during execution; retained code is not a dependency-binary backup.
Controller corrections after a run remain distinct from its immutable snapshot.
No service account files or access/identity tokens are copied into records.
