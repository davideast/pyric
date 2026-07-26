import { describe, expect, it } from 'bun:test';
import * as firestore from '../../src/firestore/index.ts';

describe('Firestore offline caching, indexing, and tab sync controllers (Pillar 2)', () => {
  it('exports PersistentCacheIndexManager and controller functions', async () => {
    expect(typeof (firestore as any).PersistentCacheIndexManager).toBe('function');
    expect(typeof (firestore as any).getPersistentCacheIndexManager).toBe('function');
    expect(typeof (firestore as any).enablePersistentCacheIndexAutoCreation).toBe('function');
    expect(typeof (firestore as any).disablePersistentCacheIndexAutoCreation).toBe('function');
    expect(typeof (firestore as any).deleteAllPersistentCacheIndexes).toBe('function');
    expect(typeof (firestore as any).setIndexConfiguration).toBe('function');

    const mockDb = {} as any;
    const mgr = (firestore as any).getPersistentCacheIndexManager(mockDb);
    expect(mgr).toBeInstanceOf((firestore as any).PersistentCacheIndexManager);
    await expect((firestore as any).enablePersistentCacheIndexAutoCreation(mgr)).resolves.toBeUndefined();
    await expect((firestore as any).disablePersistentCacheIndexAutoCreation(mgr)).resolves.toBeUndefined();
    await expect((firestore as any).deleteAllPersistentCacheIndexes(mgr)).resolves.toBeUndefined();
    await expect((firestore as any).setIndexConfiguration(mockDb, { indexes: [] })).resolves.toBeUndefined();
  });
});
