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

## Hosted compiler limits on king replies

The first cumulative source above failed Google's Rules compiler before any game write. Google reported that its four `allRefused` patterns measured 7,093–7,477 characters against a maximum of 4,096. Splitting each pattern into two preserves every regular-expression token and every other linked function. That second source, `ac1cbff2`, still failed. Its eight expressions had 243–289 groupings against Google's maximum of 100. Both failures occurred despite matching all 94 primary cases locally. The untouched Arcade Reversi module has a 5,615-byte ray lookup string consumed by `split(' ')`. This literal holds data. The diagnostic applied to regex patterns. [Source comparison](verify-regex-width.mjs)

The fixed-width variants derive a temporary character for each cell of the submitted, independently checked board. A friendly king becomes `K`, other friendly pieces become `X`, enemy pieces keep their lowercase kind, and walls retain `#`. Each alternative tests a particular attacking piece at its displacement and the empty squares required for its ray. The two adjacent-direction tests each consume their own copy of the same record. Their eight paired patterns contain four groupings each and measure 3,813–3,902 characters. The resulting source preserves the earlier signed-write contract. [Generator](direct.mjs)

| Complete variant suffix after `knight-endgame-paired-pawn-` | Whole Rules SHA-256 | Honest fourth-ply Fool’s Mate, local expression count |
| --- | --- | ---: |
| `combined-bare-projections-packed-v5` | `ef1a9a20902c228227567277e8acc8cb38936a8c64789ca16d993da2de1e5343` | 982 |
| `combined-bare-fixed-packed-v5` | `28a1783008b1d212be7a386e3db2aced79adb0a4f4b185a0b47d61a9afc673fa` | 993 |
| `combined-bare-fixed-comma-packed-v5` | `5365dc5183a2ef4d8a9af8443e4d35323fd7a4794e602c7a6fff36220a7e8380` | 987 |

The projection control uses the previous successor-board king algorithm. The fixed-width version encodes empty squares as underscores. The comma version keeps the original empty cell's comma and consumes an enemy token or a wall in one substitution. Google’s read-only compiler accepted the projection and fixed-underscore sources. Actual signed-write outcomes belong in the release-specific hosted results.
