# Multiplayer experiments

For shared mutable documents, stale array replacements, pixel boards or exclusive
claims, first distinguish an architectural hypothesis from measured behavior.
The Pyric repository contains a retained Pixel Together experiment at
`experiments/multiplayer/pixel-together/README.md`. Check that it exists before invoking it;
this is a repository tool, not an installed CLI command.

With an authorized isolated local probe:

```sh
bun experiments/multiplayer/pixel-together/run.mjs run /tmp/pixel-experiments
```

Read `result.json` and `assessment.json`, including incomplete cases and the
intentionally failed stale-grid invariant. Cite run ID, workload/Rules hashes,
case and assertion IDs in findings. Preserve the result directory and its
fixture/Rules files as durable evidence; do not treat it as a disposable audit
scratch report. Never apply its two hard-coded fixture members as production Rules.

The checked-in first recipe compares stale replacement, transactional intent
recomputation and independent pixel documents; it also tests exclusive color
claims and subsequent listener deliveries. Use it to motivate app-specific tests,
not to claim that every app using those patterns is correct. A transaction around
an already-computed replacement does not prove it preserves concurrent changes.

Grade these results **E2 Local**. Local execution speed, callback counts and
listener deliveries do not establish hosted contention, billing, quotas, latency,
offline behavior or TTL semantics. The later Firebase adapter must execute the
same workload and preserve provenance; comparison rejects changed workloads or
incomplete coverage. Neither environment is automatically the oracle when they
disagree. Hosted Rules tests alone do not measure production concurrency.

Do not prescribe ledgers, sharding or TTL leases without a requirement and an
experiment. The revision 2 fixture tests serialized same-cell overwrites and claim generations
that reject stale writes after release/reclaim. It also tests listener resubscription.
These do not simulate real offline queues, network reconnection, expiry or cleanup;
those remain untested. Cite the workload revision when describing coverage. Static warnings about shared-document
replacement are hypotheses until a reproducible schedule demonstrates the issue.


New CLI captures include the executed source snapshot and per-file manifest.
Verify the capture before citing it. Replay runs archived architecture with
current installed dependencies into a new bundle. Compare backend fingerprints
before attributing differences to architecture changes. Older captures without
manifests retain incomplete source provenance; do not attach today's code to them.
See the experiment README for verify and replay commands.


Revision 3 adds competing generation-bearing acquisitions, ownership transfer
mid-draw, delayed releases by a former owner, same-user multi-color acquisition,
and overlapping same-pixel transactions with listener convergence. It reproduces
a single-color-per-user failure: per-color claims alone permit the same UID to
own multiple colors. Do not infer that cardinality from exclusive per-color
ownership. Revision 4 tests a per-user coordination record paired atomically with each
color record. It passes the local acquisition, release, switch and stale-token
checks under preseeded fixtures. getAfter reciprocity denies direct partial or
mismatched writes. The retained failed candidate shows why drawing authorization
must also check final batch state: get() allowed release-and-draw in one batch.
These are E2 observations, not production assurance or a completed Kin migration.
