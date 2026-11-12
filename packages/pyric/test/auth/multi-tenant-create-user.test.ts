import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from '../../src/sandbox/index.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithCredential,
  sandbox as authSandbox,
} from '../../src/auth/index.js';

describe('multi-tenant user creation and detached session claim restoration', () => {
  it('preserves tenantId on admin createUser and isolates same-email creation across tenants', async () => {
    const sb = initializeSandbox();
    try {
      const auth = getAuth(sb);
      const alphaUser = authSandbox.createUser(auth, {
        uid: 'alpha-1',
        email: 'member@example.test',
        tenantId: 'org-alpha',
      } as Parameters<typeof authSandbox.createUser>[1]);
      const betaUser = authSandbox.createUser(auth, {
        uid: 'beta-1',
        email: 'member@example.test',
        tenantId: 'org-beta',
      } as Parameters<typeof authSandbox.createUser>[1]);

      expect(alphaUser.tenantId).toBe('org-alpha');
      expect(betaUser.tenantId).toBe('org-beta');

      expect(() =>
        authSandbox.createUser(auth, {
          uid: 'alpha-dup',
          email: 'member@example.test',
          tenantId: 'org-alpha',
        } as Parameters<typeof authSandbox.createUser>[1]),
      ).toThrow(/email-already-in-use/);

      auth.tenantId = 'org-gamma';
      authSandbox.mockSignInResult(auth, {
        user: { uid: 'gamma-1', email: 'member@example.test', emailVerified: true },
        providerId: 'google.com',
      });
      const cred = await signInWithCredential(auth, GoogleAuthProvider.credential('tok-gamma'));
      expect(cred.user.tenantId).toBe('org-gamma');

      const all = authSandbox.listUsers(auth);
      expect(all.find((u) => u.uid === 'alpha-1')?.tenantId).toBe('org-alpha');
      expect(all.find((u) => u.uid === 'beta-1')?.tenantId).toBe('org-beta');
      expect(all.find((u) => u.uid === 'gamma-1')?.tenantId).toBe('org-gamma');

      const betaSecond = authSandbox.createUser(auth, {
        uid: 'beta-2',
        email: 'second@example.test',
        tenantId: 'org-beta',
      } as Parameters<typeof authSandbox.createUser>[1]);
      expect(betaSecond.email).toBe('second@example.test');

      const alphaUpdated = authSandbox.updateUser(auth, 'alpha-1', {
        email: 'second@example.test',
      });
      expect(alphaUpdated.email).toBe('second@example.test');

      expect(() =>
        authSandbox.updateUser(auth, 'beta-1', {
          email: 'second@example.test',
        }),
      ).toThrow(/email-already-in-use/);
    } finally {
      sb.dispose();
    }
  });

  it('restores detached uid sessions with unrefreshed customClaims snapshots until forced refresh', async () => {
    const sb = initializeSandbox();
    try {
      const auth = getAuth(sb);
      authSandbox.createUser(auth, {
        uid: 'user-1',
        email: 'user1@example.test',
        customClaims: {},
      });

      const restoredRevoked = authSandbox.mintSession(auth, {
        kind: 'uid',
        uid: 'user-1',
        tenantId: null,
        restore: {
          customClaims: { role: 'admin' },
          signInProvider: 'password',
        } as { sessionKey?: string },
      });
      expect(restoredRevoked.state.token?.role).toBe('admin');
      const unrefreshed = await restoredRevoked.user.getIdTokenResult(false);
      expect(unrefreshed.claims.role).toBe('admin');

      const refreshed = await restoredRevoked.user.getIdTokenResult(true);
      expect(refreshed.claims.role).toBeUndefined();

      authSandbox.updateUser(auth, 'user-1', { customClaims: { role: 'owner' } });
      const restoredEmpty = authSandbox.mintSession(auth, {
        kind: 'uid',
        uid: 'user-1',
        tenantId: null,
        restore: {
          customClaims: {},
          signInProvider: 'password',
        } as { sessionKey?: string },
      });
      expect(restoredEmpty.state.token?.role).toBeUndefined();
    } finally {
      sb.dispose();
    }
  });
});
