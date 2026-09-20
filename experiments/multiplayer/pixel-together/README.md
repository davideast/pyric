# Pixel Together multiplayer experiments

A reproducible **E2 local experiment**, using public Pyric sandbox and modular
Firestore APIs. It does not modify Kin, connect to its sandbox bridge, or access
Firebase production. Each case creates a fresh synthetic backend.

```sh
bun test experiments/multiplayer/pixel-together/tests
bun experiments/multiplayer/pixel-together/run.mjs run /tmp/pixel-experiments
bun experiments/multiplayer/pixel-together/run.mjs compare <first/result.json> <second/result.json>
```

Programmatic entry: `runExperiment()` returns in-memory evidence. Use the CLI
or `captureRun()` to retain executed source and evidence. `assessRun(result)` checks required coverage, positive cases and the negative
controls. A successful experiment **includes a failed application invariant** in
`stale-grid` and `claim-aba-control`; those failures remain `passed: false`, never rewritten as a pass.
CLI exit 0 means the experiment produced expected evidence, 1 means an unexpected
result/incomplete case, and 2 means invalid usage or incompatible comparison.

## Workload and observations

Two authenticated member handles share a fresh backend. Both edits target a
two-cell board: Alice paints cell 0 red, Bob paints cell 1 blue. Explicit barriers
hold Bob after his initial transaction read until Alice's commit is acknowledged.
The expected final state is authored independently as `[red, blue]`.

| Model | Behavior exercised |
| --- | --- |
| Stale grid | Both read initial array; each submits their precomputed replacement |
| Transaction grid | Bob recomputes his pixel intent from each transaction read |
| Pixel records | Each pixel has its own document; distinct-cell writes are independent |
| Claims | Two users contend for red; owner can draw/release; rejected ownership bypasses; release/reclaim |

After the edit assertion, two listeners subscribe, receive initial snapshots,
then observe a separate marker write. This measures update delivery correctness,
**not time-to-convergence**. It does not prove arbitrary multi-client convergence.

Claims are authorized by fixture backend Rules, not by generated client code or
Kin's high-trust policy bridge. The fixture has two hard-coded family members.
It is not a deployable family-membership model. Claim generations and explicitly serialized same-cell writes are tested in workload revision 2.
No claim TTL, real offline queue, process crash, quota, billing or load test is included. A ledger is deliberately deferred; this workload needs no replay or
historical accounting.

## Normalized evidence contract (schema version 1)

Each new CLI output directory retains `source/`, `manifest.json`, `findings.md`,
`result.json`, `workload.json`, `firestore.rules`, and `assessment.json`.
The source copy is what executes. Keep the complete bundle together.
See [archive and replay behavior](../../README.md) for commands and dependency limits.

- `run`: UUID, start/end wall-clock timestamps, workload/rules/implementation
  SHA-256, Git revision, backend SDK version, entrypoint/build-tree/adapter digests, runtime,
  transport, production flag and explicit limitations. Git revision is a baseline;
  the implementation hash identifies architecture, scenarios, fixtures and comparison source.
  The manifest additionally fingerprints all retained files, including the runner and adapter.
- `cases`: unique case ID, run foreign key, completion/error status. Incomplete
  execution is never an assertion pass or a zero-valued measurement.
- `operations`: unique ID, run/case foreign keys, actor UID (null means signed out),
  operation kind/path, attempt when available, acknowledged/error/staged status,
  start/end sequence and native error code/message. Staged transaction writes
  are **not committed writes**. Read attempts are not billed-read estimates.
- `observations`: unique ID, run/case foreign keys, ordered listener deliveries,
  final grids, and SDK return-shape observations.
- `assertions`: unique ID, run/case foreign keys, named invariant, independent
  expected and observed values, Boolean decision. Failed negative controls remain
  failures in this table.

Sequence numbers are local recorder order (including completion events), not
server timestamps or global distributed ordering. Counts can be derived from
operation kinds, but do not compare these to billing. No latency metric is
reported: missing performance measurements are **unmeasured**, not zero.

`compareRuns` requires identical schema, workload, Rules and implementation
hashes, matching assertion coverage, and complete cases. It returns decisions
side by side without assuming either backend is the oracle. It never claims
performance comparability. Changing a scenario requires a new workload revision;
re-run both backends under that revision rather than joining unlike experiments.

## Future supervised Firebase execution

`runExperiment(driver)` is the seam. A driver supplies the modular Web SDK
operations in `sdk`, `environment` provenance, and async
`create({rules, fixture}) -> {client(uid), close()}`. Every case must have an
isolated database namespace and independently authenticated clients; only the
setup path may bypass Rules. The driver must provision the exact fixture Rules,
return acknowledged SDK operations, and clean up its resources. Supply immutable
SDK/build/deployment identifiers, backend/project/region and network conditions.
Do not silently translate unsupported operations into successful no-ops.

No Firebase driver is shipped or executed. Adding it requires supervised project
scope, Rules provisioning and cleanup. Preserve this scenario implementation to
keep its digest comparable; driver-specific behavior belongs in the driver.
Backend differences remain observations to investigate. A timeout is an
incomplete case, not proof that an invariant is false. The five-second local
barrier limit is not a production SLA; revise and replay both workloads if the
supervised environment needs a different timeout.

## First recipe

See [the collected run — private archive](../../EVIDENCE.md) for the exact run and its native traces.
The initial capture shows stale whole-grid replacement losing Alice's acknowledged
edit. Both recomputing inside a retried transaction and separate pixel documents
preserve the two distinct edits. Bob's grid transaction reads twice, demonstrating
that its callback actually retries. Two member listeners observe the subsequent
write in each model. All ten claim assertions pass.

For this workload, prefer independent pixel documents when unrelated cells need
no atomic coupling. If a shared grid is required, recompute the intended edit from
**every transaction read**, including retries; wrapping a precomputed stale array
in a transaction is insufficient. Use backend authorization for exclusive claims.
This is a local correctness recipe, not evidence of cheaper writes, higher
throughput, or production security for Kin's existing high-trust backend.

One observed compatibility gap: Pyric's transaction snapshot exposes `exists` as
a Boolean in this build. The fixture reads document data to avoid assuming
that shape, and retains `transaction-snapshot-exists-type` observations for a
later Firebase comparison. No simulator change was made to improve the result.


## Claim lifecycle experiments (workload revision 2)

[Retained capture — private archive](../../EVIDENCE.md):
8 completed cases, 29 invariant checks, including two intentional failures.
The original capture is retained unchanged. Compare revision 2 only with runs
of the same workload and implementation; revision 1 has different coverage.

| Case | Observation |
| --- | --- |
| UID-only release/reclaim | An old payload from the same UID is accepted after reacquisition (negative control) |
| Generation-bearing claim | Old drawing payload and stale release denied; current generation succeeds |
| Claim lifecycle protection | Delete/reset rejected; another member cannot use the owner's current generation |
| Same pixel | Blue written after red's acknowledgement replaces red; the neighboring green pixel remains unchanged |
| Listener resubscription | After detaching, missing a write, and subscribing again, the listener receives blue |

The fenced claim keeps `{ uid, epoch }` in a persistent claim document. Release
sets `uid` to null without changing `epoch`. Transactional reacquisition increments
`epoch`. Each pixel write carries the generation it was created under; Rules
check both current owner and generation. Claim deletion is forbidden so clients
cannot reset its history. This is a synthetic policy fixture, not deployed Kin Rules.

**Recipe refinement:** independent pixels avoid unrelated-cell replacement;
transactional claims should also carry a persistent generation when delayed work
must become invalid after release. Do not equate a matching UID with the same
ownership session. A generation is not a secret or a defense against a malicious
current owner deliberately submitting the current generation.

The delayed payload is held by the harness and submitted later. It is not a
Firestore offline queue simulation. Likewise unsubscribe/resubscribe is not a
network outage. Same-pixel ordering is deliberate and serial: no claim about
simultaneous server ordering, client timestamps or fairness follows. Revision 3 below adds competing reacquisitions and overlapping drawing transactions.
Claim expiry, crash recovery, real offline queues and hosted contention remain
future experiments.


## First source-inclusive capture

[Manifest — private archive](../../EVIDENCE.md)
and [findings](results/fa83f4b2-c445-4997-bbdc-9f66a0d05a6f/findings.md).

Pixel transactions and claim-acquisition algorithms live in architecture/ and
are imported by the scenarios. Adversarial writes and listener orchestration
are captured too. This is the synthetic architecture under test, not a claim
that the live generated app imports these modules. No React or unrelated Kin
code is saved.


## Contention and ownership experiments (workload revision 3)

[Source and environment manifest — private archive](../../EVIDENCE.md)
· [Per-invariant findings](results/9d0a8702-ebe5-4fa2-a946-fbb3f545b259/findings.md)

| Requested probe | Local observation |
| --- | --- |
| Competing acquisition of a released color | Alice wins generation 2; Bob retries, observes Alice, and returns false. Only one generation increment. |
| Ownership changes after a drawing transaction reads | Retried read sees Bob. Rules deny Alice's old drawing; the saved pixel is unchanged. |
| Delayed release after another UID acquires | Old release denied; Bob still owns generation 2. |
| Same UID claims two colors concurrently | **Fails the single-color requirement.** Both transactions initially read vacant documents and both claims succeed. |
| Concurrent transactions paint one pixel | Both initially read the same absent pixel. Red commits first; blue retries and commits afterward. Saved pixel and both listeners end blue. |

The fifth probe has overlapping transaction lifetimes with a controlled commit
order; it does not claim arbitrary fairness or ordering in hosted Firebase.
Both users own different valid color claims, so it tests authorized overwrites.
The fourth is retained as an expected negative control, never converted to a
passing architecture invariant. A successful harness assessment means the gap was
reproduced, not that single-color ownership is enforced.

**Next model hypothesis:** an atomic per-user ownership record alongside the
per-color record could enforce one color per user. It needs its own implementation,
Rules and contention probes; revision 3 intentionally does not claim that fix.
Revision 4 below implements and tests that hypothesis.
The existing one-owner-per-color and generation checks remain useful but do not
imply one-color-per-owner.

Saved revision 2 source remains replayable after these scenario additions; replay
uses the files in that capture's manifest, not today's scenario file list.


## Paired member/color ownership (workload revision 4)

[Final captured findings](results/d106dc67-cd0a-44dd-801b-7fc80e6a2242/findings.md)
· [Executed source manifest — private archive](../../EVIDENCE.md)

The candidate adds a memberClaims document to each colorClaims document under
pairedBoards/main. Acquisition reads both records and writes matching ownership
in one transaction. Concurrent requests for different colors by the same UID
now contend on the member record; concurrent requests by different UIDs for the
same color contend on the color record. Both races produce one winner locally.

Release clears both records while retaining the color generation. Switching
reads and updates the member record plus both colors atomically. An occupied
requested color leaves current ownership intact. Expected color/generation tokens
reject delayed release intents; Rules reject old-generation drawings and batches.

The getAfter checks independently enforce reciprocal records in the final atomic
write state. Direct batches with incomplete pairs, forged owners, mismatched
generations, extra fields, deleted records or two new colors are denied. Bypassing
the transition helper to switch without releasing the old color or acquiring the
new one is also denied. Signed-out and outsider writes are denied.

### Preserved failed candidate

[Failed capture](results/7256e37a-795f-4c3c-b508-d1b998822aef/findings.md)
uses get() for pixel authorization: it incorrectly accepts releasing a claim and
drawing with it in the same batch. The final variant uses getAfter() for both
ownership records, denies release-and-draw, and permits valid acquire-and-draw.
The failed source and evidence remain unchanged. An intermediate successful run
before adding the direct-switch bypass checks is also retained at
results/76c62038-dee3-40cf-bf03-6d032eaa1e10/.

This is E2 local evidence for a candidate architecture, not a live Kin migration
or hosted security proof. Claim/member records are preseeded in a valid state by
trusted setup; client creation and deletion are denied. Production provisioning,
family-membership authorization, claim expiry, SDK offline behavior and measured
Rules access-call/billing limits are outside this fixture. No production Rules
were deployed. The original per-color baseline still fails one-color-per-user;
that failure remains visible alongside the passing paired variant.
