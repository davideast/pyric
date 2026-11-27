import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [sdk,file]=process.argv.slice(2);
const {firestoreRules}=await import(pathToFileURL(resolve(sdk,'dist/index.js')));
const source=readFileSync(file,'utf8');
const anchor='  match /databases/{database}/documents {';
assert.equal(source.split(anchor).length,2);
const probe=firestoreRules(source.replace(anchor,()=>anchor+`
    match /reviewDense/{id} {
      allow update: if request.resource.data.w ? denseNoInterpositionw(request.resource.data.t) : denseNoInterpositionb(request.resource.data.t);
    }`));
const bytes=readFileSync(0),rows=JSON.parse(bytes);
const sha=b=>createHash('sha256').update(b).digest('hex');
const unexpected=[],failures=[];
for(const r of rows){
  const [placement,side]=r.fen.split(' ');
  const t=placement.split('/').reverse().map(rank=>{
    let cells='';
    for(const c of rank){
      if(c>='1' && c<='8') cells+=','.repeat(Number(c));
      else cells+=(c===c.toUpperCase()?'w':'b')+c.toLowerCase()+',';
    }
    return cells+'#,#,';
  }).join('');
  const answer=probe.simulate([{description:r.family,method:'update',path:'reviewDense/a',auth:{uid:'referee'},resource:{},
    data:{w:side==='w',t},expectation:'DENY'}]).cases[0];
  if(answer.resourceLimit || answer.unsupported || answer.trace.some(rule=>rule.verdict==='ERROR')) failures.push(r);
  else if(answer.decision!=='DENY') unexpected.push(r);
}
console.log(JSON.stringify({rulesSha256:sha(source),inputsSha256:sha(bytes),boards:rows.length,
  incorrectTriggers:unexpected.length,evaluationErrors:failures.length,firstIncorrect:unexpected[0]??null,firstError:failures[0]??null}));
