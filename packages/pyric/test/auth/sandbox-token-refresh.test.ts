/**
 * Token refresh + onIdTokenChanged fan-out — sandbox target.
 *
 * Closes the COMPAT.md #55 (forceRefresh new-token) and #39
 * (onIdTokenChanged fires on refresh) divergences.
 *
 * Spec is the prod oracle:
 *   - scripts/oracle/observations/auth-getidtoken-force-refresh.json
 *     `token0 !== token1`, `token1 === token2` — forceRefresh mints a
 *     new string; a subsequent getIdToken(false) returns the cached
 *     new token, not yet another fresh one.
 *   - scripts/oracle/observations/auth-onidtokenchanged-force-refresh.json
 *     `firesAfterRefresh > firesAfterSignIn` — the listener fires on
 *     a forced refresh in addition to identity transitions.
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

describe('getIdToken(forceRefresh) — sandbox', () => {
  it('returns a NEW token string on forceRefresh=true', async () => {
    // Mirrors `auth-getidtoken-force-refresh.json` row
    // `token0EqualsToken1: false`.
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);
    const user = auth.currentUser!;
    const token0 = await user.getIdToken();
    const token1 = await user.getIdToken(true);
    expect(token0).not.toBe(token1);
    expect(token1.startsWith('sandbox-id-token-')).toBe(true);
    expect(token1).toContain(user.uid);
  });

  it('caches the refreshed token — subsequent getIdToken(false) returns the new token', async () => {
    // Mirrors `auth-getidtoken-force-refresh.json` row
    // `token1EqualsToken2: true`.
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);
    const user = auth.currentUser!;
    await user.getIdToken();
    const refreshed = await user.getIdToken(true);
    const cached = await user.getIdToken(false);
    expect(cached).toBe(refreshed);
  });

  it('token is stable across multiple non-forced reads', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);
    const user = auth.currentUser!;
    const a = await user.getIdToken();
    const b = await user.getIdToken();
    const c = await user.getIdToken(false);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('two refreshes mint two distinct tokens', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);
    const user = auth.currentUser!;
    const t1 = await user.getIdToken(true);
    const t2 = await user.getIdToken(true);
    expect(t1).not.toBe(t2);
  });

  it('getIdTokenResult(true) returns a refreshed result with the new token', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [
      { uid: 'alice', email: 'a@example.com', password: 'pw', customClaims: { role: 'admin' } },
    ]);
    await signInWithEmailAndPassword(auth, 'a@example.com', 'pw');
    const user = auth.currentUser!;
    const r0 = await user.getIdTokenResult();
    const r1 = await user.getIdTokenResult(true);
    expect(r1.token).not.toBe(r0.token);
    // Custom claims survive a refresh.
    expect(r1.claims['role']).toBe('admin');
    // Subsequent non-forced read returns the cached result.
    const r2 = await user.getIdTokenResult(false);
    expect(r2.token).toBe(r1.token);
  });

  it('re-sign-in after signOut mints a fresh token for the same uid', async () => {
    // Prod's "new session = new token" — closing the cache on
    // signOut means the next sign-in for the same uid does not
    // serve a stale token.
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [
      { uid: 'alice', email: 'a@example.com', password: 'pw' },
    ]);
    await signInWithEmailAndPassword(auth, 'a@example.com', 'pw');
    const firstSessionToken = await auth.currentUser!.getIdToken();
    await signOut(auth);
    await signInWithEmailAndPassword(auth, 'a@example.com', 'pw');
    const secondSessionToken = await auth.currentUser!.getIdToken();
    expect(secondSessionToken).not.toBe(firstSessionToken);
  });
});

describe('token string is sensitive to claims, not just the mint serial', () => {
  // `sandboxTokenFor(uid, claims, serial)` hashes claims + serial; every
  // adversarial-review test elsewhere compares tokens ACROSS mints
  // (refresh, re-sign-in), where the monotonic serial always advances
  // too — so a mutant that dropped `claims` from the hash and hashed
  // only `uid + serial` would still pass every one of those. Isolate
  // the claims effect by holding uid AND serial fixed: two freshly
  // initialized sandboxes each have their own independent
  // `nextTokenSerial` counter starting at 1, so the FIRST `getIdToken()`
  // call in each (the first cache-miss mint) lands on serial 1. Seed
  // the SAME uid with DIFFERENT customClaims in each sandbox and take
  // that first token — uid and serial are pinned equal, so any
  // difference in the token string is attributable to the claims alone.
  it('same uid + same mint-serial, different customClaims -> different token', async () => {
    const sandboxX = initializeSandbox();
    const authX = getAuth(sandboxX);
    authSandbox.seedUsers(authX, [
      { uid: 'twin', email: 'twin@example.com', password: 'pw', customClaims: { role: 'admin' } },
    ]);
    await signInWithEmailAndPassword(authX, 'twin@example.com', 'pw');
    const tokenX = await authX.currentUser!.getIdToken();

    const sandboxY = initializeSandbox();
    const authY = getAuth(sandboxY);
    authSandbox.seedUsers(authY, [
      { uid: 'twin', email: 'twin@example.com', password: 'pw', customClaims: { role: 'guest' } },
    ]);
    await signInWithEmailAndPassword(authY, 'twin@example.com', 'pw');
    const tokenY = await authY.currentUser!.getIdToken();

    expect(tokenX).not.toBe(tokenY);
  });

  it('same uid + same mint-serial, same customClaims -> same token (determinism control)', async () => {
    // Companion to the test above: proves the two-sandbox setup itself
    // holds uid + serial equal (so the prior test's divergence really
    // is the claims), by showing identical claims collapse back to an
    // identical token.
    const sandboxX = initializeSandbox();
    const authX = getAuth(sandboxX);
    authSandbox.seedUsers(authX, [
      { uid: 'twin', email: 'twin@example.com', password: 'pw', customClaims: { role: 'admin' } },
    ]);
    await signInWithEmailAndPassword(authX, 'twin@example.com', 'pw');
    const tokenX = await authX.currentUser!.getIdToken();

    const sandboxY = initializeSandbox();
    const authY = getAuth(sandboxY);
    authSandbox.seedUsers(authY, [
      { uid: 'twin', email: 'twin@example.com', password: 'pw', customClaims: { role: 'admin' } },
    ]);
    await signInWithEmailAndPassword(authY, 'twin@example.com', 'pw');
    const tokenY = await authY.currentUser!.getIdToken();

    expect(tokenX).toBe(tokenY);
  });
});

describe('onIdTokenChanged fires on forced refresh — sandbox', () => {
  it('fires once on subscribe + once on signIn + once on getIdToken(true)', async () => {
    // Mirrors `auth-onidtokenchanged-force-refresh.json` shape:
    // 3 fires total = [initial null, signIn, refresh].
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const fires: Array<{ uid: string | null }> = [];
    onIdTokenChanged(auth, (u) => { fires.push({ uid: u ? u.uid : null }); });
    await flush(); // initial null fire
    expect(fires.length).toBe(1);
    expect(fires[0]?.uid).toBe(null);

    await signInAnonymously(auth);
    await flush();
    const firesAfterSignIn = fires.length;
    expect(firesAfterSignIn).toBe(2);
    expect(fires[1]?.uid).toBe(auth.currentUser!.uid);

    await auth.currentUser!.getIdToken(true);
    await flush();
    const firesAfterRefresh = fires.length;
    expect(firesAfterRefresh).toBeGreaterThan(firesAfterSignIn);
    expect(fires[firesAfterRefresh - 1]?.uid).toBe(auth.currentUser!.uid);
  });

  it('forced refresh does NOT fire onAuthStateChanged (identity unchanged)', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);
    const seenAuth: Array<User | null> = [];
    onAuthStateChanged(auth, (u) => { seenAuth.push(u); });
    await flush();
    expect(seenAuth.length).toBe(1);
    await auth.currentUser!.getIdToken(true);
    await flush();
    expect(seenAuth.length).toBe(1); // unchanged — refresh is not an identity event
  });

  it('non-forced getIdToken does NOT fire onIdTokenChanged', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);
    const fires: Array<User | null> = [];
    onIdTokenChanged(auth, (u) => { fires.push(u); });
    await flush();
    expect(fires.length).toBe(1);
    await auth.currentUser!.getIdToken();
    await auth.currentUser!.getIdToken(false);
    await flush();
    expect(fires.length).toBe(1); // still just the initial fire
  });

  it('multiple onIdTokenChanged subscribers all see the refresh', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);
    const firesA: Array<User | null> = [];
    const firesB: Array<User | null> = [];
    onIdTokenChanged(auth, (u) => { firesA.push(u); });
    onIdTokenChanged(auth, (u) => { firesB.push(u); });
    await flush();
    expect(firesA.length).toBe(1);
    expect(firesB.length).toBe(1);
    await auth.currentUser!.getIdToken(true);
    expect(firesA.length).toBe(2);
    expect(firesB.length).toBe(2);
  });

  it('unsubscribed listener does not see refreshes', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);
    const fires: Array<User | null> = [];
    const unsub = onIdTokenChanged(auth, (u) => { fires.push(u); });
    await flush();
    expect(fires.length).toBe(1);
    unsub();
    await auth.currentUser!.getIdToken(true);
    expect(fires.length).toBe(1); // no further fires after unsub
  });
});
