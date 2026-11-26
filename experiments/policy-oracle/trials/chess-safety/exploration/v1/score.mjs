import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {sha} from '../../../../arcade/corpus.mjs';
import {position} from '../../../chess/reference/score.mjs';
import {inCheck,squareOf} from '../../../chess/reference/arcade-reference.ts';
import {nativeEvidence} from '../../reference/native.mjs';
import {sample} from '../../reference/fixtures.mjs';
import {bucket} from '../replies-v1/family.mjs';
import {encode,plausible} from './corpus.mjs';

const [simulator,bundle,cohort]=process.argv.slice(2);
assert.ok(!cohort || cohort==='--terminal-replies','unknown discovery cohort');
const base=new URL(cohort?'../replies-v1/':'./',import.meta.url);
const read=path=>readFileSync(new URL(path,base));
const manifest=JSON.parse(read('freeze.json'));
const corpus=gunzipSync(read('corpus.json.gz')).toString();
assert.equal(sha(corpus),manifest.sha256);
const rows=JSON.parse(corpus);
assert.ok(simulator && bundle,'usage: bun score.mjs INSTALLED_PINNED_REFERENCE_PACKAGE COMPLETE_RULES [--terminal-replies]');
const {firestoreRules}=await import(pathToFileURL(join(resolve(simulator),'dist/index.js')));
const code=readFileSync(bundle,'utf8'),sim=firestoreRules(code);
const order=[];
const groups={},reachableByMove={},seeds=new Map();
const occupied=c=>position(c.fen).board.filter(Boolean).length;
const compact=c=>Object.fromEntries(['id','fen','uci','claim','nativeLegal','kingSafe','nativeAdmission','successor','outcome','replyCount'].filter(k=>k in c).map(k=>[k,c[k]]));

function decision(c) {
  const {before,proposal}=sample(c,'writer','other');
  const [r]=sim.simulate([{description:c.id,method:'update',path:'chess/explore',resource:before,
    data:{...before,...proposal},auth:{uid:'writer'},expectation:'ALLOW'}]).cases;
  const error=r.trace?.find(t=>t.verdict==='ERROR');
  const refused=r.decision==='DENY', limit=r.resourceLimit?.kind??null;
  const cause=r.unsupported?'unsupported':limit?'resource-limit':refused&&error?'rule-error':null;
  const actual=r.decision==='ALLOW';
  const status=cause==='unsupported'?'unsupported':cause && refused && !c.nativeAdmission?'evaluation-error'
    :actual===c.nativeAdmission?'match':actual?'false-allow':'false-refusal';
  return {actual:r.decision,status,cause,expressions:r.evaluatedExpressions};
}
for(const c of rows) {
  const result=decision(c), group=groups[c.group]??={cases:0,outcomes:{},peakExpressions:0};
  group.cases++;
  const kind=[result.status,result.cause].filter(Boolean).join('/');
  group.outcomes[kind]=(group.outcomes[kind]??0)+1;
  group.peakExpressions=Math.max(group.peakExpressions,result.expressions);
  if (c.group==='reachable-traces') {
    const p=position(c.fen), from=squareOf(c.uci.slice(0,2)), to=squareOf(c.uci.slice(2,4));
    const kind=p.board[from][1];
    const span=Math.max(Math.abs(Math.floor(from/8)-Math.floor(to/8)),Math.abs(from%8-to%8));
    const label=kind+'-'+(span>3?'long':span)+'-'+(p.board[to]?'capture':'quiet');
    const category=reachableByMove[label]??={cases:0,outcomes:{}};
    category.cases++;
    category.outcomes[result.status]=(category.outcomes[result.status]??0)+1;
  }
  order.push([c.id,result.actual,result.status,result.cause,result.expressions]);
  if(result.status==='match')continue;
  const k=c.group+'/'+kind, prior=seeds.get(k),example={c,result};
  if(!prior) seeds.set(k,{first:example,smallest:example});
  else if(occupied(c)<occupied(prior.smallest.c)) prior.smallest=example;
}

function minimize({c:input,result}) {
  const start=position(input.fen);
  const from=squareOf(input.uci.slice(0,2)),to=squareOf(input.uci.slice(2,4));
  const fixed=new Set([from,to,...start.board.flatMap((piece,i)=>piece[1]==='k'?[i]:[])]);
  if(start.enPassant===to) fixed.add(to+(start.turn==='w'?8:-8));
  const pinnedOutcome=input.nativeLegal?input.outcome:null;
  const beforeCheck=inCheck(start);
  const initialCount=occupied(input);
  let tried=0;
  function reproduce(board) {
    tried++;
    const p={...start,board};
    if(!plausible(p)||inCheck(p)!==beforeCheck) return null;
    const fen=encode(p);
    const candidate={id:input.id,fen,uci:input.uci,...(input.claim&&{claim:input.claim})};
    const a=nativeEvidence([candidate]).cases[0];
    if(a.kingSafe!==input.kingSafe || a.nativeLegal!==input.nativeLegal || a.nativeAdmission!==input.nativeAdmission) return null;
    if(pinnedOutcome && pinnedOutcome!==a.outcome) return null;
    if(input.replyCount===1 && (a.replies?.length!==1 ||
      (input.replySha256 && sha(JSON.stringify(a.replies))!==input.replySha256))) return null;
    if(cohort) {
      const next=position(a.successor);
      if(!next.board.some(v=>v[0]===next.turn && v[1]!=='k') ||
         bucket(next,a.replies)!==input.group || JSON.stringify(a.replies)!==JSON.stringify(input.replies)) return null;
    }
    const observed=decision(a);
    if(result.actual!==observed.actual || result.status!==observed.status || result.cause!==observed.cause) return null;
    return {position:a,result:observed};
  }
  let board=[...start.board],best={position:input,result};
  let changed=true;
  while(changed) {
    changed=false;
    for(const [i,piece] of board.entries()) {
      if(!piece || fixed.has(i)) continue;
      const reduced=[...board];reduced[i]='';
      const next=reproduce(reduced);
      if(next) {board=reduced;best=next;changed=true;}
    }
  }
  const removed=start.board.flatMap((piece,i)=>piece&&!board[i]?[i]:[]);
  const removable=board.flatMap((piece,i)=>piece&&!fixed.has(i)?[i]:[]);
  for(const i of removable) {const reduced=[...board];reduced[i]='';assert.equal(reproduce(reduced),null);}
  const minimized={...compact(best.position),replyCount:best.position.replies?.length??best.position.replyCount??null};
  return {beforePieces:initialCount,afterPieces:board.filter(Boolean).length,
    criterion:'no single unprotected piece removable preserving side, move, victim, rights, source check, native safety, admissibility, legal outcome, lone reply identity and local failure class',
    removedSquares:removed.map(i=>'abcdefgh'[i%8]+(8-Math.floor(i/8))),positionsTried:tried,case:minimized,result:best.result};
}
const divergences=Object.fromEntries([...seeds].map(([group,{first,smallest}])=>[group,{
  first:{case:compact(first.c),result:first.result},minimized:minimize(smallest),
}]));
console.log(JSON.stringify({authority:'pinned local full Firestore Rules simulator',rulesSha256:sha(code),
  corpusSha256:manifest.sha256,caseCount:rows.length,scoreSha256:sha(JSON.stringify(order)),groups,reachableByMove,divergences},null,2));
