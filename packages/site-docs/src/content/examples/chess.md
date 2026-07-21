---
title: Chess, with Security Rules as the game engine
navLabel: Chess showcase
group: Secure & debug
section: Examples
order: 95
description: Play chess against Firestore Security Rules in an isolated Pyric sandbox.
example: chess
---

The application does not decide whether a move is legal. It builds the next Firestore document and submits the write. The Security Rules decide.

Try `e2` to `e4`. Pyric commits the new board. Reset, then try `e2` to `e5`. The Rules deny the write and the board stays where it was.

The playable board handles ordinary moves, captures, and pawn moves. The Rules artifact also contains branches for promotion, en passant, castling, draw, checkmate, and resignation; inspect those branches in the source rather than treating this UI as a complete chess client.

## Why chess belongs in Security Rules

Games make every Rules problem visible at once: identity, turns, valid state changes, geometry, path blocking, captures, and data that must change together. Chess adds check detection, castling, promotion, and en passant.

The board stores 64 squares and a position field for every piece. A geometry document maps pieces and squares to possible destinations. That changes an awkward calculation into a lookup the Rules language can perform.

```text
browser move → proposed Firestore document → Security Rules → commit or deny
```

The source tabs below are not a simplified copy. They show the move builder, the complete Rules file, and the geometry data loaded by this sandbox.

## The failure that shaped Pyric's linter

The first chess implementation needed five production deploy attempts. Three failed to compile. Two compiled and then failed at runtime because several overlapping rules exhausted a shared expression budget.

The second version began with those measured limits in Pyric's linter. Each move category received a unique `moveType` gate, so unrelated branches stop immediately. It compiled on the first production deployment; its knight and pin cases passed there without another debugging cycle.

That history matters more than the board. Pyric's Rules tooling carries constraints learned from production so the next difficult Rules system does not have to rediscover them.

## What this showcase proves

The committed Rules artifact is the production-observed chess v2 source. Pyric replays all 17 scenario shapes locally: valid and invalid geometry, blocked paths, captures, pins, check, turn ownership, checkmate claims, and resignation. The earlier v1 artifact ran all 17 against production; v2's production check covered the knight and pin cases.

Pyric is still a development mirror, not Firebase production. Before shipping a game or any Rules-heavy application, run its important cases against a Firebase project too. The observations give this example provenance; they do not claim that every v2 scenario has production evidence.
