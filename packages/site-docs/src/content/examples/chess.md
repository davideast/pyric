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

Choose a piece and its destination. `e2 → e4` is allowed; `e2 → e5` is denied and leaves the board unchanged. Switch the identity to see turn ownership enforced.

Use **Play Fool's Mate** to run four allowed moves. After the final write commits, the browser tests every legal reply and reports checkmate.

## A move is a Firestore write

```text
move → proposed Firestore document → Security Rules → commit or deny → next board
```

Each game is one Firestore document. A move proposes its next state: one square is emptied, another receives the piece, the turn changes, and the move count increases.

Pyric evaluates that write against Firestore Security Rules in the browser. An allowed write changes the document and the board. A denied write changes neither.

## Keep the Rules focused on chess

```rules
rules_version = '2+modules';

import { isAuthenticated } from 'auth';
import { validSimpleMove } from 'geometry';
import { isPlaying, moveIncremented, participantsUnchanged } from 'state';
import { isMyTurn, turnFlipped } from 'turns';
```

`2+modules` is Pyric's modular Rules format. Pyric resolves its imports into ordinary version 2 Rules before evaluation or deployment.

The Standard Library modules handle checks that are useful beyond chess: authentication, participants, turns, move counts, and movement across a grid. The remaining Rules can concentrate on chess-specific behavior such as blocked paths, captures, castling, and king safety.

The board's geometry lives in a read-only Firestore document. `validSimpleMove(cfg())` uses that data to check whether a piece can travel from one square to another. This turns movement into lookups that the Rules language can evaluate.

## Stop unrelated Rules early

```rules
allow update: if request.resource.data.moveType == 'normal'
      && baseMoveChecks() && validPieceMove() && myKingSafe();

allow update: if request.resource.data.moveType == 'capture'
      && baseMoveChecks() && validPieceMove() && captureValid() && myKingSafe();
```

Firestore limits how much work a Rules evaluation may perform. Each move type starts with a different value, so only the matching branch continues into the expensive chess checks. Pyric's linter checks these limits locally instead of waiting for a deployment to expose them.

## Checkmate is a result, not a trusted claim

Security Rules decide whether a move may be stored. After an allowed move commits, the browser checks the resulting board. It reports checkmate only when the king is attacked and no legal move, capture, block, king escape, or en passant response removes the attack.

There is no client-authored `checkmate` move for the Rules to trust. The result is derived from the board that the Rules already accepted.

## Test the same boundaries before production

The local suite covers allowed and denied geometry, blocked paths, captures, pins, check, turn ownership, resignation, and checkmate. It runs against the same resolved Rules as the board.

Pyric is a development mirror, not Firebase production. Before shipping a game or any Rules-heavy application, run its important cases against a Firebase project too.
