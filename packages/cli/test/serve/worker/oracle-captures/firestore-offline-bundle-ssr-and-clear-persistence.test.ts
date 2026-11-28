import { describe, expect, it } from 'bun:test';
import { FirebaseError, deleteApp, getApps, initializeApp } from 'pyric/app';
import { resetAppRegistryForTests } from 'pyric/app/internal';
import { setRules } from 'pyric/sandbox/firestore';
import { connectClientToHost, makeHostCtx } from '../integration-support.js';
import {
  buildSyntheticArticlesBundle,
  makeWorkerPlaneDriver,
  replayWithDriver,
} from './firestore-offline-bundle-ssr-driver.ts';
import { hostedFirestoreContext } from './hosted-firestore-support.ts';
import { expectReplay, load, loadServedFirestoreSurface, restoreSharedWorker } from './support.ts';

restoreSharedWorker();

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

describe('firestore-offline-bundle-ssr-and-clear-persistence oracle capture (served worker + Node host)', () => {
  it('replays over SharedWorker client + host handles with zero pins (firestore#142, #153, #154)', async () => {
    const production = load('firestore-offline-bundle-ssr-and-clear-persistence');
    const host = await makeHostCtx();
    setRules(host.sandbox, OPEN_RULES);
    try {
      const driver = makeWorkerPlaneDriver(
        (app) => connectClientToHost(host, `worker://bundle-ssr-${app.name}`).db,
      );
      const pyric = await replayWithDriver(driver, 'served-worker-bundle-ssr');
      expectReplay({ production, pyric, pins: [] });
    } finally {
      host.sandbox.dispose();
    }
  });

  it('replays over Node-hosted loopback WebSocket handles with zero pins (firestore#142, #153, #154)', async () => {
    const production = load('firestore-offline-bundle-ssr-and-clear-persistence');
    const hosted = await hostedFirestoreContext();
    const preAllocated = new Map<string, { port: object }>();
    const labels = [
      'producer',
      'uint8',
      'ssr-consumer',
      'resume-doc',
      'resume-query',
      'clear-fresh',
      'clear-running',
    ];
    for (const label of labels) {
      const opened = await hosted.newClient(`hosted-bundle-${label}`);
      preAllocated.set(`served-hosted-bundle-ssr-${label}`, opened.db as unknown as { port: object });
    }
    const driver = makeWorkerPlaneDriver(
      (app) => preAllocated.get(app.name) ?? (hosted.db as unknown as { port: object }),
    );
    const pyric = await replayWithDriver(driver, 'served-hosted-bundle-ssr');
    expectReplay({ production, pyric, pins: [] });
  });

  it('routes surface.loadBundle, surface.documentSnapshotFromJSON, and surface.clearIndexedDbPersistence end-to-end', async () => {
    const host = await makeHostCtx();
    setRules(host.sandbox, OPEN_RULES);
    const surface = await loadServedFirestoreSurface(host);
    if (getApps().length === 0) await resetAppRegistryForTests();
    const existingApp = getApps()[0];
    let appOptions = { apiKey: 'fake-api-key', projectId: 'demo-firestore-bundle-ssr-probe' };
    if (existingApp !== undefined) appOptions = existingApp.options as typeof appOptions;
    const app = initializeApp(appOptions, 'served-surface-direct-bundle-ssr');
    try {
      const db = surface.getFirestore(app);
      await surface.clearIndexedDbPersistence(db);
      const bundle = buildSyntheticArticlesBundle('demo-firestore-bundle-ssr-probe');
      const progress = await surface.loadBundle(db, bundle);
      expect(progress.taskState).toBe('Success');
      expect(() => surface.clearIndexedDbPersistence(db)).toThrow(FirebaseError);
      const snap = await surface.getDocFromCache(surface.doc(db, 'articles/alpha'));
      const hydrated = surface.documentSnapshotFromJSON(db, snap.toJSON());
      expect(hydrated.data()).toEqual({ title: 'First Post', published: true, rank: 1 });
      await surface.terminate(db);
      await surface.clearIndexedDbPersistence(db);
    } finally {
      await deleteApp(app);
      host.sandbox.dispose();
    }
  });
});
