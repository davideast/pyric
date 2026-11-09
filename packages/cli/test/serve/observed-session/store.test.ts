import { describe, expect, it } from 'bun:test';
import { readObservedSessionDelta } from '../../../src/serve/observed-session/delta-validation.js';
import { createObservedSessionDataStore } from '../../../src/serve/observed-session/store.js';
import { UNREAD_RTDB_INSTANCE } from '../../../src/serve/observed-session/wire.js';

describe('createObservedSessionDataStore', () => {
  it('folds Firestore set/merge/dotted-update/delete and RTDB set/update/remove with empty-ancestor pruning', () => {
    const store = createObservedSessionDataStore({ projectId: 'demo-proj', now: () => 1234 });

    store.apply({
      firestore: [
        { kind: 'set', path: 'rooms/lobby', data: { title: 'Lobby', stats: { users: 2, temp: 'x' } } },
        {
          kind: 'set',
          path: 'rooms/lobby',
          data: { stats: { active: true } },
          merge: true,
          deleteFields: ['stats.temp'],
        },
        { kind: 'update', path: 'rooms/lobby', data: { 'stats.users': 3 } },
      ],
      rtdb: [
        { kind: 'set', instance: UNREAD_RTDB_INSTANCE, path: '/presence/alice', value: 'online' },
        { kind: 'update', instance: UNREAD_RTDB_INSTANCE, path: '/presence', value: { bob: 'away' } },
      ],
    });

    let snap = store.snapshot();
    expect(snap.revision).toBe(1);
    expect(snap.updatedAt).toBe(1234);
    expect(snap.defaultRtdbInstance).toBe('demo-proj-default-rtdb');
    expect(snap.firestore['rooms/lobby']).toEqual({
      title: 'Lobby',
      stats: { users: 3, active: true },
    });
    expect(snap.rtdb['demo-proj-default-rtdb']).toEqual({
      presence: { alice: 'online', bob: 'away' },
    });
    expect(snap.skips).toBeUndefined();

    // Removing all RTDB children prunes empty ancestors and removes the empty instance.
    store.apply({
      firestore: [{ kind: 'delete', path: 'rooms/lobby' }],
      rtdb: [
        { kind: 'remove', instance: 'demo-proj-default-rtdb', path: '/presence/alice' },
        { kind: 'remove', instance: 'demo-proj-default-rtdb', path: '/presence/bob' },
      ],
    });
    snap = store.snapshot();
    expect(snap.firestore).toEqual({});
    expect(snap.rtdb).toEqual({});
  });

  it('bounds memory by maxDocs and maxBytes, evicting oldest entries and reporting truncation stats', () => {
    const store = createObservedSessionDataStore({ projectId: 'demo', maxDocs: 2, maxBytes: 4096 });
    store.apply({
      firestore: [
        { kind: 'set', path: 'items/1', data: { n: 1 } },
        { kind: 'set', path: 'items/2', data: { n: 2 } },
        { kind: 'set', path: 'items/3', data: { n: 3 } },
      ],
    });
    const snap = store.snapshot();
    expect(Object.keys(snap.firestore)).toEqual(['items/2', 'items/3']);
    expect(snap.stats.truncated).toBe(true);
    expect(snap.stats.droppedCount).toBe(1);
  });

  it('stores 12 RTDB instances and 150 KiB single items while keeping the 5-key stats shape and skips breakdown', () => {
    const store = createObservedSessionDataStore({ projectId: 'demo-multi' });
    const instances = Array.from({ length: 12 }, (_, idx) => ({
      kind: 'set' as const,
      instance: `demo-multi-${String(idx + 1).padStart(2, '0')}`,
      path: '/meta',
      value: { idx },
    }));
    store.apply(readObservedSessionDelta({ rtdb: instances }));
    store.apply(
      readObservedSessionDelta({
        firestore: [{ kind: 'set', path: 'rooms/large', data: { blob: 'a'.repeat(150 * 1024) } }],
        rtdb: [{ kind: 'set', instance: 'demo-multi-01', path: '/payload', value: { blob: 'b'.repeat(150 * 1024) } }],
        skipped: { oversized: 1, unsupported: 2 },
      }),
    );

    const snap = store.snapshot();
    expect(snap.stats.rtdbInstances).toBe(12);
    expect(Object.keys(snap.rtdb)).toHaveLength(12);
    expect(snap.firestore['rooms/large']).toEqual({ blob: 'a'.repeat(150 * 1024) });
    expect(snap.stats.truncated).toBe(false);
    expect(Object.keys(snap.stats).sort()).toEqual(['byteEstimate', 'droppedCount', 'firestoreDocs', 'rtdbInstances', 'truncated']);
    expect(snap.skips).toEqual({ oversized: 1, unsupported: 2, truncated: 0, failed: 0, admin: 0 });
  });

  it('drops the stale RTDB value at a path whose oversized write it rejects', () => {
    const store = createObservedSessionDataStore({ projectId: 'demo' });
    store.apply({
      rtdb: [
        { kind: 'set', instance: 'demo-default-rtdb', path: '/rooms/r1', value: { title: 'old' } },
        { kind: 'set', instance: 'demo-default-rtdb', path: '/rooms/r2', value: { title: 'kept' } },
      ],
    });
    store.apply({
      rtdb: [{ kind: 'set', instance: 'demo-default-rtdb', path: '/rooms/r1', value: { blob: 'x'.repeat(600 * 1024) } }],
    });
    const snap = store.snapshot();
    expect(snap.rtdb['demo-default-rtdb']).toEqual({ rooms: { r2: { title: 'kept' } } });
    expect(snap.skips?.oversized).toBe(1);
    expect(snap.stats.droppedCount).toBe(1);
  });

  it('drops the stale RTDB values an update writes when the session budget rejects it', () => {
    const store = createObservedSessionDataStore({ projectId: 'demo', maxBytes: 4096 });
    store.apply({
      rtdb: [{ kind: 'set', instance: 'demo-default-rtdb', path: '/items', value: { a: 'old-a', b: 'old-b', c: 'kept' } }],
    });
    store.apply({
      rtdb: [{ kind: 'update', instance: 'demo-default-rtdb', path: '/items', value: { a: 'y'.repeat(3000), b: 'y'.repeat(3000) } }],
    });
    const snap = store.snapshot();
    expect(snap.rtdb['demo-default-rtdb']).toEqual({ items: { c: 'kept' } });
    expect(snap.skips?.truncated).toBe(1);
  });

  it('drops the stale Firestore document whose write no longer fits', () => {
    const store = createObservedSessionDataStore({ projectId: 'demo' });
    store.apply({ firestore: [{ kind: 'set', path: 'items/1', data: { n: 1 } }] });
    store.apply({ firestore: [{ kind: 'set', path: 'items/1', data: { blob: 'z'.repeat(600 * 1024) } }] });
    const snap = store.snapshot();
    expect(snap.firestore).toEqual({});
    expect(snap.skips?.oversized).toBe(1);
  });

  it('counts recorded skips and moves the revision only when one is counted', () => {
    const store = createObservedSessionDataStore({ projectId: 'demo' });
    store.recordSkip({});
    expect(store.snapshot().revision).toBe(0);
    store.recordSkip({ failed: 1 });
    store.recordSkip({ admin: 2 });
    const snap = store.snapshot();
    expect(snap.revision).toBe(2);
    expect(snap.skips).toEqual({ oversized: 0, unsupported: 0, truncated: 0, failed: 1, admin: 2 });
  });

  it('tracks contributing SDK sources only when deltas apply data, omitting sources when empty or skip-only', () => {
    const store = createObservedSessionDataStore({ projectId: 'demo' });
    expect(store.snapshot().sources).toBeUndefined();

    store.apply({ skipped: { unsupported: 1 } }, undefined, 'admin');
    expect(store.snapshot().sources).toBeUndefined();

    store.apply({ firestore: [{ kind: 'set', path: 'items/a1', data: { title: 'Admin item' } }] }, undefined, 'admin');
    expect(store.snapshot().sources).toEqual({ client: false, admin: true });

    store.apply({ rtdb: [{ kind: 'set', instance: 'demo-default-rtdb', path: '/flags/beta', value: true }] }, undefined, 'client');
    expect(store.snapshot().sources).toEqual({ client: true, admin: true });
  });
});
