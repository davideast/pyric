---
title: Case studies in pure security rules
navLabel: Case studies
outcome: See working, deployed rulesets that enforce chess, checkers, connect four, and US tax math, built from the patterns this wing teaches.
status: draft
---

# Case studies in pure security rules

Every artifact below enforces its logic entirely in security rules: no server, no Cloud Functions, the database is the referee. Each one is deployed and built from the same [patterns](../secure/rules-patterns.md) and [standard library](../secure/rules-standard-library.md) this wing teaches. Each one was engineered inside the [measured limits](../secure/limits-that-bite.md) that keep it deployable.

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

Checkmate is not computed at all. The rules deny any move that leaves the king in check, so checkmate is emergent: the state from which no legal write exists. Seventeen scenarios pass against a deployed ruleset, including a false checkmate claim, denied.

Stated plainly: castling, en passant, and promotion are written into the rules but were not among the seventeen deployed tests.

## Checkers

Where the lookup-document pattern was born. The first build hardcoded geometry into 30 KB of rules across 611 lines. The rebuild stores the same geometry as data and reads it back with one expression:

```
cfg.moves[piece][from][to] == true
```

That took the ruleset to 7 KB and 86 lines, a 77 percent reduction, with a React UI playing against it over live snapshots.

## Connect Four

Gravity is one rule per column: a piece lands only on the lowest empty row. Win detection is sixty-nine generated four-in-a-row lines, not sixty-nine hand-written ones:

```rules
// Gravity for column 0: a piece lands on the lowest empty row
(nr == 0 && ob.c0r0 == '')
  || (nr == 1 && ob.c0r0 != '' && ob.c0r1 == '')
  || (nr == 2 && ob.c0r0 != '' && ob.c0r1 != '' && ob.c0r2 == '')
  || (nr == 3 && ob.c0r0 != '' && ob.c0r1 != '' && ob.c0r2 != '' && ob.c0r3 == '')
  || (nr == 4 && ob.c0r0 != '' && ob.c0r1 != '' && ob.c0r2 != '' && ob.c0r3 != '' && ob.c0r4 == '')
  || (nr == 5 && ob.c0r0 != '' && ob.c0r1 != '' && ob.c0r2 != '' && ob.c0r3 != '' && ob.c0r4 != '' && ob.c0r5 == '')

// One of 69 generated four-in-a-row lines (Red, top row)
(b.c0r0 == 'R' && b.c1r0 == 'R' && b.c2r0 == 'R' && b.c3r0 == 'R')
```

The lobby lifecycle, create, join, cancel, is rules too, and forty-plus scenarios pass against a deployed ruleset with no trusted server anywhere in the flow.

## The US tax return

The 2024 federal single-filer brackets live in a config document: boundaries, rates, and precomputed per-bracket maximums. The client computes its own return, and the rules verify every step of the arithmetic, from the standard deduction through each of the seven brackets:

```rules
function cfg() {
  return get(/databases/$(database)/documents/tax_config/2024).data;
}

function verifyB1(ret, config) {
  return ret.taxableIncome > config.b1Max
    ? ret.b1Tax == config.b1Tax
    : ret.b1Tax == ret.taxableIncome * config.b1Rate / 100;
}
```

A return whose math is wrong is not invalid data. It is a permission denial, and twenty-seven scenarios prove it against the ruleset in the sandbox.

## Tic-tac-toe, live

A deployed, playable browser app runs entirely on Realtime Database rules. Turn enforcement, per-cell board integrity, and win verification all live in the ruleset:

```ts
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

'/xWins': { validate: winCheckHelper('X', LINES) },
'/oWins': { validate: winCheckHelper('O', LINES) },
```

The winner field only accepts a value when the claimed line actually exists on the board. The ruleset is generated from these typed constraints ([RTDB rules in TypeScript](../secure/rtdb-rules-in-typescript.md)) and deployed over REST.

## Rules that hold chess hold state machines and billing

None of this is a feature you will ship on Monday. It is calibration: if rules can hold chess, they can hold a role model, a state machine, billing invariants. The parts are the same ones covered on this wing: the [patterns](../secure/rules-patterns.md), the [standard library](../secure/rules-standard-library.md), and the [limits](../secure/limits-that-bite.md) that keep all of it deployable.
