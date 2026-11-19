import { describe, expect, it } from 'bun:test';
import {
  CACHE_SIZE_UNLIMITED,
  memoryEagerGarbageCollector,
  memoryLocalCache,
  memoryLruGarbageCollector,
  persistentLocalCache,
  persistentMultipleTabManager,
  persistentSingleTabManager,
} from 'pyric/firestore';

describe('cache-tokens', () => {
  it('mints tab-manager tokens with firebase/firestore kind and toJSON shapes', () => {
    const singleDefault = persistentSingleTabManager(undefined);
    const singleForced = persistentSingleTabManager({ forceOwnership: true });
    const multiple = persistentMultipleTabManager();

    expect(singleDefault.kind).toBe('persistentSingleTab');
    expect(singleDefault.toJSON()).toEqual({ kind: 'persistentSingleTab' });
    expect(singleForced.kind).toBe('persistentSingleTab');
    expect(singleForced.toJSON()).toEqual({ kind: 'persistentSingleTab' });
    expect(multiple.kind).toBe('PersistentMultipleTab');
    expect(multiple.toJSON()).toEqual({ kind: 'PersistentMultipleTab' });
    expect(Object.is(singleDefault, singleForced)).toBe(false);
    expect(Object.is(singleDefault, multiple)).toBe(false);
  });

  it('mints garbage-collector tokens with firebase/firestore kind and toJSON shapes', () => {
    const eager = memoryEagerGarbageCollector();
    const lruBounded = memoryLruGarbageCollector({ cacheSizeBytes: 2_097_152 });
    const lruUnlimited = memoryLruGarbageCollector({ cacheSizeBytes: CACHE_SIZE_UNLIMITED });

    expect(CACHE_SIZE_UNLIMITED).toBe(-1);
    expect(eager.kind).toBe('memoryEager');
    expect(eager.toJSON()).toEqual({ kind: 'memoryEager' });
    expect(lruBounded.kind).toBe('memoryLru');
    expect(lruBounded.toJSON()).toEqual({ kind: 'memoryLru' });
    expect(lruUnlimited.kind).toBe('memoryLru');
    expect(lruUnlimited.toJSON()).toEqual({ kind: 'memoryLru' });
    expect(Object.is(eager, lruBounded)).toBe(false);
  });

  it('mints localCache tokens for both settings-wrapped and bare tabManager forms', () => {
    const eager = memoryEagerGarbageCollector();
    const multiTab = persistentMultipleTabManager();
    const memDefault = memoryLocalCache();
    const memEager = memoryLocalCache({ garbageCollector: eager });
    const persDefault = persistentLocalCache();
    const persWrapped = persistentLocalCache({ tabManager: multiTab, cacheSizeBytes: 8_388_608 });
    const persDirect = persistentLocalCache(multiTab);

    expect(memDefault.kind).toBe('memory');
    expect(memDefault.toJSON()).toEqual({ kind: 'memory' });
    expect(memEager.garbageCollector).toBe(eager);
    expect(persDefault.kind).toBe('persistent');
    expect(persDefault.toJSON()).toEqual({ kind: 'persistent' });
    expect(persWrapped.tabManager).toBe(multiTab);
    expect(persDirect.tabManager).toBe(multiTab);
    expect(JSON.parse(JSON.stringify(persWrapped))).toEqual({ kind: 'persistent' });
    expect(Object.is(memDefault, persDefault)).toBe(false);
  });
});
