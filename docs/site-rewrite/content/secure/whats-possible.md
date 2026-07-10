---
title: Case studies in pure security rules
navLabel: Case studies
outcome: See working, deployed rulesets that enforce chess, checkers, connect four, and US tax math, built from the patterns this wing teaches.
status: draft
---

# Case studies in pure security rules

Every artifact below enforces its logic entirely in security rules. No server, no Cloud Functions. The database is the referee. Each one deployed, each one is built from the same [patterns](../secure/rules-patterns.md) and [standard library](../secure/rules-standard-library.md) this wing teaches, and each one was engineered inside the [measured limits](../secure/limits-that-bite.md).

| Case | Service | The rules enforce | The move that makes it work |
|---|---|---|---|
| Chess | Firestore | Full piece geometry, check, checkmate | Piece position tracking |
| Checkers | Firestore | Moves, jumps, captures, win state | The lookup document |
| Connect Four | Firestore | Gravity, 69 win lines, lobby lifecycle | Generated win tables |
| US tax return | Firestore | 2024 single-filer bracket math | Config-document verification |
| Tic-tac-toe | Realtime DB | Turns, board integrity, win claims | The constraint DSL |

## Chess

Rules cannot iterate, and check detection means examining every opponent piece. The answer is to stop scanning and start tracking. All thirty-two piece locations live as document fields, so check becomes sixteen targeted lookups against a config document:

```
// Is the king's square in this piece's attack table?
kingSquare in cfg.moves[board[piecePos]][piecePos]
```

Checkmate is not computed at all. The rules deny any move that leaves your own king in check, so checkmate is emergent: the state from which no legal write exists. Seventeen scenarios pass against a deployed ruleset, including a false checkmate claim, denied.

Stated plainly: castling, en passant, and promotion are written into the rules but were not among the seventeen deployed tests.

## Checkers

Where the lookup-document pattern was born. The first build hardcoded geometry into 30 KB of rules across 611 lines. The rebuild stores the same geometry as data and reads it back with one expression:

```
cfg.moves[piece][from][to] == true
```

That took the ruleset to 7 KB and 86 lines, a 77 percent reduction, with a React UI playing against it over live snapshots.

## Connect Four

The cleanest complete example. Gravity is one rule: a piece may only land on the lowest empty row of its column. Win detection is sixty-nine generated four-in-a-row lines. The lobby lifecycle, create, join, cancel, is rules too, so the whole multiplayer flow runs with no trusted server anywhere in it. Forty-plus scenarios tested against a deployed ruleset.

## The US tax return

The unlikely one. The 2024 federal single-filer brackets live in a config document: boundaries, rates, and precomputed per-bracket maximums. The client computes its own return, and the rules verify every step of the arithmetic, from the standard deduction through each of the seven brackets to the total.

A return whose math is wrong is not invalid data. It is a permission denial.

## Tic-tac-toe, live

A deployed, playable browser app on Realtime Database rules. Turn enforcement, per-cell board integrity, and win verification all live in the ruleset, so the winner field only accepts a value when the claimed winning line actually exists on the board. The ruleset is generated from a typed constraint DSL and deployed over REST.

## Why this shelf exists

None of this is a feature you will ship on Monday. It is calibration. If rules can hold chess, they can hold your role model, your state machine, your billing invariants, and the parts are the ones you already have: the [patterns](../secure/rules-patterns.md), the [standard library](../secure/rules-standard-library.md), and the [limits](../secure/limits-that-bite.md) that keep all of it deployable.
