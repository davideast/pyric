# Referee: planes that must agree

pyric runs the same SDK surface on three planes: the in-page sandbox, the
SharedWorker host, and the Node host. An app must get the same results,
listener events and final data on each. When no production observation covers
a behavior, the planes referee each other: a mismatch is a defect on at least
one plane, even before anyone knows which.

Agreement is not correctness. Three planes can share a wrong answer. Use this
referee when production has nothing to say (host-only behavior, served-plane
error shapes), or to find where to point a production capture next.

## The RTDB differential runner

`packages/cli/test/serve/rtdb-differential/` generates operation sequences
(`set`, `update`, `push`, `transaction`, priorities, onDisconnect operations,
`reconnect`, listeners with queries, `get`, sign-in and sign-out, rules
changes, across named instances), runs each on every plane, compares the
normalized traces, and shrinks each mismatch to a minimal sequence.

```sh
bun run build:cli    # the Node plane runs the CLI's built dist
# the gate CI runs: fixed seeds plus every saved fixture
bun test --cwd packages/cli ./test/serve/rtdb-differential/rtdb-differential.gate.ts
# a hunt: more and longer sequences, mismatches saved as fixtures
bun packages/cli/test/serve/rtdb-differential/differential.ts \
  --start=1000 --count=2000 --steps=40 --chunks=2 --save=<scratch dir>
# replay a saved fixture; --strict also reports the known divergences
bun packages/cli/test/serve/rtdb-differential/differential.ts --replay=<fixture> --strict
```

Other flags: `--planes=sandbox,worker,node` to compare a subset, and
`--shrink=false` to keep a mismatch at full length. The exit code is 1 when any
sequence mismatches. The nightly CI run is the long sweep above, without
`--save`.

## A hunt with it

1. Run a sweep from a seed range nobody has run (the gate covers seeds 1 to
   160; nightly covers 1000 to 2999).
2. For each shrunk mismatch, decide which plane is right: a production
   observation, the written contract ([contract-adr.md](contract-adr.md)), or a
   new capture ([oracle-sdk-runtime.md](oracle-sdk-runtime.md)). Until then the
   finding reads "planes disagree" and names the unknown fact.
3. To grow the generator toward an angle (fault injection around `reconnect`,
   onDisconnect under rules changes), edit `generator.ts` in your worktree for
   the hunt; a generator change that should stay ships with the fix campaign.

## Pinning a divergence

`known-divergences.ts` lists divergences not fixed yet. Each entry has a
`name` and a `matches(mismatch, step)` predicate, and its minimal sequence is
saved as `fixtures/<name>.json`. The gate skips a mismatch an entry matches,
and fails if any entry's fixture stops reproducing it. The fix deletes the
entry, and its fixture must then agree on every plane: that is the red to green
for this referee.

## What is missing

- No Firestore or Storage differential runner. A Firestore or Storage plane
  question is answered by a test written for one plane, or not at all. To hunt
  it, write the same scenario against each plane's entry point by hand and
  compare. PRIORITIES.md names extending the runner to named databases and
  buckets.
