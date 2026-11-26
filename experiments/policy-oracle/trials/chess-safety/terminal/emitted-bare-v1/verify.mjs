import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {touching} from '../v1/geometry.mjs';
import {pieces,verdict} from '../table-v2/endings.mjs';
const [sdk,bundle,shardArg='0',shardsArg='1',limitArg]=process.argv.slice(2);
const shard=Number(shardArg),shards=Number(shardsArg),limit=limitArg?Number(limitArg):Infinity;
assert.ok(Number.isInteger(shards)&&Number.isInteger(shard)&&shard>=0&&shard<shards&&shards>0);
const full=readFileSync(bundle,'utf8');
const sha=v=>createHash('sha256').update(v).digest('hex');
const saved=new Map();
for(const m of full.matchAll(/^  function (\w+)\([^\n]+\) \{\n[\s\S]*?^  \}/gm)){
  assert.ok(!saved.has(m[1]));saved.set(m[1],m[0]);
}
const needed=new Map();
function include(name){
  if(needed.has(name))return;
  const body=saved.get(name);assert.ok(body,'expected emitted status helper '+name);
  needed.set(name,body);
  for(const m of body.matchAll(/\b(\w+)\s*\(/g))if(saved.has(m[1]))include(m[1]);
}
include('admittedStatus');
const specimen="rules_version = '2'; service cloud.firestore {\n"+[...needed.values()].join('\n')+"\nmatch /databases/{db}/documents/test/{id} { allow update: if admittedStatus(request.resource.data.text,request.resource.data.color,request.resource.data.status); } }";
const {firestoreRules}=await import(pathToFileURL(resolve(sdk,'dist/index.js')));
const rules=firestoreRules(specimen);
const request={description:'bare-king-result',method:'update',path:'test/end',auth:{uid:'player'},resource:{},expectation:'ALLOW'};
const native=JSON.parse(readFileSync(new URL('../table-v2/native.json',import.meta.url)));
const counts={},truth=createHash('sha256'),scores=createHash('sha256');
const encode=s=>s%8+10*(7-(s>>3));
const text=Array.from({length:80},(_,n)=>n%10<8?'':'#');
let seen=0,checked=0,mismatches=0,first=null,runtimeErrors=0;
for(const color of ['w','b'])for(const piece of pieces)for(let s=0;s<64;s++)for(let d=0;d<64;d++)for(let a=0;a<64;a++){
  if(s===d||s===a||touching(a,d))continue;
  const status=verdict(piece,s,d,a);
  const nativeStatus={playing:'playing',won:'checkmate',draw:'stalemate'}[status];
  truth.update([color,piece,s,d,a,nativeStatus].join(' ')+'\n');
  const seq=seen++;
  if(seq%shards!==shard||checked>=limit)continue;
  text[encode(s)]=color+piece;text[encode(d)]=color==='w'?'bk':'wk';text[encode(a)]=color+'k';
  const board=text.join(',')+',';
  text[encode(s)]='';text[encode(d)]='';text[encode(a)]='';
  // Distinguish false admission of the two alternate status claims from failure
  // to accept the correct result. Only the trusted referee supplies the label.
  for(const claim of ['playing','draw','won']){
    const [r]=rules.simulate([{...request,data:{text:board,color,status:claim}}]).cases;
    const error=r.unsupported||r.resourceLimit||(r.decision==='DENY'&&r.trace.some(t=>t.verdict==='ERROR'));
    const correct=!error&&((r.decision==='ALLOW')===(claim===status));
    if(error)runtimeErrors++;
    if(!correct){mismatches++;first??={color,piece,s,d,a,status,claim,decision:r.decision,error:Boolean(error)};}
    const key=claim+'-'+r.decision+(error?'-error':'');counts[key]=(counts[key]??0)+1;
    scores.update([seq,claim,r.decision,r.evaluatedExpressions,Boolean(error)].join(' ')+'\n');
  }
  checked++;
}
assert.equal(seen,native.positions);
assert.equal(truth.digest('hex'),native.sha256);
console.log(JSON.stringify({authority:'isolated compiled Rules helper under pinned independent local evaluator',bundleSha256:sha(full),helperScopeSha256:sha(specimen),
  functions:[...needed.keys()],nativeSha256:native.sha256,shard,shards,available:seen,checked,writes:checked*3,runtimeErrors,mismatches,first,counts,scoreSha256:scores.digest('hex')},null,2));
