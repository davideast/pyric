import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {sha} from '../../../../arcade/corpus.mjs';
import {position} from '../../../chess/reference/score.mjs';
import * as native from '../../../chess/reference/native.mjs';
import {inCheck,squareName,squareOf} from '../../../chess/reference/arcade-reference.ts';
import {nativeEvidence} from '../../reference/native.mjs';
import {sample} from '../../reference/fixtures.mjs';
import {bucket} from '../replies-v1/family.mjs';
import {classify} from '../classify.mjs';
import {encode,plausible} from './corpus.mjs';

const args=process.argv.slice(2);
const scopeReport=args.includes('--scope-report');
const [simulator,bundle,cohort]=args.filter(a=>a!=='--scope-report');
const locations=new Map([
  [undefined,'./'],['--terminal-replies','../replies-v1/'],['--rights','../rights-v1/'],
  ['--promotions','../promotions-v1/'],['--interior','../interior-v1/'],
  ['--king-last','../king-last-v1/'],['--all-claims','../successor-claims-v1/'],
  ['--bare-defender','../bare-defender-v1/'],['--knight-replies','../knight-replies-v1/'],
]);
assert.ok(locations.has(cohort),'unknown discovery cohort');
const base=new URL(locations.get(cohort),import.meta.url);
const read=path=>readFileSync(new URL(path,base));
const manifest=JSON.parse(read('freeze.json'));
const corpus=gunzipSync(read('corpus.json.gz')).toString();
assert.equal(sha(corpus),manifest.sha256);
const rows=JSON.parse(corpus);
assert.ok(simulator && bundle,'usage: bun score.mjs INSTALLED_PINNED_REFERENCE_PACKAGE COMPLETE_RULES [--terminal-replies | --rights | --promotions | --interior]');
execFileSync('python3',[fileURLToPath(new URL('verify-simulator.py',import.meta.url)),simulator]);
const {firestoreRules}=await import(pathToFileURL(join(resolve(simulator),'dist/index.js')));
const code=readFileSync(bundle,'utf8'),sim=firestoreRules(code);
const order=[];
const groups={},reachableByMove={},coverage={},seeds=new Map();
const occupied=c=>position(c.fen).board.filter(Boolean).length;
const compact=c=>Object.fromEntries(['id','fen','uci','claim','nativeLegal','kingSafe','nativeAdmission','successor','outcome','replyCount'].filter(k=>k in c).map(k=>[k,c[k]]));

function decision(c) {
  const {before,proposal}=sample(c,'writer','other');
  const [r]=sim.simulate([{description:c.id,method:'update',path:'chess/explore',resource:before,
    data:{...before,...proposal},auth:{uid:'writer'},expectation:'ALLOW'}]).cases;
  return {actual:r.decision,...classify(r,c.nativeAdmission),expressions:r.evaluatedExpressions};
}
// Independent subset membership uses native chess material and legal replies.
function terminalScope(c) {
  if(!c.nativeLegal) return 'illegal-move';
  const next=position(c.successor), defending=next.turn, mover=defending==='w'?'b':'w';
  const pieces=next.board.filter(v=>v[0]===mover),slider=next.board.findIndex(v=>v===mover+'r'||v===mover+'q');
  if(slider<0||pieces.length!==2) return 'outside-subset';
  const defenders=next.board.filter(v=>v[0]===defending);
  if(defenders.length===1 && squareName(slider)===c.uci.slice(2,4)) return 'bare-king-slider-last-move';
  if(native.legalMoves(next).some(m=>m.slice(2,4)===squareName(slider) && next.board[squareOf(m.slice(0,2))][1]!=='k'))
    return 'nonking-can-take-last-slider';
  return 'outside-subset';
}
for(const c of rows) {
  const result=decision(c), group=groups[c.group]??={cases:0,outcomes:{},peakExpressions:0};
  group.cases++;
  if(scopeReport) {
    const label=terminalScope(c), sub=coverage[label]??={cases:0,outcomes:{},first:{}};
    sub.cases++;
    const outcome=result.kind;
    sub.outcomes[outcome]=(sub.outcomes[outcome]??0)+1;
    if(result.status!=='match') sub.first[outcome]??=c.id;
  }
  const kind=result.kind;
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
    if(cohort==='--terminal-replies') {
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
  corpusSha256:manifest.sha256,caseCount:rows.length,scoreSha256:sha(JSON.stringify(order)),groups,reachableByMove,divergences,...(scopeReport&&{coverage})},null,2));
