# Compiling sliding replies

The source in this directory generates pure Pyric functions, compiles each through the installed `@pyric/rules/experimental/policy` entry point, and links the exported helpers into the pinned full Arcade ruleset. The compiler receives ordinary policy source. Its inputs and the board geometry generator contain no FENs, expected moves or oracle verdicts.

```sh
bun emit.mjs /absolute/path/to/installed/@pyric/rules /tmp/arcade.rules all-paired-records-v16
```

The scorer compiles the same functions in a separate worker and performs its own link. The standalone witness and the actual write both derive the defender, source and destination from the post-move position. A successful numeric witness is `origin * 80 + destination`. Each rank has eight squares and two boundary markers. Thus c5 is 42, c8 is 72, and c5c8 is 3432. A result of -1 means this material policy found no legal sliding reply. A king or a knight may still have a legal move.

## The signed geometry

A checking rook, bishop or queen defines a line through the king. Write the line as `a*x + b*y = c`, let `d` be its signed distance numerator at the defending slider, and choose a permitted slider direction `v`. The only possible intersection is `n = d / (a*vx + b*vy)` steps from the slider. Reject fractional and off-board intersections. When the source is already on the checking line, the slider can try capturing the first opposing piece on each permitted collinear ray. A knight or pawn check requires a capture by the slider. In a quiet position, testing the nearest legal step on each ray suffices for existence. A longer legal move traverses the nearest square, and any pin it resolves requires the slider to stay on that same king-attacker line.

The generator precomputes a small set of regular-expression recipes for those geometric possibilities. The live Pyric policy derives the distance from the board, selects the recipe and projects all eligible moves in a batch. Each record is a separate board. An unsuccessful projection retains the source marker. A successful projection empties the source and marks the destination. The final filter removes every successor still exposing the defending king, including discovered and double checks. The returned witness identifies the first surviving successor. Multiple legal replies can produce more than one correct witness. When the defender has two rooks, the solver searches each source in turn and keeps the other rook on the board as a blocker. Revision 16 computes the king position once for that pair.

`slideProject` is one of the pure functions the public compiler emits. Its inputs include the normalized board, piece kind, board-derived geometric recipe, the defender's attack pattern and the origin computed from that board.

```
function slideProject(board, kind, recipe, rejected, origin) {
  let labels = kind == 'r' ? 'ABCD' : kind == 'b' ? 'EFGH' : 'ABCDEFGH';
  let originals = labels.replace('([A-H])', '$1,X' + board + ';');
  let first = originals.replace(recipe[0], recipe[1])
    .replace(rejected, '').split(';')[0];
  return first == '' ? -1 : origin * 80 + first.replace('X.*', '').size();
}
```

The Rules binder chooses the geometry function, supplies the checked post-move board, and integrates the verdict with authentication, turn, move shape and stored-state validation. The experiment uses a specialized chess lowering. A general-purpose module compiler would also need to accept and link calls between authored policy functions directly.

## Material scope

The guarded solver accepts these defending rosters, each with its king.

- One rook, bishop or queen.
- One such slider and one knight, or two rooks.
- One such slider and one pawn when there is no opposing pawn.
- A lone knight.

The statement assumes valid Arcade chess positions. Both colors may defend and the attacker may have multiple pieces. Excluding opposing pawns in the friendly-pawn case rules out an en passant escape. A legal standard castle already implies an ordinary legal step to the king's transit square. A mate or stalemate verdict in this scope considers king, slider, knight and pawn defenses as applicable. The inherited full Arcade evaluation remains the fallback outside this guard. Additional optional scorer policies declare their own scope.

## Independent checks

`checks/board-shape.mjs` tests 97 complete writes across normal sliders, both sides of castling for each color, and en passant for each color. It covers missing and extra keys on each participating square and compares the chosen release with the inherited ruleset. `checks/king-projection.mjs` extracts the compiled, adjacent-king predicates from the emitted bytes and evaluates them against separately frozen native replies.

```sh
bun checks/board-shape.mjs "$EVALUATOR" /tmp/arcade.rules "$PRIOR_RULES"
bun checks/king-projection.mjs "$EVALUATOR" /tmp/arcade.rules \
  ../review/panel/boards.json.gz ../review/other-turns/boards.json.gz ../review/roster/boards.json
```

Earlier revision identifiers in `sources.mjs` reproduce the historical source-size and evaluation-cost trials. Refer to the campaign scorecard and receipts for the selected release, its live verdicts and any remaining disagreements.
