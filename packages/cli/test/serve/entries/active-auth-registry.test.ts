import { describe, expect, it, mock } from 'bun:test';
import { createActiveAuthRegistry } from '../../../src/serve/entries/active-auth-registry.js';

interface TestAuth {
  currentUser: { uid: string } | null;
}

describe('active-auth-registry', () => {
  it('observes a repeated auth handle once and releases it after every owner leaves', () => {
    const observers = new Map<TestAuth, (user: TestAuth['currentUser']) => void>();
    const unsubscribe = mock(() => {});
    const observe = mock((auth: TestAuth, listener: (user: TestAuth['currentUser']) => void) => {
      observers.set(auth, listener);
      return unsubscribe;
    });
    const registry = createActiveAuthRegistry(observe);
    const auth: TestAuth = { currentUser: null };

    const releaseFirst = registry.register(auth);
    const releaseSecond = registry.register(auth);

    expect(observe).toHaveBeenCalledTimes(1);
    expect([...registry.auths()]).toEqual([auth]);

    releaseFirst();
    expect(unsubscribe).not.toHaveBeenCalled();
    expect([...registry.auths()]).toEqual([auth]);

    releaseSecond();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect([...registry.auths()]).toEqual([]);
  });

  it('fans each auth transition out once and seeds subscribers from the active user', () => {
    const observers = new Map<TestAuth, (user: TestAuth['currentUser']) => void>();
    const registry = createActiveAuthRegistry((auth: TestAuth, listener: (user: TestAuth['currentUser']) => void) => {
      observers.set(auth, listener);
      return () => observers.delete(auth);
    });
    const auth: TestAuth = { currentUser: { uid: 'alice' } };
    registry.register(auth);
    const listener = mock(() => {});

    registry.subscribe(listener);
    observers.get(auth)?.({ uid: 'bob' });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0]?.[0]).toEqual({ uid: 'alice' });
    expect(listener.mock.calls[1]?.[0]).toEqual({ uid: 'bob' });
  });
});
