/**
 * Ledger A9 (#1380): sandbox reset must route through setOnline(true) so
 * /.info/connected observers attached while offline receive true after reset
 * and subsequent goOffline()/goOnline() transitions continue working.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from '../../../src/sandbox/index.js';
import {
  get,
  getDatabase,
  goOffline,
  goOnline,
  onChildChanged,
  onDisconnect,
  onValue,
  ref,
  sandbox as rtdbSandbox,
} from '../../../src/database/index.js';

describe('ledger A9: reset notifies .info/connected observers via setOnline(true)', () => {
  it('delivers true to /.info/connected observers attached while offline when sandbox resets', () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    const seen: unknown[] = [];

    goOffline(db);
    const stop = onValue(ref(db, '.info/connected'), (snap) => {
      seen.push(snap.val());
    });
    expect(seen).toEqual([false]);

    sandbox.reset();
    expect(seen).toEqual([false, true]);

    // Already online after reset: goOnline() is a no-op, while a new
    // goOffline() -> goOnline() cycle transitions cleanly.
    goOnline(db);
    expect(seen).toEqual([false, true]);

    goOffline(db);
    goOnline(db);
    expect(seen).toEqual([false, true, false, true]);
    stop();
  });

  it('allows re-arming presence via onDisconnect inside the reset-triggered /.info/connected callback', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    rtdbSandbox.setDefaultPolicy(db, 'allow');

    goOffline(db);
    const rearmPromises: Array<Promise<void>> = [];
    const stop = onValue(ref(db, '.info/connected'), (snap) => {
      if (snap.val() === true) {
        rearmPromises.push(onDisconnect(ref(db, 'presence/u1')).set('offline'));
      }
    });
    expect(rearmPromises.length).toBe(0);

    sandbox.reset();
    rtdbSandbox.setDefaultPolicy(db, 'allow');
    expect(rearmPromises.length).toBe(1);
    await Promise.all(rearmPromises);

    goOffline(db);
    await Promise.resolve();
    goOnline(db);
    expect((await get(ref(db, 'presence/u1'))).val()).toBe('offline');
    stop();
  });

  it('notifies /.info root value and child_changed observers on resetAll() and stops after unsubscribe', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    const rootSeen: unknown[] = [];
    const childChanges: Array<[string | null, unknown]> = [];
    const unsubscribedSeen: unknown[] = [];

    goOffline(db);
    const stopRoot = onValue(ref(db, '.info'), (snap) => {
      rootSeen.push(snap.val());
    });
    const stopChild = onChildChanged(ref(db, '.info'), (snap) => {
      childChanges.push([snap.key, snap.val()]);
    });
    const stopEarly = onValue(ref(db, '.info/connected'), (snap) => {
      unsubscribedSeen.push(snap.val());
    });
    stopEarly();

    expect(rootSeen).toEqual([{ connected: false, serverTimeOffset: 0 }]);
    expect(childChanges).toEqual([]);
    expect(unsubscribedSeen).toEqual([false]);

    await sandbox.resetAll();

    expect(rootSeen).toEqual([
      { connected: false, serverTimeOffset: 0 },
      { connected: true, serverTimeOffset: 0 },
    ]);
    expect(childChanges).toEqual([['connected', true]]);
    expect(unsubscribedSeen).toEqual([false]);

    stopRoot();
    stopChild();
  });

  it('notifies /.info/connected observers when snapshot restore resets the RTDB state', () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    const seen: unknown[] = [];

    goOffline(db);
    const stop = onValue(ref(db, '.info/connected'), (snap) => {
      seen.push(snap.val());
    });
    expect(seen).toEqual([false]);

    sandbox.loadSnapshot({
      firestore: {},
      services: {
        rtdb: {
          '.pyricRtdbPersistence': 1,
          data: { restored: true },
          priorities: {},
          rules: { rules: { '.read': true, '.write': true } },
        },
      },
    });
    expect(seen).toEqual([false, true]);
    stop();
  });

  it('preserves onDisconnect queued inside a data listener during loadSnapshot restore', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    rtdbSandbox.setDefaultPolicy(db, 'allow');

    const queued: Array<Promise<void>> = [];
    const stopRoom = onValue(ref(db, 'room'), (snap) => {
      if (snap.val() === 'restored') {
        queued.push(onDisconnect(ref(db, 'presence/from-data-listener')).set('gone'));
      }
    });

    await sandbox.loadSnapshot({
      firestore: {},
      services: {
        rtdb: {
          '.pyricRtdbPersistence': 1,
          data: { room: 'restored' },
          priorities: {},
          rules: { rules: { '.read': true, '.write': true } },
        },
      },
    });
    expect(queued).toHaveLength(1);
    await Promise.all(queued);

    goOffline(db);
    await Promise.resolve();
    goOnline(db);
    expect((await get(ref(db, 'presence/from-data-listener'))).val()).toBe('gone');

    stopRoom();
  });
});
