# Ordered returns inside a bounded loop

**Recommendation.** Promise source order for a finite sequence of guarded returns in the opt-in policy language. Authors can read each guard as a statement. For each item, evaluate the next condition. If it is true, evaluate that return value and exit the function. If a reached expression errors, propagate the error. Finishing the last guard continues with the next item. Two guards were enough for the author who wrote the chess policy. A third has the same semantics.

### The policy that motivated the change

The experiment compiled the [original author submission](../for-of/reference/author-trial/loop/first.policy) byte for byte. It receives Arcade's validated move geometry and a complete board. The first guard recognizes the destination. The second checks whether an intermediate square is occupied.

```js
for (const i of [1, 2, 3, 4, 5, 6]) {
  if (i * sx == dx && i * sy == dy) return true;
  if (board[files[x + i * sx] + ranks[y + i * sy]] != '') return false;
}
return true;
```

With a black pawn on a3 and a2 empty, the rook on a1 can capture on a3. Both conditions would be true at the destination. The first one returns. With the pawn moved to a2 instead, the second condition refuses the move at a2. The pinned Arcade native engine and the handwritten helper agreed on these and the other three fixtures before implementation. [Frozen answers](reference/native.json)

The previous compiler stopped at the second `if` with `Expected "}"`. The author had rewritten the loop with one guard:

```js
for (const i of [1, 2, 3, 4, 5, 6]) {
  if ((i < sx * dx || i < sy * dy) && board[files[x + i * sx] + ranks[y + i * sy]] != '') return false;
}
return true;
```

The new compiler scored both saved policies on all 256 previously sealed positions. Each matched all 112 clear paths and all 144 blocked paths. These are revisions from the prior trial. The result establishes compatibility with the original author intent. [Rewrite](../for-of/reference/author-trial/loop/locked.policy) · [Source and corpus digests](reference/sealed-score.json)

### Decisions

| Author guarantee | Enforcing runtime | Decisive case and boundary |
|---|---|---|
| Visit items in list order and guards in source order. The first taken return ends the function. | Standalone and eligible emitted Firestore helpers | The occupied destination passed. Reversing the two guards changed that case to a false refusal. |
| Skip later conditions and unselected return expressions. Propagate a reached error. | Standalone exposes the evaluation error. The deployed Firestore update exposes an allow or deny verdict. | Reading a missing field after a taken return was skipped. Reaching that same read errored. Forcing eager evaluation changed the skipped case from true to an error. |
| Preserve the input and check a declared runtime list limit before visiting any item. | Standalone | A two-element input against limit one read zero elements. A legal first-item return read just index zero. Input objects survived the public invocations unchanged. |
| Permit a sequence of guards subject to resource limits. | Standalone. The compiler can unroll eligible literal scalar lists into Firestore conditional expressions. | A three-guard policy selected each of three results and the fallback. For that specific body the helper passed the estimate at 36 items. At 37 the compiler refused emission with an upper bound of 1,002 expression units. Standalone still returned the fallback. |
| Carry one invocation-local accumulator across iterations. | Existing standalone extension | Tally still produced 89 for strike then erase at 90 and 90 for erase then strike. All seven controls matched. A 401-action input exceeded its checked limit. |

The emitter checks the configured source evaluation budget, the emitted helper's target budget, and applicable syntax and module limits. It reports a placement diagnostic when it cannot justify emission. A caller and the other rules in the same request consume part of Firestore's request-wide allowance. The three-guard probe supplies standalone and local compilation evidence. The hosted measurements below cover the two-guard policies. [Three-guard boundary](artefacts/placement.json) · [Mutation witnesses, bounds and Tally](reference/standalone-score.json)

### Production evidence

The handwritten and generated helpers ran inside the complete Arcade ruleset. Each signed player submitted the same move against the same normalized full match under each release. An independently signed client read every field before and after, and the controller recorded the server versions.

| White rook from a1 | Handwritten | Generated |
|---|---|---|
| Capture the pawn on a3 through clear a2 | Allow | Allow |
| Attempt the same move with the pawn on a2 | Deny | Deny |
| Move to adjacent a2 | Allow | Allow |
| Move to a8 over six clear squares | Allow | Allow |
| Attempt a8 with a blocker on the sixth square, a7 | Deny | Deny |

The separate owner-update release ran the [two-guard witness](policies/first-hit.policy) through Firestore. Every owner attempted the same update. These five cases distinguish error order within a single iteration.

| Stored cells | Standalone | Live write |
|---|---|---|
| `{stop:true}` | true | Allow |
| `{stop:false}` | missing-field error | Deny |
| `{stop:true, missing:true}` | true | Allow |
| `{stop:false, missing:true}` | false | Deny |
| `{stop:false, missing:false}` | true | Allow |

The 150-case complete-application regression matrix produced the same verdicts across its four rules profiles. Its highest local count was 997 for Black's rook capture a8 to a1 with castling rights in play. The handwritten helper reached 965 on the same request. We selected that position from the measured local results for a separate production check. Both releases allowed the signed guest's move, stored the complete successor and advanced the server version. Across five deployments, the 17 signed write attempts had 39 case-related read checks. All six refusals preserved the original full document and version. Each deployment restored the original deny-all rules and proved closure with a signed read and write. [Follow-up receipt and local costs](artefacts/hosted-budget.json) · [Complete match comparisons and restoration evidence](live/README.md)

One generated path can be cheaper on one move and costlier on another. The generated capture on a3 used 752 expressions in local replay, against 780 for the handwritten helper. On the six-clear-square move those counts were 919 and 896. Firestore supplied whole-write verdicts and persisted state. The evaluator supplied the expression counts. [Per-write evidence and release digests](artefacts/hosted-score.json)

### Reproduce the experiment

Run from this worktree with Python 3, Bun, Node and npm:

```sh
python3 experiments/policy-oracle/trials/ordered-guards/replay.py
```

The command installs locked packages offline. It checks the frozen answers, reconstructs the deployed bytes, repeats the mutations and Tally controls, compares 600 local chess verdicts, and replays the retained production evidence. It labels the previously sealed author scores as retained. A verifier can add `--corpus PATH` to rescore the hidden positions, `--controller PATH` to authenticate the original private production journals, and `--baselines ARCADE_CHECKOUT` alongside the controller to repeat the wider package and game suites. [Package and evidence lock](lock.json)

Compiler source is local commit `dcffab60f01ef9d6508735a14c2b6d1436f5e7d2` on `experiment/ordered-guard-compiler`. The [packed compiler](vendor/pyric-rules-ordered-guards.tgz) passed its installed Node consumer, 763 API and module tests, and 403 evaluator and budget tests. The earlier experiment's five generated outputs were byte-identical. The wider replay also passed 77 package cases, 21 Sokoban cases, 93,312 Yacht calculations, 186,624 local Yacht writes, and the existing 1,611-position chess corpus. [Regression scores](artefacts/regressions.json)
