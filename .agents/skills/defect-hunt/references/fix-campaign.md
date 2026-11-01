# Fix campaign: parallel streams that do not collide

The fix phase starts only after the evidence has landed as pins. Every stream
proves itself by removing pins; none may weaken one.

## 1. Pins first

Land the evidence before any fix, in its own PR: new scenarios, observations,
registry rows, a node count delta file per service touched, and a pin for every
disagreement (a known-divergence entry naming both answers and the finding).
The published score drops honestly. In #1247 this was stream S0 (#1248).

## 2. Stream plan

Group findings by root cause and by the files the fix must touch. Write the
table before anyone starts:

| Stream | Findings | Owns (may edit) | Must not edit | Depends on |
|---|---|---|---|---|
| S0 evidence | none | corpus, observations, registry, baselines, pin tables | source | none |
| S1 … | … | the source files for this root cause | other streams' files | S0 |

- **Disjoint ownership.** No two streams own the same file.
- **Exceptions are written down.** When a stream needs a file it does not own
  (a one-token export, a test that asserted non-production behavior), it asks;
  the coordinator approves on the board, naming the file and the reason.
- **Waves.** Streams with no dependency run at once; dependent streams stack on
  their base branch.
- **One worktree per stream**, never the main checkout.

## 3. Shared score pins

Scorecards, baselines and score pins in tests are shared by every stream, and
they are where parallel PRs collide. Each stream keeps its changes to them in
one commit of its own, separate from its source commits. The first stream to
merge lands its commit as is. Whichever PR merges second drops its pin commit,
rebases on `main`, regenerates the shared files, and commits the result.
Nobody hand-merges a generated number.

Node counts are not shared this way. Each PR adds its own delta file,
`assurance-node-counts/<service>/<pr-number>.json`, so two streams that add
rows to one service merge without conflict and nobody regenerates a count.

## 4. Each stream works red to green against the pins

1. Remove the pin for one case. Run its test: it must fail (red).
2. Change the source until the case passes (green), with the observation or
   contract clause as the answer key.
3. Typecheck and run the single test file often; the full gates once at the
   end.
4. A test elsewhere that asserted the old, non-production behavior changes only
   with a citation in a comment at the site, and only after the coordinator
   approves. Keep its intent: change what it asserts about the wrong behavior,
   and add a case for anything the change would otherwise leave uncovered.
5. Commit with a body that names the findings, the red to green evidence, and
   either regenerated conformance evidence or a `Conformance-Exempt:` trailer.

## 5. Review on two axes

Each stream is reviewed by an agent that did not write it:

- **Standards.** Does the change follow `docs/code-conventions.md`, the
  AGENTS.md boundaries, and its file ownership?
- **Spec.** Does it fix exactly the findings assigned, match the cited
  observations or clauses, and leave nothing half-done?

The reviewer re-runs red to green itself: the base's source with the stream's
tests must fail, and the stream tip must pass.

## 6. Merge one at a time

Merge approved streams one at a time, in dependency order:

- each merge follows [shipping.md](shipping.md#merging-a-stack);
- after each merge, the next PR regenerates shared evidence (section 3) and
  runs the gates before it merges;
- after the last merge, fold duplicated helpers into one module, remove pins
  whose dependency has now landed, and fix review notes deferred as
  non-blocking;
- run every finding's repro against `main`: all must print `FIXED`.

Findings that turn up during the campaign, outside its streams, get their own
issue and a comment on the umbrella issue, not a new stream.

## 7. Downstream check

If an app or package prompted the campaign, pack the merged build
(`bun pm pack` per package) and run that consumer's own regression gate against
it in a throwaway copy, without committing tarballs or touching its checkout.
