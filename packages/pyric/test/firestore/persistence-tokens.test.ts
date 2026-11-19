import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import * as firestore from 'pyric/firestore';

describe('Firestore offline caching, indexing, and tab sync controllers (Pillar 2)', () => {
  it('returns null on memory local cache and a singleton PersistentCacheIndexManager on persistent local cache', async () => {
    expect(typeof firestore.PersistentCacheIndexManager).toBe('function');
    expect(typeof firestore.getPersistentCacheIndexManager).toBe('function');
    expect(typeof firestore.enablePersistentCacheIndexAutoCreation).toBe('function');
    expect(typeof firestore.disablePersistentCacheIndexAutoCreation).toBe('function');
    expect(typeof firestore.deleteAllPersistentCacheIndexes).toBe('function');
    expect(typeof firestore.setIndexConfiguration).toBe('function');

    const sandbox = initializeSandbox();
    const memDb = firestore.initializeFirestore(sandbox, {
      localCache: firestore.memoryLocalCache(),
    });
    expect(firestore.getPersistentCacheIndexManager(memDb)).toBeNull();

    const persDb = firestore.initializeFirestore(sandbox, {
      localCache: firestore.persistentLocalCache({
        tabManager: firestore.persistentMultipleTabManager(),
      }),
    });
    const mgr = firestore.getPersistentCacheIndexManager(persDb);
    expect(mgr).toBeInstanceOf(firestore.PersistentCacheIndexManager);
    expect(firestore.getPersistentCacheIndexManager(persDb)).toBe(mgr);
    if (mgr === null) {
      throw new Error('Expected non-null PersistentCacheIndexManager');
    }
    expect(mgr.type).toBe('PersistentCacheIndexManager');
    expect(firestore.enablePersistentCacheIndexAutoCreation(mgr)).toBeUndefined();
    expect(firestore.disablePersistentCacheIndexAutoCreation(mgr)).toBeUndefined();
    expect(firestore.deleteAllPersistentCacheIndexes(mgr)).toBeUndefined();
    await expect(firestore.setIndexConfiguration(persDb, { indexes: [] })).resolves.toBeUndefined();
  });
});
