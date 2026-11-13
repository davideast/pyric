/**
 * RTDB persistence round-trip tests.
 *
 * Verifies that the RTDB tree registers with the persistable-service
 * registry and rides the serialized blob exactly like the auth user DB —
 * giving RTDB the same durability contract as Firestore/auth (worker death
 * / browser restart restores the whole tree instead of losing it).
 *
 * Covers (modeled on `auth-persistence.test.ts`):
 *   - Basic round-trip: write, flush, fresh sandbox restore → tree present.
 *   - Late registration: `enablePersistence` BEFORE `getDatabase`.
 *   - Early registration: `getDatabase` BEFORE `enablePersistence`.
 *   - Snapshot shape: `sandbox.snapshot().services.rtdb` holds the versioned
 *     value/priority envelope while owner snapshots remain raw RTDB data.
 *   - RTDB writes trigger a debounced flush without a Firestore write
 *     (RTDB writes emit `service_mutation` events, which the controller's
 *     `isPersistableEvent` does NOT cover — the service `subscribe` hook is
 *     the sole flush trigger).
 *   - Restore fires listeners so a live view converges (notification
 *     design), exercised directly against `RtdbBackend`.
 *
 * Pattern: injected in-memory backend for determinism; explicit
 * `sandbox.flush()` except where the debounce is under test.
 */
import { describe, expect, it } from 'bun:test';
import {
  CHUNK_FORMAT_VERSION,
  META_RECORD_ID,
} from '../../src/sandbox/persistence/chunk-format.js';
import {
  createMemoryBackend,
  deserializeFromBuckets,
  initializeSandbox,
  type PersistenceBackend,
} from '../../src/sandbox/index.js';
import {
  getDatabase as baseGetDatabase,
  ref,
  set,
  setWithPriority,
  get,
  remove,
  sandbox as rtdbSandbox,
} from '../../src/database/index.js';
import { RtdbBackend } from '../../src/database/sandbox/backend.js';

function getDatabase(target: Parameters<typeof baseGetDatabase>[0]) {
  const db = baseGetDatabase(target);
  rtdbSandbox.setDefaultPolicy(db, 'allow');
  return db;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Snapshot shape ────────────────────────────────────────────────────

describe('SandboxSnapshot.services — rtdb', () => {
  it('includes the rtdb tree after getDatabase + a write', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    await set(ref(db, '/rooms/general'), { name: 'General' });

    const snap = sandbox.snapshot();
    expect(snap.services).toHaveProperty('rtdb');
    expect(snap.services.rtdb).toEqual({
      '.pyricRtdbPersistence': 1,
      data: { rooms: { general: { name: 'General' } } },
      priorities: {},
    });
  });

  it('registers rtdb even before any write (empty tree snapshot)', () => {
    const sandbox = initializeSandbox();
    getDatabase(sandbox);
    const snap = sandbox.snapshot();
    expect(snap.services).toHaveProperty('rtdb');
    expect(snap.services.rtdb).toEqual({
      '.pyricRtdbPersistence': 1,
      data: {},
      priorities: {},
    });
  });
});

// ─── Basic round-trip ─────────────────────────────────────────────────

describe('rtdb persistence — basic round-trip', () => {
  it('restores the tree after flush → fresh sandbox restore', async () => {
    const backend = createMemoryBackend();

    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({ key: 'rtdb:rt', injectedBackend: backend });
    const db1 = getDatabase(sandbox1);
    await set(ref(db1, '/rooms/general'), { name: 'General', members: 3 });
    await set(ref(db1, '/rooms/random'), { name: 'Random' });
    await sandbox1.flush();

    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({ key: 'rtdb:rt', injectedBackend: backend });
    const db2 = getDatabase(sandbox2);

    const snap = await get(ref(db2, '/rooms'));
    expect(snap.val()).toEqual({
      general: { name: 'General', members: 3 },
      random: { name: 'Random' },
    });
  });

  it('a removed subtree stays removed after restore', async () => {
    const backend = createMemoryBackend();

    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({ key: 'rtdb:rm', injectedBackend: backend });
    const db1 = getDatabase(sandbox1);
    await set(ref(db1, '/rooms/doomed'), { x: 1 });
    await remove(ref(db1, '/rooms/doomed'));
    await sandbox1.flush();

    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({ key: 'rtdb:rm', injectedBackend: backend });
    const db2 = getDatabase(sandbox2);

    const snap = await get(ref(db2, '/rooms/doomed'));
    expect(snap.exists()).toBe(false);
  });

  it('restores priority metadata after flush into a fresh sandbox', async () => {
    const backend = createMemoryBackend();
    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({ key: 'rtdb:priority', injectedBackend: backend });
    const db1 = getDatabase(sandbox1);
    await setWithPriority(ref(db1, '/items/a'), { label: 'A' }, 7);
    await sandbox1.flush();

    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({ key: 'rtdb:priority', injectedBackend: backend });
    const restored = await get(ref(getDatabase(sandbox2), '/items/a'));
    expect(restored.priority).toBe(7);
    expect(restored.exportVal()).toEqual({ label: 'A', '.priority': 7 });
  });
});

// ─── Late registration ─────────────────────────────────────────────────

describe('rtdb persistence — late registration (enablePersistence before getDatabase)', () => {
  it('writes made after enablePersistence are flushed and restored', async () => {
    const backend = createMemoryBackend();

    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({ key: 'rtdb:late', injectedBackend: backend });
    // getDatabase registers 'rtdb' AFTER the controller has already attached.
    const db1 = getDatabase(sandbox1);
    await set(ref(db1, '/counters/global'), { clicks: 7 });
    await sandbox1.flush();

    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({ key: 'rtdb:late', injectedBackend: backend });
    const db2 = getDatabase(sandbox2);

    const snap = await get(ref(db2, '/counters/global'));
    expect(snap.val()).toEqual({ clicks: 7 });
  });

  it('restored tree is queryable on the FIRST read after restore (eager-registration path)', async () => {
    const backend = createMemoryBackend();

    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({ key: 'rtdb:first', injectedBackend: backend });
    await set(ref(getDatabase(sandbox1), '/rooms/general'), { name: 'General' });
    await sandbox1.flush();

    // Session 2: register rtdb eagerly (as the worker boot does), then the
    // controller's late-registration hook applies the restore synchronously.
    // The very first read sees the restored tree — no prior op needed.
    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({ key: 'rtdb:first', injectedBackend: backend });
    const db2 = getDatabase(sandbox2); // eager registration → restore applied
    const snap = await get(ref(db2, '/rooms/general'));
    expect(snap.val()).toEqual({ name: 'General' });
  });
});

// ─── Early registration ─────────────────────────────────────────────────

describe('rtdb persistence — early registration (getDatabase before enablePersistence)', () => {
  it('writes made before enablePersistence are flushed on the next flush', async () => {
    const backend = createMemoryBackend();
    const sandbox = initializeSandbox();

    const db = getDatabase(sandbox);
    await set(ref(db, '/rooms/general'), { name: 'General' });

    await sandbox.enablePersistence({ key: 'rtdb:early', injectedBackend: backend });
    await sandbox.flush();

    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({ key: 'rtdb:early', injectedBackend: backend });
    const db2 = getDatabase(sandbox2);

    const snap = await get(ref(db2, '/rooms/general'));
    expect(snap.val()).toEqual({ name: 'General' });
  });
});

// ─── Auto-flush on RTDB write without a Firestore write ────────────────

describe('rtdb persistence — auto-flush on write', () => {
  it('an RTDB write triggers a debounced flush even with no Firestore write', async () => {
    const backend = createMemoryBackend();
    let writeCount = 0;
    const counting: PersistenceBackend = {
      getRecord: backend.getRecord.bind(backend),
      listRecords: backend.listRecords.bind(backend),
      putRecords: async (k, r) => { writeCount++; await backend.putRecords(k, r); },
      deleteRecords: backend.deleteRecords.bind(backend),
      clear: backend.clear.bind(backend),
    };

    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: 'rtdb:autof',
      injectedBackend: counting,
      flushIntervalMs: 20,
    });
    const db = getDatabase(sandbox);

    // A write schedules the debounced flush via the service `subscribe`
    // hook. No Firestore write happens; RTDB's `service_mutation` event is
    // NOT a persistable sandbox event, so this is the sole trigger.
    await set(ref(db, '/rooms/general'), { name: 'General' });

    // Before debounce window: flush hasn't fired yet.
    expect(writeCount).toBe(0);

    await sleep(60);
    expect(writeCount).toBeGreaterThan(0);

    const records: [string, unknown][] = [];
    for (const id of await backend.listRecords('rtdb:autof')) {
      records.push([id, await backend.getRecord('rtdb:autof', id)]);
    }
    const { services } = deserializeFromBuckets(records);
    expect((services as { rtdb?: unknown }).rtdb).toEqual({
      '.pyricRtdbPersistence': 1,
      data: { rooms: { general: { name: 'General' } } },
      priorities: {},
    });
  });
});

// ─── Restore fires listeners (notification design) ─────────────────────

describe('rtdb persistence — restore notifies live listeners', () => {
  it('does not mistake valid legacy user keys for the persistence envelope', () => {
    const backend = new RtdbBackend();
    const legacy = {
      __pyricRtdbPersistence: 1,
      data: { belongs: 'to the user' },
      priorities: { also: 'user data' },
    };
    backend.restoreTree(legacy);
    expect(backend.exportTree()).toEqual(legacy);
  });

  it('restoreTree fires an attached onValue listener with the restored value', () => {
    const backend = new RtdbBackend();
    backend.setDefaultPolicy('allow');
    const fires: Array<{ val: unknown; exists: boolean }> = [];
    // Attach a plain-ref value listener (admin auth) at /rooms/general.
    backend.onValue({ mode: 'admin' } as never, '/rooms/general', (snap) => {
      fires.push({ val: snap.val, exists: snap.exists });
    });
    // Initial fire is the empty/absent path.
    expect(fires).toHaveLength(1);
    expect(fires[0]).toEqual({ val: null, exists: false });

    // Restore a snapshot that populates the listener's path.
    backend.restoreTree({ rooms: { general: { name: 'General' } } });

    // The listener must have re-fired with the restored value so a live UI
    // converges rather than showing stale/empty data.
    expect(fires).toHaveLength(2);
    expect(fires[1]).toEqual({ val: { name: 'General' }, exists: true });
  });
});

// ─── snapshotState helper agrees with restored tree ────────────────────

describe('rtdb persistence — snapshotState after restore', () => {
  it('rtdbSandbox.snapshotState reflects the restored tree', async () => {
    const backend = createMemoryBackend();
    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({ key: 'rtdb:snapstate', injectedBackend: backend });
    await set(ref(getDatabase(sandbox1), '/a/b'), 1);
    await sandbox1.flush();

    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({ key: 'rtdb:snapstate', injectedBackend: backend });
    const db2 = getDatabase(sandbox2);
    expect(rtdbSandbox.snapshotState(db2)).toEqual({ a: { b: 1 } });
  });
});

// ─── Incremental dirty-record RTDB persistence (Slice C) ───────────────

describe('rtdb persistence — incremental dirty-tracked records', () => {
  it('rewrites only the dirtied RTDB bucket record on a small write and round-trips instances, rules, and priorities', async () => {
    const storage = createMemoryBackend();
    const flushes: Array<{ changed: string[]; removed: string[] }> = [];
    const backend: PersistenceBackend = {
      ...storage,
      async applyChanges(key, changed, removed) {
        flushes.push({ changed: [...changed.keys()], removed: [...removed] });
        await storage.putRecords(key, changed);
        await storage.deleteRecords(key, removed);
      },
    };

    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({ key: 'rtdb:dirty', injectedBackend: backend, flushIntervalMs: 60_000 });
    const defaultDb = baseGetDatabase(sandbox1);
    const secondaryDb = baseGetDatabase(sandbox1, 'https://secondary-inst.firebaseio.com');

    const defaultRules = {
      rules: {
        workspaces: { '.read': true, '.write': true },
        locked: { '.read': false, '.write': false },
      },
    };
    const secondaryRules = {
      rules: {
        counters: { '.read': true, '.write': true },
        locked: { '.read': false, '.write': false },
      },
    };
    rtdbSandbox.setRules(defaultDb, defaultRules);
    rtdbSandbox.setRules(secondaryDb, secondaryRules);

    for (let i = 0; i < 24; i++) {
      await set(ref(defaultDb, `/workspaces/w-${i}/records/r-0`), { index: i, payload: `seed-${i}` });
    }
    await setWithPriority(ref(defaultDb, '/workspaces/w-0/cursors/u-1'), { x: 1, y: 2 }, 42);
    await setWithPriority(ref(secondaryDb, '/counters/c-1'), { hits: 10 }, 'p-sec');
    await sandbox1.flush();

    const metaAfterSeed = (await storage.getRecord('rtdb:dirty', META_RECORD_ID)) as { services: Record<string, unknown> };
    expect(metaAfterSeed.services).not.toHaveProperty('rtdb');

    // Small write to one leaf on the default instance: only its single RTDB bucket record is written.
    flushes.length = 0;
    await set(ref(defaultDb, '/workspaces/w-0/cursors/u-1'), { x: 9, y: 8 });
    await sandbox1.flush();

    expect(flushes).toHaveLength(1);
    const rtdbChanged = flushes[0]!.changed.filter((id) => id.startsWith('rtdb:'));
    expect(rtdbChanged).toHaveLength(1);
    expect(rtdbChanged[0]).toMatch(/^rtdb:b:\(default\):[0-9a-f]{2}$/);
    expect(flushes[0]!.removed).toEqual([]);

    // Priority survives on another node and secondary instance stays untouched; cold reload reproduces everything.
    await setWithPriority(ref(defaultDb, '/workspaces/w-0/cursors/u-2'), { x: 3, y: 4 }, 77);
    await sandbox1.flush();

    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({ key: 'rtdb:dirty', injectedBackend: storage, flushIntervalMs: 60_000 });
    // Note: baseGetDatabase starts in default-deny mode, so allowed reads below
    // succeed ONLY because each instance's deployed rules survived persistence.
    const restoredDefault = baseGetDatabase(sandbox2);
    const restoredSecondary = baseGetDatabase(sandbox2, 'https://secondary-inst.firebaseio.com');

    expect((await get(ref(restoredDefault, '/workspaces/w-0/cursors/u-1'))).val()).toEqual({ x: 9, y: 8 });
    const cursor2Snap = await get(ref(restoredDefault, '/workspaces/w-0/cursors/u-2'));
    expect(cursor2Snap.val()).toEqual({ x: 3, y: 4 });
    expect(cursor2Snap.priority).toBe(77);
    expect((await get(ref(restoredDefault, '/workspaces/w-23/records/r-0'))).val()).toEqual({ index: 23, payload: 'seed-23' });
    await expect(get(ref(restoredDefault, '/locked'))).rejects.toThrow(/permission/i);

    const secSnap = await get(ref(restoredSecondary, '/counters/c-1'));
    expect(secSnap.val()).toEqual({ hits: 10 });
    expect(secSnap.priority).toBe('p-sec');
    await expect(get(ref(restoredSecondary, '/locked'))).rejects.toThrow(/permission/i);

    // Resetting clears persisted RTDB bucket records so a subsequent cold reload starts empty.
    await sandbox2.resetAll();
    await sandbox2.flush();

    const sandbox3 = initializeSandbox();
    await sandbox3.enablePersistence({ key: 'rtdb:dirty', injectedBackend: storage, flushIntervalMs: 60_000 });
    const emptyDefault = getDatabase(sandbox3);
    expect((await get(ref(emptyDefault, '/workspaces'))).exists()).toBe(false);

    sandbox1.dispose();
    sandbox2.dispose();
    sandbox3.dispose();
  });

  it('retains dirty RTDB buckets and removals across a failed flush and promotes shallow primitives cleanly', async () => {
    const storage = createMemoryBackend();
    let failNext = false;
    const backend: PersistenceBackend = {
      ...storage,
      async applyChanges(key, changed, removed) {
        if (failNext) throw new Error('Transient disk error');
        await storage.putRecords(key, changed);
        await storage.deleteRecords(key, removed);
      },
    };

    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({ key: 'rtdb:retry-promote', injectedBackend: backend, flushIntervalMs: 60_000 });
    const db1 = getDatabase(sandbox1);

    await setWithPriority(ref(db1, '/shallow/leaf'), 'primitive-seed', 11);
    await set(ref(db1, '/ephemeral/a/b/c'), { doomed: true });
    await sandbox1.flush();

    // Promote shallow primitive `/shallow/leaf` via a deep write and delete `/ephemeral/a/b/c`,
    // then fail the commit and verify a subsequent retry persists both mutations.
    await set(ref(db1, '/shallow/leaf/deep/node/item'), { ok: true });
    await remove(ref(db1, '/ephemeral/a/b/c'));
    failNext = true;
    await expect(sandbox1.flush()).rejects.toThrow('Transient disk error');

    failNext = false;
    await sandbox1.flush();

    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({ key: 'rtdb:retry-promote', injectedBackend: storage, flushIntervalMs: 60_000 });
    const db2 = getDatabase(sandbox2);

    const promoted = await get(ref(db2, '/shallow/leaf'));
    expect(promoted.val()).toEqual({ deep: { node: { item: { ok: true } } } });
    expect(promoted.priority).toBeNull();
    expect((await get(ref(db2, '/ephemeral/a/b/c'))).exists()).toBe(false);

    sandbox1.dispose();
    sandbox2.dispose();
  });

  it('skips incompatible v3 metadata records on restore with a warning and ignores inline meta.services.rtdb', async () => {
    const storage = createMemoryBackend();
    await storage.putRecords('rtdb:v3-rejected', new Map<string, unknown>([
      [META_RECORD_ID, {
        version: 3,
        savedAt: 100,
        services: {
          rtdb: {
            '.pyricRtdbPersistence': 1,
            data: { items: { legacy: 1 } },
            priorities: {},
          },
        },
      }],
      ['aa', { docs: { 'notes/stale': { title: 'v3' } } }],
    ]));

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    const sandbox1 = initializeSandbox();
    try {
      await sandbox1.enablePersistence({ key: 'rtdb:v3-rejected', injectedBackend: storage, flushIntervalMs: 60_000 });
      expect(warnings.some((line) => line.includes('unsupported persistence format version 3'))).toBe(true);
      expect(sandbox1.admin.getDocument('notes/stale')).toBeNull();
      const db1 = getDatabase(sandbox1);
      expect((await get(ref(db1, '/items/legacy'))).exists()).toBe(false);

      // Flushing fresh v4 state removes stale v3 records so a subsequent reopen stays clean.
      await set(ref(db1, '/items/fresh'), 'v4');
      await sandbox1.flush();
      expect(await storage.getRecord('rtdb:v3-rejected', 'aa')).toBeNull();
      const v4Meta = (await storage.getRecord('rtdb:v3-rejected', META_RECORD_ID)) as { version: number; services: Record<string, unknown> };
      expect(v4Meta.version).toBe(CHUNK_FORMAT_VERSION);
      expect(v4Meta.services).not.toHaveProperty('rtdb');
    } finally {
      console.warn = originalWarn;
      sandbox1.dispose();
    }

    // Even at CHUNK_FORMAT_VERSION, inline meta.services.rtdb is ignored rather than loaded.
    await storage.putRecords('rtdb:inline-ignored', new Map<string, unknown>([
      [META_RECORD_ID, {
        version: CHUNK_FORMAT_VERSION,
        savedAt: 200,
        services: {
          rtdb: {
            '.pyricRtdbPersistence': 1,
            data: { items: { inline: 'ignored' } },
            priorities: {},
          },
        },
      }],
    ]));
    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({ key: 'rtdb:inline-ignored', injectedBackend: storage, flushIntervalMs: 60_000 });
    const db2 = getDatabase(sandbox2);
    expect((await get(ref(db2, '/items/inline'))).exists()).toBe(false);
    sandbox2.dispose();
  });
});
