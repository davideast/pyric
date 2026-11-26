# Playing Arcade chess with Pyric

This experiment makes a move from the last stored position. The player selects two squares and, for promotion, a piece. The Arcade browser sends the UCI move and the move count it displayed. The referee authenticates the player, reads that version of the match, and evaluates two authored Pyric modules. An accepted move commits only against the Firestore document version that was read. A stale submission receives a named refusal.

The [board policy](policies/chess.policy) derives legal moves, board changes, rights, check, checkmate and stalemate. The [match policy](policies/chess-match.policy) derives admission, next seat, count, stored last move and result. The adapter translates squares between Arcade's Firestore map and the policy's 64-entry array. The native Arcade engine supplies the independent expected update during the browser replay.

## Enforcement

| Complete linked release | Contract |
|---|---|
| Stock | Pinned Arcade rules and deployment reference. |
| Compatibility | The packed compiler emits replacements for the castling metadata and previous-position predicates. Arcade's ordinary Rules continue to govern the remaining writes. |
| Stronger | Adds piece geometry, path clearance, promotion, rights, en passant and special-move board updates in Firestore. The expensive legal-reply and attack searches run in standalone Pyric. |
| Referee | Firestore governs reads, lobby, cancellation, resignation and rematches. It refuses direct player move writes. The authenticated referee derives the move and uses Firestore's version precondition to persist it. |

The [placement gate](bundle/placement/README.md) names each requirement and binding. Six requirements in the stronger profile use standalone evaluation in the full referee profile. They concern attacks on the king, attacked castling squares, en passant exposing the king, available legal replies, checkmate and stalemate. The sampled peak of 965 expressions is a local estimate on the tested inputs. The hosted observations establish concrete accepted and refused writes for the exact deployed bundles. [Bundle construction and measurements](bundle/README.md)

## Reproduce

From this directory, run the following commands. They install the packed compiler offline, regenerate and hash both portable ES modules, and compare the locked candidate with the independent public positions and turn traces.

```sh
python3 policies/reproduce.py
bun reference/score.mjs policies/chess.mjs reference/public.json.gz
python3 bundle/placement/check.py referee bundle/artifacts/referee.rules policies/chess.mjs policies/chess-match.mjs policies/lock.json --require-complete
```

For the full public hill-climbing loop, run `bun verify/replay.mjs` after preparing the oracle runtime via `python3 ../../core/oracle.py --all`. Pass a candidate policy directory and candidate rules directory to score a new build against the same frozen evidence. The reference suite compares exact legal move lists, the complete successor and the adjudicated outcome. It includes per-opening-move counts, fixed scripts, seeded games, promotions of both colors, pins, castling and en passant. The independent verifier sealed an additional corpus before candidate development. [Reference scoring](reference/README.md)

Run `python3 bundle/reproduce.py --arcade /path/to/pinned/arcade` to regenerate all nine Firestore artifacts from the same packed compiler and check all 600 local decisions. An offline score can run repeatedly between live captures.

To build the browser, run `python3 playable/prepare.py /path/to/pinned/arcade /new/build/directory --engine policies/chess.mjs`. It installs the frozen Arcade dependencies and builds the actual Phaser client with the policy adapter. The referee serves that build on loopback during a live qualification. The original Arcade checkout is untouched.

The [authenticated capture driver](live/qualify.py) uses a private operator archive and the single lease on the isolated named live Firestore database. Supply the archive, browser build directory, board module and desired profiles. Chromium runs in two independent browser contexts. Set `CHESS_PLAYWRIGHT` to the Playwright ES module when it is installed outside this checkout. Full receipts are admissible after the original journal verifies the deployed release, complete state readbacks and final deny-all restoration. [Hosted evidence verification](verify/README.md)

This release covers the outcomes shipped by Arcade. A tournament-rules profile with repetition, time controls, move-count draws or dead-position adjudication would need a separate state contract.
