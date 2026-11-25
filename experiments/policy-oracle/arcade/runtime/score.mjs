import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { firestoreRules, timestamp } from '@pyric/rules';
import { compilePolicy } from '@pyric/rules/experimental/policy';
import { resolveModules } from './node_modules/arcade-bundler/dist/rules/modules/resolver.js';
import { json, read, manifest, sha } from '../corpus.mjs';
import { checkBatch } from '../receipts.mjs';

const bindings = manifest.bindings;
function resolved(moduleSource) {
  assert.equal(sha(read('v1/imports.json')),'4a7cfeef2806a46aa8c7353a5401ead5e21a71557e9b437a3ff9af2852811989');
  const sources = json('v1/imports.json');
  sources.modules['../games/tictactoe/move-counter'] = moduleSource;
  const result = resolveModules(sources.root,{modules:sources.modules,sourceFile:'firestore.modules.rules'});
  assert.ok(result.success,result.error?.message);
  return result.data.resolved;
}
function typed(doc) {
  const {seconds,nanoseconds} = doc.createdAt;
  assert.equal(nanoseconds,0,'v1 static fixture timestamp precision');
  return {...doc,createdAt:timestamp(new Date(seconds*1000).toISOString())};
}
export function verdict(handle, row) {
  const input = {description:row.id,method:'update',path:'tictactoe/'+row.id.replaceAll('/','-'),
    auth:{uid:row.role==='host'?'HOST':'GUEST'}, resource:typed(row.before),data:typed(row.proposal),
    expectation:row.decision};
  const results = handle.simulate([input]).cases;
  assert.equal(results.length,1);
  const [result] = results;
  assert.ok(!result.unsupported && !result.resourceLimit && ['ALLOW','DENY'].includes(result.decision),
    'unscorable evaluation for '+row.id+': '+result.decision);
  return result.decision;
}
export function score(batches, moduleDir) {
  assert.deepEqual(batches.map(b=>b.batch),['zero','four']);
  for(const b of batches) checkBatch(b.batch,b);
  const controls = {stock:firestoreRules(read('v1/rules/stock.rules')),hand2:firestoreRules(read('v1/rules/hand2.rules'))};
  const revisions = {};
  for(const claim of manifest.claims) {
    const v = claim.generated, source = read('v1/rules/'+v+'.policy');
    const policy = compilePolicy(source);
    const emitted = policy.firestoreModule(bindings);
    assert.equal(emitted,read('v1/rules/'+v+'-module.rules'));
    assert.equal(sha(resolved(emitted)),manifest.files['v1/rules/'+v+'.rules'],'bundler bytes differ from production');
    const candidate = moduleDir ? readFileSync(resolve(moduleDir,v+'-module.rules'),'utf8') : emitted;
    const constant = source.replace('before.moveCount + '+claim.delta,String(claim.delta));
    assert.notEqual(constant,source);
    const mutated = compilePolicy(constant).firestoreModule(bindings);
    revisions[v] = {policy,candidate:firestoreRules(resolved(candidate)),mutant:firestoreRules(resolved(mutated)),sha256:sha(resolved(candidate))};
  }
  const rows = [], claims = [];
  const all = batches.flatMap(b=>b.cases);
  for(const claim of manifest.claims) {
    const {control,generated,delta} = claim;
    const {policy,candidate,mutant} = revisions[generated];
    const local = all.filter(r=>[control,generated].includes(r.id.split('/')[1]));
    let pass = true;
    for(const row of local) {
      const [batch,variant,name] = row.id.split('/');
      const expected = manifest.cases.find(c=>c.id===row.id).predicted;
      // When evaluating an alternate emitted module, run it on BOTH control
      // and generated examples. Those operations cover the same target grant.
      const simulated = verdict(candidate,row);
      const reference = verdict(controls[control],row);
      const altered = verdict(mutant,row);
      const independent = all.find(r=>r.id===batch+'/'+control+'/'+name);
      if(independent) {
        assert.deepEqual(independent.before,row.before);
        assert.deepEqual(independent.proposal,row.proposal);
        assert.equal(independent.role,row.role);
      }
      const required = row.proposal.moveCount===row.before.moveCount+delta;
      const judged = policy.judge({before:row.before,after:row.proposal,input:{}});
      const sourceOK = judged.ok===required && (required || judged.requirement==='nextMove');
      const ok = row.decision===expected && simulated===row.decision && reference===row.decision &&
        (!independent || row.decision===independent.decision) && sourceOK;
      if(!ok) pass=false;
      rows.push({id:row.id,variant,role:row.role,before:row.before.moveCount,after:row.proposal.moveCount,
        predicted:expected,live:row.decision,stored:row.stored.moveCount,reference,simulated,mutant:altered,sourceOK,ok});
    }
    claims.push({id:claim.id,evidenced:true,conforms:pass,candidateSha256:revisions[generated].sha256});
  }
  const order = manifest.cases.map(c=>c.id);
  rows.sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id));
  const mismatch = (live,mutated) => {
    const row = rows.find(r=>r.live===live && r.mutant===mutated);
    return row && {score:row, input:all.find(r=>r.id===row.id)};
  };
  return {claims,rows, firstFalseAllow:mismatch('DENY','ALLOW'),firstFalseDenial:mismatch('ALLOW','DENY')};
}
