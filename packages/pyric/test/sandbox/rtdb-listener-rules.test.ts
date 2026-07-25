import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import type { SandboxEvent, SandboxListenerEvent } from 'pyric/sandbox';
import { getAdminDatabase, getDatabase, onValue, ref as dbRef, sandbox as rtdbSandbox, set } from '../../src/database/index.js';

function listeners(events: SandboxEvent[]): SandboxListenerEvent[] {
  return events.filter((e): e is SandboxListenerEvent => e.kind === 'listener');
}

describe('rtdb listener security rules diagnostics', () => {
  it('emits rtdb.listener errored events with rich rules evaluation traces when read is denied on attach', async () => {
    const sandbox = initializeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    const db = getDatabase(sandbox.withAuth({ uid: 'bob' }));
    rtdbSandbox.setRules(db, {
      rules: {
        private: {
          '.read': 'auth != null && auth.uid == "alice"',
          '.write': 'auth != null && auth.uid == "alice"',
        },
      },
    });

    let permissionError: Error | null = null;
    try {
      onValue(
        dbRef(db, 'private/item'),
        () => {},
        (err) => { permissionError = err; },
      );
    } catch (err) {
      permissionError = err instanceof Error ? err : new Error(String(err));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(permissionError).toBeDefined();
    const errMsg = permissionError?.message ?? '';
    expect(errMsg.toLowerCase()).toContain('permission_denied');

    const erroredListener = listeners(events).find(
      (e) => e.service === 'rtdb' && e.phase === 'errored' && e.target.path === '/private/item',
    );
    expect(erroredListener).toBeDefined();
    expect(erroredListener?.result).toBe('deny');
    expect(erroredListener?.rules).toBeDefined();
    expect(erroredListener?.rules?.engine).toBe('rtdb');
    expect(erroredListener?.reasons).toBeDefined();
    expect((erroredListener?.reasons?.length ?? 0)).toBeGreaterThan(0);
  });

  it('emits rtdb.listener errored events with rich rules evaluation traces when an existing listener is canceled by rules re-evaluation', async () => {
    const sandbox = initializeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    const db = getDatabase(sandbox.withAuth({ uid: 'bob' }));
    rtdbSandbox.setRules(db, {
      rules: {
        rooms: {
          '$roomId': {
            '.read': 'auth != null',
            '.write': 'auth != null',
          },
        },
      },
    });

    const adminDb = getAdminDatabase(sandbox);
    await set(dbRef(adminDb, 'rooms/room1'), { owner: 'bob', name: 'Bob Room' });

    let permissionError: Error | null = null;
    let receivedVal: unknown = null;
    onValue(
      dbRef(db, 'rooms/room1'),
      (snap) => { receivedVal = snap.val(); },
      (err) => { permissionError = err; },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(receivedVal).toEqual({ owner: 'bob', name: 'Bob Room' });
    expect(permissionError).toBeNull();

    events.length = 0; // clear initial events

    rtdbSandbox.setRules(db, {
      rules: {
        rooms: {
          '$roomId': {
            '.read': 'auth != null && auth.uid == "alice"',
            '.write': 'auth != null && auth.uid == "alice"',
          },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(permissionError).toBeDefined();
    const errMsg = permissionError?.message ?? '';
    expect(errMsg.toLowerCase()).toContain('permission_denied');

    const erroredListener = listeners(events).find(
      (e) => e.service === 'rtdb' && e.phase === 'errored' && e.target.path === '/rooms/room1',
    );
    expect(erroredListener).toBeDefined();
    expect(erroredListener?.result).toBe('deny');
    expect(erroredListener?.rules).toBeDefined();
    expect(erroredListener?.rules?.engine).toBe('rtdb');
    expect(erroredListener?.reasons).toBeDefined();
    expect((erroredListener?.reasons?.length ?? 0)).toBeGreaterThan(0);
  });
});
