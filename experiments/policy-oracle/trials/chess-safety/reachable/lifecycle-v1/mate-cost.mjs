import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha} from '../../../../arcade/corpus.mjs';
import {afterMove,priorPosition} from '../../../chess/verify/document.mjs';
import * as native from '../../../chess/reference/native.mjs';
import {position} from '../../../chess/reference/score.mjs';
import {squareName} from '../../../chess/reference/arcade-reference.ts';
import * as standalone from '../../../chess/policies/chess.mjs';
import * as match from '../../../chess/policies/chess-match.mjs';
import {sample} from '../../reference/fixtures.mjs';
import {encode,plausible} from '../../exploration/v1/corpus.mjs';
import {classify} from '../../exploration/classify.mjs';
import {steps,traces} from './fixtures.mjs';

const [pkg,file,seedFen]=process.argv.slice(2);
execFileSync('python3',[fileURLToPath(new URL('../../exploration/v1/verify-simulator.py',import.meta.url)),pkg]);
const {firestoreRules}=await import(pathToFileURL(resolve(pkg,'dist/index.js')));
const source=readFileSync(file),handle=firestoreRules(source.toString());
const chain=[...steps(traces.find(t=>t.name==='fools-mate'))],start=chain.find(s=>s.kind==='join').after;
const moves=chain.filter(s=>s.kind==='move').map(s=>s.uci);
assert.deepEqual(moves,['f2f3','e7e5','g2g4','d8h4']);
const rootPieces=Object.keys(start.board).filter(s=>start.board[s]);
const fixed=new Set(['e1','e8','f2','e7','g2','d8']);
function inspect(before,data,expected){
  const [r]=handle.simulate([{description:'fools-mate',path:'chess/exact-match',method:'update',
    auth:{uid:before[before.currentTurn]},resource:before,data,expectation:expected?'ALLOW':'DENY'}]).cases;
  return {decision:r.decision,expressions:r.evaluatedExpressions,...classify(r,expected)};
}
function sequence(keep,requireFullRights){
  const b=Object.fromEntries(Object.entries(start.board).map(([sq,p])=>[sq,keep.has(sq)?p:'']));
  const rights=[['K','h1'],['Q','a1'],['k','h8'],['q','a8']].filter(([,s])=>b[s]).map(([r])=>r).join('');
  if(requireFullRights&&rights!=='KQkq')return null;
  let before={...start,board:b,prevBoard:b,castling:rights,prevCastling:rights};
  if(!plausible(priorPosition(before)))return null;
  const seedFen=encode(priorPosition(before)),path=[];
  for(const [i,uci] of moves.entries()){
    const p=priorPosition(before);
    if(!native.legalMoves(p).includes(uci))return null;
    const after=afterMove(before,uci,native,true);
    if(after.status!==(i===3?'won':'playing'))return null;
    const honest=inspect(before,after,true);
    const entry={uci,fen:encode(p),afterFen:encode(priorPosition(after)),honest};
    if(i===3){
      assert.deepEqual(after,afterMove(before,uci,standalone,true,match));
      assert.deepEqual(native.legalMoves(priorPosition(after)),[]);
      entry.claims={won:honest,playing:inspect(before,{...after,status:'playing',winner:''},false),
        draw:inspect(before,{...after,status:'draw',winner:''},false),
        wrongWinner:inspect(before,{...after,status:'won',winner:'host'},false)};
      const isolated=sample({fen:entry.fen,uci},before.guest,before.host);
      entry.atPly16=inspect(isolated.before,{...isolated.before,...isolated.proposal},true);
    }
    path.push(entry);before=after;
  }
  return {seedFen,pieces:keep.size,remainingSquares:[...keep].sort(),path};
}
const all=new Set(rootPieces),original=sequence(all,true);
function failed(result){
  return result&&result.path.slice(0,3).every(s=>s.honest.status==='match')&&
    result.path[3].honest.kind==='false-refusal/resource-limit'&&result.path[3].claims.playing.status==='false-allow';
}
function reduce(fullRights){
  let best=original,attempts=0;
  let word=0x6498d1cf;
  const index=n=>{word=(Math.imul(1664525,word)+1013904223)>>>0;return Math.floor(word/4294967296*n);};
  for(let round=0;round<8;round++){
    let keep=new Set(rootPieces);
    const order=rootPieces.filter(s=>!fixed.has(s));
    if(round)for(let i=order.length-1;i>0;i--){const j=index(i+1);[order[i],order[j]]=[order[j],order[i]];}
    let changed=true;
    while(changed){
      changed=false;
      for(const s of order){
        if(!keep.has(s))continue;
        const trial=new Set(keep);trial.delete(s);attempts++;
        const next=sequence(trial,fullRights);
        if(failed(next)){keep=trial;changed=true;if(keep.size<best.pieces)best=next;}
      }
    }
  }
  for(const s of best.remainingSquares){
    if(fixed.has(s))continue;
    const copy=new Set(best.remainingSquares);copy.delete(s);
    assert.ok(!failed(sequence(copy,fullRights)),s+' still removable');
  }
  return {fullInitialCastlingRights:fullRights,attempts,criterion:'no single removable initial piece preserves the four legal plies, nonterminal prefixes accepted, mate refusal by budget and false-playing acceptance',...best};
}
let suppliedSeed;
if(seedFen){
  const p=position(seedFen);
  const keep=new Set(p.board.flatMap((piece,i)=>piece?[squareName(i)]:[]));
  suppliedSeed=sequence(keep,false);
  assert.equal(suppliedSeed?.seedFen,seedFen,'expected a subset of original opening pieces and rights');
}
const minimizations=!seedFen&&failed(original)?[reduce(true),reduce(false)]:[];
console.log(JSON.stringify({authority:'pinned local complete Rules evaluator',rulesSha256:sha(source),
  original,minimizations,...(suppliedSeed&&{suppliedSeed}),seedReduction:'each reduced board is a composed initial seed; only the original starts from a standard signed game'},null,2));
