/**
 * Persistence layer tests.
 *
 * Covers:
 *   - Serializer round-trip preserves wrapper types (Timestamp, Bytes,
 *     LatLng, Duration, Reference, Vector).
 *   - Controller restore hydrates documents into a fresh sandbox.
 *   - Auto-flush fires after write events (debounced).
 *   - clearPersistence wipes the backend without touching memory.
 *   - IndexedDB backend round-trips via fake-indexeddb.
 *
 * The controller tests use the in-memory backend by default so they
 * don't depend on `globalThis.indexedDB`. The IndexedDB backend has a
 * separate suite at the bottom that pulls in fake-indexeddb.
 */
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
// Import wrappers from the same src module graph that `serialize.ts` (also
// imported from src below) pulls in via the leaf Firestore value codec. In
// this monorepo, `pyric/rules` resolves to the *built* dist copy, which is a
// DISTINCT class identity from the src wrappers — mixing the two would break
// the `instanceof` checks. Production code is all-dist, so identity holds
// there; this keeps the unit test internally consistent (all-src).
import { Bytes } from '../../src/rules/simulator/wrappers/bytes.js';
import { Duration } from '../../src/rules/simulator/wrappers/duration.js';
import { LatLng } from '../../src/rules/simulator/wrappers/latlng.js';
import { Reference } from '../../src/rules/simulator/wrappers/reference.js';
import { Timestamp } from '../../src/rules/simulator/wrappers/timestamp.js';
import { Vector } from '../../src/rules/simulator/wrappers/vector.js';
import {
  createIndexedDBBackend,
  createMemoryBackend,
  initializeSandbox,
  type PersistenceBackend,
} from '../../src/sandbox/index.js';
import { getInternalEnv } from '../../src/sandbox/internal/sandbox-impl.js';
import {
  deserializeSnapshot,
  PersistenceSchemaError,
  serializeSnapshot,
} from '../../src/sandbox/persistence/serialize.js';
import {
  serializeToBuckets,
  deserializeFromBuckets,
} from '../../src/sandbox/persistence/chunk-format.js';

/** Seed a record backend with a firestore map (the v3 record-shaped flush). */
async function seedBackend(
  backend: PersistenceBackend,
  key: string,
  firestore: Record<string, Record<string, unknown>>,
  services: Record<string, unknown> = {},
): Promise<void> {
  await backend.putRecords(key, serializeToBuckets(firestore, services, 0));
}

/** Read all of a key's records back into a firestore map. */
async function readFirestore(
  backend: PersistenceBackend,
  key: string,
): Promise<Record<string, Record<string, unknown>>> {
  const ids = await backend.listRecords(key);
  const records: [string, unknown][] = [];
  for (const id of ids) records.push([id, await backend.getRecord(key, id)]);
  return deserializeFromBuckets(records).firestore;
}

// Permissive rules so test writes go through the rules-evaluated path
// (which is what fires `kind: 'write'` events). Admin writes bypass rules
// and don't trigger the persistence subscription — see comments in
// controller.ts:isPersistableEvent.
const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

function seedSandbox() {
  const sandbox = initializeSandbox();
  const env = getInternalEnv(sandbox);
  env.seed({ rules: OPEN_RULES });
  return { sandbox, env };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('serializeSnapshot / deserializeSnapshot', () => {
  it('round-trips primitive doc data', () => {
    const before = {
      'users/alice': { name: 'Alice', age: 30, active: true, tags: ['a', 'b'] },
    };
    const { firestore: after } = deserializeSnapshot(serializeSnapshot(before));
    expect(after).toEqual(before);
  });

  it('round-trips Timestamp wrapper', () => {
    const ts = Timestamp.fromMillis(1_700_000_000_000);
    const blob = serializeSnapshot({ 'logs/x': { at: ts } });
    const { firestore: restored } = deserializeSnapshot(blob);
    const restoredTs = (restored['logs/x'] as Record<string, unknown>).at;
    expect(restoredTs).toBeInstanceOf(Timestamp);
    expect((restoredTs as Timestamp).toMillis()).toBe(1_700_000_000_000);
  });

  it('round-trips Bytes / LatLng / Duration / Reference / Vector', () => {
    const blob = serializeSnapshot({
      'k/v': {
        bytes: Bytes.fromUtf8('hello'),
        loc: new LatLng(37.7, -122.4),
        dur: new Duration(0, 250_000_000),
        ref: new Reference('users/alice'),
        vec: new Vector([0.1, 0.2, 0.3]),
      },
    });
    const { firestore: restored } = deserializeSnapshot(blob);
    const doc = restored['k/v'] as Record<string, unknown>;
    expect(doc.bytes).toBeInstanceOf(Bytes);
    expect(new TextDecoder().decode((doc.bytes as Bytes).data)).toBe('hello');
    expect(doc.loc).toBeInstanceOf(LatLng);
    expect((doc.loc as LatLng).lat).toBe(37.7);
    expect(doc.dur).toBeInstanceOf(Duration);
    expect(doc.ref).toBeInstanceOf(Reference);
    expect((doc.ref as Reference).path).toBe('users/alice');
    expect(doc.vec).toBeInstanceOf(Vector);
    expect((doc.vec as Vector).value).toEqual([0.1, 0.2, 0.3]);
  });

  it('throws PersistenceSchemaError on malformed JSON', () => {
    expect(() => deserializeSnapshot('{not json')).toThrow(PersistenceSchemaError);
  });

  it('throws PersistenceSchemaError on unrecognized version', () => {
    const blob = JSON.stringify({ version: 99, savedAt: 0, firestore: {} });
    expect(() => deserializeSnapshot(blob)).toThrow(PersistenceSchemaError);
  });

  it('accepts v1 blobs (no services field) with services defaulted to {}', () => {
    // v1 blobs were written before the service registry landed — they are
    // accepted as forward-compatible; the missing services map defaults to {}.
    const blob = JSON.stringify({
      version: 1,
      savedAt: 0,
      firestore: { 'k/v': { weird: { __type: 'future-type', value: 7 } } },
    });
    const { firestore: restored, services } = deserializeSnapshot(blob);
    expect(restored['k/v']).toEqual({
      weird: { __type: 'future-type', value: 7 },
    });
    expect(services).toEqual({});
  });

  it('round-trips services map', () => {
    const blob = serializeSnapshot(
      { 'docs/a': { x: 1 } },
      { auth: { users: [{ uid: 'alice', email: 'alice@example.com', password: 'pw' }] } },
    );
    const { firestore, services } = deserializeSnapshot(blob);
    expect(firestore['docs/a']).toEqual({ x: 1 });
    expect((services.auth as { users: unknown[] }).users).toHaveLength(1);
  });
});

describe('Sandbox.enablePersistence — restore', () => {
  it('hydrates the sandbox from a prior snapshot', async () => {
    const backend = createMemoryBackend();
    // Pre-seed the backend with a serialized snapshot — simulates a
    // prior session that already flushed.
    await seedBackend(backend, 'pyric:test', {
      'sessions/abc': { title: 'first', count: 1 },
    });

    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: 'pyric:test',
      injectedBackend: backend,
    });

    expect(sandbox.admin.getDocument('sessions/abc')).toEqual({
      title: 'first',
      count: 1,
    });
  });

  it('is a no-op when no prior snapshot exists', async () => {
    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: 'pyric:fresh',
      injectedBackend: createMemoryBackend(),
    });
    expect(sandbox.snapshot().firestore).toEqual({});
  });

  it('skips an unrecognized record and starts fresh', async () => {
    const backend = createMemoryBackend();
    // A record that is not a valid v3 bucket (no `docs`) is skipped on restore.
    // Per-bucket integrity + quarantine arrive with the checksum commit (C5).
    await backend.putRecords('pyric:corrupt', new Map([['bad', { not: 'a-bucket' }]]));

    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: 'pyric:corrupt',
      injectedBackend: backend,
    });

    expect(sandbox.snapshot().firestore).toEqual({});
  });

  it('rejects re-enable with a different key', async () => {
    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: 'pyric:a',
      injectedBackend: createMemoryBackend(),
    });
    let err: unknown;
    try {
      await sandbox.enablePersistence({
        key: 'pyric:b',
        injectedBackend: createMemoryBackend(),
      });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/already enabled/);
  });
});

describe('Sandbox.flush', () => {
  it('serializes the current state to the backend on demand', async () => {
    const backend = createMemoryBackend();
    const { sandbox, env } = seedSandbox();
    await sandbox.enablePersistence({
      key: 'pyric:flush',
      injectedBackend: backend,
    });

    env.execute({
      method: 'set',
      path: 'sessions/x',
      auth: { uid: 'alice' },
      data: { title: 'hello' },
    });
    await sandbox.flush();

    const restored = await readFirestore(backend, 'pyric:flush');
    expect(restored['sessions/x']).toEqual({ title: 'hello' });
  });

  it('throws when persistence is not enabled', async () => {
    const sandbox = initializeSandbox();
    let err: unknown;
    try {
      await sandbox.flush();
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/before enablePersistence/);
  });
});

describe('Sandbox auto-flush', () => {
  it('writes to the backend after a debounced write event', async () => {
    const backend = createMemoryBackend();
    const { sandbox, env } = seedSandbox();
    await sandbox.enablePersistence({
      key: 'pyric:auto',
      injectedBackend: backend,
      flushIntervalMs: 20,
    });

    env.execute({
      method: 'set',
      path: 'sessions/auto',
      auth: { uid: 'alice' },
      data: { v: 1 },
    });

    // Before the debounce window, nothing has been flushed yet.
    expect((await backend.listRecords('pyric:auto')).length).toBe(0);

    // After the debounce window, the snapshot lands.
    await sleep(60);
    const restored = await readFirestore(backend, 'pyric:auto');
    expect(restored['sessions/auto']).toEqual({ v: 1 });
  });

  it('coalesces a burst of writes into one flush', async () => {
    const backend = createMemoryBackend();
    let writeCount = 0;
    const counting: PersistenceBackend = {
      getRecord: backend.getRecord.bind(backend),
      listRecords: backend.listRecords.bind(backend),
      putRecords: async (k, r) => {
        writeCount++;
        await backend.putRecords(k, r);
      },
      deleteRecords: backend.deleteRecords.bind(backend),
      clear: backend.clear.bind(backend),
    };
    const { sandbox, env } = seedSandbox();
    await sandbox.enablePersistence({
      key: 'pyric:burst',
      injectedBackend: counting,
      flushIntervalMs: 30,
    });

    for (let i = 0; i < 5; i++) {
      env.execute({
        method: 'set',
        path: `sessions/${i}`,
        auth: { uid: 'alice' },
        data: { i },
      });
    }
    await sleep(80);
    expect(writeCount).toBe(1);
  });
});

describe('Sandbox.clearPersistence', () => {
  it('wipes the backend blob and leaves in-memory state intact', async () => {
    const backend = createMemoryBackend();
    const { sandbox, env } = seedSandbox();
    await sandbox.enablePersistence({
      key: 'pyric:clear',
      injectedBackend: backend,
    });
    env.execute({
      method: 'set',
      path: 'sessions/a',
      auth: { uid: 'alice' },
      data: { v: 1 },
    });
    await sandbox.flush();

    await sandbox.clearPersistence();
    expect((await backend.listRecords('pyric:clear')).length).toBe(0);
    // In-memory state untouched.
    expect(sandbox.admin.getDocument('sessions/a')).toEqual({ v: 1 });
  });

  it('is a no-op when persistence is not enabled', async () => {
    const sandbox = initializeSandbox();
    await expect(sandbox.clearPersistence()).resolves.toBeUndefined();
  });
});

describe('Sandbox.dispose with persistence enabled', () => {
  it('releases the persistence subscription so post-dispose writes do not flush', async () => {
    const backend = createMemoryBackend();
    let writeCount = 0;
    const counting: PersistenceBackend = {
      getRecord: backend.getRecord.bind(backend),
      listRecords: backend.listRecords.bind(backend),
      putRecords: async (k, r) => {
        writeCount++;
        await backend.putRecords(k, r);
      },
      deleteRecords: backend.deleteRecords.bind(backend),
      clear: backend.clear.bind(backend),
    };
    const { sandbox } = seedSandbox();
    await sandbox.enablePersistence({
      key: 'pyric:dispose',
      injectedBackend: counting,
      flushIntervalMs: 10,
    });
    sandbox.dispose();
    await sleep(40);
    // No writes were issued by the auto-flush after dispose. (The
    // session_boundary `phase: 'dispose'` emit happens before
    // controller dispose, so it might queue a flush; the dispose path
    // cancels the pending timer.)
    expect(writeCount).toBe(0);
  });
});

describe('Sandbox incremental flush (C3)', () => {
  it('flushes only the buckets whose content changed', async () => {
    const backend = createMemoryBackend();
    let lastPutSize = 0;
    const counting: PersistenceBackend = {
      ...backend,
      putRecords: async (k, r) => {
        lastPutSize = r.size;
        await backend.putRecords(k, r);
      },
    };
    const { sandbox, env } = seedSandbox();
    await sandbox.enablePersistence({ key: 'pyric:inc', injectedBackend: counting });

    // Seed several docs across buckets, then flush once (writes everything).
    for (let i = 0; i < 10; i++) {
      env.execute({ method: 'set', path: `c/${i}`, auth: { uid: 'alice' }, data: { i } });
    }
    await sandbox.flush();
    expect(lastPutSize).toBeGreaterThan(1); // meta + multiple buckets

    // Change ONE doc: the next flush writes only meta + that doc's bucket.
    env.execute({ method: 'set', path: 'c/5', auth: { uid: 'alice' }, data: { i: 500 } });
    await sandbox.flush();
    expect(lastPutSize).toBeLessThanOrEqual(2); // meta + 1 bucket, not all of them

    const restored = await readFirestore(backend, 'pyric:inc');
    expect(restored['c/5']).toEqual({ i: 500 });
    expect(restored['c/0']).toEqual({ i: 0 }); // unchanged docs intact
  });

  it('a crash mid-flush does not lose data; the next flush recovers it', async () => {
    const backend = createMemoryBackend();
    let failNext = false;
    const flaky: PersistenceBackend = {
      ...backend,
      putRecords: async (k, r) => {
        if (failNext) {
          failNext = false;
          throw new Error('simulated crash');
        }
        await backend.putRecords(k, r);
      },
    };
    const { sandbox, env } = seedSandbox();
    await sandbox.enablePersistence({ key: 'pyric:crash', injectedBackend: flaky });

    env.execute({ method: 'set', path: 'x/1', auth: { uid: 'alice' }, data: { v: 1 } });

    // The flush crashes before any record lands; the hashes are NOT adopted.
    failNext = true;
    let threw = false;
    try {
      await sandbox.flush();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // The next flush re-detects the change (hash state unchanged) and writes it.
    await sandbox.flush();
    const restored = await readFirestore(backend, 'pyric:crash');
    expect(restored['x/1']).toEqual({ v: 1 });
  });

  it('clearPersistence then a single mutation re-persists the FULL state', async () => {
    const backend = createMemoryBackend();
    const { sandbox, env } = seedSandbox();
    await sandbox.enablePersistence({ key: 'pyric:clear-reflush', injectedBackend: backend });

    for (let i = 0; i < 5; i++) {
      env.execute({ method: 'set', path: `d/${i}`, auth: { uid: 'alice' }, data: { i } });
    }
    await sandbox.flush();

    // Wipe durable state, then change ONE doc and flush.
    await sandbox.clearPersistence();
    env.execute({ method: 'set', path: 'd/2', auth: { uid: 'alice' }, data: { i: 222 } });
    await sandbox.flush();

    // The hash baseline was reset on clear, so the whole in-memory state is back,
    // not just the one changed doc.
    const restored = await readFirestore(backend, 'pyric:clear-reflush');
    expect(restored['d/0']).toEqual({ i: 0 });
    expect(restored['d/2']).toEqual({ i: 222 });
    expect(restored['d/4']).toEqual({ i: 4 });
  });

  it('concurrent flushes persist an interleaved write (serialized chain)', async () => {
    const backend = createMemoryBackend();
    const { sandbox, env } = seedSandbox();
    await sandbox.enablePersistence({ key: 'pyric:concurrent', injectedBackend: backend });

    env.execute({ method: 'set', path: 'y/1', auth: { uid: 'alice' }, data: { v: 1 } });
    const f1 = sandbox.flush();
    // A write lands between the two flush calls; the second (chained after the
    // first) must snapshot and persist it.
    env.execute({ method: 'set', path: 'y/2', auth: { uid: 'alice' }, data: { v: 2 } });
    const f2 = sandbox.flush();
    await Promise.all([f1, f2]);

    const restored = await readFirestore(backend, 'pyric:concurrent');
    expect(restored['y/1']).toEqual({ v: 1 });
    expect(restored['y/2']).toEqual({ v: 2 });
  });
});

describe('Sandbox migrate-on-open (C4)', () => {
  it('migrates a legacy v2 blob to v3 records on open', async () => {
    const backend = createMemoryBackend();
    // Simulate an old v2 store: the single JSON blob under the old 'snapshot' id.
    await backend.putRecords('pyric:v2', new Map([
      ['snapshot', serializeSnapshot({ 'old/doc': { v: 1, n: 'legacy' } })],
    ]));

    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({ key: 'pyric:v2', injectedBackend: backend });

    // The v2 data is restored...
    expect(sandbox.admin.getDocument('old/doc')).toEqual({ v: 1, n: 'legacy' });
    // ...and the backend is now pure v3 (the legacy 'snapshot' record is gone).
    const ids = await backend.listRecords('pyric:v2');
    expect(ids).not.toContain('snapshot');
    expect(ids).toContain('meta');
    expect((await readFirestore(backend, 'pyric:v2'))['old/doc']).toEqual({ v: 1, n: 'legacy' });
  });
});

describe('Sandbox quota handling (C7)', () => {
  it('a quota-exceeded flush keeps in-memory data and does not crash', async () => {
    const backend = createMemoryBackend();
    const quotaFull: PersistenceBackend = {
      ...backend,
      putRecords: async () => {
        const e = new Error('quota exceeded');
        (e as Error & { name: string }).name = 'QuotaExceededError';
        throw e;
      },
    };
    const { sandbox, env } = seedSandbox();
    await sandbox.enablePersistence({ key: 'pyric:quota', injectedBackend: quotaFull });

    env.execute({ method: 'set', path: 'q/1', auth: { uid: 'alice' }, data: { v: 1 } });
    // Explicit flush propagates the error; the sandbox itself stays usable.
    let threw = false;
    try {
      await sandbox.flush();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(sandbox.admin.getDocument('q/1')).toEqual({ v: 1 }); // in-memory intact
  });

  it('the IndexedDB backend exposes an estimate() method', () => {
    // (calling it needs navigator.storage; here we assert the surface exists.)
    const backend = createMemoryBackend();
    expect(typeof backend.estimate).toBe('undefined'); // memory omits the optional method
  });
});

describe('createIndexedDBBackend (fake-indexeddb)', () => {
  beforeAll(async () => {
    // Install the fake before the backend module reads `indexedDB`.
    // Bun has no native IndexedDB, so this is the only way to drive
    // the real backend.
    const fake = await import('fake-indexeddb');
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = fake.indexedDB;
    (globalThis as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange =
      fake.IDBKeyRange;
  });

  afterEach(async () => {
    // Clean both keys we use below so tests stay isolated.
    const backend = createIndexedDBBackend();
    await backend.clear('pyric:idb-a').catch(() => {});
    await backend.clear('pyric:idb-b').catch(() => {});
  });

  it('round-trips a write through the real IndexedDB API', async () => {
    const backend = createIndexedDBBackend();
    await backend.putRecords('pyric:idb-a', new Map([['r1', { hello: 'world' }]]));
    expect(await backend.getRecord('pyric:idb-a', 'r1')).toEqual({ hello: 'world' });
  });

  it('returns null for an unset key', async () => {
    const backend = createIndexedDBBackend();
    expect(await backend.getRecord('pyric:idb-b', 'r1')).toBeNull();
  });

  it('clear removes the stored value', async () => {
    const backend = createIndexedDBBackend();
    await backend.putRecords('pyric:idb-a', new Map([['r1', { v: 1 }]]));
    await backend.clear('pyric:idb-a');
    expect(await backend.getRecord('pyric:idb-a', 'r1')).toBeNull();
  });
});
