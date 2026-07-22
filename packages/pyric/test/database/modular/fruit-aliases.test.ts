/**
 * Low-hanging-fruit `firebase/database` exports (issue #149).
 *
 * Each test proves (a) the symbol is now importable (was a missing export —
 * an app importing it crashed at module load before this landed) and (b) its
 * contract: honest no-ops resolve/return without error and don't perturb the
 * store; `refFromURL` is a REAL alias that resolves the URL's path exactly
 * like `ref(db, path)`.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  ref,
  get,
  set,
  goOffline,
  goOnline,
  forceLongPolling,
  forceWebSockets,
  enableLogging,
  refFromURL,
} from '../../../src/database/index.js';

function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  return { sandbox, db };
}

describe('RTDB low-hanging-fruit exports (issue #149)', () => {
  it('all six symbols are importable (were missing exports before)', () => {
    for (const fn of [goOffline, goOnline, forceLongPolling, forceWebSockets, enableLogging, refFromURL]) {
      expect(typeof fn).toBe('function');
    }
  });

  it('goOffline / goOnline preserve ordinary local reads and writes when no disconnect work is queued', async () => {
    const { db } = setup();
    const r = ref(db, '/room/msg');
    await set(r, 'hello');

    expect(() => goOffline(db)).not.toThrow();
    // The local data plane remains usable; connection state only owns the
    // one-shot onDisconnect queue.
    await set(r, 'while-offline');
    expect((await get(r)).val()).toBe('while-offline');
    expect(() => goOnline(db)).not.toThrow();
    expect((await get(r)).val()).toBe('while-offline');
  });

  it('forceLongPolling / forceWebSockets / enableLogging are accepted no-ops', () => {
    expect(() => forceLongPolling()).not.toThrow();
    expect(() => forceWebSockets()).not.toThrow();
    expect(() => enableLogging()).not.toThrow();
    expect(() => enableLogging(true)).not.toThrow();
    expect(() => enableLogging((msg: string) => void msg, true)).not.toThrow();
  });

  it('refFromURL parses the path from the URL and resolves it like ref(db, path)', async () => {
    const { db } = setup();
    await set(ref(db, '/users/alice/name'), 'Alice');

    const fromUrl = refFromURL(db, 'https://demo-db.firebaseio.com/users/alice/name');
    // Resolves the SAME node as ref(db, path).
    expect(fromUrl.toString()).toBe(ref(db, '/users/alice/name').toString());
    expect((await get(fromUrl)).val()).toBe('Alice');

    // A different-host URL with the same path resolves the same node (the
    // single-database sandbox ignores host/namespace).
    const otherHost = refFromURL(db, 'https://someproject.europe-west1.firebasedatabase.app/users/alice/name');
    expect((await get(otherHost)).val()).toBe('Alice');
  });

  it('refFromURL rejects a value that is not an absolute URL', () => {
    const { db } = setup();
    expect(() => refFromURL(db, '/users/alice')).toThrow();
  });
});
