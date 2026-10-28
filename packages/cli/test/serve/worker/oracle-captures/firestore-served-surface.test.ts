/**
 * The served `firebase/firestore` surface (`entries/firestore-surface.ts`), the
 * module a served page and a registered Node process import, checked against
 * production observations. The surface picks its data path once, at load, and
 * other tests in this process may have switched it to the worker; so each test
 * takes only the export under test from the surface and does the rest through
 * `pyric/firestore` or the worker client directly.
 */
import { describe, expect, it } from 'bun:test';
import * as ip from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import * as surface from '../../../../src/serve/entries/firestore-surface.js';
import * as client from '../../../../src/serve/worker/index.js';
import { readDocumentAs } from '../../../../src/serve/worker/client/firestore-reads.js';
import { connectClientToHost, makeHostCtx } from '../integration-support.js';
import { scenario as aggregates } from '../../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-aggregate-field-semantics.scenario.ts';
import { replayTiming } from '../../../../../conformance/src/capture/sdk-scenarios/scenario-timing.ts';
import type { FirestoreSdk } from '../../../../../conformance/src/capture/sdk-scenarios/scenario-types.ts';
import { expectReplay, load, restoreSharedWorker, withoutMessages } from './support.ts';

restoreSharedWorker();

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

function inPageDb() {
  const sandbox = initializeSandbox();
  setRules(sandbox, OPEN_RULES);
  return ip.getFirestore(sandbox.withAuth({ uid: 'alice' }));
}

const UNSUPPORTED = { error: 'firestore/unsupported-in-served-mode' };

describe('served firestore surface', () => {
  it('FP-4: getAggregateFromServer throws unsupported-in-served-mode where production aggregates', async () => {
    // The served export, over a sandbox that does aggregate.
    const fs = { ...ip, getAggregateFromServer: surface.getAggregateFromServer } as unknown as FirestoreSdk;
    const pyric = withoutMessages(await aggregates.run({
      ...replayTiming,
      fs,
      db: inPageDb() as never,
      base: 'pyric_oracle/replay',
      deniedDocPath: 'pyric_oracle_denied_replay/x',
      newClient: async () => ({ db: inPageDb() as never }),
    }));
    const finding = 'FP-4: a leftover stub (entries/unsupported/firestore.ts) shadows the worker client and host implementation';
    expectReplay({
      production: withoutMessages(load('firestore-aggregate-field-semantics')),
      pyric,
      pins: [
        { key: 'multi', finding: `${finding}; FL-30`, production: { error: 'failed-precondition' }, pyric: UNSUPPORTED },
        { key: 'countOnly', finding, production: { n: 4 }, pyric: UNSUPPORTED },
        { key: 'countAndSumY', finding: `${finding}; FL-27`, production: { n: 3, sy: 16 }, pyric: UNSUPPORTED },
        { key: 'nullField', finding: `${finding}; FL-30`, production: { error: 'failed-precondition' }, pyric: UNSUPPORTED },
        { key: 'nan', finding: `${finding}; FL-28`, production: { s: 'NaN', a: 'NaN', n: 3 }, pyric: UNSUPPORTED },
        { key: 'inf', finding: `${finding}; FL-28`, production: { s: 'Infinity', a: 'Infinity', n: 2 }, pyric: UNSUPPORTED },
      ],
    });
  });

  describe('FP-9: network and persistence calls are accepted no-ops', () => {
    const lifecycle = load('firestore-browser-lifecycle');

    it('a write after disableNetwork commits at once; production keeps it pending', async () => {
      const db = inPageDb();
      await surface.disableNetwork(db);
      let settled = false;
      const write = ip.setDoc(ip.doc(db, 'lifecycle/network'), { value: 'offline' }).then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(lifecycle.offlineWritePending).toBe(true);
      expect(!settled).toBe(false);
      await write;
    });

    it('getDocFromCache on a doc never read resolves; production rejects unavailable', async () => {
      // Over the worker, the surface's getDocFromCache is this read of the host's store.
      const host = await makeHostCtx();
      setRules(host.sandbox, OPEN_RULES);
      const { db } = connectClientToHost(host, `worker://served-cache-${Math.random()}`);
      expect([lifecycle.coldCacheThrew, lifecycle.coldCacheCode]).toEqual([true, 'unavailable']);
      const snapshot = await readDocumentAs(client.doc(db, 'lifecycle/cache'), 'getDocFromCache');
      expect(snapshot.exists()).toBe(false);
    });

    it('enableIndexedDbPersistence after first use resolves; production fails failed-precondition', async () => {
      const db = inPageDb();
      await ip.getDoc(ip.doc(db, 'lifecycle/precondition'));
      expect([lifecycle.persistenceAfterUseThrew, lifecycle.persistenceAfterUseCode]).toEqual([true, 'failed-precondition']);
      await expect(surface.enableIndexedDbPersistence(db)).resolves.toBeUndefined();
    });
  });
});
