// Run against the leased, UID-pinned non-default oracle database only.
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {api, dbName, dbUrl} from '../control.mjs';
import {manifest, sha} from '../../corpus.mjs';
import {clientsFor, createDocument, lite, SDK_VERSION} from './clients.mjs';
import {startJournal, withMonotonicEvidenceClock, now} from './archive.mjs';
import {withRelease} from './release.mjs';
import {wireFields} from '../../../adapters/arcade-sdk/v1/evidence.mjs';
import {revision, hashes, roles, operations, configFor, event, profile, patch} from '../../../adapters/world-role/v1/fixture.mjs';

const probe = new URL('../../../suites/ai-jrpg/pixelwood/claims/world-role/v1/probes/app-and-mirror/v1/', import.meta.url);
const runId = randomUUID(), journal = startJournal(process.argv[2], runId), clients = clientsFor(runId, journal);
const receipt = {runId, revision, target: manifest.target, sdk: SDK_VERSION, endpoint: 'firestore.googleapis.com', phases: {}, rows: {}};
let actor, owner, stop = false;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stop = true; });
const checkStop = () => assert.ok(!stop, 'stop requested');
async function raw(path) {
  const url = dbUrl + '/documents/' + path;
  try { return await api(url); }
  catch (e) { if (e.message === 'GET ' + new URL(url).pathname + ' 404 NOT_FOUND') return null; throw e; }
}
async function remove(path, document) {
  await api(dbUrl + '/documents:commit', 'POST', {writes: [{delete: dbName + '/documents/' + path,
    currentDocument: {updateTime: document.updateTime}}]});
}
// Only remove fixtures created by this run; a replaced or unexpected document aborts cleanup.
async function seeded(path, data, work, allowedAfter = [data]) {
  const seed = await createDocument(path, wireFields(data));
  try { return await work(seed); }
  finally {
    const current = await raw(path);
    if (current) {
      assert.equal(current.createTime, seed.createTime);
      assert.ok(allowedAfter.some(value => isDeepStrictEqual(wireFields(value), current.fields)));
      await remove(path, current);
    }
  }
}
async function sdkDecision(action) {
  try { await action(); return 'ALLOW'; }
  catch (e) { if (e.code === 'permission-denied') return 'DENY'; throw e; }
}
async function read(client, path) {
  // Lite reads always go to the server. Each document read may see a brief
  // permission denial during release propagation; the scored write is never retried.
  for (let attempt = 1; ; attempt++) {
    try {
      const snap = await lite.getDoc(lite.doc(client.lite, path));
      return snap.exists() ? snap.data() : null;
    } catch (error) {
      journal.event('readback-error', {path, attempt, code: error.code ?? 'unknown'});
      if (attempt >= 20 || !['permission-denied','unavailable','deadline-exceeded'].includes(error.code)) throw error;
      await delay(3000);
    }
  }
}

async function capture(mode) {
  const source = readFileSync(new URL(mode + '.rules', probe), 'utf8');
  const phases = receipt.phases[mode] = {};
  let controlPath;
  try { await withRelease({runId, journal, source, digest: hashes[mode], checkStop,
    async setupClients(config) {
      const list = await api(dbUrl + '/documents:listCollectionIds', 'POST', {pageSize: 1000});
      assert.ok(!list.nextPageToken);
      const roots = [...source.matchAll(/^    match \/(\w+)/gm)].map(m => m[1]);
      assert.ok(!(list.collectionIds ?? []).some(id => roots.includes(id)), 'previously populated application path');
      if (!actor) {
        actor = await clients.add('actor', config);
        owner = await clients.add('owner-reader', config);
        receipt.actor = actor.identity; receipt.owner = owner.identity;
      }
      controlPath = 'mapPins/' + actor.identity.uid;
      assert.equal(await raw(controlPath), null);
    },
    async checkPropagation(phase, proof) {
      const open = phase === 'open', expected = open ? 'ALLOW' : 'DENY';
      const ref = lite.doc(actor.lite, controlPath);
      let streak = 0;
      for (let i = 0; i < 70; i++) {
        const write = await sdkDecision(() => lite.setDoc(ref, {runId}));
        const get = await sdkDecision(async () => {
          const snap = await lite.getDoc(ref);
          if (open && write === 'ALLOW') assert.deepEqual(snap.data(), {runId});
        });
        const readerGet = await sdkDecision(async () => {
          const snap = await lite.getDoc(lite.doc(owner.lite, controlPath));
          if (open && write === 'ALLOW') assert.deepEqual(snap.data(), {runId});
        });
        if (get === expected && readerGet === expected && write === expected) streak++; else streak = 0;
        if (streak >= 2) {
          const result = {phase, proof, get, readerGet, write, at: now()};
          journal.event('propagation-confirmed', {mode, ...result});
          phases[phase] = result;
          return journal.retain(result);
        }
        await delay(3000);
      }
      throw Error('propagation timed out: ' + phase);
    },
    async capture(verify) {
      for (const role of roles) {
        const config = configFor(role, actor.identity.uid, owner.identity.uid);
        const run = async () => {
          for (const op of operations) {
            checkStop();
            journal.event('begin-case', {mode, role, op});
            const deletion = op === 'event-delete';
            const id = [mode, role, op].join('-');
            const path = deletion ? 'events/oracle-' + runId : 'players/' + owner.identity.uid;
            const data = deletion ? event : profile;
            await seeded(path, data, async seed => {
              const deploymentBefore = await verify();
              const configBefore = await raw('world/config');
              assert.deepEqual(await read(owner, 'world/config'), config);
              const before = await read(owner, path);
              assert.deepEqual(before, data);
              const ref = lite.doc(actor.lite, path), attemptedAt = now();
              const decision = await sdkDecision(() => deletion ? lite.deleteDoc(ref) : lite.updateDoc(ref, patch));
              const stored = await read(owner, path), afterDocument = await raw(path);
              const configAfter = await raw('world/config');
              assert.deepEqual(configAfter, configBefore);
              const row = {mode, role, op, path, config, configBefore, configAfter, before, seed, proposal: deletion ? null : patch,
                decision, code: decision === 'ALLOW' ? 'ok' : 'permission-denied', stored, afterDocument, attemptedAt,
                readAt: now(), deploymentBefore, deploymentAfter: await verify()};
              receipt.rows[id] = row; journal.event('scored', {id, ...row});
              console.log(id, decision, JSON.stringify(stored));
            }, deletion ? [event] : [profile, {...profile, ...patch}]);
          }
        };
        assert.equal(await raw('world/config'), null);
        if (config) await seeded('world/config', config, run); else await run();
      }
    },
  }); } finally {
    const marker = controlPath && await raw(controlPath);
    if (marker) {
      assert.deepEqual(marker.fields, wireFields({runId}));
      await remove(controlPath, marker);
    }
  }
}
await withMonotonicEvidenceClock(async () => {
  try { for (const mode of Object.keys(hashes)) await capture(mode); }
  finally { await clients.close(); }
  const digest = journal.retain(receipt);
  journal.complete({runId, digest});
  console.log('Completed', runId, digest);
});
