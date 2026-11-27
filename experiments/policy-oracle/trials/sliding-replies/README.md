# Sliding replies in Arcade chess

After White plays **Qg4–g8**, can Black keep playing? With the black king on a8, the white king on a6 and the black rook on c5, Black has exactly one legal move, **Rc5–c8**. Shift that rook to h5 before the same queen move and it is checkmate. Rh5–h8 lands beyond the checking queen. The a7 and b7 escape squares are covered by the white king, and the queen covers b8. The client submits its ordinary Arcade move and a status claim. It supplies no defending move. [Frozen rook positions and both native reply lists](native/rook/independent.json)

## Score a compiler

From this directory run the following command. Substitute the tarball built by the compiler under test. It must expose the public `@pyric/rules/experimental/policy` entry point.

```sh
python3 -B replay.py --candidate-package /absolute/path/to/pyric-rules.tgz \
  --summary --report /tmp/chess-score.json --scorecard /tmp/chess-score.md
```

Omit `--candidate-package` to rebuild the pinned experimental package. A submitted package returns exit 0 only if its standalone predictions, compiled witnesses, and every local and measured live write satisfy the complete oracle with full live coverage. Exit 1 includes a scorecard for partial or incorrect candidates. A default reference replay returns exit 0 when its recorded results reproduce, including known failures. An operational failure exits with an error. A byte-identical Rules artifact can reuse its digest-bound capture, even from a repacked compiler. New Rules bytes require new live observations. [Scorer](replay.py) · [Package controls](controls/)

All 190 historical proposals are replayed as complete document transitions. The six rook claims are already among them. The 18 bishop claims and 30 queen claims bring the total to 238. Each board has the same transition under playing, draw and won. A refused legal write that exhausts the local expression budget counts as a false refusal and a limit hit. A refusal on an illegal proposal that exhausts the evaluator receives an evaluation error. Source compilation and data-plane enforcement have distinct evidence. [Frozen submissions](native/) · [Local revision observations](revisions/) · [Live capture and closure procedure](live/README.md)

Add any of these options to the same command.

| Option | What it verifies or produces |
| --- | --- |
| `--with-history` | Rebuild every archived policy revision and rescore all 238 proposals for each. |
| `--witness-panel` | Trace 2,796 independent positions, check 42 full writes on 14 roster controls, and exercise the selected short-diagonal proof on 2,400 positions. Report in-scope and fallback cases separately. |
| `--python-chess-archive /path/to/chess-1.11.2.tar.gz` | Recompute each new native answer from the pinned independent source in addition to the Arcade referee and checked-in freezes. |
| `--archive /path/to/private/captures` | Authenticate portable receipts against the original private SDK journals, including signed closure. |
| `--emit /tmp/firestore.rules --example-dir /tmp/rook-example` | Write the complete deployable artifact and extract exact Pyric and emitted functions for the rook example. |

## What derives the reply

**Standalone Pyric** accepts the successor board, turn, castling rights, and en passant target. It selects the side's rook, bishop, and queen origins, checks their destinations and ray clearance, applies each reply, and checks its king on the changed board. It returns coordinates such as `["c5c8"]`. The same bounded module separately enumerates every legal reply to distinguish a continuing game, mate, and stalemate. Legal moves leading to the same exact successor share a prediction. Deliberately illegal source moves and corrupted successions are still graded on their complete writes. [Readable standalone policy](sliding-replies.policy) · [Shared move and safety policy](../chess/policies/chess.policy) · [Adapter input](project.mjs)

**Compiled Rules** use a chess-specific lowering to avoid enumerating a 64-by-64 move product during a Firestore write. The full map becomes a rank-ordered board with two boundary markers per rank. For a ray check, the policy finds where the defending piece can intersect that checking line, verifies clear travel, moves it on a copy, and tests whether any attack still reaches its king. A successful result encodes both squares. The c5 square has index 42 and c8 has index 72. The number `42 × 80 + 72 = 3432` therefore means `c5c8`. A return of `-1` means no legal slider reply in the helper's material scope. A separate check considers the remaining defenders. An in-check king with no legal reply is mated. [Exact Pyric functions for the rook pair](examples/rook-pair.policy) · [Their emitted Firestore functions](examples/rook-pair.rules) · [Complete selected ruleset](live/releases/a7f7200fffbb294ca859f3d279ae8cd33c6107d579e221dd9ad1aa9d28f225ca/firestore.rules) · [Policy construction](compiler/cross.mjs) · [Piece dispatch and other defenses](compiler/family.mjs) · [Public compiler entry point and full ruleset linkage](compiler/emit.mjs)

The full bounded program and the specialized Firestore source are separate authored implementations. The experiment demonstrates public compilation of the specialized helpers. It does not establish an automatic transformation from arbitrary bounded chess policy to equivalent Firestore Rules. For material outside a compiled guard the complete Arcade ruleset can fall back to its previous result logic. The independent witness audit reports that branch explicitly. [Witness extraction](review/witness.mjs) · [Independent board panel](review/panel/freeze.json)

**Live Firestore** returns the SDK verdict and stored document. Local traces can show the defending square and expression count, neither of which the hosted service returns to the client. The signed capture records both the document and server version before and after every attempt. A refusal must preserve the entire match and its version. Only fully closed capture windows enter the score. [Receipt qualification](live/records.mjs)

## How the oracle detects false agreement

One faulty implementation permits a bishop on e5 to jump over d6 to b8. Another permits a bishop on b7 to move to c8 while exposing its own king. Each wrong reply contradicts a frozen empty native reply list. A third control changes only the encoded destination while leaving every complete admission verdict intact. The package scorer catches the wrong square on the rook pair. [Geometric and king-safety controls](native/mutations.json) · [Destination-encoding package control](controls/queen-cross-v4.json)

The scorer installs candidate code offline. Its standalone worker receives only positions and the policy source. The emission worker receives policy source and an interface version. Independent workers own the frozen answers, trusted linker, Rules evaluator, and receipt lookup. The local witness test adds diagnostic match paths to inspect the existing function return values, then traces the untouched full write rules separately. Diagnostic paths are local and never part of the deployed Rules. [Isolated package scorer](../../core/offline_runtime.py) · [Trusted linker](link.mjs)

The selected batched solver compiles one rewrite over labeled, hypothetical boards. For a rook it proposes the four orthogonal rays, for a bishop the four diagonals, and for a queen all eight. A successful projection has vacated the origin and placed the piece at a legal destination. A separate expression discards projections where the king is still attacked. The result goes into the actual full-write claim check. For each of the 18 focused boards, the oracle also forces the shared integer producer to return absence and presence in two local diagnostic copies. This establishes whether that returned move changes the playing and won decisions. [Batched projection and readable example](compiler/README.md) · [Causal verdict tests](review/witness.mjs)

The declared material includes one defending slider, two defending rooks, a slider with one knight, or a lone knight. It also includes a slider with one pawn when the opponent has no pawn. The king is considered in every such position. A pawn promotion can block or capture on its last rank, where any promotion occupies the same square for purposes of its own king’s safety. The pawn guard excludes en passant when a defending pawn is present. A legal castle also implies a legal one-square king move onto the transit square, sufficient to establish continued play. Other material uses the prior result policy, except for a proved short diagonal check on the ordinary-slider write path. [Material predicate](compiler/material.mjs) · [King projections](compiler/king.mjs)

For the short diagonal check, the emitted function marks the checking bishop or queen and the two intervening empty squares. It tests every defending nonking piece for geometric access to the relevant squares. Pawn captures, advances and double advances have separate tests. A negative result proves that only a king move can answer the check. A positive geometric possibility defers to the previous policy. The path requires an empty successor en passant target. On this domain a dense position such as the fourth-ply mate can be decided without general full-board reply enumeration. [Proof source](protocol/dense.mjs) · [Frozen 2,400-board independent control](protocol/dense-freeze.json) · [Incorrect geometries](review/dense-geometry.py)

## Where the selected rules still disagree with chess

The wider local replay found 15,828 matches across 15,905 case occurrences in eleven frozen cohorts. It also found 71 false approvals and six legal writes refused at the expression limit. The cohorts can contain the same document transition under different identifiers. The live campaign has its own denominator of 238 distinct proposals. [Cohort counts and minimized positions](supplemental/selected.json)

| First minimized example | Native answer | Complete local Rules decision |
| --- | --- | --- |
| White castles short with its king on e1 and rook on h1. After castling, Black can move its rook on b8. | Allow `playing`. Black has 13 legal replies. | Deny at the 1,000-expression limit. |
| Black checks with Qd2–b2. White has a queen on b1 and a bishop on c3. | Deny `won`. Both Qxb2 and Bxb2 capture the checker. | Allow the win claim. This defending roster takes the fallback path. |

To reproduce the wider score and both reductions, supply the selected full Rules and an installed, pinned reference evaluator. The report includes the actual successor, native legal replies, full-write decisions and retained castling or en passant state.

```sh
python3 -B supplemental/score.py --rules /absolute/path/to/firestore.rules \
  --reference /absolute/path/to/reference/node_modules/@pyric/rules \
  --output /tmp/sliding-wider-score.json
```
