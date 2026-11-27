# The 75 remaining local chess disagreements

On the v17 release, 75 distinct writes disagreed with native chess among 15,905 frozen proposals. I replayed all eleven cohorts and checked each cohort’s verdict-and-cost digest. Of the 75, 71 are false approvals and four are legal writes refused at the local evaluator’s 1,000-expression limit. The separate 242-write live Firestore suite passed. The evidence for the 75 comes from the local evaluator. [Complete case list and executed status checks](review/scores/833a0fe29435df2456f0a3636aeea03dc33405f1193f22c424428efe469fdae8/residuals.json) · [Live scorecard](QUEEN-BISHOP.md)

| Mechanism seen in the complete Rules trace | Cases | What goes wrong |
| --- | ---: | --- |
| A remaining piece is taken as proof that play can continue | 54 | All 32 checkmates and 22 stalemates have zero legal replies. The material guard returns false. The fallback’s `otherDefenders` returns true and short-circuits the king-reply test. The client’s `playing` claim is admitted. |
| A terminal claim overlooks a legal sliding-piece reply | 13 | Twelve false wins and one false draw. Each has a legal bishop, rook or queen reply. The fallback’s `replyCapture` and `hasKingReply` checks both return false. One of these positions also has a knight reply. |
| A pawn test takes precedence over the only legal knight reply | 4 | Four false wins. Each defender has a pawn and knight. The fallback evaluates the pawn branch, finds no pawn reply, and skips the knight branch. The complete native reply list contains only knight moves. |
| A legal write exhausts the expression budget | 4 | Three legal continuations and one legal mate. All reach 1,000 locally despite a true status result. Budget exhaustion is measured for the whole write. These traces do not isolate a single expensive subexpression. |

Within the 54 false continuations, exactly two defending knights account for **25** (17 mates, eight stalemates). A lone defending pawn accounts for **20** (seven mates, 13 stalemates). The other nine comprise three bishop-and-rook, three two-pawn, one knight-and-pawn, one pawn-and-two-rook and one larger mixed-material position. Each roster excludes its king.

## Fix two-knight mobility next

This is the largest single defending roster behind the same bad decision. For a king with exactly two knights and no other friendly material, derive whether the king or either knight has a legal move on the successor. A knight reply must leave its own king safe. Zero legal moves means mate when the king is in check and stalemate otherwise. The change targets 25 known errors. Replay all 75 to measure the actual effect.

The smallest test that distinguishes all three results uses **three boards, only one new to the signed oracle**. I checked the existing 242 signed operands for legal successors with exactly this roster. They include a stalemate and two continuing positions, but no mate. The mate board is already frozen in the wider corpus. The two Ra8–h8 boards differ only by White’s queen on b4. [Full starting and successor FENs, both referees’ checked answers, each claim’s local verdict and existing live observations](review/scores/833a0fe29435df2456f0a3636aeea03dc33405f1193f22c424428efe469fdae8/two-knight-proposal.json)

| Frozen IDs | Move | Complete native result | Sole claim Firestore should accept |
| --- | --- | --- | --- |
| `knight-reply-121…123` | Qa5–h5 | Checkmate. Neither knight on d3 or e8 can answer the check. | `won` |
| `knight-reply-475…477` | Ra8–h8, white queen on b4 | Stalemate. The rook pins the h5 knight and the queen pins the g4 knight to the king on h4. | `draw` |
| `knight-reply-481…483` | Ra8–h8, b4 empty | Playing. Only the g4 knight can move, to e3, e5, f2, f6, h2 or h6. | `playing` |

Submit all three status claims per board. The existing oracle already has 477 and 483, both draw claims. Adding **seven claim cases** brings the suite to **249 distinct writes**. The three `playing` submissions are the minimal check of the affected branch. All nine claims also protect correct wins and draws. First capture the seven unmeasured claims under v17 on the isolated live database. The local prediction is that 121 and 475 incorrectly accept `playing`. After the fix, repeat all nine under the new digest, compare complete match readbacks and server versions, and restore deny-all. This proposal has no new live observations.

To reproduce the 75 classifications from this directory with the pinned Rules evaluator installed, run

```sh
release=833a0fe29435df2456f0a3636aeea03dc33405f1193f22c424428efe469fdae8
python3 -B ../chess-safety/exploration/v1/verify-simulator.py "$PINNED_RULES"
bun --no-install ../chess-safety/exploration/residuals-v1/measure.mjs \
  "$PINNED_RULES" "live/releases/$release/firestore.rules" \
  "review/scores/$release/wide.json" --traces
```
