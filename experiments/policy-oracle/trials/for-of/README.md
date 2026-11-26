# What Pyric should promise about loops

**Recommendation.** Expose an opt-in, ordered `for...of` over finite lists in the experimental package. A guarded early return over literal scalar items is ready for an opt-in Firestore compiler preview. Keep a single local accumulator available for standalone experiments. The authoring trial found a real usability issue with making the one-guard body a stable language contract.

The prototype accepts a literal list of up to 400 items or a runtime list with an explicit integer limit in `bounded(input, N)`, where N is 1 through 400. Four hundred comes from Tally's turn limit. The evidence supports keeping this a prototype limit until another application needs it.

## Decision by behaviour

| Behaviour | Proposed guarantee | Enforcing runtime and decisive case | Open question |
|---|---|---|---|
| Bounded iteration | Visit items in list order. An empty list takes zero steps. A literal gives its own bound. `bounded(input, N)` checks the entire list length before executing the body. | Standalone supports both. In live Firestore the six-offset helper accepted the adjacent move, which inspects zero squares, and the move with six clear intermediate squares. Both runtimes refused the blocker on the sixth square. | Which dynamic lists merit generated type and length guards in Firestore? |
| Early return | The first taken return ends the loop. An error in a reached condition propagates. Later conditions are skipped. | Standalone and the generated literal-list helper. A live write with the first cell true and the second missing passed. A write with the first missing and the second true was refused. | Would authors succeed on the first edit if a body allowed a second guarded return? |
| Ordered accumulation | One invocation-local binding carries the result of an assignment into the next iteration. Inputs stay unchanged. Zero iterations preserve the starting value. | Standalone. From 90, strike then erase produces 89. Reversing those operations produces 90. Firestore emission stops with a named diagnostic. | Short or specialised folds might have an affordable translation. The 400-action trial gives no hosted evidence for that translation. |
| Unproven or exceeded bounds | Reject a loop whose maximum is unknown. A checked bound violation fails before even a first-item return. | Compiler and standalone evaluator. Three keys against a declared maximum of two failed both with a blocker at the first key and one at the third. | Whether to infer bounds from caller schemas or earlier validation. |

## The two authored policies

The rook helper receives the complete board map and validated move geometry from Arcade. The list contains the six possible offsets. Only offsets shorter than the move length access a square. The source and destination are excluded from the path. [Authored rook policy](policies/rook.policy) · [Handwritten comparison](../chess/bundle/source/path.rules)

```js
use extension loops;
function pathClear(board, x, y, dx, dy) {
  let sx = dx < 0 ? -1 : (dx > 0 ? 1 : 0);
  let sy = dy < 0 ? -1 : (dy > 0 ? 1 : 0);
  let distance = dx * sx > dy * sy ? dx * sx : dy * sy;
  let files = ['a','b','c','d','e','f','g','h'];
  let ranks = ['1','2','3','4','5','6','7','8'];
  for (const step of [1,2,3,4,5,6]) {
    if (step < distance ? board[files[x+sx*step]+ranks[y+sy*step]] != '' : false) return false;
  }
  return true;
}
```

Tally's game contract supplies a starting count in 0..90 and parsed strike/erase actions. Its arithmetic fold has an identity on empty input. Separately, the stock turn parser requires 1..400 actions. With 401 strikes the unrestricted native model still ends at 90, the stock turn parser refuses the turn, and the prototype refuses its declared length. The caller selected a 32,768-unit standalone budget. The concrete 400-strike calculation required 8,803 standalone units, above the default of 8,192. These units measure Pyric's evaluator. [Authored Tally policy](policies/tally.policy) · [Independent model and parser results](reference/native.json)

```js
use extension loops;
function tally(start, moves) {
  let count = start;
  for (const move of bounded(moves, 400)) {
    count = count == null ? null :
      move.kind == 'strike' ? (count < 90 ? count + 1 : 90) :
      move.kind == 'erase' ? (('all' in move && move.all) ? 0 : (count > 0 ? count - 1 : 0)) :
      null;
  }
  return count;
}
```

## What was verified

The expected outcomes were committed before the first implementation run. Four chess cases came from the pinned Arcade engine and its handwritten path helper. Seven Tally cases were compared with the pinned native model and turn parser. Six additional probes specify the proposed language's error, evaluation-order and bound semantics. All 17 passed. Deleting the sixth offset first misclassified `rook-sixth-blocked` as clear. Reversing the action sequence first changed `strike-then-erase-at-cap` from 89 to 90. [Frozen inputs and authority](reference/README.md) · [Candidate results and diagnostics](artefacts/results.json)

| Live authenticated write | Handwritten Arcade | Generated Arcade |
|---|---|---|
| a1 to a2, empty path | Allow | Allow |
| a1 to a8, six clear squares | Allow | Allow |
| Same move with a blocker at a2 | Deny | Deny |
| Same move with a blocker at a7 | Deny | Deny |

The two releases used identical normalised match documents and SDK write proposals. A separately signed client read back every field and the controller checked server versions. A third complete release added one owner-only diagnostic update for the emitted `firstHit` function. Its inputs `{a:true}`, `{a:false}`, `{b:true}`, and `{a:false,b:true}` produced allow, deny, deny, and allow. Firestore reported the whole-write verdict. The standalone probes captured the exact missing-key error. Across all three releases there were 12 writes and 27 read checks. All six denied writes preserved the documents and versions. Each release restored the original deny-all rules and verified closure before releasing the lease. [Signed evidence](live/README.md) · [Verdicts and release digests](artefacts/hosted-score.json) · [Emitted rook helper](artefacts/path-module.rules)

The Firestore compiler unrolls the literal items into ordered conditional expressions. The prototype accepts literal scalar nodes here. A computed expression such as unary minus takes the standalone path, even when its value is constant. The standalone-only diagnostic for a checked list names the missing type and length enforcement. For Tally it names the missing state-carrying translation. Neither a finite item count nor a helper-level estimate guarantees that an entire linked application fits the service budget. The 150-case complete-rules replay observed a local high of 946 expressions on the generated release and 965 on the handwritten release. Production supplied verdicts and stored state for the four paired moves. [Regression evidence](regressions.json)

## What the authors showed

Two fresh authors received the same brief, two public cases, one syntax card each and equal time caps. First and locked revisions were scored against 256 independently sealed ray positions. The existing `bounded.any` solution passed on the first edit. The loop author's first submission returned true on reaching the endpoint, then tested for a blocker in a second `if`. The parser refused the second guard with `Expected "}"`. The author rewrote it as one condition. Both locked submissions passed all 256 positions. One author per syntax establishes the specific source of friction. It cannot estimate a relative success rate. [Author submissions, diagnostics and scores](reference/author-trial/README.md)

**Next experiment.** Freeze the first loop submission as a new scenario: an endpoint guard followed by an occupancy guard in the same iteration. Include a missing square that should be skipped after the first return and a missing square that must be read. This tests a restriction an author actually encountered and would change the decision about a stable early-return contract. [Four-hour goal prompt](next-goal.md)

## Replay

Run this command from the worktree root.

```sh
python3 experiments/policy-oracle/trials/for-of/replay.py
```

The compiler source is commit `0f8f42cf03d7b6bda108fe73bc5b671fc65b6590` on local branch `experiment/loop-policy-compiler`. The campaign retains its [exact installable package](vendor/pyric-rules-loops.tgz). The packed Node consumer, 66 API and module tests, and 446 ordinary evaluator and budget tests passed on that revision. Independent review observed zero element reads on an oversized list and only one element read on a successful first guard.

The command installs the locked package offline, compiles both policies, rebuilds the linked rules, scores all 17 probes and both mutations, and replays the three live captures against a separately pinned evaluator. Add `--controller PATH` to authenticate the original operator journals. Add `--baselines PATH_TO_ARCADE` alongside it to rerun the prior package and game suites. The hidden authoring corpus stays with its verifier and has a separate reproduction command. [Package and evidence lock](lock.json) · [Authoring replay](reference/author-trial/README.md)
