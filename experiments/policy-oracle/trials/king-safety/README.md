# An oracle for a rook uncovering its king

White's king is on e1 and White's rook on e2. Submit e2→d2 as the player whose turn it is. A black rook on f8 leaves the move legal. Moving only that black rook to e8 makes the same move expose White's king. These two inputs distinguish a compiler that checks the resulting board from one that consults the board before the move.

## Score a compiler

From this directory, run:

```sh
python3 score.py --candidate-package ../ordered-guards/vendor/pyric-rules-ordered-guards.tgz --with-live
```

Replace the tarball with any candidate implementing the [package contract](score-README.md). The command installs the candidate offline, invokes its public policy compiler, and evaluates its emitted Rules in the full application with a separately pinned evaluator. Each case reports the frozen native answer, the candidate outcome and the first divergence. Exit 0 requires all ten standalone file-safety results and all ten linked write decisions to agree with their respective reference answers.

The optional `hosted` field looks up the SHA-256 of the **complete linked ruleset**. Identical bytes receive the archived Firestore measurements for that digest. Different bytes report `unmeasured` until independently captured. The local score remains available for every package. The [capture protocol and receipts](live/README.md) retain each actual write, full server document and versions. With a reviewed ruleset, a subsequent capture can add observations without changing the native answers.

To reproduce the qualified compiler, the stale-board mutation, both lowering strategies, the diagnostic controls, the local cost study, the full application regression and the retained hosted receipts together, run `python3 replay.py`. Supply `--controller /path/to/captures` on the capture owner's machine to authenticate the original journals again. Replaying saved receipts makes zero live writes.

## What each authority answers

| Input | Source of the answer | What it establishes |
| --- | --- | --- |
| Position and move | Pinned native Arcade chess engine | Move legality and the moving king's check status before and after the move. [Frozen primary answers](reference/native.json) |
| Same position | Previously frozen standalone Pyric board implementation | Independent agreement on check and legal moves. The source hashes and both answers are recorded in the native fixture. |
| Authenticated update | Independent local Rules evaluator | Decision on the complete linked application, runtime errors and local expression count. [Candidate scores](score-evidence/qualified.json) |
| Authenticated update on a deployed ruleset | Live Firestore SDK write and independent server-backed readbacks | Admission for that exact release, the complete resulting match and whether its version advanced. [Retained observations](live/) |

The original seven cases were frozen at commit `7efc90c49`. The legal long slide and two blocked slides were frozen in separate cohorts, at `c00f8acac` and `ae5e65863`. Position IDs, moves and starting boards are public. The [registry claim](../../suites/arcade/chess/claims/vacated-file-king-safety/v1/claim.json) uses the native engine as its authority. Its probe replays pinned Rules artifacts. The package scorer additionally requires the submitted compiler to generate the artifacts from source.

## What compiled

The [authored policy](policy/file-safe.policy) reads all eight squares of the vacated file on the successor board. After empty squares are removed, a rook or queen can attack a king on that file only if it is the king's immediate occupied neighbor on one side. The bounded loop examines those neighbors. The compiler unrolls the loop to ordered conditionals in the [emitted module](artefacts/file-safe.rules). The host supplies the validated successor board, the moving rook's source file and the moving color derived from the stored turn. The player submits no separate king coordinate or safety verdict.

The [complete deployed rules](artefacts/generated.rules) contain this additional condition:

```js
&& (kind != 'r' || dx == 0 || fileSafe(next.board, mv.from[0:1], color))
```

The revised release also compiles [horizontal path clearance](policy/horizontal-path.policy) on the **old** board. It checks the intervening squares on the moving rank. The two blocked slides leave the king safe, so the standalone file helper returns true while the whole write is refused. The [generated path helper](artefacts/horizontal-path.rules) and the [old-board mutation](score-evidence/before-board.json) exercise the difference between those obligations.

The full board search still runs standalone. In this compiler the bounded module exposes no Firestore emitter and the single-function emitter stops at the attack-search lambda. This experiment covers a rook moving sideways and uncovering a rook or queen on its source file. Rank and diagonal pins, knight and pawn attacks, castling through attack, and other moving pieces require additional obligations. [Full-search diagnostic](policy/full-search.json)

## Production results

| Case | Move | Native chess | Handwritten live | First generated live | Revised generated live |
| --- | --- | --- | --- | --- | --- |
| rook-safe | e2→d2 | Legal | ALLOW | ALLOW | ALLOW |
| rook-exposed | e2→d2 | Illegal | ALLOW | DENY | DENY |
| mirrored-file | d2→e2 | Illegal | ALLOW | DENY | DENY |
| surviving-blocker | e2→d2 | Legal | ALLOW | ALLOW | ALLOW |
| black-exposed | e7→d7 | Illegal | ALLOW | DENY | DENY |
| black-safe | e7→d7 | Legal | ALLOW | ALLOW | ALLOW |
| queen-exposed | e2→d2 | Illegal | ALLOW | DENY | DENY |
| long-safe-slide | a2→h2 | Legal | ALLOW | DENY | ALLOW |
| long-slide-blocked-sixth | a2→h2 | Illegal | Unmeasured | Unmeasured | DENY |
| long-slide-left-blocked | h2→a2 | Illegal | Unmeasured | Unmeasured | DENY |

The five successful captures cover 26 authenticated write attempts and 57 read checks, including a signed-out read per capture. All 15 accepted writes stored the complete proposed match and advanced its version. All 11 refused writes preserved the full document and its version. Each release restored the original deny-all rules and confirmed signed read and write refusal. The first capture attempt encountered a management-service error, verified closure and supplied no scored observations. [Primary releases](artefacts/primary-live.json) · [Long-slide releases](artefacts/cost-live.json) · [Revised release](artefacts/optimized-live.json)

## What the oracle caught

- Binding the same generated file helper to `old.board` falsely allowed four exposed kings. The first divergence was the e8 board. The mutant scored 6/10 on linked move decisions. Its production digest is unmeasured. [Mutation score](score-evidence/before-board.json)
- The first generated release passed the seven original live positions. It subsequently refused a legal a2→h2 slide on live Firestore. The local evaluator hit its 1,000-expression limit on that request. Production returned permission denied without an expression count or an attributed cause. The revised rules allowed the same complete proposal, with 900 expressions locally. [Paired cost observation](artefacts/cost-live.json)
- Across 288 additional locally generated long-slide positions, 240 moves were native-legal. The first lowering accepted 20 of those. The revision accepted all 240, with a peak of 998 local expressions. The separate rank-clearance check matched all 114,688 combinations of rank, distinct ordered endpoints and occupancy mask. These are local measurements. [Long-slide study](policy/long-ranks.json) · [Rank-path check](policy/rank-path-score.json)
- In the existing 150-case, four-profile application matrix, the revised rule changed the intended pinned-slider verdict. The other 599 decisions reproduced. The previous full-board standalone regression also reproduced across 3,184 positions and 3,473 proposed successors. [Regression summary](artefacts/regressions.json)

The [evidence lock](lock.json) identifies the compiler package, policies, generated bundles, regression observations and per-release receipts. Each new compiler can earn its own score against these frozen answers.
