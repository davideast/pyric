/**
 * `pyric/firestore` -- offline cache, tab-manager, and garbage-collector
 * configuration tokens matching `firebase/firestore` `kind` and `toJSON()` shapes.
 */

export const DEFAULT_CACHE_SIZE_BYTES = 41_943_040;
const LOCAL_CACHE_SYMBOL: unique symbol = Symbol('pyric/firestore/localCache');
const TAB_MANAGER_SYMBOL: unique symbol = Symbol('pyric/firestore/tabManager');
const GC_SYMBOL: unique symbol = Symbol('pyric/firestore/gc');

export interface PersistentTabManager {
  readonly kind: 'persistentSingleTab' | 'PersistentMultipleTab';
  readonly [TAB_MANAGER_SYMBOL]: 'single' | 'multiple';
  toJSON(): { kind: 'persistentSingleTab' | 'PersistentMultipleTab' };
}

export interface MemoryGarbageCollector {
  readonly kind: 'memoryEager' | 'memoryLru';
  readonly [GC_SYMBOL]: 'eager' | 'lru';
  toJSON(): { kind: 'memoryEager' | 'memoryLru' };
}

export interface LocalCache {
  readonly kind: 'persistent' | 'memory';
  readonly [LOCAL_CACHE_SYMBOL]: 'persistent' | 'memory';
  readonly tabManager?: PersistentTabManager;
  readonly garbageCollector?: MemoryGarbageCollector;
  toJSON(): { kind: 'persistent' | 'memory' };
}

export type FirestoreLocalCache = LocalCache;
export interface PersistentLocalCache extends LocalCache {
  readonly kind: 'persistent';
  readonly [LOCAL_CACHE_SYMBOL]: 'persistent';
}
export interface MemoryLocalCache extends LocalCache {
  readonly kind: 'memory';
  readonly [LOCAL_CACHE_SYMBOL]: 'memory';
}
export interface PersistentMultipleTabManager extends PersistentTabManager {
  readonly kind: 'PersistentMultipleTab';
  readonly [TAB_MANAGER_SYMBOL]: 'multiple';
}
export interface PersistentSingleTabManager extends PersistentTabManager {
  readonly kind: 'persistentSingleTab';
  readonly [TAB_MANAGER_SYMBOL]: 'single';
}
export interface PersistentSingleTabManagerSettings { forceOwnership?: boolean; }
export interface PersistentCacheSettings { tabManager?: PersistentTabManager; cacheSizeBytes?: number; }
export interface MemoryCacheSettings { garbageCollector?: MemoryGarbageCollector; }
export interface MemoryEagerGarbageCollector extends MemoryGarbageCollector {
  readonly kind: 'memoryEager';
  readonly [GC_SYMBOL]: 'eager';
}
export interface MemoryLruGarbageCollector extends MemoryGarbageCollector {
  readonly kind: 'memoryLru';
  readonly [GC_SYMBOL]: 'lru';
}

export interface NormalizedLocalCacheSpec {
  tier: 'default' | 'memory' | 'persistent';
  gcMode: 'eager' | 'lru';
  gcCacheSizeBytes: number;
  tabMode: 'single' | 'multiple';
  forceOwnership: boolean;
  cacheSizeBytes: number;
}

interface NormalizedTabSpec { mode: 'single' | 'multiple'; forceOwnership: boolean; }
interface NormalizedGcSpec { mode: 'eager' | 'lru'; cacheSizeBytes: number; }

const tabSpecs = new WeakMap<object, NormalizedTabSpec>();
const gcSpecs = new WeakMap<object, NormalizedGcSpec>();
const localCacheSpecs = new WeakMap<object, NormalizedLocalCacheSpec>();

function toKindJson<K extends string>(kind: K): () => { kind: K } {
  return () => ({ kind });
}

function baseSpec(tier: 'memory' | 'persistent'): NormalizedLocalCacheSpec {
  return {
    tier,
    gcMode: 'lru',
    gcCacheSizeBytes: DEFAULT_CACHE_SIZE_BYTES,
    tabMode: 'single',
    forceOwnership: false,
    cacheSizeBytes: DEFAULT_CACHE_SIZE_BYTES,
  };
}

export function persistentSingleTabManager(
  settings?: PersistentSingleTabManagerSettings,
): PersistentSingleTabManager {
  const token: PersistentSingleTabManager = {
    kind: 'persistentSingleTab',
    [TAB_MANAGER_SYMBOL]: 'single',
    toJSON: toKindJson('persistentSingleTab'),
  };
  tabSpecs.set(token, { mode: 'single', forceOwnership: settings?.forceOwnership === true });
  return token;
}

export function persistentMultipleTabManager(): PersistentMultipleTabManager {
  const token: PersistentMultipleTabManager = {
    kind: 'PersistentMultipleTab',
    [TAB_MANAGER_SYMBOL]: 'multiple',
    toJSON: toKindJson('PersistentMultipleTab'),
  };
  tabSpecs.set(token, { mode: 'multiple', forceOwnership: false });
  return token;
}

export function memoryEagerGarbageCollector(): MemoryEagerGarbageCollector {
  const token: MemoryEagerGarbageCollector = {
    kind: 'memoryEager',
    [GC_SYMBOL]: 'eager',
    toJSON: toKindJson('memoryEager'),
  };
  gcSpecs.set(token, { mode: 'eager', cacheSizeBytes: DEFAULT_CACHE_SIZE_BYTES });
  return token;
}

export function memoryLruGarbageCollector(settings?: { cacheSizeBytes?: number }): MemoryLruGarbageCollector {
  const token: MemoryLruGarbageCollector = {
    kind: 'memoryLru',
    [GC_SYMBOL]: 'lru',
    toJSON: toKindJson('memoryLru'),
  };
  let size = DEFAULT_CACHE_SIZE_BYTES;
  if (settings !== undefined && typeof settings.cacheSizeBytes === 'number') {
    size = settings.cacheSizeBytes;
  }
  gcSpecs.set(token, { mode: 'lru', cacheSizeBytes: size });
  return token;
}

export function persistentLocalCache(settings?: PersistentCacheSettings): PersistentLocalCache {
  let tabManager: PersistentTabManager | undefined;
  let size = DEFAULT_CACHE_SIZE_BYTES;
  if (settings !== undefined && typeof settings === 'object' && settings !== null) {
    if (TAB_MANAGER_SYMBOL in settings) {
      tabManager = settings as unknown as PersistentTabManager;
    } else {
      tabManager = settings.tabManager;
      if (typeof settings.cacheSizeBytes === 'number') {
        size = settings.cacheSizeBytes;
      }
    }
  }
  const token: PersistentLocalCache = {
    kind: 'persistent',
    [LOCAL_CACHE_SYMBOL]: 'persistent',
    tabManager,
    toJSON: toKindJson('persistent'),
  };
  const spec = baseSpec('persistent');
  spec.cacheSizeBytes = size;
  if (tabManager !== undefined) {
    const recorded = tabSpecs.get(tabManager);
    if (recorded !== undefined) {
      spec.tabMode = recorded.mode;
      spec.forceOwnership = recorded.forceOwnership;
    } else if (tabManager.kind === 'PersistentMultipleTab') {
      spec.tabMode = 'multiple';
    }
  }
  localCacheSpecs.set(token, spec);
  return token;
}

export function memoryLocalCache(settings?: MemoryCacheSettings): MemoryLocalCache {
  let garbageCollector: MemoryGarbageCollector | undefined;
  if (settings !== undefined && typeof settings === 'object' && settings !== null) {
    garbageCollector = settings.garbageCollector;
  }
  const token: MemoryLocalCache = {
    kind: 'memory',
    [LOCAL_CACHE_SYMBOL]: 'memory',
    garbageCollector,
    toJSON: toKindJson('memory'),
  };
  const spec = baseSpec('memory');
  if (garbageCollector !== undefined) {
    const recorded = gcSpecs.get(garbageCollector);
    if (recorded !== undefined) {
      spec.gcMode = recorded.mode;
      spec.gcCacheSizeBytes = recorded.cacheSizeBytes;
    } else if (garbageCollector.kind === 'memoryEager') {
      spec.gcMode = 'eager';
    }
  }
  localCacheSpecs.set(token, spec);
  return token;
}

export function readLocalCacheSpec(token: object): NormalizedLocalCacheSpec | undefined {
  return localCacheSpecs.get(token);
}
