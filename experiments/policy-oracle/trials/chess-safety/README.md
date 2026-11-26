# Scoring a compiler on chess king safety

Submit the same rook move on two boards. When the rook is the last blocker between its king and an enemy slider, the move exposes the king. Give it a second blocker and the same move is legal. The oracle tests that distinction, legal moves along the pin, king destinations, escapes from check, en passant, castling, and claims about the resulting game. Each case records the starting board, player, proposed move and full successor. [Frozen batches](batches/) · [Native checker and mutation controls](reference/README.md)

From this directory, run the archived experiment offline with one command.

```sh
python3 replay.py
```

The command rebuilds the reference compiler from pinned local archives, checks the native answers and mutation controls, invokes the compiler in isolation, evaluates the complete linked Arcade ruleset, scores the discovery and historical corpora, and replays the completed Firestore receipts. Use `--archive /absolute/private/captures` to authenticate those receipts against the original private journals. Each release has independent results. A digest with no completed signed capture appears as `unmeasured`. [Hosted measurement protocol](live/README.md)

To score another compiler through its public `@pyric/rules/experimental/policy` API, supply `--candidate-package /absolute/candidate.tgz`. Use `--variant` to select the source program. `quick-packed-v5` requires pure `split`, `join` and `matches`. `combined-pattern-fast-packed-v5` adds `replace`. A compiler that supports neither representation can still be scored on the simpler `pins` source. The separate `standaloneBoard` column requires `compileBoundedModule`. The linked evaluator uses a different package from the candidate, and only its emitted text crosses that boundary. [Compiler policies](policy/README.md) · [General king-reply programs](mobility/README.md)

The standalone safety score concerns the moving king. A blocked slide can score safe for that king while the full move is illegal. The standalone board score checks move legality, exact successor and submitted status. The linked write score covers the entire request. A local expression-limit refusal of a legal move counts as a false refusal, and its diagnostic remains visible. A denial of an illegal move due to an evaluation error earns no agreement credit. The normal replay reports known disagreements. Supplying a candidate makes the exit status reflect its score.

Seven native claims have independent, versioned leaves in the [Arcade chess registry](../../suites/arcade/chess/claims/). The generic registry tests an evaluator on archived emitted bytes. The trial command above also runs the candidate compiler. [Registration and exact SDK bindings](registry/leaves.py) · [Discovery cases and scope](exploration/README.md) · [Historical legal successor freeze](reachable/v1/freeze.json)
