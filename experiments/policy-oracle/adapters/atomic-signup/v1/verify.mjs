import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {manifest, sha, versionNs} from '../../../arcade/corpus.mjs';
import {checkIdentity, databasePath, releaseName, wireFields} from '../../arcade-sdk/v1/evidence.mjs';
import {materialize, revision, seedTime, sourceDigest, sourcePath, stamp} from '../../invite-profile/v1/fixture.mjs';
import {accounts, signup} from './fixture.mjs';

const record = JSON.parse(readFileSync(process.argv[3]));
assert.deepEqual(record.target, manifest.target);
assert.equal(record.endpoint, 'firestore.googleapis.com');
assert.equal(record.sdk, manifest.target.sdk);
assert.equal(record.revision, revision);
assert.equal(sha(readFileSync(new URL('../../../' + sourcePath, import.meta.url))), sourceDigest);
assert.match(record.runId, /^[a-f0-9-]{36}$/);
assert.deepEqual(Object.keys(record.identities).sort(), [...accounts].sort());
const uids = Object.fromEntries(accounts.map(role => {
  checkIdentity(record.identities[role]);
  return [role, record.identities[role].uid];
}));
assert.equal(new Set(Object.values(uids)).size, accounts.length);

const {paths, attempts} = signup(uids.claimant, record.runId);
const {open, 'initially-closed': initial, 'restored-closed': restored} = record.phases;
const active = open.proof.rulesetName;
assert.match(active, /^projects\/digame-mas\/rulesets\/[a-f0-9-]{36}$/);
assert.notEqual(active, manifest.target.closedRuleset);
versionNs(open.proof.lockVersion);
function checkProof(proof, closed = false) {
  assert.equal(proof.databaseUid, manifest.target.uid);
  assert.equal(proof.releaseName, releaseName);
  assert.equal(proof.rulesetName, closed ? manifest.target.closedRuleset : active);
  assert.equal(proof.rulesSha256, closed ? manifest.files['v1/rules/closed.rules'] : sourceDigest);
  assert.equal(proof.lockRunId, record.runId);
  assert.equal(proof.lockVersion, open.proof.lockVersion);
}
for (const [phase, snapshot] of Object.entries({'initially-closed':initial, open, 'restored-closed':restored})) {
  const closed = phase !== 'open', decision = closed ? 'DENY' : 'ALLOW';
  checkProof(snapshot.proof, closed);
  assert.equal(snapshot.phase, phase);
  assert.equal(snapshot.write, decision);
  assert.deepEqual(snapshot.reads, Object.fromEntries(accounts.map(role => [role, decision])));
}
const propagationDigest = sha(JSON.stringify(open, null, 2) + '\n');

function sdkTimestamp(iso) {
  const ns = versionNs(iso);
  return {type:'firestore/timestamp/1.0', seconds:Number(ns / 1000000000n), nanoseconds:Number(ns % 1000000000n)};
}
// Compare every SDK field with the independently fetched REST document and its version.
function checkSnapshot(snapshot, path) {
  const {document, data} = snapshot;
  assert.equal(snapshot.path, path);
  if (document === null) return assert.equal(data, null);
  assert.equal(document.name, databasePath + '/documents/' + path);
  assert.ok(versionNs(document.updateTime) >= versionNs(document.createTime));
  assert.deepEqual(Object.keys(document.fields).sort(), Object.keys(data).sort());
  for (const [key, wire] of Object.entries(document.fields)) {
    if ('timestampValue' in wire) assert.deepEqual(data[key], sdkTimestamp(wire.timestampValue));
    else if ('nullValue' in wire) { assert.deepEqual(wire, {nullValue:null}); assert.equal(data[key], null); }
    else assert.deepEqual(wire, wireFields({[key]:data[key]})[key]);
  }
}

const decisions = {}, roles = Object.keys(paths);
let previous, config, lastTime = versionNs(open.at);
assert.ok(versionNs(initial.at) <= lastTime);
const initialCapture = process.argv[4] === '--initial-capture';
for (const attempt of attempts) {
  const row = record.rows[attempt.id];
  assert.deepEqual([row.actor,row.id,row.method,row.writes], [uids.claimant,attempt.id,attempt.method,attempt.writes]);
  if (!initialCapture) {
    assert.ok(versionNs(row.attemptedAt) - versionNs(open.at) >= 100_000_000_000n);
    for (const [position,marker] of [['before',row.markerBefore],['after',row.markerAfter]]) {
      assert.deepEqual([marker.id,marker.actor,marker.path,marker.decision],
        [attempt.id + '-' + position,uids.claimant,'mapPins/' + uids.claimant,'ALLOW']);
    }
  }
  for (const proof of [row.deploymentBefore,row.deploymentAfter]) {
    checkProof(proof);
    assert.equal(proof.propagationReceiptSha256, propagationDigest);
    assert.equal(proof.releaseUpdateTime, open.proof.releaseUpdateTime);
  }
  for (const t of [row.deploymentBefore.verifiedAt,...(initialCapture ? [] : [row.markerBefore.at]),row.attemptedAt,row.readAt,
    ...(initialCapture ? [] : [row.markerAfter.at]),row.deploymentAfter.verifiedAt]) {
    const ns = versionNs(t);
    assert.ok(ns >= lastTime);
    lastTime = ns;
  }
  assert.equal(row.config.name, databasePath + '/documents/world/config');
  assert.deepEqual(row.config.fields, wireFields({admins:[uids.reader]}));
  if (config) assert.deepEqual(row.config, config);
  config = row.config;
  if (attempt.id === 'atomic-signup') {
    assert.deepEqual(row.before.invite.document, record.seed);
    assert.deepEqual(row.before.invite.data, {createdBy:uids.reader, createdAt:sdkTimestamp(seedTime), usedBy:null, usedAt:null});
    assert.equal(row.before.profile.document, null);
  } else if (attempt.id === 'sequential-claim' && decisions['atomic-signup'] === 'ALLOW') {
    assert.deepEqual(row.before.invite.data, record.rows['atomic-signup'].before.invite.data);
    assert.equal(row.before.invite.document.createTime, record.seed.createTime);
    assert.ok(versionNs(row.before.invite.document.updateTime) > versionNs(previous.invite.document.updateTime));
    assert.equal(row.before.profile.document, null);
  } else assert.deepEqual(row.before, previous);
  assert.ok(['ALLOW','DENY'].includes(row.decision));
  const allowed = row.decision === 'ALLOW';
  assert.equal(row.code, allowed ? 'ok' : 'permission-denied');
  for (const snapshot of [row.before,row.after]) {
    assert.deepEqual(Object.keys(snapshot).sort(), [...roles].sort());
    for (const role of roles) checkSnapshot(snapshot[role], paths[role]);
  }
  for (const role of roles) {
    const before = row.before[role], after = row.after[role];
    const write = attempt.writes.find(w => w.path === paths[role]);
    if (write?.method === 'create') assert.equal(before.document, null);
    if (write?.method === 'update') assert.ok(before.document);
    if (!allowed || !write) {
      assert.deepEqual(after, before);
      continue;
    }
    const key = Object.keys(write.data).find(k => write.data[k] === stamp);
    const serverTime = after.document.fields[key].timestampValue;
    assert.deepEqual(after.data, {...before.data, ...materialize(write.data, sdkTimestamp(serverTime))});
    const updated = versionNs(after.document.updateTime);
    assert.ok(versionNs(serverTime) <= updated);
    if (before.document) {
      assert.equal(after.document.createTime, before.document.createTime);
      assert.ok(versionNs(before.document.updateTime) < updated);
      assert.ok(versionNs(before.document.updateTime) <= versionNs(serverTime));
    } else assert.equal(after.document.createTime, after.document.updateTime);
  }
  if (allowed && attempt.method === 'writeBatch.commit') {
    assert.equal(row.after.invite.document.updateTime, row.after.profile.document.updateTime);
    assert.deepEqual(row.after.invite.data.usedAt, row.after.profile.data.createdAt);
  }
  previous = row.after;
  decisions[attempt.id] = row.decision;
}
assert.ok(lastTime <= versionNs(restored.at));
assert.deepEqual(Object.keys(record.rows).sort(), Object.keys(decisions).sort());
console.log(JSON.stringify(decisions));
