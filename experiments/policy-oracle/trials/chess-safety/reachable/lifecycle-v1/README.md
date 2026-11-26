# Consecutive match documents

The 37 archived traces contain 1,553 recorded moves. For 34 traces, the host creates an ordinary opening match with a server timestamp, the guest joins, and the player on turn submits each move. Three traces begin from explicitly supplied chess positions. Their stored documents become continuous from that seed. Every transition carries forward the previous board, counters, castling rights, en-passant target, last move and player identities. [Native per-trace freeze](freeze.json)

The public python-chess archive supplies each move and board. Arcade and a separately executed standalone policy reconstruct every complete match document. An additional Python program independently reconstructs the documents, outgoing writes and rejected alternatives using python-chess. The two implementations reproduce the same combined SHA-256 for all 37 histories. [Independent receipt](python-chess.json)

Run from this directory with the installed independent evaluator and the candidate's complete Rules.

```sh
bun freeze.mjs
bun measure.mjs "$PINNED_REFERENCE" "$COMPLETE_RULES" > measured.json
python3 summary.py measured.json
python3 check.py "$CHESS_ARCHIVE"
```

Each negative probe starts from the exact document before a canonical write. It changes the actor, ply, previous board, capture result or reported terminal status. A falsely accepted claim opens a separate branch. The first example of each such claim per trace attempts the next honest move against that corrupted stored head. The honest line continues independently. If a canonical legal write is refused, its prefix ends there. The scorer labels subsequent requests from reconstructed canonical heads as resynchronized. The stored document in this local evaluator is modeled in memory. Hosted readback requires an authenticated SDK receipt. [Per-candidate summaries](scores/)

The public lines finish with one checkmate, one stalemate and 35 positions still in play. The negative probes include 170 cases that restore a captured piece. These lines contain no en-passant capture or actual castle. Dedicated cohorts cover those transitions. [En-passant windows](../../exploration/en-passant-evasions-v1/) · [Castling](../../batches/05-castling/)

On the standard opening, the input-only live plan submits White's g2–g4 declaring a draw. A refusal triggers an honest retry on the same match. Black then submits a7–a6. The local replay records every verdict and the complete modeled head digest after each attempt. [Input-only plan](opening-plan.json) · [Unguarded result](opening-bare.json) · [Guarded result](opening-guarded.json)
