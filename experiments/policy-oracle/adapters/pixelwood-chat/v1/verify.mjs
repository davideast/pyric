import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {captureTiming} from './timing.mjs';
import {manifest, sha, versionNs} from '../../../arcade/corpus.mjs';
import {checkIdentity, databasePath, releaseName, wireFields} from '../../arcade-sdk/v1/evidence.mjs';
import {revision, sourceDigest, sourcePath} from '../../invite-profile/v1/fixture.mjs';
import {accounts, attempts, pathsFor, profileData, messageData} from './fixture.mjs';

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

const uid = uids.sender;
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
for (const [id,marker] of [['chat-before',record.markerBefore],['chat-after',record.markerAfter]]) {
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
const decisions = {};
for (const attempt of attempts) {
  const row = record.rows[attempt.id], paths = pathsFor(uid,record.runId,attempt.id);
  assert.deepEqual([row.id,row.actor,row.profile],[attempt.id,uid,attempt.profile]);
  advance(row.attemptedAt);
  advance(row.readAt);
  const {before,afterLedger,after,decision} = row;
  for (const snap of [before,afterLedger,after]) {
    assert.deepEqual(Object.keys(snap).sort(),Object.keys(paths).sort());
    for (const [key,path] of Object.entries(paths)) checkSnapshot(snap[key],path);
    assert.deepEqual(snap.profile.data,profileData(attempt.profile));
    assert.deepEqual(snap.profile.document,before.profile.document);
  }
  for (const key of Object.keys(paths)) {
    assert.ok(versionNs(before[key].readTime) <= versionNs(afterLedger[key].readTime));
    assert.ok(versionNs(afterLedger[key].readTime) <= versionNs(after[key].readTime));
  }
  assert.equal(before.message.document,null);
  assert.equal(afterLedger.message.document,null);
  if (attempt.fresh) assert.equal(before.ledger.document,null);
  else {
    assert.deepEqual(before.ledger.document,previous.ledger.document);
    assert.deepEqual(before.profile.document,previous.profile.document);
  }
  assert.ok(['ALLOW','DENY'].includes(decision.ledger));
  if (decision.ledger === 'ALLOW') {
    const doc = afterLedger.ledger.document;
    const stamp = doc.fields.lastChatAt.timestampValue;
    assert.deepEqual(afterLedger.ledger.data,{lastChatAt:sdkTimestamp(stamp)});
    assert.ok(versionNs(stamp) <= versionNs(doc.updateTime));
    if (before.ledger.document) {
      assert.equal(doc.createTime,before.ledger.document.createTime);
      assert.ok(versionNs(doc.updateTime) > versionNs(before.ledger.document.updateTime));
    } else assert.equal(doc.createTime,doc.updateTime);
    assert.ok(['ALLOW','DENY'].includes(decision.message));
  } else {
    assert.deepEqual(afterLedger.ledger.document,before.ledger.document);
    assert.equal(decision.message,'NOT_SUBMITTED');
    assert.deepEqual(after,afterLedger);
  }
  assert.deepEqual(after.ledger.document,afterLedger.ledger.document);
  if (decision.message === 'ALLOW') {
    const doc = after.message.document;
    const t = doc.fields.t.timestampValue;
    assert.deepEqual(after.message.data,messageData(uid,attempt.profile,sdkTimestamp(t)));
    assert.equal(doc.createTime,doc.updateTime);
    assert.ok(versionNs(t) <= versionNs(doc.updateTime));
    assert.ok(versionNs(t) >= versionNs(after.ledger.document.fields.lastChatAt.timestampValue));
  } else assert.equal(after.message.document,null);
  previous = after;
  decisions[attempt.id] = decision;
}
advance(record.markerAfter.at);
advance(record.deploymentAfter.verifiedAt);
advance(restored.at);
assert.deepEqual(Object.keys(record.rows).sort(),Object.keys(decisions).sort());
const observed = captureTiming(record);
const pinned = JSON.parse(readFileSync(join(process.argv[2],'timing.json')));
if (pinned.referenceRun === record.runId) assert.deepEqual(observed,pinned);
console.log(JSON.stringify(decisions));
