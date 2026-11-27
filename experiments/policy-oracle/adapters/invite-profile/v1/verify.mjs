import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {manifest, sha, versionNs} from '../../../arcade/corpus.mjs';
import {checkIdentity, databasePath, releaseName, wireFields} from '../../arcade-sdk/v1/evidence.mjs';
import {accounts, fixture, materialize, revision, seedTime, sourceDigest, sourcePath, stamp} from './fixture.mjs';

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

const {paths, steps} = fixture(uids, record.runId);
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
for (const step of steps) {
  const row = record.rows[step.id];
  assert.deepEqual([row.actor,row.path,row.operation,row.data], [uids[step.role],paths[step.target],step.method,step.data]);
  for (const proof of [row.deploymentBefore,row.deploymentAfter]) {
    checkProof(proof);
    assert.equal(proof.propagationReceiptSha256, propagationDigest);
    assert.equal(proof.releaseUpdateTime, open.proof.releaseUpdateTime);
  }
  for (const t of [row.deploymentBefore.verifiedAt,row.attemptedAt,row.readAt,row.deploymentAfter.verifiedAt]) {
    const ns = versionNs(t);
    assert.ok(ns >= lastTime);
    lastTime = ns;
  }
  assert.equal(row.config.name, databasePath + '/documents/world/config');
  assert.deepEqual(row.config.fields, wireFields({admins:[uids.reader]}));
  if (config) assert.deepEqual(row.config, config);
  config = row.config;
  if (previous) assert.deepEqual(row.before, previous);
  else {
    assert.deepEqual(row.before.invite.document, record.seed);
    assert.deepEqual(row.before.invite.data, {createdBy:uids.reader, createdAt:sdkTimestamp(seedTime), usedBy:null, usedAt:null});
    for (const role of ['claimant','other','guest']) assert.equal(row.before[role].document, null);
  }
  assert.ok(['ALLOW','DENY'].includes(row.decision));
  const allowed = row.decision === 'ALLOW';
  assert.equal(row.code, allowed ? 'ok' : 'permission-denied');
  for (const snapshot of [row.before,row.after]) {
    assert.deepEqual(Object.keys(snapshot).sort(), [...roles].sort());
    for (const role of roles) checkSnapshot(snapshot[role], paths[role]);
  }
  const before = row.before[step.target], after = row.after[step.target];
  if (step.method === 'create') assert.equal(before.document, null);
  else assert.ok(before.document);
  for (const role of roles) {
    if (!allowed || role !== step.target) assert.deepEqual(row.after[role], row.before[role]);
  }
  if (allowed) {
    const key = Object.keys(step.data).find(k => step.data[k] === stamp);
    const serverTime = after.document.fields[key].timestampValue;
    assert.deepEqual(after.data, {...before.data, ...materialize(step.data, sdkTimestamp(serverTime))});
    const updated = versionNs(after.document.updateTime);
    assert.ok(versionNs(serverTime) <= updated);
    if (before.document) {
      assert.equal(after.document.createTime, before.document.createTime);
      assert.ok(versionNs(before.document.updateTime) < updated);
      assert.ok(versionNs(before.document.updateTime) <= versionNs(serverTime));
    } else assert.equal(after.document.createTime, after.document.updateTime);
  }
  previous = row.after;
  decisions[step.id] = row.decision;
}
assert.ok(lastTime <= versionNs(restored.at));
assert.deepEqual(Object.keys(record.rows).sort(), Object.keys(decisions).sort());
console.log(JSON.stringify(decisions));
