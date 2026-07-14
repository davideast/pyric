/**
 * `beforeAuthStateChanged` — sandbox target.
 *
 * `beforeAuthStateChanged(auth, callback, onAbort?)` registers a
 * BLOCKING gate that runs before a real sign-in/sign-out transition
 * commits (mirrors `firebase/auth`'s `AuthMiddlewareQueue.runMiddleware`,
 * `auth_impl.ts`):
 *   - callbacks run in registration order;
 *   - if a callback throws (or its returned promise rejects), the
 *     transition is ABORTED — the `signInWith…` / `signOut` call
 *     rejects with `auth/login-blocked`, `currentUser` is left
 *     unchanged, and `onAuthStateChanged` / `onIdTokenChanged` do NOT
 *     fire;
 *   - every `onAbort` registered by a callback that already ran
 *     successfully in the SAME pass runs (in reverse registration
 *     order) so side effects can be undone;
 *   - fires for both directions: sign-in (`nextUser` non-null) and
 *     sign-out (`nextUser === null`).
 *
 * Covers the sign-in paths that exist in `pyric/auth` today:
 * `signInAnonymously`, `signInWithEmailAndPassword`,
 * `createUserWithEmailAndPassword`, `signInWithCustomToken`, and `signOut`.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  beforeAuthStateChanged,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sandbox as authSandbox,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from '../../src/auth/index.js';

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe('beforeAuthStateChanged (sandbox)', () => {
  it('an allowing callback lets sign-in proceed and fires onAuthStateChanged', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const seen: Array<User | null> = [];
    onAuthStateChanged(auth, (u) => { seen.push(u); });
    await flush();

    const gated: Array<User | null> = [];
    beforeAuthStateChanged(auth, (u) => { gated.push(u); });

    const cred = await signInAnonymously(auth);

    expect(gated).toEqual([cred.user]);
    expect(auth.currentUser?.uid).toBe(cred.user.uid);
    await flush();
    expect(seen.length).toBe(2);
    expect(seen[1]?.uid).toBe(cred.user.uid);
  });

  it('a throwing callback aborts sign-in: rejects, currentUser unchanged, onAuthStateChanged does not fire', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const seen: Array<User | null> = [];
    onAuthStateChanged(auth, (u) => { seen.push(u); });
    await flush();
    expect(seen).toEqual([null]);

    beforeAuthStateChanged(auth, () => {
      throw new Error('blocked: fails client-side gate');
    });

    await expect(signInAnonymously(auth)).rejects.toMatchObject({
      code: 'auth/login-blocked',
    });

    expect(auth.currentUser).toBeNull();
    await flush();
    // No second fire — the transition never committed.
    expect(seen).toEqual([null]);
  });

  it('a rejecting async callback also aborts sign-in', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);

    beforeAuthStateChanged(auth, async () => {
      throw new Error('async block');
    });

    await expect(signInAnonymously(auth)).rejects.toMatchObject({
      code: 'auth/login-blocked',
    });
    expect(auth.currentUser).toBeNull();
  });

  it('registration order is preserved across multiple callbacks (all must pass)', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const order: string[] = [];

    beforeAuthStateChanged(auth, () => { order.push('first'); });
    beforeAuthStateChanged(auth, () => { order.push('second'); });
    beforeAuthStateChanged(auth, () => { order.push('third'); });

    await signInAnonymously(auth);

    expect(order).toEqual(['first', 'second', 'third']);
    expect(auth.currentUser).not.toBeNull();
  });

  it('multiple callbacks: if one blocks, none of the LATER callbacks run and the transition aborts', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const order: string[] = [];

    beforeAuthStateChanged(auth, () => { order.push('first'); });
    beforeAuthStateChanged(auth, () => {
      order.push('second');
      throw new Error('nope');
    });
    beforeAuthStateChanged(auth, () => { order.push('third'); });

    await expect(signInAnonymously(auth)).rejects.toMatchObject({
      code: 'auth/login-blocked',
    });

    expect(order).toEqual(['first', 'second']);
    expect(auth.currentUser).toBeNull();
  });

  it('onAbort runs (in reverse order) for callbacks that already succeeded when a later one blocks', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const aborted: string[] = [];

    beforeAuthStateChanged(
      auth,
      () => {},
      () => { aborted.push('first-abort'); },
    );
    beforeAuthStateChanged(
      auth,
      () => {},
      () => { aborted.push('second-abort'); },
    );
    beforeAuthStateChanged(auth, () => {
      throw new Error('blocks after two successes');
    });

    await expect(signInAnonymously(auth)).rejects.toMatchObject({
      code: 'auth/login-blocked',
    });

    // Reverse registration order — matches upstream's rollback stack.
    expect(aborted).toEqual(['second-abort', 'first-abort']);
  });

  it('a callback whose own onAbort throws does not mask the original block, and other onAborts still run', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const aborted: string[] = [];

    beforeAuthStateChanged(
      auth,
      () => {},
      () => { aborted.push('ok-abort'); },
    );
    beforeAuthStateChanged(
      auth,
      () => {},
      () => { throw new Error('onAbort itself throws'); },
    );
    beforeAuthStateChanged(auth, () => {
      throw new Error('block');
    });

    await expect(signInAnonymously(auth)).rejects.toMatchObject({
      code: 'auth/login-blocked',
    });
    expect(aborted).toEqual(['ok-abort']);
  });

  it('unsubscribe stops a callback from gating later transitions', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    let calls = 0;
    const unsubscribe = beforeAuthStateChanged(auth, () => { calls++; });

    await signInAnonymously(auth);
    expect(calls).toBe(1);

    unsubscribe();
    await signOut(auth);
    await signInAnonymously(auth);
    expect(calls).toBe(1);
  });

  it('covers signInWithEmailAndPassword', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [
      { uid: 'alice', email: 'alice@example.com', password: 'pw1' },
    ]);

    const allow: Array<User | null> = [];
    beforeAuthStateChanged(auth, (u) => { allow.push(u); });
    const cred = await signInWithEmailAndPassword(auth, 'alice@example.com', 'pw1');
    expect(allow).toEqual([cred.user]);
    expect(auth.currentUser?.uid).toBe('alice');
  });

  it('blocks signInWithEmailAndPassword when the callback throws', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [
      { uid: 'alice', email: 'alice@example.com', password: 'pw1' },
    ]);

    beforeAuthStateChanged(auth, () => {
      throw new Error('gate rejects alice');
    });

    await expect(
      signInWithEmailAndPassword(auth, 'alice@example.com', 'pw1'),
    ).rejects.toMatchObject({ code: 'auth/login-blocked' });
    expect(auth.currentUser).toBeNull();
  });

  it('blocks createUserWithEmailAndPassword when the callback throws (account is still created, just not signed in)', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);

    const unsubscribe = beforeAuthStateChanged(auth, () => {
      throw new Error('gate rejects new account');
    });

    await expect(
      createUserWithEmailAndPassword(auth, 'bob@example.com', 'password123'),
    ).rejects.toMatchObject({ code: 'auth/login-blocked' });
    expect(auth.currentUser).toBeNull();
    unsubscribe();

    // The account itself was created (matches prod: account creation is
    // already committed server-side before the local middleware gate
    // runs) — a retry sign-in for the same identity now succeeds.
    const cred = await signInWithEmailAndPassword(auth, 'bob@example.com', 'password123');
    expect(cred.user.email).toBe('bob@example.com');
  });

  it('fires on sign-out too, and a throwing callback blocks the sign-out', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);
    expect(auth.currentUser).not.toBeNull();

    const seenOnSignOut: Array<User | null> = [];
    beforeAuthStateChanged(auth, (u) => {
      seenOnSignOut.push(u);
      if (seenOnSignOut.length === 1) throw new Error('block sign-out');
    });

    await expect(signOut(auth)).rejects.toMatchObject({ code: 'auth/login-blocked' });
    expect(seenOnSignOut).toEqual([null]);
    expect(auth.currentUser).not.toBeNull();
  });

  it('sandbox.setUser test driver bypasses the gate (documented divergence — no prod analog)', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    let calls = 0;
    beforeAuthStateChanged(auth, () => { calls++; throw new Error('should not matter'); });

    authSandbox.setUser(auth, { uid: 'forced', isAnonymous: true } as User);
    expect(calls).toBe(0);
    expect(auth.currentUser?.uid).toBe('forced');
  });
});
