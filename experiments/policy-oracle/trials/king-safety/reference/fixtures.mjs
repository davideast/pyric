import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {position} from '../../chess/reference/score.mjs';
import {fresh,afterMove,movePatch} from '../../chess/verify/document.mjs';
import {fixedCreatedAt} from '../../for-of/live/fixtures.mjs';

export const {cases}=JSON.parse(readFileSync(new URL('native.json',import.meta.url)));
export function sample(c,writer,other) {
  const p=position(c.fen), white=p.turn==='w';
  const board=Object.fromEntries(p.board.map((piece,i)=>['abcdefgh'[i%8]+(8-Math.floor(i/8)),piece]));
  assert.equal(p.enPassant,-1);
  const before={...fresh(white?writer:other,fixedCreatedAt),guest:white?other:writer,
    currentTurn:white?'host':'guest',status:'playing',board,prevBoard:board,moveCount:16,
    castling:p.castling,prevCastling:p.castling};
  // Project identical pseudo-legal transitions for both verdicts.
  const proposal=movePatch(afterMove(before,c.uci,undefined,false));
  return {before,proposal,after:c.nativeLegal?{...before,...proposal}:before};
}
