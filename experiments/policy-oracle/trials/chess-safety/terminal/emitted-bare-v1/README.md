# Three-piece emitted helper replay

This probe asks the emitted `admittedStatus` helper whether it accepts each claim of continued play, draw or win. It extracts that function and its dependencies from one complete compiled Arcade rules file, hashes the extracted test ruleset, and submits all three claims to the pinned local evaluator. Each shard verifies the complete native answer stream before reporting its disjoint subset. The population covers both piece colors, both kings and one additional queen, rook, bishop or knight. [Native population and position hash](../table-v2/native.json)

To repeat the exhaustive run, supply the installed independent evaluator package and the exact release file. The two shard processes can run concurrently.

```sh
bun verify.mjs "$EVALUATOR" "$RULES" 0 2 > shard-0.json
bun verify.mjs "$EVALUATOR" "$RULES" 1 2 > shard-1.json
python3 summarize.py shard-0.json shard-1.json
```

The summary checks population coverage, the three claims, release identity and extracted source identity across shards. Its scores concern the helper in isolation. Linked source, authorization, per-request cost and authenticated Firestore outcomes have separate checks in the [campaign replay](../../README.md).

The [guarded-pawn source](../../artefacts/guarded-pawn-combined-bare-simple-packed-v5.rules) agreed with all 5,374,656 native status claims across 1,791,552 three-piece positions. Its two shard decision streams, native position hash and extracted source hash are retained in the [measured result](d582f74a/summary.json).

The [selected fixed-width program](../../artefacts/knight-endgame-paired-pawn-combined-bare-fixed-comma-packed-v5.rules) was tested separately. Its different extracted helper also agreed on all 5,374,656 claims, with zero runtime errors. The denominator is every eligible placement of the two kings and one additional queen, rook, bishop or knight, for either color, with the bare king to move and no castling or en passant rights. The three labels use Arcade’s shipped status convention. [Eight-shard result and exact helper identity](5365dc51/summary.json) · [Arcade outcome scope](../../../chess/README.md)
