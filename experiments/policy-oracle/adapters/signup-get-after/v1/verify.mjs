import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {manifest, sha, versionNs} from '../../../arcade/corpus.mjs';
import {checkIdentity, databasePath, releaseName, wireFields} from '../../arcade-sdk/v1/evidence.mjs';
import {accounts, signup} from '../../atomic-signup/v1/fixture.mjs';
import {materialize, revision, seedTime, stamp} from '../../invite-profile/v1/fixture.mjs';
import {sources} from './sources.mjs';

const record = JSON.parse(readFileSync(process.argv[3]));
assert.deepEqual(record.target, manifest.target);
assert.equal(record.sdk, manifest.target.sdk);
assert.equal(record.endpoint, 'firestore.googleapis.com');
assert.equal(record.revision, revision);
assert.match(record.runId, /^[a-f0-9-]{36}$/);
assert.deepEqual(Object.keys(record.identities).sort(), [...accounts].sort());
for (const identity of Object.values(record.identities)) checkIdentity(identity);
const caller = record.identities.claimant.uid, reader = record.identities.reader.uid;
assert.notEqual(caller, reader);
const {paths, attempts} = signup(caller,record.runId);
const seed = {createdBy:reader, createdAt:sdkTime(seedTime), usedBy:null, usedAt:null};
const modes = Object.keys(sources);
assert.deepEqual(Object.keys(record.arms).sort(), [...modes].sort());

function sdkTime(iso) {
  const ns = versionNs(iso);
  return {type:'firestore/timestamp/1.0',seconds:Number(ns / 1000000000n),nanoseconds:Number(ns % 1000000000n)};
}
function checkReadbacks(snapshot) {
  assert.deepEqual(Object.keys(snapshot).sort(), Object.keys(paths).sort());
  for (const [role,path] of Object.entries(paths)) {
    const {data, document} = snapshot[role];
    assert.equal(snapshot[role].path, path);
    if (document === null) {
      assert.equal(data, null);
      continue;
    }
    assert.equal(document.name, databasePath + '/documents/' + path);
    assert.ok(versionNs(document.updateTime) >= versionNs(document.createTime));
    assert.deepEqual(Object.keys(data).sort(), Object.keys(document.fields).sort());
    for (const [field,wire] of Object.entries(document.fields)) {
      if ('timestampValue' in wire) assert.deepEqual(data[field], sdkTime(wire.timestampValue));
      else if (data[field] === null) assert.deepEqual(wire,{nullValue:null});
      else assert.deepEqual(wire, wireFields({[field]:data[field]})[field]);
    }
  }
}
function checkWrite(row, attempt) {
  assert.ok(['ALLOW','DENY'].includes(row.decision));
  const allowed = row.decision === 'ALLOW';
  assert.equal(row.code, allowed ? 'ok' : 'permission-denied');
  for (const [role,path] of Object.entries(paths)) {
    const before = row.before[role], after = row.after[role];
    const write = attempt.writes.find(w => w.path === path);
    if (write?.method === 'create') assert.equal(before.document,null);
    if (write?.method === 'update') assert.ok(before.document);
    if (!allowed || !write) {
      assert.deepEqual(after,before);
      continue;
    }
    const key = Object.keys(write.data).find(k => write.data[k] === stamp);
    const serverTime = after.document.fields[key].timestampValue;
    assert.deepEqual(after.data, {...before.data, ...materialize(write.data,sdkTime(serverTime))});
    assert.ok(versionNs(serverTime) <= versionNs(after.document.updateTime));
    if (before.document) {
      assert.equal(after.document.createTime, before.document.createTime);
      assert.ok(versionNs(after.document.updateTime) > versionNs(before.document.updateTime));
      assert.ok(versionNs(serverTime) >= versionNs(before.document.updateTime));
    } else assert.equal(after.document.createTime, after.document.updateTime);
  }
  if (allowed && attempt.method === 'writeBatch.commit') {
    assert.equal(row.after.invite.document.updateTime, row.after.profile.document.updateTime);
    assert.deepEqual(row.after.invite.data.usedAt, row.after.profile.data.createdAt);
  }
}
const decisions = {}, releases = new Set();
let lastTime = 0n;
function advance(time) {
  const ns = versionNs(time);
  assert.ok(ns >= lastTime);
  lastTime = ns;
}
for (const [mode,source] of Object.entries(sources)) {
  const arm = record.arms[mode], phases = arm.phases;
  const open = phases.open, active = open.proof.rulesetName;
  assert.match(active,/^projects\/digame-mas\/rulesets\/[a-f0-9-]{36}$/);
  assert.notEqual(active,manifest.target.closedRuleset);
  assert.ok(!releases.has(active));
  releases.add(active);
  const digest = sha(source), markerHash = sha(JSON.stringify(open,null,2) + '\n');
  versionNs(open.proof.lockVersion);
  function checkProof(proof, closed) {
    assert.equal(proof.databaseUid,manifest.target.uid);
    assert.equal(proof.releaseName,releaseName);
    assert.equal(proof.rulesetName,closed ? manifest.target.closedRuleset : active);
    assert.equal(proof.rulesSha256,closed ? manifest.files['v1/rules/closed.rules'] : digest);
    assert.equal(proof.lockRunId,record.runId);
    assert.equal(proof.lockVersion,open.proof.lockVersion);
  }
  function phase(name) {
    const p = phases[name], closed = name !== 'open', verdict = closed ? 'DENY' : 'ALLOW';
    assert.equal(p.phase,name);
    checkProof(p.proof,closed);
    assert.equal(p.write,verdict);
    assert.deepEqual(p.reads,Object.fromEntries(accounts.map(role => [role,verdict])));
    advance(p.proof.verifiedAt);
    advance(p.at);
  }
  phase('initially-closed');
  phase('open');
  let previous, config;
  for (const attempt of attempts) {
    const id = mode + '-' + attempt.id, row = record.rows[id];
    assert.deepEqual([row.mode,row.id,row.method,row.writes,row.actor],[mode,attempt.id,attempt.method,attempt.writes,caller]);
    for (const proof of [row.deploymentBefore,row.deploymentAfter]) {
      checkProof(proof,false);
      assert.equal(proof.propagationReceiptSha256,markerHash);
      assert.equal(proof.releaseUpdateTime,open.proof.releaseUpdateTime);
    }
    assert.ok(versionNs(row.attemptedAt) - versionNs(open.at) >= 100_000_000_000n);
    for (const [position,marker] of [['before',row.markerBefore],['after',row.markerAfter]]) {
      assert.deepEqual([marker.id,marker.actor,marker.path,marker.decision],
        [id + '-' + position,caller,'mapPins/' + caller,'ALLOW']);
    }
    for (const t of [row.deploymentBefore.verifiedAt,row.markerBefore.at,row.attemptedAt,row.readAt,
      row.markerAfter.at,row.deploymentAfter.verifiedAt]) advance(t);
    assert.equal(row.config.name,databasePath + '/documents/world/config');
    assert.deepEqual(row.config.fields,wireFields({admins:[reader]}));
    if (config) assert.deepEqual(row.config,config);
    config = row.config;
    checkReadbacks(row.before);
    checkReadbacks(row.after);
    if (attempt.id === 'atomic-signup') {
      assert.deepEqual(row.before.invite.document,arm.seed);
      assert.deepEqual(row.before.invite.data,seed);
      assert.equal(row.before.profile.document,null);
    } else if (attempt.id === 'sequential-claim' && decisions[mode + '-atomic-signup'] === 'ALLOW') {
      assert.deepEqual(row.before.invite.data,seed);
      assert.equal(row.before.profile.document,null);
      assert.equal(row.before.invite.document.createTime,arm.seed.createTime);
      assert.ok(versionNs(row.before.invite.document.updateTime) > versionNs(previous.invite.document.updateTime));
    } else assert.deepEqual(row.before,previous);
    checkWrite(row,attempt);
    decisions[id] = row.decision;
    previous = row.after;
  }
  phase('restored-closed');
}
assert.deepEqual(Object.keys(record.rows).sort(),Object.keys(decisions).sort());
console.log(JSON.stringify(decisions));
