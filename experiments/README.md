# Architecture experiments

Original captures are stored in the [private evidence archive](EVIDENCE.md).
This repository retains code, synthetic fixtures and sanitized findings; raw logs,
deployment records and captured source bundles are excluded from Git.

Shared [observability setup](rate-limiting/inference-allowance/OBSERVABILITY.md)
lives under `shared/observability/`; each experiment declares its own requirements
manifest. The inference allowance experiment is the first consumer.

Repeatable workloads for testing application architecture and retaining the
observations behind our guidance. Start with
[Pixel Together](multiplayer/pixel-together/README.md).

```text
experiments/
├── shared/
│   ├── evidence/                    # Capture, verification and comparison
│   └── backends/pyric.mjs            # Isolated sandbox setup and build provenance
├── rate-limiting/
│   ├── inference-allowance/          # Per-user quotas, gateway and evidence
│   ├── distributed-capacity/        # Shared execution slots and gateway recovery
│   ├── provider-contract/           # Build brief: real provider evidence
│   ├── integrated-admission/        # Build brief: atomic admission/accounting
│   ├── automatic-recovery/          # Build brief: autonomous reconciliation
│   └── fair-allocation/             # Build brief: fairness and contention
└── multiplayer/
    └── pixel-together/
        ├── architecture/            # Pixel/claim algorithms and Rules
        ├── scenarios/harness.mjs     # Schedules, recording and invariant checks
        ├── fixtures/workload.mjs     # Actors, initial data and fixture Rules
        ├── tests/harness.test.ts     # Harness regression tests
        ├── results/<run-id>/         # Source snapshots, evidence and findings
        ├── README.md                # Findings, commands and limitations
        └── run.mjs                  # Run, replay, verify and compare CLI
```

From the repository root:

```sh
bun test experiments/multiplayer/pixel-together/tests
bun experiments/multiplayer/pixel-together/run.mjs run /tmp/pixel-experiments
bun experiments/multiplayer/pixel-together/run.mjs compare <left/result.json> <right/result.json>
```

These experiments ask how an application design behaves under a stated workload.
`packages/conformance` asks whether Pyric reproduces Firebase behavior. Comparing
experiment runs across backends can expose conformance gaps, but local experiment
results do not establish hosted performance or universal correctness.

Keep scenarios, fixtures and reviewed findings together in each experiment.
Keep original capture bundles together in private storage, referenced by the archive index.
Extract shared infrastructure only when there is a concrete need. The shared
comparison code accepts the experiment's required coverage; it does not prescribe
Pixel Together's invariants to future experiments. Production adapters and their
verification status are documented within each experiment.

Each new CLI run copies the small architecture, fixtures, scenarios and backend
adapter into its result directory before executing that copy. Source and evidence
are available together without a Git checkout. Uncommitted source is captured too;
Git is context, not the source archive.

The bundle contains source/experiments/, manifest.json, workload.json,
firestore.rules, result.json, assessment.json and findings.md. Keep these together.
No React or unrelated app code is copied. Pyric and its installed dependencies
remain external; hashes identify them but cannot reconstruct them.

Commands:

```sh
bun experiments/multiplayer/pixel-together/run.mjs verify CAPTURE_DIRECTORY
bun experiments/multiplayer/pixel-together/run.mjs replay CAPTURE_DIRECTORY /tmp/pixel-replays
```

Replay verifies file hashes and runs a fresh copy of archived source without
changing original evidence. It uses current installed dependencies and records
their fingerprints; compare these before claiming an identical environment.
Hashes detect accidental changes, not publisher authenticity. Replay only trusted
local bundles. A temporary dependency link is removed before archive finalization.

Older captures without a manifest predate source snapshots and remain unchanged.
They cannot use the new replay command. Failed execution retains copied source
and a diagnostic; a bundle without a completed manifest is incomplete.

## Inference allowance

[Inference allowance experiments](rate-limiting/inference-allowance/README.md) exercise
per-user transactional allowances with Pyric, captured source, and fake inference.
Hosted Firestore comparisons have separate captures and matching Pyric baselines;
AI Logic deployment remains a later step. Local results never stand in for hosted
latency or capacity measurements.

## Distributed execution capacity and recovery

[The local recovery experiment](rate-limiting/distributed-capacity/README.md)
uses separate gateway processes, native Pyric transactions and an independent
fake-provider oracle to test shared capacity, leases, fences and crash recovery.
An unsafe expiry-only control must oversubscribe capacity. Source snapshots and
normalized results are retained together. The [paired hosted workload](rate-limiting/distributed-capacity/hosted/RESULTS.md)
completed nine supported/adapted scenarios against native Firestore; the remaining
original fault-injection cases are not yet hosted. Every Cloud Run deployment
requires explicit approval.

## Next experiment build briefs

The [rate-limiting experiment index](rate-limiting/README.md) describes the sequence,
shared evidence schema, source-capture rules and comparison requirements for four
new experiments: provider contract, integrated admission, automatic recovery and
fair allocation. Their directories currently contain README build briefs only.
The proposed CLI commands in those briefs are not implemented yet.
