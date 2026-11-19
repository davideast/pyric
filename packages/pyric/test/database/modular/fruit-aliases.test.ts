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
import { setup } from './oracle-conformance.support.js';

describe('RTDB low-hanging-fruit exports (issue #149)', () => {
  it('all six symbols are importable (were missing exports before)', () => {
    for (const fn of [goOffline, goOnline, forceLongPolling, forceWebSockets, enableLogging, refFromURL]) {
      expect(typeof fn).toBe('function');
    }
  });

  it('goOffline queues outbound writes locally until goOnline flushes them to other clients', async () => {
    const { db, sandbox } = setup();
    const observer = getDatabase(sandbox.withAuth({ uid: 'observer' }));
    const r = ref(db, '/room/msg');
    const obsRef = ref(observer, '/room/msg');
    await set(r, 'hello');

    expect(() => goOffline(db)).not.toThrow();
    const pendingSet = set(r, 'while-offline');
    expect((await get(r)).val()).toBe('while-offline');
    expect((await get(obsRef)).val()).toBe('hello');
    expect(() => goOnline(db)).not.toThrow();
    await pendingSet;
    expect((await get(obsRef)).val()).toBe('while-offline');
  });

  it('forceLongPolling / forceWebSockets are accepted no-ops and enableLogging wires logger callbacks', async () => {
    expect(() => forceLongPolling()).not.toThrow();
    expect(() => forceWebSockets()).not.toThrow();
    expect(() => enableLogging((msg: string) => void msg, true)).toThrow(
      /Can't turn on custom loggers persistently/,
    );
    const logs: string[] = [];
    try {
      expect(enableLogging(true)).toBeUndefined();
      expect(enableLogging(false)).toBeUndefined();
      expect(enableLogging((msg: string) => { logs.push(msg); }, false)).toBeUndefined();
      const { db } = setup();
      await set(ref(db, '/logs/ping'), 1);
      expect(logs.length).toBeGreaterThan(0);
    } finally {
      enableLogging(false);
    }
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
