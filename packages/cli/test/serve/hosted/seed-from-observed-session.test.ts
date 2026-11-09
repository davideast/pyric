import { describe, expect, it } from 'bun:test';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { getFirestore, getDoc, doc } from 'pyric/firestore';
import { listAll, ref } from 'pyric/storage';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { seedFromObservedSession } from '../../../src/serve/hosted/seed-from-observed-session.js';
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
});
