# Chess showcase provenance

- Source: `firebase-agent-sdk/examples/chess/chess-v2.rules`, adapted to import Pyric's `auth`, `geometry`, `state`, and `turns` Standard Library modules
- Source config: `firebase-agent-sdk/examples/chess/chess-v2-config.json`
- Production observation: chess v1 passed all 17 scenarios after the unique `moveType` gates were introduced. The rebuilt v2 artifact was then deployed and its knight-move and pin-detection cases passed against Firestore on the first attempt.
- Original Rules SHA-256: `45aea8a5ef6548dbfc56392214c4d86867543c840f52f281b92359fc5956937f`
- Config SHA-256: `d142ae08855591a539899bc6c649f83d22cb7f20cd58d25ef61f1b92fd82f5bf`

The original checkmate branch accepted any check as checkmate, so this adaptation removes that branch. The example now detects checkmate from the committed board by proving that the checked player has no legal reply. This does not turn the broader v1 run or the two v2 production checks into a new conformance claim; it records exactly which evidence belongs to each artifact.

## Corrections verified against production

On 2026-09-27 the resolved Rules were run through the Firestore Rules Test API, with the committed configuration supplied as a mock of the `gameConfig/chessv2` read. Each case below uses a board with only the pieces it needs. The Pyric simulator returned the same decision as production for every one of these cases.

| Rules behavior | Before | After |
| --- | --- | --- |
| Creating a game with the starting board | Denied. The `allow create` condition read an unbound `d`, which production reports as `Invalid variable name: d.` and fails at evaluation. | Allowed. `isStartingBoard()` binds `d` to `request.resource.data`. A board that differs from the starting position is denied. |
| A rook, bishop or queen seven squares from the king, blocked only on the sixth square between them | Treated as check, so every move of the checked side was denied. The scan read five of the six path squares. | Not check. The scan reads all six path squares. A clear seven-square line is still check. |
| A move after a pawn has promoted | Denied for the opponent. The pawn scan looked up `pawnAttacks` for the promoted piece, which has no entry, and the lookup failed. | Allowed when the promoted piece gives no check. A promoted piece attacks as a knight, bishop, rook or queen. |
| Promotion by capture | Denied. `validPromotion()` and `pieceMovedCorrectly()` accepted only the `promotion` move type. | Allowed. |
| Promotion on another rank, and a pawn that reaches the last rank without promoting | Allowed. The promotion rank test compared square names as strings, so a square such as `e3` passed. The pawn move branches did not reject the last rank. | Denied. |

The showcase scenarios were also replayed move by move through production. Before the corrections, production denied the final move of Fool's Mate because the request reached the expression limit described under Known gaps. After the corrections, production allowed or denied every move in the six scenarios as each scenario expects.

## Known gaps

- Castling checks only the square the write records as the king's new position. A king may castle out of check or through an attacked square, and the write does not have to move the rook. Checking the two extra squares repeats the check scan. In a measured attempt, that took a castling write on a developed board above production's limit of 1,000 evaluated expressions.
- A move branch checks the squares the move touches. It does not reject a write that also changes other squares.
- Production stops a request after 1,000 evaluated expressions and denies it. A long-range move on a developed board can reach that limit, for example `c8 → g4` after `e2 → e4, e7 → e5, g1 → f3, b8 → c6, f1 → c4, f8 → c5, d2 → d3, g8 → f6, c1 → g5, d7 → d6, b1 → c3`. The Pyric sandbox allows that move.
