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

## What Pyric is doing

```text
move → proposed Firestore document → Security Rules → commit or deny → next board
```

The app proposes a complete next board. Pyric evaluates that write in an isolated browser sandbox using the authenticated player, current document, geometry data, and authored Rules.

The Rules import `auth`, `geometry`, `state`, and `turns` from Pyric's Standard Library. Those modules keep common checks—authentication, turn changes, move counts, participant identity, and configured movement—out of the chess-specific code.

## Why chess is useful here

Chess puts several Rules problems on one board: identity, turns, valid state changes, blocked paths, captures, and king safety. A geometry document turns movement into lookups the Rules language can evaluate.

## The failure that shaped Pyric's linter

The first version needed five production deploy attempts. Three failed to compile. Two compiled, then exhausted a shared expression budget at runtime.

The second version began with those measured limits in Pyric's linter. Each move category has a unique `moveType` gate, so unrelated branches stop immediately. It compiled on its first production deployment; its knight and pin cases passed there.

Pyric's linter carries those production limits so another Rules system does not have to rediscover them by deploying.

## What this example proves

The modular Rules are derived from the production-observed chess v2 source. The local suite covers valid and invalid geometry, blocked paths, captures, pins, check, turn ownership, and resignation. Checkmate detection is application logic applied only after the Rules commit a move; the Rules do not accept a client-authored checkmate claim.

Pyric is still a development mirror, not Firebase production. Before shipping a game or any Rules-heavy application, run its important cases against a Firebase project too. The observations give this example provenance; they do not claim that every v2 scenario has production evidence.
