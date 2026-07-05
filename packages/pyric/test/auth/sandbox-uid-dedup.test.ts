/**
 * uid-keyed notification semantics — sandbox target. Locks AUTH-B7 + B8.
 *
 * Mirrors upstream `notifyAuthListeners` (`auth_impl.ts:714-723`):
 *   - `onIdTokenChanged` fires on EVERY identity update — including a
 *     same-uid re-sign-in, which mints a fresh token (AUTH-B8);
 *   - `onAuthStateChanged` fires ONLY when the uid changes vs the last
 *     notification — a same-uid profile-shape change does NOT re-fire it
 *     (AUTH-B7).
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAuth,
  onAuthStateChanged,
  onIdTokenChanged,
  sandbox as authSandbox,
  signInWithEmailAndPassword,
  type User,
} from '../../src/auth/index.js';

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function user(uid: string, displayName: string | null): User {
  return {
    uid,
    email: `${uid}@example.com`,
    displayName,
    isAnonymous: false,
    getIdToken: async () => `t-${uid}`,
    getIdTokenResult: async () => ({
      token: `t-${uid}`,
      claims: {},
      expirationTime: '',
      issuedAtTime: '',
      authTime: '',
    }),
  };
}

describe('uid-keyed notification (AUTH-B7 / B8)', () => {
  it('AUTH-B7: a same-uid profile-shape change does NOT re-fire onAuthStateChanged', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setUser(auth, user('u1', 'Name A'));
    const authStateSeen: Array<User | null> = [];
    onAuthStateChanged(auth, (u) => { authStateSeen.push(u); });
    await flush();
    expect(authStateSeen.length).toBe(1); // initial fire (u1)
    // Same uid, different displayName — a profile-shape change.
    authSandbox.setUser(auth, user('u1', 'Name B'));
    await flush();
    expect(authStateSeen.length).toBe(1); // NOT re-fired — uid unchanged
  });

  it('AUTH-B7: same-uid profile change DOES fire onIdTokenChanged', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.setUser(auth, user('u2', 'Name A'));
    const idTokenSeen: Array<User | null> = [];
    onIdTokenChanged(auth, (u) => { idTokenSeen.push(u); });
    await flush();
    expect(idTokenSeen.length).toBe(1); // initial
    authSandbox.setUser(auth, user('u2', 'Name B'));
    await flush();
    expect(idTokenSeen.length).toBe(2); // id-token fires on the update
  });

  it('AUTH-B8: same-uid re-sign-in fires onIdTokenChanged with a fresh token', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [
      { uid: 'alice', email: 'alice@example.com', password: 'pw1' },
    ]);
    await signInWithEmailAndPassword(auth, 'alice@example.com', 'pw1');
    const token1 = await auth.currentUser!.getIdToken();
    const idTokenSeen: Array<User | null> = [];
    onIdTokenChanged(auth, (u) => { idTokenSeen.push(u); });
    await flush();
    expect(idTokenSeen.length).toBe(1); // initial
    // Re-sign-in the SAME user without signing out first.
    await signInWithEmailAndPassword(auth, 'alice@example.com', 'pw1');
    await flush();
    expect(idTokenSeen.length).toBe(2); // id-token re-fires (AUTH-B8)
    const token2 = await auth.currentUser!.getIdToken();
    expect(token2).not.toBe(token1); // fresh token minted on re-sign-in
  });

  it('AUTH-B8: same-uid re-sign-in does NOT re-fire onAuthStateChanged', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [
      { uid: 'bob', email: 'bob@example.com', password: 'pw1' },
    ]);
    await signInWithEmailAndPassword(auth, 'bob@example.com', 'pw1');
    const authStateSeen: Array<User | null> = [];
    onAuthStateChanged(auth, (u) => { authStateSeen.push(u); });
    await flush();
    expect(authStateSeen.length).toBe(1); // initial
    await signInWithEmailAndPassword(auth, 'bob@example.com', 'pw1');
    await flush();
    expect(authStateSeen.length).toBe(1); // uid unchanged → no re-fire
  });
});
