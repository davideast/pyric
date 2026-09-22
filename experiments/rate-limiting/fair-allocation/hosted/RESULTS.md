# Hosted Execution Findings — Fair Allocation (`fair-allocation`)

## Executive Summary

The **Fair Allocation (`fair-allocation`)** experiment evaluates whether bounded queueing and fair admission selection (`immediate`, `fifo`, and per-user `round-robin`) improve effective completion fairness across contending users under a hard execution capacity cap (`LIMITS.global = 3`, `LIMITS.perUser = 2`) without violating any safety, idempotency, or allowance invariant.

The identical architecture and HTTP workload harness were executed across two runtime planes:

1. **Local HTTP + Multi-Process Pyric Sandbox (`--local`)** — measurement ID `d392f5da-e5f6-433e-b5e8-c6769e8c8b8c`
2. **Hosted Google Cloud Run + Native Firestore (`firestore-admin`)** — measurement ID `14782337-b151-4b79-822c-d709ddebe18c`

Both captures passed **10/10 cases**, **18/18 assertions**, and **79/79 HTTP commands** with **zero terminal transport errors**, identical final document counts across all 10 scenario scopes (`active`, `quotas`, `reservations`, `queueEntries`, `providerJobs`), and cryptographic verification of identical deployed architecture source hashes (`sourceHash = 2f892ea64f10e6291a4d93f82514a0991f0c77459a342039f30dd10d25def79e`).

---

## Deployment & Provenance Metadata

| Field | Value |
| :--- | :--- |
| **GCP Project** | `digame-mas` (`803835021738`) |
| **Cloud Run Region** | `us-east4` |
| **Service Name** | `fair-allocation` |
| **Deployed Service URL** | `https://fair-allocation-77eiz5rbyq-uk.a.run.app` |
| **Deployed Revision** | `fair-allocation-00001-g6j` |
| **Deployment Run ID** | `94834f7e-3eb7-4058-aa7b-a10b8a0151ea` |
| **Runtime Service Account** | `firebase-adminsdk-fbsvc@digame-mas.iam.gserviceaccount.com` |
| **Firestore Database ID** | `allowance-experiments` (Native mode, `us-east4`) |
| **Firestore Collection Root** | `fairAllocationExperiments` |
| **Deployed Source Hash (SHA-256)** | `2f892ea64f10e6291a4d93f82514a0991f0c77459a342039f30dd10d25def79e` |
| **Local Capture Manifest SHA-256** | `23498f4b6db43b507bb5d5dd77a380686fa7831de97bfb58d3db07dfcc4a346d` |
| **Hosted Capture Manifest SHA-256** | `84c2d99f0c08b45d71ed2f955c8a064357a3dd3eed4140ff6de77d87b0073fd2` |
| **Paired Analysis ID** | `1bc579f5-3e2b-45ea-a273-6fcb11c0cbcd` |
| **Real Provider Inference Enabled** | `false` (`REAL_INFERENCE_ENABLED = false`) |

---

## Paired Runtime Comparison (`--local` Pyric vs. Cloud Run + Native Firestore)

| Metric | Pyric Local HTTP (`--local`) | Cloud Run + Native Firestore | Parity Verdict |
| :--- | :---: | :---: | :---: |
| **Scenarios Passed** | `10 / 10` | `10 / 10` | **Exact Match** |
| **Assertions Passed** | `18 / 18` | `18 / 18` | **Exact Match (`18/18`)** |
| **Dispatched HTTP Commands** | `79` | `79` | **Exact Match** |
| **Terminal Transport Errors** | `0` | `0` | **Exact Match** |
| **Total Wall-Clock Elapsed** | `109 ms` | `14,473 ms` | Expected WAN + Cloud Run cold/warm latency |
| **HTTP Latency p50** | `0.69 ms` | `126.58 ms` | Expected network + Firestore commit latency |
| **HTTP Latency p95** | `2.00 ms` | `456.44 ms` | Multi-document transaction & query scans |
| **HTTP Latency Max** | `8.43 ms` | `1,178.47 ms` | Initial container & index warm-up |
| **Firestore Audit Log Entries** | N/A (local sandbox) | `491` | Verified via Cloud Logging |

---

## Scenario-by-Scenario State & Assertion Parity

Every scenario was executed against isolated document scopes under `fairAllocationExperiments/run-<runId>-<variant>-<scenarioId>`. After all HTTP commands settled, `/inspect` verified that final Firestore document counts and all scenario assertions matched identically across Pyric and Native Firestore:

| Scenario ID | Assertions | Active | Quotas | Reservations | Queue Entries | Provider Jobs | Local vs. Hosted Parity |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `balanced-backlogged-users` | `2 / 2` | 3 | 3 | 3 | 6 | 3 | **Identical** |
| `one-noisy-two-quiet-users` | `2 / 2` | 3 | 3 | 3 | 5 | 3 | **Identical** |
| `short-and-long-operations` | `2 / 2` | 3 | 2 | 3 | 4 | 3 | **Identical** |
| `distinct-user-burst` | `1 / 1` | 3 | 3 | 3 | 0 | 3 | **Identical** |
| `duplicate-offer-storm` | `2 / 2` | 0 | 0 | 0 | 1 | 0 | **Identical** |
| `queue-overload` | `2 / 2` | 0 | 0 | 0 | 8 | 0 | **Identical** |
| `queue-cancellation-and-expiry` | `3 / 3` | 1 | 1 | 1 | 3 | 1 | **Identical** |
| `unknown-running-work` | `1 / 1` | 1 | 1 | 1 | 1 | 1 | **Identical** |
| `selector-restart-and-competing-selectors` | `1 / 1` | 3 | 3 | 3 | 3 | 3 | **Identical** |
| `allowance-exhaustion-interaction` | `2 / 2` | 2 | 2 | 3 | 4 | 3 | **Identical** |

---

## Architectural Findings & Engineering Takeaways

1. **Enqueue Must Not Reserve Execution Capacity or Allowance:**
   Separating bounded queue persistence (`enqueue`) from execution slot claim (`selectNext`) prevents queued work from consuming limited active capacity (`LIMITS.global = 3`) or debiting token/budget buckets prematurely. Cancellations (`cancelQueued`) and TTL expirations (`expireQueued`) cleanly transition queue entries to terminal states with zero capacity or quota leakage.
2. **Per-User Round-Robin Eliminates Noisy-Neighbor Head-of-Line Monopoly:**
   Under `one-noisy-two-quiet-users` and `selector-restart-and-competing-selectors`, a single noisy user submitting bursts of requests monopolizes global FIFO ordering. Storing a transactional `cursor/round-robin` document (`lastAdmittedUserId`) inside the claim transaction guarantees fair rotation (`alice -> bob -> carol`) across competing selector instances and restarts without external locks.
3. **Allowance Exhaustion Cleanly Skips Ineligible Users Without Blocking Others:**
   Under `allowance-exhaustion-interaction`, when a user exhausts their per-user concurrency or allowance policy, both `fifo` and `round-robin` selectors skip that user's queued entries and admit eligible work from other users in the same selection pass.
4. **Known Limit — Admission Fairness vs. Hold-Time Fairness:**
   Under `short-and-long-operations`, long-running operations hold active execution slots (`LIMITS.global = 3`) until settlement or lease expiry. While `round-robin` guarantees fair *slot selection* whenever a slot opens, total *execution slot-seconds* remain dominated by long-running requests unless paired with duration-aware quotas or preemptive scheduling.
