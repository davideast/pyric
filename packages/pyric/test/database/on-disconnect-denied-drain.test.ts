import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  get,
  goOffline,
  goOnline,
  onChildAdded,
  onDisconnect,
  onValue,
  ref,
  sandbox as rtdbSandbox,
} from '../../src/database/index.js';

describe('onDisconnect execution-time rules denial', () => {
  it('does not emit speculative listener events when a queued onDisconnect write is denied at disconnect time', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    const observer = getDatabase(sandbox.withAuth({ uid: 'observer' }));
    rtdbSandbox.setRules(db, {
      rules: {
        '.read': true,
        docs: { '.write': true },
        drainControl: { '.write': true },
      },
    });
    const added: string[] = [];
    const observerAdded: string[] = [];
    const values: unknown[] = [];
    const stopAdded = onChildAdded(ref(db, 'docs'), (snap) => {
      if (snap.key !== null) added.push(snap.key);
    });
    const stopObserverAdded = onChildAdded(ref(observer, 'docs'), (snap) => {
      if (snap.key !== null) observerAdded.push(snap.key);
    });
    const stopValue = onValue(ref(db, 'docs'), (snap) => {
      values.push(snap.val());
    });
    await onDisconnect(ref(db, 'docs/d1')).set({ a: 'hello', '.priority': 5 });
    await onDisconnect(ref(db, 'drainControl')).set('drained');
    rtdbSandbox.setRules(db, {
      rules: {
        '.read': true,
        docs: { '.write': false },
        drainControl: { '.write': true },
      },
    });

    goOffline(db);
    expect((await get(ref(observer, 'drainControl'))).val()).toBe('drained');
    expect((await get(ref(observer, 'docs'))).val()).toBeNull();
    expect(added).toEqual([]);
    expect(observerAdded).toEqual([]);
    expect(values).toEqual([null]);

    goOnline(db);
    expect((await get(ref(db, 'drainControl'))).val()).toBe('drained');
    expect((await get(ref(db, 'docs'))).val()).toBeNull();
    expect(added).toEqual([]);
    expect(observerAdded).toEqual([]);
    expect(values).toEqual([null]);

    stopAdded();
    stopObserverAdded();
    stopValue();
  });
});
