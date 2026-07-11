/**
 * `@pyric/rtdb` modular SDK — connection/transport/logging honest no-ops.
 *
 * Before this change, `goOffline`, `goOnline`, `forceLongPolling`,
 * `forceWebSockets`, and `enableLogging` were not exported from
 * `pyric/database` at all — importing them from an app bundled under
 * pyric would fail at import time, crashing before the app ever ran a
 * read or write. These tests assert each is now importable and settles
 * without throwing on a sandbox handle.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  ref,
  set,
  get,
  goOffline,
  goOnline,
  forceLongPolling,
  forceWebSockets,
  enableLogging,
} from '../../../src/database/index.js';

function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  return { sandbox, db };
}

describe('goOffline / goOnline', () => {
  it('goOffline(db) does not throw and is accepted on a sandbox handle', () => {
    const { db } = setup();
    expect(() => goOffline(db)).not.toThrow();
  });

  it('goOnline(db) does not throw and is accepted on a sandbox handle', () => {
    const { db } = setup();
    expect(() => goOnline(db)).not.toThrow();
  });

  it('reads/writes still work immediately after goOffline — no offline queue is simulated', async () => {
    const { db } = setup();
    goOffline(db);
    const r = ref(db, 'notes/n1');
    await set(r, { text: 'wrote anyway' });
    const snap = await get(r);
    expect(snap.val()).toEqual({ text: 'wrote anyway' });
  });
});

describe('forceLongPolling / forceWebSockets / enableLogging', () => {
  it('forceLongPolling() is an accepted no-op', () => {
    expect(() => forceLongPolling()).not.toThrow();
  });

  it('forceWebSockets() is an accepted no-op', () => {
    expect(() => forceWebSockets()).not.toThrow();
  });

  it('enableLogging() accepts no args', () => {
    expect(() => enableLogging()).not.toThrow();
  });

  it('enableLogging(true) accepts a boolean level', () => {
    expect(() => enableLogging(true)).not.toThrow();
  });

  it('enableLogging(logger, persistent) accepts a logger callback + persistent flag', () => {
    expect(() => enableLogging((msg: string) => void msg, true)).not.toThrow();
  });
});
