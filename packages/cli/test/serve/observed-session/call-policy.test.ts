import { describe, expect, it } from 'bun:test';
import type { ObservedCall } from 'pyric/sandbox';
import {
  applyAcceptedSessionCall,
  classifySessionCall,
  invalidateEvictedPendingCall,
  isSessionDataService,
} from '../../../src/serve/observed-session/call-policy.js';
import { createObservedSessionDataStore } from '../../../src/serve/observed-session/store.js';

function makeCall(overrides: Partial<ObservedCall> & Pick<ObservedCall, 'service' | 'method'>): ObservedCall {
  return {
    at: 1_700_000_000_000,
    outcome: { status: 'ok' },
    ...overrides,
  };
}

describe('observed-session call-policy', () => {
  it('classifies Firestore, RTDB, and Storage calls from canonical rules maps with fail-closed fallback', () => {
    expect(isSessionDataService('firestore')).toBe(true);
    expect(isSessionDataService('rtdb')).toBe(true);
    expect(isSessionDataService('storage')).toBe(true);
    expect(isSessionDataService('auth')).toBe(false);

    expect(classifySessionCall('storage', 'getMetadata')).toBe('read');
    expect(classifySessionCall('storage', 'listAll')).toBe('read');
    expect(classifySessionCall('storage', 'File.download')).toBe('read');
    expect(classifySessionCall('storage', 'uploadBytes')).toBe('scoped-mutation');
    expect(classifySessionCall('storage', 'deleteObject')).toBe('scoped-mutation');
    expect(classifySessionCall('storage', 'File.restore')).toBe('scoped-mutation');
    expect(classifySessionCall('storage', 'File.copy')).toBe('unscoped-mutation');
    expect(classifySessionCall('storage', 'Bucket.deleteFiles')).toBe('unscoped-mutation');
    expect(classifySessionCall('storage', 'futureUnknownStorageMethod')).toBe('scoped-mutation');

    expect(classifySessionCall('firestore', 'getDoc')).toBe('read');
    expect(classifySessionCall('firestore', 'getDocs')).toBe('read');
    expect(classifySessionCall('firestore', 'onSnapshot')).toBe('read');
    expect(classifySessionCall('firestore', 'Query.onSnapshot')).toBe('read');
    expect(classifySessionCall('firestore', 'Firestore.getAll')).toBe('read');
    expect(classifySessionCall('firestore', 'setDoc')).toBe('scoped-mutation');
    expect(classifySessionCall('firestore', 'DocumentReference.update')).toBe('scoped-mutation');
    expect(classifySessionCall('firestore', 'writeBatch')).toBe('unscoped-mutation');
    expect(classifySessionCall('firestore', 'runTransaction')).toBe('unscoped-mutation');
    expect(classifySessionCall('firestore', 'WriteBatch.commit')).toBe('unscoped-mutation');
    expect(classifySessionCall('firestore', 'Firestore.recursiveDelete')).toBe('unscoped-mutation');
    expect(classifySessionCall('firestore', 'terminate')).toBe('passive');
    expect(classifySessionCall('firestore', 'getCountFromServer')).toBe('passive');
    expect(classifySessionCall('firestore', 'getAggregateFromServer')).toBe('passive');
    expect(classifySessionCall('firestore', 'futureUnknownMethod')).toBe('scoped-mutation');

    expect(classifySessionCall('rtdb', 'get')).toBe('read');
    expect(classifySessionCall('rtdb', 'Query.get')).toBe('read');
    expect(classifySessionCall('rtdb', 'Query.once')).toBe('read');
    expect(classifySessionCall('rtdb', 'Query.on')).toBe('read');
    expect(classifySessionCall('rtdb', 'set')).toBe('scoped-mutation');
    expect(classifySessionCall('rtdb', 'update')).toBe('scoped-mutation');
    expect(classifySessionCall('rtdb', 'remove')).toBe('scoped-mutation');
    expect(classifySessionCall('rtdb', 'push')).toBe('scoped-mutation');
    expect(classifySessionCall('rtdb', 'runTransaction')).toBe('scoped-mutation');
    expect(classifySessionCall('rtdb', 'goOnline')).toBe('passive');
    expect(classifySessionCall('rtdb', 'onDisconnect.cancel')).toBe('passive');
    expect(classifySessionCall('rtdb', 'futureUnknownRtdbMethod')).toBe('scoped-mutation');
  });

  it('applies deltas and fail-closed invalidations for failed, skipped, unscoped, and evicted calls', () => {
    const store = createObservedSessionDataStore({ projectId: 'demo' });

    // Seed baseline state across Firestore, RTDB, and Storage.
    applyAcceptedSessionCall(
      store,
      {
        call: makeCall({ service: 'firestore', method: 'setDoc', path: 'rooms/r1' }),
        sessionData: { firestore: [{ kind: 'set', path: 'rooms/r1', data: { open: true } }] },
      },
      'demo',
    );
    applyAcceptedSessionCall(
      store,
      {
        call: makeCall({
          service: 'rtdb',
          method: 'set',
          instance: 'demo-default-rtdb',
          path: '/flags/open',
        }),
        sessionData: {
          rtdb: [{ kind: 'set', instance: 'demo-default-rtdb', path: '/flags/open', value: true }],
        },
      },
      'demo',
    );
    applyAcceptedSessionCall(
      store,
      {
        call: makeCall({ service: 'storage', method: 'getMetadata', sdk: 'admin' }),
        sessionData: {
          storage: [
            {
              kind: 'upsert',
              bucket: 'demo.firebasestorage.app',
              fullPath: 'docs/readme.txt',
              metadata: { size: 12, contentType: 'text/plain' },
            },
          ],
        },
      },
      'demo',
    );
    expect(store.getFirestoreDoc('rooms/r1')).toEqual({ status: 'complete', data: { open: true } });
    expect(store.getRtdbInstance('demo-default-rtdb').isPathKnown('/flags/open')).toBe(true);
    expect(store.snapshot().sources).toEqual({ client: true, admin: true });

    // Definitive rules denial on a mutation preserves existing authoritative state.
    applyAcceptedSessionCall(
      store,
      {
        call: makeCall({
          service: 'firestore',
          method: 'setDoc',
          path: 'rooms/r1',
          outcome: { status: 'error', code: 'permission-denied' },
        }),
      },
      'demo',
    );
    expect(store.getFirestoreDoc('rooms/r1')).toEqual({ status: 'complete', data: { open: true } });

    // Non-rules mutation error (`unavailable`) invalidates target fail-closed.
    applyAcceptedSessionCall(
      store,
      {
        call: makeCall({
          service: 'firestore',
          method: 'setDoc',
          path: 'rooms/r1',
          outcome: { status: 'error', code: 'unavailable' },
        }),
      },
      'demo',
    );
    expect(store.getFirestoreDoc('rooms/r1')).toEqual({ status: 'unobserved' });

    // Partial unscoped mutation (`runTransaction` with skipped ops) invalidates all Firestore state.
    store.apply({ firestore: [{ kind: 'set', path: 'rooms/r2', data: { open: true } }] });
    applyAcceptedSessionCall(
      store,
      {
        call: makeCall({ service: 'firestore', method: 'runTransaction' }),
        sessionData: {
          firestore: [{ kind: 'set', path: 'rooms/r3', data: { open: true } }],
          skipped: { unsupported: 1 },
        },
      },
      'demo',
    );
    expect(store.getFirestoreDoc('rooms/r2')).toEqual({ status: 'unobserved' });
    expect(store.getFirestoreDoc('rooms/r3')).toEqual({ status: 'unobserved' });
    expect(store.snapshot().firestore).toEqual({});

    // Unscoped `Firestore.recursiveDelete` with a `path` clears `target` so subcollection docs invalidate too (CP4).
    for (const outcome of [{ status: 'error', code: 'unavailable' } as const, { status: 'ok' } as const]) {
      store.apply({ firestore: [{ kind: 'set', path: 'spaces/s1/notes/n1', data: { a: 1 } }] });
      applyAcceptedSessionCall(
        store,
        {
          call: makeCall({
            service: 'firestore',
            sdk: 'admin',
            method: 'Firestore.recursiveDelete',
            path: 'spaces/s1',
            outcome,
          }),
        },
        'demo',
      );
      expect(store.getFirestoreDoc('spaces/s1/notes/n1')).toEqual({ status: 'unobserved' });
      expect(store.snapshot().firestore).toEqual({});
    }

    // Skipped Storage read/list invalidates matching Storage catalog entry cleanly.
    applyAcceptedSessionCall(
      store,
      {
        call: makeCall({
          service: 'storage',
          method: 'getMetadata',
          bucket: 'demo.firebasestorage.app',
          path: 'docs/readme.txt',
        }),
        sessionDataSkip: 'oversized',
      },
      'demo',
    );
    expect(store.snapshot().storage).toBeUndefined();

    // Passive calls and listener lifecycle events do not invalidate on pending eviction; reads/writes do.
    invalidateEvictedPendingCall(
      store,
      makeCall({ service: 'rtdb', method: 'goOffline', instance: 'demo-default-rtdb', path: '/flags/open' }),
      'demo',
    );
    invalidateEvictedPendingCall(
      store,
      makeCall({
        service: 'rtdb',
        method: 'onValue',
        listener: { phase: 'attach', id: 'l-1', target: '/flags/open' },
        instance: 'demo-default-rtdb',
        path: '/flags/open',
      }),
      'demo',
    );
    expect(store.getRtdbInstance('demo-default-rtdb').isPathKnown('/flags/open')).toBe(true);

    invalidateEvictedPendingCall(
      store,
      makeCall({ service: 'rtdb', method: 'set', instance: 'demo-default-rtdb', path: '/flags/open' }),
      'demo',
    );
    expect(store.getRtdbInstance('demo-default-rtdb').isPathKnown('/flags/open')).toBe(false);
  });

  it('classifies Storage mutations, preserves entries on definitive rules denials, invalidates uncaptured/ambiguous Storage writes, and normalizes gs:// buckets', () => {
    expect(classifySessionCall('storage', 'getMetadata')).toBe('read');
    expect(classifySessionCall('storage', 'Bucket.getFiles')).toBe('read');
    expect(classifySessionCall('storage', 'uploadBytes')).toBe('scoped-mutation');
    expect(classifySessionCall('storage', 'File.restore')).toBe('scoped-mutation');
    expect(classifySessionCall('storage', 'File.makePublic')).toBe('scoped-mutation');
    expect(classifySessionCall('storage', 'File.copy')).toBe('unscoped-mutation');
    expect(classifySessionCall('storage', 'File.move')).toBe('unscoped-mutation');
    expect(classifySessionCall('storage', 'Bucket.combine')).toBe('unscoped-mutation');
    expect(classifySessionCall('storage', 'Bucket.delete')).toBe('unscoped-mutation');

    const store = createObservedSessionDataStore({ projectId: 'demo-test' });
    store.apply({
      storage: [
        { kind: 'upsert', bucket: 'demo-test.appspot.com', fullPath: 'items/a.txt', metadata: { size: 10 } },
        { kind: 'upsert', bucket: 'demo-test.appspot.com', fullPath: 'items/b.txt', metadata: { size: 20 } },
        { kind: 'upsert', bucket: 'demo-test.appspot.com', fullPath: 'items/c.txt', metadata: { size: 30 } },
      ],
    });

    // Definitive Storage rules denials keep cached entries intact.
    applyAcceptedSessionCall(
      store,
      {
        call: makeCall({
          service: 'storage',
          method: 'deleteObject',
          bucket: 'demo-test.appspot.com',
          path: 'items/a.txt',
          outcome: { status: 'error', code: 'storage/unauthorized' },
        }),
      },
      'demo-test',
    );
    expect(Object.keys(store.snapshot().storage?.['demo-test.appspot.com']?.objects ?? {})).toEqual([
      'items/a.txt',
      'items/b.txt',
      'items/c.txt',
    ]);

    // Accepted Storage scoped mutation with no sessionData invalidates target path.
    applyAcceptedSessionCall(
      store,
      {
        call: makeCall({
          service: 'storage',
          sdk: 'admin',
          method: 'File.restore',
          bucket: 'demo-test.appspot.com',
          path: 'items/a.txt',
        }),
      },
      'demo-test',
    );
    expect(Object.keys(store.snapshot().storage?.['demo-test.appspot.com']?.objects ?? {})).toEqual([
      'items/b.txt',
      'items/c.txt',
    ]);

    // Bucket normalization handles gs://, uppercase, and trailing slashes.
    store.invalidateStorage('gs://Demo-Test.appspot.com/', 'items/c.txt');
    expect(Object.keys(store.snapshot().storage?.['demo-test.appspot.com']?.objects ?? {})).toEqual([
      'items/b.txt',
    ]);

    // Admin read streams and read-only Admin methods without sessionData must preserve cached Storage entries.
    expect(classifySessionCall('storage', 'File.createReadStream')).toBe('read');
    expect(classifySessionCall('storage', 'File.getSignedUrl')).toBe('read');
    expect(classifySessionCall('storage', 'Bucket.getFilesStream')).toBe('read');
    expect(classifySessionCall('storage', 'Storage.getBuckets')).toBe('read');
    applyAcceptedSessionCall(
      store,
      {
        call: makeCall({
          service: 'storage',
          sdk: 'admin',
          method: 'File.createReadStream',
          bucket: 'demo-test.appspot.com',
          path: 'items/b.txt',
        }),
      },
      'demo-test',
    );
    expect(Object.keys(store.snapshot().storage?.['demo-test.appspot.com']?.objects ?? {})).toEqual([
      'items/b.txt',
    ]);

    // Ambiguous failure on unscoped Storage mutation (`File.copy`) invalidates destination & source catalog entries.
    applyAcceptedSessionCall(
      store,
      {
        call: makeCall({
          service: 'storage',
          sdk: 'admin',
          method: 'File.copy',
          bucket: 'demo-test.appspot.com',
          path: 'items/src.txt',
          outcome: { status: 'error', code: 'storage/unknown' },
        }),
      },
      'demo-test',
    );
    expect(store.snapshot().storage).toBeUndefined();
  });

  it('preserves unrelated docs on projected/masked Firestore reads while purging contradicted returned docs and single-doc skipped reads, and skips store purge only on proven-uncommitted failed transactions (#3283)', () => {
    const store = createObservedSessionDataStore({ projectId: 'demo' });
    store.apply(
      {
        firestore: [
          { kind: 'set', path: 'orders/ord-1', data: { status: 'fulfilled', total: 42 } },
          { kind: 'set', path: 'orders/ord-2', data: { status: 'shipped', total: 80 } },
          { kind: 'set', path: 'orders/ord-changed', data: { status: 'queued', total: 10 } },
          { kind: 'set', path: 'orders/ord-oversized', data: { status: 'ready', total: 5 } },
        ],
      },
      'demo',
      'admin',
    );

    // 1. Projected `Query.get` (`path: 'orders'`): keeps `ord-1` (matching projection) and `ord-2` (unrelated),
    //    but purges `ord-changed` because the server returned `status: 'cancelled'`.
    applyAcceptedSessionCall(
      store,
      {
        call: makeCall({
          service: 'firestore',
          sdk: 'admin',
          method: 'Query.get',
          path: 'orders',
        }),
        sessionData: {
          firestore: [
            { kind: 'projection', path: 'orders/ord-1', fields: ['status'], data: { status: 'fulfilled' } },
            { kind: 'projection', path: 'orders/ord-changed', fields: ['status'], data: { status: 'cancelled' } },
          ],
          skipped: { unsupported: 1 },
        },
      },
      'demo',
    );
    expect(store.snapshot().firestore['orders/ord-1']).toEqual({ status: 'fulfilled', total: 42 });
    expect(store.snapshot().firestore['orders/ord-2']).toEqual({ status: 'shipped', total: 80 });
    expect(store.snapshot().firestore['orders/ord-changed']).toBeUndefined();
    expect(store.getFirestoreDoc('orders/ord-changed')).toEqual({ status: 'unobserved' });
    expect(store.snapshot().skips?.unsupported).toBe(1);

    // 2. Masked `Firestore.getAll` (`path: undefined`): does not wipe the store; reconciles returned docs.
    applyAcceptedSessionCall(
      store,
      {
        call: makeCall({
          service: 'firestore',
          sdk: 'admin',
          method: 'Firestore.getAll',
        }),
        sessionData: {
          firestore: [
            { kind: 'projection', path: 'orders/ord-2', fields: ['status'], data: { status: 'returned' } },
          ],
          skipped: { unsupported: 1 },
        },
      },
      'demo',
    );
    expect(store.snapshot().firestore['orders/ord-1']).toEqual({ status: 'fulfilled', total: 42 });
    expect(store.snapshot().firestore['orders/ord-2']).toBeUndefined();
    expect(store.snapshot().skips?.unsupported).toBe(2);

    // 3. Single-document skipped read (`DocumentReference.get` on `orders/ord-oversized`) still purges that doc.
    applyAcceptedSessionCall(
      store,
      {
        call: makeCall({
          service: 'firestore',
          sdk: 'admin',
          method: 'DocumentReference.get',
          path: 'orders/ord-oversized',
        }),
        sessionData: { skipped: { oversized: 1 } },
      },
      'demo',
    );
    expect(store.snapshot().firestore['orders/ord-oversized']).toBeUndefined();
    expect(store.snapshot().firestore['orders/ord-1']).toEqual({ status: 'fulfilled', total: 42 });

    // 4. Proven-uncommitted `Firestore.runTransaction` rejection counts `failed: 1` without purging docs.
    applyAcceptedSessionCall(
      store,
      {
        call: makeCall({
          service: 'firestore',
          sdk: 'admin',
          method: 'Firestore.runTransaction',
          outcome: { status: 'error', code: 'Error' },
        }),
        sessionData: { uncommitted: true },
      },
      'demo',
    );
    expect(store.snapshot().firestore['orders/ord-1']).toEqual({ status: 'fulfilled', total: 42 });
    expect(store.snapshot().skips?.failed).toBe(1);

    // 5. Truncated (`> 250` docs or `> 512 KiB`) collection or `getAll` reads purge cached entries beyond the
    //    delta cap (`ord-251`) before applying the captured prefix, while keeping unrelated collections (`users/u-1`).
    store.apply(
      {
        firestore: [
          { kind: 'set', path: 'orders/ord-251', data: { status: 'stale-before-cut-off', total: 99 } },
          { kind: 'set', path: 'users/u-1', data: { name: 'Ada' } },
        ],
      },
      'demo',
      'admin',
    );
    applyAcceptedSessionCall(
      store,
      {
        call: makeCall({
          service: 'firestore',
          sdk: 'admin',
          method: 'Query.get',
          path: 'orders',
        }),
        sessionData: {
          firestore: [
            { kind: 'projection', path: 'orders/ord-1', fields: ['status'], data: { status: 'fulfilled' } },
          ],
          skipped: { unsupported: 1, truncated: 1 },
        },
      },
      'demo',
    );
    expect(store.snapshot().firestore['orders/ord-251']).toBeUndefined();
    expect(store.snapshot().firestore['users/u-1']).toEqual({ name: 'Ada' });
    expect(store.snapshot().skips?.truncated).toBe(1);

    // Plain `Query.get` cut off at the 250-doc / 512 KiB cap also purges stale `#251+` while applying captured `set` ops.
    store.apply(
      { firestore: [{ kind: 'set', path: 'orders/ord-252', data: { status: 'stale-tail' } }] },
      'demo',
      'admin',
    );
    applyAcceptedSessionCall(
      store,
      {
        call: makeCall({
          service: 'firestore',
          sdk: 'admin',
          method: 'Query.get',
          path: 'orders',
        }),
        sessionData: {
          firestore: [{ kind: 'set', path: 'orders/ord-1', data: { status: 'fresh', total: 50 } }],
          skipped: { truncated: 1 },
        },
      },
      'demo',
    );
    expect(store.snapshot().firestore['orders/ord-252']).toBeUndefined();
    expect(store.snapshot().firestore['orders/ord-1']).toEqual({ status: 'fresh', total: 50 });
    expect(store.snapshot().firestore['users/u-1']).toEqual({ name: 'Ada' });

    // 6. Malformed/rejected delta (`sessionDataSkip`) or ambiguous `Firestore.runTransaction` rejection still purges fail-closed.
    applyAcceptedSessionCall(
      store,
      {
        call: makeCall({
          service: 'firestore',
          sdk: 'admin',
          method: 'Firestore.runTransaction',
          outcome: { status: 'error', code: 'unavailable' },
        }),
      },
      'demo',
    );
    expect(store.snapshot().firestore).toEqual({});
    expect(store.snapshot().skips?.failed).toBe(2);
  });
});
