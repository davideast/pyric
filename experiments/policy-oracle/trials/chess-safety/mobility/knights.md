# Can a defending knight refute a terminal declaration?

A proposed checkmate or stalemate is premature if a defending knight can legally move. Pyric receives the game's canonical successor board and the defending color. It derives the source, target, capture and king safety of each response. An absolute pin can make every apparent jump illegal; a check can leave only one interposition.

For white's `a8h8`, the [knight corpus](../exploration/knight-replies-v1/freeze.json) contains a pair that differs only by a white queen on b4. Both positions leave the black king immobile. With the queen on b4, White has pinned the black knight on g4 to the king on h4, and the draw claim is correct. Remove that queen and the knight can play `g4e3` among six legal responses. The same draw claim is premature. The frozen submissions are `knight-reply-477` and `knight-reply-483`.

## Derivation

[The standalone API](knight.mjs) returns UCI moves with `knightMoves(board, defender)` and a Boolean with `hasKnightReply(board, defender)`. Each eight-way jump must land on an empty square or capture an opposing nonking piece. Its hypothetical successor removes the knight from its source, replaces its destination, and runs the attack policy against its own king. This can certify a capture of a checking piece or a jump that blocks an attacking slider.

The first candidate examined the first and last eligible knight for each direction. Those two representatives suffice through two defending knights. A third promoted knight can stand between two pinned knights. The independent [boundary controls](knight-limit-native.json) demonstrate six legal jumps that the first candidate missed for each color.

The [paired candidate](knight-pairs.mjs) uses a single substitution per direction to project the first and last candidate in separate copies of the board. To inspect interior knights it masks the two outer knights as friendly blockers and repeats the same selection. The masked pieces stay on their squares. Their identity as friendly pawns or knights has the same effect on attacks against the defending king. Five pairs cover the original two knights plus all eight possible promotions. Every positive result identifies a concrete legal move in the original board.

[Replaying the native knight sets](qualify-knights.mjs) recovered all 8,497 legal jumps on 1,722 public and frozen boards, including the promoted-knight boundary. A [separate sweep](qualify-knight-counts.mjs) recovered all 2,914 jumps on 240 synthetic boards with one through ten friendly knights. The separately linked Rules predicate also matched existence on all 240. The attack geometry of these synthetic boards is the subject of that test; the real-history panel separately starts real matches and replays signed updates.

## Which complete writes are covered?

The selected variant is `knight-endgame-paired-pawn-combined-bare-simple-packed-v5`, complete Rules SHA-256 `a5a549b9bf2b0c1bd4835bbd9742a63629268df6f640bdb7dc8d0966fde5ef12`, 115,831 bytes. It enforces the bare-defender status exactly and tests whether the king can respond on all terminal declarations. After those and earlier checks succeed, [the linker](knight-budget.mjs) chooses one additional nonking family. A defender with pawns invokes the paired ordinary-pawn witness. A pawn-free defender invokes the knight witness. A mixed-material knight escape can therefore remain untested. A false ongoing declaration on a multi-piece terminal position can also pass.

The unrestricted combination applied both families. Even after the cheaper metadata evaluation reduced the native-conformance panel to one cost refusal, it still refused the honest fourth ply of Fool's Mate. Selecting one family restored all 37 complete historical match prefixes. In the selected policy the actual `d8h4#` accepts a correct win at 959 local expressions; an incorrect claim of continued play is also accepted. The current positive-reply contract does not adjudicate that latter case.

| Independent local panel | Matched | Incorrect allows | Incorrect refusals or budget errors |
| --- | ---: | ---: | ---: |
| 15,905 simulated full-document writes | 15,682 | 223 | 0 |
| 492 simulated knight challenges, included above | 444 | 48 | 0 |
| 9,587 simulated history writes and alternate proposals | 9,584 | 3 | 0 |

All 48 residual knight-panel mismatches declare continued play when the native position has ended. The scope choice repaired one previously refused legal move on the 15,905-input panel and admitted four false claims that the unrestricted combination had caught. Compared with the paired-pawn-only control, the selected joint candidate had 138 more matching verdicts on that panel. The native and complete local scores are recorded separately from hosted observations. [Digests and exact test results](knight-score.json)
