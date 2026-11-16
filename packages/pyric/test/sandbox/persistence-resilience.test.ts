/**
 * Persistence resilience tests:
 * - Quarantine vs legacy-cleanup handling of incompatible persisted format versions.
 * - Write-failure cache consistency in `recordBackendOverBlob`.
 */
import { describe, expect, it } from 'bun:test';
import {
  createMemoryBackend,
  initializeSandbox,
  type PersistenceBackend,
} from '../../src/sandbox/index.js';
import { recordBackendOverBlob } from '../../src/sandbox/persistence/backends.js';
import {
  bundleRecords,
  CHUNK_FORMAT_VERSION,
  pathToBucketId,
  serializeToBuckets,
} from '../../src/sandbox/persistence/chunk-format.js';

describe('incompatible persisted format handling', () => {
  it('quarantines future format versions to <key>:corrupt before flushing clean state', async () => {
    const backend = createMemoryBackend();
    const key = 'app-future';
    const futureMeta = {
      version: CHUNK_FORMAT_VERSION + 50,
      savedAt: 1_700_000_000_000,
      bucketCount: 1,
      checksum: 'future-format-checksum',
      services: {},
    };
    const futurePayload = { docs: { 'items/1': { label: 'future' } } };
    await backend.putRecords(
      key,
      new Map<string, unknown>([
        ['meta', futureMeta],
        ['col:items', futurePayload],
      ]),
    );

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
    try {
      const sandbox = initializeSandbox();
      await sandbox.enablePersistence({ key, injectedBackend: backend });
      sandbox.admin.setDocument('items/fresh', { label: 'current' });
      await sandbox.flush();
    } finally {
      console.warn = origWarn;
    }

    expect(warnings.some((line) => line.includes('quarantined'))).toBe(true);
    expect(await backend.getRecord(`${key}:corrupt`, 'meta')).toEqual(futureMeta);
    expect(await backend.getRecord(`${key}:corrupt`, 'col:items')).toEqual(futurePayload);
    expect(await backend.getRecord(key, 'col:items')).toBeNull();

    const liveMeta = (await backend.getRecord(key, 'meta')) as { version?: number } | null;
    expect(liveMeta?.version).toBe(CHUNK_FORMAT_VERSION);

    const restored = initializeSandbox();
    await restored.enablePersistence({ key, injectedBackend: backend });
    expect(restored.admin.getDocument('items/fresh')).toEqual({ label: 'current' });
  });

  it('quarantines records with missing or non-numeric metadata version', async () => {
    const backend = createMemoryBackend();
    const key = 'app-malformed-meta';
    await backend.putRecords(
      key,
      new Map<string, unknown>([
        ['meta', { version: 'corrupt-string', savedAt: 0 }],
        ['f0', { docs: { 'items/keep': { v: 1 } } }],
      ]),
    );

    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const sandbox = initializeSandbox();
      await sandbox.enablePersistence({ key, injectedBackend: backend });
      sandbox.admin.setDocument('items/new', { v: 2 });
      await sandbox.flush();
    } finally {
      console.warn = origWarn;
    }

    expect(await backend.getRecord(`${key}:corrupt`, 'f0')).toEqual({
      docs: { 'items/keep': { v: 1 } },
    });
    expect(await backend.getRecord(key, 'f0')).toBeNull();
  });

  it('preserves live incompatible records and pauses flushes when quarantine write fails until cleared', async () => {
    const inner = createMemoryBackend();
    const key = 'app-quarantine-fail';
    const collidingBucket = pathToBucketId('items/fresh');
    const futureMeta = {
      version: CHUNK_FORMAT_VERSION + 10,
      savedAt: 1_700_000_000_000,
      bucketCount: 1,
      checksum: 'future',
    };
    const futureColliding = { docs: { 'items/fresh': { label: 'future-colliding' } } };
    const futureBucket = { docs: { 'items/1': { v: 1 } } };
    await inner.putRecords(
      key,
      new Map<string, unknown>([
        ['meta', futureMeta],
        [collidingBucket, futureColliding],
        ['future:bucket', futureBucket],
      ]),
    );

    let failClear = true;
    const guarded: PersistenceBackend = {
      getRecord: (k, id) => inner.getRecord(k, id),
      listRecords: (k) => inner.listRecords(k),
      async putRecords(k, entries) {
        if (k.endsWith(':corrupt')) throw new Error('quota exceeded');
        await inner.putRecords(k, entries);
      },
      deleteRecords: (k, ids) => inner.deleteRecords(k, ids),
      async clear(k) {
        if (failClear && k === key) throw new Error('clear denied');
        await inner.clear(k);
      },
    };

    const origWarn = console.warn;
    console.warn = () => {};
    let sandbox: ReturnType<typeof initializeSandbox> | null = null;
    try {
      sandbox = initializeSandbox();
      await sandbox.enablePersistence({
        key,
        injectedBackend: guarded,
        flushIntervalMs: 10,
      });
      sandbox.admin.setDocument('items/fresh', { v: 2 });
      await sandbox.flush();
      await new Promise((resolve) => setTimeout(resolve, 40));

      // In-memory state stays usable while incompatible persisted records remain untouched.
      expect(sandbox.admin.getDocument('items/fresh')).toEqual({ v: 2 });
      expect(await inner.getRecord(key, 'meta')).toEqual(futureMeta);
      expect(await inner.getRecord(key, collidingBucket)).toEqual(futureColliding);
      expect(await inner.getRecord(key, 'future:bucket')).toEqual(futureBucket);
      expect(await inner.listRecords(`${key}:corrupt`)).toEqual([]);

      // A failed clearPersistence must keep flushing paused.
      let clearError: unknown;
      try {
        await sandbox.clearPersistence();
      } catch (err) {
        clearError = err;
      }
      expect(clearError).toBeDefined();
      await sandbox.flush();
      expect(await inner.getRecord(key, 'meta')).toEqual(futureMeta);
      expect(await inner.getRecord(key, collidingBucket)).toEqual(futureColliding);

      // Once clearPersistence succeeds, flushing resumes with clean current-version state.
      failClear = false;
      await sandbox.clearPersistence();
      await sandbox.flush();
    } finally {
      sandbox?.dispose();
      console.warn = origWarn;
    }

    const liveMeta = (await inner.getRecord(key, 'meta')) as { version?: number } | null;
    expect(liveMeta?.version).toBe(CHUNK_FORMAT_VERSION);
    expect(await inner.getRecord(key, 'future:bucket')).toBeNull();
    const restored = initializeSandbox();
    await restored.enablePersistence({ key, injectedBackend: inner });
    expect(restored.admin.getDocument('items/fresh')).toEqual({ v: 2 });
    restored.dispose();
  });

  it('keeps legacy format version cleanup intact without creating a quarantine key', async () => {
    const backend = createMemoryBackend();
    const key = 'app-legacy';
    const valid = serializeToBuckets({ 'items/legacy': { v: 1 } }, {}, 1_700_000_000_000);
    const records = new Map<string, unknown>(valid);
    const rawMeta = records.get('meta');
    if (rawMeta === undefined || typeof rawMeta !== 'object' || rawMeta === null) {
      throw new Error('Expected serialized meta record');
    }
    records.set('meta', {
      ...(rawMeta as Record<string, unknown>),
      version: CHUNK_FORMAT_VERSION - 1,
    });
    await backend.putRecords(key, records);

    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const sandbox = initializeSandbox();
      await sandbox.enablePersistence({ key, injectedBackend: backend });
      sandbox.admin.setDocument('items/next', { v: 2 });
      await sandbox.flush();
    } finally {
      console.warn = origWarn;
    }

    expect(await backend.listRecords(`${key}:corrupt`)).toEqual([]);
    const restored = initializeSandbox();
    await restored.enablePersistence({ key, injectedBackend: backend });
    expect(restored.admin.getDocument('items/legacy')).toBeNull();
    expect(restored.admin.getDocument('items/next')).toEqual({ v: 2 });
  });

  it('preserves future-version single-key blobs across writes and flushes until cleared', async () => {
    const collidingBucket = pathToBucketId('items/fresh');
    const futureMeta = { version: CHUNK_FORMAT_VERSION + 20, savedAt: 1_700_000_000_000 };
    const futureColliding = { docs: { 'items/fresh': { label: 'future-single' } } };
    const initialDurable = bundleRecords(
      new Map<string, unknown>([
        ['meta', futureMeta],
        [collidingBucket, futureColliding],
        ['future:bucket', { docs: { 'items/1': { v: 1 } } }],
      ]),
    );
    let durable: string | null = initialDurable;
    let writeCount = 0;
    const blobBackend = recordBackendOverBlob({
      read: async () => durable,
      write: async (next) => {
        writeCount += 1;
        durable = next;
      },
      clear: async () => {
        durable = null;
      },
    });

    const origWarn = console.warn;
    console.warn = () => {};
    let sandbox: ReturnType<typeof initializeSandbox> | null = null;
    try {
      sandbox = initializeSandbox();
      await sandbox.enablePersistence({
        key: 'single',
        injectedBackend: blobBackend,
        flushIntervalMs: 10,
      });
      sandbox.admin.setDocument('items/fresh', { current: true });
      await sandbox.flush();
      await new Promise((resolve) => setTimeout(resolve, 40));

      // Neither explicit flush nor debounced auto-flush may touch the future blob.
      expect(writeCount).toBe(0);
      expect(durable).toBe(initialDurable);
      expect(sandbox.admin.getDocument('items/fresh')).toEqual({ current: true });
      expect(await blobBackend.getRecord('single', 'meta')).toEqual(futureMeta);
      expect(await blobBackend.getRecord('single', collidingBucket)).toEqual(futureColliding);
      expect(await blobBackend.getRecord('single', 'future:bucket')).toEqual({
        docs: { 'items/1': { v: 1 } },
      });

      // Explicit clearPersistence unlocks clean v4 persistence.
      await sandbox.clearPersistence();
      await sandbox.flush();
      expect(writeCount).toBe(1);
    } finally {
      sandbox?.dispose();
      console.warn = origWarn;
    }

    const restored = initializeSandbox();
    const freshReader = recordBackendOverBlob({
      read: async () => durable,
      write: async (next) => {
        durable = next;
      },
      clear: async () => {
        durable = null;
      },
    });
    await restored.enablePersistence({ key: 'single', injectedBackend: freshReader });
    expect(restored.admin.getDocument('items/fresh')).toEqual({ current: true });
    restored.dispose();
  });
});

describe('recordBackendOverBlob write-failure consistency', () => {
  function makeFailableBlobBackend() {
    let durable: string | null = null;
    let failWrites = false;
    let failClears = false;

    const backend = recordBackendOverBlob({
      read: async () => durable,
      write: async (text) => {
        if (failWrites) throw new Error('disk full');
        durable = text;
      },
      clear: async () => {
        if (failClears) throw new Error('clear refused');
        durable = null;
      },
    });

    const readFresh = () =>
      recordBackendOverBlob({
        read: async () => durable,
        write: async () => {},
        clear: async () => {},
      });

    return {
      backend,
      readFresh,
      setFailWrites: (v: boolean) => {
        failWrites = v;
      },
      setFailClears: (v: boolean) => {
        failClears = v;
      },
    };
  }

  it('does not pollute cache or subsequent flushes when putRecords fails', async () => {
    const harness = makeFailableBlobBackend();
    await harness.backend.putRecords('k', new Map([['r1', { v: 1 }]]));

    harness.setFailWrites(true);
    let putError: unknown;
    try {
      await harness.backend.putRecords('k', new Map([['r2', { v: 2 }]]));
    } catch (err) {
      putError = err;
    }
    expect(putError).toBeDefined();
    expect(await harness.backend.getRecord('k', 'r2')).toBeNull();
    expect(await harness.backend.listRecords('k')).toEqual(['r1']);
    expect(await harness.readFresh().getRecord('k', 'r2')).toBeNull();

    // A later successful write must NOT leak the previously rejected r2 into durable storage.
    harness.setFailWrites(false);
    await harness.backend.putRecords('k', new Map([['r3', { v: 3 }]]));

    expect(await harness.backend.listRecords('k')).toEqual(['r1', 'r3']);
    expect(await harness.backend.getRecord('k', 'r2')).toBeNull();
    expect(await harness.readFresh().listRecords('k')).toEqual(['r1', 'r3']);
    expect(await harness.readFresh().getRecord('k', 'r2')).toBeNull();
  });

  it('preserves cached records when deleteRecords or clear fails', async () => {
    const harness = makeFailableBlobBackend();
    await harness.backend.putRecords(
      'k',
      new Map([
        ['r1', { v: 1 }],
        ['r2', { v: 2 }],
      ]),
    );

    harness.setFailWrites(true);
    let deleteError: unknown;
    try {
      await harness.backend.deleteRecords('k', ['r1']);
    } catch (err) {
      deleteError = err;
    }
    expect(deleteError).toBeDefined();
    expect(await harness.backend.getRecord('k', 'r1')).toEqual({ v: 1 });
    expect(await harness.backend.listRecords('k')).toEqual(['r1', 'r2']);

    harness.setFailClears(true);
    let clearError: unknown;
    try {
      await harness.backend.clear('k');
    } catch (err) {
      clearError = err;
    }
    expect(clearError).toBeDefined();
    expect(await harness.backend.listRecords('k')).toEqual(['r1', 'r2']);
    expect(await harness.readFresh().listRecords('k')).toEqual(['r1', 'r2']);

    harness.setFailClears(false);
    await harness.backend.clear('k');
    expect(await harness.backend.listRecords('k')).toEqual([]);
    expect(await harness.readFresh().listRecords('k')).toEqual([]);
  });

  it('isolates caller object mutations from cached records', async () => {
    const harness = makeFailableBlobBackend();
    const record = { nested: { count: 1 } };
    await harness.backend.putRecords('k', new Map([['r1', record]]));
    record.nested.count = 999;

    const loaded = (await harness.backend.getRecord('k', 'r1')) as { nested: { count: number } };
    expect(loaded.nested.count).toBe(1);
    loaded.nested.count = 42;
    expect(await harness.backend.getRecord('k', 'r1')).toEqual({ nested: { count: 1 } });
  });

  it('prevents a slow cold read from resurrecting cleared state or duplicating io.read', async () => {
    let durable: string | null = bundleRecords(new Map<string, unknown>([['r0', { v: 'old' }]]));
    let readCount = 0;
    let releaseRead: ((blob: string | null) => void) | null = null;
    const staleBlob = durable;

    const backend = recordBackendOverBlob({
      read: () => {
        readCount += 1;
        return new Promise<string | null>((resolve) => {
          releaseRead = resolve;
        });
      },
      write: async (text) => {
        durable = text;
      },
      clear: async () => {
        durable = null;
      },
    });

    const pendingGet = backend.getRecord('k', 'r0');
    const pendingList = backend.listRecords('k');
    expect(readCount).toBe(1);

    await backend.clear('k');
    expect(durable).toBeNull();

    // Release the slow pre-clear read after clear() has already committed.
    if (releaseRead === null) throw new Error('Expected pending io.read resolver');
    (releaseRead as (blob: string | null) => void)(staleBlob);

    expect(await pendingGet).toBeNull();
    expect(await pendingList).toEqual([]);
    expect(await backend.listRecords('k')).toEqual([]);

    await backend.putRecords('k', new Map([['r1', { v: 1 }]]));
    const fresh = recordBackendOverBlob({
      read: async () => durable,
      write: async () => {},
      clear: async () => {},
    });
    expect(await backend.listRecords('k')).toEqual(['r1']);
    expect(await fresh.listRecords('k')).toEqual(['r1']);
    expect(await fresh.getRecord('k', 'r0')).toBeNull();
  });

  it('retries cold load after a transient io.read error and ignores stale read failure after clear', async () => {
    let durable: string | null = bundleRecords(new Map<string, unknown>([['r1', { v: 1 }]]));
    let attempts = 0;
    const retryBackend = recordBackendOverBlob({
      read: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient read error');
        return durable;
      },
      write: async (text) => {
        durable = text;
      },
      clear: async () => {
        durable = null;
      },
    });

    let firstError: unknown;
    try {
      await retryBackend.getRecord('k', 'r1');
    } catch (err) {
      firstError = err;
    }
    expect(firstError).toBeDefined();
    expect(await retryBackend.getRecord('k', 'r1')).toEqual({ v: 1 });
    expect(attempts).toBe(2);

    // If a slow cold read rejects after clear() commits, cache stays cleanly empty.
    let rejectRead: ((err: Error) => void) | null = null;
    const raceBackend = recordBackendOverBlob({
      read: () =>
        new Promise<string | null>((_resolve, reject) => {
          rejectRead = reject;
        }),
      write: async (text) => {
        durable = text;
      },
      clear: async () => {
        durable = null;
      },
    });
    const pendingRead = raceBackend.getRecord('k', 'r1');
    await raceBackend.clear('k');
    if (rejectRead === null) throw new Error('Expected pending io.read rejector');
    (rejectRead as (err: Error) => void)(new Error('stale read failed'));
    expect(await pendingRead).toBeNull();
    await raceBackend.putRecords('k', new Map([['r2', { v: 2 }]]));
    expect(await raceBackend.getRecord('k', 'r2')).toEqual({ v: 2 });
  });

  it('snapshots queued putRecords and deleteRecords inputs before an in-flight write settles', async () => {
    let durable: string | null = null;
    let releaseFirstWrite: (() => void) | null = null;
    let writeCalls = 0;

    const backend = recordBackendOverBlob({
      read: async () => durable,
      write: async (text) => {
        writeCalls += 1;
        if (writeCalls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
        }
        durable = text;
      },
      clear: async () => {
        durable = null;
      },
    });

    const firstPut = backend.putRecords('k', new Map([['r1', { v: 1 }]]));
    // Let firstPut enter io.write so subsequent calls queue behind it.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const nestedPayload = { nested: { v: 1 } };
    const queuedMap = new Map<string, unknown>([['r2', nestedPayload]]);
    const queuedDeletes = ['r1'];

    const secondPut = backend.putRecords('k', queuedMap);
    const thirdDelete = backend.deleteRecords('k', queuedDeletes);

    // Mutate caller inputs synchronously while firstPut is still in flight.
    nestedPayload.nested.v = 999;
    queuedMap.set('r2', { nested: { v: 888 } });
    queuedMap.set('injected', { bad: true });
    queuedDeletes.push('r2');

    if (releaseFirstWrite === null) throw new Error('Expected first io.write gate');
    (releaseFirstWrite as () => void)();
    await Promise.all([firstPut, secondPut, thirdDelete]);

    const fresh = recordBackendOverBlob({
      read: async () => durable,
      write: async () => {},
      clear: async () => {},
    });
    expect(await backend.listRecords('k')).toEqual(['r2']);
    expect(await backend.getRecord('k', 'r1')).toBeNull();
    expect(await backend.getRecord('k', 'r2')).toEqual({ nested: { v: 1 } });
    expect(await backend.getRecord('k', 'injected')).toBeNull();
    expect(await fresh.listRecords('k')).toEqual(['r2']);
    expect(await fresh.getRecord('k', 'r2')).toEqual({ nested: { v: 1 } });
  });
});
