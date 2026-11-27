import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {cases,bytes,bucketFor,project,number,closed,control,marker,transport,seed,revision} from './fixture.mjs';
import {checkIdentity} from '../../arcade-sdk/v1/evidence.mjs';

const [probe,raw] = process.argv.slice(2);
const receipt = JSON.parse(readFileSync(raw));
const sha = data=>createHash('sha256').update(data).digest('hex');
const {bucket,runId,identity,releaseName,phases} = receipt;
assert.equal(bucket,bucketFor(runId));
assert.equal(receipt.project,project);
assert.equal(receipt.number,number);
assert.equal(receipt.revision,revision);
assert.equal(receipt.sdk,'12.19.0');
assert.equal(receipt.endpoint,'firebasestorage.googleapis.com');
assert.equal(receipt.rulesSha256,sha(readFileSync(join(probe,'storage.rules'))));
assert.equal(receipt.closedSha256,sha(closed));
assert.notEqual(receipt.rulesSha256,receipt.closedSha256);
assert.equal(releaseName,'projects/'+project+'/releases/firebase.storage/'+bucket);
checkIdentity(identity);
let time = 0;
function advance(stamp) {
  const t = Date.parse(stamp);
  assert.ok(Number.isFinite(t) && t>=time,'out-of-order capture time');
  time=t;
}
function snapshot(obj,path) {
  if (!obj) return assert.equal(obj,null);
  assert.equal(obj.name,path);
  assert.equal(obj.bucket,bucket);
  assert.match(obj.generation,/^[1-9][0-9]*$/);
  assert.match(obj.metageneration,/^[1-9][0-9]*$/);
  assert.match(obj.size,/^\d+$/);
  assert.match(obj.sha256,/^[a-f0-9]{64}$/);
  assert.equal(typeof obj.contentType,'string');
  assert.ok(Number.isFinite(Date.parse(obj.updated)));
}
const checksum = sha(bytes(91,7));
snapshot(receipt.marker,marker);
assert.equal(receipt.marker.sha256,checksum);
assert.equal(receipt.marker.contentType,'audio/wav');
assert.equal(Number(receipt.marker.size),91);

function release(proof,digest) {
  assert.equal(proof.name,releaseName);
  assert.equal(proof.rulesSha256,digest);
  assert.equal(proof.bucketId,bucket);
  assert.equal(proof.bucketCreated,receipt.bucketCreated);
  assert.equal(proof.projectNumber,number);
  assert.match(proof.rulesetName,/^projects\/digame-mas\/rulesets\/[a-f0-9-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(proof.updateTime)));
  advance(proof.at);
}
function markerRead(read,want) {
  assert.equal(read.decision,want);
  if (want === 'ALLOW') {
    assert.equal(read.code,'ok');
    assert.deepEqual(read.sdkResult,{size:91,sha256:checksum});
  } else assert.ok(['storage/unauthorized','storage/unauthenticated'].includes(read.code));
}
function phase(key) {
  const p = phases[key], open = key==='open' || key==='control';
  const digest = key==='open' ? receipt.rulesSha256 : key==='control' ? sha(control) : receipt.closedSha256;
  release(p.deployment,digest);
  assert.equal(p.probes.length,2);
  for (const r of p.probes) {
    advance(r.at);
    markerRead(r,open ? 'ALLOW' : 'DENY');
  }
}
phase('initial');
phase('control');
assert.notEqual(phases.control.deployment.rulesetName,phases.initial.deployment.rulesetName);
phase('armed');
assert.equal(phases.armed.deployment.rulesetName,phases.initial.deployment.rulesetName);
phase('open');
assert.notEqual(phases.open.deployment.rulesetName,phases.control.deployment.rulesetName);
release(receipt.before,receipt.rulesSha256);
assert.equal(receipt.before.rulesetName,phases.open.deployment.rulesetName);
assert.equal(receipt.before.updateTime,phases.open.deployment.updateTime);
assert.ok(Date.parse(receipt.before.at)-Date.parse(phases.open.probes.at(-1).at) >= 59900);

for (const [obj,path] of [[receipt.seed,seed.path],[receipt.transport.stored,transport]]) {
  snapshot(obj,path);
  assert.equal(Number(obj.size),seed.size);
  assert.equal(obj.contentType,seed.mime);
  assert.equal(obj.sha256,sha(bytes(seed.size,seed.salt)));
}
assert.deepEqual(receipt.transport.upload,{decision:'ALLOW',code:'ok',sdkResult:{
  generation:receipt.transport.stored.generation,size:seed.size,contentType:seed.mime}});
assert.notEqual(phases.initial.deployment.rulesetName,phases.open.deployment.rulesetName);
const latest = new Map([[seed.path,receipt.seed]]), decisions = {};
for (const c of cases) {
  const row = receipt.rows[c.id];
  for (const [k,v] of Object.entries(c)) assert.deepEqual(row[k],v,c.id+' '+k);
  assert.equal(row.actorUid,c.actor==='signed' ? identity.uid : null);
  advance(row.at);
  advance(row.finishedAt);
  snapshot(row.before,c.path);
  snapshot(row.after,c.path);
  assert.deepEqual(row.before,latest.get(c.path) ?? null);
  assert.ok(['ALLOW','DENY'].includes(row.decision));
  if (row.decision === 'DENY') {
    assert.ok(['storage/unauthorized','storage/unauthenticated'].includes(row.code));
    assert.deepEqual(row.after,row.before,c.id+' refused object changed');
    assert.equal(row.sdkResult,undefined);
  } else {
    assert.equal(row.code,'ok');
    if (c.op==='upload') {
      assert.notEqual(row.after.generation,row.before?.generation,c.id+' generation unchanged');
      assert.equal(Number(row.after.size),c.size);
      assert.equal(row.after.contentType,c.mime);
      assert.equal(row.after.sha256,sha(bytes(c.size,c.salt)));
      assert.deepEqual(row.sdkResult,{generation:row.after.generation,size:c.size,contentType:c.mime});
    } else if (c.op==='delete') {
      assert.equal(row.after,null);
    } else {
      assert.deepEqual(row.after,row.before);
      assert.deepEqual(row.sdkResult,{size:Number(row.before.size),sha256:row.before.sha256});
    }
  }
  latest.set(c.path,row.after);
  decisions[c.id] = row.decision;
}
assert.deepEqual(Object.keys(receipt.rows).sort(),Object.keys(decisions).sort());
release(receipt.after.deployment,receipt.rulesSha256);
assert.equal(receipt.after.deployment.rulesetName,phases.open.deployment.rulesetName);
assert.equal(receipt.after.deployment.updateTime,phases.open.deployment.updateTime);
markerRead(receipt.after.marker,'ALLOW');
phase('restored');
assert.equal(phases.restored.deployment.rulesetName,phases.initial.deployment.rulesetName);
advance(receipt.cleanup.at);
assert.equal(receipt.cleanup.bucket,'absent');
assert.equal(receipt.cleanup.release,'absent');
console.log(JSON.stringify(decisions));
