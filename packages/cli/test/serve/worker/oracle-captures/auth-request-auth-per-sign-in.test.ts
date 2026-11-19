import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import {
  createNodeHosted68cSession,
  createSharedWorker68cSession,
  PROJECT_ID,
  type MultiPlane68cSession,
} from './auth-request-auth-per-sign-in-support.ts';
import { load, restoreSharedWorker } from './support.ts';

const PASSWORD = 'secret-pw';

async function assertMultiPlane68cParity(session: MultiPlane68cSession): Promise<void> {
  const production = load('auth-request-auth-per-sign-in') as Record<
    string,
    { signInProvider?: string | null }
  >;

  try {
    const anon = await session.signInAnonymously();
    expect(anon.signInProvider).toBe(production.anonymous?.signInProvider ?? 'anonymous');
    expect(anon.claims.sub).toBe(anon.uid);
    expect(anon.claims.aud).toBe(PROJECT_ID);
    expect(anon.claims.iss).toBe(`https://securetoken.google.com/${PROJECT_ID}`);
    expect(Number(anon.claims.exp) - Number(anon.claims.iat)).toBe(3600);
    await session.signOut();

    await session.adminCreateUser({
      uid: 'u-68c-ada',
      email: 'ada@example.com',
      password: PASSWORD,
      emailVerified: false,
    });
    await session.adminSetCustomClaims('u-68c-ada', {
      foo: 'api',
      key1: 'kept',
      role: 'editor',
    });

    const ctMerged = await session.adminMintCustomToken('u-68c-ada', {
      foo: 'token',
      key2: 'added',
      admin: true,
    });
    const ctSession = await session.signInWithCustomToken(ctMerged);
    expect(ctSession.signInProvider).toBe(
      production.customTokenOverStoredClaims?.signInProvider ?? 'custom',
    );
    expect(ctSession.claims.foo).toBe('token');
    expect(ctSession.claims.key1).toBe('kept');
    expect(ctSession.claims.key2).toBe('added');
    expect(ctSession.claims.role).toBe('editor');
    expect(ctSession.claims.admin).toBe(true);

    // Advance clock past sign-in and verify RTDB, Firestore, and Storage rules
    // read sub, aud, iss, iat, exp, auth_time, and session-merged custom-token claims.
    await session.advanceClock(10_000);
    await session.writeRtdb('claims/ok', 1);
    await session.writeFirestore('claims/doc1', { ok: true });
    await session.checkStoragePrefix('claims');
    await expect(session.checkStoragePrefix('afterPassword')).rejects.toThrow();

    // Reload keeps sign_in_provider === 'custom'.
    const reloaded = await session.reloadCurrent();
    expect(reloaded.signInProvider).toBe(production.customTokenReload?.signInProvider ?? 'custom');

    // Password reauthentication switches sign_in_provider to 'password' and drops session-only custom-token claims.
    await session.advanceClock(1500);
    const reauthed = await session.reauthCurrentWithPassword('ada@example.com', PASSWORD);
    expect(reauthed.signInProvider).toBe(
      production.customTokenReauthPassword?.signInProvider ?? 'password',
    );
    expect(reauthed.claims.foo).toBe('api');
    expect(reauthed.claims.key1).toBe('kept');
    expect('key2' in reauthed.claims).toBe(false);
    expect('admin' in reauthed.claims).toBe(false);

    // Sign out and sign back in with password: custom-token claims did not persist on the account,
    // and forced refresh preserves auth_time while advancing iat.
    await session.signOut();
    const pwSession = await session.signInWithEmailAndPassword('ada@example.com', PASSWORD);
    expect(pwSession.signInProvider).toBe(
      production.passwordAfterCustomToken?.signInProvider ?? 'password',
    );
    expect(pwSession.claims.foo).toBe('api');
    expect(pwSession.claims.key1).toBe('kept');
    expect('key2' in pwSession.claims).toBe(false);
    expect('admin' in pwSession.claims).toBe(false);
    await session.writeRtdb('afterPassword/ok', 1);
    await session.writeFirestore('afterPassword/doc1', { ok: true });
    await session.checkStoragePrefix('afterPassword');

    await session.advanceClock(3000);
    const refreshed = await session.forceRefreshCurrent();
    expect(refreshed.claims.auth_time).toBe(pwSession.claims.auth_time);
    expect(Number(refreshed.claims.iat)).toBeGreaterThan(Number(pwSession.claims.iat));
    expect(Number(refreshed.claims.exp) - Number(refreshed.claims.iat)).toBe(3600);
    await session.signOut();

    // Email link sign-in sets sign_in_provider: 'password' and email_verified: true.
    const linkSession = await session.signInWithEmailLinkRoundTrip('link@example.com');
    expect(linkSession.signInProvider).toBe(production.emailLink?.signInProvider ?? 'password');
    expect(linkSession.claims.email_verified).toBe(true);
  } finally {
    await session.cleanup();
  }
}

describe('auth-request-auth-per-sign-in multi-plane parity (SharedWorker + Node host, auth#68c)', () => {
  restoreSharedWorker();

  it('SharedWorker: RTDB, Firestore, and Storage rules read minted JWT claims, session-scoped custom-token claims, and password reauth provider', async () => {
    await assertMultiPlane68cParity(await createSharedWorker68cSession());
  });

  it('Node host WebSocket: RTDB, Firestore, and Storage rules read minted JWT claims, session-scoped custom-token claims, and password reauth provider', async () => {
    await assertMultiPlane68cParity(await createNodeHosted68cSession());
  });
});
