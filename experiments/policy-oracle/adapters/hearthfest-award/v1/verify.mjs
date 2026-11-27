import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {manifest, sha, versionNs} from '../../../arcade/corpus.mjs';
import {checkIdentity, databasePath, releaseName, wireFields} from '../../arcade-sdk/v1/evidence.mjs';
import {revision, sourceDigest, sourcePath} from '../../invite-profile/v1/fixture.mjs';
import {accounts, fixture} from './fixture.mjs';

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

const uid = uids.writer;
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
  const readTime = versionNs(snapshot.readTime);
  if (document === null) return assert.equal(data, null);
  assert.ok(readTime >= versionNs(document.updateTime));
  assert.equal(document.name, databasePath + '/documents/' + path);
  assert.ok(versionNs(document.updateTime) >= versionNs(document.createTime));
  assert.deepEqual(Object.keys(document.fields).sort(), Object.keys(data).sort());
  for (const [key, wire] of Object.entries(document.fields)) {
    if ('timestampValue' in wire) assert.deepEqual(data[key], sdkTimestamp(wire.timestampValue));
    else if ('nullValue' in wire) { assert.deepEqual(wire, {nullValue:null}); assert.equal(data[key], null); }
    else assert.deepEqual(wire, wireFields({[key]:data[key]})[key]);
  }
}

for (const proof of [record.deploymentBefore,record.deploymentAfter]) {
  checkProof(proof);
  assert.equal(proof.releaseUpdateTime,open.proof.releaseUpdateTime);
  assert.equal(proof.propagationReceiptSha256,propagationDigest);
}
for (const [id,marker] of [['award-before',record.markerBefore],['award-after',record.markerAfter]]) {
  assert.deepEqual([marker.id,marker.actor,marker.path,marker.decision],[id,uid,'mapPins/' + uid,'ALLOW']);
}
assert.ok(versionNs(record.deploymentBefore.verifiedAt) - versionNs(open.at) >= 100_000_000_000n);
let previous, lastTime = versionNs(initial.at);
function advance(time) {
  const ns = versionNs(time);
  assert.ok(ns >= lastTime);
  lastTime = ns;
}
advance(open.at);
advance(record.deploymentBefore.verifiedAt);
advance(record.markerBefore.at);
const {attempts,paths,contribution} = fixture(uids.reader);
const decisions = {};
let previousAward = null;
assert.deepEqual(record.seed.fields,wireFields(contribution));
for (const attempt of attempts) {
  const row = record.rows[attempt.id];
  for (const key of Object.keys(attempt)) assert.deepEqual(row[key],attempt[key]);
  assert.equal(row.uid,attempt.actor === 'signed-out' ? null : uid);
  advance(row.attemptedAt);
  advance(row.readAt);
  for (const snap of [row.before,row.after]) {
    assert.deepEqual(Object.keys(snap).sort(),Object.keys(paths).sort());
    for (const [key,path] of Object.entries(paths)) checkSnapshot(snap[key],path);
    assert.deepEqual(snap.contribution.data,contribution);
    assert.deepEqual(snap.contribution.document,record.seed);
  }
  for (const key of Object.keys(paths)) assert.ok(versionNs(row.before[key].readTime) <= versionNs(row.after[key].readTime));
  const before = row.before.award, after = row.after.award;
  assert.deepEqual(before.document,previousAward);
  assert.equal(before.document === null,attempt.method === 'create');
  assert.ok(['ALLOW','DENY'].includes(row.decision));
  assert.equal(row.code,row.decision === 'ALLOW' ? 'ok' : 'permission-denied');
  if (row.decision === 'DENY') assert.deepEqual(after.document,before.document);
  else if (attempt.method === 'delete') assert.equal(after.document,null);
  else {
    assert.deepEqual(after.data,{...before.data,...attempt.data});
    const doc = after.document;
    assert.equal(doc.createTime,before.document?.createTime ?? doc.updateTime);
    if (before.document) assert.ok(versionNs(doc.updateTime) > versionNs(before.document.updateTime));
  }
  previousAward = after.document;
  decisions[attempt.id] = row.decision;
}
advance(record.markerAfter.at);
advance(record.deploymentAfter.verifiedAt);
advance(restored.at);
assert.deepEqual(Object.keys(record.rows).sort(),Object.keys(decisions).sort());
console.log(JSON.stringify(decisions));
