---
title: What's possible in pure security rules
navLabel: What's possible
outcome: See working proof of how far rules go, from chess to the US tax code, all enforced in rules alone.
status: draft
---

# What's possible in pure security rules

The claims in this wing are large, so here is the shelf they stand on. Every artifact below enforces its logic entirely in security rules. No server, no Cloud Functions. The database is the referee. If you have written rules before, some of these should look impossible, and that is the point of the shelf: they exist, they deployed, and each one is built from the same [patterns](../secure/rules-patterns.md) and [standard library](../secure/rules-standard-library.md) this wing teaches.

**Chess.** Complete chess as Firestore rules, deployed to production, seventeen test scenarios passing. All six piece types with correct geometry, sliding-piece path blocking, pins, pawn captures and double moves. The detail worth pausing on is check detection, because rules cannot iterate and check requires examining every opponent piece. The answer is piece position tracking: all thirty-two piece locations are document fields, so check becomes sixteen targeted lookups against a config document, about sixty-two expressions. Checkmate is not computed at all. The rules deny any move that leaves your own king in check, so checkmate is emergent, the state from which no legal write exists, and the suite includes a false checkmate claim, denied. The boundary, stated plainly: castling, en passant, and promotion are written into the rules but were not among the seventeen production tests.

**Checkers.** Where the lookup-document pattern was born. The first build hardcoded the geometry: 30 KB of rules, 611 lines, and gate expressions to survive the evaluation budget. The rebuild stores geometry as data and reads it with `config().moves[piece][from][to]`: 7 KB, 86 lines, a 77 percent reduction. Jump-and-capture geometry, piece counters for win detection, and a React UI that plays against the deployed ruleset over live snapshots.

**Connect Four.** A placement game, and the cleanest complete example. Gravity is enforced in rules, so a piece may only land on the lowest empty row of its column. Win detection is sixty-nine code-generated four-in-a-row lines, split per player. The lobby lifecycle (create, join, cancel) is rules too, which means the whole multiplayer flow has no trusted server anywhere in it. Forty-plus scenarios tested against production.

**The US tax code.** The unlikely one. 2024 federal single-filer brackets, as Firestore rules. Bracket boundaries, rates, and precomputed per-bracket maximums live in a config document. The client computes its own return, and the rules verify every step: the standard deduction, the taxable-income arithmetic, each of the seven brackets' tax, and the total. A return whose math is wrong is not invalid data. It is a permission denial.

**Tic-tac-toe, live.** A deployed, playable browser app, this one on Realtime Database rules. Lobby, turn enforcement, per-cell board integrity, and win verification all live in the ruleset. The winner field only accepts a value when the claimed winning line actually exists on the board, so a player cannot announce a victory the board does not show. The ruleset itself is generated from a typed constraint DSL and deployed over REST.

None of this is a feature you will ship on Monday. It is calibration. If rules can hold chess, they can hold your role model, your state machine, your billing invariants. And the parts are the same ones you already have: [rules patterns](../secure/rules-patterns.md) are the techniques, [the standard library](../secure/rules-standard-library.md) is the tested pieces, and [the limits that actually bite](../secure/limits-that-bite.md) are the numbers that keep all of it deployable.
