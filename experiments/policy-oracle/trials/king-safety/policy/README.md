# Compiled source-file king safety

The full chess policy exports `inCheck` from its bounded standalone module. The pinned public compiler returns `target: "standalone"` for that module and provides no Firestore emitter on the result. Its Firestore function entry also rejects the existing `underAttack` search at the lambda in `bounded.any(range(64), ...)`. This establishes the current compiler boundary. [Reproducible diagnostic](full-search.json) · [Original chess policy](../../chess/policies/chess.policy)

The [specialized policy](file-safe.policy) reads the eight squares on the moving rook's original file from the validated successor board. Removing the empty squares leaves the pieces in rank order. On a valid chess board with one king per color, an enemy rook or queen attacks the moving side's king on that file exactly when it is the king's immediate occupied neighbor. A surviving piece of either color separates them. The helper checks both neighbors. A king on a different file is outside this obligation.

The [linker](build.mjs) imports the emitted helper into the complete, previously qualified stronger Arcade release. In its existing move validator, `kind` is derived from the piece on the stored source square, `dx` from the move coordinates, and `color` from the stored turn. This additional conjunct runs for a rook changing files. The enclosing validator enforces orthogonal movement, ownership, the exact changed squares and the destination value. The king-safety binding is:

```js
&& (kind != 'r' || dx == 0 || fileSafe(next.board, mv.from[0:1], color))
```

The mutation uses exactly the same module and substitutes `old.board` for `next.board` in that call. Both the board and the move come from the existing match protocol. The player supplies no king location, attacker location or safety verdict.

The pure export `fileSafe(board, file, color)` and the whole move rule have different contracts. The export checks a single chosen file for attacks by a rook or queen. The move rule checks that obligation when a rook vacates its file sideways. Attacks on a rank or diagonal, knight or pawn attacks, castling, and changes caused by other piece types still require the standalone referee.

## Long horizontal moves

The initial bundle used Arcade's existing general two-dimensional path helper for every slider. A separate local search found that a legal a2-to-h2 slide exceeded the request budget with the extra file check. The initial bundle remains reproducible with `build.mjs ... --v1`.

The revised bundle compiles a [horizontal path helper](horizontal-path.policy) through the same public compiler. A horizontal move can have intermediate squares only on files b through g. For each of those six files the helper tests occupancy when the file lies strictly between the endpoints. This avoids the general ray helper's duplicated coordinate arithmetic and helper calls. The unchanged piece-shape check already enforces a single rank. All other move shapes continue through the earlier path helper.

The [independent path check](rank-path-check.mjs) covers eight ranks, all 56 nonzero ordered endpoint pairs per rank, and every 8-bit rank occupancy mask. It agreed on 114,688 cases. The separate [long-slide local corpus](long-ranks.mjs) varied mover color, direction, source-file blockers, king placement, and captures. Native Arcade accepted 240 of 288 distinct proposed positions and moves. The pinned local Firestore evaluator accepted all 240 under stock, 20 under the first generated release, and 240 under the revision. Its maximum on the revised cases was 998 expressions. The corpus was generated after initial qualification to investigate cost and measures these concrete local requests. [Recorded counts and first divergence](long-ranks.json)
