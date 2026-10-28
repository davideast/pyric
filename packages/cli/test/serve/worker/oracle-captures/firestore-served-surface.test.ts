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
import type { FirestoreScenarioContext, FirestoreSdk } from '../../../../../conformance/src/capture/sdk-scenarios/scenario-types.ts';
import { expectReplay, load, restoreSharedWorker, servedFirestoreContext, withoutMessages, type Pin } from './support.ts';

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

/** The aggregate findings other items own (#1374); the in-page replay pins the same answers. */
const AGGREGATE_PINS: Pin[] = [
  { key: 'multi', finding: 'FL-30: aggregations on several fields need a composite index', production: { error: 'failed-precondition' }, pyric: { n: 4, sx: 6, sy: 16, ay: 16 / 3 } },
  { key: 'countAndSumY', finding: 'FL-27: count with sum(y) counts only docs that have y', production: { n: 3, sy: 16 }, pyric: { n: 4, sy: 16 } },
  { key: 'nullField', finding: 'FL-30: aggregations on several fields need a composite index', production: { error: 'failed-precondition' }, pyric: { n: 2, sx: 3, sy: 4 } },
  { key: 'nan', finding: 'FL-28: sum and average over a NaN value are NaN', production: { s: 'NaN', a: 'NaN', n: 3 }, pyric: { s: 3, a: 1.5, n: 3 } },
  { key: 'inf', finding: 'FL-28: sum and average over Infinity are Infinity', production: { s: 'Infinity', a: 'Infinity', n: 2 }, pyric: { s: 1, a: 1, n: 2 } },
];

/** A replay context on the plane the surface picked at load: the worker client and host, or the in-page sandbox. */
async function surfacePlaneContext(): Promise<FirestoreScenarioContext> {
  const servedOverWorker = surface.getAggregateFromServer === (client.getAggregateFromServer as unknown);
  if (servedOverWorker) return servedFirestoreContext();
  return {
    ...replayTiming,
    fs: ip as unknown as FirestoreSdk,
    db: inPageDb() as never,
    base: 'pyric_oracle/replay',
    deniedDocPath: 'pyric_oracle_denied_replay/x',
    newClient: async () => ({ db: inPageDb() as never }),
  };
}

/** Which plane's implementation a surface export is. */
function planeOf(exported: unknown, inPage: unknown, worker: unknown): 'in-page' | 'worker' | 'neither' {
  if (exported === inPage) return 'in-page';
  if (exported === worker) return 'worker';
  return 'neither';
}

const AGGREGATE_PRODUCTION = () => withoutMessages(load('firestore-aggregate-field-semantics'));

describe('served firestore surface', () => {
  it('getAggregateFromServer is the data-path pick, as getCountFromServer is', () => {
    const aggregate = planeOf(surface.getAggregateFromServer, ip.getAggregateFromServer, client.getAggregateFromServer);
    const countOnly = planeOf(surface.getCountFromServer, ip.getCountFromServer, client.getCountFromServer);
    expect(aggregate).toBe(countOnly);
  });

  it('the served getAggregateFromServer aggregates as production does, apart from the aggregate findings', async () => {
    const context = await surfacePlaneContext();
    const fs = { ...context.fs, getAggregateFromServer: surface.getAggregateFromServer } as unknown as FirestoreSdk;
    const pyric = withoutMessages(await aggregates.run({ ...context, fs }));
    expectReplay({ production: AGGREGATE_PRODUCTION(), pyric, pins: AGGREGATE_PINS });
  });

  it('getAggregateFromServer over the worker client and host aggregates as in-page', async () => {
    const pyric = withoutMessages(await aggregates.run(await servedFirestoreContext()));
    expectReplay({ production: AGGREGATE_PRODUCTION(), pyric, pins: AGGREGATE_PINS });
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
