import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { getFirestore, getDoc, doc, getAdminFirestore, setDoc } from 'pyric/firestore';
import { getAdminDatabase, get as databaseGet, ref as databaseRef, sandbox as rtdbSandbox } from 'pyric/database';
import { listAll, ref } from 'pyric/storage';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import {
  createObservedSeedRunner,
  seedFromObservedSession,
} from '../../../src/serve/hosted/seed-from-observed-session.js';
import type { HostCtx } from '../../../src/serve/worker/host.js';
import type { ObservedSessionDataSnapshot } from '../../../src/serve/observed-session/wire.js';

describe('seedFromObservedSession Storage zero-byte invariant', () => {
  it('seeds Firestore and RTDB without fabricating 0-byte placeholder Storage blobs in merge or replace mode', async () => {
    const sandbox = createSandboxRoot();
    const dbName = `pyric-seed-observed-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const adminStorage = getAdminStorageSandbox(sandbox, { dbName });
    const namedBucketStorage = getAdminStorageSandbox(sandbox, {
      dbName,
      bucket: 'demo-proj.firebasestorage.app',
    });
    const ctx: HostCtx = {
      sandbox,
      db: getFirestore(sandbox),
      adminStorage,
      subs: new Map(),
      instanceId: 'seed-storage-test',
    };

    const snapshot: ObservedSessionDataSnapshot = {
      revision: 3,
      updatedAt: 1000,
      projectId: 'demo-proj',
      firestore: { 'docs/doc-1': { title: 'Hello' } },
      rtdb: { default: { items: { a: true } } },
      defaultRtdbInstance: 'default',
      storage: {
        'demo-proj.firebasestorage.app': {
          prefixes: ['workspaces', 'workspaces/ws-1', 'workspaces/ws-1/items'],
          objects: {
            'workspaces/ws-1/items/item-1.png': {
              bucket: 'demo-proj.firebasestorage.app',
              fullPath: 'workspaces/ws-1/items/item-1.png',
              name: 'item-1.png',
              size: 4096,
              contentType: 'image/png',
            },
          },
        },
      },
      defaultStorageBucket: 'demo-proj.firebasestorage.app',
      stats: {
        firestoreDocs: 1,
        rtdbInstances: 1,
        storageBuckets: 1,
        storageObjects: 1,
        byteEstimate: 256,
        truncated: false,
        droppedCount: 0,
      },
    };

    for (const mode of ['merge', 'replace'] as const) {
      const result = await seedFromObservedSession(ctx, snapshot, mode);
      expect(result).toEqual({
        mode,
        seededFirestoreDocs: 1,
        seededRtdbInstances: ['default'],
      });

      const docSnap = await getDoc(doc(ctx.db, 'docs/doc-1'));
      expect(docSnap.exists()).toBe(true);
      expect(docSnap.data()).toEqual({ title: 'Hello' });

      const rootListing = await listAll(ref(adminStorage));
      expect(rootListing.items).toHaveLength(0);
      expect(rootListing.prefixes).toHaveLength(0);

      const namedListing = await listAll(ref(namedBucketStorage));
      expect(namedListing.items).toHaveLength(0);
      expect(namedListing.prefixes).toHaveLength(0);
    }
  });

  it('createObservedSeedRunner serializes queued seeds and enforces project ownership and closed-runtime guards', async () => {
    const sandbox = createSandboxRoot();
    const dbName = `pyric-seed-runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ctx: HostCtx = {
      sandbox,
      db: getFirestore(sandbox),
      adminStorage: getAdminStorageSandbox(sandbox, { dbName }),
      subs: new Map(),
      instanceId: 'seed-runner-test',
    };
    const ownedDir = mkdtempSync(join(tmpdir(), 'pyric-seed-runner-'));
    try {
      let closed = false;
      let restored = 0;
      let flushed = 0;
      const runner = createObservedSeedRunner({
        ctx,
        ownedProjectDir: ownedDir,
        isClosed: () => closed,
        isInOwnedProject: (candidate) => candidate === ownedDir,
        requireHealthyPersistence: () => {},
        restoreFirestoreSubscriptions: () => {
          restored += 1;
        },
        flushPersistence: async () => {
          flushed += 1;
        },
      });

      await expect(
        runner.run(
          {
            revision: 1,
            updatedAt: 1,
            projectId: 'demo-proj',
            firestore: {},
            rtdb: {},
            stats: {
              firestoreDocs: 0,
              rtdbInstances: 0,
              byteEstimate: 0,
              truncated: false,
              droppedCount: 0,
            },
          },
          { callerProjectDir: `${ownedDir}-other` },
        ),
      ).rejects.toThrow('another project');

      const seeded = await runner.run({
        revision: 2,
        updatedAt: 2,
        projectId: 'demo-proj',
        firestore: { 'items/i-1': { ok: true } },
        rtdb: {},
        stats: {
          firestoreDocs: 1,
          rtdbInstances: 0,
          byteEstimate: 32,
          truncated: false,
          droppedCount: 0,
        },
      });
      await runner.pending();
      expect(seeded).toEqual({ mode: 'merge', seededFirestoreDocs: 1, seededRtdbInstances: [] });
      expect(restored).toBe(1);
      expect(flushed).toBe(1);

      closed = true;
      await expect(
        runner.run({
          revision: 3,
          updatedAt: 3,
          projectId: 'demo-proj',
          firestore: {},
          rtdb: {},
          stats: {
            firestoreDocs: 0,
            rtdbInstances: 0,
            byteEstimate: 0,
            truncated: false,
            droppedCount: 0,
          },
        }),
      ).rejects.toThrow('closed');
    } finally {
      rmSync(ownedDir, { recursive: true, force: true });
    }
  });

  it('clears held named RTDB instances on replace and rolls back Firestore and RTDB state atomically on error', async () => {
    const sandbox = createSandboxRoot();
    const dbName = `pyric-seed-atomic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ctx: HostCtx = {
      sandbox,
      db: getFirestore(sandbox),
      adminStorage: getAdminStorageSandbox(sandbox, { dbName }),
      subs: new Map(),
      instanceId: 'seed-atomic-test',
    };
    const adminDb = getAdminFirestore(sandbox);
    await setDoc(doc(adminDb, 'items/existing'), { title: 'KeepOnError' });
    const defaultAdminRtdb = getAdminDatabase(sandbox);
    rtdbSandbox.setData(defaultAdminRtdb, { counters: { n: 7 } });
    const secondaryAdminRtdb = getAdminDatabase(sandbox, 'secondary-db');
    rtdbSandbox.setData(secondaryAdminRtdb, { stale: { keep: 'until-replace' } });

    const failingSnapshot: ObservedSessionDataSnapshot = {
      revision: 4,
      updatedAt: 400,
      projectId: 'demo-proj',
      firestore: { 'items/new-doc': { title: 'PartialWrite' } },
      rtdb: { default: { bad: { 'nested.invalid': 1 } } },
      defaultRtdbInstance: 'default',
      stats: {
        firestoreDocs: 1,
        rtdbInstances: 1,
        byteEstimate: 64,
        truncated: false,
        droppedCount: 0,
      },
    };
    await expect(seedFromObservedSession(ctx, failingSnapshot, 'replace')).rejects.toThrow();

    expect((await getDoc(doc(ctx.db, 'items/existing'))).data()).toEqual({ title: 'KeepOnError' });
    expect((await getDoc(doc(ctx.db, 'items/new-doc'))).exists()).toBe(false);
    expect((await databaseGet(databaseRef(defaultAdminRtdb, '/counters/n'))).val()).toBe(7);
    expect((await databaseGet(databaseRef(secondaryAdminRtdb, '/stale/keep'))).val()).toBe('until-replace');

    const validReplace: ObservedSessionDataSnapshot = {
      revision: 5,
      updatedAt: 500,
      projectId: 'demo-proj',
      firestore: { 'items/fresh': { title: 'Fresh' } },
      rtdb: { default: { counters: { n: 1 } } },
      defaultRtdbInstance: 'default',
      stats: {
        firestoreDocs: 1,
        rtdbInstances: 1,
        byteEstimate: 64,
        truncated: false,
        droppedCount: 0,
      },
    };
    const result = await seedFromObservedSession(ctx, validReplace, 'replace');
    expect(result).toEqual({
      mode: 'replace',
      seededFirestoreDocs: 1,
      seededRtdbInstances: ['default'],
    });
    expect((await getDoc(doc(ctx.db, 'items/existing'))).exists()).toBe(false);
    expect((await getDoc(doc(ctx.db, 'items/fresh'))).data()).toEqual({ title: 'Fresh' });
    expect((await databaseGet(databaseRef(defaultAdminRtdb, '/counters/n'))).val()).toBe(1);
    expect((await databaseGet(databaseRef(secondaryAdminRtdb, '/'))).val()).toBeNull();
  });
});
