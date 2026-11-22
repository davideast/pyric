/**
 * Regression tests for `#1954`: `reload(user)` notifies `onIdTokenChanged`
 * once when `user` is the current user, without re-firing `onAuthStateChanged`
 * or notifying for non-current held users.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAuth,
  onAuthStateChanged,
  onIdTokenChanged,
  reload,
  sandbox as authSandbox,
  signInWithEmailAndPassword,
  signOut,
} from '../../src/auth/index.js';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('reload(user) listener notifications (#1954)', () => {
  it('notifies onIdTokenChanged once for the current user and does not re-fire onAuthStateChanged', async () => {
    const sandbox = initializeSandbox();
    try {
      const auth = getAuth(sandbox);
      authSandbox.createUser(auth, {
        uid: 'alice',
        email: 'alice@example.com',
        password: 'password123',
        displayName: 'Alice Before',
        emailVerified: false,
      });
      const { user } = await signInWithEmailAndPassword(auth, 'alice@example.com', 'password123');

      const idTokenObserved: Array<{ uid: string | null; displayName: string | null; verified: boolean }> = [];
      const authStateObserved: Array<string | null> = [];
      const unsubIdToken = onIdTokenChanged(auth, (current) => {
        idTokenObserved.push({
          uid: current?.uid ?? null,
          displayName: current?.displayName ?? null,
          verified: current?.emailVerified ?? false,
        });
      });
      const unsubAuthState = onAuthStateChanged(auth, (current) => {
        authStateObserved.push(current?.uid ?? null);
      });
      await flushMicrotasks();

      expect(idTokenObserved).toHaveLength(1);
      expect(authStateObserved).toHaveLength(1);
      idTokenObserved.length = 0;
      authStateObserved.length = 0;

      authSandbox.updateUser(auth, 'alice', {
        displayName: 'Alice After',
        emailVerified: true,
      });

      await reload(user);
      await flushMicrotasks();

      expect(idTokenObserved).toEqual([
        { uid: 'alice', displayName: 'Alice After', verified: true },
      ]);
      expect(authStateObserved).toEqual([]);

      unsubIdToken();
      unsubAuthState();
    } finally {
      sandbox.dispose();
    }
  });

  it('does not notify onIdTokenChanged when reloading a non-current held user', async () => {
    const sandbox = initializeSandbox();
    try {
      const auth = getAuth(sandbox);
      authSandbox.createUser(auth, {
        uid: 'user-a',
        email: 'a@example.com',
        password: 'password123',
        displayName: 'User A',
      });
      authSandbox.createUser(auth, {
        uid: 'user-b',
        email: 'b@example.com',
        password: 'password123',
        displayName: 'User B',
      });

      const credA = await signInWithEmailAndPassword(auth, 'a@example.com', 'password123');
      await signInWithEmailAndPassword(auth, 'b@example.com', 'password123');

      const idTokenEvents: Array<string | null> = [];
      const unsub = onIdTokenChanged(auth, (current) => {
        idTokenEvents.push(current?.uid ?? null);
      });
      await flushMicrotasks();
      idTokenEvents.length = 0;

      authSandbox.updateUser(auth, 'user-a', { displayName: 'User A Updated' });
      await reload(credA.user);
      await flushMicrotasks();

      expect(credA.user.displayName).toBe('User A Updated');
      expect(idTokenEvents).toEqual([]);

      // Also verify after signing out completely.
      await signOut(auth);
      await flushMicrotasks();
      idTokenEvents.length = 0;

      authSandbox.updateUser(auth, 'user-a', { displayName: 'User A After SignOut' });
      await reload(credA.user);
      await flushMicrotasks();

      expect(credA.user.displayName).toBe('User A After SignOut');
      expect(idTokenEvents).toEqual([]);

      unsub();
    } finally {
      sandbox.dispose();
    }
  });

  it('signs out and fires null listeners without a spurious non-null idToken event when reload fails for disabled/deleted user', async () => {
    const sandbox = initializeSandbox();
    try {
      const auth = getAuth(sandbox);
      authSandbox.createUser(auth, {
        uid: 'disabled-u',
        email: 'disabled@example.com',
        password: 'password123',
      });
      const { user } = await signInWithEmailAndPassword(auth, 'disabled@example.com', 'password123');

      const idTokenEvents: Array<string | null> = [];
      const authStateEvents: Array<string | null> = [];
      const unsubId = onIdTokenChanged(auth, (current) => {
        idTokenEvents.push(current?.uid ?? null);
      });
      const unsubAuth = onAuthStateChanged(auth, (current) => {
        authStateEvents.push(current?.uid ?? null);
      });
      await flushMicrotasks();
      idTokenEvents.length = 0;
      authStateEvents.length = 0;

      authSandbox.updateUser(auth, 'disabled-u', { disabled: true });
      await expect(reload(user)).rejects.toMatchObject({ code: 'auth/user-disabled' });
      await flushMicrotasks();

      expect(auth.currentUser).toBeNull();
      expect(idTokenEvents).toEqual([null]);
      expect(authStateEvents).toEqual([null]);

      unsubId();
      unsubAuth();
    } finally {
      sandbox.dispose();
    }
  });
});
