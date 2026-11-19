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
import { hostedFirestoreContext } from './hosted-firestore-support.ts';
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
  { key: 'nullField', finding: 'FL-30: aggregations on several fields need a composite index', production: { error: 'failed-precondition' }, pyric: { n: 2, sx: 3, sy: 4 } },
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

  it('getAggregateFromServer over the Node host WebSocket aggregates as in-page', async () => {
    const context = await hostedFirestoreContext();
    const pyric = withoutMessages(await aggregates.run(context));
    expectReplay({ production: AGGREGATE_PRODUCTION(), pyric, pins: AGGREGATE_PINS });

    const adminDb = await context.openRemoteAdminFirestore();
    const nanAdmin = await adminDb.collection(`${context.base}/agnan`).aggregate({
      s: { kind: 'sum', field: 'v' },
      a: { kind: 'average', field: 'v' },
      n: { kind: 'count' },
    });
    expect(nanAdmin.data().n).toBe(3);
    expect(Number.isNaN(nanAdmin.data().s)).toBe(true);
    expect(Number.isNaN(nanAdmin.data().a)).toBe(true);

    const infAdmin = await adminDb.collection(`${context.base}/aginf`).aggregate({
      s: { kind: 'sum', field: 'v' },
      a: { kind: 'average', field: 'v' },
      n: { kind: 'count' },
    });
    expect(infAdmin.data()).toEqual({ s: Infinity, a: Infinity, n: 2 });
  });

  describe('FP-9: network, cache, persistence, and termination lifecycle conform across served planes', () => {
    const lifecycle = load('firestore-browser-lifecycle');

    it('a write after disableNetwork stays pending with local cache metadata until enableNetwork across planes', async () => {
      const db = inPageDb();
      await surface.disableNetwork(db);
      let settled = false;
      const write = ip.setDoc(ip.doc(db, 'lifecycle/network'), { value: 'offline' }).then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(!settled).toBe(lifecycle.offlineWritePending as boolean);
      const local = await ip.getDoc(ip.doc(db, 'lifecycle/network'));
      expect(local.data()?.value).toBe(lifecycle.offlineLocalValue as string);
      expect(local.metadata.fromCache).toBe(lifecycle.offlineSnapshotFromCache as boolean);
      expect(local.metadata.hasPendingWrites).toBe(lifecycle.offlineSnapshotHasPendingWrites as boolean);
      await surface.enableNetwork(db);
      await write;
      expect((await ip.getDoc(ip.doc(db, 'lifecycle/network'))).data()?.value).toBe(
        lifecycle.reconnectedServerValue as string,
      );

      for (const ctx of [await servedFirestoreContext(), await hostedFirestoreContext()]) {
        const ref = ctx.fs.doc(ctx.db, `${ctx.base}/lifecycle/network`);
        await ctx.fs.disableNetwork(ctx.db);
        let planeSettled = false;
        const planeWrite = ctx.fs.setDoc(ref, { value: 'offline' }).then(() => { planeSettled = true; });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(!planeSettled).toBe(lifecycle.offlineWritePending as boolean);
        const planeLocal = await ctx.fs.getDoc(ref);
        expect(planeLocal.data()?.value).toBe(lifecycle.offlineLocalValue as string);
        expect(planeLocal.metadata.fromCache).toBe(lifecycle.offlineSnapshotFromCache as boolean);
        expect(planeLocal.metadata.hasPendingWrites).toBe(lifecycle.offlineSnapshotHasPendingWrites as boolean);
        await ctx.fs.enableNetwork(ctx.db);
        await planeWrite;
        expect((await ctx.fs.getDoc(ref)).data()?.value).toBe(lifecycle.reconnectedServerValue as string);
      }
    });

    it('getDocFromCache on a doc never read rejects unavailable as production does', async () => {
      const host = await makeHostCtx();
      setRules(host.sandbox, OPEN_RULES);
      try {
        const { db } = connectClientToHost(host, `worker://served-cache-${Math.random()}`);
        expect([lifecycle.coldCacheThrew, lifecycle.coldCacheCode]).toEqual([true, 'unavailable']);
        await expect(
          readDocumentAs(client.doc(db, 'lifecycle/cache'), 'getDocFromCache'),
        ).rejects.toMatchObject({ code: lifecycle.coldCacheCode });
      } finally {
        host.sandbox.dispose();
      }
    });

    it('enableIndexedDbPersistence after first use rejects failed-precondition as production does', async () => {
      const db = inPageDb();
      await ip.getDoc(ip.doc(db, 'lifecycle/precondition'));
      expect([lifecycle.persistenceAfterUseThrew, lifecycle.persistenceAfterUseCode]).toEqual([true, 'failed-precondition']);
      await expect(surface.enableIndexedDbPersistence(db)).rejects.toMatchObject({
        code: lifecycle.persistenceAfterUseCode,
      });
    });
  });
});
