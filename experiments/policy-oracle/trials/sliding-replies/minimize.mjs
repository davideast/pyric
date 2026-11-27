// Reduce a full-write disagreement while preserving its chess and evaluator causes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual as equal} from 'node:util';
import {position} from '../chess/reference/score.mjs';
import {inCheck,squareOf,squareName} from '../chess/reference/arcade-reference.ts';
import {priorPosition} from '../chess/verify/document.mjs';
import {nativeEvidence} from '../chess-safety/reference/native.mjs';
import {sample} from '../chess-safety/reference/fixtures.mjs';
import {encode,plausible} from '../chess-safety/exploration/v1/corpus.mjs';

const [installed,rulesPath,reportPath,...selected]=process.argv.slice(2);
const {firestoreRules}=await import(pathToFileURL(resolve(installed,'dist/index.js')));
const source=readFileSync(rulesPath);
const rulesSha256=createHash('sha256').update(source).digest('hex');
const report=JSON.parse(readFileSync(reportPath));
assert.equal(report.compile.rulesSha256,rulesSha256);
const referee=firestoreRules(source.toString());
const requests=new Map(JSON.parse(readFileSync(0,'utf8')).map(request=>[request.description,request]));
const groups=selected.length?selected:Object.keys(report.groups);
const reductions=[];
for (const group of groups) {
  const id=report.groups[group].find(k=>report.local.rows[k].status!=='match');
  if (!id) continue;
  const input=requests.get(id);
  const before=priorPosition(input.resource);
  const mv=input.data.lastMove,uci=mv.from+mv.to+mv.promotion;
  const claim={status:input.data.status,winner:input.data.winner};
  const original=report.local.rows[id],from=squareOf(mv.from),to=squareOf(mv.to);
  const fixed=new Set([from,to,...before.board.flatMap((pc,i)=>pc[1]==='k'?[i]:[])]);
  if (before.enPassant===to) fixed.add(to+(before.turn==='w'?8:-8));
  function snapshot(board) {
    const p={...before,board};
    if (!plausible(p) || inCheck(p)!==inCheck(before)) return null;
    const fixture={id,fen:encode(p),uci,claim};
    const [truth]=nativeEvidence([fixture]).cases;
    const {before:frame,proposal}=sample(fixture,input.auth.uid,input.resource[input.resource.currentTurn==='host'?'guest':'host']);
    const resource={...input.resource,board:frame.board};
    if (equal(input.resource.prevBoard,input.resource.board)) resource.prevBoard=frame.board;
    const data={...input.data,board:proposal.board,prevBoard:frame.board};
    const req={...input,resource,data};
    if (equal(board,before.board)) assert.deepEqual(req,input,'replay must start on the original complete request');
    const [result]=referee.simulate([req]).cases;
    const diagnostic=result.unsupported?'unsupported':result.resourceLimit?'resource-limit':
      result.decision==='DENY' && result.trace.some(x=>x.verdict==='ERROR')?'rule-error':null;
    return {fen:fixture.fen,uci,claim,successor:truth.successor,replies:truth.replies,nativeLegal:truth.nativeLegal,
      kingSafe:truth.kingSafe,checkedDefender:inCheck(position(truth.successor)),native:truth.nativeAdmission?'ALLOW':'DENY',outcome:truth.outcome,
      decision:result.decision,diagnostic,expressions:result.evaluatedExpressions};
  }
  const start=snapshot(before.board);
  assert.ok(start&&start.native===original.native&&start.decision===original.decision&&start.diagnostic===(original.diagnostic??null),id);
  const preserve=row=>row&&row.native===start.native&&row.decision===start.decision&&row.diagnostic===start.diagnostic&&
    row.nativeLegal===start.nativeLegal&&row.kingSafe===start.kingSafe&&row.checkedDefender===start.checkedDefender&&row.outcome===start.outcome&&
    (start.replies?.length!==1 || equal(start.replies,row.replies));
  let board=[...before.board],smallest=start;
  const removed=[],trials=[];
  while (true) {
    let changed=false;
    for (let i=0;i<64;i++) {
      if (!board[i]||fixed.has(i)) continue;
      const next=[...board]; next[i]='';
      const tested=snapshot(next),kept=Boolean(preserve(tested));
      trials.push({removed:[...removed,squareName(i)],preservesFailure:kept});
      if (kept) {board=next;smallest=tested;removed.push(squareName(i));changed=true;break;}
    }
    if (!changed) break;
  }
  reductions.push({group,id,start,smallest,removed,fixedSquares:[...fixed].map(squareName),trials});
}
console.log(JSON.stringify({rulesSha256,criterion:'One-piece deletion preserving the actor, move, victim, castling and en-passant state, prior check, legality, mover safety, successor check, result, admission, sole reply identity when unique, and local diagnostic.',reductions},null,2));
