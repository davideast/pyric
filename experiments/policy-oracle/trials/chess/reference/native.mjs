import * as arcade from "./arcade-reference.ts";

export function legalMoves(position) {
  return arcade.legalMoves(position).map(({from, to, promotion}) =>
    arcade.squareName(from) + arcade.squareName(to) + (promotion ?? "")
  );
}

export function apply(position, uci) {
  return arcade.applyMove(position, {
    from: arcade.squareOf(uci.slice(0, 2)),
    to: arcade.squareOf(uci.slice(2, 4)),
    ...(uci.length === 5 && {promotion: uci[4]}),
  });
}

export const outcome = arcade.outcome;
