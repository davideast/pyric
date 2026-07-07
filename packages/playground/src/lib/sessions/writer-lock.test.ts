/**
 * Writer-lock election tests.
 *
 * `navigator.locks` does not exist under Bun (nor jsdom), so the lock
 * instances run against an injected mock LockManager + an in-process
 * BroadcastChannel hub that simulates two "tabs" inside one test.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  acquireSessionWriterLock,
  isSessionWriter,
  markSessionWriterStatus,
  resetSessionWriterStatusForTests,
  sessionWriterLockName,
  subscribeSessionWriter,
  type ChannelLike,
  type LocksApiLike,
  type SessionWriterStatus,
} from './writer-lock';
import { writerGatedBackend } from './sandbox';
import type { PersistenceBackend } from 'pyric/sandbox';

afterEach(() => {
  resetSessionWriterStatusForTests();
});

// ─── Mocks ─────────────────────────────────────────────────────────────

/** Minimal Web Locks semantics: one holder per name; `ifAvailable`
 *  hands `null` to the callback when held; the lock frees when the
 *  callback's returned promise settles. */
function makeMockLocks(): LocksApiLike {
  const held = new Set<string>();
  return {
    async request(name, _options, callback) {
      if (held.has(name)) return await callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

/** BroadcastChannel hub — messages go to every OTHER channel on the
 *  same name, delivered asynchronously (like the real API). */
function makeChannelHub() {
  const channels = new Map<string, Set<{ deliver: (data: unknown) => void }>>();
  return {
    create(name: string): ChannelLike {
      const listeners: Array<(ev: { data: unknown }) => void> = [];
      const entry = {
        deliver(data: unknown) {
          for (const l of listeners) l({ data });
        },
      };
      let peers = channels.get(name);
      if (!peers) {
        peers = new Set();
        channels.set(name, peers);
      }
      peers.add(entry);
      return {
        postMessage(message: unknown) {
          for (const peer of channels.get(name) ?? []) {
            if (peer === entry) continue;
            queueMicrotask(() => peer.deliver(message));
          }
        },
        close() {
          channels.get(name)?.delete(entry);
        },
        addEventListener(_type, listener) {
          listeners.push(listener);
        },
      };
    },
  };
}

const FAST = { yieldTimeoutMs: 200, retryDelayMs: 5 };

// ─── Election ──────────────────────────────────────────────────────────

describe('acquireSessionWriterLock — election', () => {
  it('no Locks API → unconditional writer (current behavior, never blocks)', async () => {
    const lock = await acquireSessionWriterLock('s1', { locksApi: null });
    expect(lock.unsupported).toBe(true);
    expect(lock.status()).toBe('writer');
    expect(await lock.takeOver()).toBe(true);
    lock.release();
  });

  it('first tab is the writer, second tab on the same session is read-only', async () => {
    const locks = makeMockLocks();
    const hub = makeChannelHub();
    const a = await acquireSessionWriterLock('s1', {
      locksApi: locks,
      createChannel: hub.create,
      ...FAST,
    });
    const b = await acquireSessionWriterLock('s1', {
      locksApi: locks,
      createChannel: hub.create,
      ...FAST,
    });
    expect(a.status()).toBe('writer');
    expect(b.status()).toBe('readonly');
    a.release();
    b.release();
  });

  it('tabs on DIFFERENT sessions are both writers (lock is per session)', async () => {
    const locks = makeMockLocks();
    const hub = makeChannelHub();
    const a = await acquireSessionWriterLock('s1', {
      locksApi: locks,
      createChannel: hub.create,
      ...FAST,
    });
    const b = await acquireSessionWriterLock('s2', {
      locksApi: locks,
      createChannel: hub.create,
      ...FAST,
    });
    expect(sessionWriterLockName('s1')).not.toBe(sessionWriterLockName('s2'));
    expect(a.status()).toBe('writer');
    expect(b.status()).toBe('writer');
    a.release();
    b.release();
  });

  it('after the writer releases (tab closed), a new tab wins the election', async () => {
    const locks = makeMockLocks();
    const hub = makeChannelHub();
    const a = await acquireSessionWriterLock('s1', {
      locksApi: locks,
      createChannel: hub.create,
      ...FAST,
    });
    a.release();
    // Let the mock free the lock (callback promise settles on a microtask).
    await new Promise((r) => setTimeout(r, 0));
    const b = await acquireSessionWriterLock('s1', {
      locksApi: locks,
      createChannel: hub.create,
      ...FAST,
    });
    expect(b.status()).toBe('writer');
    b.release();
  });
});

// ─── Take over (graceful steal) ────────────────────────────────────────

describe('acquireSessionWriterLock — take over', () => {
  it('holder yields gracefully: onYield flushes FIRST, then status flips, then the requester becomes writer', async () => {
    const locks = makeMockLocks();
    const hub = makeChannelHub();
    const order: string[] = [];

    const a = await acquireSessionWriterLock('s1', {
      locksApi: locks,
      createChannel: hub.create,
      onYield: async () => {
        // Still the writer while flushing.
        order.push(`yield(status=${a.status()})`);
      },
      ...FAST,
    });
    a.subscribe((s: SessionWriterStatus) => order.push(`a:${s}`));

    const b = await acquireSessionWriterLock('s1', {
      locksApi: locks,
      createChannel: hub.create,
      ...FAST,
    });
    b.subscribe((s: SessionWriterStatus) => order.push(`b:${s}`));
    expect(b.status()).toBe('readonly');

    const won = await b.takeOver();
    expect(won).toBe(true);
    expect(a.status()).toBe('readonly');
    expect(b.status()).toBe('writer');
    expect(order).toEqual(['yield(status=writer)', 'a:readonly', 'b:writer']);

    a.release();
    b.release();
  });

  it('takeOver while already the writer is a no-op true', async () => {
    const locks = makeMockLocks();
    const hub = makeChannelHub();
    const a = await acquireSessionWriterLock('s1', {
      locksApi: locks,
      createChannel: hub.create,
      ...FAST,
    });
    expect(await a.takeOver()).toBe(true);
    expect(a.status()).toBe('writer');
    a.release();
  });

  it('takeOver succeeds when the holder tab is simply gone (lock auto-released)', async () => {
    const locks = makeMockLocks();
    const hub = makeChannelHub();
    const a = await acquireSessionWriterLock('s1', {
      locksApi: locks,
      createChannel: hub.create,
      ...FAST,
    });
    const b = await acquireSessionWriterLock('s1', {
      locksApi: locks,
      createChannel: hub.create,
      ...FAST,
    });
    // Tab A "closes": browser auto-releases its lock; its channel dies.
    a.release();
    await new Promise((r) => setTimeout(r, 0));

    expect(await b.takeOver()).toBe(true);
    expect(b.status()).toBe('writer');
    b.release();
  });
});

// ─── Module-global status + writer-gated persistence backend ──────────

describe('module-global writer status', () => {
  it('defaults to writer and notifies subscribers on change', () => {
    expect(isSessionWriter()).toBe(true);
    const seen: SessionWriterStatus[] = [];
    const unsub = subscribeSessionWriter((s) => seen.push(s));
    markSessionWriterStatus('readonly');
    expect(isSessionWriter()).toBe(false);
    markSessionWriterStatus('readonly'); // dedup — no second event
    markSessionWriterStatus('writer');
    expect(seen).toEqual(['readonly', 'writer']);
    unsub();
  });
});

describe('writerGatedBackend (sessions-store flush gate / autosave backstop)', () => {
  function makeBackend(): { backend: PersistenceBackend; store: Map<string, Map<string, unknown>> } {
    const store = new Map<string, Map<string, unknown>>();
    const bucket = (key: string) => {
      let records = store.get(key);
      if (!records) {
        records = new Map<string, unknown>();
        store.set(key, records);
      }
      return records;
    };
    return {
      store,
      backend: {
        getRecord: async (key, recordId) => store.get(key)?.get(recordId) ?? null,
        listRecords: async (key) => [...(store.get(key)?.keys() ?? [])],
        putRecords: async (key, records) => {
          const target = bucket(key);
          for (const [recordId, value] of records) target.set(recordId, value);
        },
        deleteRecords: async (key, recordIds) => {
          const target = store.get(key);
          if (!target) return;
          for (const recordId of recordIds) target.delete(recordId);
        },
        clear: async (key) => void store.delete(key),
      },
    };
  }

  it('drops writes and clears while read-only; reads always pass', async () => {
    const { backend, store } = makeBackend();
    const gated = writerGatedBackend(backend);
    store.set('k', new Map([['snapshot', 'persisted-by-writer-tab']]));

    markSessionWriterStatus('readonly');
    await gated.putRecords('k', new Map([['snapshot', 'stale-snapshot-from-readonly-tab']]));
    expect(store.get('k')?.get('snapshot')).toBe('persisted-by-writer-tab'); // not clobbered
    await gated.clear('k');
    expect(store.get('k')?.get('snapshot')).toBe('persisted-by-writer-tab');
    expect(await gated.getRecord('k', 'snapshot')).toBe('persisted-by-writer-tab');
  });

  it('writes land again immediately after a take-over (checked at write time)', async () => {
    const { backend, store } = makeBackend();
    const gated = writerGatedBackend(backend);

    markSessionWriterStatus('readonly');
    await gated.putRecords('k', new Map([['snapshot', 'dropped']]));
    expect(store.get('k')?.has('snapshot') ?? false).toBe(false);

    markSessionWriterStatus('writer');
    await gated.putRecords('k', new Map([['snapshot', 'landed']]));
    expect(store.get('k')?.get('snapshot')).toBe('landed');
  });
});
