# Bounded loops and immutable map updates in Pyric

**Design proposal.** Let policy authors write `for...of` in an opt-in Pyric extension and use a standard library function, `maps.patch(original, edits)`, to describe a new map. Authors can then express two common questions in familiar terms. Is every square on this path empty? Does the submitted board equal the result of this move? The examples below sketch the proposed syntax. The existing chess campaign supplies the reference answers.

## One board change, two uses

Consider White's en passant capture from g5 to f6. The pawn leaves g5, arrives on f6, and captures the black pawn on **f5**. Today the board policy computes those effects, the match policy scans 64 squares to discover the extra changed square, and a Firestore helper checks the captured square separately. The proposal lets all three use the same description. This example uses Arcade’s stored map keyed by square name. The current standalone board policy uses a 64-element list. [Board policy](policies/chess.policy) · [Match metadata](policies/chess-match.policy) · [Firestore special-move check](bundle/source/specialSquares.rules)

```js
const edits = [
  ["g5", ""],
  ["f6", board["g5"]],
  ["f5", ""]
];
const next = maps.patch(board, edits);
```

`maps.patch` returns a shallow copy with the edits applied in order. The last assignment to a key wins. The empty string is a stored value that represents an empty square. The standard library could implement the operation with a map copy and a loop.

```js
function patch(original, edits) {
  const result = { ...original };
  for (const [key, value] of edits) {
    result[key] = value;
  }
  return result;
}
```

Standalone Pyric can produce the next board and check the king’s safety on it. To derive Arcade’s `lastMove.extra`, compare the final and original values at the edited keys, then exclude the move’s endpoints and sort the result. Here that gives `["f5"]`. Comparing final values matters when an edit writes the existing value or two edits cancel each other.

For Firestore, the author can write `proposed.board == maps.patch(previous.board, edits)`. Firestore already has the proposed board. For three validated, distinct en passant squares, the compiler could translate that equality into the following ordinary Rules function.

```
function matchesEnPassantBoard(before, after, from, to, captured) {
  return after[from] == ''
      && after[to] == before[from]
      && after[captured] == ''
      && after.diff(before).affectedKeys().hasOnly([from, to, captured]);
}
```

The three equalities check the assigned values. The final condition catches a fourth square being changed, added or removed. With potentially coincident keys the compiler must preserve last-write-wins semantics. Move eligibility is a separate check. The live referee accepted g5 to f6 in the clear position and refused the same board change when clearing the fifth rank exposed White’s king to a rook. [Hosted en passant cases](verify/releases/referee-boundary.json)

## A familiar loop for a bounded search

```js
function pathClear(board, from, to) {
  for (const square of between(from, to)) {
    if (board[square] != "") return false;
  }
  return true;
}
```

The chess helper `between` returns the intermediate squares along a valid line and excludes both endpoints. Moving a rook from a1 to a2 checks zero squares and succeeds. Moving from a1 to a8 checks up to six, and a blocker at a7 is enough to refuse the path. Today the standalone policy searches for a blocker with `bounded.any`, and the Rules helper spells out six guarded checks. Those checks give the compiler a concrete target for *loop unrolling*. [Current path policy](policies/chess.policy) · [Six guarded Firestore checks](bundle/source/path.rules)

The original `every square in … satisfies …` proposal, JavaScript’s `.every(…)`, and CEL’s `.all(…)` all express “for every element”. Try the familiar early-return loop first. It also lets a library author implement `maps.patch` without reserving a `patch` keyword or giving chess special treatment.

## What qualifies for Firestore

Keep extension syntax in explicitly opted-in policy source. Emit a Firestore check only when the compiler can establish the iteration bound, preserve the result and error behaviour, and fit the complete linked ruleset’s evaluation budget. A bound must cover the entire input. Silently checking a prefix could accept an illegal move. When a requirement needs standalone evaluation, the compiler should name it and the full-enforcement profile should require an authoritative evaluator before commit. [Existing enforcement placement](bundle/placement/README.md)

## How to decide whether to adopt it

- Run the library call and a user-written copy of its loop against identical cases. Include empty edits, repeated keys, a write of the existing value, and a sequence that restores the original value. Check both the resulting map and the original input.
- Exercise ordinary moves, castling and en passant. For compiled checks, submit the correct board and a board with one unrelated square altered to an isolated **live Firestore** database. Read back the full board after each attempt. Exercise the rook path with zero intermediate squares and a blocker on its sixth square. Use the existing chess oracle to check legal moves and complete successors. [Campaign oracle](verify/qualified-score.json)
- Test author familiarity directly. Give fresh model authors the same rook-path and en passant tasks, equivalent documentation and the same hidden cases. Compare first-edit correctness and regressions. Use the result to decide whether a dedicated quantifier spelling earns its place.
