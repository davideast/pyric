---
title: Play chess against Security Rules
navLabel: Chess showcase
group: Secure & debug
section: Examples
order: 95
description: Play chess against Firestore Security Rules in an isolated Pyric sandbox.
example: chess
---

## Try the board

Choose a piece and its destination. `e2 → e4` is allowed. `e2 → e5` is denied and leaves the board unchanged. Switch the identity to see turn ownership enforced.

Choose a scenario to run a complete sequence through the Rules. Fool's Mate and Scholar's Mate end in checkmate. The opening remains in progress. The illegal pawn leap is denied without changing the board.

## A move is a Firestore write

```text
move → proposed Firestore document → Security Rules → commit or deny → next board
```

Each game is one Firestore document. A move proposes its next state: one square is emptied, another receives the piece, the turn changes, and the move count increases.

Pyric evaluates that write against Firestore Security Rules in the browser. An allowed write changes the document and the board. When the Rules deny a write, the document and board stay unchanged.

## Why the Rules look like this

Firestore Security Rules cannot loop over the pieces on a chessboard. A request also has limits on expressions, function calls, and document reads. These constraints determine how the chess Rules are structured.

Movement geometry lives in a read-only Firestore document, where the Rules can look up valid destinations and the squares between them. Check detection names each opposing piece explicitly. Each move type starts in a separate branch so unrelated checks can stop early.

## Look up the available helpers

```rules
rules_version = '2+modules';

import { isAuthenticated } from 'auth';
import { validSimpleMove } from 'geometry';
import { isPlaying, moveIncremented, participantsUnchanged } from 'state';
import { isMyTurn, turnFlipped } from 'turns';
```

Before using a helper, an agent can ask `firestore_rules_stdlib_list` and `firestore_rules_stdlib_get` for its exact name, arguments, and examples. The imports above come from that library. `firestore_resolve_modules` then turns them into ordinary version 2 Rules.

The shared helpers cover authentication, participants, turns, move counts, and movement across a grid. The functions left in this file deal with chess: blocked paths, captures, castling, and king safety.

## Route each move to one branch

Before writing the proposed game document, the board labels each available move from the piece and its destination:

| Piece and destination | `moveType` |
| --- | --- |
| Non-pawn moving to an empty square | `normal` |
| Non-pawn moving to an occupied square | `capture` |
| Pawn moving one square to an empty square | `pawn_forward` |
| Pawn moving two squares to an empty square | `double_pawn` |
| Pawn moving to an occupied square | `pawn_capture` |

The board stores the label in the proposed `/chess-v2/{gameId}` document. The matching Rules branch then checks whether the move is legal. In the Rules, `resource.data` is the current game and `request.resource.data` is that proposed next game.

The `allow update` clauses inside this match block are alternatives. Firestore allows the update when any one of them returns `true`. Because a proposed document has one `moveType`, only its matching branch can get past the first comparison.

```rules
allow update: if request.resource.data.moveType == 'normal'
      && request.resource.data.capturedPiece == ''
      && request.resource.data.status == 'playing'
      && baseMoveChecks() && validPieceMove()
      && resource.data[request.resource.data.moveTo] == ''
      && pieceMovedCorrectly() && myKingSafe();

allow update: if request.resource.data.moveType == 'capture'
      && request.resource.data.capturedPiece != ''
      && request.resource.data.status == 'playing'
      && baseMoveChecks() && validPieceMove()
      && captureValid() && pieceMovedCorrectly() && myKingSafe();
```

The `normal` branch requires an empty destination and no captured piece. The `capture` branch requires a captured piece, and `captureValid()` checks that the proposed document removes it. Both branches check the player and turn, the piece's movement, the changed board fields, and king safety. Pawn moves have separate branches.

The first comparison in each branch is deliberately cheap. A capture skips the normal-move checks, and a normal move skips the capture checks. `firestore_lint_rules` warns the agent when branches share a gate and may waste the evaluation budget, as well as when a branch calls too many functions or reads too many documents.

## Derive checkmate from the board

Security Rules decide whether a move may be stored. After an allowed move commits, the browser checks the resulting board. It reports checkmate only when the king is attacked and no legal move, capture, block, king escape, or en passant response removes the attack.

The write contains the move and the next board state. After it commits, the browser derives checkmate from that board.

## Test specific moves

After changing the Rules, the agent uses `firestore_simulate_rules` to try specific moves with a player and a board state. Stateful sandbox sessions run longer sequences. If a move is denied unexpectedly, `sandbox_inspect` shows the request, identity, active Rules, and denial.

The local suite covers allowed and denied geometry, blocked paths, captures, pins, check, turn ownership, resignation, and checkmate. It also checks that a rejected move leaves the Firestore document unchanged.

These checks happen in Pyric's local development mirror. Important cases also run against a Firebase project before shipping.
