# Arcade chess reference and locked-candidate score

The referee is the chess 1.11.2 source distribution from PyPI. It runs separately from Arcade and Pyric. The generator verifies the source archive's SHA-256 before loading the standalone core. The retained observations cover the Arcade result vocabulary of playing, checkmate and stalemate. The oracle always retains the skipped square after a double pawn move, even if a capture there is unavailable. [Pinned referee release](https://pypi.org/project/chess/1.11.2/)

Each scored snapshot compares the complete sorted list of legal UCI moves and the outcome. Named cases compare the full successor for every legal move. Traces replay from their initial position using the candidate's own returned state until the first mismatch, then report any subsequent isolated discrepancies. Every successor check compares board size, all 64 squares, turn, castling rights and en passant. The scorer also verifies the input position remains unchanged. A divergence names the case, ply, FEN and differing move or field. The public corpus and raw division counts are retained alongside the code. [Branch counts by position, depth and root move](divides.json)

The 32 public and 32 sealed xorshift32 seeds each run for up to 48 plies, stopping at an empty legal move set. The public suite adds 21 named positions and 5 scripted traces, including a game ending in checkmate, a move producing stalemate, en passant expiry and a rook's round trip. The sealed inputs add 5 named positions. The verifier recorded their input digest before candidate inspection and retained the inputs and compressed expected answers privately. POSIX file permissions and a separate worktree provide operational separation. The digest identifies the release. A future campaign can draw a fresh holdout after disclosing any sealed case.

## Replay

From this directory, Bun can replay the frozen independent answers without Python, Firebase or internet access. The native reference copy is the byte-identical Arcade source from commit `66e14d4f4b0aeab22c05db8d748704dde053d2e5`, path `games/chess/src/chess.ts`, Git blob `a3d1e91d7d6989f7a40a31906caf954d3b53517e`.

```sh
bun score.mjs ./native.mjs public.json.gz
bun score.mjs /absolute/path/to/chess.mjs public.json.gz
bun sensitivity.mjs
```

For a locked candidate the verifier also passes the private, digest-pinned corpus. The scoring command exits nonzero on any discrepancy. The optional `--skip-divides` flag speeds up public development and is recorded in the report. The qualifying release includes divides.

```sh
archive="$HOME/.local/state/pyric/oracle/chess-referee-34808f9b"
bun score.mjs /absolute/path/to/chess.mjs public.json.gz "$archive/holdout.json.gz"
```

To regenerate the reference from retained inputs and independently maintained code, run the following commands. The generator checks the archive digest, validates the initial chess positions, and checks the scripted terminal outcomes. Reproduction uses the same gzip implementation as the original generator when comparing byte hashes.

```sh
python3 generate.py "$archive/chess-1.11.2.tar.gz" public.json /tmp/chess-public.json.gz
python3 generate.py "$archive/chess-1.11.2.tar.gz" "$archive/holdout-v1.json" /tmp/chess-held-out.json.gz
cmp public.json.gz /tmp/chess-public.json.gz
cmp "$archive/holdout.json.gz" /tmp/chess-held-out.json.gz
```

## Evidence

The complete native score has 3,184 snapshots and 3,473 complete successor checks. Five initial positions contributed 416 root counts across depths and 369,801 legal continuations when counting only the deepest level of each position. Seven altered implementations each produced a first divergence. Their changes cover turn, sliding range, rook rights, en passant expiry, promotion, pinned pieces and terminal classification. A separate claim in the oracle registry captures exact legal move sets and results for the 21 public named positions. Its default replay compares Arcade's pinned native implementation against the independent observations. Set `ARCADE_CHESS_CANDIDATE` to an absolute engine path to score another implementation on that claim. The full-match protocol, mutation of rematch behavior and hosted Firestore decisions have their own evidence outside this chess-engine comparison. [Native score](native-score.json) · [Mutation details](sensitivity.json)

The placement under `scores/` names the exact generated module hash for each locked submission. The metadata score additionally exercises the emitted match policy's field derivation and admission decisions for the same 3,473 successor cases. For named child positions the independently frozen full board is adjudicated with the pinned Arcade engine. Every traced result is frozen directly by python-chess. Replay with the referee's sealed path as an optional second corpus.

```sh
bun score-metadata.mjs /absolute/path/to/chess.mjs /absolute/path/to/chess-match.mjs public.json.gz
```
