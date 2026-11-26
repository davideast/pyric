import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ending,squares,touching} from './geometry.mjs';

const [simulator,bundle]=process.argv.slice(2);
const {firestoreRules}=await import(pathToFileURL(resolve(simulator,'dist/index.js')));
const rules=readFileSync(bundle,'utf8');
const sha=s=>createHash('sha256').update(s).digest('hex');
function emitted(name) {
  const m=rules.match(new RegExp('^  function '+name+'\\([^{}]*\\) \\{[^{}]*?^  \\}', 'm'));
  assert.ok(m,'Missing emitted helper '+name);
  return m[0];
}
function judge(fn,guard) {
  return firestoreRules("rules_version = '2'; service cloud.firestore { "+fn+
    " match /databases/{db}/documents/tests/{id} { allow update: if "+guard+"; } }");
}
const operation={description:'endgame',method:'update',path:'tests/position',auth:{uid:'player'},resource:{},expectation:'ALLOW'};
function check(handle,data,wanted) {
  const [r]=handle.simulate([{...operation,data}]).cases;
  assert.ok(!r.unsupported&&!r.resourceLimit);
  assert.equal(r.trace.some(t=>t.verdict==='ERROR'),false);
  assert.equal(r.decision,wanted?'ALLOW':'DENY',JSON.stringify(data));
}
const index=s=>s%8+Math.floor(s/8)*10;
const stats={rulesSha256:sha(rules),tableWrites:0,pairWrites:0};
const tableDigest=createHash('sha256');
for(let s=0;s<64;s++){
  const name='table'+squares[s],fn=emitted(name);
  tableDigest.update(fn);
  const h=judge(fn,name+'(request.resource.data.key, request.resource.data.queen) == request.resource.data.status');
  for(let d=0;d<64;d++)for(let a=0;a<64;a++){
    if(s===d||s===a||touching(a,d))continue;
    for(const queen of [false,true]){
      const truth=ending(s,d,a,queen), key=index(d)*100+index(a);
      for(const status of ['playing','won','draw']){
        check(h,{key,queen,status},truth===status);
        stats.tableWrites++;
      }
    }
  }
}
stats.tablesDigest=tableDigest.digest('hex');
const pair=emitted('pairKey');
stats.pairDigest=sha(pair);
const h=judge(pair,'pairKey(request.resource.data.text, request.resource.data.color) == request.resource.data.key');
for(const color of ['w','b'])for(let d=0;d<64;d++)for(let a=0;a<64;a++){
  if(a===d)continue;
  const cells=Array(80).fill('');
  for(let r=0;r<8;r++)cells[r*10+8]=cells[r*10+9]='#';
  cells[index(a)]=color+'k';cells[index(d)]=(color==='w'?'b':'w')+'k';
  const slider=(a+1)%64;
  if(slider!==d)cells[index(slider)]=color+'q';
  const text=cells.join(',')+',',key=index(d)*100+index(a);
  check(h,{text,key,color},true);check(h,{text,key:key+1,color},false);
  stats.pairWrites+=2;
}
console.log(JSON.stringify(stats,null,2));
