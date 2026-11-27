import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {api, dbName, dbUrl} from '../control.mjs';
import {manifest} from '../../corpus.mjs';
import {clientsFor, createDocument, lite, SDK_VERSION} from './clients.mjs';
import {startJournal, withMonotonicEvidenceClock, now} from './archive.mjs';
import {withRelease} from './release.mjs';
import {revision, sourceDigest, sourcePath} from '../../../adapters/invite-profile/v1/fixture.mjs';

import {wireFields} from '../../../adapters/arcade-sdk/v1/evidence.mjs';
import {accounts, attempts, profileData, messageData, pathsFor} from '../../../adapters/pixelwood-chat/v1/fixture.mjs';

const runId = randomUUID(), journal = startJournal(process.argv[2], runId);
const clients = clientsFor(runId, journal), signed = {}, ownedPaths = new Set();
const source = readFileSync(new URL('../../../' + sourcePath, import.meta.url), 'utf8');
const receipt = {runId, revision, target: manifest.target, sdk: SDK_VERSION, endpoint:'firestore.googleapis.com',
  identities:{}, phases:{}, rows:{}};
let stop = false, controlPath, originalRoots;
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
async function snapshot(paths) {
  const entries = Object.entries(paths);
  const [docs, values] = await Promise.all([
    api(dbUrl + '/documents:batchGet','POST',{documents:entries.map(([,path]) => dbName + '/documents/' + path)}),
    Promise.all(entries.map(([,path]) => signedRead(path))),
  ]);
  return Object.fromEntries(entries.map(([role,path],i) => {
    const name = dbName + '/documents/' + path;
    const row = docs.find(row => (row.found?.name ?? row.missing) === name);
    assert.ok(row?.readTime);
    return [role,{path,data:values[i],document:row.found ?? null,readTime:row.readTime}];
  }));
}
async function setupClients(config) {
  originalRoots = await roots();
  const exposed = [...source.matchAll(/^    match \/(\w+)/gm)].map(m => m[1]);
  assert.ok(!originalRoots.some(r => exposed.includes(r)), 'application fixtures must start empty');
  for (const role of accounts) {
    signed[role] = await clients.add(role, config);
    receipt.identities[role] = signed[role].identity;
  }
  const uid = signed.sender.identity.uid;
  controlPath = 'mapPins/' + uid;
  const paths = new Set(attempts.flatMap(attempt => Object.values(pathsFor(uid,runId,attempt.id))));
  for (const path of [controlPath,...paths]) assert.equal(await raw(path),null);
  ownedPaths.add(controlPath);
}
async function propagation(phase, proof) {
  const open = phase === 'open', expected = open ? 'ALLOW' : 'DENY';
  const ref = lite.doc(signed.sender.lite, controlPath);
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
  const ref = lite.doc(signed.sender.lite, controlPath);
  await lite.setDoc(ref, {runId, id});
  const snapshot = await lite.getDoc(lite.doc(signed.reader.lite,controlPath));
  assert.deepEqual(snapshot.data(), {runId, id});
  return {id, actor:signed.sender.identity.uid, path:controlPath, decision:'ALLOW', at:now()};
}
async function removeOwned(path) {
  assert.ok(ownedPaths.has(path));
  const doc = await raw(path);
  if (!doc) return;
  if (path === controlPath) assert.equal(doc.fields.runId.stringValue,runId);
  await api(dbUrl + '/documents:commit','POST',{writes:[{delete:doc.name,currentDocument:{updateTime:doc.updateTime}}]});
  assert.equal(await raw(path),null);
}
async function cleanup() {
  for (const path of ownedPaths) await removeOwned(path);
}
async function capture(verify) {
  await delay(100_000);
  const uid = signed.sender.identity.uid, db = signed.sender.lite;
  receipt.deploymentBefore = await verify();
  receipt.markerBefore = await marker('chat-before');
  let namedAck;
  for (const attempt of attempts) {
    checkStop();
    const paths = pathsFor(uid,runId,attempt.id);
    for (const path of Object.values(paths)) ownedPaths.add(path);
    if (attempt.fresh) {
      await removeOwned(paths.ledger);
      await removeOwned(paths.profile);
      const profile = profileData(attempt.profile);
      if (profile) await createDocument(paths.profile,wireFields(profile));
    }
    if (attempt.id === 'after-cooldown') await delay(Math.max(0,1650 - (performance.now() - namedAck)));
    const before = await snapshot(paths);
    const attemptedAt = now();
    const ledger = await verdict(() => lite.setDoc(lite.doc(db,paths.ledger),{lastChatAt:lite.serverTimestamp()},{merge:true}));
    if (attempt.id === 'named-profile') namedAck = performance.now();
    const afterLedger = await snapshot(paths);
    let message = 'NOT_SUBMITTED', after = afterLedger;
    if (ledger === 'ALLOW') {
      // Reserve the message ID so both clients can read its path even on refusal.
      message = await verdict(() => lite.setDoc(lite.doc(db,paths.message),messageData(uid,attempt.profile,lite.serverTimestamp())));
      after = await snapshot(paths);
    }
    const row = {id:attempt.id, actor:uid, profile:attempt.profile, decision:{ledger,message},
      attemptedAt, readAt:now(), before, afterLedger, after};
    receipt.rows[attempt.id] = row;
    journal.event('scored',row);
    console.log(attempt.id, ledger, message);
  }
  receipt.markerAfter = await marker('chat-after');
  receipt.deploymentAfter = await verify();
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
