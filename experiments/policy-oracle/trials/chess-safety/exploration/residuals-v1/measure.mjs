import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {position} from '../../../chess/reference/score.mjs';
import * as native from '../../../chess/reference/native.mjs';
import {squareOf} from '../../../chess/reference/arcade-reference.ts';
import {sample} from '../../reference/fixtures.mjs';
import {sampleRights} from '../rights-claims-v1/fixture.mjs';
import {classify} from '../classify.mjs';

const [sdk,file,referenceReport]=process.argv.slice(2);
const expected=JSON.parse(readFileSync(referenceReport));
const code=readFileSync(file);
const sha=v=>createHash('sha256').update(v).digest('hex');
assert.equal(sha(code),expected.rulesSha256);
const {firestoreRules}=await import(pathToFileURL(resolve(sdk,'dist/index.js')));
const judge=firestoreRules(code.toString()), unique=new Map();
const frequencies={},cohorts={},canonical=v=>v&&typeof v==='object'
  ? Array.isArray(v)?v.map(canonical):Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const count=(map,key)=>map[key]=(map[key]??0)+1;
function explain(c,result,pending) {
  if(result.cause==='resource-limit')return {obligation:'evaluation-budget'};
  if(!c.nativeLegal)return {obligation:c.claimedRights!==undefined?'castling-rights-transition':'move-admission'};
  const future=position(c.successor),reply=native.legalMoves(future).sort();
  assert.equal(reply.length,c.replyCount);
  if(c.replySha256)assert.equal(sha(JSON.stringify(reply)),c.replySha256);
  if(c.replies)assert.deepEqual(reply,c.replies);
  assert.equal(native.outcome(future),c.outcome);
  const witnessKinds=[...new Set(reply.map(m=>future.board[squareOf(m.slice(0,2))][1]))].sort();
  let obligation='move-admission';
  if(result.status==='false-allow'){
    if(pending.status==='playing'&&c.outcome!=='playing')obligation='reject-playing-after-'+c.outcome;
    else if(c.outcome==='playing'&&pending.status!=='playing')obligation='refute-'+pending.status+'-with-legal-reply';
    else obligation='result-claim';
  }else if(result.status==='false-refusal')obligation='permit-legal-result';
  return {obligation,witnessKinds,legalReplies:reply};
}

for(const [name,freezeScore] of Object.entries(expected.cohorts)) {
  assert.match(name,/^[a-z0-9-]+$/);
  const folder=new URL('../'+name+'/',import.meta.url);
  const bytes=gunzipSync(readFileSync(new URL('corpus.json.gz',folder)));
  const pin=JSON.parse(readFileSync(new URL('freeze.json',folder)));
  assert.equal(sha(bytes),pin.sha256??pin.inputsSha256);
  const rows=JSON.parse(bytes),stream=createHash('sha256'),ordered=[],outcomes={};
  for(const c of rows){
    const rights=name==='rights-claims-v1',self=name==='self-check-v1';
    const {before,proposal}=(rights?sampleRights:sample)(c,'writer','other');
    const pending={...before,...proposal};
    const req={description:c.id,path:self?'chess/oracle':'chess/explore',method:'update',auth:{uid:'writer'},
      resource:before,data:pending,expectation:'ALLOW'};
    const [observed]=judge.simulate([req]).cases;
    const r=classify(observed,c.nativeAdmission),cost=observed.evaluatedExpressions;
    count(outcomes,r.kind);
    // Reproduce each original scorer's ordered decision digest, including cost.
    if(self)stream.update(JSON.stringify([c.id,observed.decision,r.cause,cost])+'\n');
    else ordered.push(rights?[c.id,observed.decision,r.kind,cost]:[c.id,observed.decision,r.status,r.cause,cost]);
    if(r.status==='match')continue;
    const explanation=explain(c,r,pending);
    count(frequencies,explanation.obligation);
    // A document alias may itself influence a submitted program. Preserve the
    // complete evaluator input when identifying repeated writes.
    const key=sha(JSON.stringify(canonical([req.path,req.method,req.auth,before,pending])));
    const observation={fen:c.fen,uci:c.uci,claim:{status:pending.status,winner:pending.winner},
      nativeAdmission:c.nativeAdmission,observed:observed.decision,outcome:r.kind,localCost:cost,...explanation};
    const existing=unique.get(key);
    if(existing) {
      for(const field of ['nativeAdmission','observed','outcome','localCost'])assert.equal(existing.observation[field],observation[field]);
      if(!existing.observation.legalReplies&&observation.legalReplies)existing.observation=observation;
    }else unique.set(key,{observation,occurrences:[]});
    unique.get(key).occurrences.push({cohort:name,id:c.id});
  }
  assert.equal(rows.length,freezeScore.cases);
  assert.deepEqual(outcomes,freezeScore.outcomes);
  const digest=name==='self-check-v1'?stream.digest('hex'):sha(JSON.stringify(ordered));
  assert.equal(digest,freezeScore.decisionsSha256,name+' independent replay');
  cohorts[name]={cases:rows.length,decisionsSha256:digest};
}
const records=[...unique].map(([writeSha256,row])=>({writeSha256,...row}));
const obligations={},replyFamilies={},examples={};
for(const {writeSha256,observation:r,occurrences} of records) {
  count(obligations,r.obligation);
  if(r.obligation.startsWith('refute-'))count(replyFamilies,(r.witnessKinds??[]).join('+'));
  const pieces=position(r.fen).board.filter(Boolean).length;
  if(!examples[r.obligation]||pieces<examples[r.obligation].pieces)examples[r.obligation]={writeSha256,pieces,...r,first:occurrences[0]};
}
console.log(JSON.stringify({authority:'independent local full Rules evaluator joined with frozen native reply lists',
  rulesSha256:expected.rulesSha256,cohorts,caseOccurrences:frequencies,distinctWrites:records.length,
  obligations,replyFamilies,examples,recordsSha256:sha(JSON.stringify(records))},null,2));
