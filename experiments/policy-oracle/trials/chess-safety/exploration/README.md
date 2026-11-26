# Counterexample discovery

The [2,481-case corpus](v1/freeze.json) adds color and file reflections, sparse and dense blockers, and deterministic legal moves from 24 opening traces. Each row carries exact native successor FEN, legal reply count and reply digest. Native truth was frozen before evaluating Rules at `f1267ef8e`. Generated mirrors preserve castling geometry and pawn direction. The 941 trace moves come from legal play. The synthetic positions satisfy material, king, castling-right and en-passant consistency checks. Their reachability from the standard opening is unproven.

The [terminal corpus](replies-v1/freeze.json) has 189 legal transitions ending on boards with four to six pieces. For each transition the submitted status and winner vary on otherwise identical requests, producing 378 cases. The native answer stores the exact legal replies. The finite sample includes positions where a nonking move is the only reply and stalemates with a pinned defender. It was frozen at `8c976bd08`.

The [rights corpus](rights-v1/freeze.json) isolates a cost interaction missed by the first corpus. It contains 1,736 native-legal rook departures and corner captures under different starting castling rights. It was frozen at `06cc3663d`. Packed revision four accepted all 2,242 nonterminal inputs in the first corpus, then falsely refused 267 native-legal diagonal corner captures locally. Packed revision five replayed all 1,736 with zero false refusals, reaching 958 expressions on the highest-cost local write. [Revised rights score](rights-v1/packed-v5-score.json)

The [four selected native controls](rights-v1/controls/native.json) change just the prior right, holding placement and move constant. [Revision four cost evidence](rights-v1/packed-v4-score.json)

Run any freeze script without arguments to verify the frozen bytes. Run the local scoring CLI from the trial directory with the independently installed pinned referee and exact complete Rules file. It verifies all installed referee and dependency files against their vendored tarballs. Optional cohort flags select the terminal or castling-right follow-up. Production verdicts have a separate receipt for each release.

```sh
bun exploration/v1/freeze.mjs
bun exploration/replies-v1/freeze.mjs
bun exploration/rights-v1/freeze.mjs
bun exploration/v1/score.mjs "$installed_reference_package" "$complete_rules" --rights
```

For each local divergence class, the score retains the first example in corpus order and a reduced representative. The reduction repeatedly removes one piece, verifies the resulting source and rechecks both the native and compiled outcomes. It preserves the actor, origin, destination occupant, special-move rights, initial check state, king safety, legal move and write decisions, legal terminal result and any lone reply. The multi-piece terminal corpus additionally preserves the defending material, sole reply and reply family. The final witness is minimal under tested single-piece deletions.

The [promotion corpus](promotions-v1/freeze.json) has 113 pre-move positions with a quiet or capturing promotion. Each contributes all four promotion choices and two submitted results. A queen or rook promotion that leaves the opposing side with its king alone enters the same terminal proof domain as an ordinary slider move. The outcome can change when only the choice of piece changes. [Three-piece promotion witnesses](promotions-v1/controls/native.json)

The [interior-king corpus](interior-v1/freeze.json) adds 192 paired positions where the defender's king starts off the edge. It balances both colors across mate, stalemate, king-only responses, and nonking-only responses with and without check. The [rights-claim audit](rights-claims-v1/freeze.json) varies all sixteen canonical proposed castling-right masks on each of 128 legal moves. This includes corner-to-corner captures that revoke both the departing rook's right and the captured rook's right in one write.

Run all the local holdouts on complete Rules emitted by any candidate from the trial directory:

```sh
python3 exploration/replay.py --rules candidate-complete.rules --report discovery.json
```

The command uses a fresh offline install of the pinned independent referee. The summary identifies each cohort, its actual outcome counts and its decision digest. The optional report retains the first divergences and reduced examples. Add `--rebuild-native` to regenerate the frozen native evidence, `--strict` to return a failure exit code on any mismatch, or `--reference` to use an existing byte-verified install. The assembled campaign includes the additional self-check holdout when its independently frozen files are present.
