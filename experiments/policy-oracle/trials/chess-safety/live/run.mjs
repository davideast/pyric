import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {manifest,sha} from '../../../arcade/corpus.mjs';
import {privateArchive} from '../../../arcade/live/controller/archive.mjs';
import {checkRows,comparable,qualify} from '../../for-of/live/evidence.mjs';
import {retain} from '../../for-of/live/retain.mjs';
import {reviewedPlan} from './fixtures.mjs';
import {failureObservations} from './failures.mjs';

const roles={host:'host',guest:'guest',observer:'observer'};

function verify(name, profile, archive) {
  const {plan,bundle,batches,fixtures,receipts}=profile;
  const bytes=readFileSync(new URL(name+'.json.gz',receipts));
  const pin=JSON.parse(readFileSync(new URL(name+'.pin.json',receipts)));
  assert.equal(sha(bytes),pin.receiptGzipSha256);
  const ev=JSON.parse(gunzipSync(bytes));
  assert.equal(ev.privateReceipt,pin.controllerSha256);
  assert.match(ev.privateReceipt,/^[0-9a-f]{64}$/);
  assert.match(ev.journalSha256,/^[0-9a-f]{64}$/);
  assert.equal(ev.mode,name);
  assert.equal(ev.rulesSha256,plan.rulesSha256);
  assert.equal(ev.targetDatabaseUid,manifest.target.uid);
  assert.equal(ev.restored,manifest.target.closedRuleset);
  const closed=manifest.files['v1/rules/closed.rules'];
  assert.deepEqual(ev.phases.map(p=>[p.phase,p.rulesSha256]),[
    ['initially-closed',closed],['open',ev.rulesSha256],['restored-closed',closed],
  ]);
  assert.deepEqual([ev.closure.leaseReleased,ev.closure.signedRead,ev.closure.signedWrite,ev.signedOutRead],
    [true,'DENY','DENY','DENY']);
  if(archive) assert.deepEqual(ev,qualify(privateArchive(archive),ev.privateReceipt,bundle,fixtures));
  checkRows(ev.rows,roles,id=>'chess/match-'+id,name,fixtures);
  const measurements={plan:name,receipt:ev.privateReceipt,readChecks:2*ev.rows.length+1,
    closureVerified:true,decisions:ev.rows.map(r=>({id:r.id,batch:batches.get(r.id),verdict:r.observed,
      versionChanged:r.after[0].version!==r.before[0].version}))};
  const operands=comparable(ev).map(({after,observed,...input})=>input);
  return {measurements,operands};
}

function report(archive, allowUnmeasured) {
  const answers=new Map(), captures=new Map(), repeat=new Set();
  const files=readdirSync(new URL('plans/',import.meta.url)).filter(f=>f.endsWith('.json')).sort();
  for(const file of files) {
    const name=file.slice(0,-5);
    if(allowUnmeasured) {
      const {rulesSha256}=JSON.parse(readFileSync(new URL('plans/'+file,import.meta.url)));
      assert.match(rulesSha256,/^[0-9a-f]{64}$/);
      if(!existsSync(new URL('receipts/'+rulesSha256+'/'+name+'.pin.json',import.meta.url))) continue;
    }
    const profile=reviewedPlan(name), sha=profile.plan.rulesSha256;
    const {measurements,operands}=verify(name,profile,archive);
    if(!captures.has(sha)) captures.set(sha,{outcomes:new Map(),reports:[]});
    const {outcomes:known,reports}=captures.get(sha);
    for(const {id,verdict} of measurements.decisions) {
      if(known.has(id)) assert.equal(known.get(id),verdict,name+' conflicting measurement for '+id);
      known.set(id,verdict);
    }
    for(const op of operands) {
      if(answers.has(op.id)) {
        assert.deepEqual(op,answers.get(op.id),name+' changed submitted inputs for '+op.id);
        repeat.add(op.id);
      } else answers.set(op.id,op);
    }
    reports.push(measurements);
  }
  // The previous file study qualified these ten exact request payloads on
  // production. Compare the newly normalized requests to those originals.
  const legacyUrl=new URL('../../king-safety/live/optimized/receipts/optimized.json.gz',import.meta.url);
  const legacy=JSON.parse(gunzipSync(readFileSync(legacyUrl)));
  const oldInputs=comparable(legacy).map(({after,observed,...input})=>input);
  assert.equal(oldInputs.length,10);
  const replayed=oldInputs.filter(row=>answers.has(row.id));
  for(const row of replayed) assert.deepEqual(answers.get(row.id),row,'legacy signed inputs '+row.id);
  return {authority:'live Firestore',privateJournalChecked:Boolean(archive),
    managementFailures:failureObservations(archive),
    legacyInputsReplayed:replayed.length,repeatedInputs:repeat.size, releases:[...captures].map(([rulesSha256,rows])=>({
      rulesSha256,status:'measured',distinctCases:rows.outcomes.size,captures:rows.reports}))};
}

const [operation,...args]=process.argv.slice(2);
if(operation==='measure') {
  const [name,archive]=args;
  assert.equal(args.length,2);
  const {measure}=await import('./measure.mjs');
  await measure(name,archive);
  const {measurements}=verify(name,reviewedPlan(name),archive);
  console.log('Replayed',measurements.decisions.length,'signed writes and closure',measurements.receipt);
} else if(operation==='capture' || operation==='retain') {
  const [name,archive,receipt]=args;
  const {plan,bundle,fixtures,receipts}=reviewedPlan(name);
  if(operation==='capture') {
    assert.equal(args.length,2);
    const {capture}=await import('../../for-of/live/capture.mjs');
    await capture([name,archive,bundle,plan.rulesSha256],fixtures);
  } else {
    assert.equal(args.length,3);
    retain([archive,receipt,bundle],fixtures,receipts);
    const bytes=readFileSync(new URL(name+'.json.gz',receipts));
    const pin=JSON.stringify({controllerSha256:receipt,receiptGzipSha256:sha(bytes)},null,2)+'\n';
    const path=new URL(name+'.pin.json',receipts);
    if(existsSync(path)) assert.equal(readFileSync(path,'utf8'),pin);
    else writeFileSync(path,pin,{flag:'wx'});
  }
} else {
  assert.ok(operation==='replay'||operation==='lookup');
  const digest=operation==='lookup' ? args.shift() : undefined;
  if(operation==='lookup') assert.match(digest,/^[0-9a-f]{64}$/);
  assert.ok(!args.length || (args.length===2 && args[0]==='--archive'));
  const result=report(args[1],operation==='lookup');
  const data=digest ? result.releases.find(r=>r.rulesSha256===digest)
    ?? {rulesSha256:digest,status:'unmeasured',distinctCases:0,captures:[]} : result;
  console.log(JSON.stringify(data,null,2));
}
