/**
 * Listener semantics — sandbox target.
 *
 * Verifies:
 *   - `onAuthStateChanged` fires *immediately* on subscribe with
 *     current state (via microtask — async observability).
 *   - Subsequent sign-in / sign-out delivers updates to every
 *     subscriber.
 *   - Observer object form (`{next, error, complete}`) works
 *     alongside the function form.
 *   - Unsubscribing mid-emission does NOT skip remaining subscribers.
 *   - `onIdTokenChanged` fires on user change (sandbox divergence:
 *     does NOT fire on token refresh, because there are no token
 *     refreshes on sandbox).
 *   - Setting the same user twice is a no-op (no double-fire).
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAuth,
  onAuthStateChanged,
  onIdTokenChanged,
  sandbox as authSandbox,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from '../../src/auth/index.js';

/** Wait one microtask + macrotask so initial-fire microtasks settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe('onAuthStateChanged (sandbox)', () => {
  it('fires immediately on subscribe with current state (null)', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const seen: Array<User | null> = [];
    onAuthStateChanged(auth, (u) => { seen.push(u); });
    await flush();
    expect(seen).toEqual([null]);
  });

  it('fires immediately on subscribe with current user', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);
    const seen: Array<User | null> = [];
    onAuthStateChanged(auth, (u) => { seen.push(u); });
    await flush();
    expect(seen.length).toBe(1);
    expect(seen[0]?.isAnonymous).toBe(true);
  });

  it('fires on subsequent sign-in / sign-out', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const seen: Array<User | null> = [];
    onAuthStateChanged(auth, (u) => { seen.push(u); });
    await flush(); // initial: null
    await signInAnonymously(auth);
    await signOut(auth);
    expect(seen.length).toBe(3);
    expect(seen[0]).toBe(null);
    expect(seen[1]?.isAnonymous).toBe(true);
    expect(seen[2]).toBe(null);
  });

  it('observer object form works', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const seen: Array<User | null> = [];
    onAuthStateChanged(auth, { next: (u) => { seen.push(u); } });
    await flush();
    await signInAnonymously(auth);
    expect(seen.length).toBe(2);
    expect(seen[1]?.isAnonymous).toBe(true);
  });

  it('multiple subscribers all fire', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const a: Array<User | null> = [];
    const b: Array<User | null> = [];
    onAuthStateChanged(auth, (u) => { a.push(u); });
    onAuthStateChanged(auth, (u) => { b.push(u); });
    await flush();
    await signInAnonymously(auth);
    expect(a.length).toBe(2);
    expect(b.length).toBe(2);
  });

  it('unsubscribe stops emissions', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const seen: Array<User | null> = [];
    const unsub = onAuthStateChanged(auth, (u) => { seen.push(u); });
    await flush();
    unsub();
    await signInAnonymously(auth);
    await signOut(auth);
    expect(seen).toEqual([null]); // only the initial fire
  });

  it('unsubscribing during emission does not skip remaining subscribers', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const seen: number[] = [];
    let unsubA = () => {};
    // Only act on the SECOND fire — skip the initial-fire microtask
    // so both A and B are still subscribed at the moment we sign in.
    let firedA = false;
    const obsA = (_u: User | null) => {
      if (!firedA) { firedA = true; return; }
      seen.push(1);
      unsubA();
    };
    let firedB = false;
    const obsB = (_u: User | null) => {
      if (!firedB) { firedB = true; return; }
      seen.push(2);
    };
    unsubA = onAuthStateChanged(auth, obsA);
    onAuthStateChanged(auth, obsB);
    await flush(); // initial fires consume firedA / firedB
    await signInAnonymously(auth);
    expect(seen).toContain(1);
    expect(seen).toContain(2);
  });

  it('setting the same user twice does not double-fire', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [
      { uid: 'alice', email: 'a@example.com', password: 'pw' },
    ]);
    const seen: Array<User | null> = [];
    onAuthStateChanged(auth, (u) => { seen.push(u); });
    await flush();
    await signInWithEmailAndPassword(auth, 'a@example.com', 'pw');
    const lenAfterFirst = seen.length;
    // Re-sign-in with the same uid + claims — sandbox no-ops.
    await signInWithEmailAndPassword(auth, 'a@example.com', 'pw');
    expect(seen.length).toBe(lenAfterFirst);
  });

  it('a throwing observer does not block other observers', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const seenB: Array<User | null> = [];
    onAuthStateChanged(auth, () => { throw new Error('boom'); });
    onAuthStateChanged(auth, (u) => { seenB.push(u); });
    await flush();
    await signInAnonymously(auth);
    expect(seenB.length).toBe(2);
  });

  it('does NOT double-fire when sign-in happens synchronously after subscribe', async () => {
    // The mount-time-useEffect pattern in app code:
    //   onAuthStateChanged(auth, fn);
    //   signInAnonymously(auth);
    // setCurrentUser fires fanOut synchronously (1st fire); the
    // subscribe-replay microtask scheduled by onAuthStateChanged
    // would then fire the SAME value again unless we dedupe.
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const seen: Array<User | null> = [];
    onAuthStateChanged(auth, (u) => { seen.push(u); });
    await signInAnonymously(auth);
    await flush();
    expect(seen.length).toBe(1);
    expect(seen[0]?.isAnonymous).toBe(true);
  });

  it('does NOT double-fire when subscribe happens after a sync sign-in chain', async () => {
    // Slightly different ordering: signInAnonymously fires no
    // listener (nobody subscribed yet), then onAuthStateChanged
    // subscribes — the initial replay should fire ONCE with the
    // current anonymous user, not twice.
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);
    const seen: Array<User | null> = [];
    onAuthStateChanged(auth, (u) => { seen.push(u); });
    await flush();
    expect(seen.length).toBe(1);
    expect(seen[0]?.isAnonymous).toBe(true);
  });
});

describe('onIdTokenChanged (sandbox)', () => {
  it('fires on user change (sandbox: same channel as onAuthStateChanged)', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const seen: Array<User | null> = [];
    onIdTokenChanged(auth, (u) => { seen.push(u); });
    await flush();
    await signInAnonymously(auth);
    await signOut(auth);
    expect(seen.length).toBe(3);
  });

  it('fires on getIdToken(true) — forced refresh fans out to id-token listeners (matches prod)', async () => {
    // Oracle: scripts/oracle/observations/auth-onidtokenchanged-force-refresh.json
    // — prod fires onIdTokenChanged on a forced refresh; the previously-
    // documented sandbox divergence was closed in this commit.
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);
    const seen: Array<User | null> = [];
    onIdTokenChanged(auth, (u) => { seen.push(u); });
    await flush(); // initial
    expect(seen.length).toBe(1);
    await auth.currentUser!.getIdToken(true);
    expect(seen.length).toBe(2);
    expect(seen[1]?.uid).toBe(auth.currentUser!.uid);
  });
});

describe('sandbox reset clears currentUser', () => {
  it('reset emits sign-out to onAuthStateChanged', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);
    const seen: Array<User | null> = [];
    onAuthStateChanged(auth, (u) => { seen.push(u); });
    await flush();
    expect(seen.length).toBe(1);
    expect(seen[0]?.isAnonymous).toBe(true);
    sandbox.reset();
    expect(auth.currentUser).toBe(null);
    expect(seen.length).toBe(2);
    expect(seen[1]).toBe(null);
  });
});
