import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readCorpus,position} from './score.mjs';
import * as arcade from './native.mjs';

const [engineFile,metadataFile,...paths]=process.argv.slice(2);
assert.ok(paths.length,'supply at least one pinned corpus');
const engine=await import(pathToFileURL(resolve(engineFile)));
const policy=await import(pathToFileURL(resolve(metadataFile)));
const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const square=i=>'abcdefgh'[i%8]+(8-Math.floor(i/8));
const ep=i=>i===-1?'':square(i);
function payload(fen,ply) {
  const p=position(fen);
  return {host:'white-player',guest:'black-player',currentTurn:p.turn==='w'?'host':'guest',
    moveCount:ply,castling:p.castling,enPassant:ep(p.enPassant),status:'playing',winner:''};
}
function check(before,move,expectedAfter,result,ply) {
  const p=position(before),wanted=position(expectedAfter);
  const game=payload(before,ply);
  const next=engine.apply(p,move), outcome=engine.outcome(next);
  assert.equal(outcome,result);
  const from=move.slice(0,2), to=move.slice(2,4), mover=game.currentTurn;
  const extra=wanted.board.flatMap((piece,i)=>piece!==p.board[i]?[square(i)]:[]).filter(s=>s!==from&&s!==to).sort();
  const expected={currentTurn:mover==='host'?'guest':'host',moveCount:ply+1,status:result==='checkmate'?'won':result==='stalemate'?'draw':'playing',
    winner:result==='checkmate'?mover:'',lastMove:{from,to,promotion:move[4]||'',extra},
    castling:wanted.castling,enPassant:ep(wanted.enPassant),prevCastling:p.castling,prevEnPassant:ep(p.enPassant)};
  const derived=policy.metadata(game,move,p,next,outcome);
  assert.deepEqual(derived,expected,before+' '+move+' match metadata');
  assert.equal(policy.admit(game,game[mover],ply),'ok');
  assert.equal(policy.admit(game,game[mover],ply+1),'matchVersion');
  assert.equal(policy.admit(game,game[expected.currentTurn],ply),'currentTurn');
  assert.equal(policy.admit({...game,status:'resigned'},game[mover],ply),'playing');
}
const results=paths.map(path=>{
  const data=readCorpus(path);
  let staticCases=0,traceCases=0;
  for(const r of data.positions){
    for(const [move,after] of Object.entries(r.successors)){
      // The independent corpus freezes the complete successor. The pinned native source
      // adjudicates its terminal status when a named position enumerates every child.
      check(r.fen,move,after,arcade.outcome(position(after)),0); staticCases++;
    }
  }
  for(const t of data.traces) {
    for(const [ply,r] of t.rows.entries()) if(r.move){
      const expected=t.rows[ply+1];
      check(r.fen,r.move,expected.fen,expected.outcome,ply); traceCases++;
    }
  }
  return {inputDigest:data.inputDigest,staticCases,traceCases,metadataChecks:staticCases+traceCases,admissionChecks:4*(staticCases+traceCases)};
});
console.log(JSON.stringify({engine:digest(engineFile),metadataPolicy:digest(metadataFile),results},null,2));
