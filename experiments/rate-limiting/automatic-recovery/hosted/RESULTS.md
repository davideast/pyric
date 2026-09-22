# Hosted Execution Results — Automatic Recovery & Reconciliation

This document records the paired comparison between the local Pyric HTTP sandbox execution and the live Cloud Run + Native Firestore (`allowance-experiments`, `FIRESTORE_NATIVE`, `PESSIMISTIC`) execution of **Experiment 8: Autonomous Recovery & Reconciliation**.

## Target Infrastructure & Provenance

| Attribute | Value |
| :--- | :--- |
| **GCP Project** | `digame-mas` (`us-east4`) |
| **Cloud Run Service** | `automatic-recovery` (`https://automatic-recovery-77eiz5rbyq-uk.a.run.app`) |
| **Cloud Run Revision** | `automatic-recovery-00002-wts` |
| **Container Runtime Identity** | `firebase-adminsdk-fbsvc@digame-mas.iam.gserviceaccount.com` |
| **Firestore Database** | `projects/digame-mas/databases/allowance-experiments` (`FIRESTORE_NATIVE`, `PESSIMISTIC`) |
| **Root Document Collection** | `automaticRecoveryExperiments/{runId}/cases/{caseId}` |
| **Deployed Source SHA-256** | `bfe254f1cad4b08983dc6a91fc702a41736c15803f0d7067d4a9a47a63750f56` |
| **Inference Execution** | Disabled (`REAL_INFERENCE_ENABLED = false`; durable Firestore-backed provider oracle) |

## Paired Execution Summary

| Metric | Local Pyric HTTP (`--local`) | Hosted Cloud Run + Firestore | Parity Verdict |
| :--- | :--- | :--- | :--- |
| **Capture ID** | `89d585a9-f45c-4dd5-a534-dc99e682c3f8` | `01c63d6d-53c5-4346-aec4-314a629b0559` | — |
| **Manifest SHA-256** | `644e21d1bb01ac59e9f2c97a6983521a30bb92f16f03d7b864d4a8962e37879a` | `dd47ed1c5a7a82d5549948eff8394b809e79c1aa303c9ba517c27949a499f5bb` | Immutable |
| **Scenarios Executed** | 13 / 13 | 13 / 13 | **100% Match** |
| **Assertions Passed** | 31 / 31 | 31 / 31 | **31 / 31 Identical** |
| **HTTP Commands Dispatched** | 114 | 114 | **100% Match** |
| **Total Wall Elapsed** | 127 ms | 23,992 ms | Expected network/commit delta |
| **HTTP Latency (p50 / p95 / max)** | 0.52 ms / 1.27 ms / 10.17 ms | 174.29 ms / 507.47 ms / 925.84 ms | Sub-second max latency |
| **Firestore Data Access Audits** | In-memory | 468 audit log entries captured | Verified |
| **Analysis Bundle ID** | `b1cf1442-407b-427d-9389-ce5f518a3d42` | `comparable: true`, `matchingAssertions: 31/31` | **Verified** |

## Verified Recovery Scenarios (13 Core Scenarios, 31 Assertions)

1. **`death-after-reservation`** (3 assertions): Pre-dispatch gateway crash before `dispatching` intent is refunded on lease expiry; quota debited once, slot released (`active: 0`), state `refunded`.
2. **`death-after-intent-before-start`** (3 assertions): Post-intent crash with absent provider job never blind-resends (`provider.length === 0`), retains slot (`active: 1`), and records explicit quarantine (`quarantineReason: "provider-unobservable"`).
3. **`death-while-provider-runs`** (3 assertions): Expired lease while provider is `running` retains slot and reschedules `nextCheckAt` with exponential backoff; subsequent sweep after provider completion settles and releases slot (`active: 0`).
4. **`provider-completes-while-gateway-dead`** (2 assertions): Remote completion while gateway is dead is claimed and settled once by recovery worker (`state: "completed"`, `active: 0`).
5. **`two-recovery-workers-claim-race`** (3 assertions): Concurrent `claimExpired()` calls across `rec-1` and `rec-2` produce exactly one `claimed` winner and one `lease-owned` loser, advancing `fence` once (`fence: 2`).
6. **`recovery-worker-dies-after-claim`** (3 assertions): When `rec-1` dies after claiming (`fence: 2`), `rec-2` claims after lease expiry (`fence: 3`) and completes reconciliation without duplicate provider dispatch (`startAttempts: 1`).
7. **`stale-observation-after-takeover`** (2 assertions): Stale worker `rec-1` attempting to reconcile with old fence (`2`) after `rec-2` takeover (`fence: 3`) is rejected with `stale-owner`; slot decremented once.
8. **`settlement-commits-response-lost`** (2 assertions): Recovery claim against an already-settled record returns `already-terminal` without double-decrementing capacity (`active: 0`).
9. **`stop-acknowledged-not-confirmed`** (2 assertions): Acknowledged cancellation (`stop-pending`) retains slot (`active: 1`) until terminal `cancelled` evidence is observed (`active: 0`).
10. **`provider-status-transiently-unavailable`** (2 assertions): Transient provider status failure retains slot without guessing termination, then settles cleanly when status becomes observable.
11. **`provider-forever-unobservable`** (2 assertions): Permanently hidden/unobservable job after dispatch retains capacity slot (`active: 1`) and transitions to explicit quarantine (`quarantineReason: "provider-unobservable"`).
12. **`reconciler-backlog-spans-pages`** (2 assertions): Multi-page backlog (`batchSize: 2`) sweeps strictly forward via cursor pagination (`(nextCheckAt ASC, requestId ASC)`), quarantining stuck page-1 jobs while settling completed jobs on subsequent pages without starvation.
13. **`clock-offsets-and-renew-races`** (2 assertions): Skewed gateway attempting heartbeat renewal with stale fence after recovery worker takeover is rejected with `stale-owner`, preserving single-owner settlement.
