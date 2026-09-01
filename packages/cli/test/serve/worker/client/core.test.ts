import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  AUTH_LENS_STORAGE_KEY,
  getLens,
  hydrateLensFromStorage,
  isPersistedAuthLens,
  rpcWithTimeout,
  setLens,
  subscribeLens,
  wirePort,
} from '../../../../src/serve/worker/client/core.js';
import type { ClientPort } from '../../../../src/serve/worker/client/handles.js';
import type { AuthLens } from 'pyric/sandbox';

class MockSessionStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

describe('worker client RPC timeout', () => {
  it('rejects a bounded RPC and ignores its late response', async () => {
    const port: ClientPort = {
      onmessage: null,
      postMessage() {},
      start() {},
      close() {},
    };
    wirePort(port);

    const request = rpcWithTimeout(
      port,
      { t: 'op', id: 'slow-operation', method: 'getRuntimeEpoch' },
      5,
      'worker did not answer',
    );
    await expect(request).rejects.toThrow('worker did not answer');

    expect(() => port.onmessage?.({
      data: { t: 'res', id: 'slow-operation', ok: true, value: { version: 'late' } },
    } as MessageEvent)).not.toThrow();
  });
});

describe('worker client auth lens hydration and persistence', () => {
  const originalSessionStorage = globalThis.sessionStorage;
  let mockStorage: MockSessionStorage;

  beforeEach(() => {
    mockStorage = new MockSessionStorage();
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
    setLens(undefined);
  });

  afterEach(() => {
    setLens(undefined);
    if (originalSessionStorage !== undefined) {
      Object.defineProperty(globalThis, 'sessionStorage', {
        value: originalSessionStorage,
        writable: true,
        configurable: true,
      });
    } else {
      // @ts-expect-error cleanup global mock
      delete globalThis.sessionStorage;
    }
  });

  it('defines the canonical storage key', () => {
    expect(AUTH_LENS_STORAGE_KEY).toBe('pyric:auth-lens');
  });

  describe('setLens and persistence', () => {
    it('serializes impersonation lens with tenant and token to sessionStorage', () => {
      const lens: AuthLens = {
        mode: 'as',
        uid: 'user_alice',
        tenant: 'tenant-acme',
        token: { role: 'admin', premium: true },
      };

      setLens(lens);
      expect(getLens()).toEqual(lens);
      expect(mockStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBe(JSON.stringify(lens));
    });

    it('serializes admin bypass lens to sessionStorage', () => {
      const lens: AuthLens = { mode: 'admin' };
      setLens(lens);
      expect(getLens()).toEqual(lens);
      expect(mockStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBe(JSON.stringify(lens));
    });

    it('removes storage key when setLens is called with undefined', () => {
      setLens({ mode: 'admin' });
      expect(mockStorage.getItem(AUTH_LENS_STORAGE_KEY)).not.toBeNull();

      setLens(undefined);
      expect(getLens()).toBeUndefined();
      expect(mockStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBeNull();
    });

    it('normalizes mode: "app-session" to undefined and removes storage key', () => {
      setLens({ mode: 'as', uid: 'bob' });
      expect(mockStorage.getItem(AUTH_LENS_STORAGE_KEY)).not.toBeNull();

      setLens({ mode: 'app-session' });
      expect(getLens()).toBeUndefined();
      expect(mockStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBeNull();
    });
  });

  describe('hydrateLensFromStorage', () => {
    it('classifies only persistable admin and valid impersonation lenses', () => {
      expect(isPersistedAuthLens({ mode: 'admin' })).toBe(true);
      expect(isPersistedAuthLens({ mode: 'as', uid: 'alice' })).toBe(true);
      expect(isPersistedAuthLens({ mode: 'as' })).toBe(false);
      expect(isPersistedAuthLens({ mode: 'app-session' })).toBe(false);
      expect(isPersistedAuthLens(null)).toBe(false);
    });

    it('hydrates a valid impersonation lens with tenant from sessionStorage', () => {
      const storedLens: AuthLens = {
        mode: 'as',
        uid: 'user_42',
        tenant: 'tenant_omega',
      };
      mockStorage.setItem(AUTH_LENS_STORAGE_KEY, JSON.stringify(storedLens));

      const hydrated = hydrateLensFromStorage();
      expect(hydrated).toEqual(storedLens);
    });

    it('hydrates admin lens from sessionStorage', () => {
      mockStorage.setItem(AUTH_LENS_STORAGE_KEY, JSON.stringify({ mode: 'admin' }));
      const hydrated = hydrateLensFromStorage();
      expect(hydrated).toEqual({ mode: 'admin' });
    });

    it('returns undefined when storage key is absent', () => {
      expect(hydrateLensFromStorage()).toBeUndefined();
    });

    it('cleans up and returns undefined when storage contains invalid JSON', () => {
      mockStorage.setItem(AUTH_LENS_STORAGE_KEY, '{malformed-json: true');
      const hydrated = hydrateLensFromStorage();
      expect(hydrated).toBeUndefined();
      expect(mockStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBeNull();
    });

    it('cleans up and returns undefined when storage contains app-session mode', () => {
      mockStorage.setItem(AUTH_LENS_STORAGE_KEY, JSON.stringify({ mode: 'app-session' }));
      const hydrated = hydrateLensFromStorage();
      expect(hydrated).toBeUndefined();
      expect(mockStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBeNull();
    });

    it('cleans up and returns undefined when storage contains non-object payload', () => {
      mockStorage.setItem(AUTH_LENS_STORAGE_KEY, JSON.stringify('not-a-lens-object'));
      const hydrated = hydrateLensFromStorage();
      expect(hydrated).toBeUndefined();
      expect(mockStorage.getItem(AUTH_LENS_STORAGE_KEY)).toBeNull();
    });
  });

  describe('subscribeLens reactive notifications', () => {
    it('notifies registered listeners when setLens is called', () => {
      const calls: (AuthLens | undefined)[] = [];
      const unsubscribe = subscribeLens((lens) => {
        calls.push(lens);
      });

      expect(calls).toEqual([]);

      const userLens: AuthLens = { mode: 'as', uid: 'charlie' };
      setLens(userLens);
      expect(calls).toEqual([userLens]);

      setLens({ mode: 'admin' });
      expect(calls).toEqual([userLens, { mode: 'admin' }]);

      setLens(undefined);
      expect(calls).toEqual([userLens, { mode: 'admin' }, undefined]);

      unsubscribe();
    });

    it('stops notifications after unsubscription', () => {
      const listener = mock();
      const unsubscribe = subscribeLens(listener);

      setLens({ mode: 'admin' });
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      setLens({ mode: 'as', uid: 'dave' });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('isolates listener errors so other listeners still receive notifications', () => {
      const originalConsoleError = console.error;
      console.error = () => {};
      try {
        const failingListener = () => {
          throw new Error('Listener crash!');
        };
        const succeedingCalls: (AuthLens | undefined)[] = [];
        const succeedingListener = (lens: AuthLens | undefined) => {
          succeedingCalls.push(lens);
        };

        const unsub1 = subscribeLens(failingListener);
        const unsub2 = subscribeLens(succeedingListener);

        expect(() => {
          setLens({ mode: 'admin' });
        }).not.toThrow();

        expect(succeedingCalls).toEqual([{ mode: 'admin' }]);

        unsub1();
        unsub2();
      } finally {
        console.error = originalConsoleError;
      }
    });
  });

  describe('environment resilience', () => {
    it('gracefully handles undefined sessionStorage (Node.js/worker environment)', () => {
      // @ts-expect-error simulate Node/worker environment
      delete globalThis.sessionStorage;

      expect(typeof sessionStorage).toBe('undefined');

      // Hydration returns undefined without error
      expect(hydrateLensFromStorage()).toBeUndefined();

      // Setting lens updates in-memory lens and notifies subscribers without error
      const notifications: (AuthLens | undefined)[] = [];
      const unsub = subscribeLens((lens) => notifications.push(lens));

      expect(() => setLens({ mode: 'as', uid: 'eve', tenant: 'tenant-1' })).not.toThrow();
      expect(getLens()).toEqual({ mode: 'as', uid: 'eve', tenant: 'tenant-1' });
      expect(notifications).toEqual([{ mode: 'as', uid: 'eve', tenant: 'tenant-1' }]);

      // Clearing lens works without error
      expect(() => setLens(undefined)).not.toThrow();
      expect(getLens()).toBeUndefined();
      expect(notifications).toEqual([
        { mode: 'as', uid: 'eve', tenant: 'tenant-1' },
        undefined,
      ]);

      unsub();
    });

    it('handles throwing sessionStorage operations without crashing', () => {
      const throwingStorage = {
        getItem() {
          throw new Error('Access denied (SecurityError)');
        },
        setItem() {
          throw new Error('QuotaExceededError');
        },
        removeItem() {
          throw new Error('Storage write failed');
        },
        clear() {},
        key() { return null; },
        length: 0,
      } as Storage;

      Object.defineProperty(globalThis, 'sessionStorage', {
        value: throwingStorage,
        writable: true,
        configurable: true,
      });

      // Hydrate survives read error
      expect(hydrateLensFromStorage()).toBeUndefined();

      // setLens survives write error
      expect(() => setLens({ mode: 'admin' })).not.toThrow();
      expect(getLens()).toEqual({ mode: 'admin' });

      // setLens(undefined) survives remove error
      expect(() => setLens(undefined)).not.toThrow();
      expect(getLens()).toBeUndefined();
    });
  });

  describe('barrel re-exports', () => {
    it('re-exports lens symbols from packages/cli/src/serve/worker/client.ts', async () => {
      const clientModule = await import('../../../../src/serve/worker/client.js');
      expect(clientModule.AUTH_LENS_STORAGE_KEY).toBe('pyric:auth-lens');
      expect(typeof clientModule.setLens).toBe('function');
      expect(typeof clientModule.getLens).toBe('function');
      expect(typeof clientModule.subscribeLens).toBe('function');
      expect(typeof clientModule.hydrateLensFromStorage).toBe('function');
    });

    it('re-exports lens symbols from packages/cli/src/serve/worker/index.ts', async () => {
      const indexModule = await import('../../../../src/serve/worker/index.js');
      expect(indexModule.AUTH_LENS_STORAGE_KEY).toBe('pyric:auth-lens');
      expect(typeof indexModule.setLens).toBe('function');
      expect(typeof indexModule.getLens).toBe('function');
      expect(typeof indexModule.subscribeLens).toBe('function');
      expect(typeof indexModule.hydrateLensFromStorage).toBe('function');
    });
  });
});
