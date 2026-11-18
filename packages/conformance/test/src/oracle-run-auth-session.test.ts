import { describe, expect, test } from 'bun:test';
import {
  createOracleRunAuthSession,
  FRESH_AUTH_NON_AUTH_PROBES,
  sanitizeOracleCustomUid,
  signInOracleClientAuth,
} from '../../src/oracle-run-auth-session.ts';
import type { OracleServiceAccount } from '../../src/oracle-credential.ts';

interface FakeUser {
  uid: string;
  isAnonymous: boolean;
  deleteCalls: number;
  delete(): Promise<void>;
}

function createFakeAuth() {
  let deleteCount = 0;
  let signOutCount = 0;
  let seq = 0;
  const state: {
    currentUser: FakeUser | null;
    signOut(): Promise<void>;
  } = {
    currentUser: null,
    async signOut() {
      signOutCount += 1;
      state.currentUser = null;
    },
  };

  function signIn(isAnonymous: boolean, uidPrefix = 'anon'): FakeUser {
    seq += 1;
    const user: FakeUser = {
      uid: `${uidPrefix}-${seq}`,
      isAnonymous,
      deleteCalls: 0,
      async delete() {
        user.deleteCalls += 1;
        deleteCount += 1;
        if (state.currentUser === user) {
          state.currentUser = null;
        }
      },
    };
    state.currentUser = user;
    return user;
  }

  return {
    state,
    signInAnon: () => signIn(true, 'anon'),
    signInCustom: (uid: string) => signIn(false, uid),
    getDeleteCount: () => deleteCount,
    getSignOutCount: () => signOutCount,
  };
}

describe('createOracleRunAuthSession', () => {
  test('retains anonymous user across ordinary non-auth probes and drops before auth-* and at finishRun', async () => {
    const fake = createFakeAuth();
    const session = createOracleRunAuthSession(() => fake.state, {
      signOutAuth: () => fake.state.signOut(),
    });

    await session.beforeProbe('firestore-deletedoc-missing');
    fake.signInAnon();
    await session.dropAfterProbeBody();
    expect(fake.state.currentUser?.isAnonymous).toBe(true);
    expect(fake.getDeleteCount()).toBe(0);

    await session.beforeProbe('firestore-queryequal-structural');
    expect(fake.state.currentUser?.isAnonymous).toBe(true);
    await session.dropAfterProbeBody();
    expect(fake.getDeleteCount()).toBe(0);

    await session.beforeProbe('auth-signout-idempotent');
    expect(fake.state.currentUser).toBeNull();
    expect(fake.getDeleteCount()).toBe(1);

    fake.signInAnon();
    await session.dropAfterProbeBody();
    expect(fake.state.currentUser).toBeNull();
    expect(fake.getDeleteCount()).toBe(2);

    await session.beforeProbe('storage-upload-bytes-roundtrip');
    fake.signInAnon();
    await session.dropAfterProbeBody();
    expect(fake.state.currentUser?.isAnonymous).toBe(true);
    expect(fake.getDeleteCount()).toBe(2);

    await session.finishRun();
    expect(fake.state.currentUser).toBeNull();
    expect(fake.getDeleteCount()).toBe(3);
  });

  test('opts out signOut-calling non-auth probes and deletes currentUser before signOut so zero accounts are orphaned', async () => {
    expect(FRESH_AUTH_NON_AUTH_PROBES.has('storage-rules-denied-signed-out-error-code')).toBe(true);
    expect(FRESH_AUTH_NON_AUTH_PROBES.has('rtdb-simulator-vs-prod-agreement')).toBe(true);

    const fake = createFakeAuth();
    const customSignIns: string[] = [];
    const session = createOracleRunAuthSession(() => fake.state, {
      signOutAuth: () => fake.state.signOut(),
      signInProbe: async (uidHint) => {
        customSignIns.push(uidHint);
        fake.signInCustom(uidHint);
      },
    });

    await session.beforeProbe('firestore-deletedoc-missing');
    fake.signInAnon();
    await session.dropAfterProbeBody();
    expect(fake.getDeleteCount()).toBe(0);

    // Entering opted-out storage probe deletes the retained anonymous user first.
    await session.beforeProbe('storage-rules-denied-signed-out-error-code');
    expect(fake.state.currentUser).toBeNull();
    expect(fake.getDeleteCount()).toBe(1);

    await session.signInProbeUser('storage-denied-run1');
    expect(customSignIns).toEqual(['storage-denied-run1']);
    expect(fake.state.currentUser).not.toBeNull();

    // signOutAndDeleteCurrentUser deletes currentUser BEFORE signOut so no orphan remains.
    await session.signOutAndDeleteCurrentUser();
    expect(fake.state.currentUser).toBeNull();
    expect(fake.getDeleteCount()).toBe(2);
    expect(fake.getSignOutCount()).toBe(1);

    // Entering opted-out rtdb-simulator probe also clears any retained user.
    await session.beforeProbe('firestore-queryequal-structural');
    fake.signInAnon();
    await session.beforeProbe('rtdb-simulator-vs-prod-agreement');
    expect(fake.state.currentUser).toBeNull();
    expect(fake.getDeleteCount()).toBe(3);
  });

  test('signInOracleClientAuth uses custom tokens when serviceAccount is present and falls back to anonymous when absent', async () => {
    expect(sanitizeOracleCustomUid('rtdb/climb:listener cancellation#0')).toBe(
      'pyric-rtdb-climb-listener-cancellation-0',
    );
    expect(sanitizeOracleCustomUid('x'.repeat(200)).length).toBe(128);

    const mintedUids: string[] = [];
    const signedInTokens: string[] = [];
    let anonCalls = 0;

    const fakeServiceAccount: OracleServiceAccount = {
      kind: 'application-default',
      project_id: 'demo-oracle',
      client_email: 'demo@demo-oracle.iam.gserviceaccount.com',
      credential: { getAccessToken: async () => ({ access_token: 'tok', expires_in: 3600 }) },
    };

    await signInOracleClientAuth({} as never, fakeServiceAccount, 'rtdb-climb-run1-0', {
      mintCustomToken: async (_sa, uid) => {
        mintedUids.push(uid);
        return `jwt-for-${uid}`;
      },
      signInCustomToken: async (_auth, token) => {
        signedInTokens.push(token);
      },
      signInAnonymous: async () => {
        anonCalls += 1;
      },
    });
    expect(mintedUids).toEqual(['pyric-rtdb-climb-run1-0']);
    expect(signedInTokens).toEqual(['jwt-for-pyric-rtdb-climb-run1-0']);
    expect(anonCalls).toBe(0);

    await signInOracleClientAuth({} as never, null, 'manual-fallback', {
      mintCustomToken: async () => 'unused',
      signInCustomToken: async () => {},
      signInAnonymous: async () => {
        anonCalls += 1;
      },
    });
    expect(anonCalls).toBe(1);
  });

  test('retries auth/too-many-requests with backoff and rethrows other errors immediately', async () => {
    const fake = createFakeAuth();
    const sleeps: number[] = [];
    const session = createOracleRunAuthSession(() => fake.state, {
      backoffMs: [15_000, 30_000],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: () => {},
      signOutAuth: () => fake.state.signOut(),
    });

    let calls = 0;
    await session.beforeProbe('auth-row-38-onidtokenchanged-fires-on-user-change');
    const result = await session.observeWithRateLimitRetry(
      'auth-row-38-onidtokenchanged-fires-on-user-change',
      async () => {
        calls += 1;
        fake.signInAnon();
        if (calls < 3) {
          throw Object.assign(new Error('Firebase: Error (auth/too-many-requests).'), {
            code: 'auth/too-many-requests',
          });
        }
        return { ok: true };
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sleeps).toEqual([15_000, 30_000]);
    expect(fake.getDeleteCount()).toBe(2);

    await expect(
      session.observeWithRateLimitRetry('auth-row-10', async () => {
        throw new Error('permission-denied');
      }),
    ).rejects.toThrow('permission-denied');
    expect(sleeps).toEqual([15_000, 30_000]);
  });

  test('absorbs auth-row-35 intentional async observer throw so Bun exits 0 cleanly without masking real uncaught errors', async () => {
    const moduleUrl = new URL('../../src/oracle-run-auth-session.ts', import.meta.url).href;
    const okProc = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { createOracleRunAuthSession } from ${JSON.stringify(moduleUrl)};
         const s = createOracleRunAuthSession(() => ({ currentUser: null }));
         await s.observeWithRateLimitRetry('auth-row-35-throwing-observer-doesnt-block-others', async () => {
           setTimeout(() => { throw new Error('intentional throw from oracle probe observer #1'); }, 0);
           await new Promise((r) => setTimeout(r, 30));
           return { ok: true };
         });`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    expect(await okProc.exited).toBe(0);

    const failProc = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { createOracleRunAuthSession } from ${JSON.stringify(moduleUrl)};
         const s = createOracleRunAuthSession(() => ({ currentUser: null }));
         await s.observeWithRateLimitRetry('auth-row-35-throwing-observer-doesnt-block-others', async () => {
           setTimeout(() => { throw new Error('unexpected observer crash'); }, 0);
           await new Promise((r) => setTimeout(r, 30));
           return { ok: true };
         });`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    expect(await failProc.exited).not.toBe(0);
  });
});
