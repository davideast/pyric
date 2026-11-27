import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {api, dbName, dbUrl} from '../control.mjs';
import {manifest,sha} from '../../corpus.mjs';
import {clientsFor, lite, SDK_VERSION} from './clients.mjs';
import {startJournal, withMonotonicEvidenceClock, now} from './archive.mjs';
import {withRelease} from './release.mjs';
import {revision} from '../../../adapters/invite-profile/v1/fixture.mjs';

import {artifactPath,build} from '../../../adapters/hearthfest-compiled/v1/build.mjs';
import {fileURLToPath} from 'node:url';
import {accounts, fixture} from '../../../adapters/hearthfest-atomic/v1/fixture.mjs';

const runId = randomUUID(), journal = startJournal(process.argv[2], runId);
const clients = clientsFor(runId, journal), signed = {}, ownedPaths = new Set();
const root = fileURLToPath(new URL('../../../',import.meta.url));
const source = await build(root);
assert.equal(source,readFileSync(new URL('../../../' + artifactPath,import.meta.url),'utf8'));
const sourceDigest = sha(source);
const receipt = {runId, revision, target: manifest.target, sdk: SDK_VERSION, endpoint:'firestore.googleapis.com',
  identities:{}, phases:{}, rows:{}};
let stop = false, controlPath, originalRoots, plan;
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
  controlPath = 'mapPins/' + signed.writer.identity.uid;
  plan = fixture(signed.writer.identity.uid);
  for (const path of [controlPath,...Object.values(plan.paths)]) assert.equal(await raw(path),null);
  ownedPaths.add(controlPath);
}
async function propagation(phase, proof) {
  const open = phase === 'open', expected = open ? 'ALLOW' : 'DENY';
  const ref = lite.doc(signed.writer.lite, controlPath);
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
  const ref = lite.doc(signed.writer.lite, controlPath);
  await lite.setDoc(ref, {runId, id});
  const snapshot = await lite.getDoc(lite.doc(signed.reader.lite,controlPath));
  assert.deepEqual(snapshot.data(), {runId, id});
  return {id, actor:signed.writer.identity.uid, path:controlPath, decision:'ALLOW', at:now()};
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
  receipt.deploymentBefore = await verify();
  receipt.markerBefore = await marker('award-before');
  const db = signed.writer.lite;
  for (const [role,path] of Object.entries(plan.paths)) {
    ownedPaths.add(path);
    await lite.setDoc(lite.doc(db,path),plan.initial[role]);
  }
  receipt.seed = await snapshot(plan.paths);
  for (const attempt of plan.attempts) {
    checkStop();
    const before = await snapshot(plan.paths);
    for (const role of Object.keys(plan.paths)) {
      assert.deepEqual(before[role].data,plan.initial[role]);
      assert.deepEqual(before[role].document,receipt.seed[role].document);
    }
    const batch = lite.writeBatch(db);
    for (const write of attempt.writes) batch.update(lite.doc(db,write.path),write.data);
    const attemptedAt = now();
    const decision = await verdict(() => batch.commit());
    const after = await snapshot(plan.paths);
    const row = {...attempt,uid:signed.writer.identity.uid,before,after,attemptedAt,readAt:now(),
      decision,code:decision === 'ALLOW' ? 'ok' : 'permission-denied'};
    receipt.rows[attempt.id] = row;
    journal.event('scored',row);
    console.log(attempt.id,decision,after.contribution.data.items,after.award.data.points);
  }
  receipt.markerAfter = await marker('award-after');
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
