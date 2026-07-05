/**
 * Top-level `getIdToken` / `getIdTokenResult` free functions —
 * `firebase/auth` modular parity.
 *
 * Provenance: W1.5 grid (2026-06-10, conductor log). Generated apps
 * import `getIdTokenResult` from 'firebase/auth' to read custom
 * claims (the canonical modular shape), and the missing top-level
 * export failed every render of the claims-driven fixtures
 * (team-tasks 0/9 across all strategy arms). Only the user-method
 * form existed; these pin the free-function mirror.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAuth,
  getIdToken,
  getIdTokenResult,
  sandbox as authSandbox,
  signInAnonymously,
  signInWithEmailAndPassword,
} from '../../src/auth/index.js';

describe('top-level getIdToken / getIdTokenResult', () => {
  it('getIdToken(user) returns the same token as user.getIdToken()', async () => {
    const auth = getAuth(initializeSandbox());
    const { user } = await signInAnonymously(auth);
    const viaFn = await getIdToken(user);
    expect(viaFn).toBe(await user.getIdToken());
    expect(viaFn.length).toBeGreaterThan(0);
  });

  it('getIdTokenResult(user) surfaces seeded customClaims', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.seedUsers(auth, [
      { uid: 'admin', email: 'admin@example.com', password: 'pw1', customClaims: { role: 'admin' } },
    ]);
    const { user } = await signInWithEmailAndPassword(auth, 'admin@example.com', 'pw1');
    const result = await getIdTokenResult(user);
    expect(result.claims['role']).toBe('admin');
  });

  it('forceRefresh passes through (re-seeded claims visible)', async () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.seedUsers(auth, [
      { uid: 'u1', email: 'u@example.com', password: 'pw1', customClaims: { role: 'user' } },
    ]);
    const { user } = await signInWithEmailAndPassword(auth, 'u@example.com', 'pw1');
    authSandbox.seedUsers(auth, [
      { uid: 'u1', email: 'u@example.com', password: 'pw1', customClaims: { role: 'admin' } },
    ]);
    const refreshed = await getIdTokenResult(user, true);
    expect(refreshed.claims['role']).toBe('admin');
  });
});
