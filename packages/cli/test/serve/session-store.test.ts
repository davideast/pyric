/** Auth session store — setPersistence-parity logic (pyric-persist 2.1/2.3).
 *  Pure over injected storages; the restore wiring is the browser gate. */
import { describe, expect, it } from 'bun:test';
import { SessionStore, type SessionStores } from '../../src/serve/entries/session-store.js';

function fakeStorage(): SessionStores['local'] & { dump(): Record<string, string> } {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

function wire() {
  const local = fakeStorage();
  const session = fakeStorage();
  return { store: new SessionStore({ local, session }), local, session };
}

describe('SessionStore', () => {
  it('defaults to LOCAL (firebase default): saves to localStorage, survives "reload"', () => {
    const { store, local, session } = wire();
    store.save('u1');
    expect(Object.keys(local.dump())).toHaveLength(1);
    expect(Object.keys(session.dump())).toHaveLength(0);
    // a "new page" with the same storages sees the session
    const reloaded = new SessionStore({ local, session });
    expect(reloaded.load()?.uid).toBe('u1');
  });

  it('SESSION mode uses sessionStorage; switching modes MIGRATES the session', () => {
    const { store, local, session } = wire();
    store.save('u1');
    store.setMode('SESSION'); // setPersistence(browserSessionPersistence)
    expect(Object.keys(local.dump())).toHaveLength(0);
    expect(session.dump()).not.toEqual({});
    expect(store.load()?.uid).toBe('u1'); // carried over, like the real SDK
  });

  it('NONE stores nothing and drops the current session; signOut clears', () => {
    const { store, local, session } = wire();
    store.save('u1');
    store.setMode('NONE'); // setPersistence(inMemoryPersistence)
    expect(local.dump()).toEqual({});
    expect(session.dump()).toEqual({});
    expect(store.load()).toBeNull();
    store.save('u2'); // still NONE — nothing lands
    expect(store.load()).toBeNull();

    const { store: s2 } = wire();
    s2.save('u3');
    s2.clear();
    expect(s2.load()).toBeNull();
  });

  it('corrupt stored JSON is dropped silently (never throws at page init)', () => {
    const { local, session } = wire();
    local.setItem('pyric:serve:auth-session', '{nope');
    const store = new SessionStore({ local, session });
    expect(store.load()).toBeNull();
    expect(local.dump()).toEqual({}); // cleaned up
  });
});
