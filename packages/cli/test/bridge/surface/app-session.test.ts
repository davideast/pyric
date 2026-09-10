/**
 * The app session read: what `getAuth(sandbox).currentUser` reports, with the
 * claims and the tenant the stored record holds folded in.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import {
  getAuth,
  sandbox as authSandbox,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
} from 'pyric/auth';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';

import { describeAppSession, readAppSession } from '../../../src/bridge/surface/app-session.js';

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
