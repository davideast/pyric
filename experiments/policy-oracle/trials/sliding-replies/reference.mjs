// Independent Arcade referee. This file is never mounted inside the compiler worker.
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {priorPosition} from '../chess/verify/document.mjs';
import * as native from '../chess/reference/native.mjs';

const requests = JSON.parse(readFileSync(0, 'utf8'));
console.log(JSON.stringify(requests.map(({resource,data}) => {
  const before = priorPosition(resource), after = priorPosition(data);
  const {from,to,promotion} = data.lastMove;
  const move = from + to + promotion;
  if (!native.legalMoves(before).includes(move)) return {eligible:false, reason:'illegal predecessor move'};
  if (!isDeepStrictEqual(native.apply(before,move),after)) return {eligible:false, reason:'submitted board or rights differ'};
  const all = native.legalMoves(after).sort();
  const sliding = all.filter(reply => {
    const index = (8-Number(reply[1]))*8 + 'abcdefgh'.indexOf(reply[0]);
    return ['r','b','q'].includes(after.board[index][1]);
  });
  return {eligible:true, all, sliding, outcome:native.outcome(after)};
})));
