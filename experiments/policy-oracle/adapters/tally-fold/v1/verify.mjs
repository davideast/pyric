import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {manifest,sha,versionNs} from '../../../arcade/corpus.mjs';
import {checkIdentity,databasePath,releaseName} from '../../arcade-sdk/v1/evidence.mjs';
import {fields} from '../../ai-jrpg-campaign/v1/values.mjs';
import {cases,moves} from './fixture.mjs';

const r = JSON.parse(readFileSync(process.argv[3]));
assert.deepEqual(r.target,manifest.target);
assert.equal(r.sdk,r.target.sdk);
assert.match(r.runId,/^[a-f0-9-]{36}$/);
assert.equal(r.digest,sha(readFileSync(new URL('generated.rules',import.meta.url))));
const {writer,reader} = r.identities;
checkIdentity(writer); checkIdentity(reader);
assert.notEqual(writer.uid,reader.uid);
const open = r.phases.open.proof;
assert.notEqual(open.rulesetName,r.target.closedRuleset);
for (const [phase,want] of [['initially-closed','DENY'],['open','ALLOW'],['restored-closed','DENY']]) {
  const {proof,read,write} = r.phases[phase];
  assert.equal(read,want); assert.equal(write,want);
  assert.equal(proof.rulesSha256,phase === 'open' ? r.digest : manifest.files['v1/rules/closed.rules']);
  assert.equal(proof.rulesetName,phase === 'open' ? open.rulesetName : r.target.closedRuleset);
  assert.equal(proof.lockRunId,r.runId);
  assert.equal(proof.lockVersion,open.lockVersion);
  assert.equal(proof.databaseUid,r.target.uid);
  assert.equal(proof.releaseName,releaseName);
}
for (const p of [r.beforeProof,r.afterProof]) {
  const {verifiedAt,propagationReceiptSha256,...rest} = p;
  assert.deepEqual({...rest,verifiedAt:open.verifiedAt},open);
  assert.equal(propagationReceiptSha256,sha(JSON.stringify(r.phases.open,null,2)+'\n'));
}
assert.deepEqual(Object.keys(r.rows).sort(),cases.map(c=>c.id).sort());
const output = {};
for (const c of cases) {
  const {path,before,after,decision,submitted} = r.rows[c.id];
  assert.equal(path,'tallyFolds/'+r.runId+'-'+c.id);
  assert.deepEqual(before.data,{owner:writer.uid,reader:reader.uid,tally:90,moves:[]});
  assert.deepEqual(submitted,{moves:moves(c),tally:c.claim});
  for (const {data,document} of [before,after]) {
    assert.equal(document.name,databasePath+'/documents/'+path);
    assert.deepEqual(fields(document),data);
  }
  if (decision === 'DENY') assert.deepEqual(before,after);
  else {
    assert.equal(decision,'ALLOW');
    assert.deepEqual(after.data,{...before.data,...submitted});
    assert.equal(after.document.createTime,before.document.createTime);
    assert.ok(versionNs(after.document.updateTime) > versionNs(before.document.updateTime));
  }
  output[c.id] = decision;
}
console.log(JSON.stringify(output));
