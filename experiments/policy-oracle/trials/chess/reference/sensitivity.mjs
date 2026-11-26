import * as native from "./native.mjs";
import {squareOf, inCheck} from "./arcade-reference.ts";
import {readCorpus, score} from "./score.mjs";

function after(mutate) {
  return {...native, apply(before, move) {
    const next = native.apply(before, move);
    mutate(before, move, next);
    return next;
  }};
}

const mutants = {
  "retain-turn": after((before, _move, next) => next.turn = before.turn),
  "truncate-bishop-rays": {...native, legalMoves(pos) {
    return native.legalMoves(pos).filter(m =>
      pos.board[squareOf(m.slice(0, 2))][1] !== "b" || Math.abs(Number(m[1]) - Number(m[3])) === 1
    );
  }},
  "retain-rook-rights": after((before, move, next) => {
    if (before.board[squareOf(move.slice(0, 2))][1] === "r") next.castling = before.castling;
  }),
  "retain-en-passant": after((before, _move, next) => {
    if (next.enPassant === -1) next.enPassant = before.enPassant;
  }),
  "promote-knight-to-queen": after((before, move, next) => {
    if (move[4] === "n") next.board[squareOf(move.slice(2, 4))] = before.turn + "q";
  }),
  "allow-pinned-rook-sideways": {...native, legalMoves(pos) {
    const moves = native.legalMoves(pos);
    for (let sq = 0; sq < 64; sq++) {
      if (pos.board[sq] !== pos.turn + "r" || sq % 8 === 7 || pos.board[sq + 1] !== "") continue;
      const row = 8 - Math.floor(sq / 8);
      const move = "abcdefgh"[sq % 8] + row + "abcdefgh"[(sq % 8) + 1] + row;
      if (inCheck(native.apply(pos, move), pos.turn)) moves.push(move);
    }
    return moves;
  }},
  "report-mate-as-stalemate": {...native, outcome(pos) {
    const out = native.outcome(pos);
    return out === "checkmate" ? "stalemate" : out;
  }},
};

const publicData = readCorpus(new URL("./public.json.gz", import.meta.url));
const observations = {};
for (const [name, engine] of Object.entries(mutants)) {
  const result = score(engine, publicData, {includeDivides: false});
  observations[name] = result.firstDivergence;
  if (!result.firstDivergence) throw Error("Surviving mutation: " + name);
}
console.log(JSON.stringify(observations, null, 2));
