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
