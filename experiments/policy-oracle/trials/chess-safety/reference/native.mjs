import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sha} from '../../../arcade/corpus.mjs';
import {position} from '../../chess/reference/score.mjs';
import * as board from '../../chess/reference/arcade-reference.ts';
import * as native from '../../chess/reference/native.mjs';
import * as standalone from '../../chess/policies/chess.mjs';
import {priorPosition} from '../../chess/verify/document.mjs';
import {sample} from './fixtures.mjs';

const digest=path=>sha(readFileSync(new URL(path,import.meta.url)));
const engine=digest('../../chess/reference/arcade-reference.ts');
const policy=digest('../../chess/policies/chess.mjs');
assert.equal(engine,'1f321bbb70128936c00283d22cfe03ad84b8907a00f0dacf3363b694d6534d5e');
assert.equal(policy,'97dda7add77cb18d132ba1c730bbef24a48870404198d6677cdf0f961a30d212');

function fen(pos) {
  const ranks=Array.from({length:8},(_,r)=>pos.board.slice(r*8,(r+1)*8)
    .map(p=>!p?'1':p[0]==='w'?p[1].toUpperCase():p[1]).join('').replace(/1+/g,s=>s.length));
  return [ranks.join('/'),pos.turn,pos.castling||'-',pos.enPassant<0?'-':board.squareName(pos.enPassant)].join(' ');
}

function inspect(c) {
  const p=position(c.fen),other=p.turn==='w'?'b':'w';
  const move={from:board.squareOf(c.uci.slice(0,2)),to:board.squareOf(c.uci.slice(2,4))};
  assert.match(c.uci,/^[a-h][1-8][a-h][1-8][qrbn]?$/);
  assert.equal(p.board.length,64,c.id);
  for (const side of ['w','b']) assert.equal(p.board.filter(x=>x===side+'k').length,1,c.id);
  assert.equal(board.inCheck(p,other),false,c.id+' side that just moved is in check');
  assert.equal(p.board[move.from][0],p.turn,c.id+' origin');
  assert.notEqual(p.board[move.to][0],p.turn,c.id+' target');
  assert.notEqual(p.board[move.to],other+'k',c.id+' target is a king');
  const next=native.apply(p,c.uci);
  const beforeCheck=board.inCheck(p),afterCheck=board.inCheck(next,p.turn);
  assert.equal(standalone.inCheck(p),beforeCheck,c.id);
  assert.equal(standalone.inCheck({...next,turn:p.turn}),afterCheck,c.id);
  const castle=p.board[move.from][1]==='k' && Math.abs(move.to-move.from)===2;
  let transitCheck=null;
  if (castle) {
    const transit=board.applyMove(p,{from:move.from,to:(move.from+move.to)/2});
    transitCheck=board.inCheck(transit,p.turn);
    assert.equal(standalone.inCheck({...transit,turn:p.turn}),transitCheck,c.id+' transit');
  }
  const kingSafe=!afterCheck && (!castle || (!beforeCheck && !transitCheck));
  const legal=native.legalMoves(p).sort();
  assert.deepEqual(standalone.legalMoves(p).sort(),legal,c.id+' predecessor legal moves');
  const nativeLegal=legal.includes(c.uci);
  if (nativeLegal) assert.deepEqual(standalone.apply(p,c.uci),next,c.id+' legal successor');
  else assert.throws(()=>standalone.apply(p,c.uci),/illegalMove/,c.id+' illegal application');
  const replies=nativeLegal?native.legalMoves(next).sort():null;
  if(replies) assert.deepEqual(standalone.legalMoves(next).sort(),replies,c.id+' successor legal replies');
  const outcome=native.outcome(next);
  assert.equal(standalone.outcome(next),outcome,c.id+' successor outcome');
  const expected={status:outcome==='checkmate'?'won':outcome==='stalemate'?'draw':'playing',
    winner:outcome==='checkmate'?(p.turn==='w'?'host':'guest'):''};
  const {before,proposal}=sample(c,'writer','other');
  assert.deepEqual(priorPosition(before),p,c.id+' stored prior protocol');
  assert.deepEqual(priorPosition({...before,...proposal}),next,c.id+' proposed successor protocol');
  const submitted={status:proposal.status,winner:proposal.winner};
  assert.deepEqual(submitted,c.claim??expected,c.id+' submitted terminal metadata');
  const nativeAdmission=nativeLegal && Object.keys(expected).every(k=>submitted[k]===expected[k]);
  return {...c,beforeCheck,transitCheck,afterCheck,kingSafe,nativeLegal,nativeAdmission,
    successor:fen(next),outcome,expected,submitted,replies};
}

export function nativeEvidence(inputs) {
  assert.equal(new Set(inputs.map(c=>c.id)).size,inputs.length);
  return {engine,policy,standaloneAgrees:true,cases:inputs.map(inspect)};
}

if(import.meta.main) {
  const inputs=JSON.parse(readFileSync(process.argv[2],'utf8'));
  console.log(JSON.stringify(nativeEvidence(inputs),null,2));
}
