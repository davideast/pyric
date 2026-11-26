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
