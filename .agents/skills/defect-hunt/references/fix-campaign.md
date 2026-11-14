# Fix campaign: parallel streams that do not collide

The fix phase starts only after the evidence has landed as pins. Every stream
proves itself by removing pins; none may weaken one.

## 1. Pins first

Land the evidence before any fix, in its own PR: new scenarios, observations,
registry rows, a node count delta file per service touched, and a pin for every
disagreement (a known-divergence entry naming both answers and the finding).
The published score drops honestly. In #1247 this was stream S0 (#1248).

## 2. Stream plan

Group findings by defect class, mechanism ([defect-classes.md](defect-classes.md)),
and the files the fix must touch. Write the table before anyone starts:

| Stream | Findings | Class / Mechanism | Owns (may edit) | Must not edit | Depends on |
|---|---|---|---|---|---|
| S0 evidence | none | pins & observations | corpus, observations, registry, baselines, pin tables | source | none |
| S1 ... | ... | `STATE-ROUNDTRIP` (`...`) | the source files for this root cause | other streams' files | S0 |

- **Disjoint ownership.** No two streams own the same file. Isolate any single
  finding that requires a `> 500`-line compiler, prover, or lexer rewrite in its
  own stream rather than bundling it with routine parity fixes.
- **Standing checks for repeat classes.** If a stream fixes a repeat mechanism
  or a class with `>= 3` findings in the round, it must add or extend that
  class's standing mechanical check ([defect-classes.md](defect-classes.md#5-repeat-class-escalation-rule))
  rather than relying on per-finding regression pins alone. Every new standing
  check must fail against `main` (`revert-to-red`) rather than passing via silent
  abstention.
- **Invariant-only briefs.** Stream briefs and review bounces state behavioral
  invariants, concrete counterexamples, and non-regression constraints (after
  reconciling any narrowed or rejected sub-claims in `verified.md` up front).
  Never prescribe internal helper signatures, regexes, or encoding mechanics.
- **Exceptions are written down.** When a stream needs a file it does not own
  (a one-token export, a test that asserted non-production behavior), it asks;
  the coordinator approves on the board, naming the file and the reason.
- **Dependency-ordered DAG scheduling at 4 builder slots.** Do not gate all
  streams behind rigid round barriers. Compute hard interface dependencies and
  heavy multi-file soft overlaps from actual `origin/main` call sites. Keep up
  to 4 builders active whenever unblocked DAG streams exist, and release a
  builder's slot as soon as its branch enters independent review or PR CI. Hold a
  downstream stream only on its own unmerged hard dependencies or heavy soft
  file overlaps; every PR still targets `main` directly once its dependencies
  have merged.
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

## 4. Pre-build sibling check, then red to green

Before writing production code, each builder inspects `origin/main` and posts a
short (`<= 30`-line) seam and sibling note for one-turn `Spec` reviewer sign-off:

1. **Foundation reuse vs file splits:** which shared module (`AGENTS.md` #4) owns
   the invariant, and which `> 600`-line files stay at zero net growth by
   extracting a collaborator (`docs/code-conventions.md`).
2. **Complete sibling inventory:** every plane (in-process, SharedWorker, Hosted
   SQLite, Live), every entry point (CLI, Vite, Next, MCP canonical and
   discriminator), and every sibling grammar construct or prototype method that
   shares the same mechanism.
3. **Standing-check oracle and `revert-to-red` target:** how the class check will
   prove the mechanism and fail when the production fix is reverted.

Once the `Spec` reviewer confirms no sibling was missed, work red to green:

1. Remove the pin (or run the standalone repro) for one case. Run its test: it
   must fail (red).
2. Change the source until the case passes (green), with the observation or
   contract clause as the answer key.
3. Typecheck both `src/` and new or modified `test/**/*.test.ts` files (`tsconfig.json`
   excludes `test/` by default, so run `tsc` with `"exclude": []`), run single
   test files often, and run the full affected gates at the end.
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

## 6. Queue and merge one at a time

Enqueue approved streams through the repository merge queue (`.github/workflows/merge-queue.yml`),
in dependency order:

- apply the `merge-queue` label ([shipping.md](shipping.md#merging-through-the-queue-and-stacks))
  once two-axis review is `MERGE` and PR `CI / required` is green, rather than
  merging two PRs manually back-to-back;
- if a stream modified shared scorecards or baselines (section 3) after `main`
  moved, regenerate those shared files before re-applying `merge-queue`;
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
