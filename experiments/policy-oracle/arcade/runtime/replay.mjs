import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { manifestDigest, json, read, sha, verifyInputs } from '../corpus.mjs';
import { importReceipt } from '../receipts.mjs';
import { score } from './score.mjs';

const {values} = parseArgs({options:{
  json:{type:'boolean'},modules:{type:'string'},receipt:{type:'string'},
}});
verifyInputs();
const ledger = json('v1/ledger.json');
assert.equal(ledger.manifestSha256,manifestDigest);
const batches = ['zero','four'].map(batch=>{
  const bytes = read('v1/observations/'+batch+'.json');
  assert.equal(sha(bytes),ledger.observations[batch].normalizedSha256,'observation digest: '+batch);
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.rawSha256,ledger.observations[batch].rawSha256,'original receipt digest: '+batch);
  if(batch==='four' && values.receipt) return importReceipt('four',readFileSync(values.receipt));
  return receipt;
});
const result = score(batches, values.modules);
const originals = result.rows.filter(r=>r.id.startsWith('zero/'));
const oldMatches = originals.filter(r=>r.live===r.mutant).length;
const coverage = result.claims.filter(c=>c.evidenced).length;
const conforming = result.claims.filter(c=>c.conforms).length;
const summary = {
  manifestSha256:manifestDigest,evidenceCoverage:[coverage,result.claims.length],
  conformance:[conforming,coverage],baselineMutationMatches:[oldMatches,originals.length],
  correctDecisions:result.rows.filter(r=>r.ok).length,
  mutationFalseAllows:result.rows.filter(r=>r.live==='DENY' && r.mutant==='ALLOW').length,
  mutationFalseDenials:result.rows.filter(r=>r.live==='ALLOW' && r.mutant==='DENY').length,
};
if(values.json) console.log(JSON.stringify({...summary,...result},null,2));
else {
  console.table(result.rows.map(({id,role,before,after,live,stored,simulated,mutant})=>({id,role,before,after,live,stored,simulated,mutant})));
  console.log('Evidence coverage',summary.evidenceCoverage.join('/'),'| Conformance',summary.conformance.join('/'),
    '| Constant-counter agreement on original writes',summary.baselineMutationMatches.join('/'));
  console.log('Constant-counter false allows',summary.mutationFalseAllows,'| false denials',summary.mutationFalseDenials);
  for(const [name,example] of [['First false allow',result.firstFalseAllow],['First false denial',result.firstFalseDenial]]) {
    console.log(name, JSON.stringify(example?.input ?? null));
  }
}
if(oldMatches!==9 || !result.firstFalseAllow || !result.firstFalseDenial || conforming!==2) process.exitCode=1;
