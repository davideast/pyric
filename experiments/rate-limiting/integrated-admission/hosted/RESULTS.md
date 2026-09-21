# Integrated Admission and Accounting — Hosted Cloud Run Results

## Deployment & Provenance

| Property | Value |
| --- | --- |
| Project | `digame-mas` |
| Region | `us-east4` |
| Cloud Run Service | `integrated-admission` (`https://integrated-admission-77eiz5rbyq-uk.a.run.app`) |
| Revision | `integrated-admission-00002-dmz` |
| Image Digest | `sha256:dbb376f47dee84b6a2dc3688a030df2850b466b429c78ed644cf4277ffdff0c8` |
| Deployer Identity | `803835021738-compute@developer.gserviceaccount.com` |
| Runtime Identity | `firebase-adminsdk-fbsvc@digame-mas.iam.gserviceaccount.com` |
| Firestore Database | `projects/digame-mas/databases/allowance-experiments` (`FIRESTORE_NATIVE`, `STANDARD`, `PESSIMISTIC`) |
| Deployed Source SHA-256 | `5116704eb2a0b39f76e9ba5c94e4589cde33d1c72cad447cc4d27149e382f804` (12 files) |
| Log Sink | `pyric-integrated-admission` → `logging.googleapis.com/projects/digame-mas/locations/global/buckets/pyric-experiments` |
| Inference Backend | Durable Firestore state-machine fixture (`provider/{key}`); **no real AI model calls** |

## Paired Capture Summary

| Metric | Local Pyric HTTP (`68f4b48a-aa72-41cf-88d7-359e6ac18bec`) | Hosted Cloud Run + Firestore (`50e167ef-12aa-41f1-b0a2-6984e085190e`) |
| --- | --- | --- |
| Cases Executed | 12 / 12 passed | 12 / 12 passed |
| Assertions Passed | 38 / 38 (`100%` parity) | 38 / 38 (`100%` parity) |
| Commands Dispatched | 76 | 76 |
| Terminal Transport Errors | 0 | 0 |
| Total Elapsed Time | 96 ms | 11,092 ms |
| HTTP Latency p50 | 0.64 ms | 99.22 ms |
| HTTP Latency p95 | 2.74 ms | 1,178.66 ms |
| HTTP Latency max | 6.17 ms | 2,119.86 ms |
| Cloud Logging Streams | In-memory server events (`server-events.json`) | `application: 351`, `http-request: 48`, `firestore-audit: 351` |

## Per-Case Final Ledger State (Identical Across Pyric and Cloud Run)

| Case | Global Active Slots | Quotas Docs | Request Records | Provider Jobs | Final Request State(s) |
| --- | --- | --- | --- | --- | --- |
| `normal-chat` | `0` | `1` | `1` | `1` | `{ completed: 1 }` |
| `normal-agent` | `0` | `1` | `1` | `1` | `{ completed: 1 }` |
| `capacity-busy` | `3` | `3` | `3` | `0` | `{ reserved: 3 }` |
| `quota-exhausted` | `2` | `1` | `2` | `0` | `{ reserved: 2 }` |
| `duplicate-same-payload` | `1` | `1` | `1` | `0` | `{ reserved: 1 }` |
| `duplicate-conflict` | `1` | `1` | `1` | `0` | `{ reserved: 1 }` |
| `pre-dispatch-cancel` | `0` | `1` | `1` | `0` | `{ refunded: 1 }` |
| `cancel-vs-dispatch-race` | `1` | `1` | `1` | `0` | `{ dispatching: 1 }` |
| `refund-saturation` | `0` | `1` | `1` | `0` | `{ refunded: 1 }` |
| `provider-unknown-quarantine` | `1` | `1` | `1` | `1` | `{ unknown: 1 }` |
| `idempotent-settlement` | `0` | `1` | `1` | `1` | `{ completed: 1 }` |
| `stale-fence-rejection` | `1` | `1` | `1` | `1` | `{ dispatching: 1 }` |

## Scope & Limitations

- **Atomic Conservation Verified on Pessimistic Firestore:** Every admitted request wrote all four documents (`quotas/{uidHash}`, `capacity/global`, `users/{uidHash}`, `requests/{requestKey}`) in a single native transaction; denials (`busy`, `quota_exhausted`, `conflict`) committed zero writes.
- **Pre-Dispatch vs Post-Dispatch Boundary:** Pre-dispatch cancellations atomically released the capacity slot and refunded allowance with saturation clamping; post-dispatch unknown outcomes (`provider-unknown-quarantine`) retained both the debit and capacity slot.
- **Fault Hooks Not Deployed:** Pre-commit crash injection (`crash-before-commit`), post-commit ack loss (`ack-lost`), and the unsafe negative control (`split-admission-control`) are verified exclusively in the local multi-process SIGKILL harness (`run.mjs run`).
