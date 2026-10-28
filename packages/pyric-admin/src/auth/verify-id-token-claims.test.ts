/**
 * `verifyIdToken` on a client ID token returns the token's own `sub`, `aud`,
 * `iss`, `iat`, `exp` and `auth_time`, not values made up at verify time
 * (auth-claims AU-7). A server's recent-sign-in check reads `auth_time`
 * (firebase.google.com/docs/auth/admin/manage-cookies: "the auth_time should
 * be checked"), and production keeps it at the sign-in across refreshes
 * (firebase-admin `token-verifier.d.ts`: "the same auth_time value"; capture
 * `admin.verifyIdTokenDecoded.authTimeEqualsToken: true`).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import { createUserWithEmailAndPassword, getAuth as getClientAuth } from 'pyric/auth';
import { deleteApp, getApps, initializeApp } from '../app/index.js';
import { getAuth } from './index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('verifyIdToken returns the client token claims', () => {
  it('keeps auth_time at the sign-in and iat at the refresh', async () => {
    const sandbox = initializeSandbox();
    const admin = getAuth(initializeApp({ sandbox }, 'verify-id-token-claims'));
    const client = getClientAuth(sandbox);
    // Move the sandbox clock away from the wall clock, so a value made up at
    // verify time cannot match by accident.
    getClock(sandbox).advance(60 * 60 * 1000);
    const { user } = await createUserWithEmailAndPassword(client, 'ada@example.com', 'secret-pw');
    getClock(sandbox).advance(10 * 60 * 1000);
    const idToken = await user.getIdToken(true);
    const { claims } = await user.getIdTokenResult();

    const decoded = await admin.verifyIdToken(idToken);

    for (const key of ['sub', 'aud', 'iss', 'iat', 'exp', 'auth_time'] as const) {
      expect(decoded[key]).toEqual(claims[key]);
    }
    expect(decoded.uid).toBe(user.uid);
    expect(decoded.iat - decoded.auth_time).toBe(600);
  });
});
