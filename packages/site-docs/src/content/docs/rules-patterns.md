---
title: "The techniques hard rules are built from"
navLabel: "Rules patterns"
group: "Secure & debug"
section: ""
order: 14
description: "Learn the five moves that turn \"rules can't do that\" into a ruleset that deploys."
---

# The techniques hard rules are built from

The rules language cannot loop. It cannot build a map key out of strings. And it evaluates under budgets that are real but invisible. Every hard ruleset that exists anyway, chess included, is built from a small set of moves that work with those constraints instead of against them. Here they are, generalized from the game rules where they were proven against production.

## Move the logic into a document

**The problem.** Validating a transition like "a knight on b1 may reach a3 or c3" looks like it needs one hand-written OR branch per legal pair. For checkers that was 49 branches per direction per piece type. For chess, thousands.

**The move.** Store the legal transitions as data in a config document. Rules read it once with `get()` and validate with nested dynamic access:
```
function config() {
  return get(/databases/$(database)/documents/gameConfig/checkers).data;
}

function validGeometry() {
  let mf = request.resource.data.moveFrom;
  let mt = request.resource.data.moveTo;
  let piece = resource.data[mf];
  return config().moves[piece][mf][mt] == true;
}
```
Three expressions replace hundreds of branches. It works because dynamic map access is legal when the key is a stored field value (computed strings are not), and because `get()` results are cached per request, so every function sharing `config()` costs one read of the ten-read budget. A key absent from the map evaluates as a non-match, so absence is the deny. That default is the security property.

**The receipt.** Rewriting checkers from hardcoded branches to a lookup document took the ruleset from 30 KB and 611 lines to 7 KB and 86 lines, a 77 percent reduction, and removed the budget pressure the hardcoded version needed extra scaffolding to survive.

One operational note: the config document must exist before the rules go live. If it does not, `get()` returns null and every move denies.

## Block the path with data

**The problem.** Some transitions are valid only when everything between two points is clear. A rook moving a1 to e1 requires b1, c1, and d1 empty. Hardcoded, every from-to pair needs its own emptiness checks.

**The move.** Store the between-cells in the config document, where `paths[from][to]` holds a length and the cell names, then check them with short-circuit OR:
```
function pathClear() {
  let mf = request.resource.data.moveFrom;
  let mt = request.resource.data.moveTo;
  let path = config().paths[mf][mt];
  return (path.len < 1 || resource.data[path.c0] == '')
      && (path.len < 2 || resource.data[path.c1] == '')
      && (path.len < 3 || resource.data[path.c2] == '');
      // ...continue to c5 for the longest path on an 8x8 board
}
```
`path.len < 2` is true for short paths, so the check skips cells the path does not have. The discovery that makes this expressible at all: a value retrieved from `get()` can be used as a dynamic key into `resource.data`. That one fact was probed and confirmed against production, and it is what sliding pieces stand on.

## Look up by type, don't branch by type

**The problem.** Chess has twelve piece types that move differently. Twelve validation functions, each with its own branch lists, is more code than the compiler will accept.

**The move.** Read the type from pre-write state and make it the first key of the lookup. In `config().moves[piece][from][to]`, `piece` is `resource.data[moveFrom]`. One function covers every type.

The load-bearing detail is which side of the write the type comes from. The client declares where the piece moves. The rules read what piece sits there from `resource.data`, the existing board the client does not control. A client cannot claim a pawn moved like a queen, because the pawn's identity was never in its hands.

## Give every rule a unique first expression

**The problem.** Firestore evaluates the allow rules of a match block in order, against a shared per-request expression budget. When several rules open with the same check, the non-matching rules evaluate deep and burn the budget before the matching rule is reached. The matching rule then fails as a silent 403. This was discovered the hard way, debugging chess: pawn moves denied while every rule tested fine in isolation, and reordering the rules changed which category failed.

**The move.** Open every allow rule with a cheap discriminator that is unique to it:
```
allow update: if request.resource.data.moveType == 'pawn_forward'
  && isMyTurn() && validPawnForward(config());

allow update: if request.resource.data.moveType == 'capture'
  && isMyTurn() && validCapture(config()) && pathClear();
```
A non-matching write now fails each foreign rule in one expression. Chess ships eleven distinct `moveType` values for exactly this reason. Pyric's linter flags the violation as SHARED_GATE when two rules in a match block open with the same gate expression.

## Data over code, the pattern under the patterns

Every move above is one idea wearing different clothes. When the rules language cannot compute something, move the computation out, and make the rules verify instead.

There are three places the computation can go:

- **Into a config document, ahead of time.** Move geometry, path cells, win lines, tax bracket boundaries. A generator computes it once, and the rules look it up.
- **Into the client, verified per write.** The client declares which cell changed, and the rules verify the declaration against the board. The client claims a win, and the rules check the claimed line. Neither side trusts the other.
- **Into counter fields, kept honest by arithmetic.** Scanning a board for "no opponent pieces left" costs 64 expressions. A `guestCount` field that every capture must decrement by exactly one makes the win check a single expression: `guestCount == 0`.

The US tax example takes this the whole way. The client computes its own tax return, and the rules verify every intermediate figure against the bracket config. A return that lies about its math is a permission denial.

## And from an agent

The patterns with stable shapes ship as standard library modules an agent imports instead of re-deriving: `geometry` for the config-document lookup, `counters` for the honest arithmetic, `timing` for cooldowns. `firestore_rules_stdlib_get` serves each with its gotchas attached, and `firestore_lint_rules` catches a shared gate before it costs a debugging session. See [skills](../skills/).

## Where to go next

These techniques run up against real budgets, and the exact numbers are in [the limits that actually bite](../limits-that-bite/). To see how far the techniques reach, the finished proof is in [what's possible](../whats-possible/).
