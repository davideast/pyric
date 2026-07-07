/** `exportUsers` → `seedUsers` round-trip + `restoreSession` — the auth
 *  substrate for sandbox persistence (pyric-persist plan 0.1, flow doc section 3c). */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  GoogleAuthProvider,
  sandbox as authSandbox,
} from '../../src/auth/index.js';
import { NO_PASSWORD_SENTINEL } from '../../src/auth/sandbox-backend.js';

const wire = () => getAuth(initializeSandbox());

describe('sandbox.exportUsers', () => {
  it('round-trips seeded users into a fresh sandbox losslessly', () => {
    const a = wire();
    authSandbox.seedUsers(a, [
      { uid: 'u1', email: 'a@x.com', password: 'pw-a', displayName: 'A', customClaims: { admin: true } },
      { uid: 'google.com:b@x.com', email: 'b@x.com', password: 'pw-b', providerId: 'google.com' },
    ]);
    const exported = authSandbox.exportUsers(a);

    const b = wire();
    authSandbox.seedUsers(b, exported);
    expect(authSandbox.exportUsers(b)).toEqual(exported);

    const ids = authSandbox.listIdentities(b);
    expect(ids.find((i) => i.uid === 'u1')?.customClaims).toEqual({ admin: true });
    expect(ids.find((i) => i.email === 'b@x.com')?.providerId).toBe('google.com');
  });

  it('passwordless provider identities export with the sentinel; anonymous are skipped', async () => {
    const a = wire();
    // provider-flow identity without a password (createSignInCredential spec path)
    authSandbox.mockSignInResult(
      a,
      authSandbox.createSignInCredential(a, {
        providerId: 'google.com',
        spec: { email: 'popup@x.com' },
      }),
    );
    await signInWithPopup(a, new GoogleAuthProvider());
    await signInAnonymously(a);

    const exported = authSandbox.exportUsers(a);
    const popup = exported.find((u) => u.email === 'popup@x.com');
    expect(popup?.password).toBe(NO_PASSWORD_SENTINEL);
    expect(popup?.providerId).toBe('google.com');
    // the anonymous identity exists in the DB but is not exported
    expect(authSandbox.listIdentities(a).some((i) => i.isAnonymous)).toBe(true);
    expect(exported.some((u) => u.uid.startsWith('anon'))).toBe(false);
    expect(exported).toHaveLength(1);
  });
});

describe('sandbox.restoreSession', () => {
  it('signs the user in and fires onAuthStateChanged like a real restore', async () => {
    const a = wire();
    authSandbox.seedUsers(a, [
      { uid: 'u1', email: 'a@x.com', password: 'pw', customClaims: { role: 'editor' } },
    ]);
    const seen: Array<string | null> = [];
    onAuthStateChanged(a, (u) => seen.push(u?.uid ?? null));

    const user = authSandbox.restoreSession(a, 'u1');
    expect(user.uid).toBe('u1');
    expect(a.currentUser?.uid).toBe('u1');
    expect((await a.currentUser!.getIdTokenResult()).claims.role).toBe('editor');
    // initial null emission (registration) then the restore
    expect(seen[seen.length - 1]).toBe('u1');
  });

  it('throws auth/user-not-found and auth/user-disabled', () => {
    const a = wire();
    expect(() => authSandbox.restoreSession(a, 'ghost')).toThrow(
      expect.objectContaining({ code: 'auth/user-not-found' }),
    );
    authSandbox.seedUsers(a, [{ uid: 'u1', email: 'a@x.com', password: 'pw' }]);
    authSandbox.updateUser(a, 'u1', { disabled: true });
    expect(() => authSandbox.restoreSession(a, 'u1')).toThrow(
      expect.objectContaining({ code: 'auth/user-disabled' }),
    );
    expect(a.currentUser).toBeNull();
  });
});
