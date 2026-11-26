import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sha} from '../../../arcade/corpus.mjs';
import {position} from '../../chess/reference/score.mjs';
import {inCheck,isLegal,applyMove,squareOf} from '../../chess/reference/arcade-reference.ts';
import * as pyric from '../../chess/policies/chess.mjs';

const read = path => readFileSync(new URL(path,import.meta.url));
const engine = sha(read('../../chess/reference/arcade-reference.ts'));
const policy = sha(read('../../chess/policies/chess.mjs'));
assert.equal(engine,'1f321bbb70128936c00283d22cfe03ad84b8907a00f0dacf3363b694d6534d5e');
assert.equal(policy,'97dda7add77cb18d132ba1c730bbef24a48870404198d6677cdf0f961a30d212');
const cases = JSON.parse(read(process.argv[2] ?? 'positions.json')).map(({id,fen,uci}) => {
  const pos=position(fen), move={from:squareOf(uci.slice(0,2)),to:squareOf(uci.slice(2))};
  const next=applyMove(pos,move);
  const beforeCheck=inCheck(pos), afterCheck=inCheck(next,pos.turn), nativeLegal=isLegal(pos,move);
  const standalone={beforeCheck:pyric.inCheck(pos),afterCheck:pyric.inCheck({...next,turn:pos.turn}),legal:pyric.legalMoves(pos).includes(uci)};
  assert.deepEqual(standalone,{beforeCheck,afterCheck,legal:nativeLegal},id);
  assert.equal(beforeCheck,false,id);
  assert.equal(afterCheck,!nativeLegal,id);
  return {id,fen,uci,nativeLegal,beforeCheck,afterCheck,standalone};
});
console.log(JSON.stringify({engine,policy,cases},null,2));
