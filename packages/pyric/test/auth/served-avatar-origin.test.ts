/**
 * A served host stores a generated avatar as a relative path. A detached
 * session minted with the client's page origin reads it back absolute on
 * `User.photoURL`, the ID token `picture` claim, and admin user records; with
 * no origin known (this Node test realm has no `location`) it stays relative.
 */
import { describe, expect, it } from 'bun:test';
import {
  captureFullState,
  initializeSandbox,
  type SandboxEvent,
  type ServiceMutationEvent,
} from 'pyric/sandbox';
import { captureSandboxSnapshot } from 'pyric/sandbox/internal';
import {
  GoogleAuthProvider,
  getAuth,
  sandbox as authSandbox,
  signInWithCredential,
  type Auth,
} from 'pyric/auth';
import {
  recordAuthPhotoOrigin,
  setAuthBlockingHooks,
} from 'pyric/auth/internal';

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

  it('resolves providerData[].photoURL, Auth mutation events, and blocking candidates while keeping persistence snapshots relative', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    authSandbox.setAvatarMint(auth, ({ uid, providerId }) => `/__pyric/assets/avatar/${uid}?p=${providerId}`);
    recordAuthPhotoOrigin(auth, ORIGIN);

    const events: SandboxEvent[] = [];
    const unsubscribe = sandbox.onEvent((event) => {
      events.push(event);
    });

    let blockingPhotoUrl: string | null | undefined;
    let blockingProviderPhotoUrl: string | null | undefined;
    setAuthBlockingHooks(auth, {
      beforeSignIn: async (event) => {
        blockingPhotoUrl = event.userRecord.photoURL;
        blockingProviderPhotoUrl = event.userRecord.providerData[0]?.photoURL;
        return {};
      },
    });

    try {
      const created = authSandbox.createSignInCredential(auth, {
        providerId: 'google.com',
        spec: { email: 'ada@example.com', displayName: 'Ada' },
      });
      const expected = `${ORIGIN}/__pyric/assets/avatar/${created.user.uid}?p=google.com`;
      expect(created.user.photoURL).toBe(expected);
      expect(created.user.providerData?.[0]?.photoURL).toBe(expected);

      const session = authSandbox.mintSession(auth, {
        kind: 'provider',
        uid: created.user.uid,
        providerId: 'google.com',
      });
      expect(session.user.photoURL).toBe(expected);
      expect(session.user.providerData?.[0]?.photoURL).toBe(expected);
      expect(session.state.token?.picture).toBe(expected);

      // Native / OIDC sign-in without per-call origin resolves via the host store's fallback origin (#581).
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({ sub: created.user.uid, email: 'ada@example.com', email_verified: true }),
      ).toString('base64url');
      const signedIn = await signInWithCredential(
        auth,
        GoogleAuthProvider.credential(`${header}.${payload}.`),
      );
      expect(signedIn.user.photoURL).toBe(expected);
      expect(signedIn.user.providerData?.[0]?.photoURL).toBe(expected);
      expect(blockingPhotoUrl).toBe(expected);
      expect(blockingProviderPhotoUrl).toBe(expected);

      // Re-picking an already-resolved avatar URL normalizes storage back to the portable relative path.
      authSandbox.updateProfile(auth, created.user.uid, {
        displayName: 'Ada Lovelace',
        photoURL: expected,
      });

      const authEvents = events.filter(
        (ev): ev is ServiceMutationEvent =>
          'service' in ev && ev.service === 'auth' && 'after' in ev,
      );
      const createEvent = authEvents.find((ev) => ev.op === 'user_create');
      const updateEvent = authEvents.findLast((ev) => ev.op === 'user_update');
      expect((createEvent?.after as { photoUrl?: string } | null)?.photoUrl).toBe(expected);
      expect((updateEvent?.after as { photoUrl?: string } | null)?.photoUrl).toBe(expected);
      expect((updateEvent?.detail as { photoURL?: string } | undefined)?.photoURL).toBe(expected);

      // Internal persistence exports and snapshots remain root-relative.
      const relative = `/__pyric/assets/avatar/${created.user.uid}?p=google.com`;
      expect(authSandbox.exportUsers(auth)[0]?.photoUrl).toBe(relative);
      expect((await captureFullState(sandbox)).auth.users[0]?.photoUrl).toBe(relative);
      expect((await captureSandboxSnapshot(sandbox)).auth?.users[0]?.photoUrl).toBe(relative);
    } finally {
      unsubscribe();
    }
  });
});
