import * as arcade from '../../../chess/reference/arcade-reference.ts';
import * as native from '../../../chess/reference/native.mjs';
import {encode,plausible} from '../v1/corpus.mjs';

export function reverseMove(next,at,rng) {
  const starts=Array.from({length:64},(_,i)=>i).filter(i=>!next.board[i] && i!==at);
  const offset=rng(starts.length);
  for(let x=0;x<starts.length;x++) {
    const from=starts[(x+offset)%starts.length], b=[...next.board];
    b[from]=b[at];b[at]='';
    const p={...next,board:b,turn:next.turn==='b'?'w':'b'};
    if(!plausible(p)) continue;
    const m={from,to:at};
    if(arcade.isLegal(p,m) && native.apply(p,arcade.squareName(from)+arcade.squareName(at)).board.join('|')===next.board.join('|'))
      return {fen:encode(p),uci:arcade.squareName(from)+arcade.squareName(at)};
  }
}
