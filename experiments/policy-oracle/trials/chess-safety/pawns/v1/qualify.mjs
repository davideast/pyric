import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {loadPolicyApi} from '../../../king-safety/policy/public-api.mjs';
import {position} from '../../../chess/reference/score.mjs';
import {squareName,squareOf,attacked} from '../../../chess/reference/arcade-reference.ts';
import {projections,sources} from './policy.mjs';

const [candidate,ref]=process.argv.slice(2);
const {compileFunction}=await loadPolicyApi(candidate);
const {firestoreRules}=await import(pathToFileURL(resolve(ref,'dist/index.js')));
const raw=gunzipSync(readFileSync(new URL('corpus.json.gz',import.meta.url)));
const truth=JSON.parse(readFileSync(new URL('native.json',import.meta.url)));
assert.equal(createHash('sha256').update(raw).digest('hex'),truth.sha256);
const fixed=square=>square%8+(7-(square>>3))*10;
function pack(board){
  const cells=Array(80).fill('#');
  for(let n=0;n<64;n++)cells[fixed(n)]=board[n];
  return cells.join(',')+',';
}
const promises={};
for(const [name,source] of Object.entries(sources())){
  const color=name.at(-1),test=compileFunction(source);
  const mod=test.firestoreModule();
  const fn=mod.slice(mod.indexOf('export function')).replace('export function','function');
  const rules="rules_version = '2'; service cloud.firestore { "+fn+" match /databases/{d}/documents/chess/{id} { allow update: if "+name+"(request.resource.data.board); } }";
  const byDirection=projections(color).map((expr,i)=>compileFunction(`function project${i}(original) { return ${expr}; }`));
  promises[color]={test,check:firestoreRules(rules),byDirection};
}
const stats={positions:0,concreteProjections:0,unsafeProjections:0,witnessed:0,missed:0,noPawnMove:0,
  missedOneStep:0,missedOnlyDoubleOrEp:0,firstMiss:null};
const digest=createHash('sha256');
for(const row of JSON.parse(raw)){
  const pos=position(row.fen),color=pos.turn,text=pack(pos.board);
  const {test,check,byDirection}=promises[color];
  const witness=test(text);
  assert.equal(typeof witness,'boolean');
  const [r]=check.simulate([{method:'update',path:'chess/pawn',description:row.id,auth:{uid:'player'},resource:{},data:{board:text},expectation:'ALLOW'}]).cases;
  assert.ok(!r.unsupported&&!r.resourceLimit&&!r.trace.some(t=>t.verdict==='ERROR'));
  assert.equal(r.decision==='ALLOW',witness);
  const legal=new Set(row.pawnMoves.map(m=>m.uci.slice(0,4)));
  const actual=[];
  for(const project of byDirection){
    const board=project('X'+text);
    if(board==='X'+text)continue;
    const cells=board.split(',');
    const next=pos.board.map((_,i)=>cells[fixed(i)]);
    assert.equal(pack(next),board);
    const changed=pos.board.map((piece,i)=>piece===next[i]?-1:i).filter(i=>i>=0);
    assert.equal(changed.length,2);
    const from=changed.find(n=>pos.board[n]===color+'p'&&next[n]==='');
    const to=changed.find(n=>next[n]===color+'p'&&pos.board[n]!==color+'p');
    assert.ok(from!==undefined&&to!==undefined);
    const dy=(to>>3)-(from>>3),dx=Math.abs(to%8-from%8);
    assert.equal(dy,color==='w'?-1:1);
    assert.ok(dx===0?pos.board[to]==='':dx===1&&pos.board[to].startsWith(color==='w'?'b':'w')&&!pos.board[to].endsWith('k'));
    const uci=squareName(from)+squareName(to),safe=legal.has(uci);
    assert.equal(!attacked(next,next.indexOf(color+'k'),color==='w'?'b':'w'),safe);
    stats.concreteProjections++;
    if(!safe)stats.unsafeProjections++;
    actual.push([uci,safe]);
  }
  assert.equal(witness,actual.some(([,safe])=>safe));
  if(witness)stats.witnessed++;
  else if(legal.size){
    stats.missed++;
    if(row.pawnMoves.some(m=>['advance','capture'].includes(m.kind)))stats.missedOneStep++;
    else stats.missedOnlyDoubleOrEp++;
    stats.firstMiss??={id:row.id,fen:row.fen,native:row.pawnMoves,projections:actual};
  }else stats.noPawnMove++;
  stats.positions++;digest.update(JSON.stringify([row.id,actual,witness])+'\n');
}
console.log(JSON.stringify({...stats,proofsSha256:digest.digest('hex'),nativeSha256:truth.sha256},null,2));
