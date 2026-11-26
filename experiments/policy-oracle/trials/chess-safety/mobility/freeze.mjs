import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sha} from '../../../arcade/corpus.mjs';
import {position} from '../../chess/reference/score.mjs';
import {squareOf,squareName} from '../../chess/reference/arcade-reference.ts';
import {legalMoves} from '../../chess/reference/native.mjs';
import * as standalone from '../../chess/policies/chess.mjs';

const bytes=file=>readFileSync(new URL(file,import.meta.url));
const native=sha(bytes('../../chess/reference/arcade-reference.ts'));
const model=sha(bytes('../../chess/policies/chess.mjs'));
assert.equal(native,'1f321bbb70128936c00283d22cfe03ad84b8907a00f0dacf3363b694d6534d5e');
assert.equal(model,'97dda7add77cb18d132ba1c730bbef24a48870404198d6677cdf0f961a30d212');
const cases=JSON.parse(bytes('positions.json')).map(({id,fen})=>{
  const pos=position(fen),color=pos.turn;
  const legal=legalMoves(pos).sort();
  assert.deepEqual(standalone.legalMoves(pos).sort(),legal,id);
  const from=squareName(pos.board.indexOf(color+'k'));
  const kingMoves=legal.filter(uci=>uci.startsWith(from));
  const adjacent=kingMoves.filter(uci=>Math.abs(uci.charCodeAt(0)-uci.charCodeAt(2))<=1).map(uci=>uci.slice(2,4));
  assert.equal(adjacent.length>0,kingMoves.length>0,id);
  if(id.startsWith(color+'-only-')) assert.deepEqual(adjacent,[id.slice(-2)]);
  if(id==='one-rook-reply-correct') assert.equal(legal.length,1);
  return {id,fen,from,adjacent,hasKingReply:adjacent.length>0,replies:legal};
});
console.log(JSON.stringify({native,standalone:model,cases},null,2));
