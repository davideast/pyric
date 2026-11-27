# Sliding replies in Arcade chess

After White plays **Qg4–g8**, can Black keep playing? With the black king on a8, the white king on a6 and the black rook on c5, Black has exactly one legal move, **Rc5–c8**. Shift that rook to h5 before the same queen move and it is checkmate. Rh5–h8 lands beyond the checking queen. The a7 and b7 escape squares are covered by the white king, and the queen covers b8. The client submits its ordinary Arcade move and a status claim. It supplies no defending move. [Frozen rook positions and both native reply lists](native/rook/independent.json)

The v16 release matched native chess on **238 of 238 authenticated Firestore writes**. It repaired all seven prior false approvals and the refusal of a legal mating promotion on the original 190. The 108 successful writes stored their full proposed match and advanced the server version. All 130 refusals preserved both document and version. The original deny-all release was restored and confirmed after each capture. [Per-batch and per-revision scorecard](SCORECARD.md) · [Independent signed audit](review/scores/a7f7200fffbb294ca859f3d279ae8cd33c6107d579e221dd9ad1aa9d28f225ca/signed.json) · [Full match readbacks for every write](live/releases/a7f7200fffbb294ca859f3d279ae8cd33c6107d579e221dd9ad1aa9d28f225ca/receipts/)

The v17 solver recognizes a defending king, queen and bishop for either color. It reads the piece type at each origin, keeps the other defender on the board, then checks that the reply leaves its king safe. The two Qd2–b2 boards add four claims to the original 238. Live Firestore agreed with the independent chess referee on all 242 writes. The only changed verdict was the false win with the pawn on b6. [Frozen native replies](native/queen-bishop/independent.json) · [v17 scorecard](QUEEN-BISHOP.md) · [Signed comparison of both releases on identical writes](review/scores/833a0fe29435df2456f0a3636aeea03dc33405f1193f22c424428efe469fdae8/signed.json)

The v18 solver checks whether either defending knight or its king has a legal move before it accepts `playing` on a two-knight ending. The other pieces on the board still block movement and can pin either knight. The oracle now includes all three claims on three boards. Seven claims are new and two draw claims already belonged to the original 190. Live Firestore matched the native answers on seven of nine writes before the change and all nine afterward. The full 249-write oracle passed locally. [Native positions and complete legal replies](native/two-knights/independent.json) · [Two-knight scorecard](TWO-KNIGHTS.md)

To audit the two live captures against native chess and compare the wider local disagreements by exact write, run from this directory with the private journals and pinned chess source archive.

```sh
python3 -B review/two-knights.py aa2da0c0522d4de0a8006a51591508ce4912c7bb40a102665d23f3a7bd27d341 "$PRIVATE_ARCHIVE" "$CHESS_SOURCE"
```

The v19 solver handles a defending king with one pawn. Three four-piece boards distinguish mate, stalemate and a legal pawn reply. On the Qc3–b4 pair, moving the black pawn from a7 to a4 gives Black exactly one reply, a4–a3. Each successor has a different correct status, so three is the minimum. Two independent chess referees agree on every legal reply. Live Firestore agreed on seven of nine baseline writes and all nine final writes. The 249 existing proposals plus the nine pawn claims all passed locally. [Boards and legal moves](native/lone-pawn/independent.json) · [v19 scorecard](LONE-PAWN.md)

The additional local controls check both pawn colors when a double push or en passant is the only reply. An intermediate build passed the three live boards and exceeded the local expression budget on the two legal en passant continuations. The selected candidate evaluates en passant earlier and passes all twelve control claims. The 524-write two-ply en passant corpus also reproduced its v18 verdicts. [Before and after audit](review/scores/031ff6cdfc8698e206156e248d6199d2b9c3253d5efd81852b91dd3e9b74a097/lone-pawn.json)

```sh
python3 -B review/lone-pawn.py 031ff6cdfc8698e206156e248d6199d2b9c3253d5efd81852b91dd3e9b74a097 "$PRIVATE_ARCHIVE" "$CHESS_SOURCE" "$PINNED_RULES"
```

## Score a compiler

Run from this directory on Linux with Python 3, Bun, Node, npm, Bubblewrap, and user and network namespaces available. The bundled fixtures and portable receipts support offline scoring. Substitute the tarball built by the compiler under test. It must expose the public `@pyric/rules/experimental/policy` entry point.

```sh
python3 -B replay.py --candidate-package /absolute/path/to/pyric-rules.tgz \
  --summary --report /tmp/chess-score.json --scorecard /tmp/chess-score.md
```

Omit `--candidate-package` to rebuild the pinned experimental package. A submitted package returns exit 0 only if its standalone predictions, compiled witnesses, and every local and measured live write satisfy the complete oracle with full live coverage. Exit 1 includes a scorecard for partial or incorrect candidates. A default reference replay returns exit 0 when its recorded results reproduce, including known failures. An operational failure exits with an error. A byte-identical Rules artifact can reuse its digest-bound capture, even from a repacked compiler. New Rules bytes require new live observations. [Scorer](replay.py) · [Package controls](controls/)

All 190 historical proposals are replayed as complete document transitions. The six rook claims are already among them. The 18 bishop claims and 30 queen claims bring the total to 238. Each board has the same move and successor under playing, draw and won. Arcade also requires the winner field to name the mover for won and to be empty for the other two claims. A refused legal write that exhausts the local expression budget counts as a false refusal and a limit hit. A refusal on an illegal proposal that exhausts the evaluator receives an evaluation error. Source compilation and data-plane enforcement have distinct evidence. [Frozen submissions](native/) · [Local revision observations](revisions/) · [Live capture and closure procedure](live/README.md)

Add any of these options to the same command.

| Option | What it verifies or produces |
| --- | --- |
| `--with-history` | Rebuild the saved revisions against their frozen corpora. The v17 revision covers 242 proposals, and earlier revisions cover 238. |
| `--witness-panel` | Trace 2,796 independent positions, check 42 full writes on 14 roster controls, and exercise the selected short-diagonal proof on 2,400 positions. Report in-scope and fallback cases separately. |
| `--python-chess-archive /path/to/chess-1.11.2.tar.gz` | Recompute each new native answer from the pinned independent source in addition to the Arcade referee and checked-in freezes. |
| `--archive /path/to/private/captures` | Authenticate portable receipts against the original private SDK journals, including signed closure. |
| `--emit /tmp/firestore.rules --example-dir /tmp/rook-example` | Write the complete deployable artifact and extract exact Pyric and emitted functions for the rook example. |

## What derives the reply

**Standalone Pyric** accepts the successor board, turn, castling rights, and en passant target. It selects the side's rook, bishop, and queen origins, checks their destinations and ray clearance, applies each reply, and checks its king on the changed board. It returns coordinates such as `["c5c8"]`. The same bounded module separately enumerates every legal reply to distinguish a continuing game, mate, and stalemate. Legal moves leading to the same exact successor share a prediction. Deliberately illegal source moves and corrupted successions are still graded on their complete writes. [Readable standalone policy](sliding-replies.policy) · [Shared move and safety policy](../chess/policies/chess.policy) · [Adapter input](project.mjs)

**Compiled Rules** use a chess-specific lowering to avoid enumerating a 64-by-64 move product during a Firestore write. The full map becomes a rank-ordered board with two boundary markers per rank. For a ray check, the policy finds where the defending piece can intersect that checking line, verifies clear travel, moves it on a copy, and tests whether any attack still reaches its king. A successful result encodes both squares. The c5 square has index 42 and c8 has index 72. The number `42 × 80 + 72 = 3432` therefore means `c5c8`. A return of `-1` means no legal slider reply in the helper's material scope. A separate check considers the remaining defenders. An in-check king with no legal reply is mated. [Exact Pyric functions for the rook pair](examples/rook-pair.policy) · [Their emitted Firestore functions](examples/rook-pair.rules) · [Complete selected ruleset](live/releases/833a0fe29435df2456f0a3636aeea03dc33405f1193f22c424428efe469fdae8/firestore.rules) · [Batched policy construction](compiler/records.mjs) · [King projections](compiler/king.mjs) · [Pawn defenses](compiler/family.mjs) · [Public compiler entry point and full ruleset linkage](compiler/emit.mjs)

On these two boards, the full write reaches this generated claim check after validating the submitted move and successor.

```
function slideClaim(status, hasReply) {
  return (status == 'playing') == hasReply;
}
```

The Rules binder computes `hasReply` from the defending king, the sliding-piece witness, and any in-scope knight or pawn. On each rook board the king has no move. On c5, the integer producer returns 3432, so the rules admit `playing`. On h5, it returns −1, so they admit `won`. The preceding `slideMayClaim` rejects `draw` because the king is in check on both boards. The scorer also replaces the integer producer with fixed absence or presence in diagnostic copies and observes both the playing and won decisions flip. [Exact compiled functions](examples/rook-pair.rules) · [Binder that supplies their arguments](compiler/records.mjs) · [Six full-write traces](review/scores/a7f7200fffbb294ca859f3d279ae8cd33c6107d579e221dd9ad1aa9d28f225ca/witness.json)

The full bounded program and the specialized Firestore source are separate authored implementations. The experiment demonstrates public compilation of the specialized helpers. It does not establish an automatic transformation from arbitrary bounded chess policy to equivalent Firestore Rules. For material outside a compiled guard the complete Arcade ruleset can fall back to its previous result logic. The independent witness audit reports that branch explicitly. [Witness extraction](review/witness.mjs) · [Independent board panel](review/panel/freeze.json)

**Live Firestore** returns the SDK verdict and stored document. Local traces can show the defending square and expression count, neither of which the hosted service returns to the client. The signed capture records both the document and server version before and after every attempt. A refusal must preserve the entire match and its version. Only fully closed capture windows enter the score. [Receipt qualification](live/records.mjs)

## How the oracle detects false agreement

One faulty implementation permits a bishop on e5 to jump over d6 to b8. Another permits a bishop on b7 to move to c8 while exposing its own king. Each wrong reply contradicts a frozen empty native reply list. A third control changes only the encoded destination while leaving every complete admission verdict intact. The package scorer catches the wrong square on the rook pair. [Geometric and king-safety controls](native/mutations.json) · [Destination-encoding package control](controls/queen-cross-v4.json)

The package controls exercise mistakes in the compiler itself. Ignoring blockers produces the illegal e5–b8 reply through d6. On the focused boards, skipping the post-reply king check first produces h5–h8, leaving the queen on g8 attacking a8. In the full suite’s original 190-case order, the first changed admission is the false playing claim `holdout-interior-v1-b-mate-playing`. Changing the witness encoding first reports c5–a4 in place of c5–c8, even though all complete write decisions remain the same. A byte-different repack of the correct compiler serves as the positive control. The vendored 0.1.0 package separately exercises compilation failure. Its pure-expression compiler rejects the method call in this policy. [Package control source](controls/compiler.py) · [Selected package scores](controls/selected.json)

```sh
python3 -B controls/compiler.py --variant all-paired-records-v16-dense3-lean \
  --geometry --report /tmp/sliding-package-controls.json
```

The scorer installs candidate code offline. Its standalone worker receives only positions and the policy source. The emission worker receives policy source and an interface version. Independent workers own the frozen answers, trusted linker, Rules evaluator, and receipt lookup. The local witness test adds diagnostic match paths to inspect the existing function return values, then traces the untouched full write rules separately. Diagnostic paths are local and never part of the deployed Rules. [Isolated package scorer](../../core/offline_runtime.py) · [Trusted linker](link.mjs)

The selected batched solver compiles one rewrite over labeled, hypothetical boards. For a rook it proposes the four orthogonal rays, for a bishop the four diagonals, and for a queen all eight. A successful projection has vacated the origin and placed the piece at a legal destination. A separate expression discards projections where the king is still attacked. The result goes into the actual full-write claim check. For each of the 18 focused boards, the oracle also forces the shared integer producer to return absence and presence in two local diagnostic copies. This establishes whether that returned move changes the playing and won decisions. [Batched projection and readable example](compiler/README.md) · [Causal verdict tests](review/witness.mjs)

The declared material includes one defending slider, two defending rooks, a slider with one knight, or a lone knight. It also includes a slider with one pawn when the opponent has no pawn. The king is considered in every such position. A pawn promotion can block or capture on its last rank, where any promotion occupies the same square for purposes of its own king’s safety. The pawn guard excludes en passant when a defending pawn is present. A legal castle also implies a legal one-square king move onto the transit square, sufficient to establish continued play. Other material uses the prior result policy, except for a proved short diagonal check on the ordinary-slider write path. [Material predicate](compiler/material.mjs) · [King projections](compiler/king.mjs)

For the short diagonal check, the emitted function marks the checking bishop or queen and the two intervening empty squares. It tests every defending nonking piece for geometric access to the relevant squares. Pawn captures, advances and double advances have separate tests. A negative result proves that only a king move can answer the check. A positive geometric possibility defers to the previous policy. The path requires an empty successor en passant target. On this domain a dense position such as the fourth-ply mate can be decided without general full-board reply enumeration. [Proof source](protocol/dense.mjs) · [Frozen 2,400-board independent control](protocol/dense-freeze.json) · [Incorrect geometries](review/dense-geometry.py)

## Where the selected rules still disagree with chess

The v19 local replay matched 15,875 of 15,905 proposals. All 20 lone-pawn disagreements were repaired, with zero new disagreements. The remaining 30 comprise 26 false approvals and four expression-limit refusals. [Full-write comparison](review/scores/031ff6cdfc8698e206156e248d6199d2b9c3253d5efd81852b91dd3e9b74a097/lone-pawn.json) · [All 30 remaining disagreements](review/scores/031ff6cdfc8698e206156e248d6199d2b9c3253d5efd81852b91dd3e9b74a097/residuals.json)

The wider v18 replay repaired 25 false continuations across 17 checkmates and eight stalemates. It introduced zero disagreements on the 15,905 proposals. The 50 remaining disagreements comprise 46 false approvals and four expression-limit refusals. [Per-write before and after comparison](review/scores/aa2da0c0522d4de0a8006a51591508ce4912c7bb40a102665d23f3a7bd27d341/two-knights.json)

On the 15,905-case wider local suite, v17 matched 15,830 native decisions. It repaired two expression-limit refusals compared with v16 and introduced no new disagreements. The 71 false approvals and four expression-limit refusals are outside the 242-case live campaign. [Causes of the 75 disagreements and proposed three-board live test](RESIDUALS.md) · [v17 cohort scores and changed cases](review/scores/833a0fe29435df2456f0a3636aeea03dc33405f1193f22c424428efe469fdae8/wide.json)

The wider v16 local replay found 15,828 matches across 15,905 case occurrences in eleven frozen cohorts. It also found 71 false approvals and six legal writes refused at the expression limit. The cohorts can contain the same document transition under different identifiers. The live campaign has its own denominator of 238 distinct proposals. [Cohort counts and minimized positions](supplemental/selected.json)

Compared on those same 15,905 local cases, this release repaired 152 false approvals and all four prior expression-limit refusals. The 71 remaining false approvals were already present. Six previously correct writes now hit the expression limit. Each changed or remaining error corresponds to a distinct full write. [Every repaired, regressed and remaining case by cohort](supplemental/changes.json) · [Comparison command](supplemental/compare.py)

| First minimized example | Native answer | Complete local Rules decision |
| --- | --- | --- |
| White castles short with its king on e1 and rook on h1. After castling, Black can move its rook on b8. | Allow `playing`. Black has 13 legal replies. | Deny at the 1,000-expression limit. The prior release allowed this exact write at 839 expressions. Removing the white queen from e7 gives Black two king moves and the selected rules allow the castle at 924 expressions. |
| Black checks with Qd2–b2. White has a queen on b1 and a bishop on c3. | Deny `won`. Both Qxb2 and Bxb2 capture the checker. | Allow the win claim. The prior release also allowed it. This defending roster takes the fallback path. |

A second minimization tried every subset of the original pieces while preserving the mover, both kings, the move, the claim, rights and check state. For the castling case, seven of 16 subsets met the chess conditions. Five pieces were necessary to reproduce the expression-limit refusal. For the false win, 1,536 of 4,096 subsets met the conditions and six pieces were necessary. Eleven six-piece boards reproduced the false approval. Two kept the exact replies Qxb2 and Bxb2. These minima apply to deletions from the two original boards. [Counts and smallest reproducing positions](supplemental/subsets.json) · [Exhaustive replay](supplemental/subsets.py)

In a separate four-write v16 live capture, Black played Qd2–b2 with and without the black pawn on b6. Standalone Pyric and the native referee found exactly Qxb2 and Bxb2 on each board. Firestore accepted `playing` on both. With the pawn present it also stored `won` for Black. With the pawn absent it refused `won` and preserved the complete match and server version. These four writes became the queen-and-bishop regression cohort in v17. [Predictions, verdicts and versions](supplemental/qd2-b2/result.json) · [Complete signed readbacks and restoration](supplemental/qd2-b2/qd2-b2-pawn-pair.json.gz)

Two further frozen positions show the opposite error. Black plays Rh3 mate against a bishop and rook. White plays Qg7 mate against a queen and rook. The fallback accepts a claim that play continues on both boards in local evaluation. The six status claims for these two mates still have local observations only. [Native moves, local verdicts and expression counts](review/scores/a7f7200fffbb294ca859f3d279ae8cd33c6107d579e221dd9ad1aa9d28f225ca/outside-material-checkmates.json)

To score all eleven cohorts and reduce the first example of each disagreement type in the original exploration cohort, supply the selected full Rules and an installed, pinned reference evaluator. The report includes the actual successor, native legal replies, full-write decisions and retained castling or en passant state.

```sh
python3 -B supplemental/score.py --rules /absolute/path/to/firestore.rules \
  --reference /absolute/path/to/reference/node_modules/@pyric/rules \
  --python-chess-archive /absolute/path/to/chess-1.11.2.tar.gz \
  --output /tmp/sliding-wider-score.json
```
