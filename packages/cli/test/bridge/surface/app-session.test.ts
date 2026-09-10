/**
 * The app session read: what `getAuth(sandbox).currentUser` reports, with the
 * claims, the tenant, and the sign-in provider the sandbox holds folded in.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import {
  getAuth,
  getIdTokenResult,
  sandbox as authSandbox,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
} from 'pyric/auth';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';

import { describeAppSession, readAppSession } from '../../../src/bridge/surface/app-session.js';
import { createSurfaceContext } from '../../../src/bridge/surface/context.js';
import { listHeldSessions } from '../../../src/bridge/surface/held-identity.js';
import signInWithCredential from '../../../src/bridge/surface/methods/auth/signInWithCredential.js';
import signInWithCustomToken from '../../../src/bridge/surface/methods/auth/signInWithCustomToken.js';
import type { HeldSession } from '../../../src/bridge/surface/held-identity.js';

function seeded(): LocalSandbox {
  const sandbox = initializeSandbox();
  authSandbox.seedUsers(getAuth(sandbox), [
    {
      uid: 'riley',
      email: 'riley@acme.test',
      password: 'hunter22',
      tenantId: 'tenant-acme',
      customClaims: { role: 'viewer' },
    },
  ]);
  return sandbox;
}

describe('readAppSession', () => {
  it('reports no session on a sandbox nothing has signed in to', () => {
    expect(readAppSession(initializeSandbox())).toBe(null);
  });

  it('reports the signed-in user with its tenant and claims', async () => {
    const sandbox = seeded();
    const auth = getAuth(sandbox);
    auth.tenantId = 'tenant-acme';
    await signInWithEmailAndPassword(auth, 'riley@acme.test', 'hunter22');

    expect(readAppSession(sandbox)).toEqual({
      uid: 'riley',
      email: 'riley@acme.test',
      isAnonymous: false,
      providerId: 'password',
      tenantId: 'tenant-acme',
      customClaims: { role: 'viewer' },
    });
  });

  it('labels an anonymous session by its provider', async () => {
    const sandbox = initializeSandbox();
    await signInAnonymously(getAuth(sandbox));
    const session = readAppSession(sandbox);
    expect(session?.isAnonymous).toBe(true);
    expect(session?.providerId).toBe('anonymous');
    expect(session?.tenantId).toBe(null);
  });

  it('reports no session again after a sign-out', async () => {
    const sandbox = seeded();
    const auth = getAuth(sandbox);
    await signInWithEmailAndPassword(auth, 'riley@acme.test', 'hunter22');
    await signOut(auth);
    expect(readAppSession(sandbox)).toBe(null);
  });
});

describe('describeAppSession', () => {
  it('names a signed-out app session', () => {
    expect(describeAppSession(null)).toBe('signed out');
  });

  it('names the uid, the tenant, and the provider', () => {
    expect(
      describeAppSession({
        uid: 'riley',
        email: 'riley@acme.test',
        isAnonymous: false,
        providerId: 'password',
        tenantId: 'tenant-acme',
        customClaims: {},
      }),
    ).toBe('riley, tenant tenant-acme, via password');
  });

  it('leaves the tenant out for a project-level session', () => {
    expect(
      describeAppSession({
        uid: 'dana',
        email: null,
        isAnonymous: true,
        providerId: 'anonymous',
        tenantId: null,
        customClaims: {},
      }),
    ).toBe('dana, via anonymous');
  });
});

/** The provider the sandbox itself puts on the session's minted token. */
async function mintedSignInProvider(sandbox: LocalSandbox): Promise<string | null> {
  const user = getAuth(sandbox).currentUser;
  if (user === null) throw new Error('the app is signed out');
  return (await getIdTokenResult(user)).signInProvider ?? null;
}

/** The identity line `auth.sessions` prints for the app session. */
function reportedAppSessionLine(sandbox: LocalSandbox): string {
  const sessions = listHeldSessions(createSurfaceContext(sandbox)).data as {
    sessions: HeldSession[];
  };
  const line = sessions.sessions.find((session) => session.kind === 'appSession');
  if (line === undefined) throw new Error('no app session was listed');
  return line.identity;
}

describe('the provider a session signed in through', () => {
  it('reports the federated provider when the address already had a password account', async () => {
    const sandbox = seeded();
    const ctx = createSurfaceContext(sandbox);
    const result = await signInWithCredential.handler(
      { credential: { providerId: 'google.com', email: 'riley@acme.test' } },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(readAppSession(sandbox)?.providerId).toBe('google.com');
    expect(await mintedSignInProvider(sandbox)).toBe('google.com');
    expect(reportedAppSessionLine(sandbox)).toContain('via google.com');
  });

  it('reports custom for a custom-token sign-in', async () => {
    const sandbox = seeded();
    const ctx = createSurfaceContext(sandbox);
    const result = await signInWithCustomToken.handler(
      { token: JSON.stringify({ uid: 'riley' }) },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(readAppSession(sandbox)?.providerId).toBe('custom');
    expect(await mintedSignInProvider(sandbox)).toBe('custom');
    expect(reportedAppSessionLine(sandbox)).toContain('via custom');
  });

  it('reports anonymous for an anonymous sign-in', async () => {
    const sandbox = initializeSandbox();
    await signInAnonymously(getAuth(sandbox));

    expect(readAppSession(sandbox)?.providerId).toBe('anonymous');
    expect(await mintedSignInProvider(sandbox)).toBe('anonymous');
  });

  it('reports password for an email and password sign-in', async () => {
    const sandbox = seeded();
    await signInWithEmailAndPassword(getAuth(sandbox), 'riley@acme.test', 'hunter22');

    expect(readAppSession(sandbox)?.providerId).toBe('password');
    expect(await mintedSignInProvider(sandbox)).toBe('password');
  });
});
