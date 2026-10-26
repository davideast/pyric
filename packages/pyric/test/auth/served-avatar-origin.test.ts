/**
 * A served host stores a generated avatar as a relative path. A detached
 * session minted with the client's page origin reads it back absolute on
 * `User.photoURL`, the ID token `picture` claim, and admin user records; with
 * no origin known (this Node test realm has no `location`) it stays relative.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, sandbox as authSandbox, type Auth } from '../../src/auth/index.js';

const STORED = '/__pyric/assets/avatar/ada?d=0123456789abcdef&p=google.com';
const ORIGIN = 'http://localhost:5173';

function authWithStoredAvatar(uid: string): Auth {
  const auth = getAuth(initializeSandbox());
  authSandbox.createUser(auth, { uid, email: `${uid}@example.com`, photoUrl: STORED });
  return auth;
}

function adminPhotoUrl(auth: Auth, uid: string): string | null | undefined {
  return authSandbox.listUsers(auth).find((user) => user.uid === uid)?.photoUrl;
}

describe('served avatar photo URL read against the page origin', () => {
  it('reads absolute on the session user, the token picture, and admin records', async () => {
    const auth = authWithStoredAvatar('ada');
    const session = authSandbox.mintSession(auth, { kind: 'uid', uid: 'ada', origin: ORIGIN });

    const expected = `${ORIGIN}${STORED}`;
    expect(session.user.photoURL).toBe(expected);
    expect((await session.user.getIdTokenResult()).claims.picture).toBe(expected);
    expect(session.state.token?.picture).toBe(expected);
    expect(adminPhotoUrl(auth, 'ada')).toBe(expected);
  });

  it('keeps the origin for later mints of the same uid that state none', () => {
    const auth = authWithStoredAvatar('ada');
    authSandbox.mintSession(auth, { kind: 'uid', uid: 'ada', origin: ORIGIN });
    const refreshed = authSandbox.mintSession(auth, { kind: 'uid', uid: 'ada' });

    expect(refreshed.user.photoURL).toBe(`${ORIGIN}${STORED}`);
  });

  it('stays relative when no origin is known', async () => {
    const auth = authWithStoredAvatar('bob');
    const session = authSandbox.mintSession(auth, { kind: 'uid', uid: 'bob' });

    expect(session.user.photoURL).toBe(STORED);
    expect((await session.user.getIdTokenResult()).claims.picture).toBe(STORED);
    expect(adminPhotoUrl(auth, 'bob')).toBe(STORED);
  });

  it('leaves a user-set absolute photo unchanged', () => {
    const auth = getAuth(initializeSandbox());
    const photo = 'https://cdn.example.com/avatars/cy.png';
    authSandbox.createUser(auth, { uid: 'cy', email: 'cy@example.com', photoUrl: photo });
    const session = authSandbox.mintSession(auth, { kind: 'uid', uid: 'cy', origin: ORIGIN });

    expect(session.user.photoURL).toBe(photo);
    expect(adminPhotoUrl(auth, 'cy')).toBe(photo);
  });
});
