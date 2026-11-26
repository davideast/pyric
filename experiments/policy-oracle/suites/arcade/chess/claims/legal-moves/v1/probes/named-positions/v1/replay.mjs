import {readFileSync} from "node:fs";
import {resolve, join} from "node:path";
import {pathToFileURL} from "node:url";

const dir = join(process.env.ORACLE_ROOT, "trials/chess/reference");
const engine = await import(pathToFileURL(process.env.ARCADE_CHESS_CANDIDATE
  ? resolve(process.env.ARCADE_CHESS_CANDIDATE) : join(dir, "native.mjs")));
const {position} = await import(pathToFileURL(join(dir, "score.mjs")));
const {positions} = JSON.parse(readFileSync(join(dir, "public.json"), "utf8"));
const candidate = {}, mutant = {};
for (const entry of positions) {
  const start = entry.fen === "startpos" ? "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -" : entry.fen;
  const pos = position(start);
  const legal = [...engine.legalMoves(pos)].sort();
  const outcome = engine.outcome(pos);
  candidate[entry.name] = {legal, outcome};
  const omittedCastles = legal.filter(m => {
    const castlingMove = pos.turn === "w" ? ["e1g1","e1c1"].includes(m) : ["e8g8","e8c8"].includes(m);
    return !castlingMove || pos.board[pos.turn === "w" ? 60 : 4] !== pos.turn + "k";
  });
  mutant[entry.name] = {legal: omittedCastles, outcome};
}
console.log(JSON.stringify({candidate, mutant}));
