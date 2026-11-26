# Playing Arcade chess with Pyric

This experiment makes a move from the last stored position. The player selects two squares and, for promotion, a piece. The Arcade browser sends the UCI move and the move count it displayed. The referee authenticates the player, reads that version of the match, and evaluates two authored Pyric modules. An accepted move commits only against the Firestore document version that was read. A stale submission receives a named refusal.

The [board policy](policies/chess.policy) derives legal moves, board changes, rights, check, checkmate and stalemate. The [match policy](policies/chess-match.policy) derives admission, next seat, count, stored last move and result. The adapter translates squares between Arcade's Firestore map and the policy's 64-entry array. The native Arcade engine supplies the independent expected update during the browser replay.

The source of the qualified compiler is on `experiment/chess-policy-engine` at `7edfec782d7d7a9b4a4bb40eb3a879118dda1cae`. Both policies opt into the bounded standalone language explicitly. The packed release also emits importable Rules helpers through its existing compiler entry point. The [release lock](policies/lock.json) pins the compiler tarball and both portable modules.

The chess policies also motivated a [design proposal for bounded loops and immutable map updates](bounded-loops-and-map-updates.md).

## Verified game and rematch

Two independently authenticated Chromium players played **1. f3 e5 2. g4 Qh4#** on the isolated live Firestore database. White offered the rematch, Black joined, White played **e4** and Black resigned. Separate endgame fixtures reached stalemate and promoted a pawn to a knight through the rendered selector. Pyric and the native Arcade control agreed on all seven played board transitions. The corrected client passed all 16 per-seat replay checks with an empty illegal-move warning list. The original client flagged all 16 observations on the same documents. [Verified browser receipt](verify/releases/referee.json) · [Original false warning](verify/diagnostics/first-checkmate.png) · [Corrected checkmate](verify/screens/4dd266ebce15bfeca187bdf59962a9f23dbb63d84fe419334d38e42c064e8a6d/checkmate.png) · [Rematch result](verify/screens/4dd266ebce15bfeca187bdf59962a9f23dbb63d84fe419334d38e42c064e8a6d/rematch-resignation.png)

In a separate contention fixture, the two submissions read the same stored document version, then each attempted a real conditional commit. The winner stored one move. The losing request returned `matchVersion`. A pinned rook that would expose its king returned `legalMove` before the commit, with every field and the server version unchanged. [Referee verification](verify/releases/referee.json)

The [two-game PGN](verify/matches.pgn) replays to the stored terminal positions. It records checkmate on the board in game one and Black's resignation after White's opening move in game two.

Across the public and sealed positions, the locked board policy agreed with the independent chess reference on all 3,184 position checks and 3,473 complete successors. The match policy also passed 13,892 admission checks on those successors. The public oracle records the first differing position and move when a candidate changes the answer. [Board score](reference/scores/97dda7add77cb18d132ba1c730bbef24a48870404198d6677cdf0f961a30d212.json) · [Match score](reference/scores/97dda7add77cb18d132ba1c730bbef24a48870404198d6677cdf0f961a30d212-metadata.json)

## Live Firestore results

Eight completed captures exercised four releases on the same isolated live Firestore database. Each row below combines the primary capture with its supplement.

| Deployed release | Allowed | Refused | What was exercised |
|---|---:|---:|---|
| Stock Arcade | 21 | 18 | Original match, move and rematch rules |
| Generated compatibility | 21 | 18 | Same 39 inputs as stock, same verdicts and complete stored documents |
| Stronger Firestore rules | 21 | 28 | Ordinary and special moves, geometry, clearance, rights and match protocol |
| Authoritative Pyric referee | 6 | 27 | 26 direct SDK writes and 7 HTTP move submissions |

The 160 cases include 153 direct SDK write attempts. The other seven went through the referee. It accepted a legal castle and en passant, refused both when they exposed the king, and distinguished a signed-out request, the wrong seat and a stale ply. Firestore also refused an occupied-seat join, a resignation naming the wrong winner, and a rematch offer on an unfinished game. The browser games and same-version race have separate records. [Enforcement and evidence for each requirement](bundle/placement/coverage.md) · [Final boundary receipt](verify/releases/referee-boundary.json)

All 91 refused cases preserved the complete observed documents and their server versions. Offline replay reproduced the 160 decisions, 368 read checks and 11 additional gameplay and race records. [Complete qualification score](verify/qualified-score.json) · [Release receipts](verify/releases) · [Hosted verification and replay](verify/README.md)

After each qualified capture, the controller restored the pinned deny-all release and verified signed read and write refusals before releasing its lease. A management API rate limit and a later interrupted capture required separate recoveries during development. Both recoveries verified the original lease and confirmed closure. The scored set consists of completed and independently verified captures.

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

An earlier browser capture displayed an illegal-move warning for correct boards. The original Arcade client compared serialized maps, so identical squares in different key orders produced different replay verdicts. The playable client compares complete square sets and values, and the browser driver reads the actual warning list on both seats. Run `bun playable/verify-map-order.mjs /new/build/directory` to exercise the original and corrected replay on a reordered board and three altered boards. The matching upstream-ready Arcade fix is on the local branch `fix/chess-replay-board-map-order` at `a546c20f6c922d84f8f63ef78dbdd33ca3b87e4a`.

The [authenticated capture driver](live/qualify.py) uses a private operator archive and the single lease on the isolated named live Firestore database. Supply the archive, browser build directory, board module and desired profiles. Chromium runs in two independent browser contexts. Set `CHESS_PLAYWRIGHT` to the Playwright ES module when it is installed outside this checkout. Full receipts are admissible after the original journal verifies the deployed release, complete state readbacks and final deny-all restoration. [Hosted evidence verification](verify/README.md)

This release covers the outcomes shipped by Arcade. A tournament-rules profile with repetition, time controls, move-count draws or dead-position adjudication would need a separate state contract.
