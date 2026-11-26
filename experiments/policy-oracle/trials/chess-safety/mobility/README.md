# Can the defending king move?

A legal reply by the defending king proves a claimed terminal result is premature. The converse is weaker. A rook can have the only legal reply even when its king cannot move. This experiment returns a Boolean king-reply certificate for arbitrary material and uses it as one additional condition on complete Arcade move writes that claim a win or draw. It assumes the validated, canonical Arcade board alphabet.

## Inputs and prediction

The input is the successor board and the defending color. For each ordinary adjacent king step, the policy replaces the source and destination tokens in the packed board, including a captured enemy piece. A wall, friendly piece or enemy king prevents that projection. On each valid projected board it checks attacks against the moved king. Replacing the source matters when the king itself was blocking a slider. A pinned enemy piece can still attack the king. Castling can supply another king move, and any legal castle necessarily has a legal one-square step onto the transit square. The eight ordinary steps therefore suffice for the existence question.

Thirty [independently frozen positions](native.json) cover each of the eight sole directions for both colors, edges, defended and undefended captures, moving into a discovered ray, and a sole nonking reply. The [direction replay](check.mjs) validates the exact target-square set. [Public position replay](qualify-corpus.mjs) adds the earlier native game traces and tests the actual linked aggregate predicate in its own local Rules operation; full application write admission is measured separately.

## Why the implementation changed

The first implementation made eight candidate string projections and called the full attack helper on the eligible boards. The complete local write exceeded the expression limit on two correct primary mates. The second compiled the color-specific projection and check together. The third skipped three directions on a known edge rank. That helped edge kings but a separate interior-king corpus still found 30 correct terminal declarations refused on local cost.

The fourth treats the eight projections as a finite collection. An attempted projection that does not match retains an X prefix. A valid projection consumes the prefix and emits its complete hypothetical position. A semicolon separates each record. The candidate asks whether every record is invalid or contains an attack against the defending king; negating that result proves that at least one legal king reply exists. The attack expression cannot cross a record delimiter. [Grouped predicate](grouped.mjs)

The grouped predicate matched all 1,583 unique public and named positions, covering 12,664 direction decisions in its independent per-direction check. It rejected false terminal declarations when the king could escape. Across 378 edge and 384 interior multi-piece claims, all correct declarations retained their native admission, with no resource-limit or evaluation-error denials. The one-move and terminal certificates for broader material remain separate obligations. [Corpus score](corpus-score-grouped.json)

## Compiling and replaying

`pack.py` derives the experimental compiler from the pinned join/matches tarball by admitting two-argument `replace` in the pure method whitelist. Its existing Rules evaluator supplies regex and capture-template semantics. The reproducible output SHA-256 is `1d5d5efa89c8dfa11162194309c001546f1b9d8d9dfa9d5827fb37a5e1be40d7`. [Method and error checks](qualify-replace.mjs)

`compileMobility(compileFunction, {specialized:true, grouped:true, mode})` exposes `directions(board,color)` and `hasReply(board,color)`. The former evaluates the explicit projections. The latter evaluates the grouped predicate. `linkOnto` accepts a reviewed packed release, emitted module text, the pinned module resolver and the same `grouped:true` option. The optional link-time `covered` expression marks a material class already adjudicated by the caller. The linked policy reuses the validated successor text and repacks the real successor after castling.

For the standalone v5-plus-king-reply candidate, use variant `king-reply-v4`. Its complete rules digest is `4d1f3ba3f1be096457a12a8e25f9b38b754293b0af13f4c829dfd18a1ec830f7`. Local checks do not supply a hosted observation for those bytes.

## Terminal reports in the complete application

A reported win must put the defending king in check. A reported stalemate must leave it safe. `king-reply-v5` checks that condition and tests whether the king can move. It agreed with 275/378 edge declarations and 352/384 interior declarations. Every remaining disagreement was a false win in which another piece had a legal reply. All correct declarations remained admissible in those two local corpora. The complete Rules digest is `fa2cff41e46a901f826eb53c859d03486797f0687dbe1b89b16183a1510b5814`.

[The combined linker](combined.mjs) also uses the existing exact classifier for the three-piece material it covers and the defensive capture certificate outside that class. Its standalone `predict` represents moving-king safety. Whole-write admission includes the terminal and Arcade checks. A real castling successor is packed separately because the move-safety projection uses virtual kings on the transit squares.

| Variant | Complete Rules SHA-256 | Named cases | Agreement on 12,371 independent local writes | Legal moves refused at the expression limit |
| --- | --- | ---: | ---: | ---: |
| combined-quick-packed-v5 | fc20db62e7d08d1ca6984a2c3bf2a878c2a3f3af7ff47835674172575a65a349 | 94/94 | 12,150 | 94 |
| combined-pattern-packed-v5 | 60cf348c7dd8a184e81abc55b95922091cdda387856e19c021cd0658ebacf031 | 93/94 | 12,083 | 161 |
| combined-pattern-fast-packed-v5 | a53c2fedb742710fc3aa3db055741b82842382fed457c5ab781cbf7259cb851b | 94/94 | 12,182 | 62 |

All three permitted 127 incorrect terminal declarations in the independent corpus. The fast variant preserved each correct declaration tested and exceeded the local expression budget on 38 right-changing captures and 24 promotions. It skips the table for distant kings in rook, bishop and knight three-piece positions, and uses two regex substitutions to prepare the remaining search key. These figures describe local whole-write admission. `python3 pack.py --split output.tgz` reproduces the combined compiler package, SHA-256 `98995632ebf810afa49c3e03ee7fc0bac31e3c8ff841327ffa8a3eddda2a9356`.
