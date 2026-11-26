import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {sha} from '../../../arcade/corpus.mjs';
import {compareAdmission} from './admission.mjs';

const here=dirname(fileURLToPath(import.meta.url));

// This is a candidate comparison against previously verified bytes. New cloud
// evidence always enters through receipts.mjs and the private controller journal.
export async function scoreHosted({rulesDirectory, registry=join(here,'releases'), simulator, policiesDirectory=join(here,'../policies')}) {
  const {SimulateFirestoreRulesHandler}=await import(pathToFileURL(resolve(simulator,'dist/simulator/handler.js')));
  const {checkRulesSource}=await import(pathToFileURL(resolve(simulator,'dist/grammar/source-compile-limits.js')));
  const handler=new SimulateFirestoreRulesHandler();
  const reports=[];
  for (const name of readdirSync(registry).filter(n=>n.endsWith('.json') && n!=='stock-discovery.json').sort()) {
    const pin=JSON.parse(readFileSync(join(registry,name)));
    const rules=readFileSync(join(rulesDirectory,pin.report.mode+'.rules'),'utf8');
    const checked=checkRulesSource(rules);
    assert.ok(checked.ok,name+' candidate failed to compile');
    const bytes=gunzipSync(readFileSync(join(registry,pin.receipt+'.json.gz')));
    assert.equal(sha(bytes),pin.receipt);
    const receipt=JSON.parse(bytes);
    assert.deepEqual([receipt.mode,receipt.rulesSha256,receipt.runId],[pin.report.mode,pin.report.rulesSha256,pin.report.runId]);
    const missed=[];
    const signedOut=JSON.parse(readFileSync(join(registry,'../reads',pin.receipt+'.json')));
    assert.equal(signedOut.kind,'unauthenticated-read');
    assert.deepEqual(signedOut.data,{path:'chess/'+receipt.runId,observed:'DENY'});
    let reads=0;
    const checkRead=(id,path,resource,uid,observed)=>{
      const c={description:id,path,method:'get',expectation:observed,auth:uid?{uid}:null,...(resource && {resource})};
      const run=handler.simulateParsed(checked.ast,rules,[c]);
      assert.ok(run.success);
      const result=run.data.results[0];
      const actual=result.state==='UNSUPPORTED'||result.resourceLimit?'UNRESOLVED':result.decision;
      if(actual!==observed) missed.push({id,expected:observed,actual});
      reads++;
    };
    checkRead('signed-out',signedOut.data.path,null,null,signedOut.data.observed);
    let engine,metadata,gateway=0;
    if(receipt.cohort==='boundary') {
      engine=await import(pathToFileURL(resolve(policiesDirectory,'chess.mjs')));
      metadata=await import(pathToFileURL(resolve(policiesDirectory,'chess-match.mjs')));
    }
    const rows=receipt.rows.map(row=>{
      const before=new Map(row.before.map(s=>[s.path,s.data]));
      const signedReader=row.reader || receipt.rows[0].reader;
      assert.ok(signedReader,'missing signed reader');
      for(const phase of ['before','after']) {
        for(const snap of row[phase]) checkRead(row.id+' '+phase+' '+snap.path,snap.path,snap.data,signedReader,'ALLOW');
      }
      const ops=row.submitted ?? (row.proposal?[{path:row.before[0].path,op:'update',data:row.proposal}]:null);
      assert.ok(ops,row.id+' missing submitted operation');
      if(ops[0].op==='referee-move'){
        assert.equal(ops.length,1);
        const prediction=compareAdmission(row,engine,metadata);
        gateway++;
        if(row.observed!==prediction.decision || row.requirement!==prediction.requirement || row.status!==prediction.status || !prediction.storedMatch) {
          missed.push({id:row.id,expected:row.observed,actual:prediction.decision,requirement:row.requirement,prediction});
        }
        return {id:row.id,layer:'gateway',hosted:row.observed,candidate:prediction.decision};
      }
      const after=new Map(),cases=[];
      for(const op of ops){
        const previous=before.get(op.path);
        assert.notEqual(previous,undefined,row.id+' missing pre-write snapshot');
        let data=op.op==='delete' ? null : op.op==='update'?{...previous,...op.data}:{...op.data};
        for(const field of op.serverTimestamp ?? []) data[field]={__type:'serverTimestamp'};
        after.set(op.path,data);
        cases.push({description:row.id,expectation:'ALLOW',method:op.op==='delete'?'delete':previous===null?'create':'update',
          path:op.path,auth:{uid:row.actor},requestTime:row.proof.verifiedAt,...(previous && {resource:previous}),...(data && {data})});
      }
      const unknown=new Set();
      const options={getDoc:path=>{
        if(!before.has(path)) {
          // A case can reference a prior match that the operation did not need
          // to read back. Refuse to infer its contents.
          unknown.add(path);
          throw Error('Missing lookup witness '+path+' in '+row.id);
        }
        return before.get(path);
      },batchProjection:after};
      const verdicts=cases.map(c=>{
        const result=handler.simulateParsed(checked.ast,rules,[c],options);
        assert.ok(result.success,JSON.stringify(result));
        const node=result.data.results[0];
        return {decision:node.decision,unsupported:node.state==='UNSUPPORTED',budget:node.resourceLimit||null};
      });
      assert.equal(unknown.size,0,'uncaptured lookup for '+row.id+': '+[...unknown].join(', '));
      const simulated=verdicts.some(v=>v.unsupported || v.budget) ? 'UNRESOLVED' : verdicts.every(v=>v.decision==='ALLOW')?'ALLOW':'DENY';
      if(row.observed!==simulated) missed.push({id:row.id,expected:row.observed,actual:simulated,operations:verdicts});
      return {id:row.id,hosted:row.observed,candidate:simulated};
    });
    reports.push({profile:receipt.mode,...(receipt.cohort && {cohort:receipt.cohort}),receipt:pin.receipt,deployedRules:receipt.rulesSha256,candidateRules:sha(rules),rows,reads,sdkWrites:rows.length-gateway,gatewayRequests:gateway,
      falseAllows:missed.filter(m=>m.expected==='DENY' && m.actual==='ALLOW').length,
      falseDenials:missed.filter(m=>m.expected==='ALLOW' && m.actual==='DENY').length,
      unresolved:missed.filter(m=>m.actual==='UNRESOLVED').length,mismatches:missed});
  }
  assert.ok(reports.length,'registered complete cloud releases required');
  return reports;
}

if(import.meta.main) {
  const [rulesDirectory,simulator,registry]=process.argv.slice(2);
  if(!rulesDirectory || !simulator) throw Error('Usage: bun score-hosted.mjs RULES_DIR REFERENCE_RULES_INSTALL [REGISTRY]');
  const report=await scoreHosted({rulesDirectory,simulator,registry});
  console.log(JSON.stringify(report,null,2));
  if(report.some(p=>p.mismatches.length)) process.exitCode=1;
}
