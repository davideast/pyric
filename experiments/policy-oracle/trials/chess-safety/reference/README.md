# Native answers and mutation controls

Each versioned batch holds three separate records. `positions.json` specifies SDK inputs. `native.json` records independent Arcade decisions about those inputs. `mutations.json` reports how the suite distinguishes faulty programs. The capture adapter reads positions without opening either answer file.

The native checker pins Arcade's original TypeScript chess engine and the earlier standalone Pyric chess module. It compares the exact legal move list in the source position, the moving king's check status, and the full applied position and exact replies for every legal move. FEN here records piece placement, turn, rights and en passant. The match ceremony and complete SDK fields, including seat, prior board, rights, turn and last-move metadata, use the existing Arcade document adapter. The final authority on a submitted write is `nativeAdmission`, which requires a legal move and the correct claimed result and winner. `kingSafe` also checks the departure and intermediate squares on castling.

On an illegal move, native `applyMove` can still construct the exact hypothetical board a client tries to write. Standalone `apply` must refuse it. Its check status on the constructed board is recorded independently. For these impossible states the two engines may assign different answers to a subsequent terminal query. The discovery corpus retains both answers for the two occurrences it found. Neither creates a legal successor or supplies a Firestore observation.

The [mutation runner](mutations.mjs) applies one reviewed source-location change at a time to the pinned native engine, reruns each changed executable and records every mismatch. Terminal sensitivity also checks the behavior of accepting a declared result for any legal move. For example, immobilizing every pinned piece rejects a legal slide along the pin. Asking whether the opposing side can legally capture the king accepts a destination defended by a pinned knight. A terminal check that searches only king moves misses the one surviving rook reply. [Primary pin mutations](../batches/01-rank-diagonal/v1/mutations.json) · [Destination mutations](../batches/02-king-destinations/v1/mutations.json) · [Terminal mutations](../batches/07-terminal/v1/mutations.json)

To regenerate one batch from the trial directory:

```sh
bun reference/native.mjs batches/01-rank-diagonal/v1/positions.json
bun reference/mutations.mjs 01-rank-diagonal
```
