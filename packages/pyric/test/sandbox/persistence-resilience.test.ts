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

  it('does not delete live incompatible records when quarantine write fails', async () => {
    const inner = createMemoryBackend();
    const key = 'app-quarantine-fail';
    const futureMeta = {
      version: CHUNK_FORMAT_VERSION + 10,
      savedAt: 1_700_000_000_000,
      bucketCount: 1,
      checksum: 'future',
    };
    const futureBucket = { docs: { 'items/1': { v: 1 } } };
    await inner.putRecords(
      key,
      new Map<string, unknown>([
        ['meta', futureMeta],
        ['future:bucket', futureBucket],
      ]),
    );

    const guarded: PersistenceBackend = {
      getRecord: (k, id) => inner.getRecord(k, id),
      listRecords: (k) => inner.listRecords(k),
      async putRecords(k, entries) {
        if (k.endsWith(':corrupt')) throw new Error('quota exceeded');
        await inner.putRecords(k, entries);
      },
      deleteRecords: (k, ids) => inner.deleteRecords(k, ids),
      clear: (k) => inner.clear(k),
    };

    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const sandbox = initializeSandbox();
      await sandbox.enablePersistence({ key, injectedBackend: guarded });
      sandbox.admin.setDocument('items/fresh', { v: 2 });
      await sandbox.flush();
    } finally {
      console.warn = origWarn;
    }

    // Original future bucket was not deleted because quarantine failed.
    expect(await inner.getRecord(key, 'future:bucket')).toEqual(futureBucket);
    expect(await inner.listRecords(`${key}:corrupt`)).toEqual([]);
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

  it('does not collide single-key blob backends when quarantining a future format version', async () => {
    let durable: string | null = bundleRecords(
      new Map<string, unknown>([
        ['meta', { version: CHUNK_FORMAT_VERSION + 20, savedAt: 1_700_000_000_000 }],
        ['future:bucket', { docs: { 'items/1': { v: 1 } } }],
      ]),
    );
    const blobBackend = recordBackendOverBlob({
      read: async () => durable,
      write: async (next) => {
        durable = next;
      },
      clear: async () => {
        durable = null;
      },
    });

    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const sandbox = initializeSandbox();
      await sandbox.enablePersistence({ key: 'single', injectedBackend: blobBackend });
      // No writes yet: startup alone must leave the future blob intact.
      expect(durable).toContain('"future:bucket"');
      expect(await blobBackend.getRecord('single', 'future:bucket')).toEqual({
        docs: { 'items/1': { v: 1 } },
      });
    } finally {
      console.warn = origWarn;
    }
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
});
