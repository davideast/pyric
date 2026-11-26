# Compiling post-move attacks

The input is Arcade's stored 64-square map and the validated successor supplied by the move protocol. The moving seat selects the king's color. For an ordinary move and en passant, the candidate inspects the successor. For castling, it also has to establish safety on the starting and transit squares. The authenticated player supplies no king index, attack mask, or assertion of safety.

## Two representations

The first implementation specializes a pure function to each of the 64 **target squares**. On each ray, it removes empty cells in order and tests whether the first occupied square contains the relevant enemy slider. Knights, adjacent kings, and pawn diagonals are tested directly. A bounded search of the complete board locates the moving king. A trusted binding selects the appropriate compiled function. The program generator takes board dimensions and piece directions as input. [Square geometry](geometry.mjs)

The first version correctly spotted an exposed king but exhausted a local request's expression budget on legal non-king moves. The optimized square version caches move-map reads and skips scans for slider types absent from the material. Reading several rays on each of three castling squares still consumes a large part of the budget.

The second representation compiles three ideas from the same fixed geometry. [Packed policy source generator](packed.mjs)

1. Serialize files a through h in ascending rank order. A comma terminates each square. Two wall tokens separate consecutive ranks. The wall width equals the maximum horizontal reach of a knight.
2. With this padding, rays have strides 1, 9, 10 or 11 tokens. For a stride of 10, for example, an attacking rook must occur nine arbitrary tokens beyond the king, followed by zero or more additional strides whose intervening ray square is empty. Both directions count. Knight and adjacent-piece attacks need fixed offsets. The pawn offset depends on the attacker's color. Rules `matches` evaluates the generated RE2 predicate for that board.
3. Castling has three target squares. The separately compiled packer marks the transit and destination squares as additional kings on the original board, whose castle path and rights the enclosing rule validates. If one marked target blocks a slider's ray to another, the nearer target is already attacked. The moving rook cannot expose an attacker beyond its corner. The union predicate therefore detects attack on any required square. The exhaustive castling controls compare this rule to three independently constructed native positions.

The final predicate still scans the whole board. It exchanges per-square Rules expression evaluation for collection serialization and RE2 matching. Different engine behavior, regex limits, or expression counts must be measured on the release concerned.

## Package lineage and checks

The locked ordered-guard compiler supports only `size`, `toSet` and `removeAll` in a pure function. A separately reproducible candidate admits one-argument `join` and `matches` through the same pure operation check, using the existing runtime implementations and Firestore emitter. This changes the allowed pure-method names and arities. Receiver and argument validation, RE2 errors, Unicode handling, and the full-match behavior remain in the established evaluators. [Reproducible tarball transformation](pack-candidate.py) · [Method probes](qualify-methods.mjs) · [Independent local results](methods-score.json)

From the policy directory, produce the new tarball with:

```sh
python3 pack-candidate.py /tmp/pyric-rules-king-safety.tgz
```

The input digest is `c96a1f08a6808901f14e810bf31564d7f7a0c893126f99d9b8d18747e486a932`. The output digest is `78c88ce6210ca1c83e1b9b5f0d60de7e3d5d8088203cb10f3efac7b451b64ce1`. Both package source and emitted JavaScript receive the same operation-list change.

The geometry check compared the public candidate's standalone output with the frozen native engine in 48,384 single-attacker configurations, 20,608 intervening-blocker configurations and 1,428 castling configurations. These target the attack predicate with synthetic board configurations. The authored move corpora separately test complete match admission and check resulting documents. [Geometry replay](qualify-geometry.mjs) · [Results](geometry-score.json)

## Preserving the complete move contract

The application still enforces player identity, geometry, rights, en passant state, metadata and board integrity before accepting a write. The packed-v5 lowering serializes just one diagonal when testing a long diagonal move. Given endpoints on that diagonal, the public predicate skips the prefix through the first endpoint, then requires each intervening token to be empty. It also filters a canonical rights string using the king and corner squares that can remove flags. Existing noncanonical stored strings use the original canonicalization branch. [Diagonal policy generator](line-search.mjs)

The path check agrees with an independent scan in 61,408 combinations of direction, endpoints and occupancy. The full application regression exercises 150 cases under four profiles. Packed-v3, v4 and v5 each change two previous admissions in the stronger profile: moving the pinned rook and castling through attack. The remaining 598 decisions match. An additional 35 write controls test identity, turn, ply, previous state, board-key shape and protected metadata. Both authenticated seat colors and reordered board keys remain valid. [Path checks](lines-score.json) · [Four-profile matrix](matrix-score.json) · [Write controls](contract-score.json)

All these measurements use the pinned local evaluator. The live cohort qualifies only the deployed complete Rules digest and the exact signed writes in its independent receipts.
