# Provider contract with real Firebase services

This phase uses a local Node/Bun controller, real Firebase AI Logic's GoogleAI
backend, and a dedicated Firestore database. It does not deploy Cloud Run or
represent the browser → Cloud Run → provider path. See [results](./RESULTS.md).

## Run safely and explicitly

Use a JSON file outside the repository with this shape; do not put API keys or
credentials in it:

```json
{
  "projectId": "YOUR_PROJECT",
  "databaseId": "DEDICATED_EXPERIMENT_DATABASE",
  "appId": "YOUR_FIREBASE_WEB_APP_ID",
  "model": "gemini-3.5-flash-lite",
  "limits": {
    "maxDispatches": 3,
    "maxConcurrent": 2,
    "maxOutputTokens": 64,
    "requestDeadlineMs": 30000,
    "runDeadlineMs": 180000
  }
}
```

The workload is fixed: complete response, complete stream, pre-dispatch abort,
and abort after the first nonterminal chunk. Each is attempted once. Only three
model calls are scheduled, with no inference retry. Firestore's native transaction
callbacks may retry up to eight times; that does not repeat provider dispatch.

```sh
bun experiments/rate-limiting/provider-contract/live/run.mjs preflight \
  --config /tmp/provider-live.json --credentials /path/to/data-service-account.json

# Explicitly authorized real model calls and isolated Firestore writes:
bun experiments/rate-limiting/provider-contract/live/run.mjs run \
  --config /tmp/provider-live.json --credentials /path/to/data-service-account.json \
  --auth-credentials /path/to/auth-service-account.json \
  --allow-real-inference --out /tmp/provider-live-evidence

bun experiments/rate-limiting/provider-contract/live/run.mjs verify CAPTURE
bun experiments/rate-limiting/provider-contract/live/run.mjs analyze CAPTURE
bun experiments/rate-limiting/provider-contract/live/logs.mjs \
  CAPTURE NEW_AUDIT_DIRECTORY /path/to/log-reader-service-account.json
```

Use existing service accounts with the necessary permissions. Preflight checks
read/write IAM permissions and the named database's native/pessimistic metadata;
it never grants roles or alters services. The Firebase web configuration is read
from that project's public Hosting initialization endpoint. If Hosting is absent,
pass `--firebase-config /path/to/firebase-web-config.json` outside the capture.
Project and app IDs must match the explicit target. The Auth identity needs to
create/delete a synthetic user, sign a custom token, verify the returned ID token,
and mint App Check tokens for the registered app. It can be the same account as
the database identity. Auth setup deletes only its newly created synthetic user;
it does not modify sign-in configuration or bypass rules for application users.

Credentials and tokens remain in memory or external files. Prompt/generated text
is never captured. Errors retain stages and status codes, not arbitrary response
bodies. The live prompt is a synthetic integer list.

## Durable accounting and evidence

`budget.mjs` uses Admin transactions at `providerContractExperiments/{runId}`.
One budget spans all cases: a dispatch atomically increments active reservations
and charges a dispatch before calling the provider. Only authoritative terminal
observations release a reservation, once. Abort, transport errors and timeouts do
not release it. Opening the same run again fails rather than resetting accounting.
A deadline stops local waiting; it does not prove remote work stopped.

The runner processes cases sequentially; the two-slot limit bounds retained unknown
work, not simultaneous workload pressure. Saturation, multireplica fairness and
Cloud Run connection behavior are not measured here. A shared transaction can
reject further dispatch even when the controller moves on to a different case.

The capture framework copies source before executing it. Live captures set
`replayAllowed: false`; both the CLI and generic capture replay reject redispatch.
Offline failure finalization reads files only. A killed process can leave its
synthetic Auth user behind; cleanup requires inspecting the captured run ID, never
bulk deletion. Firestore reservations are intentionally preserved for inspection.
Never start fresh runs merely to bypass unknown slots from an interrupted workload.

Audit exports are separate immutable supplements. They query the exact run's
Firestore document namespace, reject mixed/unrelated paths, and strip document
fields, caller identity and IPs. An observed export is not proof that every audit
entry arrived. No Cloud Run request logs exist for this transport path.

A passing result means the selected observations and accounting match the workload.
It does not establish remote cancellation or safe retry after interruption. The
inspection found no supported stop/status lookup on this generation interface;
those behavioral cases remain unexecuted rather than being marked as passing.
