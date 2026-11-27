import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {api, dbName, dbUrl} from '../control.mjs';
import {manifest} from '../../corpus.mjs';
import {clientsFor, createDocument, lite, SDK_VERSION} from './clients.mjs';
import {startJournal, withMonotonicEvidenceClock, now} from './archive.mjs';
import {withRelease} from './release.mjs';
import {materialize, revision, seedTime, sourceDigest, sourcePath} from '../../../adapters/invite-profile/v1/fixture.mjs';

import {accounts, signup} from '../../../adapters/atomic-signup/v1/fixture.mjs';

const runId = randomUUID(), journal = startJournal(process.argv[2], runId);
const clients = clientsFor(runId, journal), signed = {}, ownedPaths = new Set();
const source = readFileSync(new URL('../../../' + sourcePath, import.meta.url), 'utf8');
const receipt = {runId, revision, target: manifest.target, sdk: SDK_VERSION, endpoint:'firestore.googleapis.com',
  identities:{}, phases:{}, rows:{}};
let stop = false, plan, controlPath, originalRoots;
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { stop = true; });
const checkStop = () => assert.ok(!stop, 'stop requested');
async function roots() {
  const result = await api(dbUrl + '/documents:listCollectionIds','POST',{pageSize:1000});
  assert.ok(!result.nextPageToken);
  return (result.collectionIds ?? []).sort();
}
async function raw(path) {
  const url = dbUrl + '/documents/' + path;
  try { return await api(url); } catch (e) {
    if (e.message === 'GET ' + new URL(url).pathname + ' 404 NOT_FOUND') return null;
    throw e;
  }
}
async function verdict(fn) {
  try { await fn(); return 'ALLOW'; } catch (e) {
    if (e.code === 'permission-denied') return 'DENY';
    throw e;
  }
}
async function signedRead(path) {
  for (let i = 1; ; i++) {
    try {
      const snap = await lite.getDoc(lite.doc(signed.reader.lite, path));
      return snap.exists() ? JSON.parse(JSON.stringify(snap.data())) : null;
    } catch (e) {
      if (i === 20 || !['permission-denied','unavailable','deadline-exceeded'].includes(e.code)) throw e;
      journal.event('read-retry', {path, attempt:i, code:e.code});
      await delay(3000);
    }
  }
}
async function snapshot() {
  const entries = await Promise.all(Object.entries(plan.paths).map(async ([role,path]) =>
    [role, {path, data:await signedRead(path), document:await raw(path)}]));
  return Object.fromEntries(entries);
}
async function setupClients(config) {
  originalRoots = await roots();
  const exposed = [...source.matchAll(/^    match \/(\w+)/gm)].map(m => m[1]);
  assert.ok(!originalRoots.some(r => exposed.includes(r)), 'application fixtures must start empty');
  for (const role of accounts) {
    signed[role] = await clients.add(role, config);
    receipt.identities[role] = signed[role].identity;
  }
  plan = signup(signed.claimant.identity.uid, runId);
  controlPath = 'mapPins/' + signed.claimant.identity.uid;
  for (const path of [controlPath, 'world/config', ...Object.values(plan.paths)]) assert.equal(await raw(path), null);
  ownedPaths.add(controlPath);
}
async function propagation(phase, proof) {
  const open = phase === 'open', expected = open ? 'ALLOW' : 'DENY';
  const ref = lite.doc(signed.claimant.lite, controlPath);
  let streak = 0;
  for (let i = 0; i < 70; i++) {
    const write = await verdict(() => lite.setDoc(ref, {runId}));
    const reads = {};
    for (const role of accounts) {
      reads[role] = await verdict(async () => {
        const snap = await lite.getDoc(lite.doc(signed[role].lite, controlPath));
        if (open && write === 'ALLOW') assert.deepEqual(snap.data(), {runId});
      });
    }
    streak = write === expected && Object.values(reads).every(r => r === expected) ? streak + 1 : 0;
    if (streak === 2) {
      const result = {phase, proof, reads, write, at:now()};
      receipt.phases[phase] = result;
      journal.event('propagation-confirmed', result);
      return journal.retain(result);
    }
    await delay(3000);
  }
  throw Error('propagation timed out: ' + phase);
}
async function marker(id) {
  const ref = lite.doc(signed.claimant.lite, controlPath);
  await lite.setDoc(ref, {runId, id});
  const snapshot = await lite.getDoc(lite.doc(signed.reader.lite,controlPath));
  assert.deepEqual(snapshot.data(), {runId, id});
  return {id, actor:signed.claimant.identity.uid, path:controlPath, decision:'ALLOW', at:now()};
}
async function capture(verify) {
  // A marker can become readable while writes are still reaching servers on the previous release.
  await delay(100_000);
  checkStop();
  const reader = signed.reader.identity.uid;
  const config = await createDocument('world/config', {admins:{arrayValue:{values:[{stringValue:reader}]}}});
  ownedPaths.add('world/config');
  receipt.seed = await createDocument(plan.paths.invite, {createdBy:{stringValue:reader},createdAt:{timestampValue:seedTime},
    usedBy:{nullValue:null},usedAt:{nullValue:null}});
  ownedPaths.add(plan.paths.invite);
  const db = signed.claimant.lite;
  for (const attempt of plan.attempts) {
    checkStop();
    const deploymentBefore = await verify(), before = await snapshot();
    assert.deepEqual(await raw('world/config'), config);
    if (attempt.id === 'sequential-claim') {
      assert.deepEqual(before.invite.data, receipt.rows['atomic-signup'].before.invite.data);
      assert.equal(before.profile.document, null);
    }
    for (const {path} of attempt.writes) ownedPaths.add(path);
    const markerBefore = await marker(attempt.id + '-before');
    const submitted = attempt.writes.map(w => [lite.doc(db,w.path), materialize(w.data,lite.serverTimestamp())]);
    const attemptedAt = now();
    const decision = await verdict(async () => {
      if (attempt.method === 'writeBatch.commit') {
        const batch = lite.writeBatch(db);
        batch.update(...submitted[0]);
        batch.set(...submitted[1]);
        await batch.commit();
      } else if (attempt.method === 'updateDoc') await lite.updateDoc(...submitted[0]);
      else await lite.setDoc(...submitted[0]);
    });
    const after = await snapshot(), readAt = now();
    const markerAfter = await marker(attempt.id + '-after');
    assert.deepEqual(await raw('world/config'), config);
    const row = {...attempt, actor:signed.claimant.identity.uid, decision, code:decision === 'ALLOW' ? 'ok' : 'permission-denied',
      before, after, config, markerBefore, markerAfter, attemptedAt, readAt, deploymentBefore, deploymentAfter:await verify()};
    receipt.rows[attempt.id] = row;
    journal.event('scored', row);
    console.log(attempt.id, decision, JSON.stringify({invite:after.invite.data,profile:after.profile.data}));
    if (attempt.id === 'atomic-signup' && decision === 'ALLOW') {
      // Restore the identical unused invite and absent profile for the sequential control.
      await api(dbUrl + '/documents:commit','POST',{writes:[
        {update:{name:receipt.seed.name, fields:receipt.seed.fields}, currentDocument:{updateTime:after.invite.document.updateTime}},
        {delete:after.profile.document.name, currentDocument:{updateTime:after.profile.document.updateTime}},
      ]});
    }
  }
}
async function cleanup() {
  // UID and UUID paths were verified vacant before use; the singleton must still be our fixture.
  for (const path of ownedPaths) {
    const doc = await raw(path);
    if (!doc) continue;
    if (path === 'world/config') assert.deepEqual(doc.fields.admins.arrayValue.values,[{stringValue:signed.reader.identity.uid}]);
    if (path === controlPath) assert.equal(doc.fields.runId.stringValue,runId);
    if (path === plan.paths.invite) assert.equal(doc.createTime,receipt.seed.createTime);
    await api(dbUrl + '/documents:commit','POST',{writes:[{delete:dbName+'/documents/'+path,currentDocument:{updateTime:doc.updateTime}}]});
    assert.equal(await raw(path), null);
  }
}
await withMonotonicEvidenceClock(async () => {
  try {
    await withRelease({runId, journal, source, digest:sourceDigest, setupClients, checkStop,
      checkPropagation:propagation, capture:async verify => { try { await capture(verify); } finally {
        // The propagation marker is used again during restoration.
        ownedPaths.delete(controlPath);
        try { await cleanup(); ownedPaths.clear(); } finally { ownedPaths.add(controlPath); }
      }}});
  } finally {
    try { await cleanup(); } finally { await clients.close(); }
  }
  const finalRoots = await roots();
  assert.deepEqual(finalRoots, originalRoots.filter(r => r !== 'oracleLocks'));
  const digest = journal.retain(receipt);
  journal.complete({runId,digest});
  console.log('Completed',runId,digest);
});
