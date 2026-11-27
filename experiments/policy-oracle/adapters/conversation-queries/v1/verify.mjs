import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {manifest,sha,versionNs} from '../../../arcade/corpus.mjs';
import {checkIdentity,databasePath,releaseName,wireFields} from '../../arcade-sdk/v1/evidence.mjs';
import {directory,revision,root,rulesFor} from '../../ai-jrpg-campaign/v1/catalog.mjs';
import {fields} from '../../ai-jrpg-campaign/v1/values.mjs';
import {family,steps} from './fixture.mjs';

const [probe,receipt] = process.argv.slice(2);
const run = JSON.parse(readFileSync(receipt));
const variant = 'genkit';
assert.equal(resolve(probe), join(root,directory(family,variant)));
assert.equal(run.variant, variant);
assert.equal(run.family, family);
assert.equal(run.revision, revision);
assert.deepEqual(run.target, manifest.target);
assert.equal(run.sdk, manifest.target.sdk);
assert.equal(run.endpoint, 'firestore.googleapis.com');
assert.match(run.runId,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const roles = ['a','b','c'];
assert.deepEqual(Object.keys(run.identities).sort(), roles);
const uids = Object.fromEntries(roles.map(role => {
  checkIdentity(run.identities[role]);
  return [role,run.identities[role].uid];
}));
assert.equal(new Set(Object.values(uids)).size,roles.length);
assert.deepEqual(run.ctx,{uids,runId:run.runId,variant,
  emails:Object.fromEntries(roles.map(role=>[role,role+'-'+run.runId+'@example.invalid']))});
assert.equal(run.marker,'mapPins/'+uids.a);

const closed = manifest.target.closedRuleset, open = run.phases.open;
const active = open.proof.rulesetName;
assert.ok(active.startsWith('projects/'+manifest.target.project+'/rulesets/'));
assert.match(active.split('/').at(-1), /^[a-f0-9-]{36}$/);
assert.notEqual(active,closed);
function proof(proof,isOpen) {
  assert.equal(proof.databaseUid,manifest.target.uid);
  assert.equal(proof.releaseName,releaseName);
  assert.equal(proof.rulesetName,isOpen ? active : closed);
  assert.equal(proof.rulesSha256,isOpen ? sha(rulesFor(variant)) : manifest.files['v1/rules/closed.rules']);
  assert.equal(proof.lockRunId,run.runId);
  assert.equal(proof.lockVersion,open.proof.lockVersion);
  versionNs(proof.lockVersion);
  versionNs(proof.releaseUpdateTime);
  return versionNs(proof.verifiedAt);
}
for (const name of ['initially-closed','open','restored-closed']) {
  const phase = run.phases[name];
  assert.equal(phase.phase,name);
  assert.equal(phase.write,name === 'open' ? 'ALLOW' : 'DENY');
  assert.equal(phase.read,phase.write);
  assert.ok(proof(phase.proof,name === 'open') <= versionNs(phase.at));
}
assert.ok(versionNs(run.phases['initially-closed'].at) <= versionNs(open.proof.verifiedAt));
for (const witness of [run.beforeProof,run.afterProof]) {
  proof(witness,true);
  assert.equal(witness.releaseUpdateTime,open.proof.releaseUpdateTime);
  assert.equal(witness.propagationReceiptSha256,sha(JSON.stringify(open,null,2)+'\n'));
}
let clock = versionNs(run.beforeProof.verifiedAt);
assert.ok(clock-versionNs(open.at) >= 100000000000n);

const plan = steps(run.ctx);
const rooms = plan[0].watch;
const sameKeys = (object,keys) => assert.deepEqual(Object.keys(object).sort(),[...keys].sort());
sameKeys(run.seed, rooms);
sameKeys(run.rows, plan.map(step=>step.id));
const previous = new Map(rooms.map(path=>{
  assert.equal(run.seed[path].document,null);
  return [path,run.seed[path]];
}));
const results = {};
for (const step of plan) {
  const row = run.rows[step.id];
  assert.deepEqual(row.step,step);
  assert.ok(clock <= versionNs(row.started) && versionNs(row.started) <= versionNs(row.finished));
  clock = versionNs(row.finished);
  sameKeys(row.before,rooms);
  sameKeys(row.after,rooms);
  for (const path of rooms) {
    const before = row.before[path], after = row.after[path];
    assert.deepEqual(before.document,previous.get(path).document);
    assert.ok(versionNs(previous.get(path).readTime) <= versionNs(before.readTime));
    assert.ok(versionNs(before.readTime) <= versionNs(after.readTime));
    if (step.op !== 'query' && path === step.path) {
      assert.deepEqual(row.response,{verdict:'ALLOW',code:'ok',value:null}, 'required room write '+step.id);
      const doc = after.document;
      assert.equal(doc.name,databasePath+'/documents/'+path);
      assert.deepEqual(doc.fields,wireFields(step.data));
      assert.ok(versionNs(before.readTime) <= versionNs(doc.updateTime) && versionNs(doc.updateTime) <= versionNs(after.readTime));
      if (step.op === 'set') {
        assert.equal(before.document,null);
        assert.equal(doc.createTime,doc.updateTime);
      } else {
        assert.equal(doc.createTime,before.document.createTime);
        assert.ok(versionNs(before.document.updateTime) < versionNs(doc.updateTime));
      }
    } else assert.deepEqual(after.document,before.document);
    previous.set(path,after);
  }
  let observed;
  if (step.op !== 'query') observed = 'ALLOW';
  else if (row.response.verdict === 'DENY') {
    assert.deepEqual(row.response,{verdict:'DENY',code:'permission-denied'});
    observed = 'DENY';
  } else {
    const returned = [];
    for (const path of rooms) {
      const data = fields(row.before[path].document);
      const selected = step.filters.every(([,op,operand]) => {
        if (op === 'array-contains') return data.memberIds.includes(operand);
        assert.equal(op,'array-contains-any');
        return operand.some(uid => data.memberIds.includes(uid));
      });
      if (selected) returned.push({id:path.split('/').at(-1),path,data});
    }
    assert.deepEqual(row.response,{verdict:'ALLOW',code:'ok',value:returned});
    observed = {verdict:'ALLOW',matches:returned.map(doc=>rooms.indexOf(doc.path))};
  }
  assert.deepEqual(row.decision,observed);
  results[step.id] = observed;
}
assert.ok(clock <= versionNs(run.afterProof.verifiedAt));
assert.ok(versionNs(run.afterProof.verifiedAt) <= versionNs(run.phases['restored-closed'].proof.verifiedAt));
console.log(JSON.stringify(results));
