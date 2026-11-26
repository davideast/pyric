import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {steps,traces,stamp,sourceKind,digest,canonical} from './fixtures.mjs';
import {classify} from '../../exploration/classify.mjs';

const [packageDir,rules]=process.argv.slice(2);
assert.ok(packageDir&&rules,'usage: bun measure.mjs INSTALLED_REFEREE COMPLETE_RULES');
execFileSync('python3',[fileURLToPath(new URL('../../exploration/v1/verify-simulator.py',import.meta.url)),packageDir]);
const {firestoreRules}=await import(pathToFileURL(resolve(packageDir,'dist/index.js')));
const code=readFileSync(rules),handle=firestoreRules(code.toString());
const frozen=JSON.parse(readFileSync(new URL('freeze.json',import.meta.url)));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const counts={},families={},byTrace={},first={},certifiedForks={},followups={},uninterrupted={};
const events=createHash('sha256');
let positive=0,controls=0,afterFirstRefusal=0,refusedForks=0,openAtPrefix=0;
const bump=(obj,key)=>obj[key]=(obj[key]??0)+1;
function evaluate(path,step,actor,data,prior,expected) {
  const [r]=handle.simulate([{description:step.id,method:step.method,path,auth:{uid:actor},data,
    ...(prior&&{resource:prior}),requestTime:stamp,expectation:expected?'ALLOW':'DENY'}]).cases;
  return {decision:r.decision,status:classify(r,expected).kind,expressions:r.evaluatedExpressions};
}
for(const trace of traces){
  let head=null,open=true,acceptedPrefix=0,lastGood=null,firstRefusal=null,follow=[];
  const path='chess/game-'+trace.name,source=sourceKind(trace),seenForks=new Set();
  const heads=createHash('sha256'),requests=createHash('sha256'),decisions=createHash('sha256');
  const local={},localKinds={},localFirst={};
  const context=(s,k,extra)=>({trace:trace.name,source,kind:k,ply:s.ply,uci:s.uci??null,...extra});
  function record(step,kind,judged) {
    bump(counts,judged.status);bump(local,judged.status);
    bump((families[kind]??={}),judged.status);bump((localKinds[kind]??={}),judged.status);
    decisions.update(canonical([step.ply,kind,judged])+'\n');
    events.update(canonical([trace.name,step.ply,kind,judged])+'\n');
  }
  for(const step of steps(trace)){
    heads.update(canonical([step.kind,step.ply,step.actor??null,step.after])+'\n');
    if(step.kind==='seed'){head=step.after;lastGood=digest(head);continue;}
    const {before}=step,oldHash=digest(before),expectedHash=digest(step.after);
    const continuousBefore=open;
    if(open)assert.equal(digest(head),oldHash,'committed prefix head');
    if(!open)afterFirstRefusal++;
    for(const fork of follow) {
      const attempt=evaluate(path,step,step.actor,step.submitted,fork.data,true);
      const label=fork.kind+'/'+attempt.decision;
      bump(followups,label);
      certifiedForks[fork.key].next={ply:step.ply,uci:step.uci??null,observed:attempt.decision,status:attempt.status,
        headBefore:digest(fork.data),headAfter:attempt.decision==='ALLOW'?expectedHash:digest(fork.data)};
    }
    follow=[];
    requests.update(canonical([step.ply,step.method,oldHash,step.kind,step.actor,digest(step.submitted),true])+'\n');
    const actual=evaluate(path,step,step.actor,step.submitted,before,true);
    record(step,step.kind,actual);positive++;
    if(actual.status!=='match'){
      const row=context(step,step.kind,{...actual,before:oldHash,proposed:expectedHash,after:actual.decision==='ALLOW'?expectedHash:oldHash});
      first[actual.status]??=row;localFirst[actual.status]??=row;
      if(open)firstRefusal=row;
      open=false;
    } else if(open) {
      head=step.after;lastGood=digest(head);acceptedPrefix++;
    }
    for(const p of step.probes){
      controls++;
      const patch=digest(p.data);
      requests.update(canonical([step.ply,step.method,oldHash,p.kind,p.actor,patch,false])+'\n');
      const v=evaluate(path,step,p.actor,p.data,before,false);
      record(step,p.kind,v);
      if(v.decision==='DENY')refusedForks++;
      if(v.status!=='match') {
        const stored=step.method==='create'?{...p.data,createdAt:step.after.createdAt}:p.data;
        const row=context(step,p.kind,{...v,before:oldHash,submitted:patch,
          after:v.decision==='ALLOW'?digest(stored):oldHash,onUninterruptedBefore:continuousBefore});
        first[v.status]??=row;localFirst[v.status]??=row;
        if(v.decision==='ALLOW'&&!seenForks.has(p.kind)) {
          seenForks.add(p.kind);
          const key=trace.name+'/'+p.kind;
          certifiedForks[key]={...row,reportedStatus:stored.status,reportedTurn:stored.currentTurn,
            differsFromHonestHead:digest(stored)!==expectedHash,next:{status:'end-of-trace'}};
          follow.push({kind:p.kind,key,data:stored});
        }
      }
    }
    // Probe branches never change the canonical line. A refused canonical
    // step ends its reachable prefix. Subsequent requests use frozen truth.
    assert.equal(digest(before),oldHash,'evaluator changed supplied previous state');
  }
  const expected=frozen.records[trace.name];
  assert.equal(heads.digest('hex'),expected.headsSha256);
  assert.equal(requests.digest('hex'),expected.requestsSha256);
  if(open){openAtPrefix++;assert.equal(lastGood,expected.headSha256);}
  bump(uninterrupted,source+'/'+(open?'complete':'refused'));
  byTrace[trace.name]={source,acceptedPrefix,fullPrefix:open,firstRefusal,local,
    lastAcceptedHead:lastGood,expectedFinalHead:expected.headSha256,first:localFirst,decisionsSha256:decisions.digest('hex')};
}
assert.equal(positive,frozen.positiveWrites);assert.equal(controls,frozen.invalidProposals);
console.log(JSON.stringify({authority:'independent pinned local evaluator; modeled per-attempt stored document',
  rulesSha256:sha(code),nativeSha256:frozen.sha256,traces:traces.length,positiveWrites:positive,negativeProbes:controls,
  matchedAll:Object.keys(counts).every(v=>v==='match'),outcomes:counts,uninterrupted,completePrefixes:openAtPrefix,
  resynchronizedPositiveWrites:afterFirstRefusal,refusedProbeHeadsPreserved:refusedForks,first,families,
  corruptForkNextHonestMove:followups,byTrace,certifiedForks,decisionsSha256:events.digest('hex')},null,2));
