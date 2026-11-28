import { afterEach, describe, expect, it } from 'bun:test';
import { deleteApp, getApps, initializeApp } from 'pyric/app';
import { resetAppRegistryForTests } from 'pyric/app/internal';
import { setRules } from 'pyric/sandbox/firestore';
import * as client from '../../../../src/serve/worker/index.js';
import { onSnapshotsInSync as workerOnSnapshotsInSync } from '../../../../src/serve/worker/client/firestore-reads.js';
import type { FirestoreScenarioContext } from '../../../../../conformance/src/capture/sdk-scenarios/scenario-types.ts';
import { makeHostCtx } from '../integration-support.js';
import { hostedFirestoreContext } from './hosted-firestore-support.ts';
import { load, loadServedFirestoreSurface, restoreSharedWorker, servedFirestoreContext } from './support.ts';

restoreSharedWorker();

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
  resetAppRegistryForTests();
});

async function caughtCode(fn: () => Promise<unknown>): Promise<{ threw: boolean; code: string | null }> {
  try {
    await fn();
    return { threw: false, code: null };
  } catch (error) {
    let code: string | null = null;
    if (error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
      code = (error as { code: string }).code;
    }
    return { threw: true, code };
  }
}

interface PlaneFactory {
  readonly name: string;
  open(): Promise<FirestoreScenarioContext>;
}

const PLANES: readonly PlaneFactory[] = [
  { name: 'SharedWorker client+host', open: () => servedFirestoreContext() },
  { name: 'Node host loopback WebSocket', open: () => hostedFirestoreContext() },
];

describe('3-plane oracle replay: firestore-browser-lifecycle (FP-9)', () => {
  const obs = load('firestore-browser-lifecycle');

  for (const plane of PLANES) {
    it(`replays persistence, cache, network, sync, and termination isolation over ${plane.name}`, async () => {
      const ctx = await plane.open();
      const { fs } = ctx;
      const fsExt = fs as typeof fs & {
        enableIndexedDbPersistence(db: unknown): Promise<void>;
        enableMultiTabIndexedDbPersistence(db: unknown): Promise<void>;
        terminate(db: unknown): Promise<void>;
      };

      // FS-140 & FS-141: persistence preconditions before and after first use + two-client multi-tab
      const freshSingle = (await ctx.newClient('single-fresh')).db;
      const singleFreshRes = await caughtCode(() => fsExt.enableIndexedDbPersistence(freshSingle));
      expect(singleFreshRes).toEqual({ threw: false, code: null });

      const startedSingle = (await ctx.newClient('single-started')).db;
      await fs.getDoc(fs.doc(startedSingle, `${ctx.base}/lc/precondition`));
      const singleAfterUse = await caughtCode(() => fsExt.enableIndexedDbPersistence(startedSingle));
      expect(singleAfterUse).toEqual({
        threw: obs.persistenceAfterUseThrew as boolean,
        code: obs.persistenceAfterUseCode as string,
      });

      const multiFresh = (await ctx.newClient('multi-fresh')).db;
      const multiFreshRes = await caughtCode(() => fsExt.enableMultiTabIndexedDbPersistence(multiFresh));
      expect(multiFreshRes).toEqual({
        threw: obs.multiTabEnableThrew as boolean,
        code: obs.multiTabEnableCode as string | null,
      });

      const multiAfterUseDb = (await ctx.newClient('multi-started')).db;
      await fs.getDoc(fs.doc(multiAfterUseDb, `${ctx.base}/lc/multi-precondition`));
      const multiAfterUse = await caughtCode(() => fsExt.enableMultiTabIndexedDbPersistence(multiAfterUseDb));
      expect(multiAfterUse).toEqual({
        threw: obs.multiTabAfterUseThrew as boolean,
        code: obs.multiTabAfterUseCode as string,
      });

      const multiClientA = (await ctx.newClient('multi-two-a')).db;
      const multiClientB = (await ctx.newClient('multi-two-b')).db;
      const twoClientsRes = await caughtCode(async () => {
        await fsExt.enableMultiTabIndexedDbPersistence(multiClientA);
        await fsExt.enableMultiTabIndexedDbPersistence(multiClientB);
      });
      expect(twoClientsRes).toEqual({
        threw: obs.multiTabTwoClientsThrew as boolean,
        code: obs.multiTabTwoClientsCode as string | null,
      });

      // FS-148: cold vs warm getDocFromCache and getDocsFromCache across isolated clients
      const cacheDb = (await ctx.newClient('cache-doc')).db;
      const cacheRef = fs.doc(cacheDb, `${ctx.base}/lc/cache-doc`);
      const coldDocRes = await caughtCode(() => fs.getDocFromCache(cacheRef));
      expect(coldDocRes).toEqual({
        threw: obs.coldCacheThrew as boolean,
        code: obs.coldCacheCode as string,
      });
      await fs.setDoc(cacheRef, { value: 'warm' });
      await fs.getDoc(cacheRef);
      const warmDocSnap = await fs.getDocFromCache(cacheRef);
      expect(warmDocSnap.data()?.value).toBe(obs.warmCacheValue as string);
      expect(warmDocSnap.metadata.fromCache).toBe(true);

      const querySeeder = (await ctx.newClient('query-seeder')).db;
      const queryReader = (await ctx.newClient('query-reader')).db;
      await fs.setDoc(fs.doc(querySeeder, `${ctx.base}/lc_qcache/server-only`), { value: 1 });
      const cacheColl = fs.collection(queryReader, `${ctx.base}/lc_qcache`);
      const coldQuerySnap = await fs.getDocsFromCache(cacheColl);
      expect(coldQuerySnap.size).toBe(obs.coldQueryCacheSize as number);
      expect(coldQuerySnap.metadata.fromCache).toBe(true);

      const serverQuerySnap = await fs.getDocsFromServer(cacheColl);
      expect(serverQuerySnap.size).toBe(obs.serverQuerySize as number);

      const warmQuerySnap = await fs.getDocsFromCache(cacheColl);
      expect(warmQuerySnap.size).toBe(obs.warmQueryCacheSize as number);
      expect(warmQuerySnap.metadata.fromCache).toBe(true);

      // FS-150: onSnapshotsInSync ordering around write-driven snapshot delivery
      const syncDb = (await ctx.newClient('sync-order')).db;
      const syncRef = fs.doc(syncDb, `${ctx.base}/lc/sync-doc`);
      const ordering: string[] = [];
      let initialDelivered = false;
      const stopSnap = fs.onSnapshot(syncRef, (snap) => {
        if (!initialDelivered) {
          initialDelivered = true;
          return;
        }
        const val = snap.data()?.value;
        if (typeof val === 'string') {
          ordering.push(`snapshot:${val}`);
        }
      });
      await ctx.wait();
      const stopSync = workerOnSnapshotsInSync(syncDb as unknown as client.ClientDb, () => {
        ordering.push('sync');
      });
      await fs.setDoc(syncRef, { value: 'written' });
      await ctx.wait();
      stopSnap();
      stopSync();
      expect(ordering).toEqual(obs.snapshotSyncOrdering as string[]);

      // FS-152: single-instance terminate isolation leaving Auth and sibling Firestore alive
      const termDb = (await ctx.newClient('term-target')).db;
      const siblingDb = (await ctx.newClient('term-sibling')).db;
      const heldRef = fs.doc(termDb, `${ctx.base}/lc/terminated`);
      await fs.setDoc(heldRef, { value: 'before' });

      await fsExt.terminate(termDb);
      const afterTermRead = await caughtCode(() => fs.getDoc(heldRef));
      expect(afterTermRead).toEqual({
        threw: obs.readAfterTerminateThrew as boolean,
        code: obs.readAfterTerminateCode as string,
      });

      const authRes = await caughtCode(async () => {
        const auth = client.getAuth(termDb as unknown as client.ClientDb);
        await client.signInAnonymously(auth);
      });
      expect(authRes.threw).toBe(obs.authAfterTerminateThrew as boolean);

      const siblingRef = fs.doc(siblingDb, `${ctx.base}/lc/terminated`);
      const siblingWriteRead = await caughtCode(async () => {
        await fs.setDoc(siblingRef, { value: 'sibling' });
      });
      expect(siblingWriteRead.threw).toBe(obs.siblingAfterTerminateThrew as boolean);
      expect((await fs.getDoc(siblingRef)).data()?.value).toBe(obs.siblingAfterTerminateValue as string);
    });
  }

  it('replays surface getFirestore -> terminate -> fresh getFirestore and cache/persistence guards', async () => {
    const host = await makeHostCtx();
    setRules(
      host.sandbox,
      `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }`,
    );
    const surface = await loadServedFirestoreSurface(host);
    const app = initializeApp({ projectId: 'demo-surface-lc', apiKey: 'demo-key' }, 'surface-lc-app');
    try {
      const db1 = surface.getFirestore(app);
      await expect(surface.enableIndexedDbPersistence(db1)).resolves.toBeUndefined();
      await expect(surface.enableIndexedDbPersistence(db1)).rejects.toMatchObject({
        code: obs.persistenceAfterUseCode,
      });

      const coldRef = surface.doc(db1, 'items/cold-surface');
      await expect(surface.getDocFromCache(coldRef)).rejects.toMatchObject({
        code: obs.coldCacheCode,
      });

      const heldRef = surface.doc(db1, 'items/held-surface');
      await surface.setDoc(heldRef, { value: 'warm' });
      expect((await surface.getDocFromCache(heldRef)).data()?.value).toBe(obs.warmCacheValue);

      await surface.terminate(db1);
      await expect(surface.getDoc(heldRef)).rejects.toMatchObject({
        code: obs.readAfterTerminateCode,
      });
      await expect(surface.clearIndexedDbPersistence(db1)).resolves.toBeUndefined();

      const db2 = surface.getFirestore(app);
      expect(db2).not.toBe(db1);
      const freshRef = surface.doc(db2, 'items/held-surface');
      await surface.setDoc(freshRef, { value: 'sibling' });
      expect((await surface.getDoc(freshRef)).data()?.value).toBe(obs.siblingAfterTerminateValue);
    } finally {
      await deleteApp(app);
      host.sandbox.dispose();
    }
  });
});
